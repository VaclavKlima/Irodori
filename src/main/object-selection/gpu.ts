import { RawGpuRenderer } from '../gpu/raw-renderer'
import { OBJECT_SELECTION_MAX_PIXELS } from './model'

const preprocessing = `
struct Params { width:u32, height:u32, horizontal:u32, unused:u32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> input:array<u32>;
@group(0) @binding(2) var<storage,read_write> intermediate:array<vec4f>;
fn rgb(pixel:u32)->vec4f {
 return vec4f(f32(pixel&255u),f32((pixel>>8u)&255u),f32((pixel>>16u)&255u),0.)/255.;
}
// PyTorch antialiased bilinear is a normalized separable triangle widened for reduction.
@compute @workgroup_size(8,8) fn first(@builtin(global_invocation_id) id:vec3u) {
 let outWidth=select(p.width,1024u,p.horizontal==1u);
 let outHeight=select(1024u,p.height,p.horizontal==1u);
 if(id.x>=outWidth || id.y>=outHeight) {return;}
 let extent=select(p.height,p.width,p.horizontal==1u);
 let coordinate=select(id.y,id.x,p.horizontal==1u);
 let scale=f32(extent)/1024.;let support=max(scale,1.);
 let center=(f32(coordinate)+.5)*scale;
 let start=max(0,i32(floor(center-support+.5)));
 let end=min(i32(extent),i32(floor(center+support+.5)));
 var value=vec4f(0.);var total=0.;
 for(var i=start;i<end;i++) {
  let weight=max(0.,1.-abs((f32(i)+.5-center)/support));
  let index=select(u32(i)*p.width+id.x,id.y*p.width+u32(i),p.horizontal==1u);
  value+=rgb(input[index])*weight;total+=weight;
 }
 intermediate[id.y*outWidth+id.x]=value/total;
}
`

const finishing = `
struct Params { width:u32, height:u32, horizontal:u32, unused:u32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> intermediate:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<f32>;
@compute @workgroup_size(8,8) fn second(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=1024u || id.y>=1024u) {return;}
 let extent=select(p.width,p.height,p.horizontal==1u);
 let coordinate=select(id.x,id.y,p.horizontal==1u);
 let scale=f32(extent)/1024.;let support=max(scale,1.);
 let center=(f32(coordinate)+.5)*scale;
 let start=max(0,i32(floor(center-support+.5)));
 let end=min(i32(extent),i32(floor(center+support+.5)));
 var value=vec4f(0.);var total=0.;
 for(var i=start;i<end;i++) {
  let weight=max(0.,1.-abs((f32(i)+.5-center)/support));
  let index=select(id.y*p.width+u32(i),u32(i)*1024u+id.x,p.horizontal==1u);
  value+=intermediate[index]*weight;total+=weight;
 }
 value/=total;let pixel=id.y*1024u+id.x;
 output[pixel]=value.r;output[1048576u+pixel]=value.g;output[2097152u+pixel]=value.b;
}
`

const reconstruction = `
struct Params { width:u32, height:u32, unused0:u32, unused1:u32 }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> logits:array<f32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
fn coverage(pixel:u32)->u32 {
 let position=max(vec2f(0.),(vec2f(f32(pixel%p.width),f32(pixel/p.width))+.5)*vec2f(256./f32(p.width),256./f32(p.height))-.5);
 let low=vec2u(position);let high=min(low+vec2u(1u),vec2u(255u));let f=position-vec2f(low);
 let top=logits[low.y*256u+low.x]*(1.-f.x)+logits[low.y*256u+high.x]*f.x;
 let bottom=logits[high.y*256u+low.x]*(1.-f.x)+logits[high.y*256u+high.x]*f.x;
 return select(0u,255u,top*(1.-f.y)+bottom*f.y>0.);
}
@compute @workgroup_size(256) fn reconstruct(@builtin(global_invocation_id) id:vec3u) {
 let word=id.x+id.y*65535u*256u;let pixel=word*4u;
 if(pixel>=p.width*p.height){return;}
 var packed=0u;
 for(var offset=0u;offset<4u;offset++) {
  if(pixel+offset<p.width*p.height){packed|=coverage(pixel+offset)<<(offset*8u);}
 }
 output[word]=packed;
}
`

export function validateObjectSelectionSize(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    Math.max(width, height) > 8192 ||
    width * height > OBJECT_SELECTION_MAX_PIXELS
  )
    throw new Error(
      'Object selection supports photographs up to 32 megapixels and 8192 pixels per side.',
    )
}

/** Hardware compute only. Native codecs and byte transfers remain outside this owner. */
export async function createObjectSelectionGpu() {
  const owner = new RawGpuRenderer()
  try {
    const { device } = await owner.mergeDevice()
    const make = async (code: string, entryPoint: string) => {
      const module = device.createShaderModule({ code, label: `Object selection ${entryPoint}` })
      const errors = (await module.getCompilationInfo()).messages.filter(
        (entry) => entry.type === 'error',
      )
      if (errors.length) throw new Error(errors.map((entry) => entry.message).join('\n'))
      return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })
    }
    const first = await make(preprocessing, 'first')
    const second = await make(finishing, 'second')
    const reconstruct = await make(reconstruction, 'reconstruct')
    const run = async (
      operation: 'preprocess' | 'reconstruct',
      input: Uint8Array | Float32Array,
      width: number,
      height: number,
    ) => {
      validateObjectSelectionSize(width, height)
      if (owner.failure) throw new Error(owner.failure)
      const resources: GPUBuffer[] = []
      const buffer = (size: number, usage: number) => {
        if (size > device.limits.maxBufferSize || size > device.limits.maxStorageBufferBindingSize)
          throw new Error('Object selection exceeds this GPU buffer limit.')
        const value = device.createBuffer({ size, usage })
        resources.push(value)
        return value
      }
      device.pushErrorScope('validation')
      let result: Uint8Array | undefined
      let failure: unknown
      try {
        const uniform = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
        const horizontal = width >= height
        device.queue.writeBuffer(
          uniform,
          0,
          new Uint32Array([width, height, horizontal ? 1 : 0, 0]),
        )
        const source = buffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        device.queue.writeBuffer(source, 0, input as GPUAllowSharedBufferSource)
        const outputBytes =
          operation === 'preprocess' ? 3 * 1024 * 1024 * 4 : Math.ceil((width * height) / 4) * 4
        const output = buffer(outputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
        const readback = buffer(outputBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
        const encoder = device.createCommandEncoder()
        const dispatch = (
          pipeline: GPUComputePipeline,
          source: GPUBuffer,
          target: GPUBuffer,
          x: number,
          y: number,
        ) => {
          const pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: uniform } },
                { binding: 1, resource: { buffer: source } },
                { binding: 2, resource: { buffer: target } },
              ],
            }),
          )
          pass.dispatchWorkgroups(x, y)
          pass.end()
        }
        if (operation === 'preprocess') {
          if (input.byteLength !== width * height * 4)
            throw new Error('Object selection RGBA source byte count changed.')
          const intermediate = buffer(1024 * Math.min(width, height) * 16, GPUBufferUsage.STORAGE)
          dispatch(
            first,
            source,
            intermediate,
            Math.ceil((horizontal ? 1024 : width) / 8),
            Math.ceil((horizontal ? height : 1024) / 8),
          )
          dispatch(second, intermediate, output, 128, 128)
        } else {
          if (input.byteLength !== 256 * 256 * 4)
            throw new Error('Object selection logits dimensions changed.')
          const groups = Math.ceil(outputBytes / 4 / 256)
          dispatch(reconstruct, source, output, Math.min(groups, 65535), Math.ceil(groups / 65535))
        }
        encoder.copyBufferToBuffer(output, 0, readback, 0, outputBytes)
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        result = new Uint8Array(readback.getMappedRange()).slice()
        readback.unmap()
        if (owner.failure) throw new Error(owner.failure)
      } catch (error) {
        failure = error
      } finally {
        await device.queue.onSubmittedWorkDone().catch(() => undefined)
        for (const resource of resources) resource.destroy()
      }
      const error = await device.popErrorScope()
      if (failure) throw failure
      if (error) throw new Error(`Object selection GPU failed: ${error.message}`)
      if (!result) throw new Error('Object selection GPU returned no pixels.')
      return result
    }
    return {
      async preprocess(rgba: Uint8Array, width: number, height: number): Promise<Float32Array> {
        const data = await run('preprocess', rgba, width, height)
        return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
      },
      async reconstruct(logits: Float32Array, width: number, height: number): Promise<Uint8Array> {
        return (await run('reconstruct', logits, width, height)).subarray(0, width * height)
      },
      close() {
        owner.close()
      },
    }
  } catch (error) {
    owner.close()
    throw error
  }
}
