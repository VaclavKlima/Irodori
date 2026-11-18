import type { Frame, Page } from '@playwright/test'
import { build } from 'esbuild'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import {
  neutralAdjustments,
  renderAdjustments,
  srgbTransform,
  type AdjustmentParameters,
} from '../src/shared/adjustments'

const width = 8,
  height = 6
// Original CC0-1.0 patterns include transparent and translucent source pixels.
const pixels = (variant: number) => [
  ...new Float32Array(
    Array.from({ length: width * height }, (_, i) => [
      0.08 + 0.026 * ((i + variant * 3) % width),
      0.12 + 0.018 * (Math.floor(i / width) + variant),
      0.28 - 0.017 * ((i + variant) % width),
      i % 7 === 0 ? 0 : i % 3 === 0 ? 0.5 : 1,
    ]).flat(),
  ),
]
const parameters: readonly [AdjustmentParameters, AdjustmentParameters] = [
  { ...neutralAdjustments, exposureEv: 0.25, contrast: 7, saturation: -8 },
  {
    ...neutralAdjustments,
    exposureEv: -0.3,
    contrast: 12,
    saturation: 15,
    curves: {
      version: 1,
      master: [
        { input: 0, output: 0 },
        { input: 0.3, output: 0.38 },
        { input: 1, output: 1 },
      ],
      red: [
        { input: 0, output: 0 },
        { input: 1, output: 1 },
      ],
      green: [
        { input: 0, output: 0 },
        { input: 1, output: 1 },
      ],
      blue: [
        { input: 0, output: 0 },
        { input: 1, output: 1 },
      ],
    },
  },
]
interface Snapshot {
  ready: boolean
  visibility: string
  opacity: string
  pixels: number[][]
  lost: string[]
  owner: { ramBytes: number; vramBytes: number }
}
async function harness(page: Page) {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {srgbTransform} from './src/shared/adjustments';
import {ComparisonPublication,comparisonClips} from './src/renderer/src/preview/edit-comparison';
import {imageResourceOwners} from './src/renderer/src/preview/image-resource-owners';
let root,canvases=[],clips=[],presenters=[],contexts=[],params=[],held,view,viewport,key='',ready=false,lost=[],retirement;
const publication=new ComparisonPublication();
function receipts(index){
 const geometry=presenters[index]?.presentedGeometry;
 if(!geometry||JSON.stringify(geometry.view)!==JSON.stringify(view)||JSON.stringify(geometry.viewport)!==JSON.stringify(viewport))return;
 if(publication.accept(key,index===0?'a':'b')){ready=true;root.style.opacity='1'}
}
window.Worker=class {constructor(){throw Error('Unexpected CPU presenter fallback')}};
window.editPair={
 create(input,parameters){
  document.body.style.margin='0';document.body.style.background='#202020';
  root=document.createElement('div');root.id='pair';root.style.cssText='position:relative;width:8px;height:6px;background:#202020;overflow:hidden';document.body.append(root);
  params=parameters;
  for(let i=0;i<2;i++){
   const clip=document.createElement('div');clip.style.cssText='position:absolute;inset:0;pointer-events:none';root.append(clip);clips.push(clip);
   const canvas=document.createElement('canvas');canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';clip.append(canvas);canvases.push(canvas);
   const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:false,antialias:false,preserveDrawingBuffer:true});
   if(!gl)throw Error('Two-slot WebGL2 unavailable');contexts.push(gl);
   const presenter=new PreviewPresenter(canvas,false,(reason)=>lost.push(reason),()=>receipts(i));presenters.push(presenter);
   presenter.setReadOnlyComparison();
   presenter.setWorking({width:8,height:6,data:new Float32Array(input[i]),identity:'member-'+i,transform:structuredClone(srgbTransform)});
  }
 },
 draw(w=8,h=6,x=0,y=0,holdB=false){
  viewport={width:w,height:h};view={fit:false,scale:1,x,y};key=JSON.stringify([viewport,view]);publication.request(key);ready=false;root.style.opacity='0';
  root.style.width=w+'px';root.style.height=h+'px';
  presenters[0].draw({width:8,height:6},viewport,view,params[0]);
  const b=()=>presenters[1].draw({width:8,height:6},viewport,view,params[1]);
  if(holdB)held=b;else b();
 },
 mode(mode,split=.5){const c=comparisonClips(viewport.width,devicePixelRatio||1,split,mode);clips[0].style.clipPath=c.a;clips[1].style.clipPath=c.b;return c.boundary},
 release(){const draw=held;held=null;draw?.()},
 snapshot(){return {ready,visibility:root?.style.visibility,opacity:root?.style.opacity,lost,owner:imageResourceOwners.snapshot(),pixels:contexts.map((gl,i)=>{
   const canvas=canvases[i],data=new Uint8Array(canvas.width*canvas.height*4),out=[],dpr=devicePixelRatio||1;
   gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
   for(let y=0;y<viewport.height;y++)for(let x=0;x<viewport.width;x++){
    const row=Math.floor((y+.5)*dpr),column=Math.floor((x+.5)*dpr),at=((canvas.height-row-1)*canvas.width+column)*4;out.push(...data.slice(at,at+4));
   }return out;
  })}},
 async close(){for(const presenter of presenters)presenter.dispose();await Promise.all(presenters.map(p=>p.whenDisposed));presenters=[];root?.remove()},
};`,
    },
    bundle: true,
    format: 'iife',
    write: false,
    define: { 'import.meta.url': JSON.stringify('https://isolated.invalid/preview/presenter.js') },
  })
  await page.evaluate(() => {
    const iframe = document.createElement('iframe')
    iframe.title = 'Isolated edit version pair'
    iframe.style.cssText =
      'position:fixed;left:0;top:0;width:80px;height:60px;border:0;z-index:2147483647'
    document.body.append(iframe)
  })
  const frame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  await frame.evaluate(bundle.outputFiles[0].text)
  return frame
}
const act = (frame: Frame, name: string, ...args: unknown[]) =>
  frame.evaluate(
    ({ name, args }) =>
      (window as unknown as { editPair: Record<string, (...args: unknown[]) => unknown> }).editPair[
        name
      ](...args),
    { name, args },
  )
const snapshot = (frame: Frame) => act(frame, 'snapshot') as Promise<Snapshot>
function compare(actual: number[], expected: number[], tolerance = 1) {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < actual.length; i++)
    expect(Math.abs(actual[i] - expected[i]), `channel ${i}`).toBeLessThanOrEqual(tolerance)
}
function crop(input: number[], x: number, y: number, w: number, h: number) {
  return Array.from(
    { length: w * h * 4 },
    (_, i) =>
      input[((Math.floor(i / 4 / w) + y) * width + (Math.floor(i / 4) % w) + x) * 4 + (i % 4)],
  )
}
function composed(a: number[], b: number[], w: number, boundary: number) {
  const out: number[] = []
  for (let i = 0; i < a.length; i += 4) {
    const member = (i / 4) % w < boundary ? a : b,
      alpha = member[i + 3] / 255
    for (let channel = 0; channel < 3; channel++)
      out.push(Math.round(member[i + channel] * alpha + 32 * (1 - alpha)))
  }
  return out
}

const title =
  'two ordinary version slots preserve independent pixels and non-overlapping alpha at a shared native region'
const requiresForeground = foregroundTest(
  'Composited A/B and split pixel capture requires a compositor-presented drawable on Wayland.',
)

test(title, requiresForeground, async ({ irodori: { page } }) => {
  const frame = await harness(page)
  const reference = parameters.map((p, i) => [
    ...renderAdjustments(new Float32Array(pixels(i)), p, srgbTransform),
  ])
  try {
    await act(frame, 'create', [pixels(0), pixels(1)], parameters)
    await act(frame, 'draw')
    await expect.poll(async () => (await snapshot(frame)).ready).toBe(true)
    let actual = await snapshot(frame)
    compare(actual.pixels[0], reference[0])
    compare(actual.pixels[1], reference[1])
    expect(actual.lost).toEqual([])
    for (const [mode, split, boundary] of [
      ['a', 0.5, width],
      ['b', 0.5, 0],
      ['split', 0.5, width / 2],
      ['split', 0, 0],
      ['split', 1, width],
    ] as const) {
      expect(await act(frame, 'mode', mode, split)).toBe(boundary)
      const raw = await sharp(await frame.locator('#pair').screenshot({ scale: 'css' }))
        .removeAlpha()
        .raw()
        .toBuffer()
      compare([...raw], composed(reference[0], reference[1], width, boundary), 2)
    }
    // A noncentral 4x4 viewport at 100% selects source columns4..7 and rows2..5.
    await act(frame, 'draw', 4, 4, -2, -1, true)
    actual = await snapshot(frame)
    expect(actual.ready).toBe(false)
    expect(actual.opacity).toBe('0')
    const pending = await sharp(await frame.locator('#pair').screenshot({ scale: 'css' }))
      .removeAlpha()
      .raw()
      .toBuffer()
    expect([...pending]).toEqual(Array(4 * 4 * 3).fill(32))
    await act(frame, 'release')
    await expect.poll(async () => (await snapshot(frame)).ready).toBe(true)
    actual = await snapshot(frame)
    const a = crop(reference[0], 4, 2, 4, 4),
      b = crop(reference[1], 4, 2, 4, 4)
    compare(actual.pixels[0], a)
    compare(actual.pixels[1], b)
    await act(frame, 'mode', 'split', 0.5)
    const raw = await sharp(await frame.locator('#pair').screenshot({ scale: 'css' }))
      .removeAlpha()
      .raw()
      .toBuffer()
    compare([...raw], composed(a, b, 4, 2), 2)
  } finally {
    await act(frame, 'close')
    await expect
      .poll(async () => (await snapshot(frame)).owner)
      .toEqual({ ramBytes: 0, vramBytes: 0 })
  }
})
