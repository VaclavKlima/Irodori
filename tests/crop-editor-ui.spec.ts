import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import type { Frame, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'

/** Isolated real controller/controls/overlay; synthetic context, no photograph or GPU workload. */
async function component(page: Page) {
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Isolated crop editor'
    frame.style.cssText =
      'position:fixed;inset:0;width:1040px;height:690px;border:0;z-index:2147483647;background:#222'
    document.body.append(frame)
  })
  const frame = page.frames().find((value) => value.parentFrame() === page.mainFrame())!
  expect(await frame.evaluate(() => 'irodori' in window)).toBe(false)
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useCrop} from './src/renderer/src/hooks/useCrop';
import {CropControls} from './src/renderer/src/components/CropControls';
import {CropOverlay} from './src/renderer/src/components/CropOverlay';
import {initialSettings} from './src/shared/edits';
import {cropGeometry} from './src/shared/crop';
let server={photoId:'a'.repeat(64),revision:0,settings:initialSettings(),canUndo:false,canRedo:false};
const source={width:400,height:300},listeners=new Set(),requests=[],writes=[],flushes=[];
let refresh,readyChange,hold=false,resume,queueColor=false,rendered=null;
window.irodori={onLibraryEvent:(listener)=>{listeners.add(listener);return()=>listeners.delete(listener)},getEdits:async()=>structuredClone(server),
 getCropContext:async(photoId,revision)=>{requests.push({photoId,revision});const frozen={photoId,revision,source,settings:structuredClone(server.settings.crop),
  geometry:cropGeometry(source,server.settings.crop),renderingIdentity:'synthetic-native'};
  if(hold){hold=false;await new Promise(resolve=>{resume=resolve})}return frozen}};
function external(){server={...server,revision:server.revision+1,settings:{...server.settings,exposureEv:1}};
 listeners.forEach(listener=>listener({editsChanged:{photoId:server.photoId,revision:server.revision}}));refresh(server)};
const commit=async(photoId,crop,revision)=>{if(photoId!==server.photoId||revision!==server.revision)throw Error('Edit conflict');
 writes.push(structuredClone({photoId,crop,revision}));server={...server,revision:revision+1,settings:{...server.settings,crop}};
 listeners.forEach(listener=>listener({editsChanged:{photoId,revision:server.revision}}));refresh(server);return structuredClone(server)};
window.cropHarness={snapshot(){return structuredClone({requests,writes,flushes,draft:rendered?.draft,epoch:rendered?.epoch,server})},
 hold(){hold=true},resume(){resume()},queueColor(){queueColor=true},external,
 photo(){server={...server,photoId:'b'.repeat(64),revision:0,settings:initialSettings()};refresh(server)},blur(){window.dispatchEvent(new Event('blur'))}};
function Fixture(){const [state,setState]=useState(server),[ready,setReady]=useState(true);refresh=setState;readyChange=setReady;
 const edits={state,confirmed:true,flush:async()=>{flushes.push(server.revision);setReady(false);await new Promise(resolve=>setTimeout(resolve,0));
  if(queueColor){queueColor=false;external()}setReady(true)}};
 const crop=useCrop(edits,state.photoId,true,ready,commit);rendered=crop;
 return <><div style={{position:'relative',width:650,height:500}} data-testid="crop-stage">
 <CropOverlay crop={crop} viewport={{width:650,height:500}} view={{fit:true,scale:1,x:0,y:0}}/>
 </div><aside style={{width:310,height:670,overflow:'auto',padding:10}}><CropControls crop={crop}/></aside></>}
createRoot(document.getElementById('fixture')).render(<Fixture/>);
`,
    },
    bundle: true,
    jsx: 'automatic',
    format: 'iife',
    outfile: 'crop-fixture.js',
    write: false,
  })
  await frame.setContent(`<style>${await readFile('src/renderer/src/global.css', 'utf8')}\n${bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text}
body{min-width:0}#fixture{display:flex;gap:10px}</style><div id="fixture"></div>`)
  await frame.evaluate(bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text)
  await expect(
    frame.getByRole('button', { name: 'Crop and straighten', exact: true }),
  ).toBeEnabled()
  return frame
}
type Snapshot = {
  requests: { photoId: string; revision: number }[]
  writes: { photoId: string; crop: import('../src/shared/crop').CropSettings; revision: number }[]
  flushes: number[]
  draft: import('../src/shared/crop').CropSettings | null
  epoch: number
  server: {
    photoId: string
    revision: number
    settings: import('../src/shared/edits').EditSettings
  }
}
const snapshot = (frame: Frame): Promise<Snapshot> =>
  frame.evaluate(() =>
    (window as unknown as { cropHarness: { snapshot: () => Snapshot } }).cropHarness.snapshot(),
  )
const act = (frame: Frame, action: string) =>
  frame.evaluate(
    (name) =>
      (window as unknown as { cropHarness: Record<string, () => void> }).cropHarness[name](),
    action,
  )
const open = (frame: Frame) =>
  activateButton(frame.getByRole('button', { name: 'Crop and straighten', exact: true }))
async function number(frame: Frame, label: string, value: string) {
  const input = frame.getByRole('spinbutton', { name: label + ' value', exact: true })
  await input.fill(value)
  await input.press('Enter')
}

test('crop drafts flush earlier edits and combine sizing, aspect and rotation into one Apply', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await act(frame, 'queueColor')
  await open(frame)
  const apply = frame.getByRole('button', { name: 'Apply crop', exact: true })
  await expect(apply).toBeEnabled()
  expect((await snapshot(frame)).requests).toEqual([{ photoId: 'a'.repeat(64), revision: 1 }])
  await number(frame, 'Crop width', '180')
  await number(frame, 'Crop height', '90')
  await number(frame, 'Straighten', '5.25')
  await frame.getByRole('combobox', { name: 'Aspect ratio', exact: true }).selectOption('custom')
  await number(frame, 'Custom ratio', '1.25')
  await activateButton(frame.getByRole('button', { name: 'Rotate crop clockwise', exact: true }))
  await expect(
    frame.getByRole('spinbutton', { name: 'Custom ratio value', exact: true }),
  ).toHaveValue('0.800000')
  expect((await snapshot(frame)).writes).toEqual([])
  await activateButton(apply)
  await expect(frame.getByTestId('crop-overlay')).toHaveCount(0)
  const result = await snapshot(frame)
  expect(result.writes).toEqual([
    {
      photoId: 'a'.repeat(64),
      revision: 1,
      crop: expect.objectContaining({ quarterTurns: 1, angle: 5.25, aspectRatio: 0.8 }),
    },
  ])
  expect(result.server.revision).toBe(2)
  expect(result.server.settings.exposureEv).toBe(1)
})

test('crop handles have native-pixel keyboard equivalents and Escape discards the draft', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await open(frame)
  const corner = frame.getByRole('button', { name: 'Bottom right crop corner', exact: true })
  await expect(corner).toBeVisible()
  await corner.focus()
  await corner.press('ArrowLeft')
  await corner.press('Shift+ArrowUp')
  await expect(
    frame.getByRole('spinbutton', { name: 'Crop width value', exact: true }),
  ).toHaveValue('399.00')
  await expect(
    frame.getByRole('spinbutton', { name: 'Crop height value', exact: true }),
  ).toHaveValue('290.00')
  const move = frame.getByRole('button', { name: 'Move crop frame', exact: true })
  await move.focus()
  await move.press('ArrowRight')
  expect((await snapshot(frame)).draft!.centerX).toBeCloseTo(200.5 / 400, 12)
  await move.press('Escape')
  await expect(frame.getByTestId('crop-overlay')).toHaveCount(0)
  expect((await snapshot(frame)).writes).toEqual([])
  expect((await snapshot(frame)).server.revision).toBe(0)
})

test('pointer resizing commits only the draft and lost capture restores that gesture', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await open(frame)
  const corner = frame.getByRole('button', { name: 'Bottom right crop corner', exact: true })
  await expect(corner).toBeVisible()
  try {
    let box = (await corner.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 20, { steps: 3 })
    await page.mouse.up()
    await expect(
      frame.getByRole('spinbutton', { name: 'Crop width value', exact: true }),
    ).toHaveValue('350.00')
    await expect(
      frame.getByRole('spinbutton', { name: 'Crop height value', exact: true }),
    ).toHaveValue('280.00')
    box = (await corner.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2)
    await expect(
      frame.getByRole('spinbutton', { name: 'Crop width value', exact: true }),
    ).toHaveValue('300.00')
    await corner.evaluate((element) => element.releasePointerCapture(1))
    await page.mouse.move(box.x + box.width / 2 - 51, box.y + box.height / 2)
    await expect(
      frame.getByRole('spinbutton', { name: 'Crop width value', exact: true }),
    ).toHaveValue('350.00')
    expect((await snapshot(frame)).writes).toEqual([])
  } finally {
    await page.mouse.up()
  }
})

test('external revisions block Apply and focus loss cancels without changing the photo', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await open(frame)
  await number(frame, 'Straighten', '12.34')
  await act(frame, 'external')
  await expect(frame.getByRole('button', { name: 'Apply crop', exact: true })).toBeDisabled()
  await expect(frame.getByRole('alert')).toContainText('Edits changed')
  await act(frame, 'blur')
  await expect(frame.getByTestId('crop-overlay')).toHaveCount(0)
  expect((await snapshot(frame)).writes).toEqual([])
  expect((await snapshot(frame)).server.settings.crop.angle).toBe(0)
})

test('a late native context cannot open a crop draft on a different photo', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  await act(frame, 'hold')
  await open(frame)
  await expect.poll(async () => (await snapshot(frame)).requests.length).toBe(1)
  await act(frame, 'photo')
  await act(frame, 'resume')
  await expect(
    frame.getByRole('button', { name: 'Crop and straighten', exact: true }),
  ).toBeEnabled()
  await expect(frame.getByTestId('crop-overlay')).toHaveCount(0)
  await open(frame)
  await expect(frame.getByTestId('crop-overlay')).toBeVisible()
  expect((await snapshot(frame)).requests.at(-1)).toEqual({ photoId: 'b'.repeat(64), revision: 0 })
  await activateButton(frame.getByRole('button', { name: 'Cancel crop', exact: true }))
  expect((await snapshot(frame)).writes).toEqual([])
})
