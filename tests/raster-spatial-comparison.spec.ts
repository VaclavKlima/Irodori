import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { Frame, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import {
  neutralAdjustments,
  renderAdjustments,
  srgbTransform,
  type AdjustmentParameters,
} from '../src/shared/adjustments'
import { neutralColorMixer } from '../src/shared/color-mixer'
import { neutralColorGrading } from '../src/shared/color-grading'

const width = 8,
  height = 6
// Original CC0-1.0 inputs deliberately distinguish source selection from point edits.
function pixels(variant: number) {
  const values = Array.from({ length: width * height }, (_, i) => {
    const x = i % width,
      y = Math.floor(i / width)
    if (i % 23 === 0) return [0, 0, 0, 0]
    const rgb =
      variant % 2
        ? [0.12 + 0.025 * y, 0.24 + 0.04 * ((x + variant) % 3), 0.08 + 0.02 * x]
        : [0.04 + 0.03 * x, 0.08 + 0.02 * y, 0.25 + 0.025 * ((x + y + variant) % 4)]
    return [...rgb, i % 19 === 0 ? 0.5 : 1]
  }).flat()
  return [...new Float32Array(values)]
}
const parameters: AdjustmentParameters = {
  ...neutralAdjustments,
  exposureEv: 0.35,
  contrast: 12,
  highlights: -10,
  shadows: 7,
  saturation: 10,
  vibrance: 18,
  colorMixer: {
    ...neutralColorMixer,
    ranges: { ...neutralColorMixer.ranges, blue: { hue: 12, saturation: 18, luminance: -5 } },
  },
  colorGrading: {
    ...neutralColorGrading,
    tones: {
      ...neutralColorGrading.tones,
      shadows: { hue: 225, saturation: 15, luminance: 2 },
      highlights: { hue: 40, saturation: 12, luminance: -3 },
    },
  },
}
const reference = (variant: number, p = neutralAdjustments) => [
  ...renderAdjustments(new Float32Array(pixels(variant)), p, srgbTransform),
]

interface Snapshot {
  pixels: number[]
  uploads: number
  programs: number
  draws: number
  lost: number
  closed: number
  held: number
  ready: boolean
  busy: boolean
  visibility: string
  workerError?: string
  retiringBeforeBytes: number
  retiringWorkerFrames: number
  owner: { ramBytes: number; vramBytes: number }
  configurations: { after: boolean; before: boolean; generation: number }[]
  data: Record<string, string>
}
async function harness(page: Page) {
  const worker = await build({
    entryPoints: ['src/renderer/src/preview/presentation-worker.ts'],
    bundle: true,
    format: 'iife',
    write: false,
  })
  const workerFile = test.info().outputPath('presentation-worker.mjs')
  await writeFile(workerFile, worker.outputFiles[0].text)
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {srgbTransform,neutralAdjustments,sameAdjustments} from './src/shared/adjustments';
import {imageResourceOwners} from './src/renderer/src/preview/image-resource-owners';
let canvas,presenter,gl,after,baseline,requested=neutralAdjustments,viewport={width:8,height:6},
 uploads=0,programs=0,draws=0,lost=0,closed=0,holdReply=false,holdFence=false,failLink=false,
 textureLimit=false,held=[],configurations=[],workerError;
const NativeWorker=window.Worker,realClose=ImageBitmap.prototype.close;
ImageBitmap.prototype.close=function(){closed++;return realClose.call(this)};
window.Worker=class extends NativeWorker {
 constructor(url,options){
  if(!String(url).endsWith('/presentation-worker.ts'))throw Error('Unexpected isolated worker');
  super(${JSON.stringify(pathToFileURL(workerFile).href)},options);
  super.addEventListener('message',event=>{
   const deliver=()=>this.deliver?.(event);
   if(holdReply)held.push(deliver);else deliver();
  });
  super.addEventListener('error',event=>{workerError=event.message});
 }
 set onmessage(handler){this.deliver=handler}
 postMessage(message,...rest){
  if(message.generation!==undefined)configurations.push({after:!!message.frame,
    before:message.beforeFrame!==undefined,generation:message.generation});
  super.postMessage(message,...rest);
 }
};
function source(input,padding=0){
 const backing=new Float32Array(input.length+padding),data=backing.subarray(padding,input.length+padding);
 data.set(input);return {width:8,height:6,data,transform:structuredClone(srgbTransform)};
}
window.spatialPresenter={
 create(input,fallback=false,padding=0){
  canvas=document.createElement('canvas');canvas.width=Math.round(8*devicePixelRatio);
  canvas.height=Math.round(6*devicePixelRatio);document.body.append(canvas);
  if(!fallback){
   gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:false,antialias:false,preserveDrawingBuffer:true});
   if(!gl)throw Error('Isolated WebGL2 unavailable');
   const realUpload=gl.texImage2D.bind(gl),realProgram=gl.createProgram.bind(gl),
     realDraw=gl.drawArrays.bind(gl),realWait=gl.clientWaitSync.bind(gl),
     realParameter=gl.getParameter.bind(gl),realProgramParameter=gl.getProgramParameter.bind(gl);
   gl.texImage2D=(...args)=>{uploads++;return realUpload(...args)};
   gl.createProgram=()=>{programs++;return realProgram()};
   gl.drawArrays=(...args)=>{draws++;return realDraw(...args)};
   // Hold retirement publication, preserving actual GPU execution and fences.
   gl.clientWaitSync=(...args)=>holdFence?gl.TIMEOUT_EXPIRED:realWait(...args);
   gl.getParameter=name=>textureLimit&&name===gl.MAX_TEXTURE_SIZE?1:realParameter(name);
   gl.getProgramParameter=(program,name)=>failLink&&name===gl.LINK_STATUS?false:realProgramParameter(program,name);
  }
  presenter=new PreviewPresenter(canvas,fallback,()=>lost++);
  after=source(input,padding);presenter.setWorking(after);
 },
 before(input,required=true,padding=0){
  baseline=input?source(input,padding):null;presenter.setComparisonSource(baseline,required);
 },
 alias(){presenter.setComparisonSource(after)},
 replace(input){after=source(input);presenter.setWorking(after)},
 reject(input,kind){
  const invalid=source(input);
  if(kind==='geometry')invalid.width--;
  else if(kind==='transform')invalid.transform.white=2;
  else if(kind==='length')invalid.data=invalid.data.subarray(4);
  else if(kind==='hdr')invalid.hdr={};
  try{presenter.setComparisonSource(invalid);return null}catch(error){return error.message}
 },
 draw(p,mode='after',scale=1){
  requested=structuredClone(p);viewport={width:8*scale,height:6*scale};
  presenter.setComparison(mode,.5);
  presenter.draw({width:8,height:6},viewport,{fit:scale<1,scale,x:0,y:0},requested);
 },
 hold(reply,fence=false){holdReply=reply;holdFence=fence},
 release(){holdReply=holdFence=false;const callbacks=held;held=[];for(const callback of callbacks)callback()},
 limit(value){textureLimit=value},
 fail(value){failLink=value},
 snapshot(){
  let pixels=[];
  if(canvas){const dpr=devicePixelRatio||1,width=canvas.width,height=canvas.height;
   let raw;
   if(gl){raw=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw)}
   else raw=canvas.getContext('2d').getImageData(0,0,width,height).data;
   for(let y=0;y<viewport.height;y++)for(let x=0;x<viewport.width;x++){
    const row=Math.floor((y+.5)*dpr),column=Math.floor((x+.5)*dpr),
      at=((gl?height-row-1:row)*width+column)*4;
    pixels.push(...raw.slice(at,at+4));
   }
  }
  return {pixels,uploads,programs,draws,lost,closed,held:held.length,busy:!!presenter?.fallbackBusy,
   ready:gl?!presenter?.creativePending:sameAdjustments(presenter?.fallbackParameters,requested),
   visibility:canvas?.style.visibility,workerError,retiringBeforeBytes:presenter?.retiringBeforeBytes||0,
   retiringWorkerFrames:presenter?.retiringWorkerFrames.length||0,
   owner:imageResourceOwners.snapshot(),configurations,data:{...canvas?.dataset}};
 },
 close(){presenter?.dispose();presenter=null},
 finish(){this.release();this.close();canvas?.remove();canvas=null}
};`,
    },
    bundle: true,
    format: 'iife',
    write: false,
    define: {
      'import.meta.url': JSON.stringify('https://isolated.invalid/preview/presenter.js'),
    },
  })
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Isolated spatial comparison presenter'
    document.body.append(frame)
  })
  const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  await frame.evaluate(bundle.outputFiles[0].text)
  return frame
}
const act = (frame: Frame, name: string, ...args: unknown[]) =>
  frame.evaluate(
    ({ name, args }) =>
      (
        window as unknown as { spatialPresenter: Record<string, (...args: unknown[]) => unknown> }
      ).spatialPresenter[name](...args),
    { name, args },
  )
const snapshot = (frame: Frame): Promise<Snapshot> => act(frame, 'snapshot') as Promise<Snapshot>
const ready = (frame: Frame) => expect.poll(async () => (await snapshot(frame)).ready).toBe(true)
async function finish(frame: Frame) {
  await act(frame, 'finish')
  await expect
    .poll(async () => (await snapshot(frame)).owner)
    .toEqual({ ramBytes: 0, vramBytes: 0 })
}
function compare(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) expect(actual[i], `alpha ${i}`).toBe(expected[i])
    else expect(Math.abs(actual[i] - expected[i]), `channel ${i}`).toBeLessThanOrEqual(1)
  }
}
function split(before: number[], after: number[], w = width) {
  return after.map((value, index) => (Math.floor(index / 4) % w < w / 2 ? before[index] : value))
}
function zoom(p: number[]) {
  return Array.from({ length: width * height * 16 }, (_, i) => {
    const pixel = Math.floor(i / 4),
      x = Math.floor((pixel % (width * 2)) / 2),
      y = Math.floor(Math.floor(pixel / (width * 2)) / 2)
    return p[(y * width + x) * 4 + (i % 4)]
  })
}

for (const fallback of [false, true]) {
  test(`${fallback ? 'worker' : 'WebGL'} raster Before/Split use distinct original pixels with grading, zoom and resident-source reuse`, async ({
    irodori: { page },
  }) => {
    const frame = await harness(page)
    try {
      await act(frame, 'create', pixels(0), fallback)
      await act(frame, 'before', pixels(1))
      for (const [mode, expected] of [
        ['after', reference(0, parameters)],
        ['before', reference(1)],
        ['split', split(reference(1), reference(0, parameters))],
      ] as const) {
        await act(frame, 'draw', parameters, mode)
        await ready(frame)
        const s = await snapshot(frame)
        expect(s.visibility).toBe('')
        expect(s.data.comparisonLoading).toBe('false')
        compare(s.pixels, expected)
      }
      await act(frame, 'draw', parameters, 'split', 2)
      await ready(frame)
      compare(
        (await snapshot(frame)).pixels,
        split(zoom(reference(1)), zoom(reference(0, parameters)), width * 2),
      )
      const resident = await snapshot(frame)
      const changed = { ...parameters, exposureEv: -0.4 }
      await act(frame, 'draw', changed, 'after')
      await ready(frame)
      compare((await snapshot(frame)).pixels, reference(0, changed))
      const after = await snapshot(frame)
      expect(after.uploads).toBe(resident.uploads)
      expect(after.configurations).toEqual(resident.configurations)
      expect(after.lost).toBe(0)
      expect(after.workerError).toBeUndefined()
      // Fit keeps each renderer's established filtering policy; source routing must
      // still agree with independently presented whole Before/After renditions.
      await act(frame, 'draw', changed, 'before', 0.5)
      await ready(frame)
      const fitBefore = (await snapshot(frame)).pixels
      await act(frame, 'draw', changed, 'after', 0.5)
      const fitAfter = (await snapshot(frame)).pixels
      await act(frame, 'draw', changed, 'split', 0.5)
      compare((await snapshot(frame)).pixels, split(fitBefore, fitAfter, width / 2))
    } finally {
      await finish(frame)
    }
  })
}

test('a missing baseline stays hidden and late worker replies cannot bind an old Before or edited source', async ({
  irodori: { page },
}) => {
  const frame = await harness(page)
  try {
    await act(frame, 'create', pixels(0), true)
    await act(frame, 'hold', true)
    await act(frame, 'before', null)
    await act(frame, 'draw', parameters, 'before')
    await expect.poll(async () => (await snapshot(frame)).held).toBe(1)
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await act(frame, 'before', pixels(1))
    await act(frame, 'before', pixels(3))
    expect((await snapshot(frame)).configurations).toHaveLength(1)
    await act(frame, 'release')
    await ready(frame)
    let s = await snapshot(frame)
    expect(s.closed).toBeGreaterThanOrEqual(2)
    expect(s.configurations).toEqual([
      { after: true, before: false, generation: 1 },
      { after: false, before: true, generation: 3 },
    ])
    compare(s.pixels, reference(3))
    await act(frame, 'hold', true)
    await act(frame, 'before', pixels(5))
    await expect.poll(async () => (await snapshot(frame)).held).toBe(1)
    s = await snapshot(frame)
    expect(s.retiringWorkerFrames).toBe(1)
    expect(s.owner.ramBytes).toBeGreaterThanOrEqual(width * height * 16 * 3 * 3)
    await act(frame, 'replace', pixels(2))
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await act(frame, 'release')
    await ready(frame)
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await act(frame, 'before', pixels(7))
    await ready(frame)
    compare((await snapshot(frame)).pixels, reference(7))
    await act(frame, 'draw', parameters, 'after')
    await ready(frame)
    compare((await snapshot(frame)).pixels, reference(2, parameters))
    expect((await snapshot(frame)).retiringWorkerFrames).toBe(0)
  } finally {
    await finish(frame)
  }
})

test('raster comparison aliases allocate once, invalid sources preserve the frame and retired textures stay charged through their fence', async ({
  irodori: { page },
}) => {
  const frame = await harness(page)
  try {
    await act(frame, 'create', pixels(0), false, 64)
    await act(frame, 'draw', neutralAdjustments)
    const ordinary = await snapshot(frame)
    await act(frame, 'alias')
    expect((await snapshot(frame)).owner).toEqual(ordinary.owner)
    expect((await snapshot(frame)).uploads).toBe(1)
    for (const kind of ['geometry', 'transform', 'length', 'hdr'])
      expect(await act(frame, 'reject', pixels(1), kind)).toMatch(/does not match/)
    await act(frame, 'draw', neutralAdjustments, 'before')
    compare((await snapshot(frame)).pixels, reference(0))
    await act(frame, 'before', pixels(1), true, 32)
    compare((await snapshot(frame)).pixels, reference(1))
    const resident = await snapshot(frame)
    expect(resident.owner.ramBytes).toBeGreaterThanOrEqual(
      (width * height * 16 * 2 + (64 + 32) * 4) * 3,
    )
    await act(frame, 'hold', false, true)
    await act(frame, 'before', pixels(3))
    const retiring = await snapshot(frame)
    expect(retiring.retiringBeforeBytes).toBe(Math.ceil((width * height * 16 * 4) / 3))
    expect(retiring.owner.vramBytes).toBeGreaterThan(resident.owner.vramBytes)
    await act(frame, 'limit', true)
    await expect(act(frame, 'before', pixels(5))).rejects.toThrow(/GPU allocation budget/)
    expect((await snapshot(frame)).uploads).toBe(retiring.uploads)
    compare((await snapshot(frame)).pixels, reference(3))
    await act(frame, 'limit', false)
    await act(frame, 'release')
    await expect.poll(async () => (await snapshot(frame)).retiringBeforeBytes).toBe(0)
    await act(frame, 'hold', false, true)
    await act(frame, 'close')
    expect((await snapshot(frame)).owner.vramBytes).toBeGreaterThan(0)
    await act(frame, 'release')
    await expect
      .poll(async () => (await snapshot(frame)).owner)
      .toEqual({ ramBytes: 0, vramBytes: 0 })
  } finally {
    await finish(frame)
  }
})

test('an incomplete GPU comparison program stays hidden and a changed edited frame requires a fresh baseline', async ({
  irodori: { page },
}) => {
  const frame = await harness(page)
  try {
    await act(frame, 'create', pixels(0))
    await act(frame, 'draw', neutralAdjustments, 'before')
    await act(frame, 'fail', true)
    await expect(act(frame, 'before', pixels(1))).rejects.toThrow(/comparison program failed/)
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await act(frame, 'fail', false)
    await act(frame, 'before', pixels(3))
    compare((await snapshot(frame)).pixels, reference(3))
    await act(frame, 'replace', pixels(2))
    await act(frame, 'draw', neutralAdjustments, 'before')
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await act(frame, 'before', pixels(5))
    compare((await snapshot(frame)).pixels, reference(5))
    await act(frame, 'draw', neutralAdjustments, 'after')
    compare((await snapshot(frame)).pixels, reference(2))
  } finally {
    await finish(frame)
  }
})

test('a disposed raster worker closes transferred late bitmaps and source replacement hides old pixels', async ({
  irodori: { page },
}) => {
  const frame = await harness(page)
  try {
    await act(frame, 'create', pixels(0), true)
    await act(frame, 'draw', neutralAdjustments)
    await ready(frame)
    await act(frame, 'hold', true)
    await act(frame, 'replace', pixels(2))
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await expect.poll(async () => (await snapshot(frame)).held).toBe(1)
    const closed = (await snapshot(frame)).closed
    await act(frame, 'close')
    await act(frame, 'release')
    expect((await snapshot(frame)).closed).toBe(closed + 2)
    await expect
      .poll(async () => (await snapshot(frame)).owner)
      .toEqual({ ramBytes: 0, vramBytes: 0 })
  } finally {
    await finish(frame)
  }
})
