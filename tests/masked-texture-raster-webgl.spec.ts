import { build } from 'esbuild'
import { test, expect } from './electron.fixture'

const moduleCode = `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {neutralAdjustments,srgbTransform,adjustmentPixelKey} from './src/shared/adjustments';
import {neutralMaskLight,neutralMaskColor,neutralMaskEdge} from './src/shared/masks';
import {identityMaskGeometry} from './src/shared/mask-geometry';
window.runPreparedRaster=async(activeLight=false,requestedDpr=1)=>{
 const originalDpr=Object.getOwnPropertyDescriptor(window,'devicePixelRatio');Object.defineProperty(window,'devicePixelRatio',{configurable:true,value:requestedDpr});
 const width=64,height=32,data=new Float32Array(width*height*4),candidate=new Float32Array(data.length),union=new Float32Array(width*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=y*width+x,value=x<32?((x+y)%2):.1,alpha=x===50&&y===12?0:1;
  data.set([value,value,value,alpha],i*4);candidate.set([value,value,value,alpha],i*4);
  if(x>=48&&y>=8&&y<24){union[i]=.25;candidate.set([.3,.3,.3,alpha],i*4)}
 }
 // Distinct adjacent negative zero and smallest-positive coverage must retain their predicates.
 union[8*width+48]=-0;union[8*width+49]=2**-149;
 const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join(''),
  sourceSha256=await hash(data.buffer),candidateHash=await hash(candidate.buffer),unionHash=await hash(union.buffer),
  candidateUrl='https://irodori.invalid/mask-stack',unionUrl='https://irodori.invalid/mask-union',
  originalFetch=window.fetch.bind(window),routes=new Map([[candidateUrl,new Uint8Array(candidate.buffer)],[unionUrl,new Uint8Array(union.buffer)]]);
 window.fetch=(url,options)=>{const bytes=routes.get(String(url));return bytes?Promise.resolve(new Response(bytes,{status:200,headers:{'content-length':String(bytes.byteLength)}})):originalFetch(url,options)};
 const parameters={...structuredClone(neutralAdjustments),maskGeometry:identityMaskGeometry(width,height),localMasks:[{
  id:'00000000-0000-0000-0000-000000000001',name:'Synthetic prepared Texture',enabled:true,inverted:false,head:null,strokes:[],edge:{...neutralMaskEdge},light:{...neutralMaskLight,exposureEv:activeLight?.5:0},color:{...neutralMaskColor},texture:25,
  gradient:{kind:'radial',center:{x:.8,y:.5},radiusX:.2,radiusY:.3,rotation:0,feather:35}}]},
  preparedMasks={key:'a'.repeat(64),context:'b'.repeat(64),consumed:'global-and-local-point-v1',parentSha256:sourceSha256,pointKey:adjustmentPixelKey(parameters),
   candidate:{url:candidateUrl,sha256:candidateHash,byteLength:candidate.byteLength,strips:[{byteLength:candidate.byteLength,sha256:candidateHash}]},
   union:{url:unionUrl,sha256:unionHash,byteLength:union.byteLength,strips:[{byteLength:union.byteLength,sha256:unionHash}]}},
  owners=[];
 const create=async prepared=>{
  const canvas=document.createElement('canvas');document.body.append(canvas);let failure='',stats,clip,analysisFailure='';
  const presenter=new PreviewPresenter(canvas,false,reason=>{failure=reason},undefined,value=>{if(value)stats=value},undefined,reason=>{if(reason)analysisFailure=reason},undefined,value=>{if(value)clip=value},reason=>{if(reason)analysisFailure=reason}),gl=canvas.getContext('webgl2');
  if(!gl)throw new Error('WebGL2 unavailable.');gl.disable(gl.DITHER);
  presenter.setWorking({width,height,data,transform:srgbTransform,sourceSha256,...(prepared?{preparedMasks}:{})});
  const extension=gl.getExtension('WEBGL_debug_renderer_info'),gpu=extension?{vendor:gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),renderer:gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)}:{vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmasked:false};
  const owner={canvas,presenter,gl,gpu,failure:()=>failure,analysis:()=>({stats,clip,analysisFailure})};if(prepared)presenter.setClippingEnabled(true,'synthetic-context');owners.push(owner);return owner;
 };
 const render=async(owner,scale,mode,prepared,viewport={width:width*scale,height:height*scale})=>{
  const before=Number(owner.canvas.dataset.presentationSerial||0);
  owner.presenter.setComparison(mode,.5);owner.presenter.draw({width,height},viewport,{scale,fit:scale<1,x:0,y:0},prepared?parameters:{...parameters,localMasks:parameters.localMasks.map(mask=>({...mask,texture:0}))});
  const until=performance.now()+10000;
  while(!owner.failure()&&(Number(owner.canvas.dataset.presentationSerial||0)<=before||owner.canvas.dataset.preparedMaskState==='loading')&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
  if(owner.failure())throw new Error(owner.failure());if(Number(owner.canvas.dataset.presentationSerial||0)<=before)throw new Error('Prepared raster draw did not complete.');
  const pixels=new Uint8Array(owner.canvas.width*owner.canvas.height*4);owner.gl.readPixels(0,0,owner.canvas.width,owner.canvas.height,owner.gl.RGBA,owner.gl.UNSIGNED_BYTE,pixels);
  if(owner.gl.getError()!==owner.gl.NO_ERROR)throw new Error('Prepared raster readback failed.');
  return{pixels:[...pixels],width:owner.canvas.width,height:owner.canvas.height,serial:Number(owner.canvas.dataset.presentationSerial),state:owner.canvas.dataset.preparedMaskState};
 };
 try{
  const legacy=await create(false),prepared=await create(true),dpr=window.devicePixelRatio||1,
    nativeScale=1,fitScale=.5/dpr,
    nativeLegacy=await render(legacy,nativeScale,'after',false),nativePrepared=await render(prepared,nativeScale,'after',true);
  const until=performance.now()+10000;while(!prepared.analysis().analysisFailure&&(!prepared.analysis().stats||!prepared.analysis().clip)&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
  const analysis=prepared.analysis();if(analysis.analysisFailure)throw new Error(analysis.analysisFailure);if(!analysis.stats||!analysis.clip)throw new Error('Prepared raster analysis did not complete.');
  const nativeBefore=await render(legacy,nativeScale,'before',false),fitLegacy=await render(legacy,fitScale,'after',false),fitPrepared=await render(prepared,fitScale,'after',true),
    before=await render(prepared,nativeScale,'before',true),split=await render(prepared,nativeScale,'split',true);
  const letterbox={width:53.7,height:34.9},letterScale=.57/dpr,
    letterLegacy=await render(legacy,letterScale,'after',false,letterbox),
    letterPrepared=await render(prepared,letterScale,'after',true,letterbox),
    letterBefore=await render(prepared,letterScale,'before',true,letterbox),
    letterSplit=await render(prepared,letterScale,'split',true,letterbox),
    letterReturned=await render(prepared,letterScale,'after',true,letterbox),
    letterLegacyBefore=await render(legacy,letterScale,'before',false,letterbox);
  await render(legacy,letterScale,'split',false,letterbox);
  const letterLegacyReturned=await render(legacy,letterScale,'after',false,letterbox);
  return{nativeLegacy,nativePrepared,nativeBefore,fitLegacy,fitPrepared,before,split,dpr,gpu:prepared.gpu,letterbox,letterScale,letterLegacy,letterPrepared,letterBefore,letterSplit,letterReturned,letterLegacyBefore,letterLegacyReturned,statistics:analysis.stats,clipping:[...analysis.clip.levels[0].data]};
 }finally{if(originalDpr)Object.defineProperty(window,'devicePixelRatio',originalDpr);window.fetch=originalFetch;for(const owner of owners){owner.presenter.dispose();await owner.presenter.whenDisposed;owner.canvas.remove()}}
};`

test('raster prepared Texture preserves unchanged native and Fit presentation with alpha-zero, Before and split views', async ({
  irodori: { page },
}) => {
  test.setTimeout(120000)
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: moduleCode },
    bundle: true,
    write: false,
    format: 'iife',
  })
  await page.evaluate(() => {
    const iframe = document.createElement('iframe')
    iframe.title = 'Prepared raster presentation verification'
    document.body.append(iframe)
  })
  const frame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!
  try {
    await frame.evaluate(bundle.outputFiles[0].text)
    for (const activeLight of [false, true])
      for (const requestedDpr of [1, 2]) {
        const r = await frame.evaluate(
          ({ activeLight, requestedDpr }) =>
            (
              window as unknown as {
                runPreparedRaster: (
                  activeLight: boolean,
                  requestedDpr: number,
                ) => Promise<{
                  nativeLegacy: { pixels: number[]; width: number; height: number }
                  nativePrepared: { pixels: number[]; width: number; height: number; state: string }
                  nativeBefore: { pixels: number[] }
                  statistics: {
                    rgb: number[][]
                    visiblePixels: number
                    shadowClipped: number
                    highlightClipped: number
                  }
                  clipping: number[]
                  fitLegacy: { pixels: number[]; width: number; height: number }
                  fitPrepared: { pixels: number[]; width: number; height: number }
                  before: { pixels: number[] }
                  split: { pixels: number[] }
                  dpr: number
                  gpu: { vendor: string; renderer: string; unmasked?: boolean }
                  letterbox: { width: number; height: number }
                  letterScale: number
                  letterLegacy: { pixels: number[]; width: number; height: number }
                  letterPrepared: { pixels: number[]; width: number; height: number }
                  letterBefore: { pixels: number[]; width: number; height: number }
                  letterSplit: { pixels: number[]; width: number; height: number }
                  letterReturned: { pixels: number[]; width: number; height: number }
                  letterLegacyBefore: { pixels: number[]; width: number; height: number }
                  letterLegacyReturned: { pixels: number[]; width: number; height: number }
                }>
              }
            ).runPreparedRaster(activeLight, requestedDpr),
          { activeLight, requestedDpr },
        )
        const scenario = `${activeLight ? 'active local Light' : 'neutral local Light'}, DPR ${r.dpr}`
        let nativeOutside = 0,
          fitOutside = 0,
          changed = 0
        for (const [legacy, actual, kind] of [
          [r.nativeLegacy, r.nativePrepared, 'native'],
          [r.fitLegacy, r.fitPrepared, 'fit'],
        ] as const) {
          expect(actual.width).toBe(legacy.width)
          expect(actual.height).toBe(legacy.height)
          const protectedActual: number[] = [],
            protectedExpected: number[] = []
          for (let y = 0; y < legacy.height; y++)
            for (let x = 0; x < legacy.width; x++) {
              const sourceX = ((x + 0.5) / legacy.width) * 64,
                sourceY = 32 - ((y + 0.5) / legacy.height) * 32,
                i = (y * legacy.width + x) * 4,
                hidden =
                  kind === 'native' && Math.floor(sourceX) === 50 && Math.floor(sourceY) === 12
              const nativeProtected =
                (kind === 'native' && !(sourceX >= 48 && sourceY >= 8 && sourceY < 24)) ||
                (kind === 'native' && Math.floor(sourceX) === 48 && Math.floor(sourceY) === 8)
              const fitProtected =
                kind === 'fit' && !(sourceX >= 48 && sourceY >= 8 && sourceY < 24)
              if (sourceX < 32 || hidden || nativeProtected || fitProtected) {
                protectedActual.push(...actual.pixels.slice(i, i + 4))
                protectedExpected.push(...legacy.pixels.slice(i, i + 4))
                if (kind === 'native') nativeOutside++
                else fitOutside++
              }
              if (sourceX > 52 && sourceY > 10 && sourceY < 22 && !hidden)
                changed += Number(actual.pixels[i] !== legacy.pixels[i])
            }
          expect(protectedActual, `${scenario}: every protected ${kind} RGBA byte`).toEqual(
            protectedExpected,
          )
        }
        test.info().annotations.push({
          type: 'webgl-adapter',
          description: JSON.stringify({ activeLight, dpr: r.dpr, ...r.gpu }),
        })
        expect(r.letterReturned.pixels).toEqual(r.letterPrepared.pixels)
        expect(r.letterLegacyReturned.pixels).toEqual(r.letterLegacy.pixels)
        expect(r.letterBefore.pixels).toEqual(r.letterLegacyBefore.pixels)
        let letterOutside = 0
        const letterProtectedActual: number[] = [],
          letterProtectedExpected: number[] = [],
          letterSplitExpected: number[] = []
        for (let y = 0; y < r.letterPrepared.height; y++)
          for (let x = 0; x < r.letterPrepared.width; x++) {
            const i = (y * r.letterPrepared.width + x) * 4,
              cssX = (x + 0.5) / r.dpr,
              cssY = r.letterbox.height - (y + 0.5) / r.dpr,
              sourceX = (cssX - r.letterbox.width * 0.5) / r.letterScale + 32,
              sourceY = (cssY - r.letterbox.height * 0.5) / r.letterScale + 16
            if (sourceX < 44 || sourceX >= 64 || sourceY < 4 || sourceY >= 28) {
              letterProtectedActual.push(...r.letterPrepared.pixels.slice(i, i + 4))
              letterProtectedExpected.push(...r.letterLegacy.pixels.slice(i, i + 4))
              letterOutside++
            }
            letterSplitExpected.push(
              ...(cssX < r.letterbox.width * 0.5 ? r.letterBefore : r.letterPrepared).pixels.slice(
                i,
                i + 4,
              ),
            )
          }
        expect(
          letterProtectedActual,
          `${scenario}: every protected fractional letterbox RGBA byte`,
        ).toEqual(letterProtectedExpected)
        expect(
          r.letterSplit.pixels,
          `${scenario}: every fractional letterbox split RGBA byte`,
        ).toEqual(letterSplitExpected)
        expect(letterOutside).toBeGreaterThan(0)
        expect(nativeOutside).toBeGreaterThan(0)
        expect(fitOutside).toBeGreaterThan(0)
        expect(changed).toBeGreaterThan(0)
        const subnormalAt =
          ((r.nativePrepared.height - 1 - 8 * r.dpr) * r.nativePrepared.width + 49 * r.dpr) * 4
        expect(r.nativePrepared.pixels[subnormalAt]).not.toBe(r.nativeLegacy.pixels[subnormalAt])
        expect(r.nativePrepared.state).toBe('ready')
        expect(r.before.pixels).toEqual(r.nativeBefore.pixels)
        const nativeSplitExpected: number[] = []
        for (let y = 0; y < r.nativePrepared.height; y++)
          for (let x = 0; x < r.nativePrepared.width; x++) {
            const i = (y * r.nativePrepared.width + x) * 4,
              expected = x < r.nativePrepared.width / 2 ? r.before.pixels : r.nativePrepared.pixels
            nativeSplitExpected.push(...expected.slice(i, i + 4))
          }
        expect(r.split.pixels, `${scenario}: every native split RGBA byte`).toEqual(
          nativeSplitExpected,
        )
        const center = (Math.floor(r.fitLegacy.height / 2) * r.fitLegacy.width + 4) * 4
        expect(r.fitLegacy.pixels[center]).toBeGreaterThan(180)
        expect(r.fitPrepared.pixels[center]).toBe(r.fitLegacy.pixels[center])
        expect(r.statistics.visiblePixels).toBe(2047)
        expect(r.statistics.rgb[0][149]).toBeGreaterThan(0)
        expect(r.statistics.shadowClipped).toBe(512)
        expect(r.statistics.highlightClipped).toBe(512)
        const clippingExpected = Array.from({ length: 32 * 64 }, (_, i) => {
          const x = i % 64,
            y = Math.floor(i / 64)
          return x < 32 ? ((x + y) % 2 ? 2 : 1) : 0
        })
        expect(r.clipping, `${scenario}: every native clipping byte`).toEqual(clippingExpected)
      }
  } finally {
    if (!frame.isDetached())
      await page
        .evaluate(() =>
          document
            .querySelector('iframe[title="Prepared raster presentation verification"]')
            ?.remove(),
        )
        .catch(() => undefined)
  }
})
