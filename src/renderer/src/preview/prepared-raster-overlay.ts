import type { DisplayTransform, WorkingFrame } from '../../../shared/adjustments'
import type { PreparedMaskPresentation } from '../../../shared/hdr'
import { readPreparedMaskStrips, validatePreparedMaskPresentation } from './prepared-mask-upload'
import { pixelGridGlsl } from './pixel-grid'
import type { Size, View } from './geometry'

const vertex = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`
const mipFragment = `#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D inputUnion;
uniform ivec2 inputSize,outputSize;
uniform int inputLevel;
layout(location=0)out uint presence;
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);
 ivec2 first=ivec2(floor(vec2(p)*vec2(inputSize)/vec2(outputSize)));
 ivec2 last=ivec2(ceil(vec2(p+1)*vec2(inputSize)/vec2(outputSize)))-1;
 uint maximum=0u;
 for(int y=0;y<3;y++){for(int x=0;x<3;x++){
  ivec2 q=first+ivec2(x,y);if(any(greaterThan(q,last)))continue;
  maximum=max(maximum,texelFetch(inputUnion,clamp(q,ivec2(0),inputSize-1),inputLevel).r&0x7fffffffu);
 }}presence=maximum;
}`
const fragment = `#version 300 es
precision highp float;precision highp int;
uniform highp sampler2D preparedPixels;
uniform highp usampler2D preparedUnion;
uniform vec2 viewport,imageSize,pan;
uniform float scale,dpr,split;
uniform int comparison,levels;
uniform bool quantize,histogramPass,clippingPass;
uniform vec3 transform;
uniform vec2 histogramSize;
uniform float histogramCount;
uniform uint clippingOffset;
out vec4 color;
uint unionLevel(vec2 p,int level){
 ivec2 size=textureSize(preparedUnion,level);
 vec2 tap=p/imageSize*vec2(size)-.5,weight=fract(tap);
 ivec2 first=ivec2(floor(tap));uint maximum=0u;
 for(int y=0;y<2;y++){for(int x=0;x<2;x++){
  if((x==1&&weight.x==0.)||(y==1&&weight.y==0.))continue;
  maximum=max(maximum,texelFetch(preparedUnion,clamp(first+ivec2(x,y),ivec2(0),size-1),level).r&0x7fffffffu);
 }}return maximum;
}
void main(){
 vec2 css=vec2(gl_FragCoord.x/dpr,viewport.y-gl_FragCoord.y/dpr);
 vec2 source=(css-viewport*.5-pan)/scale+imageSize*.5;
 vec2 sampleDx=dFdx(source/imageSize),sampleDy=dFdy(source/imageSize);
 if(!histogramPass&&(comparison==1||(comparison==2&&css.x<viewport.x*split)))discard;
 if(histogramPass){
  uint sampleIndex=uint(gl_FragCoord.y)*uint(histogramSize.x)+uint(gl_FragCoord.x);
  uint count=uint(histogramCount),imageWidth=uint(imageSize.x),total=imageWidth*uint(imageSize.y);
  if(sampleIndex>=count)discard;
  uint pixelIndex=clippingOffset+sampleIndex;
  if(!clippingPass){uint quotient=total/count,remainder=total%count,product=sampleIndex*remainder;
   pixelIndex=sampleIndex*quotient+quotient/2u+product/count+(2u*(product%count)+(quotient%2u)*count+remainder)/(2u*count);}
  source=vec2(float(pixelIndex%imageWidth)+.5,float(pixelIndex/imageWidth)+.5);
 }
 if(any(lessThan(source,vec2(0)))||any(greaterThanEqual(source,imageSize)))discard;
 vec4 pixel;
 if(histogramPass||scale>=1.){
  ivec2 p=clamp(ivec2(floor(source)),ivec2(0),ivec2(imageSize)-1);
  if((texelFetch(preparedUnion,p,0).r&0x7fffffffu)==0u)discard;
  pixel=texelFetch(preparedPixels,p,0);
 }else{
  float lod=clamp(log2(1./(scale*dpr)),0.,float(levels-1));int lower=int(floor(lod)),upper=min(levels-1,lower+int(fract(lod)>0.));
  if(max(unionLevel(source,lower),unionLevel(source,upper))==0u)discard;
  pixel=textureGrad(preparedPixels,source/imageSize,sampleDx,sampleDy);
 }
 if(!(pixel.a>0.))discard;
 vec3 rgb=pixel.rgb;
 if(quantize)rgb=floor(rgb*65535.)/65535.;
 rgb=clamp(rgb/transform.x,vec3(0),vec3(1));
 rgb=mix(pow(rgb,vec3(1./2.4))*(1.+transform.z)-transform.z,rgb*12.92,lessThan(rgb,vec3(transform.y)));
 color=vec4(quantize?min(vec3(255),floor(rgb*65536./256.))/255.:floor(rgb*255.+.5)/255.,pixel.a);
 if(histogramPass)return;
 ${pixelGridGlsl}
}`

function program(gl: WebGL2RenderingContext, fragment: string) {
  const p = gl.createProgram()
  if (!p) throw new Error('Prepared raster program allocation failed.')
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Prepared raster shader allocation failed.')
      try {
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) ?? 'Prepared raster shader failed.')
        gl.attachShader(p, shader)
      } finally {
        gl.deleteShader(shader)
      }
    }
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p) ?? 'Prepared raster program failed.')
    return p
  } catch (error) {
    gl.deleteProgram(p)
    throw error
  }
}
export function rasterOverlayBytes(width: number, height: number) {
  let w = width,
    h = height,
    pixels = 0,
    scratch = 0,
    levels = 0
  while (true) {
    pixels += w * h
    levels++
    if (w === 1 && h === 1) break
    w = Math.max(1, Math.floor(w / 2))
    h = Math.max(1, Math.floor(h / 2))
    scratch += w * h * 4
  }
  return {
    levels,
    active: pixels * 20 + 4096,
    pending: pixels * 20 + scratch + 8192,
    ram: width * Math.min(64, height) * 48 + 2 * 1024 ** 2,
  }
}
export function rasterOverlayCompletion(gl: WebGL2RenderingContext) {
  if (gl.isContextLost()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!fence) {
      gl.finish()
      resolve()
      return
    }
    gl.flush()
    const poll = () => {
      if (gl.isContextLost() || gl.clientWaitSync(fence, 0, 0) !== gl.TIMEOUT_EXPIRED) {
        gl.deleteSync(fence)
        resolve()
      } else setTimeout(poll, 1)
    }
    poll()
  })
}
export class PreparedRasterOverlay {
  private pixels?: WebGLTexture
  private union?: WebGLTexture
  private drawProgram?: WebGLProgram
  private disposed = false
  private constructor(
    private gl: WebGL2RenderingContext,
    readonly descriptor: PreparedMaskPresentation,
    readonly width: number,
    readonly height: number,
    readonly bytes: number,
    readonly levels: number,
  ) {}
  static async create(gl: WebGL2RenderingContext, frame: WorkingFrame, signal: AbortSignal) {
    const descriptor = validatePreparedMaskPresentation({
      width: frame.width,
      height: frame.height,
      sha256: frame.sourceSha256 ?? '',
      preparedMasks: frame.preparedMasks,
    })
    if (!descriptor) throw new Error('Missing prepared raster descriptor.')
    const memory = rasterOverlayBytes(frame.width, frame.height),
      owner = new PreparedRasterOverlay(
        gl,
        descriptor,
        frame.width,
        frame.height,
        memory.active,
        memory.levels,
      )
    let scratch: WebGLTexture | undefined,
      fbo: WebGLFramebuffer | undefined,
      mip: WebGLProgram | undefined
    try {
      owner.pixels = gl.createTexture() ?? undefined
      owner.union = gl.createTexture() ?? undefined
      if (!owner.pixels || !owner.union)
        throw new Error('Prepared raster texture allocation failed.')
      for (const [unit, texture, format] of [
        [4, owner.pixels, gl.RGBA32F],
        [5, owner.union, gl.R32UI],
      ] as const) {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texStorage2D(gl.TEXTURE_2D, memory.levels, format, frame.width, frame.height)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          unit === 4 ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST,
        )
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, unit === 4 ? gl.LINEAR : gl.NEAREST)
      }
      for (const [file, channels, unit, texture] of [
        [descriptor.candidate, 4, 4, owner.pixels],
        [descriptor.union, 1, 5, owner.union],
      ] as const) {
        for await (const { row, rows, bytes } of readPreparedMaskStrips(
          file,
          frame.width,
          frame.height,
          channels,
          signal,
        )) {
          signal.throwIfAborted()
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            row,
            frame.width,
            rows,
            channels === 4 ? gl.RGBA : gl.RED_INTEGER,
            channels === 4 ? gl.FLOAT : gl.UNSIGNED_INT,
            channels === 4 ? new Float32Array(bytes.buffer) : new Uint32Array(bytes.buffer),
          )
        }
      }
      gl.activeTexture(gl.TEXTURE4)
      gl.bindTexture(gl.TEXTURE_2D, owner.pixels)
      gl.generateMipmap(gl.TEXTURE_2D)
      if (memory.levels > 1) {
        scratch = gl.createTexture() ?? undefined
        fbo = gl.createFramebuffer() ?? undefined
        mip = program(gl, mipFragment)
        if (!scratch || !fbo) throw new Error('Prepared raster union mip allocation failed.')
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
          viewport = gl.getParameter(gl.VIEWPORT) as Int32Array,
          currentProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
        try {
          gl.useProgram(mip)
          gl.uniform1i(gl.getUniformLocation(mip, 'inputUnion'), 5)
          let w = frame.width,
            h = frame.height
          for (let level = 1; level < memory.levels; level++) {
            signal.throwIfAborted()
            const dw = Math.max(1, Math.floor(w / 2)),
              dh = Math.max(1, Math.floor(h / 2))
            gl.activeTexture(gl.TEXTURE4)
            gl.bindTexture(gl.TEXTURE_2D, scratch)
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.R32UI,
              dw,
              dh,
              0,
              gl.RED_INTEGER,
              gl.UNSIGNED_INT,
              null,
            )
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scratch, 0)
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
              throw new Error('Prepared raster union framebuffer is unavailable.')
            gl.activeTexture(gl.TEXTURE5)
            gl.bindTexture(gl.TEXTURE_2D, owner.union)
            gl.uniform1i(gl.getUniformLocation(mip, 'inputLevel'), level - 1)
            gl.uniform2i(gl.getUniformLocation(mip, 'inputSize'), w, h)
            gl.uniform2i(gl.getUniformLocation(mip, 'outputSize'), dw, dh)
            gl.viewport(0, 0, dw, dh)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
            gl.copyTexSubImage2D(gl.TEXTURE_2D, level, 0, 0, 0, 0, dw, dh)
            w = dw
            h = dh
          }
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
          gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3])
          gl.useProgram(currentProgram)
        }
      }
      owner.drawProgram = program(gl, fragment)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Prepared raster upload/mips failed.')
      await rasterOverlayCompletion(gl)
      signal.throwIfAborted()
      return owner
    } catch (error) {
      await owner.dispose()
      throw error
    } finally {
      await rasterOverlayCompletion(gl)
      if (scratch) gl.deleteTexture(scratch)
      if (fbo) gl.deleteFramebuffer(fbo)
      if (mip) gl.deleteProgram(mip)
    }
  }
  draw(
    image: Size,
    viewport: Size,
    view: View,
    transform: DisplayTransform,
    comparison: { mode: 'after' | 'before' | 'split'; split: number },
    analysis?: { width: number; height: number; count: number; offset?: number },
  ) {
    if (this.disposed || !this.drawProgram) return
    const gl = this.gl,
      p = this.drawProgram,
      previous = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      active = gl.getParameter(gl.ACTIVE_TEXTURE) as number
    try {
      gl.useProgram(p)
      gl.activeTexture(gl.TEXTURE4)
      gl.bindTexture(gl.TEXTURE_2D, this.pixels!)
      gl.uniform1i(gl.getUniformLocation(p, 'preparedPixels'), 4)
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_2D, this.union!)
      gl.uniform1i(gl.getUniformLocation(p, 'preparedUnion'), 5)
      const location = (name: string) => gl.getUniformLocation(p, name)
      gl.uniform2f(location('viewport'), viewport.width, viewport.height)
      gl.uniform2f(location('imageSize'), image.width, image.height)
      gl.uniform2f(location('pan'), view.x, view.y)
      gl.uniform1f(location('scale'), view.scale)
      gl.uniform1f(location('dpr'), window.devicePixelRatio || 1)
      gl.uniform1f(location('split'), comparison.split)
      gl.uniform1i(
        location('comparison'),
        comparison.mode === 'before' ? 1 : comparison.mode === 'split' ? 2 : 0,
      )
      gl.uniform1i(location('levels'), this.levels)
      gl.uniform3f(location('transform'), transform.white, transform.threshold, transform.offset)
      gl.uniform1i(location('quantize'), Number(transform.quantize))
      gl.uniform1i(location('histogramPass'), Number(!!analysis))
      gl.uniform1i(location('clippingPass'), Number(analysis?.offset !== undefined))
      gl.uniform1ui(location('clippingOffset'), analysis?.offset ?? 0)
      gl.uniform2f(location('histogramSize'), analysis?.width ?? 1, analysis?.height ?? 1)
      gl.uniform1f(location('histogramCount'), analysis?.count ?? 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    } finally {
      gl.useProgram(previous)
      gl.activeTexture(active)
    }
  }
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await rasterOverlayCompletion(this.gl)
    if (this.pixels) this.gl.deleteTexture(this.pixels)
    if (this.union) this.gl.deleteTexture(this.union)
    if (this.drawProgram) this.gl.deleteProgram(this.drawProgram)
  }
}
