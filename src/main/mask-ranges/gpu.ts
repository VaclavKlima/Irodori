import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import {
  RGB_TO_XYZ,
  XYZ_TO_OKLAB_LMS,
  OKLAB_LMS_TO_LAB,
  type ColorPrimaries,
} from '../../shared/color-model'
import { maskRangeParameters, validateMaskRange, type MaskRange } from '../../shared/mask-ranges'
import { maskCapabilities } from '../../shared/masks'
import type { MaskRangeSource } from './types'

export const MASK_RANGE_ROWS = 64
const matrix = (rows: readonly (readonly number[])[]) =>
  `mat3x3f(${[0, 1, 2].map((column) => `vec3f(${rows.map((row) => row[column]).join(',')})`).join(',')})`

export function maskRangeShader(primaries: ColorPrimaries) {
  return `
struct Parameters { values:array<vec4f,8> }
@group(0) @binding(0) var<uniform> params:Parameters;
@group(0) @binding(1) var<storage,read> source:array<vec4f>;
struct Result { invalid:atomic<u32>, packed:array<u32> }
@group(0) @binding(2) var<storage,read_write> result:Result;
fn finite(v:vec4f)->bool {return all(v==v) && all(abs(v)<=vec4f(3.4028234663852886e38));}
fn transition(low:f32,high:f32,value:f32)->f32 {
 if(high<=low){return select(0.,1.,value>=high);}
 let t=clamp((value-low)/(high-low),0.,1.);return t*t*(3.-2.*t);
}
fn coverage(pixel:vec4f)->f32 {
 if(!finite(pixel) || pixel.a<0. || pixel.a>1.){atomicStore(&result.invalid,1u);return 0.;}
 if(pixel.a==0.){return 0.;}
 let y=dot(pixel.rgb,vec3f(${RGB_TO_XYZ[primaries][1].join(',')}));
 if(y!=y || abs(y)>3.4028234663852886e38){atomicStore(&result.invalid,1u);return 0.;}
 if(params.values[0].x==1.){
  if(y<0.){return 0.;}
  let lower=params.values[1].x;let upper=params.values[1].y;let width=params.values[1].z;
  var value=1.;
  if(y<lower){value=transition(lower-width,lower,y);}
  if(upper>=0. && y>upper){value*=1.-transition(upper,upper+width,y);}
  return value;
 }
 let magnitude=max(abs(pixel.r),max(abs(pixel.g),abs(pixel.b)));
 if(magnitude==0.){return 0.;}
 let rgb=pixel.rgb/magnitude;
 if(dot(rgb,vec3f(${RGB_TO_XYZ[primaries][1].join(',')}))<=0.){return 0.;}
 let xyz=${matrix(RGB_TO_XYZ[primaries])}*rgb;
 let lms=${matrix(XYZ_TO_OKLAB_LMS)}*xyz;
 let roots=sign(lms)*pow(abs(lms),vec3f(1./3.));
 let lab=${matrix(OKLAB_LMS_TO_LAB)}*roots;
 if(lab.x<=.000001){return 0.;}
 let q=lab.yz/lab.x;
 if(any(abs(q)>vec2f(1e7)) || any(q!=q)){return 0.;}
 if(params.values[0].z>=1.){return 1.;}
 var nearest=1.;
 for(var sample=0u;sample<u32(params.values[0].y);sample++){
  let delta=abs(q-params.values[2u+sample].xy);
  let scale=max(delta.x,delta.y);
  var distance=0.;
  if(scale>0.){distance=scale*length(delta/scale);}
  nearest=min(nearest,distance/(1.+distance));
 }
 let radius=params.values[0].z;let outer=params.values[0].w;
 if(outer<=radius){return select(0.,1.,nearest<=radius);}
 return 1.-transition(radius,outer,nearest);
}
@compute @workgroup_size(256) fn classify(@builtin(global_invocation_id) id:vec3u){
 let first=id.x*4u;let count=u32(params.values[1].w);
 if(first>=count){return;}var word=0u;
 for(var offset=0u;offset<4u;offset++){
  if(first+offset<count){word|=u32(floor(clamp(coverage(source[first+offset]),0.,1.)*255.+.5))<<(offset*8u);}
 }
 result.packed[id.x]=word;
}
`
}

/** One bounded GPU classification pass; only source I/O and PNG encoding run on CPU. */
export async function prepareMaskRangeBase(
  device: GPUDevice,
  source: MaskRangeSource,
  range: MaskRange,
  signal: AbortSignal,
): Promise<Uint8Array> {
  validateMaskRange(range)
  signal.throwIfAborted()
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 1 ||
    source.height < 1 ||
    source.width > 32768 ||
    source.height > 32768 ||
    source.width * source.height > maskCapabilities.maxBasePixels ||
    source.byteLength !== source.width * source.height * 16 ||
    !/^[a-f\d]{64}$/.test(source.sha256) ||
    !['srgb', 'rec2020'].includes(source.primaries)
  )
    throw new Error('Range masks require a bounded canonical linear source.')
  const info = await lstat(source.path)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== source.byteLength)
    throw new Error('The canonical range source is incomplete.')
  const file = await open(source.path, 'r')
  const opened = await file.stat()
  if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
    await file.close()
    throw new Error('The canonical range source changed before reading.')
  }
  const resources: GPUBuffer[] = []
  let failure: unknown
  const pixels = source.width * Math.min(MASK_RANGE_ROWS, source.height)
  const packedBytes = Math.ceil(pixels / 4) * 4 + 4
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    if (
      size > device.limits.maxBufferSize ||
      ((usage & GPUBufferUsage.STORAGE) !== 0 && size > device.limits.maxStorageBufferBindingSize)
    )
      throw new Error('Range classification exceeds this GPU buffer limit.')
    const result = device.createBuffer({ size, usage })
    resources.push(result)
    return result
  }
  const output = new Uint8Array(source.width * source.height)
  const hash = createHash('sha256')
  device.pushErrorScope('validation')
  try {
    const uniform = buffer(128, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const input = buffer(pixels * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const packed = buffer(
      packedBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    )
    const readback = buffer(packedBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    const module = device.createShaderModule({
      label: 'Source-relative range masks',
      code: maskRangeShader(source.primaries),
    })
    const errors = (await module.getCompilationInfo()).messages.filter(
      (item) => item.type === 'error',
    )
    if (errors.length) throw new Error(errors.map((item) => item.message).join('\n'))
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'classify' },
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: input } },
        { binding: 2, resource: { buffer: packed } },
      ],
    })
    const parameters = new Float32Array(32)
    const prepared = maskRangeParameters(range)
    if (range.kind === 'color') {
      parameters.set([0, range.samples.length, prepared.radius!, prepared.outer!])
      range.samples.forEach((sample, index) => parameters.set([sample.a, sample.b], 8 + index * 4))
    } else parameters.set([1, 0, 0, 0, prepared.lower!, prepared.upper ?? -1, prepared.transition!])
    for (let top = 0; top < source.height; top += MASK_RANGE_ROWS) {
      signal.throwIfAborted()
      const count = source.width * Math.min(MASK_RANGE_ROWS, source.height - top)
      const bytes = Buffer.allocUnsafe(count * 16)
      const read = await file.read(bytes, 0, bytes.byteLength, top * source.width * 16)
      if (read.bytesRead !== bytes.byteLength)
        throw new Error('The canonical range source strip is incomplete.')
      hash.update(bytes)
      parameters[7] = count
      device.queue.writeBuffer(uniform, 0, parameters)
      device.queue.writeBuffer(input, 0, bytes)
      device.queue.writeBuffer(packed, 0, new Uint32Array([0]))
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(count / 1024))
      pass.end()
      const size = Math.ceil(count / 4) * 4 + 4
      encoder.copyBufferToBuffer(packed, 0, readback, 0, size)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ, 0, size)
      try {
        const mapped = readback.getMappedRange(0, size)
        if (new Uint32Array(mapped, 0, 1)[0])
          throw new Error('The canonical range source contains invalid pixels.')
        output.set(new Uint8Array(mapped, 4, count), top * source.width)
      } finally {
        readback.unmap()
      }
    }
    if (hash.digest('hex') !== source.sha256)
      throw new Error('The canonical range source hash changed.')
    signal.throwIfAborted()
  } catch (error) {
    failure = error
  } finally {
    await file.close()
    await device.queue.onSubmittedWorkDone().catch((error: unknown) => {
      failure ??= error
    })
    for (const resource of resources) resource.destroy()
    const validation = await device.popErrorScope()
    if (validation) failure ??= new Error(validation.message)
  }
  if (failure) throw failure
  return output
}
