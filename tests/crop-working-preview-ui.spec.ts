import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import type { Frame, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { cropGeometry, identityCrop } from '../src/shared/crop'

/** Real React hook with synthetic replies in an isolated child frame; no photo/GPU workload. */
async function component(page: Page) {
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Crop working-frame fixture'
    document.body.append(frame)
  })
  const frame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  const geometry = (centerX: number) =>
    cropGeometry(
      { width: 12, height: 10 },
      {
        ...identityCrop,
        width: 0.5,
        height: 0.4,
        centerX,
      },
    )
  const fixtures = [geometry(0.5), geometry(0.6), undefined].map((crop, index) => {
    const width = crop?.width ?? 12,
      height = crop?.height ?? 10,
      data = new Float32Array(width * height * 4).fill(0.2 * (index + 1))
    for (let offset = 3; offset < data.length; offset += 4) data[offset] = 1
    const bytes = new Uint8Array(data.buffer)
    return {
      crop,
      width,
      height,
      bytes: [...bytes],
      hash: createHash('sha256').update(bytes).digest('hex'),
    }
  })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useWorkingPreview} from './src/renderer/src/hooks/useWorkingPreview';
import {srgbTransform,neutralAdjustments} from './src/shared/adjustments';
import {imageResourceOwners} from './src/renderer/src/preview/image-resource-owners';
const fixtures=${JSON.stringify(fixtures)},requests=[],fetches=[];
let current=0,revision=0,publish,hold=false,resume,holdFetch=false,resumeFetch;
const photoId='a'.repeat(64);
function preview(){const f=fixtures[current];return {photoId,requestId:'synthetic-full',width:f.width,height:f.height,
 crop:f.crop,format:'rgba8-srgb',byteLength:f.width*f.height*4,sha256:f.hash,renderId:'display-'+revision,
 settingsRevision:revision,url:'synthetic-full-'+revision,adjustments:neutralAdjustments,
 linear:{url:'synthetic-linear-'+current,byteLength:f.bytes.length,sha256:f.hash,transform:srgbTransform}}}
window.irodori={onLibraryEvent:()=>()=>{},reportForegroundActivity:async()=>{},releaseFullPreview:async()=>{},
 requestEditingPreview:async(id,token)=>{const frozen={...preview(),requestId:token};requests.push({current,revision});
 if(hold){hold=false;await new Promise(resolve=>{resume=resolve})}return frozen}};
window.fetch=async(url)=>{fetches.push(url);const index=Number(String(url).split('-').at(-1)),f=fixtures[index];
 if(holdFetch){holdFetch=false;await new Promise(resolve=>{resumeFetch=resolve})}
 return new Response(new Uint8Array(f.bytes),{headers:{'Content-Length':String(f.bytes.length)}})};
window.workingHarness={requests,fetches,hold(){hold=true},resume(){resume()},framing(){current=2;revision++;publish({...preview(),sourceSpace:'uncropped'})},
 resources(){return imageResourceOwners.snapshot()},holdFetch(){holdFetch=true},resumeFetch(){resumeFetch()},unmount(){root.unmount()},
 grade(){revision++;publish(preview())},move(){current=1;revision++;publish(preview())},reset(){current=2;revision++;publish(preview())}};
function Fixture(){const [value,setValue]=useState(preview());publish=setValue;const result=useWorkingPreview(value,true);
 return <output data-testid="working" data-identity={result.working?.identity??''} data-value={result.working?.data[0]??''}>
 {result.working?'ready':result.error||'loading'}</output>}
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
  await expect(frame.getByTestId('working')).toHaveText('ready')
  return frame
}
const act = (frame: Frame, action: string) =>
  frame.evaluate(
    (action) =>
      (window as unknown as { workingHarness: Record<string, () => void> }).workingHarness[
        action
      ](),
    action,
  )
const counts = (frame: Frame) =>
  frame.evaluate(() => {
    const { requests, fetches } = (
      window as unknown as {
        workingHarness: { requests: unknown[]; fetches: unknown[] }
      }
    ).workingHarness
    return { requests: requests.length, fetches: fetches.length }
  })
const resources = (frame: Frame) =>
  frame.evaluate(() =>
    (
      window as unknown as {
        workingHarness: { resources: () => { ramBytes: number; vramBytes: number } }
      }
    ).workingHarness.resources(),
  )

test('grading reuses one working fetch while a same-size crop replaces it and identity resets geometry', async ({
  irodori: { page },
}) => {
  const frame = await component(page),
    output = frame.getByTestId('working')
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.2)))
  expect(await resources(frame)).toEqual({ ramBytes: 6 * 4 * 16, vramBytes: 0 })
  await act(frame, 'grade')
  // The 100ms working preparation timer must also have had time to run.
  await frame.evaluate(() => new Promise((done) => setTimeout(done, 150)))
  expect(await counts(frame)).toEqual({ requests: 1, fetches: 1 })
  await act(frame, 'hold')
  await act(frame, 'move')
  await expect(output).toHaveText('loading')
  await expect.poll(() => counts(frame)).toEqual({ requests: 2, fetches: 1 })
  await act(frame, 'resume')
  await expect(output).toHaveText('ready')
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.4)))
  expect(await counts(frame)).toEqual({ requests: 2, fetches: 2 })
  await act(frame, 'reset')
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.6)))
  expect(await counts(frame)).toEqual({ requests: 3, fetches: 3 })
  expect(await resources(frame)).toEqual({ ramBytes: 12 * 10 * 16, vramBytes: 0 })
})

test('working transfers remain charged after unmount until the asynchronous receiver settles', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await act(frame, 'holdFetch')
  await act(frame, 'move')
  await expect.poll(() => counts(frame)).toEqual({ requests: 2, fetches: 2 })
  expect(await resources(frame)).toEqual({ ramBytes: 6 * 4 * 16 * 3, vramBytes: 0 })
  await act(frame, 'unmount')
  await expect.poll(() => resources(frame)).toEqual({ ramBytes: 6 * 4 * 16 * 2, vramBytes: 0 })
  await act(frame, 'resumeFetch')
  await expect.poll(() => resources(frame)).toEqual({ ramBytes: 0, vramBytes: 0 })
})

test('a revision-checked crop source uses its prepared pixels instead of requesting the committed crop', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await act(frame, 'framing')
  await expect(frame.getByTestId('working')).toHaveAttribute('data-value', String(Math.fround(0.6)))
  expect(await counts(frame)).toEqual({ requests: 1, fetches: 2 })
  expect(await resources(frame)).toEqual({ ramBytes: 12 * 10 * 16, vramBytes: 0 })
})

test('a late crop preparation cannot replace the working frame for newer geometry', async ({
  irodori: { page },
}) => {
  const frame = await component(page),
    output = frame.getByTestId('working')
  await act(frame, 'hold')
  await act(frame, 'move')
  await expect.poll(() => counts(frame)).toEqual({ requests: 2, fetches: 1 })
  await act(frame, 'reset')
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.6)))
  await act(frame, 'resume')
  await frame.evaluate(() => new Promise((done) => setTimeout(done, 0)))
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.6)))
  expect(await counts(frame)).toEqual({ requests: 3, fetches: 2 })
})
