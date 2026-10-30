import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import type { Frame, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'

/** Real comparison/float hooks in an isolated child frame; no photograph or GPU workload. */
async function component(page: Page) {
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Spatial comparison hook fixture'
    document.body.append(frame)
  })
  const frame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  const fixtures = [0.2, 0.3].map((value) => {
    const data = new Float32Array(4 * 3 * 4).fill(value)
    for (let i = 3; i < data.length; i += 4) data[i] = 1
    const bytes = new Uint8Array(data.buffer)
    return { bytes: [...bytes], hash: createHash('sha256').update(bytes).digest('hex') }
  })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useComparisonPreview} from './src/renderer/src/hooks/useComparisonPreview';
import {useWorkingPreview} from './src/renderer/src/hooks/useWorkingPreview';
import {neutralAdjustments,srgbTransform} from './src/shared/adjustments';
import {PREPARED_COMPARISON_VERSION} from './src/shared/prepared-comparison';
import {imageResourceOwners} from './src/renderer/src/preview/image-resource-owners';
const fixtures=${JSON.stringify(fixtures)},requests=[],releases=[],fetches=[];
const photoId='a'.repeat(64),ids=['11111111-2222-3333-4444-555555555555','66666666-7777-8888-9999-000000000000'];
let publish,variant=0,revision=0,holdRelease=false,resumeRelease,holdReply=false,resumeReply,invalid=false,holdFetch=false,resumeFetch;
const after=()=>({photoId,requestId:'after-request',format:'rgba8-srgb',width:4,height:3,byteLength:48,
 sha256:'c'.repeat(64),renderId:'after-'+revision,url:'after-display',settingsRevision:revision,
 workingSource:{photoId,cacheId:ids[variant],workingSha256:(variant?'e':'d').repeat(64)}});
window.irodori={onLibraryEvent:()=>()=>{},reportForegroundActivity:async()=>{},
 requestEditingPreview:async()=>{throw Error('Comparison must not reload the After source')},
 releaseFullPreview:async token=>{releases.push(token);if(holdRelease){holdRelease=false;await new Promise(resolve=>{resumeRelease=resolve})}},
 requestComparisonPreview:async(source,token,rev)=>{const current=variant,f=fixtures[current],broken=invalid;invalid=false;
 requests.push({source:structuredClone(source),revision:rev,token});
 if(holdReply){holdReply=false;await new Promise(resolve=>{resumeReply=resolve})}
 return {...after(),requestId:token,width:broken===true?5:4,settingsRevision:rev,workingSource:{photoId,cacheId:'aaaaaaaa-bbbb-cccc-dddd-00000000000'+current,workingSha256:f.hash},
 comparisonOf:{version:PREPARED_COMPARISON_VERSION,after:structuredClone(source),settingsRevision:rev},adjustments:neutralAdjustments,
 linear:{url:'before-'+current,byteLength:f.bytes.length,sha256:f.hash,transform:srgbTransform,...(broken==='domain'?{hdr:{}}:{})}}}};
window.fetch=async url=>{fetches.push(String(url));const f=fixtures[Number(String(url).split('-').at(-1))];
 if(holdFetch){holdFetch=false;await new Promise(resolve=>{resumeFetch=resolve})}
 return new Response(new Uint8Array(f.bytes),{headers:{'Content-Length':String(f.bytes.length)}})};
window.comparisonHarness={requests,releases,fetches,enable(){publish(true)},disable(){publish(false)},
 change(){variant=1;revision++;publish(true,true)},holdRelease(){holdRelease=true},resumeRelease(){resumeRelease()},
 holdReply(){holdReply=true},resumeReply(){resumeReply()},holdFetch(){holdFetch=true},resumeFetch(){resumeFetch()},
 invalid(){invalid=true},invalidDomain(){invalid='domain'},retry(){window.retry()},resources(){return imageResourceOwners.snapshot()},unmount(){root.unmount()}};
function Before({preview}){const result=useWorkingPreview(preview,true);return <output data-testid="working" data-value={result.working?.data[0]??''}>
 {result.working?'ready':result.error||'loading'}</output>}
function Fixture(){const [enabled,setEnabled]=useState(false),[value,setValue]=useState(after());
 publish=(next,changed=false)=>{setEnabled(next);if(changed)setValue(after())};
 const result=useComparisonPreview(value,enabled);window.retry=result.retry;
 return <><output data-testid="comparison">{result.error||(!enabled?'off':result.loading?'loading':result.preview?'ready':'empty')}</output>
 {enabled&&<Before preview={result.preview}/>}</>}
const root=createRoot(document.getElementById('fixture'));root.render(<Fixture/>);
`,
    },
    bundle: true,
    jsx: 'automatic',
    format: 'iife',
    write: false,
  })
  await frame.setContent('<div id="fixture"></div>')
  await frame.evaluate(bundle.outputFiles[0].text)
  await expect(frame.getByTestId('comparison')).toHaveText('off')
  return frame
}
const act = (frame: Frame, name: string) =>
  frame.evaluate(
    (name) =>
      (window as unknown as { comparisonHarness: Record<string, () => void> }).comparisonHarness[
        name
      ](),
    name,
  )
const state = (frame: Frame) =>
  frame.evaluate(() => {
    const h = (
      window as unknown as {
        comparisonHarness: {
          requests: unknown[]
          releases: unknown[]
          fetches: string[]
          resources(): { ramBytes: number; vramBytes: number }
        }
      }
    ).comparisonHarness
    return {
      requests: h.requests.length,
      releases: h.releases.length,
      fetches: h.fetches,
      resources: h.resources(),
    }
  })

test('comparison hooks load the unfiltered capability directly and drain its owner before replacement', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  expect((await state(frame)).requests).toBe(0)
  await act(frame, 'enable')
  await expect(frame.getByTestId('working')).toHaveText('ready')
  await expect(frame.getByTestId('working')).toHaveAttribute('data-value', String(Math.fround(0.2)))
  expect(await state(frame)).toMatchObject({
    requests: 1,
    fetches: ['before-0'],
    resources: { ramBytes: 192, vramBytes: 0 },
  })
  await act(frame, 'holdRelease')
  await act(frame, 'disable')
  await expect(frame.getByTestId('comparison')).toHaveText('off')
  expect((await state(frame)).resources.ramBytes).toBe(0)
  await act(frame, 'enable')
  await expect(frame.getByTestId('comparison')).toHaveText('loading')
  expect((await state(frame)).requests).toBe(1)
  await act(frame, 'resumeRelease')
  await expect(frame.getByTestId('working')).toHaveText('ready')
  expect((await state(frame)).requests).toBe(2)
  await act(frame, 'unmount')
  await expect.poll(async () => (await state(frame)).resources.ramBytes).toBe(0)
})

test('stale or malformed comparison replies cannot publish and retry releases the failed owner', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await act(frame, 'invalid')
  await act(frame, 'enable')
  await expect(frame.getByTestId('comparison')).toContainText('does not match')
  expect(await state(frame)).toMatchObject({ requests: 1, releases: 1, fetches: [] })
  await act(frame, 'invalidDomain')
  await act(frame, 'retry')
  await expect.poll(async () => (await state(frame)).releases).toBe(2)
  await expect(frame.getByTestId('comparison')).toContainText('does not match')
  expect((await state(frame)).fetches).toEqual([])
  await act(frame, 'holdReply')
  await act(frame, 'retry')
  await expect.poll(async () => (await state(frame)).requests).toBe(3)
  await act(frame, 'change')
  await expect(frame.getByTestId('comparison')).toHaveText('loading')
  expect((await state(frame)).requests).toBe(3)
  await act(frame, 'resumeReply')
  await expect(frame.getByTestId('working')).toHaveText('ready')
  await expect(frame.getByTestId('working')).toHaveAttribute('data-value', String(Math.fround(0.3)))
  expect(await state(frame)).toMatchObject({ requests: 4, fetches: ['before-1'] })
  await act(frame, 'unmount')
  await expect.poll(async () => (await state(frame)).resources.ramBytes).toBe(0)
})

test('a changed Before float source cannot display the prior matching-geometry pixels while its replacement fetch is pending', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await act(frame, 'enable')
  await expect(frame.getByTestId('working')).toHaveText('ready')
  await act(frame, 'holdFetch')
  await act(frame, 'change')
  await expect.poll(async () => (await state(frame)).fetches.length).toBe(2)
  await expect(frame.getByTestId('working')).toHaveText('loading')
  await expect(frame.getByTestId('working')).toHaveAttribute('data-value', '')
  await act(frame, 'resumeFetch')
  await expect(frame.getByTestId('working')).toHaveText('ready')
  await expect(frame.getByTestId('working')).toHaveAttribute('data-value', String(Math.fround(0.3)))
  expect((await state(frame)).resources).toEqual({ ramBytes: 192, vramBytes: 0 })
  await act(frame, 'unmount')
  await expect.poll(async () => (await state(frame)).resources.ramBytes).toBe(0)
})
