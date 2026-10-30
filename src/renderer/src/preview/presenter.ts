import { reservePresentationBitmaps, retainPresentationBitmap } from './frame-cache'
import { imageResourceOwners } from './image-resource-owners'
import { whiteBalanceMatrix, identityMatrix } from '../../../shared/white-balance'
type ComparisonMode = 'after' | 'before' | 'split'
import {
  exposureModule,
  contrastModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
  blacksModule,
  neutralAdjustments,
  sameAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
import type { Size, View } from './geometry'
import { drawPixelGrid, pixelGridGlsl } from './pixel-grid'
import { colorIntensityGlsl } from '../../../shared/color-intensity'
import { creativeColorGlsl } from '../../../shared/creative-color-glsl'
import { creativeColorActive, prepareCreativeColor } from '../../../shared/creative-color'
import {
  CREATIVE_COLOR_PARAMETER_BYTES,
  packCreativeColor,
} from '../../../shared/creative-color-gpu'

const vertex = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`
const fragment = `#version 300 es
precision highp float;
${exposureModule.glsl}
${contrastModule.glsl}
${highlightsModule.glsl}
${shadowsModule.glsl}
${whitesModule.glsl}
${blacksModule.glsl}
${colorIntensityGlsl}
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
    vec3 rgb = before ? max(vec3(0), color.rgb) : max(vec3(0), applyHighlights(applyContrast(applyExposure(inputRgb, exposureEv), contrast, transform.x), highlights, transform.x));
    if (!before) {
      rgb = applyShadows(rgb, shadows, transform.x);
      rgb = applyWhites(rgb, whites, transform.x);
      rgb = applyBlacks(rgb, blacks, transform.x);
      if(any(notEqual(colorIntensity,vec2(0)))) rgb=applyColorIntensity(rgb/transform.x,colorIntensity)*transform.x;
    }
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
        [
          this.working,
          this.beforeSource,
          this.workerFrame,
          this.workerBefore,
          ...this.retiringWorkerFrames,
        ].flatMap((frame) => (frame ? [frame.data.buffer] : [])),
      ),
      storage = [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0),
      bitmap =
        ((this.bitmap?.width ?? 0) * (this.bitmap?.height ?? 0) +
          (this.beforeBitmap?.width ?? 0) * (this.beforeBitmap?.height ?? 0)) *
        4,
      canvas = this.canvas.width * this.canvas.height * 32
    return {
      ramBytes: storage * 3 + bitmap * 2 + canvas + this.creativeBytes * 3,
      vramBytes:
        Math.ceil((working * 4) / 3) +
        bitmap * 2 +
        canvas +
        this.creativeBytes +
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
  private texture?: WebGLTexture
  private beforeTexture?: WebGLTexture
  private beforeSource?: WorkingFrame
  private comparisonRequired = false
  private retiringBeforeBytes = 0
  private sourceGeneration = 0
  private sentGeneration = -1
  private workerFrame?: WorkingFrame
  private workerBefore?: WorkingFrame
  private retiringWorkerFrames: WorkingFrame[] = []
  private spatialProgram?: WebGLProgram
  private bitmap?: ImageBitmap
  private ownedBitmap = false
  private beforeBitmap?: ImageBitmap
  private releaseBitmapBudget?: () => void
  private releaseBorrowedBitmap?: () => void
  private comparison: { mode: ComparisonMode; split: number } = { mode: 'after', split: 0.5 }
  private working?: WorkingFrame
  private fallback?: Worker
  private fallbackBusy = false
  private fallbackParameters?: AdjustmentParameters
  private requestedParameters: AdjustmentParameters = neutralAdjustments
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  private disposed = false
  constructor(
    private canvas: HTMLCanvasElement,
    forceFallback: boolean,
    private lost: () => void,
  ) {
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
      this.context = canvas.getContext('2d', { colorSpace: 'srgb' })
      if (!this.context) throw new Error('Preview canvas unavailable.')
      canvas.dataset.backend = 'canvas2d'
    }
    this.imageOwner = imageResourceOwners.register(() => this.imageBytes())
  }
  private contextLost = (event: Event) => {
    event.preventDefault()
    this.lost()
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
      this.lost()
      return undefined
    }
    const pending = {
      program,
      shaders,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    this.creativePending = pending
    this.creativeBytes = CREATIVE_COLOR_PARAMETER_BYTES
    this.canvas.dataset.colorProgram = 'pending'
    const fail = () => {
      this.clearCreativePreparation()
      this.creativeFailed = true
      this.canvas.dataset.colorProgram = 'failed'
      this.lost()
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
        .replace(colorIntensityGlsl, creativeColorGlsl('srgb'))
        .replace(
          'if(any(notEqual(colorIntensity,vec2(0)))) rgb=applyColorIntensity(rgb/transform.x,colorIntensity)*transform.x;',
          'rgb=applyCreativeColor(rgb/transform.x)*transform.x;',
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
        this.canvas.dataset.colorProgram = 'ready'
        if (redraw && this.view)
          this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
      }
      poll(false)
    } catch {
      fail()
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
    if (this.working && (this.gl || this.fallbackParameters !== undefined)) return
    if (this.bitmap !== bitmap) {
      const release = retainPresentationBitmap(bitmap)
      if (this.ownedBitmap) this.bitmap?.close()
      this.ownedBitmap = false
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
        this.retiringBeforeBytes >
        512 * 1024 ** 2
    )
      throw new Error('Preview exceeds GPU allocation budget.')
  }
  setWorking(frame: WorkingFrame) {
    if (this.working === frame) return
    if (this.working) {
      if (this.beforeSource) {
        this.comparisonRequired = true
        this.replaceComparisonSource()
      } else {
        this.beforeBitmap?.close()
        this.beforeBitmap = undefined
      }
      if (this.ownedBitmap) this.bitmap?.close()
      this.releaseBorrowedBitmap?.()
      this.releaseBorrowedBitmap = undefined
      this.bitmap = undefined
      this.ownedBitmap = false
    }
    this.working = frame
    this.sourceGeneration++
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
    } else if (!this.fallback) {
      this.fallback = new Worker(new URL('./presentation-worker.ts', import.meta.url), {
        type: 'module',
      })
      this.fallback.onmessage = (event) => {
        const { parameters, bitmap, before, generation } = event.data as {
          generation: number
          before?: ImageBitmap
          parameters: AdjustmentParameters
          bitmap: ImageBitmap
        }
        if (this.disposed) {
          bitmap.close()
          before?.close()
          return
        }
        this.fallbackBusy = false
        if (generation === this.sentGeneration) this.retiringWorkerFrames = []
        if (generation !== this.sourceGeneration) {
          bitmap.close()
          before?.close()
          this.requestFallback()
          return
        }
        if (before) {
          this.beforeBitmap?.close()
          this.beforeBitmap = before
        }
        if (sameAdjustments(parameters, this.requestedParameters)) {
          if (this.ownedBitmap) this.bitmap?.close()
          this.releaseBorrowedBitmap?.()
          this.releaseBorrowedBitmap = undefined
          this.bitmap = bitmap
          this.ownedBitmap = true
          this.fallbackParameters = parameters
          if (this.view) this.draw(this.view.image, this.view.viewport, this.view.view, parameters)
        } else bitmap.close()
        this.requestFallback()
      }
    }
    if (this.fallback) {
      this.releaseBitmapBudget?.()
      this.releaseBitmapBudget = reservePresentationBitmaps(frame.width * frame.height * 8)
      this.fallbackParameters = undefined
      if (this.view)
        this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
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
    this.sourceGeneration++
    this.beforeBitmap?.close()
    this.beforeBitmap = undefined
    this.clearCreativePreparation()
    if (this.creativeProgram) gl?.deleteProgram(this.creativeProgram)
    this.creativeProgram = undefined
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
    this.fallbackParameters = undefined
  }
  private requestFallback() {
    if (
      !this.fallback ||
      this.fallbackBusy ||
      sameAdjustments(this.fallbackParameters, this.requestedParameters)
    )
      return
    if (this.sentGeneration !== this.sourceGeneration) {
      const frame = this.workerFrame !== this.working ? this.working : undefined,
        beforeFrame =
          this.workerBefore !== this.beforeSource ? (this.beforeSource ?? null) : undefined
      this.retiringWorkerFrames = [
        ...(frame && this.workerFrame ? [this.workerFrame] : []),
        ...(beforeFrame !== undefined && this.workerBefore ? [this.workerBefore] : []),
      ]
      this.fallback.postMessage({ frame, beforeFrame, generation: this.sourceGeneration })
      this.workerFrame = this.working
      this.workerBefore = this.beforeSource
      this.sentGeneration = this.sourceGeneration
    }
    this.fallbackBusy = true
    this.fallback.postMessage({ parameters: this.requestedParameters })
  }
  setComparison(mode: ComparisonMode, split: number) {
    this.comparison = { mode, split }
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    if (this.disposed || !viewport.width || !viewport.height) return
    this.view = { image, viewport, view, parameters }
    if (this.fallback) {
      this.requestedParameters = structuredClone(parameters)
      this.view.parameters = this.requestedParameters
      this.requestFallback()
    }
    const waiting =
      this.comparison.mode !== 'after' &&
      (this.comparisonRequired || !!this.beforeSource) &&
      (!this.beforeSource ||
        (this.gl
          ? !this.beforeTexture || !this.spatialProgram
          : !this.beforeBitmap || !this.bitmap))
    this.canvas.dataset.comparisonLoading = String(waiting)
    const sourceWaiting = !!this.fallback && !this.bitmap
    this.canvas.style.visibility = waiting || sourceWaiting ? 'hidden' : ''
    if (waiting || sourceWaiting) return
    const gl = this.gl,
      colour = prepareCreativeColor(parameters),
      creative =
        gl && this.working && this.comparison.mode !== 'before' && creativeColorActive(colour),
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
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    if (gl && program) {
      gl.viewport(0, 0, width, height)
      gl.useProgram(program)
      const location = (name: string) => gl.getUniformLocation(program, name)
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
    } else if (this.context && this.bitmap) {
      const context = this.context
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.imageSmoothingEnabled = view.scale < 1
      const left = (viewport.width - image.width * view.scale) / 2 + view.x
      const top = (viewport.height - image.height * view.scale) / 2 + view.y
      if (this.comparison.mode !== 'after' && !this.beforeBitmap) return
      context.drawImage(
        this.comparison.mode === 'before' && this.beforeBitmap ? this.beforeBitmap : this.bitmap,
        left,
        top,
        image.width * view.scale,
        image.height * view.scale,
      )
      if (this.comparison.mode === 'split' && this.beforeBitmap) {
        context.save()
        context.beginPath()
        context.rect(0, 0, viewport.width * this.comparison.split, viewport.height)
        context.clip()
        context.clearRect(0, 0, viewport.width, viewport.height)
        context.drawImage(
          this.beforeBitmap,
          left,
          top,
          image.width * view.scale,
          image.height * view.scale,
        )
        context.restore()
      }
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

    this.canvas.dataset.contrast = String(parameters.contrast)
    this.canvas.dataset.exposure = String(parameters.exposureEv)
  }
  dispose() {
    if (this.disposed) return
    const gl = this.gl,
      drained = gl ? glCompletion(gl) : Promise.resolve()
    this.imageOwner?.retire(drained)
    this.disposed = true
    this.clearCreativePreparation()
    this.canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.fallback?.terminate()
    this.beforeBitmap?.close()
    this.releaseBitmapBudget?.()
    this.releaseBorrowedBitmap?.()
    if (this.ownedBitmap) this.bitmap?.close()
    if (this.texture) this.gl?.deleteTexture(this.texture)
    if (this.beforeTexture) this.gl?.deleteTexture(this.beforeTexture)
    if (this.spatialProgram) this.gl?.deleteProgram(this.spatialProgram)
    if (this.program) this.gl?.deleteProgram(this.program)
    if (this.creativeProgram) this.gl?.deleteProgram(this.creativeProgram)
    this.working = undefined
    this.beforeSource = undefined
    this.workerFrame = undefined
    this.workerBefore = undefined
    this.retiringWorkerFrames = []
  }
}
