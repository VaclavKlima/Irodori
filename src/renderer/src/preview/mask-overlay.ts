import type { AdjustmentParameters } from '../../../shared/adjustments'
import {
  localMasksGlslFor,
  packLocalMasks,
  MASK_GPU_TEXTURE_WIDTH,
  maskBaseAtlasPlan,
} from '../../../shared/masks-gpu'
import { WebGlMaskBaseAtlas } from './mask-base-assets'
import type { Size, View } from './geometry'
import { imageResourceOwners } from './image-resource-owners'

/** Coverage uses the same canonical pull mapping and brush evaluation as photo pixels. */
export class MaskOverlayPresenter {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly texture: WebGLTexture
  private readonly owner: ReturnType<typeof imageResourceOwners.register>
  private disposed = false
  private key = ''
  private bytes = 0
  private readonly baseAtlas: WebGlMaskBaseAtlas
  private baseRam = 0
  private baseVram = 0
  private latest?: {
    image: Size
    viewport: Size
    view: View
    parameters: AdjustmentParameters
    maskId: string
    requestIdentity: string
  }
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly failed: (reason: string) => void = () => {},
    private readonly presented: (maskId: string) => void = () => {},
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    })
    if (!gl) throw new Error('GPU mask coverage presentation is unavailable.')
    this.gl = gl
    this.baseAtlas = new WebGlMaskBaseAtlas(gl)
    const program = gl.createProgram(),
      texture = gl.createTexture()
    if (!program || !texture) throw new Error('GPU mask coverage allocation failed.')
    this.program = program
    this.texture = texture
    const shaders: WebGLShader[] = []
    try {
      for (const [type, source] of [
        [
          gl.VERTEX_SHADER,
          `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`,
        ],
        [
          gl.FRAGMENT_SHADER,
          `#version 300 es
precision highp float;precision highp int;
${localMasksGlslFor(true)}
uniform vec2 viewport,imageSize,pan;uniform float scale,dpr;
out vec4 color;
void main(){
 vec2 css=vec2(gl_FragCoord.x/dpr,viewport.y-gl_FragCoord.y/dpr);
 vec2 source=(css-viewport*.5-pan)/scale+imageSize*.5;
 if(any(lessThan(source,vec2(0.)))||any(greaterThanEqual(source,imageSize))){color=vec4(0.);return;}
 float coverage=maskCoverage(0,maskCanonical(source));color=vec4(.96,.30,.16,coverage*.38);
}`,
        ],
      ] as const) {
        const shader = gl.createShader(type)
        if (!shader) throw new Error('GPU mask coverage shader allocation failed.')
        shaders.push(shader)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || 'GPU mask coverage shader failed.')
        gl.attachShader(program, shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || 'GPU mask coverage program failed.')
    } catch (error) {
      gl.deleteProgram(program)
      gl.deleteTexture(texture)
      throw error
    } finally {
      for (const shader of shaders) gl.deleteShader(shader)
    }
    this.owner = imageResourceOwners.register(() => ({
      ramBytes: this.bytes * 3 + this.canvas.width * this.canvas.height * 8 + this.baseRam,
      vramBytes: this.bytes + this.canvas.width * this.canvas.height * 4 + this.baseVram,
    }))
  }
  draw(
    image: Size,
    viewport: Size,
    view: View,
    parameters: AdjustmentParameters,
    maskId: string,
    requestIdentity = maskId,
  ) {
    if (this.disposed) return
    if (this.latest?.requestIdentity !== requestIdentity) this.baseAtlas.retry()
    this.latest = { image, viewport, view, parameters, maskId, requestIdentity }
    const mask = parameters.localMasks?.find((item) => item.id === maskId)
    if (!mask || viewport.width <= 0 || viewport.height <= 0) return this.clear()
    const gl = this.gl
    if (gl.isContextLost()) throw new Error('GPU mask coverage context was lost.')
    const dpr = window.devicePixelRatio || 1,
      width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr)),
      key = JSON.stringify([mask, parameters.maskGeometry, image])
    const plan = maskBaseAtlasPlan({ localMasks: [mask] })
    this.baseRam = plan.decodeBytes + plan.uploadBytes
    this.baseVram = Math.max(plan.bytes, this.baseAtlas.bytes) + plan.uploadBytes
    if (this.baseVram + this.bytes + width * height * 8 > 512 * 1024 ** 2)
      throw new Error('Mask coverage exceeds the GPU presentation budget.')
    if (
      !this.baseAtlas.ready(
        plan,
        () => {
          const latest = this.latest
          if (latest && !this.disposed) {
            try {
              this.draw(
                latest.image,
                latest.viewport,
                latest.view,
                latest.parameters,
                latest.maskId,
                latest.requestIdentity,
              )
            } catch (error) {
              this.failed(String(error))
            }
          }
        },
        this.failed,
      )
    ) {
      this.gl.clearColor(0, 0, 0, 0)
      this.gl.clear(this.gl.COLOR_BUFFER_BIT)
      return
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    if (key !== this.key) {
      const packed = packLocalMasks(
          { localMasks: [mask], maskGeometry: parameters.maskGeometry },
          image,
        ),
        textureHeight = Math.ceil(packed.length / 4 / MASK_GPU_TEXTURE_WIDTH),
        data = new Float32Array(textureHeight * MASK_GPU_TEXTURE_WIDTH * 4)
      if (
        textureHeight > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
        data.byteLength * 3 + width * height * 8 > 512 * 1024 ** 2
      )
        throw new Error('Mask coverage exceeds the GPU presentation budget.')
      data.set(packed)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        MASK_GPU_TEXTURE_WIDTH,
        textureHeight,
        0,
        gl.RGBA,
        gl.FLOAT,
        data,
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      this.bytes = data.byteLength
      this.key = key
    }
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.program)
    const location = (name: string) => gl.getUniformLocation(this.program, name)
    gl.uniform1i(location('localMaskData'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.baseAtlas.texture!)
    gl.uniform1i(location('localMaskBaseAtlas'), 1)
    gl.uniform2f(location('viewport'), viewport.width, viewport.height)
    gl.uniform2f(location('imageSize'), image.width, image.height)
    gl.uniform2f(location('pan'), view.x, view.y)
    gl.uniform1f(location('scale'), view.scale)
    gl.uniform1f(location('dpr'), dpr)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('GPU mask coverage presentation failed.')
    this.presented(maskId)
  }
  clear() {
    if (this.disposed) return
    this.latest = undefined
    this.gl.clearColor(0, 0, 0, 0)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.latest = undefined
    this.baseAtlas.dispose()
    const gl = this.gl,
      drained = Promise.all([
        this.baseAtlas.whenDisposed,
        new Promise<void>((resolve) => {
          const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
          if (!fence || gl.isContextLost()) {
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
        }),
      ]).then(() => undefined)
    this.owner.retire(drained)
    void drained.then(() => {
      gl.deleteTexture(this.texture)
      gl.deleteProgram(this.program)
    })
  }
}
