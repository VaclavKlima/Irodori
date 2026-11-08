import {
  adjustmentPixelKey,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
import { creativeColorActive, prepareCreativeColor } from '../../../shared/creative-color'
import {
  CREATIVE_COLOR_PARAMETER_BYTES,
  packCreativeColor,
} from '../../../shared/creative-color-gpu'
import { rasterAdjustmentShader } from '../../../shared/raster-adjustments-shader'
import {
  hasLocalMasks,
  localMaskPixelData,
  localMasksGlslFor,
  packLocalMasks,
  MASK_GPU_TEXTURE_WIDTH,
  maskBaseAtlasPlan,
} from '../../../shared/masks-gpu'
import { WebGlMaskBaseAtlas } from './mask-base-assets'
import { preparedToneCurves, type CompiledToneCurves } from '../../../shared/tone-curves'
import { packToneCurves, TONE_CURVE_PARAMETER_BYTES } from '../../../shared/tone-curves-gpu'
import { neutralColorMixer } from '../../../shared/color-mixer'
import { identityMatrix, whiteBalanceMatrix } from '../../../shared/white-balance'
import { retainPresentationBitmap } from './frame-cache'
import type { PresentedPreviewGeometry, Size, View } from './geometry'
import { imageResourceOwners } from './image-resource-owners'
import { drawPixelGrid, pixelGridGlsl } from './pixel-grid'
import { imageStatistics, type ImageStatistics } from '../../../shared/statistics'
type ComparisonMode = 'after' | 'before' | 'split'

const vertex = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`
const fragment = `#version 300 es
precision highp float;
${rasterAdjustmentShader('glsl')}
uniform sampler2D pixels;
uniform vec2 viewport, imageSize, pan;
uniform float scale, dpr, exposureEv, contrast, highlights, shadows, whites, blacks;
uniform vec2 colorIntensity;
uniform bool working, quantize, customWb;
uniform mat3 whiteBalance;
uniform int comparison;
uniform float split;
uniform vec3 transform;
out vec4 color;
vec4 sampleImage(vec2 p) {
  if (scale >= 1.0) return texelFetch(pixels, clamp(ivec2(floor(p)), ivec2(0), ivec2(imageSize)-1), 0);
  return texture(pixels, p / imageSize);
}
void main() {
  vec2 css = vec2(gl_FragCoord.x / dpr, viewport.y - gl_FragCoord.y / dpr);
  vec2 source = (css - viewport * 0.5 - pan) / scale + imageSize * 0.5;
  if (any(lessThan(source, vec2(0))) || any(greaterThanEqual(source, imageSize))) { color = vec4(0); return; }
  color = sampleImage(source);
  if (working) {
    bool before = comparison == 1 || (comparison == 2 && css.x < viewport.x * split);
    vec3 inputRgb = (!before && customWb) ? whiteBalance * color.rgb : color.rgb;
    vec3 rgb = before ? max(vec3(0),color.rgb) : rasterAdjusted(inputRgb,vec4(exposureEv,contrast,highlights,shadows),vec2(whites,blacks),colorIntensity,transform.x);
    if (quantize) rgb = floor(rgb * 65535.0) / 65535.0;
    rgb = clamp(rgb / transform.x, vec3(0), vec3(1));
    rgb = mix(pow(rgb, vec3(1.0/2.4)) * (1.0+transform.z) - transform.z, rgb * 12.92, lessThan(rgb, vec3(transform.y)));
    color.rgb = quantize ? min(vec3(255), floor(rgb * 65536.0 / 256.0)) / 255.0 : floor(rgb * 255.0 + 0.5) / 255.0;
  }
  ${pixelGridGlsl}
}`

/** The ordinary program stays unchanged until a separate spatial baseline is supplied. */
function comparisonFragment(source: string) {
  return source
    .replace(
      'uniform sampler2D pixels;',
      'uniform sampler2D pixels;\nuniform sampler2D beforePixels;',
    )
    .replace(
      'void main() {\n  vec2 css',
      `vec4 sampleBefore(vec2 p) {
  if (scale >= 1.0) return texelFetch(beforePixels, clamp(ivec2(floor(p)), ivec2(0), ivec2(imageSize)-1), 0);
  return texture(beforePixels, p / imageSize);
}
void main() {\n  vec2 css`,
    )
    .replace(
      '  color = sampleImage(source);',
      `  bool spatialBefore = comparison == 1 || (comparison == 2 && css.x < viewport.x * split);
  color = spatialBefore ? sampleBefore(source) : sampleImage(source);`,
    )
}

function glCompletion(gl: WebGL2RenderingContext): Promise<void> {
  if (gl.isContextLost()) return Promise.resolve()
  return new Promise((resolve) => {
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

export class PreviewPresenter {
  private readonly imageOwner?: ReturnType<typeof imageResourceOwners.register>
  private imageBytes() {
    const working =
        (this.working?.data.byteLength ?? 0) + (this.beforeSource?.data.byteLength ?? 0),
      buffers = new Set(
        [this.working, this.beforeSource].flatMap((frame) => (frame ? [frame.data.buffer] : [])),
      ),
      storage = [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0),
      bitmap = (this.bitmap?.width ?? 0) * (this.bitmap?.height ?? 0) * 4,
      canvas = this.canvas.width * this.canvas.height * 32
    return {
      ramBytes:
        storage * 3 +
        bitmap * 2 +
        canvas +
        this.creativeBytes * 3 +
        this.localMaskBytes * 3 +
        this.localMaskBaseReservation.ramBytes +
        this.histogramBytes * 2,
      vramBytes:
        Math.ceil((working * 4) / 3) +
        bitmap * 2 +
        canvas +
        this.creativeBytes +
        this.localMaskBytes +
        this.localMaskBaseReservation.vramBytes +
        this.histogramBytes +
        this.retiringBeforeBytes,
    }
  }
  private gl: WebGL2RenderingContext | null = null
  private context: CanvasRenderingContext2D | null = null
  private program?: WebGLProgram
  private creativeProgram?: WebGLProgram
  private creativePending?: {
    program: WebGLProgram
    shaders: WebGLShader[]
    timer?: ReturnType<typeof setTimeout>
  }
  private creativeFailed = false
  private creativeBytes = 0
  private localMaskBytes = 0
  private localMaskTexture?: WebGLTexture
  private localMaskKey = ''
  private localMaskBaseAtlas?: WebGlMaskBaseAtlas
  private localMaskBaseReservation = { ramBytes: 0, vramBytes: 0 }
  private localMaskQuery?: WebGLQuery
  private localMaskQueryTimer?: ReturnType<typeof setTimeout>
  private histogramTarget?: WebGLTexture
  private histogramFramebuffer?: WebGLFramebuffer
  private histogramReadback?: WebGLBuffer
  private histogramQuery?: WebGLQuery
  private histogramBytes = 0
  private histogramBusy = false
  private histogramQueued = false
  private histogramPublished = ''
  private histogramWork?: Promise<void>
  private uploadedCurves?: CompiledToneCurves
  private texture?: WebGLTexture
  private beforeTexture?: WebGLTexture
  private beforeSource?: WorkingFrame
  private comparisonRequired = false
  private retiringBeforeBytes = 0
  private spatialProgram?: WebGLProgram
  private bitmap?: ImageBitmap
  private releaseBorrowedBitmap?: () => void
  private comparison: { mode: ComparisonMode; split: number } = { mode: 'after', split: 0.5 }
  private working?: WorkingFrame
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  private completedGeometry?: PresentedPreviewGeometry
  get presentedGeometry(): PresentedPreviewGeometry | undefined {
    return this.completedGeometry
  }
  whenDisposed: Promise<void> = Promise.resolve()
  private disposed = false
  constructor(
    private canvas: HTMLCanvasElement,
    forceFallback: boolean,
    private lost: (reason: string) => void,
    private presented: () => void = () => {},
    private statistics: (result?: ImageStatistics) => void = () => {},
    private statisticsPending: (pending: boolean) => void = () => {},
    private statisticsFailed: (reason?: string) => void = () => {},
    private activity?: () => () => void,
  ) {
    try {
      if (!forceFallback)
        this.gl = canvas.getContext('webgl2', {
          alpha: true,
          premultipliedAlpha: false,
          antialias: false,
          preserveDrawingBuffer: true,
        })
      const gl = this.gl
      if (gl) {
        if (
          !gl.getExtension('OES_texture_float_linear') ||
          !gl.getExtension('EXT_color_buffer_float')
        ) {
          this.dispose()
          throw new Error('Floating-point filtering unavailable.')
        }
        const program = gl.createProgram()!
        for (const [type, source] of [
          [gl.VERTEX_SHADER, vertex],
          [gl.FRAGMENT_SHADER, fragment],
        ] as const) {
          const shader = gl.createShader(type)!
          gl.shaderSource(shader, source)
          gl.compileShader(shader)
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(shader) ?? 'Preview shader failed.')
          gl.attachShader(program, shader)
          gl.deleteShader(shader)
        }
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error('Preview program failed.')
        this.program = program
        this.texture = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        canvas.addEventListener('webglcontextlost', this.contextLost)
        canvas.dataset.backend = 'webgl2'
      } else {
        if (!forceFallback) throw new Error('WebGL2 raster presentation is unavailable.')
        this.context = canvas.getContext('2d', { colorSpace: 'srgb' })
        if (!this.context) throw new Error('Preview canvas unavailable.')
        canvas.dataset.backend = 'canvas2d'
      }
      this.imageOwner = imageResourceOwners.register(() => this.imageBytes())
    } catch (error) {
      this.dispose()
      throw error
    }
  }
  private contextLost = (event: Event) => {
    event.preventDefault()
    this.lost((event as WebGLContextEvent).statusMessage || 'WebGL raster context was lost.')
  }
  /** Compile only on the first creative edit; poll without stalling when supported. */
  private prepareCreativeProgram(): WebGLProgram | undefined {
    if (this.creativeProgram || this.creativeFailed) return this.creativeProgram
    if (this.creativePending) return undefined
    const gl = this.gl!,
      program = gl.createProgram(),
      shaders: WebGLShader[] = []
    if (!program) {
      this.creativeFailed = true
      this.lost('GPU program allocation failed.')
      return undefined
    }
    const pending = {
      program,
      shaders,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    this.creativePending = pending
    this.creativeBytes = CREATIVE_COLOR_PARAMETER_BYTES + TONE_CURVE_PARAMETER_BYTES
    this.canvas.dataset.colorProgram = 'pending'
    const fail = (
      reason = gl.getProgramInfoLog(program) || 'Creative-color GPU program failed.',
    ) => {
      this.clearCreativePreparation()
      this.creativeFailed = true
      this.canvas.dataset.colorProgram = 'failed'
      this.lost(reason)
    }
    try {
      if (this.working)
        this.checkSize(
          this.working.width,
          this.working.height,
          ((16 * 4) / 3) * (this.beforeSource ? 2 : 1),
        )
      const source = (this.beforeTexture ? comparisonFragment(fragment) : fragment)
        .replace('precision highp float;', 'precision highp float;precision highp int;')
        .replace(
          rasterAdjustmentShader('glsl'),
          rasterAdjustmentShader('glsl', true, 12, true) + localMasksGlslFor(true),
        )
        .replace(
          'uniform vec2 colorIntensity;',
          'uniform vec2 colorIntensity;uniform bool localMasksActive,maskValidation,histogramPass;uniform vec2 histogramSize;uniform float histogramCount;',
        )
        .replace(
          'void main() {\n  vec2 css',
          'void main() {\n  bool maskInvalid=false;\n  vec2 css',
        )
        .replace(
          '{ color = vec4(0); return; }',
          '{ if(maskValidation)discard; color = vec4(0); return; }',
        )
        .replace(
          '    if (quantize) rgb',
          '    if (!before && localMasksActive) { rgb=applyLocalMasks(rgb,source,transform.x);maskInvalid=!localMaskFinite(rgb);if(maskInvalid)rgb=vec3(0.); }\n    if (quantize) rgb',
        )
        .replace(
          'vec2 source = (css - viewport * 0.5 - pan) / scale + imageSize * 0.5;',
          `vec2 source = (css - viewport * 0.5 - pan) / scale + imageSize * 0.5;
  if(histogramPass){
    uint sampleIndex=uint(gl_FragCoord.y)*uint(histogramSize.x)+uint(gl_FragCoord.x);
    uint count=uint(histogramCount), imageWidth=uint(imageSize.x), total=imageWidth*uint(imageSize.y);
    if(sampleIndex>=count){if(maskValidation)discard;color=vec4(0.);return;}
    uint quotient=total/count, remainder=total%count, product=sampleIndex*remainder;
    uint pixelIndex=sampleIndex*quotient+quotient/2u+product/count+
      (2u*(product%count)+(quotient%2u)*count+remainder)/(2u*count);
    source=vec2(float(pixelIndex%imageWidth)+.5,float(pixelIndex/imageWidth)+.5);
  }`,
        )
        .replace('if (scale >= 1.0)', 'if (histogramPass || scale >= 1.0)')
        .replace(
          'bool before = comparison == 1 || (comparison == 2 && css.x < viewport.x * split);',
          'bool before = !histogramPass && (comparison == 1 || (comparison == 2 && css.x < viewport.x * split));',
        )
        .replace(
          'bool spatialBefore = comparison == 1 || (comparison == 2 && css.x < viewport.x * split);',
          'bool spatialBefore = !histogramPass && (comparison == 1 || (comparison == 2 && css.x < viewport.x * split));',
        )
        .replace(
          pixelGridGlsl,
          'if(maskValidation&&!maskInvalid)discard;\nif(histogramPass)return;\n' + pixelGridGlsl,
        )
      for (const [kind, code] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, source],
      ] as const) {
        const shader = gl.createShader(kind)
        if (!shader) throw new Error('Creative preview shader unavailable.')
        shaders.push(shader)
        gl.shaderSource(shader, code)
        gl.compileShader(shader)
        gl.attachShader(program, shader)
      }
      gl.linkProgram(program)
      const parallel = gl.getExtension('KHR_parallel_shader_compile')
      const poll = (redraw: boolean) => {
        if (this.disposed || this.creativePending !== pending) return
        if (gl.isContextLost()) {
          fail()
          return
        }
        if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) {
          pending.timer = setTimeout(() => poll(true), 16)
          return
        }
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          fail()
          return
        }
        for (const shader of shaders) gl.deleteShader(shader)
        this.creativePending = undefined
        this.creativeProgram = program
        this.uploadedCurves = undefined
        this.canvas.dataset.colorProgram = 'ready'
        if (redraw && this.view)
          this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
      }
      poll(false)
    } catch (error) {
      fail(String(error))
    }
    return this.creativeProgram
  }
  private clearCreativePreparation() {
    const pending = this.creativePending
    if (!pending) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    for (const shader of pending.shaders) this.gl?.deleteShader(shader)
    this.gl?.deleteProgram(pending.program)
    this.creativePending = undefined
  }
  setBitmap(bitmap: ImageBitmap) {
    if (this.working) return
    if (this.bitmap !== bitmap) {
      const release = retainPresentationBitmap(bitmap)

      this.releaseBorrowedBitmap?.()
      this.releaseBorrowedBitmap = release
    }
    this.bitmap = bitmap
    const gl = this.gl
    if (gl) {
      this.checkSize(bitmap.width, bitmap.height, (4 * 4) / 3)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.texture!)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
  }
  private checkSize(width: number, height: number, bytes: number) {
    const gl = this.gl!
    if (
      width > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      height > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      width * height * bytes +
        this.canvas.width * this.canvas.height * 8 +
        this.creativeBytes +
        this.localMaskBytes +
        this.localMaskBaseReservation.vramBytes +
        this.histogramBytes +
        this.retiringBeforeBytes >
        512 * 1024 ** 2
    )
      throw new Error('Preview exceeds GPU allocation budget.')
  }
  setWorking(frame: WorkingFrame) {
    if (!this.gl) throw new Error('Floating-point GPU raster presentation is unavailable.')
    if (this.working === frame) return
    this.completedGeometry = undefined
    this.histogramPublished = ''
    if (this.histogramBusy) this.histogramQueued = true
    if (this.working) {
      if (this.beforeSource) {
        this.comparisonRequired = true
        this.replaceComparisonSource()
      }
      this.releaseBorrowedBitmap?.()
      this.releaseBorrowedBitmap = undefined
      this.bitmap = undefined
    }
    this.working = frame
    const gl = this.gl
    if (gl) {
      this.checkSize(frame.width, frame.height, (16 * 4) / 3)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.texture!)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        frame.width,
        frame.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        frame.data,
      )
      gl.generateMipmap(gl.TEXTURE_2D)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Preview texture upload failed.')
    }
    this.canvas.dataset.editing = 'ready'
  }

  /** The supplied baseline has already passed the main comparison identity and float checks. */
  setComparisonSource(frame: WorkingFrame | null, required = true) {
    // Exact source aliasing needs neither a second upload nor a worker clone.
    if (frame === this.working) {
      frame = null
      required = false
    }
    if (
      frame &&
      (!this.working ||
        frame.hdr ||
        this.working.hdr ||
        frame.width !== this.working.width ||
        frame.height !== this.working.height ||
        frame.data.byteLength !== frame.width * frame.height * 16 ||
        JSON.stringify(frame.transform) !== JSON.stringify(this.working.transform))
    )
      throw new Error('The raster comparison source does not match its edited frame.')
    const changed = this.beforeSource !== (frame ?? undefined)
    if (!changed && this.comparisonRequired === required) return
    const gl = this.gl
    if (gl && frame && changed)
      this.checkSize(frame.width, frame.height, ((16 * 4) / 3) * (this.beforeSource ? 3 : 2))
    this.comparisonRequired = required
    if (changed) {
      try {
        this.replaceComparisonSource(frame ?? undefined)
      } catch (error) {
        if (this.comparison.mode !== 'after') {
          this.canvas.dataset.comparisonLoading = 'true'
          this.canvas.style.visibility = 'hidden'
        }
        throw error
      }
    }
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  private replaceComparisonSource(frame?: WorkingFrame) {
    const gl = this.gl
    if (this.beforeTexture && gl) {
      const old = this.beforeTexture,
        bytes = Math.ceil((this.beforeSource!.data.byteLength * 4) / 3)
      this.retiringBeforeBytes += bytes
      gl.deleteTexture(old)
      void glCompletion(gl).finally(() => {
        this.retiringBeforeBytes -= bytes
      })
    }
    this.beforeTexture = undefined
    this.beforeSource = frame

    this.clearCreativePreparation()
    if (this.creativeProgram) gl?.deleteProgram(this.creativeProgram)
    this.creativeProgram = undefined
    this.uploadedCurves = undefined
    this.creativeBytes = 0
    this.creativeFailed = false
    if (this.spatialProgram) gl?.deleteProgram(this.spatialProgram)
    this.spatialProgram = undefined
    if (gl && frame) {
      const texture = gl.createTexture()
      if (!texture) throw new Error('The raster comparison texture is unavailable.')
      this.beforeTexture = texture
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        frame.width,
        frame.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        frame.data,
      )
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.texture!)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Raster comparison texture upload failed.')
      const program = gl.createProgram()!
      for (const [kind, code] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, comparisonFragment(fragment)],
      ] as const) {
        const shader = gl.createShader(kind)!
        gl.shaderSource(shader, code)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          gl.deleteShader(shader)
          gl.deleteProgram(program)
          throw new Error('Raster comparison program failed.')
        }
        gl.attachShader(program, shader)
        gl.deleteShader(shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program)
        throw new Error('Raster comparison program failed.')
      }
      this.spatialProgram = program
    }
  }
  setComparison(mode: ComparisonMode, split: number) {
    this.comparison = { mode, split }
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    if (this.disposed || !viewport.width || !viewport.height) return
    this.view = { image, viewport, view, parameters }
    const waiting =
      this.comparison.mode !== 'after' &&
      (this.comparisonRequired || !!this.beforeSource) &&
      (!this.beforeSource || !this.beforeTexture || !this.spatialProgram)
    this.canvas.dataset.comparisonLoading = String(waiting)
    const sourceWaiting = !this.bitmap && (!this.gl || !this.working)
    this.canvas.style.visibility = waiting || sourceWaiting ? 'hidden' : ''
    if (waiting || sourceWaiting) return
    const curves = preparedToneCurves(parameters.curves)
    const masks = hasLocalMasks(parameters)
    const gl = this.gl,
      colour =
        prepareCreativeColor(parameters) ??
        prepareCreativeColor({ ...parameters, colorMixer: neutralColorMixer })!,
      creative =
        gl &&
        this.working &&
        this.comparison.mode !== 'before' &&
        (creativeColorActive(colour) || !curves.identity || masks),
      program = creative ? this.prepareCreativeProgram() : (this.spatialProgram ?? this.program)
    if (creative && !program) {
      this.view = {
        image: { ...image },
        viewport: { ...viewport },
        view: { ...view },
        parameters: structuredClone(parameters),
      }
      return
    }
    const dpr = window.devicePixelRatio || 1
    if (gl && creative) {
      const plan = maskBaseAtlasPlan(masks ? parameters : {})
      this.localMaskBaseAtlas ??= new WebGlMaskBaseAtlas(gl)
      this.localMaskBaseReservation = {
        ramBytes: plan.decodeBytes + plan.uploadBytes,
        vramBytes: Math.max(plan.bytes, this.localMaskBaseAtlas.bytes) + plan.uploadBytes,
      }
      this.checkSize(image.width, image.height, ((16 * 4) / 3) * (this.beforeSource ? 2 : 1))
      const ready = this.localMaskBaseAtlas.ready(
        plan,
        () => {
          const latest = this.view
          if (latest && !this.disposed) {
            try {
              this.draw(latest.image, latest.viewport, latest.view, latest.parameters)
            } catch (error) {
              this.lost(String(error))
            }
          }
        },
        this.lost,
      )
      this.canvas.dataset.localMasksLoading = String(!ready)
      if (!ready) {
        this.canvas.style.visibility = 'hidden'
        return
      }
    }
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    if (gl && program) {
      gl.viewport(0, 0, width, height)
      gl.useProgram(program)
      const location = (name: string) => gl.getUniformLocation(program, name)
      if (creative) {
        gl.uniform1i(location('histogramPass'), 0)
        gl.uniform1i(location('localMasksActive'), Number(masks))
        gl.activeTexture(gl.TEXTURE3)
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.localMaskBaseAtlas!.texture!)
        gl.uniform1i(location('localMaskBaseAtlas'), 3)
        if (masks) {
          const key = JSON.stringify([
            localMaskPixelData(parameters),
            parameters.maskGeometry,
            image,
          ])
          gl.activeTexture(gl.TEXTURE2)
          this.localMaskTexture ??= gl.createTexture() ?? undefined
          if (!this.localMaskTexture) throw new Error('Local mask GPU texture allocation failed.')
          gl.bindTexture(gl.TEXTURE_2D, this.localMaskTexture)
          if (key !== this.localMaskKey) {
            const packed = packLocalMasks(parameters, image),
              height = Math.ceil(packed.length / 4 / MASK_GPU_TEXTURE_WIDTH),
              data = new Float32Array(height * MASK_GPU_TEXTURE_WIDTH * 4)
            if (height > gl.getParameter(gl.MAX_TEXTURE_SIZE))
              throw new Error('Local mask geometry exceeds GPU texture limits.')
            this.localMaskBytes = data.byteLength
            this.checkSize(image.width, image.height, ((16 * 4) / 3) * (this.beforeSource ? 2 : 1))
            data.set(packed)
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA32F,
              MASK_GPU_TEXTURE_WIDTH,
              height,
              0,
              gl.RGBA,
              gl.FLOAT,
              data,
            )
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            this.localMaskKey = key
          }
          gl.uniform1i(location('localMaskData'), 2)
        }
      }
      if (this.beforeTexture) {
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, this.beforeTexture)
        gl.uniform1i(location('beforePixels'), 1)
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MAG_FILTER,
          view.scale < 1 ? gl.LINEAR : gl.NEAREST,
        )
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.texture!)
      gl.uniform1i(location('pixels'), 0)
      if (creative) gl.uniform4fv(location('creativeColorData[0]'), packCreativeColor(colour!))
      if (creative && this.uploadedCurves !== curves) {
        gl.uniform4fv(location('toneCurveData[0]'), packToneCurves(curves))
        this.uploadedCurves = curves
      }
      gl.uniform2f(location('viewport'), viewport.width, viewport.height)
      gl.uniform2f(location('imageSize'), image.width, image.height)
      gl.uniform2f(location('pan'), view.x, view.y)
      gl.uniform1f(location('scale'), view.scale)
      gl.uniform1f(location('dpr'), dpr)
      gl.uniform1f(location('exposureEv'), parameters.exposureEv)
      gl.uniform1f(location('contrast'), parameters.contrast)
      gl.uniform1f(location('highlights'), parameters.highlights)
      gl.uniform1f(location('shadows'), parameters.shadows)
      gl.uniform1f(location('whites'), parameters.whites)
      gl.uniform1f(location('blacks'), parameters.blacks)
      gl.uniform2f(location('colorIntensity'), parameters.saturation, parameters.vibrance)
      const wb = whiteBalanceMatrix(parameters.whiteBalance, this.working?.transform.whiteBalance)
      const matrix = wb ?? identityMatrix
      gl.uniformMatrix3fv(
        location('whiteBalance'),
        false,
        [0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => matrix[i]),
      )
      gl.uniform1i(location('customWb'), Number(!!wb))
      gl.uniform1i(
        location('comparison'),
        this.comparison.mode === 'before' ? 1 : this.comparison.mode === 'split' ? 2 : 0,
      )
      gl.uniform1f(location('split'), this.comparison.split)

      gl.uniform1i(location('working'), Number(!!this.working))
      if (this.working) {
        const t = this.working.transform
        gl.uniform3f(location('transform'), t.white, t.threshold, t.offset)
        gl.uniform1i(location('quantize'), Number(t.quantize))
      }
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        view.scale < 1 ? gl.LINEAR : gl.NEAREST,
      )
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (masks && creative && !this.localMaskQuery) {
        const query = gl.createQuery()
        if (!query) throw new Error('Local Light validation query allocation failed.')
        const validationKey = JSON.stringify([
            adjustmentPixelKey(parameters),
            image,
            viewport,
            view,
          ]),
          validatedSource = this.working
        this.localMaskQuery = query
        gl.uniform1i(location('maskValidation'), 1)
        gl.colorMask(false, false, false, false)
        gl.beginQuery(gl.ANY_SAMPLES_PASSED, query)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.endQuery(gl.ANY_SAMPLES_PASSED)
        gl.colorMask(true, true, true, true)
        gl.uniform1i(location('maskValidation'), 0)
        const poll = () => {
          this.localMaskQueryTimer = undefined
          if (this.disposed || gl.isContextLost() || this.localMaskQuery !== query) return
          if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
            this.localMaskQueryTimer = setTimeout(poll, 1)
            return
          }
          const invalid = Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT))
          gl.deleteQuery(query)
          this.localMaskQuery = undefined
          const latest = this.view,
            currentKey =
              latest &&
              JSON.stringify([
                adjustmentPixelKey(latest.parameters),
                latest.image,
                latest.viewport,
                latest.view,
              ])
          if (this.working === validatedSource && currentKey === validationKey && invalid)
            this.lost(
              'Local Light processing produced non-finite pixels. Reduce the local adjustments.',
            )
          else if (latest && (this.working !== validatedSource || currentKey !== validationKey))
            this.draw(latest.image, latest.viewport, latest.view, latest.parameters)
        }
        this.localMaskQueryTimer = setTimeout(poll, 1)
      }
      if (masks && creative && this.comparison.mode !== 'before') {
        try {
          this.requestHistogram(image, parameters, program)
        } catch (error) {
          this.statisticsPending(false)
          this.statisticsFailed(String(error))
        }
      } else {
        this.histogramQueued = false
        this.histogramPublished = ''
        this.statisticsFailed(undefined)
      }
    } else if (this.context && this.bitmap) {
      const context = this.context
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.imageSmoothingEnabled = view.scale < 1
      const left = (viewport.width - image.width * view.scale) / 2 + view.x
      const top = (viewport.height - image.height * view.scale) / 2 + view.y
      context.drawImage(this.bitmap, left, top, image.width * view.scale, image.height * view.scale)
      drawPixelGrid(context, image, viewport, view)
    }
    this.canvas.dataset.whiteBalance = JSON.stringify(
      parameters.whiteBalance ?? { mode: 'as-shot' },
    )
    this.canvas.dataset.comparison = this.comparison.mode
    this.canvas.dataset.highlights = String(parameters.highlights)
    this.canvas.dataset.shadows = String(parameters.shadows)
    this.canvas.dataset.whites = String(parameters.whites)
    this.canvas.dataset.blacks = String(parameters.blacks)
    this.canvas.dataset.saturation = String(parameters.saturation)
    this.canvas.dataset.vibrance = String(parameters.vibrance)
    this.canvas.dataset.colorMixer = JSON.stringify(parameters.colorMixer ?? null)
    this.canvas.dataset.colorGrading = JSON.stringify(parameters.colorGrading ?? null)
    this.canvas.dataset.curves = JSON.stringify(parameters.curves ?? null)

    this.canvas.dataset.contrast = String(parameters.contrast)
    this.canvas.dataset.exposure = String(parameters.exposureEv)
    const serial = Number(this.canvas.dataset.presentationSerial ?? 0) + 1
    this.completedGeometry = Object.freeze({
      image: Object.freeze({ ...image }),
      viewport: Object.freeze({ ...viewport }),
      view: Object.freeze({ ...view }),
      maskGeometry: parameters.maskGeometry && structuredClone(parameters.maskGeometry),
      sourceIdentity: this.working?.identity,
      serial,
    })
    this.canvas.dataset.presentationSerial = String(serial)
    this.canvas.dataset.presentedView = JSON.stringify(view)
    this.presented()
  }
  private histogramKey(image: Size, parameters: AdjustmentParameters) {
    return `${this.working?.identity ?? ''}:${image.width}:${image.height}:${adjustmentPixelKey(parameters)}`
  }
  /** GPU point processing samples the complete photograph; only bounded byte binning runs on CPU. */
  private requestHistogram(image: Size, parameters: AdjustmentParameters, program: WebGLProgram) {
    const source = this.working,
      gl = this.gl
    if (!source || !gl) return
    const key = this.histogramKey(image, parameters)
    const current = () => {
      const latest = this.view
      return (
        !this.disposed &&
        this.working === source &&
        !!latest &&
        this.comparison.mode !== 'before' &&
        hasLocalMasks(latest.parameters) &&
        key === this.histogramKey(latest.image, latest.parameters)
      )
    }
    if (key === this.histogramPublished) return
    if (this.histogramBusy) {
      this.histogramQueued = true
      return
    }
    const count = Math.min(image.width * image.height, 65536),
      width = Math.min(256, count),
      height = Math.ceil(count / width),
      bytes = width * height * 4
    this.histogramBytes = bytes * 3
    this.checkSize(image.width, image.height, ((16 * 4) / 3) * (this.beforeSource ? 2 : 1))
    this.histogramTarget ??= gl.createTexture() ?? undefined
    this.histogramFramebuffer ??= gl.createFramebuffer() ?? undefined
    this.histogramReadback ??= gl.createBuffer() ?? undefined
    if (!this.histogramTarget || !this.histogramFramebuffer || !this.histogramReadback)
      throw new Error('GPU histogram allocation failed.')
    this.histogramBusy = true
    this.histogramQueued = false
    this.statisticsPending(true)
    this.statisticsFailed(undefined)
    this.canvas.dataset.analysisPending = 'true'
    const release = this.activity?.()
    const dither = gl.isEnabled(gl.DITHER)
    const query = gl.createQuery()
    if (!query) {
      release?.()
      this.histogramBusy = false
      this.statisticsPending(false)
      this.statisticsFailed('GPU histogram validation query allocation failed.')
      this.canvas.dataset.analysisPending = 'false'
      return
    }
    this.histogramQuery = query
    try {
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, this.histogramTarget)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.histogramFramebuffer)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.histogramTarget,
        0,
      )
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('GPU histogram framebuffer is unavailable.')
      gl.disable(gl.DITHER)
      gl.viewport(0, 0, width, height)
      gl.uniform1i(gl.getUniformLocation(program, 'histogramPass'), 1)
      gl.uniform2f(gl.getUniformLocation(program, 'histogramSize'), width, height)
      gl.uniform1f(gl.getUniformLocation(program, 'histogramCount'), count)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.uniform1i(gl.getUniformLocation(program, 'maskValidation'), 1)
      gl.colorMask(false, false, false, false)
      gl.beginQuery(gl.ANY_SAMPLES_PASSED, query)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.endQuery(gl.ANY_SAMPLES_PASSED)
      gl.colorMask(true, true, true, true)
      gl.uniform1i(gl.getUniformLocation(program, 'maskValidation'), 0)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.histogramReadback)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('GPU histogram submission failed.')
    } catch (error) {
      this.histogramBusy = false
      gl.deleteQuery(query)
      this.histogramQuery = undefined
      release?.()
      this.statistics(undefined)
      this.statisticsPending(false)
      this.statisticsFailed(String(error))
      this.canvas.dataset.analysisPending = 'false'
      return
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.uniform1i(gl.getUniformLocation(program, 'histogramPass'), 0)
      gl.uniform1i(gl.getUniformLocation(program, 'maskValidation'), 0)
      gl.colorMask(true, true, true, true)
      if (dither) gl.enable(gl.DITHER)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.texture!)
    }
    const work = (async () => {
      try {
        await glCompletion(gl)
        if (this.disposed || gl.isContextLost()) return
        if (gl.getQueryParameter(query, gl.QUERY_RESULT))
          throw new Error(
            'Local Light processing produced non-finite histogram samples. Reduce the local adjustments.',
          )
        const data = new Uint8Array(bytes)
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.histogramReadback!)
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data)
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
        if (gl.getError() !== gl.NO_ERROR) throw new Error('GPU histogram readback failed.')
        if (current()) {
          this.histogramPublished = key
          this.statistics(imageStatistics(data))
          this.statisticsFailed(undefined)
          this.canvas.dataset.histogramSamples = String(count)
        }
      } catch (error) {
        if (current()) {
          this.statistics(undefined)
          this.statisticsFailed(String(error))
        }
      } finally {
        gl.deleteQuery(query)
        if (this.histogramQuery === query) this.histogramQuery = undefined
        release?.()
        this.histogramBusy = false
        if (!this.disposed) {
          this.statisticsPending(false)
          this.canvas.dataset.analysisPending = 'false'
          if (this.histogramQueued && this.view)
            this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
        }
      }
    })()
    this.histogramWork = work
  }
  dispose() {
    if (this.disposed) return
    this.localMaskBaseAtlas?.dispose()
    const gl = this.gl,
      drained = Promise.all([
        gl ? glCompletion(gl) : Promise.resolve(),
        this.histogramWork ?? Promise.resolve(),
        this.localMaskBaseAtlas?.whenDisposed ?? Promise.resolve(),
      ]).then(() => undefined)
    this.whenDisposed = drained
    this.imageOwner?.retire(drained)
    this.disposed = true
    this.clearCreativePreparation()
    if (this.localMaskQueryTimer !== undefined) clearTimeout(this.localMaskQueryTimer)
    if (this.localMaskQuery) gl?.deleteQuery(this.localMaskQuery)
    this.canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.releaseBorrowedBitmap?.()
    if (this.texture) this.gl?.deleteTexture(this.texture)
    if (this.beforeTexture) this.gl?.deleteTexture(this.beforeTexture)
    if (this.localMaskTexture) this.gl?.deleteTexture(this.localMaskTexture)
    if (this.histogramTarget) this.gl?.deleteTexture(this.histogramTarget)
    if (this.histogramFramebuffer) this.gl?.deleteFramebuffer(this.histogramFramebuffer)
    if (this.histogramReadback) this.gl?.deleteBuffer(this.histogramReadback)
    if (this.histogramQuery) this.gl?.deleteQuery(this.histogramQuery)
    if (this.spatialProgram) this.gl?.deleteProgram(this.spatialProgram)
    if (this.program) this.gl?.deleteProgram(this.program)
    if (this.creativeProgram) this.gl?.deleteProgram(this.creativeProgram)
    this.working = undefined
    this.beforeSource = undefined
  }
}
