import { build } from 'esbuild'
import type { Frame, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { resolve } from 'node:path'
import { nativeCpuExecutable } from '../src/main/native-cpu-executable'
import type { CpuPreviewPair, CpuPreviewRequest } from '../src/shared/native-cpu-preview'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { controllerFixture, cpuOracle, readPlane } from './native-cpu-controller.helpers'

test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'The checked native helper is Linux x64.',
)
const parameters = { ...neutralAdjustments, exposureEv: 0.5, saturation: 12 }
async function harness(
  page: Page,
  t: Awaited<ReturnType<typeof controllerFixture>>,
  tamper = false,
) {
  const after = await t.source('native-client-after', 8, 6),
    data = new Float32Array(after.pixels)
  for (let i = 0; i < data.length; i += 4) {
    data[i] += 0.03
    data[i + 1] *= 0.7
    data[i + 2] += 0.02
  }
  const before = await t.source('native-client-before', 8, 6, data)
  Object.assign(before.ref, { photoId: after.ref.photoId })
  const operations: { name: string; args: unknown[] }[] = []
  await page.exposeFunction(
    '__nativeComparisonOperation',
    async (name: string, args: unknown[]) => {
      operations.push({ name, args })
      switch (name) {
        case 'render': {
          const pair = structuredClone(await t.controller.render(args[0] as CpuPreviewRequest))
          if (tamper) Object.assign(pair.beforeSamples!, { url: pair.samples.url })
          return pair
        }
        case 'cancel':
          return t.controller.cancel(args[0] as string, args[1] as string)
        case 'ack':
          return t.controller.acknowledge(
            args[0] as string,
            args[1] as string,
            args[2] as string | null,
          )
        case 'release':
          return t.controller.release(args[0] as string, args[1] as string | null)
        case 'plane':
          return [...(await readPlane(t.controller, args[0] as string))]
        default:
          throw new Error('Unknown isolated native comparison operation.')
      }
    },
  )
  const frameFor = (record: typeof after) => ({
    width: 8,
    height: 6,
    transform: srgbTransform,
    cpuSource: record.ref,
    identity: `fixture-${record.ref.workingSha256}`,
    hdr: record.asset,
  })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {NativeCpuClient} from './src/renderer/src/preview/native-cpu-client';
const invoke=(name,...args)=>window.__nativeComparisonOperation(name,args),
 bridge={getCpuPreviewBackend:async()=>'native',renderCpuPreview:r=>invoke('render',r),
  cancelCpuPreview:(s,r)=>invoke('cancel',s,r),acknowledgeCpuPreview:(s,p,r)=>invoke('ack',s,p,r),
  releaseCpuPreview:(s,p)=>invoke('release',s,p)},realFetch=window.fetch.bind(window);
window.fetch=async(url,options)=>{
 if(!String(url).startsWith('irodori-photo://library/'))return realFetch(url,options);
 const bytes=new Uint8Array(await invoke('plane',String(url)));
 options?.signal?.throwIfAborted();
 return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
};
let reply,publications=0,failures=[],closed=false,digestWaiting=false,hold=false,releaseDigest,
  samplesDigested=0,work=Promise.resolve();
const actualDigest=crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest=(algorithm,bytes)=>{
 const actual=actualDigest(algorithm,bytes);
 if(hold&&bytes.byteLength===8*6*32&&++samplesDigested===2){
  digestWaiting=true;const gate=new Promise(resolve=>{releaseDigest=resolve});
  return Promise.all([actual,gate]).then(([value])=>value);
 }return actual;
};
const client=new NativeCpuClient(bridge,Promise.resolve(),next=>{
 reply?.bitmap.close();reply?.neutral.close();reply=next;publications++;return true;
},error=>failures.push(String(error)));
window.nativeComparisonClient={
 post(frame,beforeFrame,p){client.post({frame:{...frame,data:new Float32Array(0)},
  beforeFrame:beforeFrame?{...beforeFrame,data:new Float32Array(0)}:undefined,
  generation:publications+1,settingsRevision:1,parameters:p,hdrRanges:false,
  viewport:{width:8,height:6,dpr:devicePixelRatio||1}})},
 hold(){hold=true},release(){hold=false;releaseDigest?.()},
 snapshot(){return {publications,failures,closed,digestWaiting,memory:client.memory,
  sample:reply?.sample?[...reply.sample]:null,beforeSample:reply?.beforeSample?[...reply.beforeSample]:null,
  draftSample:reply?.draftSample?[...reply.draftSample]:null,
  beforeDraftSample:reply?.beforeDraftSample?[...reply.beforeDraftSample]:null,
  native:reply?.native}},
 pixels(before){const canvas=document.createElement('canvas');canvas.width=8;canvas.height=6;
  const context=canvas.getContext('2d');context.drawImage(before?reply.neutral:reply.bitmap,0,0);
  return [...context.getImageData(0,0,8,6).data]},
 referencePixels(bytes){const canvas=document.createElement('canvas');canvas.width=8;canvas.height=6;
  const context=canvas.getContext('2d',{colorSpace:'srgb'});
  context.putImageData(new ImageData(new Uint8ClampedArray(bytes),8,6,{colorSpace:'srgb'}),0,0);
  return [...context.getImageData(0,0,8,6).data]},
 close(){work=client.dispose().then(()=>{closed=true});},
 async finish(){this.release();this.close();await work;reply?.bitmap.close();reply?.neutral.close();reply=null}
};`,
    },
    bundle: true,
    format: 'iife',
    write: false,
  })
  await page.evaluate(() => {
    const f = document.createElement('iframe')
    f.title = 'Isolated native paired receiver'
    document.body.append(f)
  })
  const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  await frame.evaluate(bundle.outputFiles[0].text)
  return {
    frame,
    after,
    before,
    operations,
    afterFrame: frameFor(after),
    beforeFrame: frameFor(before),
  }
}
const act = (frame: Frame, name: string, ...args: unknown[]) =>
  frame.evaluate(
    ({ name, args }) =>
      (
        window as unknown as {
          nativeComparisonClient: Record<string, (...args: unknown[]) => unknown>
        }
      ).nativeComparisonClient[name](...args),
    { name, args },
  )
interface Snapshot {
  publications: number
  failures: string[]
  closed: boolean
  digestWaiting: boolean
  sample: number[]
  beforeSample: number[]
  draftSample: number[]
  beforeDraftSample: number[]
  native: CpuPreviewPair
  memory: { peak: { ramBytes: number; gpuBytes: number } }
}
const snapshot = (frame: Frame) => act(frame, 'snapshot') as Promise<Snapshot>
async function ready(frame: Frame, count: number) {
  await expect
    .poll(async () => {
      const s = await snapshot(frame)
      expect(s.failures).toEqual([])
      return s.publications
    })
    .toBe(count)
}
function compare(actual: number[], expected: Uint8Array) {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < actual.length; i++)
    expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(i % 4 === 3 ? 0 : 1)
}

test('the actual native receiver validates distinct Before pixels and samples and replaces the pair across point edits', async ({
  irodori: { page },
}) => {
  const t = await controllerFixture({
    nativeExecutable: await nativeCpuExecutable(resolve('vendor')),
  })
  let frame: Frame | undefined
  try {
    const h = await harness(page, t)
    frame = h.frame
    await act(frame, 'post', h.afterFrame, h.beforeFrame, parameters)
    await ready(frame, 1)
    let s = await snapshot(frame)
    expect(s.native.beforeSource).toEqual(h.before.ref)
    expect(s.sample).toEqual([...h.after.pixels])
    expect(s.beforeSample).toEqual([...h.before.pixels])
    expect(s.beforeDraftSample).toEqual([...h.before.pixels])
    const afterBytes = await readPlane(t.controller, s.native.after.url),
      beforeBytes = await readPlane(t.controller, s.native.before.url)
    compare([...afterBytes], cpuOracle(h.after, t.request(h.after, { parameters })).after)
    compare([...beforeBytes], cpuOracle(h.before, t.request(h.before)).before)
    // Canvas normalizes hidden RGB and quantizes premultiplied coverage. Keep
    // raw native agreement separate from the browser's decoded-bitmap contract.
    expect(await act(frame, 'pixels', false)).toEqual(
      await act(frame, 'referencePixels', [...afterBytes]),
    )
    expect(await act(frame, 'pixels', true)).toEqual(
      await act(frame, 'referencePixels', [...beforeBytes]),
    )
    const next = { ...parameters, exposureEv: -0.5 }
    await act(frame, 'post', h.afterFrame, h.beforeFrame, next)
    await ready(frame, 2)
    s = await snapshot(frame)
    expect(s.native.diagnostics.beforeCacheHit).toBe(true)
    expect(s.beforeSample).toEqual([...h.before.pixels])
    expect(h.before.acquisitions).toBe(1)
    expect(
      h.operations
        .filter((o) => o.name === 'render')
        .every(
          (o) => (o.args[0] as CpuPreviewRequest).beforeSource?.cacheId === h.before.ref.cacheId,
        ),
    ).toBe(true)
  } finally {
    if (frame) await act(frame, 'finish')
    await t.close()
  }
})

test('a mismatched native Before sample capability cannot publish a pair', async ({
  irodori: { page },
}) => {
  const t = await controllerFixture({
    nativeExecutable: await nativeCpuExecutable(resolve('vendor')),
  })
  let frame: Frame | undefined
  try {
    const h = await harness(page, t, true)
    frame = h.frame
    await act(frame, 'post', h.afterFrame, h.beforeFrame, parameters)
    await expect.poll(async () => (await snapshot(frame!)).failures.length).toBe(1)
    expect((await snapshot(frame)).failures[0]).toMatch(/capability URLs/)
    expect((await snapshot(frame)).publications).toBe(0)
  } finally {
    if (frame) await act(frame, 'finish')
    await t.close()
  }
})

test('disposal waits for a noninterruptible original-sample digest before closing either native source', async ({
  irodori: { page },
}) => {
  const t = await controllerFixture({
    nativeExecutable: await nativeCpuExecutable(resolve('vendor')),
  })
  let frame: Frame | undefined
  try {
    const h = await harness(page, t)
    frame = h.frame
    await act(frame, 'hold')
    await act(frame, 'post', h.afterFrame, h.beforeFrame, parameters)
    await expect.poll(async () => (await snapshot(frame!)).digestWaiting).toBe(true)
    await act(frame, 'close')
    expect((await snapshot(frame)).closed).toBe(false)
    expect([h.after.releases, h.before.releases]).toEqual([0, 0])
    await act(frame, 'release')
    await expect.poll(async () => (await snapshot(frame!)).closed).toBe(true)
    expect([h.after.releases, h.before.releases]).toEqual([1, 1])
    expect((await snapshot(frame)).publications).toBe(0)
    expect((await snapshot(frame)).failures).toEqual([])
  } finally {
    if (frame) await act(frame, 'finish')
    await t.close()
  }
})
