// Ordered Texture boundaries share production point/color/coverage WGSL.
import { RawGpuRenderer } from './raw-renderer.ts'
import { exportShader } from './point-renderer.ts'
import { authoredOutputShader } from '../../shared/authored-output-wgsl.ts'
import { neutralAdjustments, srgbTransform } from '../../shared/adjustments.ts'
import { creativeColorActive, prepareCreativeColor } from '../../shared/creative-color.ts'
import { packCreativeColor } from '../../shared/creative-color-gpu.ts'
import { preparedToneCurves } from '../../shared/tone-curves.ts'
import { packToneCurves } from '../../shared/tone-curves-gpu.ts'
import { exportPrecisionData } from '../export/precision-wgsl.ts'
import { maskBaseAtlasPlan, packLocalMasks } from '../../shared/masks-gpu.ts'
import { validateExportAdmission } from '../../shared/export-resources.ts'
import { prepareNativeMaskEdges } from '../mask-edges/native.ts'
import { createMaskBaseAtlas } from './mask-bases.ts'

const check = (condition, message) => {
  if (!condition) throw new Error(`Ordered Texture point: ${message}`)
}
const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
const copyWords = (data) => new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4)

function shape(job) {
  const { width, height } = job
  check(
    Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width * height <= 24000000,
    'invalid/oversized native grid; no lower-resolution retry',
  )
  return width * height
}
function rgba(data, pixels) {
  check(data instanceof Float32Array && data.length === pixels * 4, 'invalid Float32 RGBA frame')
}
function coverage(data, pixels) {
  check(data instanceof Float32Array && data.length === pixels, 'invalid coverage grid')
  check(
    data.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
    'invalid coverage values',
  )
}
function parameters(job, pixels) {
  const values = new Float32Array(48),
    adjustments = job.adjustments ?? neutralAdjustments,
    transform = job.transform ?? srgbTransform
  check(
    Number.isFinite(transform.white) &&
      transform.white > 0 &&
      Number.isFinite(transform.threshold) &&
      transform.threshold > 0 &&
      Number.isFinite(transform.offset) &&
      transform.offset >= 0 &&
      typeof transform.quantize === 'boolean',
    'invalid authored transform',
  )
  values.set([pixels, 0, job.width, 0], 0)
  values.set(
    [adjustments.exposureEv, adjustments.contrast, adjustments.highlights, adjustments.shadows],
    8,
  )
  values.set([adjustments.whites, adjustments.blacks], 12)
  values.set(
    [transform.white, transform.threshold, transform.offset, Number(transform.quantize)],
    32,
  )
  values.set([adjustments.saturation, adjustments.vibrance], 44)
  if (job.whiteBalance) {
    check(
      job.whiteBalance.length === 9 && job.whiteBalance.every(Number.isFinite),
      'invalid white-balance matrix',
    )
    values[19] = 1
    for (let row = 0; row < 3; row++)
      values.set(job.whiteBalance.slice(row * 3, row * 3 + 3), 20 + row * 4)
  }
  check(values.every(Number.isFinite), 'nonfinite global parameters')
  return values
}

function productionPrefix(domain, adjustments, useMasks, bases = false) {
  check(['raster', 'scene-linear', 'authored-hdr'].includes(domain), 'unsupported point domain')
  const color = prepareCreativeColor(adjustments),
    creative = creativeColorActive(color),
    compiledCurves = preparedToneCurves(adjustments.curves),
    curves = !compiledCurves.identity
  let source =
    domain !== 'scene-linear'
      ? authoredOutputShader(
          false,
          false,
          creative,
          { domain, preserveAlpha: true },
          64,
          curves,
          useMasks,
          bases,
        )
      : exportShader(false, false, 64, false, creative, true, curves, useMasks, bases)
  const marker = '@compute @workgroup_size('
  check(source.includes(marker), 'actual production point entry is unavailable')
  source = source.slice(0, source.indexOf(marker))
  return { source, creative, curves, color, compiledCurves }
}

const controlsDeclaration = `
struct ProofControl { size:vec4u }
@group(0) @binding(7) var<uniform> proof:ProofControl;
fn proofFinite(rgb:vec3f)->bool { return all((bitcast<vec3u>(rgb)&vec3u(0x7f800000u))!=vec3u(0x7f800000u)); }
fn proofStore(index:u32,rgb:vec3f,alpha:f32) {
 let bits=bitcast<u32>(alpha);
 if(!proofFinite(rgb)||(bits&0x7fffffffu)>0x3f800000u||((bits&0x80000000u)!=0u&&bits!=0x80000000u)){atomicAdd(&result.peak,1u);}
 result.values[index*4u]=bitcast<u32>(rgb.r);
 result.values[index*4u+1u]=bitcast<u32>(rgb.g);
 result.values[index*4u+2u]=bitcast<u32>(rgb.b);
 result.values[index*4u+3u]=bitcast<u32>(alpha);
}
`
const numericDeclaration = '@group(0) @binding(8) var<storage,read> numericCoverage:array<f32>;'

// The full shader's helper/parameter declarations remain the actual producer's.
function shaderFor(kind, domain, prefix, numeric) {
  const scene = domain !== 'raster',
    white = scene ? '1.' : 'u.values[8].x'
  const globalExpression =
    domain === 'scene-linear'
      ? 'adjusted(pixel.rgb)'
      : domain === 'authored-hdr'
        ? 'hdr_adjusted(pixel.rgb)'
        : 'rasterAdjusted(pixel.rgb,u.values[2],u.values[3].xy,u.values[11].xy,u.values[8].x)'
  if (kind === 'global')
    return `${prefix.source}
${controlsDeclaration}
@compute @workgroup_size(64) fn proofGlobal(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x+gid.y*16384u;if(i>=proof.size.x){return;}
 let pixel=input[i];proofStore(i,${globalExpression},pixel.a);
}`
  if (kind === 'legacy')
    return `${prefix.source}
${controlsDeclaration}
${numeric ? numericDeclaration : ''}
@compute @workgroup_size(64) fn proofLegacy(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x+gid.y*16384u;if(i>=proof.size.x){return;}
 let pixel=input[i];var rgb=${globalExpression};
 let point=maskCanonical(vec2f(f32(i%proof.size.y)+.5,f32(i/proof.size.y)+.5));
 ${
   numeric
     ? `
 for(var remaining=u32(maskData[0].x);remaining>0u;remaining--){
  let index=remaining-1u;let offset=6u+index*12u;let descriptor=maskData[offset];
  let light=maskData[offset+1u];let config=maskData[offset+2u];let endpoints=config.xy;let color=config.zw;
  if(descriptor.z==0.||(all(light==vec4f(0.))&&all(config==vec4f(0.)))){continue;}
  let amount=numericCoverage[index*proof.size.x+i];
  if(amount>0.){
   var changed=rgb;if(color.y!=0.){changed=maskBalance(changed,offset,${scene});}
   changed=maskLight(changed,light,endpoints,${white},${scene});
   if(color.x!=0.){changed=maskSaturation(changed/${white},color.x,${scene})*${white};}
   if(!localMaskFinite(changed)){atomicAdd(&result.peak,1u);}
   rgb=mix(rgb,changed,amount);
  }
 }`
     : `rgb=applyLocalMasks(rgb,vec2f(f32(i%proof.size.y)+.5,f32(i/proof.size.y)+.5),${white},${scene});`
 }
 proofStore(i,rgb,pixel.a);
}`
  return `${prefix.source}
${controlsDeclaration}
@group(0) @binding(5) var<storage,read> candidate:array<vec4u>;
@group(0) @binding(6) var<storage,read_write> coverageResult:array<f32>;
${numeric ? numericDeclaration : ''}
@compute @workgroup_size(64) fn proofRoot(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x+gid.y*16384u;if(i>=proof.size.x){return;}
 let previous=input[i];let index=proof.size.w;let offset=6u+index*12u;
 let descriptor=maskData[offset];let light=maskData[offset+1u];let config=maskData[offset+2u];
 var amount=0.;if(descriptor.z!=0.){amount=${numeric ? 'numericCoverage[i]' : 'maskCoverage(index,maskCanonical(vec2f(f32(i%proof.size.y)+.5,f32(i/proof.size.y)+.5)))'};}
 coverageResult[i]=amount;
 if(amount==0.){proofStore(i,previous.rgb,previous.a);return;}
 var changed=bitcast<vec4f>(candidate[i]).rgb;
 // Texture alone bypasses hidden RGB; legacy local point edits still execute.
 if(previous.a==0.){changed=previous.rgb;}
 if(config.w!=0.){changed=maskBalance(changed,offset,${scene});}
 changed=maskLight(changed,light,config.xy,${white},${scene});
 if(config.z!=0.){changed=maskSaturation(changed/${white},config.z,${scene})*${white};}
 if(!localMaskFinite(changed)){atomicAdd(&result.peak,1u);}
 proofStore(i,mix(previous.rgb,changed,amount),previous.a);
}`
}

/** Existing isolated device; every call owns admitted disposable buffers. No CPU pixel work. */
export async function createOrderedPointGpu() {
  check(!process.versions.electron, 'requires isolated Node')
  const renderer = new RawGpuRenderer()
  let device, adapter
  try {
    ;({ device, adapter } = await renderer.mergeDevice())
  } catch (error) {
    await renderer.close()
    throw error
  }
  const { GPUBufferUsage: usage, GPUMapMode: mapMode } = globalThis
  let closed = false,
    active
  const pipelines = new Map()
  let retainedMasks
  async function masks(job, signal) {
    const input = job.maskParameters ?? { localMasks: [] }
    check(Array.isArray(input.localMasks), 'missing resolved mask roots')
    if (retainedMasks?.input === input) return retainedMasks
    const size = input.maskGeometry
      ? { width: input.maskGeometry.canonicalWidth, height: input.maskGeometry.canonicalHeight }
      : { width: job.width, height: job.height }
    const prepared = await prepareNativeMaskEdges(
      device,
      { ...neutralAdjustments, ...input },
      size.width,
      size.height,
      Math.min(
        2 * 1024 ** 3,
        job.admission.policy.vram.effectiveBytes - job.admission.reservation.vramBytes,
      ),
      { signal, edgeAdmission: job.admission },
    )
    const parameters = prepared.adjustments
    const plan = maskBaseAtlasPlan(parameters, true)
    retainedMasks = {
      input,
      parameters,
      plan,
      packed: packLocalMasks(parameters, { width: job.width, height: job.height }, true),
    }
    return retainedMasks
  }

  async function execute(job, signal, spec) {
    check(!closed && !active, 'owner is closed or already executing')
    signal ??= new AbortController().signal
    signal.throwIfAborted()
    validateExportAdmission(job.admission)
    const buffers = [],
      make = (size, flags) => {
        size = Math.max(4, size)
        check(
          size <= device.limits.maxBufferSize &&
            (!(flags & usage.STORAGE) || size <= device.limits.maxStorageBufferBindingSize),
          'actual device buffer limit exceeded',
        )
        const value = device.createBuffer({ size, usage: flags })
        buffers.push(value)
        return value
      }
    const storage = usage.STORAGE | usage.COPY_DST | usage.COPY_SRC
    const partsOf = (input) => input.parts ?? [input.data]
    const inputBytes = spec.inputs.reduce(
      (n, input) =>
        n +
        Math.max(
          4,
          partsOf(input).reduce((sum, part) => sum + part.byteLength, 0),
        ),
      0,
    )
    const gpuBytes =
      inputBytes +
      spec.outputs.reduce((n, x) => n + Math.max(4, x.bytes) * 2, 0) +
      (spec.maskAtlas?.plan.bytes ?? 0)
    const backings = [...new Set(spec.inputs.flatMap(partsOf).map((part) => part.buffer))]
    const ramBytes =
      backings.reduce((n, b) => n + b.byteLength, 0) +
      inputBytes +
      spec.outputs.reduce((n, x) => n + x.bytes * 3, 0) +
      1024 ** 2 +
      (spec.maskAtlas
        ? spec.maskAtlas.plan.decodeBytes +
          spec.maskAtlas.plan.uploadBytes +
          JSON.stringify(spec.maskAtlas.parameters).length * 2
        : 0)
    check(
      gpuBytes + job.admission.reservation.vramBytes <= job.admission.policy.vram.effectiveBytes &&
        ramBytes + job.admission.reservation.ramBytes <= job.admission.policy.ram.effectiveBytes,
      'unchanged Automatic resource policy refuses Texture point stage; no CPU/reduced-resolution fallback',
    )
    const operation = (async () => {
      let openScopes = 0,
        atlas
      const popScopes = async () => {
        const messages = []
        while (openScopes > 0) {
          openScopes--
          const error = await device.popErrorScope()
          if (error) messages.push(error.message)
        }
        return messages
      }
      try {
        for (const filter of ['internal', 'out-of-memory', 'validation']) {
          device.pushErrorScope(filter)
          openScopes++
        }
        // Explicit layouts allow intentionally retained production bindings that
        // an entry-point reachability pass may eliminate (for example precision).
        const layoutEntries = [
          ...spec.inputs.map((input) => ({
            binding: input.binding,
            visibility: globalThis.GPUShaderStage.COMPUTE,
            buffer: { type: input.uniform ? 'uniform' : 'read-only-storage' },
          })),
          ...(spec.maskAtlas
            ? [
                {
                  binding: 18,
                  visibility: globalThis.GPUShaderStage.COMPUTE,
                  texture: { sampleType: 'float', viewDimension: '2d-array', multisampled: false },
                },
              ]
            : []),
          ...spec.outputs.map((output) => ({
            binding: output.binding,
            visibility: globalThis.GPUShaderStage.COMPUTE,
            buffer: { type: 'storage' },
          })),
        ].sort((a, b) => a.binding - b.binding)
        check(
          new Set(layoutEntries.map((entry) => entry.binding)).size === layoutEntries.length,
          'duplicate proof binding',
        )
        const pipelineKey = `${spec.shader}\n${JSON.stringify(layoutEntries)}`
        let pending = pipelines.get(pipelineKey)
        if (!pending) {
          pending = (async () => {
            const module = device.createShaderModule({ code: spec.shader })
            const errors = (await module.getCompilationInfo()).messages.filter(
              (x) => x.type === 'error',
            )
            check(
              errors.length === 0,
              errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('\n'),
            )
            const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries })
            return device.createComputePipelineAsync({
              layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
              compute: { module, entryPoint: spec.entry },
            })
          })()
          pipelines.set(pipelineKey, pending)
        }
        const pipeline = await pending,
          entries = [],
          reads = []
        for (const input of spec.inputs) {
          const parts = partsOf(input)
          const buffer = make(
            parts.reduce((n, part) => n + part.byteLength, 0),
            input.uniform ? usage.UNIFORM | usage.COPY_DST : storage,
          )
          let offset = 0
          for (const part of parts) {
            device.queue.writeBuffer(buffer, offset, part.buffer, part.byteOffset, part.byteLength)
            offset += part.byteLength
          }
          entries.push({ binding: input.binding, resource: { buffer } })
        }
        for (const output of spec.outputs) {
          const buffer = make(output.bytes, storage),
            read = make(output.bytes, usage.MAP_READ | usage.COPY_DST)
          entries.push({ binding: output.binding, resource: { buffer } })
          reads.push({ buffer, read })
        }
        if (spec.maskAtlas) {
          atlas = await createMaskBaseAtlas(device, spec.maskAtlas.parameters, true)
          entries.push({ binding: 18, resource: atlas.createView({ dimension: '2d-array' }) })
        }
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(
          Math.min(256, Math.ceil(spec.pixels / 64)),
          Math.ceil(spec.pixels / 16384),
        )
        pass.end()
        for (const { buffer, read } of reads)
          encoder.copyBufferToBuffer(buffer, 0, read, 0, read.size)
        device.queue.submit([encoder.finish()])
        await device.queue.onSubmittedWorkDone()
        const errors = await popScopes()
        check(errors.length === 0, `GPU ${spec.entry} failed: ${errors.join('; ')}`)
        signal.throwIfAborted()
        const results = []
        for (const { read } of reads) {
          await read.mapAsync(mapMode.READ)
          try {
            results.push(new Uint8Array(read.getMappedRange()).slice())
          } finally {
            read.unmap()
          }
        }
        return {
          results,
          memory: { gpuBytes, ramBytes },
          adapter,
          backend: 'gpu',
          cpuFeatureFallback: false,
        }
      } finally {
        try {
          await device.queue.onSubmittedWorkDone().catch(() => undefined)
          await popScopes()
        } finally {
          for (const b of buffers) b.destroy()
          atlas?.destroy()
        }
      }
    })()
    active = operation
    try {
      return await operation
    } finally {
      active = undefined
    }
  }

  async function point(kind, job, signal) {
    const pixels = shape(job),
      input = kind === 'root' ? job.previous : job.data
    rgba(input, pixels)
    if (kind === 'root') rgba(job.candidate, pixels)
    const domain = job.domain,
      adjustments = kind === 'root' ? neutralAdjustments : (job.adjustments ?? neutralAdjustments)
    const packed = kind !== 'global' ? await masks(job, signal) : undefined
    const prefix = productionPrefix(
      domain,
      adjustments,
      kind !== 'global',
      Boolean(packed?.plan.bases.length),
    )
    const numeric =
      kind === 'root' ? job.numericCoverage !== undefined : job.numericCoverages !== undefined
    const values = parameters({ ...job, adjustments }, pixels),
      control = new Uint32Array([pixels, job.width, job.height, job.maskIndex ?? 0])
    const inputs = [
      { binding: 1, data: input },
      { binding: 7, data: control, uniform: true },
    ]
    if (kind !== 'root' || domain === 'raster')
      inputs.push({ binding: 0, data: values, uniform: true })
    if (domain === 'scene-linear')
      inputs.push({ binding: 3, data: exportPrecisionData, uniform: true })
    if (prefix.creative)
      inputs.push({
        binding: domain === 'authored-hdr' ? 13 : 12,
        data: packCreativeColor(prefix.color),
      })
    if (prefix.curves)
      inputs.push({
        binding: domain === 'authored-hdr' ? 15 : 14,
        data: packToneCurves(prefix.compiledCurves),
      })
    if (kind !== 'global') {
      inputs.push({ binding: 16, data: packed.packed })
      if (kind === 'root')
        check(
          Number.isSafeInteger(job.maskIndex) &&
            job.maskIndex >= 0 &&
            job.maskIndex < packed.parameters.localMasks.length,
          'invalid root index',
        )
      if (numeric) {
        let data
        if (kind === 'root') {
          coverage(job.numericCoverage, pixels)
          data = job.numericCoverage
        } else {
          check(
            Array.isArray(job.numericCoverages) &&
              job.numericCoverages.length === packed.parameters.localMasks.length,
            'numeric root coverage count differs',
          )
          check(job.numericCoverages.length > 0, 'numeric legacy requires at least one root')
          job.numericCoverages.forEach((values) => coverage(values, pixels))
          inputs.push({ binding: 8, parts: job.numericCoverages })
        }
        if (data) inputs.push({ binding: 8, data })
      }
    }
    const outputs = [{ binding: 2, bytes: 4 + pixels * 16 }]
    if (kind === 'root') {
      inputs.push({ binding: 5, data: job.candidate })
      outputs.push({ binding: 6, bytes: pixels * 4 })
    }
    const result = await execute(job, signal, {
      shader: shaderFor(kind, domain, prefix, numeric),
      entry: kind === 'global' ? 'proofGlobal' : kind === 'legacy' ? 'proofLegacy' : 'proofRoot',
      inputs,
      outputs,
      pixels,
      maskAtlas: packed?.plan.bases.length ? packed : undefined,
    })
    const words = copyWords(result.results[0])
    check(words[0] === 0, 'nonfinite point/composite output; no precision repair')
    return {
      ...result,
      data: new Float32Array(words.slice(1).buffer),
      ...(kind === 'root'
        ? { coverage: new Float32Array(copyWords(result.results[1]).buffer) }
        : {}),
      results: undefined,
    }
  }

  return {
    adapter,
    global: (job, signal) => point('global', job, signal),
    root: (job, signal) => point('root', job, signal),
    legacy: (job, signal) => point('legacy', job, signal),
    async union(job, signal) {
      const pixels = shape(job)
      check(
        Array.isArray(job.coverages) && job.coverages.length > 0 && job.coverages.length <= 32,
        'invalid union coverage count',
      )
      job.coverages.forEach((values) => coverage(values, pixels))
      const shader = `struct Control{size:vec4u} @group(0) @binding(0) var<uniform> p:Control; @group(0) @binding(1) var<storage,read> values:array<f32>; @group(0) @binding(2) var<storage,read_write> output:array<f32>; @compute @workgroup_size(64) fn unionCoverage(@builtin(global_invocation_id) gid:vec3u){let i=gid.x+gid.y*16384u;if(i>=p.size.x){return;}var value=0.;for(var j=0u;j<p.size.y;j++){value=max(value,values[j*p.size.x+i]);}output[i]=value;}`
      const result = await execute(job, signal, {
        shader,
        entry: 'unionCoverage',
        pixels,
        inputs: [
          {
            binding: 0,
            data: new Uint32Array([pixels, job.coverages.length, 0, 0]),
            uniform: true,
          },
          { binding: 1, parts: job.coverages },
        ],
        outputs: [{ binding: 2, bytes: pixels * 4 }],
      })
      return {
        ...result,
        coverage: new Float32Array(copyWords(result.results[0]).buffer),
        results: undefined,
      }
    },
    async select(job, signal) {
      const pixels = shape(job),
        wordsPerPixel = job.wordsPerPixel
      check(
        Number.isSafeInteger(wordsPerPixel) && wordsPerPixel >= 1 && wordsPerPixel <= 8,
        'invalid native word stride',
      )
      check(
        ArrayBuffer.isView(job.legacy) &&
          ArrayBuffer.isView(job.candidate) &&
          job.legacy.byteLength === pixels * wordsPerPixel * 4 &&
          job.candidate.byteLength === job.legacy.byteLength,
        'invalid native output planes',
      )
      coverage(job.coverage, pixels)
      const alpha = job.alpha ?? new Float32Array([1]),
        stride = job.alpha ? job.alpha.length / pixels : 0
      check(
        alpha instanceof Float32Array && [0, 1, 4].includes(stride),
        'invalid source alpha layout',
      )
      const shader = `struct Control{size:vec4u} @group(0) @binding(0) var<uniform> p:Control; @group(0) @binding(1) var<storage,read> legacy:array<u32>; @group(0) @binding(2) var<storage,read> candidate:array<u32>; @group(0) @binding(3) var<storage,read> coverage:array<f32>; @group(0) @binding(4) var<storage,read> alpha:array<f32>; @group(0) @binding(5) var<storage,read_write> output:array<u32>; @group(0) @binding(6) var<storage,read_write> counts:array<atomic<u32>>; @compute @workgroup_size(64) fn selectWords(@builtin(global_invocation_id) gid:vec3u){let i=gid.x+gid.y*16384u;if(i>=p.size.x){return;}var visible=true;if(p.size.z>0u){let offset=select(0u,3u,p.size.z==4u);visible=alpha[i*p.size.z+offset]!=0.;}let chooseCandidate=coverage[i]>0.&&visible;atomicAdd(&counts[select(0u,1u,chooseCandidate)],1u);for(var j=0u;j<p.size.y;j++){let k=i*p.size.y+j;output[k]=select(legacy[k],candidate[k],chooseCandidate);}}`
      const result = await execute(job, signal, {
        shader,
        entry: 'selectWords',
        pixels,
        inputs: [
          { binding: 0, data: new Uint32Array([pixels, wordsPerPixel, stride, 0]), uniform: true },
          { binding: 1, data: bytesOf(job.legacy) },
          { binding: 2, data: bytesOf(job.candidate) },
          { binding: 3, data: job.coverage },
          { binding: 4, data: alpha },
        ],
        outputs: [
          { binding: 5, bytes: job.legacy.byteLength },
          { binding: 6, bytes: 8 },
        ],
      })
      const counts = copyWords(result.results[1])
      return {
        ...result,
        data: copyWords(result.results[0]),
        legacyPixels: counts[0],
        selectedPixels: counts[1],
        results: undefined,
      }
    },
    async close() {
      if (closed) return
      closed = true
      await active?.catch(() => undefined)
      await device.queue.onSubmittedWorkDone().catch(() => undefined)
      await renderer.close()
    },
  }
}
