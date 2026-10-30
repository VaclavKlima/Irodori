import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import type { Frame, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'

/** Component fixture only: real React controls/hook, synthetic typed replies in a child frame.
 * The shared hidden launcher still verifies profile isolation. Real source/history work has
 * separate service coverage; this fixture neither imports photos nor claims RAW acceptance.
 */
async function component(page: Page) {
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Isolated picker component'
    frame.style.cssText =
      'position:fixed;top:0;right:0;width:310px;height:690px;border:0;z-index:2147483647;background:#222'
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
import {WhiteBalancePicker} from './src/renderer/src/components/WhiteBalancePicker';
import {useWhiteBalancePicker} from './src/renderer/src/hooks/useWhiteBalancePicker';
import {initialSettings} from './src/shared/edits';
import {profile} from './tests/white-balance-picker.helpers';
let server={photoId:'a'.repeat(64),revision:0,settings:initialSettings(),whiteBalanceProfile:profile};
const requests=[],writes=[];
let resolveSample, rejectSample;
window.pickerHarness={requests,writes,complete(valid=true){resolveSample({version:'neutral-camera-roi-v1',photoId:requests.at(-1).photoId,revision:requests.at(-1).revision,
 renderingIdentity:'synthetic',sample:requests.at(-1).sample,area:{x:10,y:10,width:15,height:15,centerX:17,centerY:17},provider:profile.identity,total:225,accepted:225,rejected:{dark:0,clipped:0,invalid:0},scatter:0,residual:0.001,
 ...(valid?{status:'valid',settings:{mode:'custom',kelvin:6500,tint:12}}:{status:'invalid',reason:'dark'})})},fail(){rejectSample(new Error('Isolated sample read failed.'))}};
function Fixture(){
 const [state,setState]=useState(server),[ready,setReady]=useState(true);
 window.irodori={getEdits:async()=>server,
  proposeWhiteBalance:async(photoId,revision,sample)=>{requests.push({photoId,revision,sample});return new Promise((resolve,reject)=>{resolveSample=resolve;rejectSample=reject})},
  updateEdits:async(photoId,patch,revision)=>{if(photoId!==server.photoId||revision!==server.revision)throw Error('Edit conflict');writes.push({photoId,patch,revision});server={...server,revision:revision+1,settings:{...server.settings,...patch}};setState(server);return server}};
 const edits={state,confirmed:true,flush:async()=>{setReady(false);await new Promise(resolve=>setTimeout(resolve,0));setReady(true)}};
 const picker=useWhiteBalancePicker(edits,state.photoId,true,ready);
 return <><WhiteBalancePicker picker={picker}/><button onClick={()=>{server={...server,revision:server.revision+1};setState(server)}}>External edit</button>
 <button onClick={()=>{server={...server,photoId:'b'.repeat(64),revision:0};setState(server)}}>Change photo</button></>
}
createRoot(document.getElementById('fixture')).render(<Fixture/>);
`,
    },
    bundle: true,
    jsx: 'automatic',
    format: 'iife',
    outfile: 'picker-fixture.js',
    write: false,
  })
  const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text
  await frame.setContent(
    `<style>${await readFile('src/renderer/src/global.css', 'utf8')}\n${css}\nbody{min-width:0}</style><div id="fixture"></div>`,
  )
  await frame.evaluate(bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text)
  await expect(
    frame.getByRole('button', { name: 'Neutral white balance', exact: true }),
  ).toBeEnabled()
  return frame
}
const evidence = (frame: Frame) =>
  frame.evaluate(
    () =>
      (window as unknown as { pickerHarness: { requests: unknown[]; writes: unknown[] } })
        .pickerHarness,
  )
const complete = (frame: Frame, valid = true) =>
  frame.evaluate(
    (valid) =>
      (
        window as unknown as { pickerHarness: { complete: (valid: boolean) => void } }
      ).pickerHarness.complete(valid),
    valid,
  )

async function requestSample(frame: Frame) {
  const before = (await evidence(frame)).requests.length
  await frame.getByRole('button', { name: 'Sample neutral area', exact: true }).click()
  // Flushing an earlier gesture precedes the proposal request; pending UI alone
  // does not prove the asynchronous request has reached the worker boundary.
  await expect.poll(async () => (await evidence(frame)).requests.length).toBe(before + 1)
}

test('picker survives a pending-edit flush, samples typed coordinates and applies one combined white balance', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  const toggle = frame.getByRole('button', { name: 'Neutral white balance', exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  for (const [label, value] of [
    ['Sample X', '25'],
    ['Sample Y', '62.5'],
  ]) {
    const field = frame.getByRole('spinbutton', { name: label + ' value' })
    await field.fill(value)
    if (label === 'Sample X') await field.press('Enter')
  }
  await frame.getByRole('button', { name: 'Sample size 31 pixels', exact: true }).click()
  const apply = frame.getByRole('button', { name: 'Apply white balance', exact: true })
  await expect(apply).toBeDisabled()
  await requestSample(frame)
  await expect(
    frame.getByRole('button', { name: 'Sample neutral area', exact: true }),
  ).toBeDisabled()
  expect((await evidence(frame)).requests).toEqual([
    { photoId: 'a'.repeat(64), revision: 0, sample: { x: 0.25, y: 0.625, diameter: 31 } },
  ])
  expect((await evidence(frame)).writes).toEqual([])
  await complete(frame)
  await expect(apply).toBeEnabled()
  await apply.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect((await evidence(frame)).writes).toEqual([
    {
      photoId: 'a'.repeat(64),
      revision: 0,
      patch: { whiteBalance: { mode: 'custom', kelvin: 6500, tint: 12 } },
    },
  ])
})

test('cancel, external revision and photo replacement discard late proposals without writes', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  const toggle = frame.getByRole('button', { name: 'Neutral white balance', exact: true })
  await toggle.click()
  const coordinate = frame.getByRole('spinbutton', { name: 'Sample X value' })
  await coordinate.fill('120')
  await coordinate.press('Escape')
  await expect(coordinate).toHaveValue('50.00')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await requestSample(frame)
  await frame.getByRole('button', { name: 'Cancel picker', exact: true }).click()
  await complete(frame)
  await expect(toggle).toBeEnabled()
  await expect(frame.getByRole('button', { name: 'Apply white balance', exact: true })).toHaveCount(
    0,
  )
  await toggle.click()
  await requestSample(frame)
  await complete(frame)
  const apply = frame.getByRole('button', { name: 'Apply white balance', exact: true })
  await expect(apply).toBeEnabled()
  await frame.getByRole('button', { name: 'External edit', exact: true }).click()
  await expect(apply).toBeDisabled()
  await expect(frame.getByRole('status')).toContainText('Edits changed')
  await requestSample(frame)
  await frame.getByRole('button', { name: 'Change photo', exact: true }).click()
  await complete(frame)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect((await evidence(frame)).writes).toEqual([])
})

test('invalid samples, read failures, Escape and loss of focus leave confirmed edits alone', async ({
  irodori: { page },
}) => {
  const frame = await component(page)
  const toggle = frame.getByRole('button', { name: 'Neutral white balance', exact: true })
  await toggle.click()
  await requestSample(frame)
  await complete(frame, false)
  await expect(frame.getByRole('status')).toContainText('too dark')
  await expect(
    frame.getByRole('button', { name: 'Apply white balance', exact: true }),
  ).toBeDisabled()
  await requestSample(frame)
  await frame.evaluate(() =>
    (window as unknown as { pickerHarness: { fail: () => void } }).pickerHarness.fail(),
  )
  await expect(frame.getByRole('status')).toContainText('read failed')
  await frame.getByRole('button', { name: 'Sample neutral area', exact: true }).press('Escape')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await frame.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect((await evidence(frame)).writes).toEqual([])
})
