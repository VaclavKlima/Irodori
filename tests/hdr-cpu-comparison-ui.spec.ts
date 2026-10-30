import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Frame, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { nativeCpuExecutable } from '../src/main/native-cpu-executable'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import type { CpuPreviewPair, CpuPreviewRequest } from '../src/shared/native-cpu-preview'
import { controllerFixture, cpuOracle, readPlane } from './native-cpu-controller.helpers'

const width = 8,
  height = 6,
  edits = { ...neutralAdjustments, exposureEv: 0.5, saturation: 12 }
type Fixture = Awaited<ReturnType<typeof controllerFixture>>
async function harness(page: Page, fixture: Fixture, backend: 'native' | 'javascript') {
  const after = await fixture.source('cpu-presenter-after', width, height),
    original = new Float32Array(after.pixels)
  for (let i = 0; i < original.length; i += 4) {
    original[i] += 0.03
    original[i + 1] *= 0.7
    original[i + 2] += 0.02
  }
  const before = await fixture.source('cpu-presenter-before', width, height, original)
  Object.assign(before.ref, { photoId: after.ref.photoId })
  const pairs: CpuPreviewPair[] = []
  await page.exposeFunction('__cpuPresenterOperation', async (name: string, args: unknown[]) => {
    switch (name) {
      case 'render': {
        const pair = await fixture.controller.render(args[0] as CpuPreviewRequest)
        pairs.push(structuredClone(pair))
        return pair
      }
      case 'cancel':
        return fixture.controller.cancel(args[0] as string, args[1] as string)
      case 'ack':
        return fixture.controller.acknowledge(
          args[0] as string,
          args[1] as string,
          args[2] as string | null,
        )
      case 'release':
        return fixture.controller.release(args[0] as string, args[1] as string | null)
      case 'plane':
        return [...(await readPlane(fixture.controller, args[0] as string))]
      default:
        throw new Error('Unknown isolated CPU presenter operation.')
    }
  })
  const worker = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import './src/renderer/src/preview/hdr-presentation-worker';
// Blob Range emulation is a test transport; real strip validation remains active.
const actualFetch=self.fetch.bind(self);
self.fetch=async(url,options)=>{
 const response=await actualFetch(url,options),range=new Headers(options?.headers).get('Range');
 if(!String(url).startsWith('blob:')||!range)return response;
 const match=/^bytes=(\\d+)-(\\d+)$/.exec(range);if(!match)throw Error('Invalid test range');
 const bytes=(await response.arrayBuffer()).slice(Number(match[1]),Number(match[2])+1);
 return new Response(bytes,{status:206,headers:{'content-length':String(bytes.byteLength)}});
};`,
    },
    bundle: true,
    format: 'iife',
    write: false,
  })
  const workerFile = test.info().outputPath('hdr-presentation-worker.mjs')
  await writeFile(workerFile, worker.outputFiles[0].text)
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {HdrCpuPresenter} from './src/renderer/src/preview/hdr-cpu-presenter';
import {observeHdrSample} from './src/renderer/src/preview/hdr-sample';
import {srgbTransform} from './src/shared/adjustments';
const invoke=(name,...args)=>window.__cpuPresenterOperation(name,args),actualFetch=window.fetch.bind(window),
 NativeWorker=window.Worker,urls=[],stops=[],requests=[];
window.fetch=async(url,options)=>{
 if(!String(url).startsWith('irodori-photo://library/'))return actualFetch(url,options);
 const bytes=new Uint8Array(await invoke('plane',String(url)));options?.signal?.throwIfAborted();
 return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
};
window.irodori={renderCpuPreview:r=>invoke('render',r),cancelCpuPreview:(s,r)=>invoke('cancel',s,r),
 acknowledgeCpuPreview:(s,p,r)=>invoke('ack',s,p,r),releaseCpuPreview:(s,p)=>invoke('release',s,p)};
window.Worker=class extends NativeWorker {
 constructor(url,options){
  if(!String(url).endsWith('/hdr-presentation-worker.ts'))throw Error('Unexpected CPU worker');
  super(${JSON.stringify(pathToFileURL(workerFile).href)},options);
 }
 postMessage(message,...rest){requests.push([message.asset?.sha256,message.beforeAsset?.sha256]);
  super.postMessage(message,...rest)}
};
let presenter,canvas,after,before,loaded=0,failures=0,activity=0,samples={},selected='after';
function frame(record){
 const url=URL.createObjectURL(new Blob([new Float32Array(record.pixels).buffer]));urls.push(url);
 return {width:8,height:6,data:new Float32Array(0),transform:srgbTransform,
  identity:record.ref.renderingIdentity,cpuSource:record.ref,hdr:{...record.asset,url}};
}
window.cpuComparisonPresenter={
 create(a,b){after=frame(a);before=frame(b);canvas=document.createElement('canvas');document.body.append(canvas);
  for(const source of [after,before])stops.push(observeHdrSample(source.hdr.sha256,(data,draft)=>{
   samples[source.hdr.sha256]={data:[...data],draft:[...draft]};}));
  presenter=new HdrCpuPresenter(canvas,()=>loaded++,()=>failures++,()=>{activity++;return()=>activity--},
   Promise.resolve(),()=>${JSON.stringify(backend)});
  presenter.setWorking(after);presenter.setComparisonSource(before);
 },
 draw(parameters,mode='before',ranges=false){selected=mode;
  presenter.setPresentationState({revision:1,settings:parameters});presenter.setComparison(mode,.5);
  presenter.setHdrRanges(ranges);presenter.draw({width:8,height:6},{width:8,height:6},
   {fit:false,scale:1,x:0,y:0},parameters);},
 alias(){presenter.setComparisonSource(after)},
 probeMask(which){let finish;const drained=new Promise(resolve=>{finish=resolve}),
  scope=presenter.reserveMask(which==='before'?before:after,()=>{},drained);
  scope?.release();finish();return !!scope},
 snapshot(){return {loaded,failures,activity,samples,requests,maskKey:presenter.maskPublicationKey,
  visibility:canvas.style.visibility,data:{...canvas.dataset},
  pixels:[...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data]}},
 async expected(afterBytes,beforeBytes){
  const c=document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;
  const ctx=c.getContext('2d',{colorSpace:'srgb'}),dpr=devicePixelRatio||1;
  const bitmap=await createImageBitmap(new ImageData(new Uint8ClampedArray(afterBytes),8,6)),
   neutral=await createImageBitmap(new ImageData(new Uint8ClampedArray(beforeBytes),8,6));
  try {ctx.scale(dpr,dpr);ctx.imageSmoothingEnabled=false;
   ctx.drawImage(selected==='before'?neutral:bitmap,0,0,8,6);
   if(selected==='split'){ctx.save();ctx.beginPath();ctx.rect(0,0,4,6);ctx.clip();ctx.clearRect(0,0,8,6);
    ctx.drawImage(neutral,0,0,8,6);ctx.restore()}
   return [...ctx.getImageData(0,0,c.width,c.height).data];
  }finally{bitmap.close();neutral.close()}
 },
 async close(){presenter?.dispose();await presenter?.whenDisposed;for(const stop of stops)stop();
  for(const url of urls)URL.revokeObjectURL(url)}
};`,
    },
    define: {
      'import.meta.url': JSON.stringify(
        pathToFileURL(resolve('src/renderer/src/preview/hdr-cpu-presenter.ts')).href,
      ),
    },
    bundle: true,
    format: 'iife',
    write: false,
  })
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Isolated CPU comparison presenter'
    document.body.append(frame)
  })
  const frame = page.frames().find((item) => item.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  await frame.evaluate(bundle.outputFiles[0].text)
  const input = (record: typeof after) => ({
    ref: record.ref,
    asset: record.asset,
    pixels: [...record.pixels],
  })
  await act(frame, 'create', input(after), input(before))
  return { frame, after, before, pairs }
}
const act = (frame: Frame, name: string, ...args: unknown[]) =>
  frame.evaluate(
    ({ name, args }) =>
      (
        window as unknown as {
          cpuComparisonPresenter: Record<string, (...args: unknown[]) => unknown>
        }
      ).cpuComparisonPresenter[name](...args),
    { name, args },
  )
interface Snapshot {
  loaded: number
  failures: number
  activity: number
  visibility: string
  data: Record<string, string>
  maskKey?: string
  samples: Record<string, { data: number[]; draft: number[] }>
  requests: string[][]
  pixels: number[]
}
const snapshot = (frame: Frame) => act(frame, 'snapshot') as Promise<Snapshot>

for (const backend of ['native', 'javascript'] as const)
  test(`${backend} CPU presentation uses original Before pixels and analysis samples through point edits, Split and aliases`, async ({
    irodori: { page },
  }) => {
    test.skip(process.platform !== 'linux' || process.arch !== 'x64', 'Checked Linux x64 helper.')
    const fixture = await controllerFixture({
      nativeExecutable: await nativeCpuExecutable(resolve('vendor')),
    })
    let frame: Frame | undefined
    try {
      const h = await harness(page, fixture, backend)
      frame = h.frame
      const wait = async (parameters: AdjustmentParameters, previous = 0) => {
          await expect
            .poll(async () => {
              const s = await snapshot(frame!)
              expect(s.failures).toBe(0)
              return (
                s.loaded > previous &&
                s.data.exposure === String(parameters.exposureEv) &&
                s.visibility === 'visible'
              )
            })
            .toBe(true)
        },
        check = async (parameters: AdjustmentParameters, alias = false, ranges = false) => {
          const after = cpuOracle(
              h.after,
              fixture.request(h.after, { parameters, hdrRanges: ranges }),
            ).after,
            before = cpuOracle(
              alias ? h.after : h.before,
              fixture.request(alias ? h.after : h.before, { hdrRanges: ranges }),
            ).before
          let a: number[] = [...after],
            b: number[] = [...before]
          if (backend === 'native') {
            const pair = h.pairs.at(-1)!
            a = [...(await readPlane(fixture.controller, pair.after.url))]
            b = [...(await readPlane(fixture.controller, pair.before.url))]
            for (const [actual, expected] of [
              [a, after],
              [b, before],
            ] as const)
              for (let i = 0; i < actual.length; i++)
                expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(i % 4 === 3 ? 0 : 1)
          }
          expect((await snapshot(frame!)).pixels).toEqual(await act(frame!, 'expected', a, b))
        }
      await act(frame, 'draw', edits)
      await wait(edits)
      await check(edits)
      const s = await snapshot(frame)
      expect(s.samples[h.after.asset.sha256].data).toEqual([...h.after.pixels])
      expect(s.samples[h.before.asset.sha256].data).toEqual([...h.before.pixels])
      expect(s.samples[h.before.asset.sha256].draft).toEqual([...h.before.pixels])
      if (backend === 'native') {
        const key = JSON.parse(s.maskKey!)
        expect(key[1]).toEqual(h.before.ref)
        expect(key[2]).toEqual(h.after.ref)
        expect(await act(frame, 'probeMask', 'before')).toBe(true)
        expect(await act(frame, 'probeMask', 'after')).toBe(false)
      } else expect(s.maskKey).toBeUndefined()
      expect(s.data.presentedBeforeSourceSha256).toBe(h.before.asset.sha256)
      const next = { ...edits, exposureEv: -0.5 }
      await act(frame, 'draw', next, 'split')
      await wait(next, s.loaded)
      await check(next)
      if (backend === 'native') expect(h.pairs.at(-1)!.diagnostics.beforeCacheHit).toBe(true)
      else
        expect((await snapshot(frame)).requests.at(-1)).toEqual([
          h.after.asset.sha256,
          h.before.asset.sha256,
        ])
      await act(frame, 'draw', next, 'before', true)
      await expect.poll(async () => (await snapshot(frame!)).data.hdrRanges).toBe('true')
      await check(next, false, true)
      const beforeAlias = await snapshot(frame)
      await act(frame, 'alias')
      await wait(next, beforeAlias.loaded)
      await expect
        .poll(async () => (await snapshot(frame!)).data.presentedBeforeSourceSha256)
        .toBeUndefined()
      await check(next, true, true)
      expect((await snapshot(frame)).failures).toBe(0)
    } finally {
      if (frame) await act(frame, 'close')
      await fixture.close()
    }
  })
