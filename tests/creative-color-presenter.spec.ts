import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { Frame, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: {
    input: [number, number, number]
    output: [number, number, number]
    primaries: string
    configuration: number
  }[]
}
const vectorsFor = (index: number) =>
  reference.gpuVectors.filter(
    (v) => v.primaries === 'srgb' && v.configuration === index && v.input.every((v) => v >= 0),
  )
const parameters = (index: number): AdjustmentParameters => {
  const c = reference.configurations[index]
  return {
    ...neutralAdjustments,
    ...c.intensity,
    colorMixer: structuredClone(c.mixer),
    colorGrading: structuredClone(c.grading),
  }
}
interface Snapshot {
  pixels: number[]
  width: number
  height: number
  uploads: number
  programs: number
  draws: number
  lost: number
  pending: boolean
  ready: boolean
  owner: { ramBytes: number; vramBytes: number }
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
import {srgbTransform,renderAdjustments,neutralAdjustments,sameAdjustments} from './src/shared/adjustments';
import {imageResourceOwners} from './src/renderer/src/preview/image-resource-owners';
let source,canvas,presenter,gl,parameters,requested,proof,mode='after',hold=false,uploads=0,programs=0,draws=0,lost=0,fail=false;
const NativeWorker=window.Worker;
const workerUrl=${JSON.stringify(pathToFileURL(workerFile).href)};
window.Worker=class extends NativeWorker {constructor(url,options){
 if(!String(url).endsWith('/presentation-worker.ts'))throw Error('Unexpected isolated worker');
 super(workerUrl,options)}};
window.presenterHarness={
 initialize(input){source=input},
 async create(fallback=false,pause=false,reject=false){
  canvas=document.createElement('canvas');document.body.append(canvas);hold=pause;fail=reject;
  uploads=programs=draws=lost=0;
  if(!fallback){
   gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:false,antialias:false,preserveDrawingBuffer:true});
   if(!gl)throw Error('Isolated WebGL2 unavailable');
   const realExtension=gl.getExtension.bind(gl),parallel=realExtension('KHR_parallel_shader_compile'),
     extension=parallel||{COMPLETION_STATUS_KHR:0x91B1},
     realParameter=gl.getProgramParameter.bind(gl),realProgram=gl.createProgram.bind(gl),
     realUpload=gl.texImage2D.bind(gl),realDraw=gl.drawArrays.bind(gl);
   // Hold only completion publication, preserving actual shader/link execution.
   gl.getExtension=name=>name==='KHR_parallel_shader_compile'?extension:realExtension(name);
   gl.getProgramParameter=(program,name)=>name===extension.COMPLETION_STATUS_KHR?
     (!hold&&(parallel?realParameter(program,name):true)):
     (fail&&programs>1&&name===gl.LINK_STATUS?false:realParameter(program,name));
   gl.createProgram=()=>{programs++;return realProgram()};
   gl.texImage2D=(...args)=>{uploads++;return realUpload(...args)};
   gl.drawArrays=(...args)=>{draws++;return realDraw(...args)};
  }else gl=null;
  presenter=new PreviewPresenter(canvas,fallback,()=>lost++);
  if(fallback){
   proof=await createImageBitmap(new ImageData(renderAdjustments(new Float32Array(source),neutralAdjustments,srgbTransform),source.length/4,1));
   presenter.setBitmap(proof);
  }
  presenter.setWorking({width:source.length/4,height:1,data:new Float32Array(source),transform:srgbTransform});
 },
 draw(p,comparison='after',extra=0){parameters=structuredClone(p);requested=structuredClone(p);mode=comparison;
  presenter.setComparison(mode,.5);
  presenter.draw({width:source.length/4,height:1},{width:source.length/4+extra,height:1},
    {fit:true,scale:1,x:0,y:0},parameters);
  // Pending preparation must own its parameters even if a caller reuses its object.
  if(parameters.colorGrading)parameters.colorGrading.tones.shadows.hue=123;
 },
 release(){hold=false},
 snapshot(){
  let pixels=[];
  if(canvas&&presenter){const width=canvas.width,height=canvas.height,dpr=window.devicePixelRatio||1;
   let raw;
   if(gl){raw=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw)}
   else raw=canvas.getContext('2d').getImageData(0,0,width,height).data;
   for(let x=0;x<source.length/4;x++){
    const at=(Math.floor(dpr/2)*width+Math.floor((x+.5)*dpr))*4;
    pixels.push(...raw.slice(at,at+4));
   }
  }
  return {pixels,width:canvas?.width||0,height:canvas?.height||0,uploads,programs,draws,lost,
    pending:!!presenter?.creativePending,
    ready:gl?!presenter?.creativePending:sameAdjustments(presenter?.fallbackParameters,requested),
    owner:imageResourceOwners.snapshot(),data:{...canvas?.dataset}};
 },
 close(){presenter?.dispose();presenter=null;proof?.close();proof=null;canvas?.remove()},
 finish(){this.close()}
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
    frame.title = 'Isolated color presenter'
    document.body.append(frame)
  })
  const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  await frame.evaluate(bundle.outputFiles[0].text)
  await act(
    frame,
    'initialize',
    vectorsFor(0).flatMap((v) => [...v.input, 1]),
  )
  return frame
}
const act = (frame: Frame, name: string, ...args: unknown[]) =>
  frame.evaluate(
    ({ name, args }) =>
      (
        window as unknown as { presenterHarness: Record<string, (...args: unknown[]) => void> }
      ).presenterHarness[name](...args),
    { name, args },
  )
const snapshot = (frame: Frame): Promise<Snapshot> =>
  frame.evaluate(() =>
    (
      window as unknown as { presenterHarness: { snapshot: () => Snapshot } }
    ).presenterHarness.snapshot(),
  )
const ready = (frame: Frame, p: AdjustmentParameters) =>
  expect
    .poll(async () => {
      const s = await snapshot(frame)
      return (
        s.ready &&
        s.data.colorMixer === JSON.stringify(p.colorMixer) &&
        s.data.colorGrading === JSON.stringify(p.colorGrading)
      )
    })
    .toBe(true)
function referencePixels(index: number) {
  return vectorsFor(index).flatMap((v) => [
    ...v.output.map((v) => {
      const x = Math.min(1, Math.max(0, v))
      return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255)
    }),
    255,
  ])
}
function comparePixels(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) expect(actual[i]).toBe(expected[i])
    else expect(Math.abs(actual[i] - expected[i]), `channel ${i}`).toBeLessThanOrEqual(1)
  }
}

test('actual hidden SDR presenter compiles grading lazily, keeps the resident source and publishes only the latest pending grade', async ({
  irodori: { page },
}) => {
  const frame = await harness(page)
  try {
    await act(frame, 'create', false, true)
    await act(frame, 'draw', parameters(0))
    const original = await snapshot(frame)
    expect(original.programs).toBe(1)
    expect(original.uploads).toBe(1)
    comparePixels(original.pixels, referencePixels(0))
    await act(frame, 'draw', parameters(1), 'after', 2)
    const pending = await snapshot(frame)
    expect(pending.pending).toBe(true)
    expect(pending.width).toBe(original.width)
    expect(pending.pixels).toEqual(original.pixels)
    expect(pending.draws).toBe(original.draws)
    expect(pending.owner.vramBytes).toBe(original.owner.vramBytes + 416)
    await act(frame, 'draw', parameters(9))
    await act(frame, 'release')
    await ready(frame, parameters(9))
    const active = await snapshot(frame)
    expect(active.programs).toBe(2)
    expect(active.uploads).toBe(1)
    expect(active.lost).toBe(0)
    comparePixels(active.pixels, referencePixels(9))
    for (const index of [2, 6, 0, 9]) {
      await act(frame, 'draw', parameters(index))
      await ready(frame, parameters(index))
      const s = await snapshot(frame)
      expect(s.programs).toBe(2)
      expect(s.uploads).toBe(1)
      comparePixels(s.pixels, referencePixels(index))
    }
    await act(frame, 'draw', parameters(9), 'before')
    comparePixels((await snapshot(frame)).pixels, referencePixels(0))
    await act(frame, 'draw', parameters(9), 'split')
    const split = (await snapshot(frame)).pixels,
      before = referencePixels(0),
      after = referencePixels(9),
      middle = split.length / 2
    expect(split.length % 8).toBe(0)
    comparePixels(split, [...before.slice(0, middle), ...after.slice(middle)])
  } finally {
    await act(frame, 'finish')
    await expect
      .poll(async () => (await snapshot(frame)).owner)
      .toEqual({ ramBytes: 0, vramBytes: 0 })
  }
})

test('failed or disposed grading preparation cannot publish late pixels and the actual CPU worker retains the same grade', async ({
  irodori: { page },
}) => {
  const frame = await harness(page)
  try {
    await act(frame, 'create', false, true)
    await act(frame, 'draw', parameters(9))
    expect((await snapshot(frame)).pending).toBe(true)
    await act(frame, 'close')
    await act(frame, 'release')
    await expect
      .poll(async () => (await snapshot(frame)).owner)
      .toEqual({ ramBytes: 0, vramBytes: 0 })
    await act(frame, 'create', false, false, true)
    await act(frame, 'draw', parameters(9))
    await expect.poll(async () => (await snapshot(frame)).lost).toBe(1)
    expect((await snapshot(frame)).data.colorProgram).toBe('failed')
    await act(frame, 'close')
    await expect
      .poll(async () => (await snapshot(frame)).owner)
      .toEqual({ ramBytes: 0, vramBytes: 0 })
    await act(frame, 'create', true)
    for (const index of [0, 1, 6, 9]) {
      await act(frame, 'draw', parameters(index))
      await ready(frame, parameters(index))
      comparePixels((await snapshot(frame)).pixels, referencePixels(index))
    }
    await act(frame, 'draw', parameters(9), 'before')
    comparePixels((await snapshot(frame)).pixels, referencePixels(0))
  } finally {
    await act(frame, 'finish')
    await expect
      .poll(async () => (await snapshot(frame)).owner)
      .toEqual({ ramBytes: 0, vramBytes: 0 })
  }
})
