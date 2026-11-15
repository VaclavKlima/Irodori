// Frozen sampled local-Laplacian residual, masked-texture-llf-residual-v1.
// Halide attribution: assets/app/licenses/halide-texture-LICENSE.txt.
import { RawGpuRenderer } from './raw-renderer.ts'
import { detailLuminance } from '../../shared/spatial-detail.ts'
import { localMasksWgsl, packLocalMasks } from '../../shared/masks-gpu.ts'

const shader = `
struct Params { inputSize:vec4u, outputSize:vec4u, controls:vec4f, luminance:vec4f }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> source:array<vec4u>;
@group(0) @binding(2) var<storage,read> a:array<vec2f>;
@group(0) @binding(3) var<storage,read> b:array<vec2f>;
@group(0) @binding(4) var<storage,read> original:array<vec2f>;
@group(0) @binding(5) var<storage,read_write> destination:array<vec2f>;
@group(0) @binding(6) var<storage,read_write> invalid:array<atomic<u32>>;
@group(0) @binding(7) var<storage,read_write> result:array<vec4u>;
@group(0) @binding(8) var<storage,read> numericCoverage:array<f32>;
@group(0) @binding(10) var<storage,read_write> coverageResult:array<f32>;
${localMasksWgsl(9)}
fn norm(v:vec2f)->f32 {if(v.y>0.){return v.x/v.y;}return 0.;}
fn finite(v:vec3f)->bool{return all((bitcast<vec3u>(v)&vec3u(0x7f800000u))!=vec3u(0x7f800000u));}
fn readA(x:i32,y:i32)->vec2f {
 let point=clamp(vec2i(x,y),vec2i(0),vec2i(p.inputSize.xy)-1);
 return a[u32(point.y)*p.inputSize.x+u32(point.x)];
}
fn readB(x:i32,y:i32)->vec2f {
 let size=(p.inputSize.xy+1u)/2u;
 let point=clamp(vec2i(x,y),vec2i(0),vec2i(size)-1);
 return b[u32(point.y)*size.x+u32(point.x)];
}
fn upA(x:i32,y:i32)->vec2f {
 let tx=f32((x%2)*2+1)*.25;let ty=f32((y%2)*2+1)*.25;
 let x0=(x+1)>>1;let x1=(x-1)>>1;let y0=(y+1)>>1;let y1=(y-1)>>1;
 let top=readA(x0,y0)+(readA(x1,y0)-readA(x0,y0))*tx;
 let bottom=readA(x0,y1)+(readA(x1,y1)-readA(x0,y1))*tx;
 return top+(bottom-top)*ty;
}
fn upB(x:i32,y:i32)->vec2f {
 let tx=f32((x%2)*2+1)*.25;let ty=f32((y%2)*2+1)*.25;
 let x0=(x+1)>>1;let x1=(x-1)>>1;let y0=(y+1)>>1;let y1=(y-1)>>1;
 let top=readB(x0,y0)+(readB(x1,y0)-readB(x0,y0))*tx;
 let bottom=readB(x0,y1)+(readB(x1,y1)-readB(x0,y1))*tx;
 return top+(bottom-top)*ty;
}
@compute @workgroup_size(64) fn features(@builtin(global_invocation_id) gid:vec3u){
 let id=vec3u(gid.x+gid.y*16384u,0u,0u);
 let n=p.outputSize.x*p.outputSize.y;if(id.x>=n){return;}
 let rgba=bitcast<vec4f>(source[id.x]);
 if(!(rgba.a>=0. && rgba.a<=1.)){atomicAdd(&invalid[0],1u);destination[id.x]=vec2f(0.);return;}
 if(rgba.a==0.){destination[id.x]=vec2f(0.);return;}
 let y=dot(rgba.rgb,p.luminance.xyz);let l=asinh(y/.18);
 if(!finite(rgba.rgb)||!(abs(l)<=6.)){atomicAdd(&invalid[0],1u);destination[id.x]=vec2f(0.);return;}
 destination[id.x]=vec2f(l*rgba.a,rgba.a);
}
@compute @workgroup_size(64) fn remap(@builtin(global_invocation_id) gid:vec3u){
 let id=vec3u(gid.x+gid.y*16384u,0u,0u);
 let n=p.outputSize.x*p.outputSize.y;if(id.x>=n){return;}
 let v=a[id.x];if(v.y==0.){destination[id.x]=vec2f(0.);return;}
 let d=norm(v)-p.controls.x;let z=d/.2;
 destination[id.x]=vec2f(d*exp(-.5*z*z)*v.y,v.y);
}
@compute @workgroup_size(64) fn downY(@builtin(global_invocation_id) gid:vec3u){
 let id=vec3u(gid.x+gid.y*16384u,0u,0u);
 let n=p.outputSize.x*p.outputSize.y;if(id.x>=n){return;}
 let x=i32(id.x%p.outputSize.x);let y=2*i32(id.x/p.outputSize.x);let c=readA(x,y);
 destination[id.x]=c+((readA(x,y-1)-c)+3.*(readA(x,y+1)-c)+(readA(x,y+2)-c))*.125;
}
@compute @workgroup_size(64) fn downX(@builtin(global_invocation_id) gid:vec3u){
 let id=vec3u(gid.x+gid.y*16384u,0u,0u);
 let n=p.outputSize.x*p.outputSize.y;if(id.x>=n){return;}
 let x=2*i32(id.x%p.outputSize.x);let y=i32(id.x/p.outputSize.x);let c=readA(x,y);
 destination[id.x]=c+((readA(x-1,y)-c)+3.*(readA(x+1,y)-c)+(readA(x+2,y)-c))*.125;
}
@compute @workgroup_size(64) fn accumulate(@builtin(global_invocation_id) gid:vec3u){
 let id=vec3u(gid.x+gid.y*16384u,0u,0u);
 let n=p.outputSize.x*p.outputSize.y;if(id.x>=n){return;}
 let v=original[id.x];let position=clamp((norm(v)+6.)*8.,0.,96.);
 let weight=max(0.,1.-abs(position-f32(p.outputSize.w)));
 var delta=0.;if(weight>0.){let x=i32(id.x%p.outputSize.x);let y=i32(id.x/p.outputSize.x);delta=norm(a[id.x])-norm(upB(x,y));}
 destination[id.x]=vec2f(destination[id.x].x+weight*delta*v.y,v.y);
}
@compute @workgroup_size(64) fn reconstruct(@builtin(global_invocation_id) gid:vec3u){
 let id=vec3u(gid.x+gid.y*16384u,0u,0u);
 let n=p.outputSize.x*p.outputSize.y;if(id.x>=n){return;}
 let x=i32(id.x%p.outputSize.x);let y=i32(id.x/p.outputSize.x);let v=a[id.x];
 destination[id.x]=vec2f((norm(v)+norm(upB(x,y)))*v.y,v.y);
}
@compute @workgroup_size(64) fn composite(@builtin(global_invocation_id) gid:vec3u){
 let id=vec3u(gid.x+gid.y*16384u,0u,0u);
 let n=p.outputSize.x*p.outputSize.y;if(id.x>=n){return;}
 let x=i32(id.x%p.outputSize.x);let y=i32(id.x/p.outputSize.x);
 var coverage=0.;
 if(p.outputSize.z==0u){coverage=numericCoverage[id.x];}
 else {coverage=maskCoverage(p.outputSize.w,maskCanonical(vec2f(f32(x)+.5+p.controls.z,f32(y)+.5+p.controls.w)));}
 coverageResult[id.x]=coverage;
 let bits=source[id.x];let rgba=bitcast<vec4f>(bits);
 if(coverage==0.||p.controls.y==0.||rgba.a==0.){result[id.x]=bits;return;}
 let d=p.controls.y*norm(upA(x,y));if(d==0.){result[id.x]=bits;return;}
 let y0=dot(rgba.rgb,p.luminance.xyz);let h=sinh(d*.5);
 let change=2.*y0*h*h+sqrt(y0*y0+.0324)*sinh(d);
 let rgb=rgba.rgb+vec3f(coverage*change);
 if(!finite(rgb)||!(coverage>=0. && coverage<=1.)){atomicAdd(&invalid[0],1u);}
 result[id.x]=vec4u(bitcast<vec3u>(rgb),bits.a);
}
`

export async function createTextureGpu() {
  if (process.versions.electron) throw new Error('Texture processing requires isolated Node.')
  const renderer = new RawGpuRenderer()
  let device, adapter, module
  try {
    ;({ device, adapter } = await renderer.mergeDevice())
    module = device.createShaderModule({ code: shader })
  } catch (error) {
    await renderer.close()
    throw error
  }
  const { GPUBufferUsage, GPUMapMode } = globalThis
  const programs = new Map()
  let current,
    closed = false
  const buffer = (bytes, usage) => {
    const size = Math.max(4, bytes)
    if (
      size > device.limits.maxBufferSize ||
      (usage & GPUBufferUsage.STORAGE && size > device.limits.maxStorageBufferBindingSize)
    )
      throw new Error('Texture buffer exceeds actual device limits; no reduced resolution.')
    return device.createBuffer({ size, usage })
  }
  const program = async (name) => {
    if (!programs.has(name))
      programs.set(
        name,
        device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: name },
        }),
      )
    return programs.get(name)
  }
  async function discard() {
    if (!current) return
    await device.queue.onSubmittedWorkDone().catch(() => undefined)
    current.pending.forEach((b) => b.destroy())
    current.buffers.forEach((b) => b.destroy())
    current = undefined
  }
  async function dispatch(
    encoder,
    name,
    bindings,
    input,
    output,
    controls = [0, 0, 0, 0],
    anchor = 0,
  ) {
    const pipeline = await program(name)
    const packet = new ArrayBuffer(64),
      integers = new Uint32Array(packet),
      floats = new Float32Array(packet)
    integers.set([input[0], input[1], 0, 0, output[0], output[1], output[2] ?? 0, anchor])
    floats.set(controls, 8)
    floats.set([...current.coefficients, 0], 12)
    const uniform = buffer(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    device.queue.writeBuffer(uniform, 0, packet)
    current.pending.push(uniform)
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        ...bindings.map(([binding, value]) => ({ binding, resource: { buffer: value } })),
      ],
    })
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(
      Math.min(256, Math.ceil((output[0] * output[1]) / 64)),
      Math.ceil((output[0] * output[1]) / 16384),
    )
    pass.end()
  }
  async function fence(signal) {
    await device.queue.onSubmittedWorkDone()
    current.pending.forEach((b) => b.destroy())
    current.pending = []
    signal.throwIfAborted()
  }
  async function invalidCount() {
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(current.invalid, 0, current.invalidRead, 0, 4)
    device.queue.submit([encoder.finish()])
    await current.invalidRead.mapAsync(GPUMapMode.READ)
    try {
      return new Uint32Array(current.invalidRead.getMappedRange())[0]
    } finally {
      current.invalidRead.unmap()
    }
  }
  return {
    adapter,
    async prepare(job, signal) {
      if (closed) throw new Error('Texture GPU owner is closed.')
      signal.throwIfAborted()
      await discard()
      const { data, width, height, admission } = job
      if (
        !(data instanceof Float32Array) ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        width * height > 24000000 ||
        data.length !== width * height * 4
      )
        throw new Error('Invalid or oversized native Texture frame.')
      const sizes = [[width, height]]
      for (let i = 1; i < 4; i++) sizes.push(sizes[i - 1].map((n) => Math.ceil(n / 2)))
      const pixels = width * height,
        rgbaBytes = pixels * 16
      const pyramidBytes = sizes.reduce((sum, [w, h]) => sum + w * h * 8, 0)
      const temporaryBytes = width * Math.ceil(height / 2) * 8
      const bandsBytes = (sizes[1][0] * sizes[1][1] * 2 + sizes[2][0] * sizes[2][1]) * 8
      const estimatedGpuBytes =
        rgbaBytes * 3 + pixels * 12 + 2 * pyramidBytes + temporaryBytes + bandsBytes + 1024 * 1024
      const estimatedRamBytes =
        Math.max(data.buffer.byteLength, rgbaBytes) + rgbaBytes * 5 + pixels * 12 + 1024 * 1024
      if (
        estimatedGpuBytes + admission.reservation.vramBytes >
          admission.policy.vram.effectiveBytes ||
        estimatedRamBytes + admission.reservation.ramBytes > admission.policy.ram.effectiveBytes
      )
        throw new Error('Automatic policy refuses Texture buffers; no override or CPU fallback.')
      const buffers = [],
        allocate = (n, usage) => {
          const b = buffer(n, usage)
          buffers.push(b)
          return b
        }
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      current = {
        coefficients: detailLuminance(job.primaries),
        buffers,
        pending: [],
        width,
        height,
        sizes,
        estimatedGpuBytes,
        estimatedRamBytes,
        gpuSubmissions: 0,
      }
      try {
        current.source = allocate(rgbaBytes, storage)
        current.output = allocate(rgbaBytes, storage)
        current.read = allocate(rgbaBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
        current.coverage = allocate(pixels * 4, storage)
        current.coverageRead = allocate(
          pixels * 4,
          GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        )
        current.numeric = allocate(pixels * 4, storage)
        current.invalid = allocate(4, storage)
        current.invalidRead = allocate(4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
        current.original = sizes.map(([w, h]) => allocate(w * h * 8, storage))
        current.remapped = sizes.map(([w, h]) => allocate(w * h * 8, storage))
        current.temporary = allocate(temporaryBytes, storage)
        current.delta = [
          undefined,
          ...[1, 2].map((j) => allocate(sizes[j][0] * sizes[j][1] * 8, storage)),
        ]
        current.reconstructed = allocate(sizes[1][0] * sizes[1][1] * 8, storage)
        device.queue.writeBuffer(current.source, 0, data.buffer, data.byteOffset, data.byteLength)
        const started = performance.now()
        let encoder = device.createCommandEncoder()
        await dispatch(
          encoder,
          'features',
          [
            [1, current.source],
            [5, current.original[0]],
            [6, current.invalid],
          ],
          sizes[0],
          sizes[0],
        )
        for (let j = 1; j < 4; j++) {
          await dispatch(
            encoder,
            'downY',
            [
              [2, current.original[j - 1]],
              [5, current.temporary],
            ],
            sizes[j - 1],
            [sizes[j - 1][0], sizes[j][1]],
          )
          await dispatch(
            encoder,
            'downX',
            [
              [2, current.temporary],
              [5, current.original[j]],
            ],
            [sizes[j - 1][0], sizes[j][1]],
            sizes[j],
          )
        }
        device.queue.submit([encoder.finish()])
        await fence(signal)
        if (await invalidCount())
          throw new Error('Nonfinite/unsupported signed feature or alpha; no source clipping.')
        for (let anchor = 0; anchor < 97; anchor++) {
          signal.throwIfAborted()
          encoder = device.createCommandEncoder()
          await dispatch(
            encoder,
            'remap',
            [
              [2, current.original[0]],
              [5, current.remapped[0]],
            ],
            sizes[0],
            sizes[0],
            [-6 + anchor * 0.125, 0, 0, 0],
          )
          for (let j = 1; j < 4; j++) {
            await dispatch(
              encoder,
              'downY',
              [
                [2, current.remapped[j - 1]],
                [5, current.temporary],
              ],
              sizes[j - 1],
              [sizes[j - 1][0], sizes[j][1]],
            )
            await dispatch(
              encoder,
              'downX',
              [
                [2, current.temporary],
                [5, current.remapped[j]],
              ],
              [sizes[j - 1][0], sizes[j][1]],
              sizes[j],
            )
          }
          for (const j of [1, 2])
            await dispatch(
              encoder,
              'accumulate',
              [
                [2, current.remapped[j]],
                [3, current.remapped[j + 1]],
                [4, current.original[j]],
                [5, current.delta[j]],
              ],
              sizes[j],
              sizes[j],
              [0, 0, 0, 0],
              anchor,
            )
          device.queue.submit([encoder.finish()])
          current.gpuSubmissions++
          if (anchor % 8 === 7 || anchor === 96) await fence(signal)
        }
        encoder = device.createCommandEncoder()
        await dispatch(
          encoder,
          'reconstruct',
          [
            [2, current.delta[1]],
            [3, current.delta[2]],
            [5, current.reconstructed],
          ],
          sizes[1],
          sizes[1],
        )
        device.queue.submit([encoder.finish()])
        await fence(signal)
        current.preparationMs = performance.now() - started
        return {
          adapter,
          estimatedGpuBytes,
          estimatedRamBytes,
          preparationMs: current.preparationMs,
          referenceAnchors: 97,
          backend: 'gpu',
          cpuFeatureFallback: false,
        }
      } catch (error) {
        await discard()
        throw error
      }
    },
    async apply(job, signal) {
      if (!current || closed) throw new Error('Prepare an admitted Texture source first.')
      signal.throwIfAborted()
      if (!Number.isInteger(job.amount) || job.amount < -100 || job.amount > 100)
        throw new Error('Invalid Texture amount.')
      const { width, height, sizes } = current
      const numeric = job.coverage !== undefined
      let packed
      if (numeric) {
        if (
          !(job.coverage instanceof Float32Array) ||
          job.coverage.length !== width * height ||
          !job.coverage.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)
        )
          throw new Error('Invalid numeric coverage.')
        device.queue.writeBuffer(current.numeric, 0, job.coverage)
        packed = packLocalMasks({ localMasks: [] }, { width, height }, true)
      } else {
        if (
          !Number.isSafeInteger(job.maskIndex) ||
          job.maskIndex < 0 ||
          job.maskIndex >= job.maskParameters.localMasks.length ||
          !job.maskParameters.localMasks[job.maskIndex].enabled
        )
          throw new Error('Missing enabled Texture mask.')
        packed = packLocalMasks(job.maskParameters, { width, height }, true)
      }
      if (packed.byteLength > 256 * 1024)
        throw new Error('Texture mask packet exceeds reserved metadata.')
      const mask = buffer(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      try {
        device.queue.writeBuffer(mask, 0, packed)
        const encoder = device.createCommandEncoder()
        await dispatch(
          encoder,
          'composite',
          [
            [1, current.source],
            [2, current.reconstructed],
            [6, current.invalid],
            [7, current.output],
            [8, current.numeric],
            [9, mask],
            [10, current.coverage],
          ],
          sizes[1],
          [width, height, numeric ? 0 : 1],
          [0, job.amount / 100, 0, 0],
          numeric ? 0 : job.maskIndex,
        )
        encoder.copyBufferToBuffer(current.output, 0, current.read, 0, current.read.size)
        encoder.copyBufferToBuffer(
          current.coverage,
          0,
          current.coverageRead,
          0,
          current.coverageRead.size,
        )
        device.queue.submit([encoder.finish()])
        await fence(signal)
        await Promise.all([
          current.read.mapAsync(GPUMapMode.READ),
          current.coverageRead.mapAsync(GPUMapMode.READ),
        ])
        let data, coverage
        try {
          data = new Float32Array(current.read.getMappedRange()).slice()
          coverage = new Float32Array(current.coverageRead.getMappedRange()).slice()
        } finally {
          current.read.unmap()
          current.coverageRead.unmap()
        }
        if (await invalidCount())
          throw new Error('Invalid Texture result; no CPU precision repair or retry.')
        return {
          data,
          coverage,
          adapter,
          backend: 'gpu',
          preparationMs: current.preparationMs,
          referenceAnchors: 97,
          cpuFeatureFallback: false,
        }
      } finally {
        await device.queue.onSubmittedWorkDone().catch(() => undefined)
        mask.destroy()
      }
    },
    async close() {
      if (closed) return
      closed = true
      await discard()
      await renderer.close()
    },
  }
}
