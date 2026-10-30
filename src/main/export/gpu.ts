import { displayRenderingWgsl } from '../../shared/display-rendering-wgsl'
import { hdrAdjustmentShader } from '../../shared/hdr-adjustments-wgsl'
import { creativeColorActive, prepareCreativeColor } from '../../shared/creative-color'
import { packCreativeColor, CREATIVE_COLOR_PARAMETER_BYTES } from '../../shared/creative-color-gpu'
import { packAces, ACES_DATA_BYTES } from '../../shared/aces-data'
import {
  prepareDisplayRendering,
  REC2020_TO_ACES,
  HDR_CONTENT_TARGET,
} from '../../shared/display-rendering'
import { SDR_TARGET } from '../../shared/hdr'
import type { AdjustmentParameters } from '../../shared/adjustments'
import { RawGpuRenderer } from '../gpu/raw-renderer'
import { exportPrecisionData, exportPrecisionWgsl } from './precision-wgsl'
import {
  exportGpuAllocation,
  EXPORT_GPU_LIMIT_BYTES,
  ExportResourceError,
} from '../../shared/export-resources'

const inputMatrix =
  'mat3x3f(' + REC2020_TO_ACES.map((row) => 'vec3f(' + row.join(',') + ')').join(',') + ')'

/** Two fixed renditions use the same reference shader, with per-invocation table selection. */
export function exportShader(
  hdr: boolean,
  packed: boolean,
  workgroup = 64,
  deferred = false,
  creative = false,
) {
  const precision = /fn acesMath\(index:u32\)->vec2f\s*\{[^}]+\}/
  if (!precision.test(displayRenderingWgsl))
    throw new Error('Reference ACES precision lookup is unavailable.')
  const tableWords = ACES_DATA_BYTES / 16
  const rendering = displayRenderingWgsl
    .replace(precision, exportPrecisionWgsl)
    .replace(`array<vec4f,${tableWords}>`, `array<vec4f,${tableWords * 2}>`)
    .replaceAll('acesData.values[', 'acesData.values[acesOffset+')
  const channels = hdr ? 6 : 3
  const reduction = `workgroupBarrier();
 for(var step=${workgroup / 2}u;step>0u;step/=2u) {
  if(local<step) {peaks[local]=max(peaks[local],peaks[local+step]);}
  workgroupBarrier();
 }
 if(local==0u) {atomicMax(&result.peak,bitcast<u32>(peaks[0]));}`
  return `
var<private> acesOffset:i32;
${rendering}
struct Params { values:array<vec4f,12> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
struct Result { peak:atomic<u32>, values:array<u32> }
@group(0) @binding(2) var<storage,read_write> result:Result;
${deferred ? '@group(0) @binding(5) var<storage,read_write> working:array<f32>;' : ''}
${hdrAdjustmentShader(creative)}
${hdr && packed ? `var<workgroup> peaks:array<f32,${workgroup}>;` : ''}
fn exportTarget(jmh:vec3f,linear:f32)->vec3f {
 let toned=Y_to_J(tonescale_fwd(linear,aces_ts()),aces_input_params());
 return JMh_to_RGB(gamut_compress_fwd(chroma_compress_fwd(jmh,toned)),aces_limit_params());
}
@compute @workgroup_size(${workgroup}) fn render(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) local:u32) {
 ${hdr && packed && !deferred ? 'peaks[local]=0.;' : ''}
 if(id.x<u32(u.values[0].x)) {
 let pixel=input[id.x];
 let aces=${inputMatrix}*adjusted(pixel.rgb);
 acesOffset=0;
 let sdrInput=clamp_AP0_to_AP1(aces,0.,aces_ts().forward_limit);
 let jmh=RGB_to_JMh(sdrInput,aces_input_params());
 let linear=J_to_Y(jmh.x,aces_input_params())/ref_luminance;
 let sdr=clamp(exportTarget(jmh,linear),vec3f(0.),vec3f(1.))*pixel.a+vec3f(1.-pixel.a);
 ${
   hdr
     ? `acesOffset=${tableWords};
 let hdrInput=clamp_AP0_to_AP1(aces,0.,aces_ts().forward_limit);
 var hdrJmh=jmh;
 var hdrLinear=linear;
 if(any(hdrInput!=sdrInput)) {
  hdrJmh=RGB_to_JMh(hdrInput,aces_input_params());
  hdrLinear=J_to_Y(hdrJmh.x,aces_input_params())/ref_luminance;
 }
 ${
   deferred
     ? `let slot=(u32(u.values[0].y)+id.x)*5u;
 working[slot]=hdrJmh.x; working[slot+1u]=hdrJmh.y; working[slot+2u]=hdrJmh.z;
 working[slot+3u]=pixel.a; working[slot+4u]=hdrLinear;`
     : 'let hdr=clamp(exportTarget(hdrJmh,hdrLinear),vec3f(0.),vec3f(10.))*pixel.a+vec3f(1.-pixel.a);'
 }`
     : ''
 }
 ${
   packed
     ? `let rgb=vec3u(floor(clamp(encodeDisplayRgb(sdr),vec3f(0.),vec3f(1.))*255.+.5));
 result.values[id.x*${hdr && !deferred ? 3 : 1}u]=rgb.r | (rgb.g<<8u) | (rgb.b<<16u);
 ${hdr && !deferred ? 'result.values[id.x*3u+1u]=pack2x16float(hdr.rg); result.values[id.x*3u+2u]=pack2x16float(vec2f(hdr.b,1.)); peaks[local]=max(hdr.r,max(hdr.g,hdr.b));' : ''}`
     : `result.values[id.x*${channels}u]=bitcast<u32>(sdr.r);
 result.values[id.x*${channels}u+1u]=bitcast<u32>(sdr.g);
 result.values[id.x*${channels}u+2u]=bitcast<u32>(sdr.b);
 ${hdr ? 'result.values[id.x*6u+3u]=bitcast<u32>(hdr.r); result.values[id.x*6u+4u]=bitcast<u32>(hdr.g); result.values[id.x*6u+5u]=bitcast<u32>(hdr.b);' : ''}`
 }
 }
 ${hdr && packed && !deferred ? reduction : ''}
}
${
  deferred
    ? `@compute @workgroup_size(${workgroup}) fn renderHdr(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) local:u32) {
 peaks[local]=0.;
 if(id.x<u32(u.values[0].x)) {
  let slot=(u32(u.values[0].y)+id.x)*5u;
  acesOffset=${tableWords};
  let jmh=vec3f(working[slot],working[slot+1u],working[slot+2u]);
  let alpha=working[slot+3u];
  let hdr=clamp(exportTarget(jmh,working[slot+4u]),vec3f(0.),vec3f(10.))*alpha+vec3f(1.-alpha);
  result.values[id.x*3u+1u]=pack2x16float(hdr.rg);
  result.values[id.x*3u+2u]=pack2x16float(vec2f(hdr.b,1.));
  peaks[local]=max(hdr.r,max(hdr.g,hdr.b));
 }
 ${reduction}
}`
    : ''
}
`
}

/** Bounded native Dawn compute in the export Node worker; never creates an Electron surface. */
export async function createExportGpu(
  capacity: number,
  adjustments: AdjustmentParameters,
  whiteBalance: readonly number[] | undefined,
  hdr: boolean,
  packed: boolean,
  workgroup = 64,
  deferredPixels = 0,
  vramLimitBytes = EXPORT_GPU_LIMIT_BYTES,
) {
  if (process.versions.electron) throw new Error('GPU export requires the isolated Node worker.')
  if (![32, 64, 128, 256].includes(workgroup)) throw new Error('Invalid export workgroup size.')
  if (!Number.isSafeInteger(deferredPixels) || deferredPixels < 0)
    throw new Error('Invalid retained export dimensions.')
  adjustments = structuredClone(adjustments)
  whiteBalance = whiteBalance ? [...whiteBalance] : undefined
  const color = prepareCreativeColor(adjustments),
    creative = creativeColorActive(color)
  const allocation = exportGpuAllocation(
    capacity,
    hdr,
    packed,
    creative,
    deferredPixels,
    vramLimitBytes,
  )
  if (!allocation.accepted)
    throw new ExportResourceError('GPU export exceeds the frozen managed image budgets.')
  const gpu = new RawGpuRenderer(),
    resources: GPUBuffer[] = []
  let queue: GPUQueue | undefined,
    pending: Promise<{ data: Buffer; headroom: number }> | undefined,
    closing = false,
    drained: Promise<void> | undefined
  const close = () =>
    (drained ??= (async () => {
      closing = true
      await pending?.catch(() => undefined)
      await queue?.onSubmittedWorkDone().catch(() => undefined)
      for (const buffer of resources) buffer.destroy()
      gpu.close()
    })())
  try {
    const { device, adapter } = await gpu.mergeDevice()
    queue = device.queue
    const stride = packed ? (hdr ? 3 : 1) : hdr ? 6 : 3
    const buffer = (size: number, usage: number) => {
      if (size > device.limits.maxBufferSize || size > device.limits.maxStorageBufferBindingSize)
        throw new Error('Export tile exceeds the GPU allocation limit.')
      if (usage & GPUBufferUsage.UNIFORM && size > device.limits.maxUniformBufferBindingSize)
        throw new Error('Export uniforms exceed the GPU allocation limit.')
      if (resources.reduce((sum, buffer) => sum + buffer.size, size) > allocation.limitBytes)
        throw new ExportResourceError('GPU export exceeds the frozen managed image budgets.')
      const value = device.createBuffer({ size, usage })
      resources.push(value)
      return value
    }
    const uniform = buffer(192, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      input = buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      output = buffer(
        4 + capacity * stride * 4,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      ),
      staging = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      tables = buffer(ACES_DATA_BYTES * 2, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      math = buffer(
        exportPrecisionData.byteLength,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      )
    device.queue.writeBuffer(math, 0, exportPrecisionData)
    const colorData = creative
      ? buffer(CREATIVE_COLOR_PARAMETER_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      : undefined
    if (colorData) device.queue.writeBuffer(colorData, 0, packCreativeColor(color!))
    const workingBytes = deferredPixels * 20
    const hdrDeferred = !!(
      hdr &&
      packed &&
      deferredPixels &&
      workingBytes <= device.limits.maxBufferSize &&
      workingBytes <= device.limits.maxStorageBufferBindingSize &&
      allocation.deferredBytes > 0
    )
    const working = hdrDeferred ? buffer(workingBytes, GPUBufferUsage.STORAGE) : undefined
    const sdrParameters = prepareDisplayRendering(SDR_TARGET),
      hdrParameters = prepareDisplayRendering(HDR_CONTENT_TARGET)
    // Only the AP0 input stage is shared. Distinct forward limits still clamp independently.
    if (JSON.stringify(sdrParameters.input_params) !== JSON.stringify(hdrParameters.input_params))
      throw new Error('Export ACES input parameters cannot be shared.')
    device.queue.writeBuffer(tables, 0, packAces(sdrParameters))
    device.queue.writeBuffer(tables, ACES_DATA_BYTES, packAces(hdrParameters))
    const values = new Float32Array(48)
    values.set(
      [adjustments.exposureEv, adjustments.contrast, adjustments.highlights, adjustments.shadows],
      8,
    )
    values.set([adjustments.whites, adjustments.blacks], 12)
    values.set([adjustments.saturation, adjustments.vibrance], 44)
    if (whiteBalance) {
      values[19] = 1
      for (let row = 0; row < 3; row++)
        values.set(whiteBalance.slice(row * 3, row * 3 + 3), 20 + row * 4)
    }
    const module = device.createShaderModule({
      code: exportShader(hdr, packed, workgroup, hdrDeferred, creative),
    })
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'))
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'render' },
    })
    const commonEntries = [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 2, resource: { buffer: output } },
      { binding: 3, resource: { buffer: math } },
      { binding: 4, resource: { buffer: tables } },
      ...(working ? [{ binding: 5, resource: { buffer: working } }] : []),
    ]
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        ...commonEntries,
        { binding: 1, resource: { buffer: input } },
        ...(colorData ? [{ binding: 12, resource: { buffer: colorData } }] : []),
      ],
    })
    const hdrPipeline = hdrDeferred
      ? await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'renderHdr' },
        })
      : undefined
    const hdrGroup = hdrPipeline
      ? device.createBindGroup({
          layout: hdrPipeline.getBindGroupLayout(0),
          entries: commonEntries,
        })
      : undefined
    const dispatch = async (
      pixels: Float32Array<ArrayBuffer> | undefined,
      offset: number,
      count: number,
      hdrPass = false,
    ) => {
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > capacity ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (hdrDeferred && offset + count > deferredPixels) ||
        Math.ceil(count / workgroup) > device.limits.maxComputeWorkgroupsPerDimension
      )
        throw new Error('Invalid export tile length.')
      if (hdrPass && !hdrPipeline) throw new Error('HDR rendering was not deferred.')
      values[0] = count
      values[1] = offset
      device.queue.writeBuffer(uniform, 0, values)
      if (pixels) device.queue.writeBuffer(input, 0, pixels)
      device.queue.writeBuffer(output, 0, new Float32Array([1.01]))
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(hdrPass ? hdrPipeline! : pipeline)
      pass.setBindGroup(0, hdrPass ? hdrGroup! : group)
      pass.dispatchWorkgroups(Math.ceil(count / workgroup))
      pass.end()
      const outputStride = hdrDeferred && !hdrPass ? 1 : stride
      encoder.copyBufferToBuffer(output, 0, staging, 0, 4 + count * outputStride * 4)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      try {
        const mapped = staging.getMappedRange()
        const data = Buffer.from(new Uint8Array(mapped, 4, count * outputStride * 4))
        const headroom = new Float32Array(mapped, 0, 1)[0]
        return { data, headroom }
      } finally {
        staging.unmap()
      }
    }
    const run = (
      pixels: Float32Array<ArrayBuffer> | undefined,
      offset: number,
      count: number,
      hdrPass = false,
    ) => {
      if (closing) return Promise.reject(new Error('The export GPU owner is closed.'))
      if (pending) return Promise.reject(new Error('The export GPU owner is busy.'))
      const work = dispatch(pixels, offset, count, hdrPass)
      pending = work
      void work
        .finally(() => {
          if (pending === work) pending = undefined
        })
        .catch(() => undefined)
      return work
    }
    return {
      adapter,
      hdrDeferred,
      peakBytes: resources.reduce((sum, b) => sum + b.size, 0),
      render(pixels: Float32Array<ArrayBuffer>, offset = 0) {
        return run(pixels, offset, pixels.length / 4)
      },
      finishHdr(offset: number, count: number) {
        return run(undefined, offset, count, true)
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
