import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import type { Frame, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { cropGeometry, identityCrop } from '../src/shared/crop'

/** Tiny synthetic RGBA/F32 replies exercise the real full/working hooks without decoding photos. */
async function component(page: Page) {
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Crop source hook fixture'
    document.body.append(frame)
  })
  const frame = page.frames().find((value) => value.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  const crop = cropGeometry(
      { width: 12, height: 10 },
      { ...identityCrop, width: 0.5, height: 0.4 },
    ),
    fixtures = [crop, null].map((geometry, index) => {
      const width = geometry?.width ?? 12,
        height = geometry?.height ?? 10,
        rgba = new Uint8Array(width * height * 4).fill(71 + index * 41),
        linear = new Float32Array(width * height * 4).fill(index ? 0.6 : 0.2)
      for (let i = 3; i < rgba.length; i += 4) {
        rgba[i] = 255
        linear[i] = 1
      }
      const bytes = new Uint8Array(linear.buffer),
        hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
      return {
        width,
        height,
        geometry,
        rgba: [...rgba],
        bytes: [...bytes],
        hash: hash(rgba),
        linearHash: hash(bytes),
      }
    })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useFullPreview} from './src/renderer/src/hooks/useFullPreview';
import {useWorkingPreview} from './src/renderer/src/hooks/useWorkingPreview';
import {SDR_TARGET} from './src/shared/hdr';
import {srgbTransform} from './src/shared/adjustments';
const fixtures=${JSON.stringify(fixtures)},photoId='a'.repeat(64),listeners=new Set(),requests=[],releases=[],fetches=[];
let setCrop,revision=0,hold=false,resume;
function preview(index,token){const f=fixtures[index];return {photoId,requestId:token,settingsRevision:revision,
 sourceSpace:index?'uncropped':undefined,crop:f.geometry??undefined,url:'synthetic-rgba-'+index,width:f.width,height:f.height,
 format:'rgba8-srgb',byteLength:f.rgba.length,sha256:f.hash,renderId:'display-'+index+'-'+revision,
 linear:{url:'synthetic-f32-'+index,byteLength:f.bytes.length,sha256:f.linearHash,transform:srgbTransform}}}
window.irodori={reportForegroundActivity:async()=>{},getDisplayState:async()=>SDR_TARGET,
 onLibraryEvent:(listener)=>{listeners.add(listener);return()=>listeners.delete(listener)},onHdrFirstSurface:()=>()=>{},releaseHdrFirstSurface:async()=>{},
 requestHdrPreview:async()=>{requests.push({kind:'hdr'});return null},requestCachedFullPreview:async()=>null,
 requestFullPreview:async(id,token)=>{requests.push({kind:'confirmed',token});return preview(0,token)},
 requestEditingPreview:async(id,token)=>{requests.push({kind:'editing',token});return preview(0,token)},
 requestCropPreview:async(id,token,expectedRevision)=>{requests.push({kind:'crop',token,expectedRevision});const frozen=preview(1,token);
  if(hold){hold=false;await new Promise(resolve=>{resume=resolve})}return frozen},
 releaseFullPreview:async(token)=>{releases.push(token)}};
window.fetch=async(url)=>{fetches.push(String(url));const index=Number(String(url).split('-').at(-1)),f=fixtures[index],bytes=String(url).includes('f32')?f.bytes:f.rgba;
 return new Response(new Uint8Array(bytes),{headers:{'Content-Length':String(bytes.length)}})};
window.sourceHarness={snapshot(){return structuredClone({requests,releases,fetches})},open(){setCrop(0)},close(){setCrop(undefined)},hold(){hold=true},resume(){resume()},
 grade(){revision++;listeners.forEach(listener=>listener({editsChanged:{photoId,revision}}))}};
function Fixture(){const [cropRevision,publish]=useState();setCrop=publish;
 const full=useFullPreview(photoId,true,'sdr',undefined,true,cropRevision),live=useWorkingPreview(full.preview,!!full.pixels);
 return <output data-testid="source" data-mode={full.preview?.sourceSpace??'confirmed'} data-width={full.preview?.width??''} data-value={live.working?.data[0]??''}>
 {full.error??(full.preview&&live.working?'ready':'loading')}</output>}
createRoot(document.getElementById('fixture')).render(<Fixture/>);
`,
    },
    bundle: true,
    jsx: 'automatic',
    format: 'iife',
    write: false,
  })
  await frame.setContent('<div id="fixture"></div>')
  await frame.evaluate(bundle.outputFiles[0].text)
  await expect(frame.getByTestId('source')).toHaveText('ready')
  return frame
}
type Snapshot = {
  requests: { kind: string; token?: string; expectedRevision?: number }[]
  releases: string[]
  fetches: string[]
}
const snapshot = (frame: Frame): Promise<Snapshot> =>
  frame.evaluate(() =>
    (window as unknown as { sourceHarness: { snapshot: () => Snapshot } }).sourceHarness.snapshot(),
  )
const act = (frame: Frame, name: string) =>
  frame.evaluate(
    (name) =>
      (window as unknown as { sourceHarness: Record<string, () => void> }).sourceHarness[name](),
    name,
  )

test('framing revision zero switches to uncropped data and restores the committed source without fallback requests', async ({
  irodori: { page },
}) => {
  const frame = await component(page),
    output = frame.getByTestId('source')
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.2)))
  await act(frame, 'open')
  await expect(output).toHaveAttribute('data-mode', 'uncropped')
  await expect(output).toHaveText('ready')
  await expect(output).toHaveAttribute('data-width', '12')
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.6)))
  expect(
    (await snapshot(frame)).requests.filter((value) => value.kind === 'confirmed'),
  ).toHaveLength(1)
  expect((await snapshot(frame)).requests.filter((value) => value.kind === 'crop')).toEqual([
    expect.objectContaining({ expectedRevision: 0 }),
  ])
  await act(frame, 'close')
  await expect(output).toHaveAttribute('data-mode', 'confirmed')
  await expect(output).toHaveText('ready')
  await expect(output).toHaveAttribute('data-value', String(Math.fround(0.2)))
  const before = await snapshot(frame)
  await act(frame, 'grade')
  await expect
    .poll(
      async () =>
        (await snapshot(frame)).requests.filter((value) => value.kind === 'confirmed').length,
    )
    .toBe(3)
  await expect(output).toHaveText('ready')
  expect((await snapshot(frame)).requests.filter((value) => value.kind === 'editing').length).toBe(
    before.requests.filter((value) => value.kind === 'editing').length,
  )
  expect((await snapshot(frame)).fetches.filter((value) => value.includes('f32'))).toEqual(
    before.fetches.filter((value) => value.includes('f32')),
  )
})

test('closing framing hides its old geometry immediately and rejects a late source reply', async ({
  irodori: { page },
}) => {
  const frame = await component(page),
    output = frame.getByTestId('source')
  await act(frame, 'hold')
  await act(frame, 'open')
  await expect
    .poll(
      async () => (await snapshot(frame)).requests.filter((value) => value.kind === 'crop').length,
    )
    .toBe(1)
  await expect(output).toHaveText('loading')
  await expect(output).toHaveAttribute('data-width', '')
  await act(frame, 'close')
  await expect(output).toHaveText('ready')
  await act(frame, 'resume')
  await expect(output).toHaveAttribute('data-mode', 'confirmed')
  await expect(output).toHaveAttribute('data-width', '6')
  const result = await snapshot(frame),
    token = result.requests.find((value) => value.kind === 'crop')!.token!
  expect(result.releases).toContain(token)
  expect(result.fetches).not.toContain('synthetic-rgba-1')
})
