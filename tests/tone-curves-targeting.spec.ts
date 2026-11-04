import { test, expect } from './electron.fixture'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { activateButton } from './button.helpers'

test('late tone responses cannot edit another photo, channel, revision or cancelled targeting session', async ({
  irodori: { page },
}) => {
  const iframe = await page.evaluateHandle(() => {
    const node = document.createElement('iframe')
    node.src = 'about:blank'
    document.body.append(node)
    return node
  })
  const frame = await (await iframe.asElement()!.contentFrame())!
  const bundle = await build({
    stdin: {
      resolveDir: resolve('.'),
      sourcefile: 'curve-target-fixture.tsx',
      loader: 'tsx',
      contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{useToneCurves}from'./src/renderer/src/hooks/useToneCurves';
import{initialSettings}from'./src/shared/edits';
let resolves=[],requests=[],changes=[];let controller;
window.irodori={onWindowBlur:()=>()=>{},sampleCurveTone:(photoId,revision,sample)=>new Promise(resolve=>{requests.push({photoId,revision,sample});resolves.push(()=>resolve({photoId,revision,channel:sample.channel,input:.18,output:.18,visibleSamples:25,referenceWhite:1,width:10,height:10,renderingIdentity:'fixture',area:{x:2,y:2,width:5,height:5}}))})};
window.harness={requests,changes,complete:()=>resolves.splice(0).forEach(resolve=>resolve())};
function Fixture(){const [photo,setPhoto]=useState('a'),[revision,setRevision]=useState(0);const settings=initialSettings();
const edits={state:{photoId:photo,revision,settings},confirmed:true,adjustments:settings,saving:false,epoch:0,flush:async()=>{},cancel:()=>{},change:async patch=>{changes.push(patch)}};
const curves=useToneCurves(edits,photo,true,true,false);controller=curves;
return <><button onClick={()=>curves.toggleTarget()}>Toggle</button><button onClick={()=>{curves.beginTarget({x:.5,y:.5},100);curves.moveTarget(50)}}>Begin</button><button onClick={()=>curves.endTarget(50)}>Release</button><button onClick={()=>setPhoto(p=>p==='a'?'b':'a')}>Photo</button><button onClick={()=>setRevision(v=>v+1)}>Revision</button><button onClick={()=>curves.switchChannel(curves.channel==='red'?'green':'red')}>Channel</button><span data-active={curves.active} data-pending={curves.pending}>{curves.message}</span></>}
createRoot(document.body).render(<Fixture/>);
`,
    },
    bundle: true,
    jsx: 'automatic',
    format: 'iife',
    write: false,
  })
  await frame.setContent('<body></body>')
  await frame.evaluate(bundle.outputFiles[0].text)
  const records = () =>
    frame.evaluate(
      () => (window as unknown as { harness: { requests: unknown[]; changes: unknown[] } }).harness,
    )
  const complete = () =>
    frame.evaluate(() =>
      (window as unknown as { harness: { complete: () => void } }).harness.complete(),
    )
  for (const replace of ['Photo', 'Channel', 'Revision', 'Escape']) {
    if ((await frame.locator('span').getAttribute('data-active')) !== 'true')
      await activateButton(frame.getByRole('button', { name: 'Toggle', exact: true }))
    const count = (await records()).requests.length
    await activateButton(frame.getByRole('button', { name: 'Begin', exact: true }))
    await expect.poll(async () => (await records()).requests.length).toBe(count + 1)
    if (replace === 'Escape') await frame.locator('button').first().press('Escape')
    else await activateButton(frame.getByRole('button', { name: replace, exact: true }))
    await complete()
    await activateButton(frame.getByRole('button', { name: 'Release', exact: true }))
    expect((await records()).changes).toEqual([])
    await expect(frame.locator('span')).toHaveAttribute('data-pending', 'false')
  }
  await iframe.evaluate((node) => node.remove())
  await iframe.dispose()
})
