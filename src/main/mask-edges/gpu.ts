import type { ResolvedMask } from '../../shared/masks'
import { neutralAdjustments } from '../../shared/adjustments'
import { identityMaskGeometry } from '../../shared/mask-geometry'
import { localMasksWgsl, packLocalMasks } from '../../shared/masks-gpu'
import { createMaskBaseAtlas } from '../gpu/mask-bases'

const CORE_ROWS = 128
const work = `
struct EdgeParams {
 width:u32,height:u32,tileWidth:u32,tileHeight:u32,
 top:i32,halo:i32,shift:i32,support:i32,
 coreRows:u32,unused0:u32,unused1:u32,unused2:u32
}
@group(0) @binding(0) var<uniform> edge:EdgeParams;
@group(0) @binding(1) var<storage,read> source:array<f32>;
@group(0) @binding(2) var<storage,read_write> edgeOutput:array<f32>;
@group(0) @binding(3) var<storage,read> weights:array<f32>;
@group(0) @binding(4) var<storage,read_write> packed:array<u32>;
var<workgroup> diskTile:array<f32,2304>;
var<workgroup> blurTile:array<f32,1088>;
fn inputAt(position:vec2i)->f32 {
 let low=vec2i(edge.halo,edge.halo-edge.top);
 let high=low+vec2i(i32(edge.width)-1,i32(edge.height)-1);
 let p=clamp(clamp(position,low,high),vec2i(0),vec2i(i32(edge.tileWidth)-1,i32(edge.tileHeight)-1));
 return source[u32(p.y)*edge.tileWidth+u32(p.x)];
}
@compute @workgroup_size(16,16) fn compose(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=edge.tileWidth || id.y>=edge.tileHeight){return;}
 let p=clamp(vec2i(i32(id.x)-edge.halo,edge.top+i32(id.y)-edge.halo),vec2i(0),vec2i(i32(edge.width)-1,i32(edge.height)-1));
 edgeOutput[id.y*edge.tileWidth+id.x]=maskCoverage(0u,(vec2f(p)+.5)/vec2f(f32(edge.width),f32(edge.height)));
}
@compute @workgroup_size(16,16) fn morphology(
 @builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_id) local:vec3u,@builtin(workgroup_id) group:vec3u
) {
 let radius=abs(edge.shift);let side=16+2*radius;
 for(var index=i32(local.y*16u+local.x);index<side*side;index+=256){
  let p=vec2i(group.xy*16u)+vec2i(index%side,index/side)-vec2i(radius);
  diskTile[u32(index)]=inputAt(p);
 }
 workgroupBarrier();
 if(id.x>=edge.tileWidth || id.y>=edge.tileHeight){return;}
 var value=select(1.,0.,edge.shift>=0);
 for(var y=-radius;y<=radius;y++){
  for(var x=-radius;x<=radius;x++){
   if(x*x+y*y<=radius*radius){
    let index=(i32(local.y)+radius+y)*side+i32(local.x)+radius+x;
    let sample=diskTile[u32(index)];
    if(edge.shift>=0){value=max(value,sample);}else{value=min(value,sample);}
   }
  }
 }
 edgeOutput[id.y*edge.tileWidth+id.x]=value;
}
fn blurLoad(local:vec3u,group:vec3u,horizontal:bool) {
 let side=8+2*edge.support;
 for(var index=i32(local.y*8u+local.x);index<side*8;index+=64){
  var p=vec2i(index%side,index/side)-vec2i(edge.support,0);
  if(!horizontal){p=vec2i(index%8,index/8)-vec2i(0,edge.support);}
  blurTile[u32(index)]=inputAt(vec2i(group.xy*8u)+p);
 }
}
fn blurValue(local:vec3u,horizontal:bool)->f32 {
 let side=8+2*edge.support;var value=0.;
 for(var offset=-edge.support;offset<=edge.support;offset++){
  var index=i32(local.y)*side+i32(local.x)+edge.support+offset;
  if(!horizontal){index=(i32(local.y)+edge.support+offset)*8+i32(local.x);}
  value+=blurTile[u32(index)]*weights[u32(offset+edge.support)];
 }
 return clamp(value,0.,1.);
}
@compute @workgroup_size(8,8) fn horizontal(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_id) local:vec3u,@builtin(workgroup_id) group:vec3u){
 blurLoad(local,group,true);workgroupBarrier();
 if(id.x<edge.tileWidth && id.y<edge.tileHeight){edgeOutput[id.y*edge.tileWidth+id.x]=blurValue(local,true);}
}
@compute @workgroup_size(8,8) fn vertical(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_id) local:vec3u,@builtin(workgroup_id) group:vec3u){
 blurLoad(local,group,false);workgroupBarrier();
 if(id.x<edge.tileWidth && id.y<edge.tileHeight){edgeOutput[id.y*edge.tileWidth+id.x]=blurValue(local,false);}
}
@compute @workgroup_size(256) fn encode(@builtin(global_invocation_id) id:vec3u) {
 let first=id.x*4u;let count=edge.width*edge.coreRows;
 if(first>=count){return;}var result=0u;
 for(var offset=0u;offset<4u;offset++){
  let pixel=first+offset;
  if(pixel<count){
   let x=pixel%edge.width+u32(edge.halo);let y=pixel/edge.width+u32(edge.halo);
   let value=source[y*edge.tileWidth+x];
   result|=u32(floor(clamp(value,0.,1.)*255.+.5))<<(offset*8u);
  }
 }
 packed[id.x]=result;
}
`

/** Small coefficient preparation; all mask sampling and filtering stays on GPU. */
function gaussian(radius: number) {
  if (!radius) return new Float32Array([1])
  const support = Math.ceil(radius),
    sigma = radius / 3
  const values = Array.from({ length: support * 2 + 1 }, (_, index) =>
    Math.exp(-((index - support) ** 2) / (2 * sigma * sigma)),
  )
  const total = values.reduce((sum, value) => sum + value, 0)
  return new Float32Array(values.map((value) => value / total))
}

/** Complete selected coverage → disk shift → Gaussian → one R8 quantization. */
export async function prepareMaskEdgeCoverage(
  device: GPUDevice,
  mask: ResolvedMask,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted()
  const edge = mask.edge ?? { featherPx: 0, shiftPx: 0 }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isFinite(edge.featherPx) ||
    edge.featherPx < 0 ||
    edge.featherPx > 64 ||
    !Number.isInteger(edge.featherPx * 2) ||
    !Number.isInteger(edge.shiftPx) ||
    Math.abs(edge.shiftPx) > 16
  )
    throw new Error('Invalid mask edge dimensions or controls.')
  const halo = Math.abs(edge.shiftPx) + Math.ceil(edge.featherPx)
  const tileWidth = width + 2 * halo,
    tileHeight = Math.min(CORE_ROWS, height) + 2 * halo
  const resources: GPUBuffer[] = []
  let base: GPUTexture | undefined
  let failure: unknown
  let result: Uint8Array | undefined
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    if (
      !Number.isSafeInteger(size) ||
      size < 4 ||
      size > device.limits.maxBufferSize ||
      ((usage & GPUBufferUsage.STORAGE) !== 0 && size > device.limits.maxStorageBufferBindingSize)
    )
      throw new Error('Mask edge processing exceeds this GPU buffer limit.')
    const value = device.createBuffer({ size, usage })
    resources.push(value)
    return value
  }
  device.pushErrorScope('validation')
  try {
    const parameters = {
      ...neutralAdjustments,
      localMasks: [{ ...mask, edge: { featherPx: 0, shiftPx: 0 }, preparedCoverage: undefined }],
      maskGeometry: identityMaskGeometry(width, height),
    }
    const packedMask = packLocalMasks(parameters, { width, height })
    const maskData = buffer(packedMask.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const uniform = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const a = buffer(tileWidth * tileHeight * 4, GPUBufferUsage.STORAGE)
    const b = buffer(tileWidth * tileHeight * 4, GPUBufferUsage.STORAGE)
    const coefficients = gaussian(edge.featherPx)
    const weights = buffer(
      coefficients.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    )
    const outputBytes = Math.ceil((width * Math.min(CORE_ROWS, height)) / 4) * 4
    const output = buffer(outputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const readback = buffer(outputBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    device.queue.writeBuffer(maskData, 0, packedMask)
    device.queue.writeBuffer(weights, 0, coefficients)
    base = await createMaskBaseAtlas(device, parameters)
    signal.throwIfAborted()
    const module = device.createShaderModule({
      code: localMasksWgsl(16, 18) + work,
      label: 'Mask edge coverage',
    })
    const errors = (await module.getCompilationInfo()).messages.filter(
      (message) => message.type === 'error',
    )
    if (errors.length) throw new Error(errors.map((message) => message.message).join('\n'))
    const entries = ['compose', 'morphology', 'horizontal', 'vertical', 'encode'] as const
    const pipelines = await Promise.all(
      entries.map((entryPoint) =>
        device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint },
        }),
      ),
    )
    const groups = pipelines.map((pipeline, index) => {
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniform } }]
      if (index === 0)
        entries.push(
          { binding: 2, resource: { buffer: a } },
          { binding: 16, resource: { buffer: maskData } },
          { binding: 18, resource: base!.createView({ dimension: '2d-array' }) },
        )
      else {
        entries.push({ binding: 1, resource: { buffer: index === 2 || index === 4 ? b : a } })
        if (index === 4) entries.push({ binding: 4, resource: { buffer: output } })
        else entries.push({ binding: 2, resource: { buffer: index === 2 ? a : b } })
        if (index === 2 || index === 3) entries.push({ binding: 3, resource: { buffer: weights } })
      }
      return device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    })
    result = new Uint8Array(width * height)
    for (let top = 0; top < height; top += CORE_ROWS) {
      signal.throwIfAborted()
      const rows = Math.min(CORE_ROWS, height - top),
        extendedRows = rows + 2 * halo
      const values = new Int32Array([
        width,
        height,
        tileWidth,
        extendedRows,
        top,
        halo,
        edge.shiftPx,
        Math.ceil(edge.featherPx),
        rows,
        0,
        0,
        0,
      ])
      device.queue.writeBuffer(uniform, 0, values)
      const encoder = device.createCommandEncoder()
      for (let index = 0; index < pipelines.length; index++) {
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipelines[index])
        pass.setBindGroup(0, groups[index])
        if (index === 4) pass.dispatchWorkgroups(Math.ceil((width * rows) / 4 / 256))
        else {
          const size = index < 2 ? 16 : 8
          pass.dispatchWorkgroups(Math.ceil(tileWidth / size), Math.ceil(extendedRows / size))
        }
        pass.end()
      }
      const validBytes = width * rows,
        copiedBytes = Math.ceil(validBytes / 4) * 4
      encoder.copyBufferToBuffer(output, 0, readback, 0, copiedBytes)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ, 0, copiedBytes)
      try {
        signal.throwIfAborted()
        result.set(
          new Uint8Array(readback.getMappedRange(0, copiedBytes)).subarray(0, validBytes),
          top * width,
        )
      } finally {
        readback.unmap()
      }
    }
  } catch (error) {
    failure = error
  } finally {
    await device.queue.onSubmittedWorkDone().catch((error: unknown) => {
      failure ??= error
    })
    for (const resource of resources) resource.destroy()
    base?.destroy()
    const validation = await device.popErrorScope()
    if (validation) failure ??= new Error(validation.message)
  }
  if (failure) throw failure
  if (!result) throw new Error('Mask edge GPU processing returned no coverage.')
  return result
}
