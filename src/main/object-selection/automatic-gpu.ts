/** Fast RGB guided filtering, radius 8 / epsilon 0.001 on the model grid.
 * Coefficients are upsampled and evaluated against native source pixels.
 * This recovers image boundaries; it cannot repair incorrect semantic labels.
 */
const common = `
struct Params { width:u32,height:u32,edge:u32,channels:u32 }
@group(0) @binding(0) var<uniform> p:Params;
fn reflect(i:i32)->u32 {
 if(i<0){return u32(-i-1);}if(i>=i32(p.edge)){return u32(2*i32(p.edge)-i-1);}return u32(i);
}
`
const moments =
  common +
  `
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(256) fn moments(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=p.edge*p.edge){return;}let v=input[i];
 output[i*4u]=v;
 output[i*4u+1u]=vec4f(v.r*v.r,v.r*v.g,v.r*v.b,v.g*v.g);
 output[i*4u+2u]=vec4f(v.g*v.b,v.b*v.b,v.r*v.a,v.g*v.a);
 output[i*4u+3u]=vec4f(v.b*v.a,0.,0.,0.);
}`
const box =
  common +
  `
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;
fn boxMean(i:u32,horizontal:bool){
 if(i>=p.edge*p.edge){return;}let x=i%p.edge;let y=i/p.edge;
 for(var c=0u;c<p.channels;c++){
  var total=vec4f(0.);
  for(var d=-8;d<=8;d++){
   let pos=select(reflect(i32(y)+d)*p.edge+x,y*p.edge+reflect(i32(x)+d),horizontal);
   total+=input[pos*p.channels+c];
  }
  output[i*p.channels+c]=total/17.;
 }
}
@compute @workgroup_size(256) fn row(@builtin(global_invocation_id) id:vec3u){boxMean(id.x,true);}
@compute @workgroup_size(256) fn column(@builtin(global_invocation_id) id:vec3u){boxMean(id.x,false);}
`
const coefficients =
  common +
  `
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(256) fn coefficients(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=p.edge*p.edge){return;}
 let m=input[i*4u];let a=input[i*4u+1u];let b=input[i*4u+2u];let c=input[i*4u+3u];
 let c0=vec3f(a.x-m.r*m.r+.001,a.y-m.r*m.g,a.z-m.r*m.b);
 let c1=vec3f(c0.y,a.w-m.g*m.g+.001,b.x-m.g*m.b);
 let c2=vec3f(c0.z,c1.z,b.y-m.b*m.b+.001);
 let r0=cross(c1,c2);let r1=cross(c2,c0);let r2=cross(c0,c1);
 let covariance=vec3f(b.z,b.w,c.x)-m.rgb*m.a;
 let slope=vec3f(dot(r0,covariance),dot(r1,covariance),dot(r2,covariance))/max(dot(c0,r0),1e-12);
 output[i]=vec4f(slope,m.a-dot(slope,m.rgb));
}`
const reconstruction =
  common +
  `
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
@group(0) @binding(2) var<storage,read> rgba:array<u32>;
@group(0) @binding(3) var<storage,read_write> output:array<u32>;
fn coverage(pixel:u32)->u32 {
 let pos=clamp((vec2f(f32(pixel%p.width),f32(pixel/p.width))+.5)*f32(p.edge)/vec2f(f32(p.width),f32(p.height))-.5,vec2f(0.),vec2f(f32(p.edge-1u)));
 let lo=vec2u(pos);let hi=min(lo+vec2u(1u),vec2u(p.edge-1u));let f=pos-vec2f(lo);
 let top=mix(input[lo.y*p.edge+lo.x],input[lo.y*p.edge+hi.x],f.x);
 let bottom=mix(input[hi.y*p.edge+lo.x],input[hi.y*p.edge+hi.x],f.x);
 let coeff=mix(top,bottom,f.y);let v=rgba[pixel];
 let rgb=vec3f(f32(v&255u),f32((v>>8u)&255u),f32((v>>16u)&255u))/255.;
 return u32(round(clamp(dot(coeff.rgb,rgb)+coeff.a,0.,1.)*255.));
}
@compute @workgroup_size(256) fn reconstruct(@builtin(global_invocation_id) id:vec3u){
 let word=id.x+id.y*65535u*256u;let pixel=word*4u;if(pixel>=p.width*p.height){return;}
 var packed=0u;for(var d=0u;d<4u;d++){if(pixel+d<p.width*p.height){packed|=coverage(pixel+d)<<(8u*d);}}
 output[word]=packed;
}`

export async function refineAutomaticSelection(
  device: GPUDevice,
  rgba: Uint8Array,
  guide: Float32Array,
  mask: Float32Array,
  width: number,
  height: number,
  edge: 128 | 1024,
): Promise<Uint8Array> {
  const pixels = edge * edge
  if (
    rgba.byteLength !== width * height * 4 ||
    guide.length !== pixels * 3 ||
    mask.length !== pixels
  )
    throw new Error('Automatic selection source or model grid changed.')
  if (!guide.every(Number.isFinite) || !mask.every(Number.isFinite))
    throw new Error('Automatic selection returned non-finite coverage.')
  const resources: GPUBuffer[] = []
  const allocate = (
    bytes: number,
    usage: number,
    data?: Uint8Array | Float32Array | Uint32Array,
  ) => {
    if (bytes > device.limits.maxBufferSize || bytes > device.limits.maxStorageBufferBindingSize)
      throw new Error('Automatic selection exceeds this GPU buffer limit.')
    const buffer = device.createBuffer({ size: bytes, usage })
    resources.push(buffer)
    if (data) device.queue.writeBuffer(buffer, 0, data as GPUAllowSharedBufferSource)
    return buffer
  }
  device.pushErrorScope('validation')
  let result: Uint8Array | undefined
  let failure: unknown
  try {
    const pipeline = async (code: string, entryPoint: string) => {
      const module = device.createShaderModule({ code, label: `Automatic selection ${entryPoint}` })
      const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
      if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'))
      return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })
    }
    const initialize = await pipeline(moments, 'moments')
    const row = await pipeline(box, 'row')
    const column = await pipeline(box, 'column')
    const solve = await pipeline(coefficients, 'coefficients')
    const finish = await pipeline(reconstruction, 'reconstruct')
    const parameters = (channels: number) =>
      allocate(
        16,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        new Uint32Array([width, height, edge, channels]),
      )
    const four = parameters(4),
      one = parameters(1)
    const low = new Float32Array(pixels * 4)
    for (let i = 0; i < pixels; i++) {
      low[i * 4] = guide[i]
      low[i * 4 + 1] = guide[pixels + i]
      low[i * 4 + 2] = guide[pixels * 2 + i]
      low[i * 4 + 3] = mask[i]
    }
    const storage = GPUBufferUsage.STORAGE
    const input = allocate(low.byteLength, storage | GPUBufferUsage.COPY_DST, low)
    const first = allocate(pixels * 64, storage)
    const temporary = allocate(pixels * 64, storage)
    const second = allocate(pixels * 64, storage)
    const slopes = allocate(pixels * 16, storage)
    const smoothed = allocate(pixels * 16, storage)
    const native = allocate(rgba.byteLength, storage | GPUBufferUsage.COPY_DST, rgba)
    const bytes = Math.ceil((width * height) / 4) * 4
    const output = allocate(bytes, storage | GPUBufferUsage.COPY_SRC)
    const readback = allocate(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    const encoder = device.createCommandEncoder()
    const dispatch = (operation: GPUComputePipeline, buffers: GPUBuffer[], count: number) => {
      const pass = encoder.beginComputePass()
      pass.setPipeline(operation)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: operation.getBindGroupLayout(0),
          entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      )
      pass.dispatchWorkgroups(Math.min(count, 65535), Math.ceil(count / 65535))
      pass.end()
    }
    const groups = Math.ceil(pixels / 256)
    dispatch(initialize, [four, input, first], groups)
    dispatch(row, [four, first, temporary], groups)
    dispatch(column, [four, temporary, second], groups)
    dispatch(solve, [four, second, slopes], groups)
    dispatch(row, [one, slopes, smoothed], groups)
    dispatch(column, [one, smoothed, slopes], groups)
    dispatch(finish, [one, slopes, native, output], Math.ceil(bytes / 4 / 256))
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes)
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    result = new Uint8Array(readback.getMappedRange()).slice(0, width * height)
    readback.unmap()
  } catch (error) {
    failure = error
  } finally {
    await device.queue.onSubmittedWorkDone().catch(() => undefined)
    for (const buffer of resources) buffer.destroy()
  }
  const error = await device.popErrorScope()
  if (failure) throw failure
  if (error) throw new Error(`Automatic selection GPU failed: ${error.message}`)
  if (!result) throw new Error('Automatic selection returned no coverage.')
  return result
}
