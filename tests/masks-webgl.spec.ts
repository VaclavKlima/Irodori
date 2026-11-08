import { test, expect } from './electron.fixture'
import { localMasksGlsl, packLocalMasks, MASK_GPU_TEXTURE_WIDTH } from '../src/shared/masks-gpu'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { neutralMaskLight, type ResolvedMask } from '../src/shared/masks'
import { brush, referenceCoverage, referenceStack } from './helpers/mask-reference'
import { build } from 'esbuild'

test('GLSL brush coverage and ordered local Light match independent native-grid references', async ({
  irodori,
}) => {
  const masks: ResolvedMask[] = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Upper',
        enabled: true,
        inverted: true,
        head: null,
        light: {
          exposureEv: -0.27,
          contrast: 32,
          highlights: -30,
          shadows: 25,
          whites: 21,
          blacks: -12,
        },
        strokes: [
          brush('add', 0.35, 0.8, [
            [0.15, 0.2],
            [0.8, 0.75],
          ]),
          brush('subtract', 0.18, 0.5, [[0.5, 0.5]]),
        ],
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Lower',
        enabled: true,
        inverted: false,
        head: null,
        light: { ...neutralMaskLight, exposureEv: 0.5, contrast: -40 },
        strokes: [brush('add', 0.5, 0, [[0.5, 0.5]])],
      },
    ],
    packed = packLocalMasks(
      { localMasks: masks, maskGeometry: identityMaskGeometry(1000, 800) },
      { width: 1000, height: 800 },
    )
  const actual = await irodori.page.evaluate(
    ({ shader, data, textureWidth }) => {
      const canvas = new OffscreenCanvas(10, 8),
        gl = canvas.getContext('webgl2', { antialias: false })
      if (!gl || !gl.getExtension('EXT_color_buffer_float'))
        throw new Error('Float WebGL is unavailable.')
      const program = gl.createProgram()!,
        textures: WebGLTexture[] = [],
        shaders: WebGLShader[] = [],
        framebuffer = gl.createFramebuffer()!
      try {
        for (const [kind, code] of [
          [
            gl.VERTEX_SHADER,
            '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}',
          ],
          [
            gl.FRAGMENT_SHADER,
            `#version 300 es\nprecision highp float;precision highp int;\n${shader}
out vec4 result;void main(){vec2 p=gl_FragCoord.xy*100.;result=vec4(applyLocalMasks(vec3(.06,.18,.38),p,1.),maskCoverage(0,maskCanonical(p)));}`,
          ],
        ] as const) {
          const s = gl.createShader(kind)!
          shaders.push(s)
          gl.shaderSource(s, code)
          gl.compileShader(s)
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(s) || 'Mask compile failed.')
          gl.attachShader(program, s)
        }
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(program) || 'Mask link failed.')
        gl.useProgram(program)
        gl.disable(gl.DITHER)
        gl.disable(gl.BLEND)
        const createTexture = () => {
          const t = gl.createTexture()!
          textures.push(t)
          gl.bindTexture(gl.TEXTURE_2D, t)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
          return t
        }
        const output = createTexture()
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 10, 8, 0, gl.RGBA, gl.FLOAT, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0)
        createTexture()
        const height = Math.ceil(data.length / 4 / textureWidth),
          values = new Float32Array(height * textureWidth * 4)
        values.set(data)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32F,
          textureWidth,
          height,
          0,
          gl.RGBA,
          gl.FLOAT,
          values,
        )
        gl.uniform1i(gl.getUniformLocation(program, 'localMaskData'), 0)
        gl.viewport(0, 0, 10, 8)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        const result = new Float32Array(10 * 8 * 4)
        gl.readPixels(0, 0, 10, 8, gl.RGBA, gl.FLOAT, result)
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Mask GPU readback failed.')
        return [...result]
      } finally {
        textures.forEach((t) => gl.deleteTexture(t))
        shaders.forEach((s) => gl.deleteShader(s))
        gl.deleteFramebuffer(framebuffer)
        gl.deleteProgram(program)
      }
    },
    { shader: localMasksGlsl, data: [...packed], textureWidth: MASK_GPU_TEXTURE_WIDTH },
  )
  for (let i = 0; i < 80; i++) {
    const point = { x: ((i % 10) + 0.5) / 10, y: (Math.floor(i / 10) + 0.5) / 8 },
      expected = [
        ...referenceStack(masks, [0.06, 0.18, 0.38].map(Math.fround), point, 1000, 800, false),
        referenceCoverage(masks[0], point.x, point.y, 1000, 800),
      ]
    expected.forEach((value, c) =>
      expect(
        Math.abs(actual[i * 4 + c] - value),
        JSON.stringify({ i, c, actual: actual[i * 4 + c], value }),
      ).toBeLessThanOrEqual(2e-6 + 2e-5 * Math.abs(value)),
    )
  }
})

test('actual raster presenter reports local overflow before a clamped image can be accepted', async ({
  irodori,
}) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {neutralAdjustments,srgbTransform} from './src/shared/adjustments';
import {identityMaskGeometry} from './src/shared/mask-geometry';
import {neutralMaskLight} from './src/shared/masks';
window.runMaskOverflow=async()=>{
 const canvas=document.createElement('canvas');document.body.append(canvas);let reason='';
 const presenter=new PreviewPresenter(canvas,false,value=>{reason=value});
 try {
  presenter.setWorking({width:1,height:1,data:new Float32Array([3e38,3e38,3e38,1]),transform:srgbTransform});
  presenter.draw({width:1,height:1},{width:64,height:64},{fit:false,scale:64,x:0,y:0},
   {...neutralAdjustments,maskGeometry:identityMaskGeometry(1,1),localMasks:[{
    id:'00000000-0000-0000-0000-000000000001',name:'Brighten',head:null,enabled:true,inverted:false,
    light:{...neutralMaskLight,exposureEv:5},strokes:[{mode:'add',radius:.5,feather:0,points:[{x:.5,y:.5}]}]}]});
  const until=performance.now()+6000;while(!reason&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  return reason;
 } finally {presenter.dispose();await presenter.whenDisposed;canvas.remove();}
};`,
    },
    bundle: true,
    write: false,
    format: 'iife',
  })
  await irodori.page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Mask numeric validation'
    document.body.append(frame)
  })
  const frame = irodori.page
    .frames()
    .find((item) => item.parentFrame() === irodori.page.mainFrame())!
  try {
    await frame.evaluate(bundle.outputFiles[0].text)
    const reason = await frame.evaluate(() =>
      (window as unknown as { runMaskOverflow: () => Promise<string> }).runMaskOverflow(),
    )
    expect(reason).toMatch(/non-finite pixels/)
  } finally {
    await irodori.page.evaluate(() =>
      document.querySelector('iframe[title="Mask numeric validation"]')?.remove(),
    )
  }
})

test('actual raster histogram evaluates ordered masks across the full native image and rejects stale readbacks', async ({
  irodori,
}) => {
  const width = 37,
    height = 19,
    data = Array.from({ length: width * height }, (_, i) => [
      Math.fround(0.025 + (i % 13) * 0.021),
      Math.fround(0.06 + (i % 17) * 0.015),
      Math.fround(0.1 + (i % 11) * 0.023),
      i % 17 === 0 ? 0 : 1,
    ]).flat(),
    masks: ResolvedMask[] = [
      {
        id: '00000000-0000-0000-0000-000000000011',
        name: 'Upper',
        enabled: true,
        inverted: false,
        head: null,
        light: { ...neutralMaskLight, exposureEv: 0.65, contrast: 27, shadows: 18 },
        strokes: [
          brush('add', 0.3, 0.55, [
            [0.28, 0.45],
            [0.58, 0.5],
          ]),
        ],
      },
      {
        id: '00000000-0000-0000-0000-000000000012',
        name: 'Lower',
        enabled: true,
        inverted: true,
        head: null,
        light: { ...neutralMaskLight, exposureEv: -0.4, highlights: -20, whites: 13, blacks: 7 },
        strokes: [brush('add', 0.22, 0.4, [[0.6, 0.4]])],
      },
    ],
    ordered = [...masks].reverse(),
    expected = {
      rgb: [Array(256).fill(0), Array(256).fill(0), Array(256).fill(0)],
      visiblePixels: 0,
      shadowClipped: 0,
      highlightClipped: 0,
    }
  const encode = (value: number) => {
    const linear = Math.max(0, Math.min(1, value))
    return Math.round(
      (linear < 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055) * 255,
    )
  }
  for (let i = 0; i < width * height; i++) {
    if (!data[i * 4 + 3]) continue
    const rgb = referenceStack(
      ordered,
      data.slice(i * 4, i * 4 + 3),
      { x: ((i % width) + 0.5) / width, y: (Math.floor(i / width) + 0.5) / height },
      width,
      height,
      false,
    ).map(encode)
    expected.visiblePixels++
    rgb.forEach((value, c) => expected.rgb[c][value]++)
    if (rgb.every((value) => value === 0)) expected.shadowClipped++
    if (rgb.some((value) => value === 255)) expected.highlightClipped++
  }
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {neutralAdjustments,srgbTransform} from './src/shared/adjustments';
import {identityMaskGeometry} from './src/shared/mask-geometry';
window.runMaskHistogram=async(input)=>{
 const canvas=document.createElement('canvas');document.body.append(canvas);
 let reason='',statistics,publications=0,pending=false;
 const presenter=new PreviewPresenter(canvas,false,value=>{reason=value},()=>{},
   value=>{statistics=value;publications++},value=>{pending=value},value=>{if(value)reason=value});
 try{
  presenter.setWorking({width:input.width,height:input.height,data:new Float32Array(input.data),transform:srgbTransform,identity:'raster-histogram-reference'});
  presenter.setComparison('split',.4);
  const image={width:input.width,height:input.height},viewport={width:187,height:103},
    parameters={...neutralAdjustments,maskGeometry:identityMaskGeometry(input.width,input.height),localMasks:input.masks};
  presenter.draw(image,viewport,{fit:false,scale:3,x:17,y:-8},parameters);
  const ready=performance.now()+6000;
  while(!statistics&&!reason&&performance.now()<ready)await new Promise(resolve=>setTimeout(resolve,10));
  if(reason)throw new Error(reason);
  if(!statistics)throw new Error('Initial masked histogram did not publish.');
  statistics=undefined;publications=0;
  const transient=input.masks.map((mask,index)=>index?mask:{...mask,light:{...mask.light,exposureEv:.92}});
  presenter.draw(image,viewport,{fit:false,scale:.6,x:-44,y:38},{...parameters,localMasks:transient});
  presenter.draw(image,viewport,{fit:false,scale:.6,x:-44,y:38},{...parameters,localMasks:[...input.masks].reverse()});
  const until=performance.now()+6000;
  while((!statistics||pending)&&!reason&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  if(reason)throw new Error(reason);
  return {statistics,publications,pending,samples:canvas.dataset.histogramSamples};
 }finally{presenter.dispose();await presenter.whenDisposed;canvas.remove();}
};`,
    },
    bundle: true,
    write: false,
    format: 'iife',
  })
  await irodori.page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Raster mask histogram'
    document.body.append(frame)
  })
  const frame = irodori.page
    .frames()
    .find((item) => item.parentFrame() === irodori.page.mainFrame())!
  try {
    await frame.evaluate(bundle.outputFiles[0].text)
    const actual = await frame.evaluate(
      (input) =>
        (
          window as unknown as {
            runMaskHistogram: (input: unknown) => Promise<{
              statistics: typeof expected
              publications: number
              pending: boolean
              samples: string
            }>
          }
        ).runMaskHistogram(input),
      { width, height, data, masks },
    )
    expect(actual.pending).toBe(false)
    expect(actual.samples).toBe(String(width * height))
    expect(actual.publications).toBe(1)
    expect(actual.statistics.visiblePixels).toBe(expected.visiblePixels)
    expect(actual.statistics.shadowClipped).toBe(expected.shadowClipped)
    expect(actual.statistics.highlightClipped).toBe(expected.highlightClipped)
    for (let c = 0; c < 3; c++) {
      // Independent Float64 values can cross an adjacent 8-bit rounding boundary.
      const error = actual.statistics.rgb[c].reduce(
        (sum, value, bin) => sum + Math.abs(value - expected.rgb[c][bin]),
        0,
      )
      expect(error, `channel ${c} total bin error`).toBeLessThanOrEqual(4)
    }
  } finally {
    await irodori.page.evaluate(() =>
      document.querySelector('iframe[title="Raster mask histogram"]')?.remove(),
    )
  }
})

test('raster histogram refuses non-finite masked samples outside the visible viewport', async ({
  irodori,
}) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {neutralAdjustments,srgbTransform} from './src/shared/adjustments';
import {identityMaskGeometry} from './src/shared/mask-geometry';
import {neutralMaskLight} from './src/shared/masks';
window.runOffviewHistogramOverflow=async()=>{
 const canvas=document.createElement('canvas');document.body.append(canvas);
 let photographError='',histogramError='',publications=0;
 const presenter=new PreviewPresenter(canvas,false,value=>{photographError=value},()=>{},
  value=>{if(value)publications++},()=>{},value=>{if(value)histogramError=value});
 try{
  presenter.setWorking({width:4,height:1,data:new Float32Array([.1,.1,.1,1,.1,.1,.1,1,.1,.1,.1,1,3e38,3e38,3e38,1]),transform:srgbTransform,identity:'off-view-histogram-overflow'});
  presenter.draw({width:4,height:1},{width:64,height:64},{fit:false,scale:64,x:96,y:0},
   {...neutralAdjustments,maskGeometry:identityMaskGeometry(4,1),localMasks:[{
    id:'00000000-0000-0000-0000-000000000013',name:'Off-view overflow',head:null,enabled:true,inverted:false,
    light:{...neutralMaskLight,exposureEv:5},strokes:[{mode:'add',radius:.5,feather:0,points:[{x:.875,y:.5}]}]}]});
  const until=performance.now()+6000;
  while(!histogramError&&!photographError&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  return {histogramError,photographError,publications};
 }finally{presenter.dispose();await presenter.whenDisposed;canvas.remove();}
};`,
    },
    bundle: true,
    write: false,
    format: 'iife',
  })
  await irodori.page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Off-view histogram overflow'
    document.body.append(frame)
  })
  const frame = irodori.page
    .frames()
    .find((item) => item.parentFrame() === irodori.page.mainFrame())!
  try {
    await frame.evaluate(bundle.outputFiles[0].text)
    const result = await frame.evaluate(() =>
      (
        window as unknown as {
          runOffviewHistogramOverflow: () => Promise<{
            histogramError: string
            photographError: string
            publications: number
          }>
        }
      ).runOffviewHistogramOverflow(),
    )
    expect(result.histogramError).toMatch(/non-finite histogram samples/)
    expect(result.photographError).toBe('')
    expect(result.publications).toBe(0)
  } finally {
    await irodori.page.evaluate(() =>
      document.querySelector('iframe[title="Off-view histogram overflow"]')?.remove(),
    )
  }
})

test('a stale invalid raster histogram cannot replace newer Before statistics', async ({
  irodori,
}) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {neutralAdjustments,srgbTransform,renderAdjustments} from './src/shared/adjustments';
import {imageStatistics} from './src/shared/statistics';
import {identityMaskGeometry} from './src/shared/mask-geometry';
import {neutralMaskLight} from './src/shared/masks';
window.runStaleHistogramFailure=async()=>{
 const canvas=document.createElement('canvas');document.body.append(canvas);
 let photographError='',histogramError='',statistics,hold=true,invalidReadback=false;
 const publish=value=>{statistics=value};
 const presenter=new PreviewPresenter(canvas,false,value=>{photographError=value},()=>{},publish,()=>{},value=>{histogramError=value||''});
 const gl=presenter.gl;if(!gl)throw new Error('WebGL unavailable.');
 const wait=gl.clientWaitSync.bind(gl),queryParameter=gl.getQueryParameter.bind(gl);
 let oldQuery;
 gl.clientWaitSync=(...args)=>hold?gl.TIMEOUT_EXPIRED:wait(...args);
 gl.getQueryParameter=(query,parameter)=>{
  const value=queryParameter(query,parameter);
  if(query===oldQuery&&parameter===gl.QUERY_RESULT)invalidReadback=Boolean(value);
  return value;
 };
 try{
  const frame={width:4,height:1,data:new Float32Array([.1,.1,.1,1,.1,.1,.1,1,.1,.1,.1,1,3e38,3e38,3e38,1]),transform:srgbTransform,identity:'stale-failed-mask-histogram'};
  const image={width:4,height:1},viewport={width:64,height:64},view={fit:false,scale:64,x:96,y:0};
  presenter.setWorking(frame);
  presenter.draw(image,viewport,view,{...neutralAdjustments,maskGeometry:identityMaskGeometry(4,1),localMasks:[{
   id:'00000000-0000-0000-0000-000000000014',name:'Off-view overflow',head:null,enabled:true,inverted:false,
   light:{...neutralMaskLight,exposureEv:5},strokes:[{mode:'add',radius:.5,feather:0,points:[{x:.875,y:.5}]}]}]});
  const until=performance.now()+6000;
  while(!presenter.histogramBusy&&!photographError&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  if(!presenter.histogramBusy)throw new Error(photographError||'The delayed histogram did not start.');
  oldQuery=presenter.histogramQuery;
  const oldWork=presenter.histogramWork;
  presenter.setComparison('before',.5);
  presenter.draw(image,viewport,view,neutralAdjustments);
  const before=imageStatistics(renderAdjustments(frame.data,neutralAdjustments,srgbTransform));
  // The ordinary worker owns Before analysis and can finish while the GPU readback waits.
  publish(before);
  hold=false;
  await oldWork;
  return {preserved:statistics===before,histogramError,photographError,invalidReadback};
 }finally{
  hold=false;gl.clientWaitSync=wait;gl.getQueryParameter=queryParameter;
  presenter.dispose();await presenter.whenDisposed;canvas.remove();
 }
};`,
    },
    bundle: true,
    write: false,
    format: 'iife',
  })
  await irodori.page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.title = 'Stale histogram failure'
    document.body.append(frame)
  })
  const frame = irodori.page
    .frames()
    .find((item) => item.parentFrame() === irodori.page.mainFrame())!
  try {
    await frame.evaluate(bundle.outputFiles[0].text)
    const result = await frame.evaluate(() =>
      (
        window as unknown as {
          runStaleHistogramFailure: () => Promise<{
            preserved: boolean
            histogramError: string
            photographError: string
            invalidReadback: boolean
          }>
        }
      ).runStaleHistogramFailure(),
    )
    expect(result.invalidReadback).toBe(true)
    expect(result.preserved).toBe(true)
    expect(result.histogramError).toBe('')
    expect(result.photographError).toBe('')
  } finally {
    await irodori.page.evaluate(() =>
      document.querySelector('iframe[title="Stale histogram failure"]')?.remove(),
    )
  }
})
