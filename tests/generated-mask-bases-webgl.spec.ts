import { test, expect } from './electron.fixture'
import { build } from 'esbuild'
import { generatedMask } from './helpers/generated-mask'

const moduleCode = `
import {WebGlMaskBaseAtlas,WebGpuMaskBaseAtlas} from './src/renderer/src/preview/mask-base-assets';
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {maskBaseAtlasPlan} from './src/shared/masks-gpu';
import {neutralAdjustments,srgbTransform} from './src/shared/adjustments';
import {neutralMaskLight} from './src/shared/masks';
import {identityMaskGeometry} from './src/shared/mask-geometry';
const masks=bases=>bases.map((base,index)=>({id:'00000000-0000-0000-0000-'+String(index+1).padStart(12,'0'),name:'Generated '+index,base,head:null,enabled:true,inverted:false,strokes:[],light:{...neutralMaskLight,exposureEv:1}}));
window.readGeneratedAtlas=async(bases,backend,points)=>{
 const plan=maskBaseAtlasPlan({localMasks:masks(bases)});
 if(backend==='webgl'){
  const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2'),owner=new WebGlMaskBaseAtlas(gl),framebuffer=gl.createFramebuffer(),output=gl.createTexture(),program=gl.createProgram();
  try{
   await new Promise((resolve,reject)=>{try{if(owner.ready(plan,resolve,reason=>reject(new Error(reason))))resolve()}catch(error){reject(error)}});
   for(const [kind,source] of [[gl.VERTEX_SHADER,'#version 300 es\\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}'],[gl.FRAGMENT_SHADER,'#version 300 es\\nprecision highp float;precision highp int;uniform highp sampler2DArray atlas;uniform ivec3 point;out vec4 result;void main(){result=vec4(texelFetch(atlas,point,0).r,0.,0.,1.);}']]){const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));gl.attachShader(program,shader);gl.deleteShader(shader)}
   gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
   gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,output);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,output,0);
   gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D_ARRAY,owner.texture);gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'atlas'),0);gl.disable(gl.DITHER);gl.viewport(0,0,1,1);
   const values=[];for(const point of points){gl.uniform3iv(gl.getUniformLocation(program,'point'),point);gl.drawArrays(gl.TRIANGLES,0,3);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);values.push(pixel[0])}
   if(gl.getError()!==gl.NO_ERROR)throw new Error('R8 WebGL atlas sampling failed.');
   return {values,bytes:owner.bytes,uploadBytes:plan.uploadBytes,transferRows:plan.transferRows};
  }finally{owner.dispose();gl.deleteProgram(program);gl.deleteTexture(output);gl.deleteFramebuffer(framebuffer);gl.getExtension('WEBGL_lose_context')?.loseContext()}
 }
 const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),owner=new WebGpuMaskBaseAtlas(device),buffers=[];
 try{
  const texture=await owner.prepare(plan),allocate=(size,usage)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b},queries=allocate(points.length*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),output=allocate(points.length*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),staging=allocate(points.length*4,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
  device.queue.writeBuffer(queries,0,new Uint32Array(points.flatMap(p=>[...p,0])));
  const module=device.createShaderModule({code:'@group(0) @binding(0) var atlas:texture_2d_array<f32>;@group(0) @binding(1) var<storage,read> points:array<vec4u>;@group(0) @binding(2) var<storage,read_write> output:array<u32>;@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){let p=points[id.x];output[id.x]=u32(round(textureLoad(atlas,vec2i(p.xy),i32(p.z),0).r*255.));}'}),pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView({dimension:'2d-array'})},{binding:1,resource:{buffer:queries}},{binding:2,resource:{buffer:output}}]}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(points.length);pass.end();encoder.copyBufferToBuffer(output,0,staging,0,output.size);device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);const values=Array.from(new Uint32Array(staging.getMappedRange()));staging.unmap();return{values,bytes:owner.bytes,uploadBytes:plan.uploadBytes,transferRows:plan.transferRows};
 }finally{await device.queue.onSubmittedWorkDone();owner.dispose();for(const buffer of buffers)buffer.destroy();device.destroy()}
};
window.presentLargeGeneratedBases=async bases=>{
 const width=bases[0].width,height=bases[0].height,canvas=document.createElement('canvas');document.body.append(canvas);let failure='';const presenter=new PreviewPresenter(canvas,false,reason=>{failure=reason});
 try{
  const data=new Float32Array(width*height*4).fill(.1);for(let i=3;i<data.length;i+=4)data[i]=1;
  presenter.setWorking({width,height,data,transform:srgbTransform});
  presenter.draw({width,height},{width:128,height:96},{fit:true,scale:Math.min(128/width,96/height),x:0,y:0},{...neutralAdjustments,localMasks:masks(bases),maskGeometry:identityMaskGeometry(width,height)});
  const until=performance.now()+20000;while(!failure&&(!Number(canvas.dataset.presentationSerial)||canvas.dataset.localMasksLoading==='true')&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  if(failure)throw new Error(failure);if(!Number(canvas.dataset.presentationSerial))throw new Error('Native two-base presentation did not complete.');
  const pixel=new Uint8Array(4),gl=canvas.getContext('webgl2');gl.readPixels(64,48,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return{pixel:Array.from(pixel),atlasBytes:maskBaseAtlasPlan({localMasks:masks(bases)}).bytes,loading:canvas.dataset.localMasksLoading};
 }finally{presenter.dispose();await presenter.whenDisposed;canvas.remove()}
};
window.retryGeneratedAtlas=async base=>{
 const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2'),owner=new WebGlMaskBaseAtlas(gl),plan=maskBaseAtlasPlan({localMasks:masks([base])}),original=HTMLImageElement.prototype.decode;let calls=0,failure='',presented=false,pending;
 try{
  HTMLImageElement.prototype.decode=function(){calls++;return calls===1?Promise.reject(new Error('Expected native decode refusal')):original.call(this)};
  owner.ready(plan,()=>{presented=true},reason=>{failure=reason});
  const until=performance.now()+5000;while(!failure&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,1));
  owner.retry();await new Promise((resolve,reject)=>{if(owner.ready(plan,resolve,reason=>reject(new Error(reason))))resolve()});
  let release;const gate=new Promise(resolve=>{release=resolve});HTMLImageElement.prototype.decode=function(){return gate.then(()=>original.call(this))};
  pending=new WebGlMaskBaseAtlas(gl);let canceledPresented=false;pending.ready(plan,()=>{canceledPresented=true},()=>{});await new Promise(resolve=>setTimeout(resolve,0));
  pending.dispose();let drained=false;pending.whenDisposed.then(()=>{drained=true});await new Promise(resolve=>setTimeout(resolve,0));const waitedForDecode=!drained;release();await pending.whenDisposed;
  return{failure,calls,presented,canceledPresented,waitedForDecode,drained,pendingBytes:pending.bytes};
 }finally{HTMLImageElement.prototype.decode=original;owner.dispose();pending?.dispose();await Promise.all([owner.whenDisposed,pending?.whenDisposed]);gl.getExtension('WEBGL_lose_context')?.loseContext()}
};`

async function isolatedHarness(page: import('@playwright/test').Page) {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: moduleCode },
    bundle: true,
    write: false,
    format: 'iife',
  })
  await page.evaluate(() => {
    const iframe = document.createElement('iframe')
    iframe.title = 'Generated mask GPU verification'
    document.body.append(iframe)
  })
  const frame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!
  await frame.evaluate(bundle.outputFiles[0].text)
  return frame
}

test('browser WebGL and WebGPU native PNG strip conversion preserves every sampled R8 value across layers and strip boundaries', async ({
  irodori: { page },
}) => {
  const width = 769,
    height = 1500,
    bases = [
      generatedMask(width, height, (x, y) => (x + 3 * y) % 256),
      generatedMask(width, height, (x, y) => 255 - ((x + 3 * y) % 256)),
    ],
    rows = Math.floor((4 * 1024 * 1024) / (width * 4)),
    points = [0, rows - 1, rows, height - 1].flatMap((y) =>
      [0, 1].flatMap((layer) => [
        [0, y, layer],
        [width - 1, y, layer],
      ]),
    ),
    expected = points.map(([x, y, layer]) =>
      layer ? 255 - ((x + 3 * y) % 256) : (x + 3 * y) % 256,
    ),
    frame = await isolatedHarness(page)
  try {
    for (const backend of ['webgl', 'webgpu']) {
      const actual = await frame.evaluate(
        ({ bases, backend, points }) =>
          (
            window as unknown as {
              readGeneratedAtlas: (
                bases: unknown,
                backend: string,
                points: number[][],
              ) => Promise<{
                values: number[]
                bytes: number
                uploadBytes: number
                transferRows: number
              }>
            }
          ).readGeneratedAtlas(bases, backend, points),
        { bases, backend, points },
      )
      expect(actual.values, backend).toEqual(expected)
      expect(actual.bytes).toBe(width * height * 2)
      expect(actual.uploadBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
      expect(actual.transferRows).toBe(rows)
    }
  } finally {
    await page.evaluate(() =>
      document.querySelector('iframe[title="Generated mask GPU verification"]')?.remove(),
    )
  }
})

test('actual raster presenter accepts two native 20MP generated bases within the unchanged 512 MiB GPU cap', async ({
  irodori: { page },
}) => {
  test.setTimeout(60000)
  const width = 5472,
    height = 3648,
    bases = [generatedMask(width, height, () => 255), generatedMask(width, height, () => 0)],
    frame = await isolatedHarness(page)
  try {
    const actual = await frame.evaluate(
      (bases) =>
        (
          window as unknown as {
            presentLargeGeneratedBases: (
              bases: unknown,
            ) => Promise<{ pixel: number[]; atlasBytes: number; loading: string }>
          }
        ).presentLargeGeneratedBases(bases),
      bases,
    )
    expect(actual.atlasBytes).toBe(width * height * 2)
    expect(actual.loading).toBe('false')
    expect(actual.pixel).toEqual([124, 124, 124, 255])
  } finally {
    await page.evaluate(() =>
      document.querySelector('iframe[title="Generated mask GPU verification"]')?.remove(),
    )
  }
})

test('same-hash native decode retry succeeds and canceled atlas ownership drains before retirement', async ({
  irodori: { page },
}) => {
  const base = generatedMask(32, 24, (x, y) => ((x + y) % 2 ? 255 : 0)),
    frame = await isolatedHarness(page)
  try {
    const actual = await frame.evaluate(
      (base) =>
        (
          window as unknown as {
            retryGeneratedAtlas: (base: unknown) => Promise<{
              failure: string
              calls: number
              presented: boolean
              canceledPresented: boolean
              waitedForDecode: boolean
              drained: boolean
              pendingBytes: number
            }>
          }
        ).retryGeneratedAtlas(base),
      base,
    )
    expect(actual.failure).toContain('Expected native decode refusal')
    expect(actual.calls).toBe(2)
    expect(actual.presented).toBe(false)
    expect(actual.canceledPresented).toBe(false)
    expect(actual.waitedForDecode).toBe(true)
    expect(actual.drained).toBe(true)
    expect(actual.pendingBytes).toBe(0)
  } finally {
    await page.evaluate(() =>
      document.querySelector('iframe[title="Generated mask GPU verification"]')?.remove(),
    )
  }
})
