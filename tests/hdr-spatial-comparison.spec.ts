import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { Frame, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import {
  HDR_SOURCE_VERSION,
  HDR_JPEG_SOURCE_VERSION,
  SDR_TARGET,
  adjustHdr,
  outputHdr,
  encodeHdr,
  type DisplayTarget,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import { hdrStatistics, analyzeHdr, type HdrStatistics } from '../src/shared/hdr-statistics'
import { neutralColorGrading } from '../src/shared/color-grading'
import { resolveResourcePolicy } from '../src/shared/resource-policy'

test.use({ hdrDisplay: true })
const width = 8,
  height = 6
// Original CC0-1.0 linear patterns. No photograph or camera decoder is involved.
function fixture(variant: number, authored = false) {
  const data = new Float32Array(
    Array.from({ length: width * height }, (_, i) => {
      const x = i % width,
        y = Math.floor(i / width)
      return variant % 2
        ? [
            0.18 + 0.027 * x,
            0.38 + 0.015 * y,
            0.14 + 0.019 * ((x + variant) % 5),
            i % 17 === 0 ? 0 : 1,
          ]
        : [
            0.07 + 0.019 * y,
            0.16 + 0.013 * x,
            0.32 + 0.023 * ((y + variant) % 4),
            i % 17 === 0 ? 0 : 1,
          ]
    }).flat(),
  )
  const sha256 = createHash('sha256').update(new Uint8Array(data.buffer)).digest('hex'),
    base = {
      processing: 'hdr-v1' as const,
      colorSpace: 'rec2020' as const,
      whitePoint: 'D65' as const,
      transfer: 'linear' as const,
      alpha: 'straight' as const,
      decoder: 'isolated-hdr-comparison',
      orientation: 'applied-once' as const,
    },
    asset: HdrWorkingAsset = {
      kind: 'hdr-working-v1',
      width,
      height,
      byteLength: data.byteLength,
      sha256,
      strips: [{ byteLength: data.byteLength, sha256 }],
      source: authored
        ? {
            ...base,
            version: HDR_JPEG_SOURCE_VERSION,
            display: { encoding: 'iso-21496-1-jpeg', headroom: 10, referenceWhiteNits: 203 },
            normalization: { referenceWhite: 1, sourceSaturation: null },
          }
        : {
            ...base,
            version: HDR_SOURCE_VERSION,
            cameraProfile: 'isolated-comparison',
            normalization: {
              black: [0, 0, 0, 0],
              maximum: 1,
              gains: [1, 1, 1, 1],
              restoreGain: 1,
              referenceWhite: 1,
              sourceSaturation: null,
            },
          },
    }
  return { data: [...data], asset }
}
const graded: AdjustmentParameters = {
  ...neutralAdjustments,
  exposureEv: 0.4,
  contrast: 8,
  shadows: 10,
  saturation: 12,
  colorGrading: {
    ...neutralColorGrading,
    tones: {
      ...neutralColorGrading.tones,
      shadows: { hue: 225, saturation: 12, luminance: 0 },
      highlights: { hue: 35, saturation: 9, luminance: 0 },
    },
  },
}
const sdr = { ...SDR_TARGET, generation: 1 },
  hdr: DisplayTarget = { ...SDR_TARGET, generation: 2, mode: 'hdr', peak: 4, headroom: 4 }
function reference(
  input: ReturnType<typeof fixture>,
  p: AdjustmentParameters,
  target: DisplayTarget,
) {
  const result: number[] = [],
    matte = [0.00478, 0.0052, 0.00563]
  for (let i = 0; i < input.data.length; i += 4) {
    const rgb = outputHdr(
        adjustHdr(input.data.slice(i, i + 3) as [number, number, number], p),
        target,
        input.asset.source,
      ).rgb,
      alpha = input.data[i + 3]
    result.push(...rgb.map((v, c) => encodeHdr(matte[c] * (1 - alpha) + v * alpha)), 1)
  }
  return result
}
function compare(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (i % 4 === 3) expect(actual[i]).toBe(expected[i])
    else
      expect(Math.abs(actual[i] - expected[i]), `encoded channel ${i}`).toBeLessThanOrEqual(1 / 255)
  }
}
const split = (before: number[], after: number[], w = width) =>
  after.map((v, i) => (Math.floor(i / 4) % w < w / 2 ? before[i] : v))

interface Snapshot {
  ready: boolean
  visibility: string
  held: number
  lost: string[]
  data: Record<string, string>
  requests: string[]
  cache: { entries: number; ramBytes: number; vramBytes: number }
  owner: { ramBytes: number; vramBytes: number }
  publications: (string | null)[]
  statistics?: HdrStatistics
  samples: Record<string, { sample: number[]; draft: number[] }>
  recovery?: { beforeSourceIdentity?: string }
  recoverable: boolean
}
async function harness(page: Page) {
  const workerPaths: Record<string, string> = {}
  for (const entry of ['hdr-upload-worker', 'display-rendering-worker']) {
    const worker = await build({
      entryPoints: [`src/renderer/src/preview/${entry}.ts`],
      bundle: true,
      format: 'iife',
      write: false,
    })
    const file = test.info().outputPath(`${entry}.mjs`)
    await writeFile(file, worker.outputFiles[0].text)
    workerPaths[`${entry}.ts`] = pathToFileURL(file).href
  }
  const policy = resolveResourcePolicy(
    { version: 1, ramMiB: 2048, vramMiB: 2048 },
    {
      ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
      gpu: { status: 'unknown', reason: 'adapter-unverified' },
    },
    1,
  )
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {HdrPresenter} from './src/renderer/src/preview/hdr-presenter';
import {neutralAdjustments,srgbTransform} from './src/shared/adjustments';
import {SDR_TARGET} from './src/shared/hdr';
import {selectEditorPreviewPolicy} from './src/shared/editor-preview-policy';
import {sourceCache,presentationCache} from './src/renderer/src/preview/hdr-preview-resources';
import {imageResourceOwners} from './src/renderer/src/preview/image-resource-owners';
import {hdrPresentationMemory,HDR_BITMAP_RESERVATION} from './src/renderer/src/preview/hdr-memory';
import {hdrSourceIdentity} from './src/renderer/src/preview/hdr-source-cache';
import {observeHdrSample} from './src/renderer/src/preview/hdr-sample';
const workers=${JSON.stringify(workerPaths)},NativeWorker=window.Worker,urls=[];
let presenter,canvas,retainedCanvas,after,before,viewport={width:8,height:6},mode='after',holdHash='',held=[],
 requests=[],lost=[],statistics,publications=[],retired=Promise.resolve(),clearing=Promise.resolve(),
 holdFences=false,fences=[],instrumented=false,samples={},sampleStops=[];
window.Worker=class extends NativeWorker {
 constructor(url,options){
  const name=String(url).split('/').pop();if(!workers[name])throw Error('Unexpected isolated HDR worker');
  super(workers[name],options);this.stopped=false;
  super.addEventListener('message',event=>{
   const item={owner:this,deliver:()=>this.deliver?.(event)};
   if(this.hash&&this.hash===holdHash)held.push(item);else item.deliver();
  });
 }
 set onmessage(handler){this.deliver=handler}
 postMessage(message,...rest){
  if(message.asset){this.hash=message.asset.sha256;requests.push(this.hash)}
  super.postMessage(message,...rest);
 }
 terminate(){this.stopped=true;held=held.filter(item=>item.owner!==this);super.terminate()}
};
function source(input,corrupt=false){
 const data=new Float32Array(input.data);if(corrupt)data[4]+=.1;
 const url=URL.createObjectURL(new Blob([data.buffer]));urls.push(url);
 sampleStops.push(observeHdrSample(input.asset.sha256,(sample,draft)=>{
  samples[input.asset.sha256]={sample:[...sample],draft:[...draft]};}));
 return {width:8,height:6,data:new Float32Array(0),transform:{...srgbTransform},
   identity:input.identity||'fixture-'+input.asset.sha256,
   cpuSource:{photoId:'a'.repeat(64),cacheId:input.asset.sha256.slice(0,8)+'-'+input.asset.sha256.slice(8,12)+
    '-'+input.asset.sha256.slice(12,16)+'-'+input.asset.sha256.slice(16,20)+'-'+input.asset.sha256.slice(20,32),
    renderingIdentity:'fixture-'+input.asset.sha256,workingSha256:input.asset.sha256},
   hdr:{...structuredClone(input.asset),url}};
}
function half(word){const e=(word>>>10)&31,f=word&1023;
 return (word&32768?-1:1)*(e?(1+f/1024)*2**(e-15):f*2**-24)}
window.hdrComparison={
 create(input,target,smallBudget=false,forceStaging=false){
  const policy=${JSON.stringify(policy)},dpr=devicePixelRatio||1;
  if(forceStaging)Object.defineProperty(window,'Float16Array',{configurable:true,value:undefined});
  canvas=document.createElement('canvas');document.body.append(canvas);
  retainedCanvas=smallBudget?undefined:document.createElement('canvas');
  if(smallBudget){
   const plan=hdrPresentationMemory({width:8,height:6,canvasWidth:Math.round(8*dpr),
    canvasHeight:Math.round(6*dpr),bitmapReservation:HDR_BITMAP_RESERVATION,rawHalfSupported:false},
    {ramBytes:2*1024**3,vramBytes:2*1024**3,revision:1});
   policy.vram.effectiveBytes=plan.minimumPresentation.vramBytes+
    Math.floor(hdrSourceIdentity(input.asset).textureBytes/2);
  }
  window.irodori={getResourcePolicy:async()=>policy};
  presenter=new HdrPresenter(canvas,target,selectEditorPreviewPolicy(smallBudget?null:'linux'),
   reason=>lost.push(reason),()=>publications.push(canvas.dataset.presentedBeforeSourceIdentity||null),
   result=>{statistics=result},retainedCanvas);
  presenter.setPresentationState({revision:1,settings:neutralAdjustments});
  after=source(input);presenter.setWorking(after);
 },
 before(input,required=true,corrupt=false){before=input?source(input,corrupt):null;
  presenter.setComparisonSource(before,required)},
 alias(){presenter.setComparisonSource(after)},
 probeMask(which){let finish;const drained=new Promise(resolve=>{finish=resolve}),
  scope=presenter.reserveMask(which==='before'?before:after,()=>{},drained);
  scope?.release();finish();return !!scope},
 draw(parameters,selected='after',scale=1,target){
  if(target)presenter.setTarget(target);
  mode=selected;viewport={width:8*scale,height:6*scale};
  presenter.setPresentationState({revision:1,settings:parameters});
  presenter.setEditing(false,1,null,{revision:1,settings:parameters});
  presenter.setComparison(mode,.5);presenter.draw({width:8,height:6},viewport,
    {fit:scale<1,scale,x:0,y:0},parameters);
 },
 holdSource(hash){holdHash=hash},
 holdFence(){
  const queue=presenter.device.queue;
  if(!instrumented){const actual=queue.onSubmittedWorkDone.bind(queue);
   queue.onSubmittedWorkDone=()=>{const done=actual();
    return holdFences?Promise.all([done,new Promise(resolve=>fences.push(resolve))]).then(()=>undefined):done};
   instrumented=true;
  }holdFences=true;
 },
 release(){holdHash='';const messages=held;held=[];for(const item of messages)if(!item.owner.stopped)item.deliver();
  holdFences=false;const gates=fences;fences=[];for(const resolve of gates)resolve()},
 snapshot(){return {ready:!!presenter&&!presenter.running&&!presenter.comparisonWork&&
    canvas.dataset.editing==='ready'&&canvas.dataset.comparison===mode&&
    canvas.dataset.completedEditSerial===canvas.dataset.requestedSerial&&
    canvas.dataset.analysisPending!=='true',visibility:canvas?.style.visibility,held:held.length,
   lost,data:{...canvas?.dataset},requests,cache:sourceCache.memory(),owner:imageResourceOwners.snapshot(),publications,statistics,samples,
   recovery:presenter?.recovery.snapshot,recoverable:!!presenter&&!!retainedCanvas&&presenter.recoverCompletedFrame(retainedCanvas)}},
 async pixels(){
  const texture=presenter.surface,device=presenter.device,width=texture.width,height=texture.height,
   bytesPerRow=Math.ceil(width*8/256)*256,buffer=device.createBuffer({size:bytesPerRow*height,
    usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
  encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow},[width,height]);device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);const words=new Uint16Array(buffer.getMappedRange()),pixels=[],dpr=devicePixelRatio||1;
  for(let y=0;y<viewport.height;y++)for(let x=0;x<viewport.width;x++){
   const at=Math.floor((y+.5)*dpr)*bytesPerRow/2+Math.floor((x+.5)*dpr)*4;
   pixels.push(...Array.from(words.subarray(at,at+4),half));
  }buffer.unmap();buffer.destroy();return pixels;
 },
 close(){if(presenter){presenter.dispose();retired=presenter.whenDisposed;presenter=null}},
 drainCache(){clearing=sourceCache.clearAndDrain()},
 async finish(){this.release();this.close();await retired;await clearing;
  await sourceCache.clearAndDrain();await presentationCache.clearAndDrain();
  for(const stop of sampleStops)stop();sampleStops=[];
  for(const url of urls)URL.revokeObjectURL(url);canvas?.remove();canvas=null}
};`,
    },
    bundle: true,
    format: 'iife',
    write: false,
    define: {
      'import.meta.url': JSON.stringify('https://isolated.invalid/preview/hdr-presenter.js'),
      'import.meta.env': '{}',
    },
  })
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Isolated HDR source comparison'
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
        window as unknown as { hdrComparison: Record<string, (...args: unknown[]) => unknown> }
      ).hdrComparison[name](...args),
    { name, args },
  )
const snapshot = (frame: Frame) => act(frame, 'snapshot') as Promise<Snapshot>
const capture = (frame: Frame) => act(frame, 'pixels') as Promise<number[]>
const ready = (frame: Frame) =>
  expect
    .poll(async () => {
      const s = await snapshot(frame)
      expect(s.lost).toEqual([])
      return s.ready
    })
    .toBe(true)
async function finish(frame: Frame) {
  await act(frame, 'finish')
  expect((await snapshot(frame)).cache).toEqual({ entries: 0, ramBytes: 0, vramBytes: 0 })
  await expect
    .poll(async () => (await snapshot(frame)).owner)
    .toEqual({ ramBytes: 0, vramBytes: 0 })
}

for (const authored of [false, true]) {
  test(`actual ${authored ? 'authored' : 'capture'} HDR presenter selects original Before pixels, histograms and cached mips without reuploading point edits`, async ({
    irodori: { page },
  }) => {
    const frame = await harness(page),
      after = fixture(0, authored),
      before = fixture(1, authored),
      initialTarget = authored ? hdr : sdr
    try {
      // Imported HDR uses its independent raster primary in SDR; its Rec.2020
      // rendition belongs to this presenter only in HDR (FullPreviews.requestHdr).
      await act(frame, 'create', after, initialTarget)
      await act(frame, 'draw', neutralAdjustments)
      await ready(frame)
      compare(await capture(frame), reference(after, neutralAdjustments, initialTarget))
      const ordinary = (await snapshot(frame)).cache
      await act(frame, 'alias')
      await act(frame, 'draw', neutralAdjustments)
      await ready(frame)
      expect((await snapshot(frame)).cache).toEqual(ordinary)
      await act(frame, 'before', before)
      for (const target of authored ? [hdr] : [sdr, hdr]) {
        for (const mode of ['split', 'before', 'after']) {
          await act(frame, 'draw', graded, mode, 1, target)
          await ready(frame)
          const expected =
            mode === 'before'
              ? reference(before, neutralAdjustments, target)
              : mode === 'after'
                ? reference(after, graded, target)
                : split(
                    reference(before, neutralAdjustments, target),
                    reference(after, graded, target),
                  )
          compare(await capture(frame), expected)
          const s = await snapshot(frame)
          expect(s.cache.entries).toBe(2)
          expect(s.data.sourceUploads).toBe('1')
          expect(s.data.comparisonUploads).toBe('1')
          expect(s.samples[after.asset.sha256].sample).toEqual(after.data)
          expect(s.samples[before.asset.sha256].sample).toEqual(before.data)
          expect(s.samples[before.asset.sha256].draft).toEqual(before.data)
          if (s.data.retentionMethod === 'raw-half-cpu') {
            expect(s.recovery?.beforeSourceIdentity).toBe(s.data.presentedBeforeSourceIdentity)
            expect(s.recoverable).toBe(true)
          }
          if (mode === 'before') {
            expect(await act(frame, 'probeMask', 'before')).toBe(true)
            expect(await act(frame, 'probeMask', 'after')).toBe(false)
            const expectedStats = hdrStatistics('content-hdr', target, before.asset, false)
            analyzeHdr(
              new Float32Array(before.data),
              neutralAdjustments,
              before.asset,
              target,
              expectedStats,
            )
            expect(s.statistics?.bins).toEqual(expectedStats.bins)
            expect(s.statistics?.rgbHistogram?.rgb).toEqual(expectedStats.rgbHistogram?.rgb)
          }
        }
      }
      await act(frame, 'draw', graded, 'before', 0.5, hdr)
      await ready(frame)
      const fitBefore = await capture(frame)
      await act(frame, 'draw', graded, 'after', 0.5)
      await ready(frame)
      const fitAfter = await capture(frame)
      await act(frame, 'draw', graded, 'split', 0.5)
      await ready(frame)
      compare(await capture(frame), split(fitBefore, fitAfter, width / 2))
      await act(frame, 'before', null, false)
      await act(frame, 'draw', graded, 'before')
      await ready(frame)
      compare(await capture(frame), reference(after, neutralAdjustments, hdr))
      await act(frame, 'before', before)
      await ready(frame)
      compare(await capture(frame), reference(before, neutralAdjustments, hdr))
      expect((await snapshot(frame)).data.comparisonSourceCache).toBe('hit')
      expect((await snapshot(frame)).requests).toEqual([after.asset.sha256, before.asset.sha256])
      const replacement = fixture(3, authored)
      await act(frame, 'before', { ...replacement, identity: 'fixture-' + before.asset.sha256 })
      await ready(frame)
      compare(await capture(frame), reference(replacement, neutralAdjustments, hdr))
    } finally {
      await finish(frame)
    }
  })
}

test('HDR comparison cancels stale source preparation and retains both source pins through disposal fences', async ({
  irodori: { page },
}) => {
  const frame = await harness(page),
    after = fixture(0, true),
    old = fixture(1, true),
    latest = fixture(3, true)
  try {
    await act(frame, 'create', after, hdr)
    await act(frame, 'draw', neutralAdjustments)
    await ready(frame)
    await act(frame, 'before', null, true)
    await act(frame, 'draw', graded, 'before')
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await act(frame, 'holdSource', old.asset.sha256)
    await act(frame, 'before', old)
    await expect.poll(async () => (await snapshot(frame)).held).toBeGreaterThan(0)
    expect((await snapshot(frame)).recoverable).toBe(false)
    await act(frame, 'before', latest)
    await ready(frame)
    compare(await capture(frame), reference(latest, neutralAdjustments, hdr))
    expect((await snapshot(frame)).publications).not.toContain(
      JSON.stringify(['fixture-' + old.asset.sha256, old.asset.sha256]),
    )
    await act(frame, 'holdFence')
    await act(frame, 'close')
    await act(frame, 'drainCache')
    expect((await snapshot(frame)).cache.entries).toBe(2)
    expect((await snapshot(frame)).owner.vramBytes).toBeGreaterThan(0)
    await act(frame, 'release')
  } finally {
    await finish(frame)
  }
})

test('HDR comparison refuses a second source before allocation when the frozen budget only fits After', async ({
  irodori: { page },
}) => {
  const frame = await harness(page),
    after = fixture(0, true),
    before = fixture(1, true)
  try {
    await act(frame, 'create', after, hdr, true)
    await act(frame, 'draw', neutralAdjustments)
    await ready(frame)
    await act(frame, 'before', before)
    await act(frame, 'draw', neutralAdjustments, 'before')
    await expect.poll(async () => (await snapshot(frame)).lost.length).toBe(1)
    expect((await snapshot(frame)).lost[0]).toMatch(/resource budgets/)
    expect((await snapshot(frame)).requests).toEqual([after.asset.sha256])
    expect((await snapshot(frame)).cache.entries).toBe(1)
    expect((await snapshot(frame)).visibility).toBe('hidden')
    await act(frame, 'draw', neutralAdjustments, 'after')
    await expect.poll(async () => (await snapshot(frame)).ready).toBe(true)
    compare(await capture(frame), reference(after, neutralAdjustments, hdr))
  } finally {
    await finish(frame)
  }
})

test('a damaged HDR Before strip cannot publish comparison pixels or retire the accepted After source', async ({
  irodori: { page },
}) => {
  const frame = await harness(page),
    after = fixture(0, true),
    before = fixture(1, true)
  try {
    await act(frame, 'create', after, hdr)
    await act(frame, 'draw', neutralAdjustments)
    await ready(frame)
    await act(frame, 'before', before, true, true)
    await act(frame, 'draw', neutralAdjustments, 'before')
    await expect.poll(async () => (await snapshot(frame)).lost.length).toBe(1)
    expect((await snapshot(frame)).lost[0]).toMatch(/Damaged HDR strip/)
    expect((await snapshot(frame)).visibility).toBe('hidden')
    expect((await snapshot(frame)).publications).not.toContain(
      JSON.stringify(['fixture-' + before.asset.sha256, before.asset.sha256]),
    )
    expect((await snapshot(frame)).cache.entries).toBe(1)
  } finally {
    await finish(frame)
  }
})

test('CPU-staged HDR recovery cannot expose an old source while the required Before capability is missing or uploading', async ({
  irodori: { page },
}) => {
  const frame = await harness(page),
    after = fixture(0, true),
    before = fixture(1, true)
  try {
    await act(frame, 'create', after, hdr, false, true)
    await act(frame, 'draw', neutralAdjustments)
    await ready(frame)
    expect((await snapshot(frame)).data.retentionMethod).toBe('cpu-staging')
    expect((await snapshot(frame)).recoverable).toBe(true)
    await act(frame, 'before', null, true)
    await act(frame, 'draw', neutralAdjustments, 'before')
    expect((await snapshot(frame)).recoverable).toBe(false)
    await act(frame, 'holdSource', before.asset.sha256)
    await act(frame, 'before', before)
    await expect.poll(async () => (await snapshot(frame)).held).toBeGreaterThan(0)
    expect((await snapshot(frame)).recoverable).toBe(false)
    await act(frame, 'release')
    await ready(frame)
    compare(await capture(frame), reference(before, neutralAdjustments, hdr))
    expect((await snapshot(frame)).recoverable).toBe(true)
  } finally {
    await finish(frame)
  }
})
