import { hdrPresentationMemory, HDR_PRESENTATION_BUDGET } from './hdr-memory'
import { reservePresentationBitmaps } from './frame-cache'
import {
  hdrAdjustmentMatrix,
  validateTarget,
  HDR_ADJUSTMENT_VERSION,
  HDR_OUTPUT_VERSION,
  type DisplayTarget,
} from '../../../shared/hdr'
import { identityMatrix } from '../../../shared/white-balance'
import {
  neutralAdjustments,
  sameAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
import { retainHdrContent } from './hdr-sample'
import type { Size, View } from './geometry'
import { hdrDevice } from './hdr-device'
import { uploadHdr } from './hdr-upload'
import { hdrShader, hdrMipShader, hdrCacheKernel } from './hdr-shader'
import { ACES_DATA_BYTES } from '../../../shared/aces-data'
import { ACES_INTERACTIVE_PREVIEW_VERSION } from '../../../shared/aces-preview-wgsl'
import { hdrCachePlan, HdrRenderCache, HDR_CACHE_MAX_TILES } from './hdr-render-cache'
import { HdrEditQueue, type HdrEditRequest } from './hdr-edit-queue'
import { hdrHistogramShader, HDR_HISTOGRAM_WORDS, readHdrHistogram } from './hdr-histogram'
import type { HdrStatistics } from '../../../shared/hdr-statistics'
import { HdrGpuTimings, HDR_GPU_TIMING_BYTES, type HdrGpuTimingFrame } from './hdr-gpu-timings'
import {
  HDR_PRESENTATION_CACHE_BUDGET,
  HdrPresentationCache,
  hdrPresentationIdentity,
  type HdrPresentationIdentity,
} from './hdr-presentation-cache'

// Paired application trials retain the bounded 32-tile default; eight remains an internal comparison.
const HDR_TILE_BATCH = import.meta.env.VITE_LUMA_HDR_TILE_BATCH === '8' ? 8 : 32
const INTERACTIVE_PRECISION = import.meta.env.VITE_LUMA_HDR_INTERACTIVE_PRECISION === 'f32'
const PRESENTATION_CACHE = import.meta.env.VITE_LUMA_HDR_PRESENTATION_CACHE === '1'
const presentationCache = new HdrPresentationCache<GPUTexture>()
const presentationDevices = new WeakSet<GPUDevice>()
const blitPipelines = new WeakMap<GPUDevice, Promise<GPURenderPipeline>>()
const presentationReservation = PRESENTATION_CACHE ? HDR_PRESENTATION_CACHE_BUDGET : 0

export interface HdrPresentationState {
  revision: number
  settings: AdjustmentParameters
}

function observePresenterLoss(device: GPUDevice, observer: { lost?: () => void }) {
  // Closed presenters release their callback; a long-lived device retains only this small holder.
  void device.lost.then(() => observer.lost?.())
}

function presentationBlit(device: GPUDevice) {
  let pending = PRESENTATION_CACHE ? blitPipelines.get(device) : undefined
  if (!pending) {
    const module = device.createShaderModule({
      code: `
        @group(0) @binding(0) var image:texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
          let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.);
        }
        @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f { return textureLoad(image,vec2i(p.xy),0); }
      `,
    })
    pending = device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    })
    if (PRESENTATION_CACHE) {
      blitPipelines.set(device, pending)
      const compiled = pending
      void pending.catch(() => {
        if (blitPipelines.get(device) === compiled) blitPipelines.delete(device)
      })
    }
  }
  return pending
}

export interface HdrFrameTimings {
  inputSerial: number
  queueMs: number
  planningMs: number
  tileSubmissionMs: number
  tileFenceMs: number
  tileFenceCount: number
  tileDispatchCount: number
  renderedTiles: number
  computedTexels: number
  renderSubmissionMs: number
  offscreenFenceMs: number
  blitSubmissionMs: number
  retainedCopyMs: number
  finalBlitFenceMs: number
  totalMs: number
  unattributedMs: number
  sourceMip: number
  tileSize: number
  cacheSlots: number
  surfacePixels: number
}
interface PresentationRequest {
  image: Size
  viewport: Size
  view: View
  parameters: AdjustmentParameters
  target: DisplayTarget
  mode: string
  split: number
  ranges: boolean
  inputSerial: number
  analysisSamples: number
  requestedAt: number
  sourceIdentity: string
  epoch: number
  interactivePrecision: boolean
}
interface HistogramRequest {
  key: string
  parameters: Float32Array<ArrayBuffer>
  presentation: PresentationRequest
}
interface RenderedPresentation {
  startedAt: number
  timings: HdrFrameTimings
  quality: 'normal' | 'interactive'
  histogram: HistogramRequest
}

export class HdrPresenter {
  private abort = new AbortController()
  private device?: GPUDevice
  private gpuTimings?: HdrGpuTimings
  private context?: GPUCanvasContext
  private texture?: GPUTexture
  private uniform?: GPUBuffer
  private pipeline?: GPURenderPipeline
  private group?: GPUBindGroup
  private layout?: GPUBindGroupLayout
  private cacheLayout?: GPUBindGroupLayout
  private cachePipeline?: GPUComputePipeline
  private interactivePipeline?: GPUComputePipeline
  private cacheKernel = hdrCacheKernel(
    import.meta.env.VITE_LUMA_HDR_KERNEL === 'grid8' ? 'grid8' : 'linear64',
  )
  private cacheTexture?: GPUTexture
  private cache?: HdrRenderCache
  private cacheGroups = new Map<number, GPUBindGroup>()
  private lookup?: GPUBuffer
  private jobs?: GPUBuffer
  private renderedTiles = 0
  private rendering?: GPUBuffer
  private sdrRendering = new Map<string, GPUBuffer>()
  private renderingGeneration = -1
  private histogramPipeline?: GPUComputePipeline
  private histogramUniform?: GPUBuffer
  private histogramBuffer?: GPUBuffer
  private histogramReadback?: GPUBuffer
  private histogramGroup?: GPUBindGroup
  private surface?: GPUTexture
  private surfaceSize = ''
  private blit?: GPURenderPipeline
  private blitGroup?: GPUBindGroup
  private configured = ''
  private queue = new HdrEditQueue<PresentationRequest>()
  private histogramQueue = new HdrEditQueue<HistogramRequest>()
  private requestedStatisticsKey = ''
  private releaseHistogramActivity?: () => void
  private gesturing = false
  private refinementPending = false
  private epoch = -1
  private inputSerial = 0
  private editsKey = ''
  private statisticsCache?: { key: string; result: HdrStatistics }
  private publishedStatisticsKey = ''
  private publishedStatisticsSerial = 0
  private renderingWorker = new Worker(new URL('./display-rendering-worker.ts', import.meta.url), {
    type: 'module',
  })
  private frame?: WorkingFrame
  private mode = 'after'
  private split = 0.5
  private hdrRanges = false
  private levels = 1
  private ready = false
  private running = false
  private releaseBitmaps?: () => void
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  private releaseActivity?: () => void
  private presentationState: HdrPresentationState | null = null
  private completedSurface?: {
    surface: GPUTexture
    identity: HdrPresentationIdentity
    serial: number
  }
  private restoredIdentity?: string
  private attemptedRestore = ''
  private restoring?: Promise<void>
  private nativePresented = false
  private presentationVersion = 0
  private deviceObserver?: { lost?: () => void }
  constructor(
    private canvas: HTMLCanvasElement,
    private target: DisplayTarget,
    private lost: (reason: string) => void,
    private loaded: () => void,
    private statistics: (result: HdrStatistics) => void = () => undefined,
    private retainedCanvas?: HTMLCanvasElement,
    private activity?: () => () => void,
    private statisticsPending: (pending: boolean) => void = () => undefined,
    private cachedPresentation: (presented: boolean) => void = () => undefined,
  ) {
    canvas.dataset.backend = 'webgpu-hdr'
    canvas.dataset.tileBatch = String(HDR_TILE_BATCH)
    canvas.dataset.tileKernel = this.cacheKernel.kind
    canvas.dataset.interactivePolicy = INTERACTIVE_PRECISION
      ? ACES_INTERACTIVE_PREVIEW_VERSION
      : 'reference'
    canvas.dataset.presentationCache = PRESENTATION_CACHE ? 'pending' : 'disabled'
    this.renderingWorker.onmessage = ({ data }) => {
      if (this.abort.signal.aborted) return
      if (data.error) {
        this.lost(data.error)
        return
      }
      if (!this.device || !this.rendering) return
      this.device.queue.writeBuffer(this.rendering, 0, data.packed)
      for (const space of ['srgb', 'display-p3'])
        this.device.queue.writeBuffer(this.sdrRendering.get(space)!, 0, data.sdr[space])
      this.renderingGeneration = 0
      if (this.view)
        this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
    }
  }
  private invalidate() {
    this.queue.invalidate()
    this.histogramQueue.invalidate()
    this.requestedStatisticsKey = ''
    this.completedSurface = undefined
    this.canvas.dataset.presentationCacheEligible = 'false'
    this.presentationVersion++
  }
  setPresentationState(state: HdrPresentationState | null) {
    if (!PRESENTATION_CACHE) return
    if (
      state?.revision === this.presentationState?.revision &&
      (!state || sameAdjustments(this.presentationState?.settings, state.settings))
    )
      return
    this.presentationState = state ? structuredClone(state) : null
    this.completedSurface = undefined
    this.canvas.dataset.presentationCacheEligible = 'false'
    this.presentationVersion++
    this.checkCachedIdentity()
    void this.restoreCached()
  }
  private presentationIdentity(snapshot = this.view) {
    const state = this.presentationState,
      frame = this.frame
    if (!PRESENTATION_CACHE || !snapshot || !frame?.hdr || !state) return null
    if (!['before', 'after', 'split'].includes(this.mode)) return null
    return hdrPresentationIdentity({
      confirmed: !this.gesturing && sameAdjustments(state.settings, snapshot.parameters),
      sourceIdentity: frame.identity ?? frame.hdr.sha256,
      sourceSha256: frame.hdr.sha256,
      renderingPolicy: `${HDR_OUTPUT_VERSION}:${HDR_ADJUSTMENT_VERSION}:normal-detail-v1`,
      settingsRevision: state.revision,
      adjustments: snapshot.parameters,
      target: this.target,
      comparison: this.mode as 'before' | 'after' | 'split',
      split: this.split,
      hdrRanges: this.hdrRanges,
      image: snapshot.image,
      viewport: snapshot.viewport,
      view: snapshot.view,
      dpr: window.devicePixelRatio || 1,
    })
  }
  private checkCachedIdentity() {
    if (this.restoredIdentity && this.presentationIdentity()?.key !== this.restoredIdentity)
      this.hideCachedPresentation()
  }
  private hideCachedPresentation() {
    if (!this.restoredIdentity) return
    this.restoredIdentity = undefined
    if (!this.nativePresented) this.canvas.style.visibility = 'hidden'
    this.canvas.dataset.cachedDisplayReady = 'false'
    this.cachedPresentation(false)
  }
  private afterPaint() {
    return new Promise<void>((resolve) => {
      let animation = 0
      const finish = () => {
        cancelAnimationFrame(animation)
        this.abort.signal.removeEventListener('abort', finish)
        resolve()
      }
      if (this.abort.signal.aborted) return finish()
      this.abort.signal.addEventListener('abort', finish, { once: true })
      animation = requestAnimationFrame(() => {
        animation = requestAnimationFrame(finish)
      })
    })
  }
  private restoreCached(): Promise<void> {
    if (this.restoring) return this.restoring
    const identity = this.presentationIdentity()
    const attempt = identity
      ? JSON.stringify([identity.key, this.presentationVersion, this.epoch])
      : ''
    if (
      !identity ||
      !this.device ||
      !this.context ||
      this.nativePresented ||
      this.abort.signal.aborted ||
      this.attemptedRestore === attempt
    )
      return Promise.resolve()
    this.attemptedRestore = attempt
    if (
      hdrPresentationMemory(
        this.frame!.width,
        this.frame!.height,
        identity.width,
        identity.height,
        this.device.limits.maxTextureArrayLayers,
        this.gpuTimings ? HDR_GPU_TIMING_BYTES : 0,
        presentationReservation,
      ).total > HDR_PRESENTATION_BUDGET
    ) {
      this.canvas.dataset.presentationCache = 'memory-bypass'
      return Promise.resolve()
    }
    const lease = presentationCache.acquire(this.device, identity)
    this.canvas.dataset.retainedPresentationBytes = String(presentationCache.bytes)
    if (!lease) {
      this.canvas.dataset.presentationCache = 'miss'
      return Promise.resolve()
    }
    const device = this.device,
      version = this.presentationVersion,
      epoch = this.epoch
    const current = () =>
      !this.abort.signal.aborted &&
      !this.nativePresented &&
      this.device === device &&
      this.presentationVersion === version &&
      this.epoch === epoch &&
      this.presentationIdentity()?.key === identity.key
    const work = (async () => {
      let submitted = false,
        fenced = false
      try {
        this.blit ??= await presentationBlit(device)
        if (!current()) return
        this.canvas.width = identity.width
        this.canvas.height = identity.height
        this.configure(this.target)
        this.configured = `${this.target.mode}:${this.target.colorSpace}`
        const group = device.createBindGroup({
          layout: this.blit.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: lease.surface.createView() }],
        })
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: this.context!.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          })
        pass.setPipeline(this.blit)
        pass.setBindGroup(0, group)
        pass.draw(3)
        pass.end()
        device.queue.submit([encoder.finish()])
        submitted = true
        await device.queue.onSubmittedWorkDone()
        fenced = true
        if (!current()) return
        this.restoredIdentity = identity.key
        this.canvas.style.visibility = 'visible'
        await this.afterPaint()
        if (!current()) {
          this.hideCachedPresentation()
          return
        }
        Object.assign(this.canvas.dataset, {
          presentationCache: 'hit',
          cachedDisplayReady: 'true',
          cachedPresentationSerial: String(lease.serial),
          cachedPostPaintAt: String(performance.now()),
          cachedParameters: JSON.stringify(this.view!.parameters),
          cachedSourceIdentity: this.frame!.identity ?? this.frame!.hdr!.sha256,
          cachedSettingsRevision: String(this.presentationState!.revision),
          cachedTargetGeneration: String(this.target.generation),
          cachedEpoch: String(epoch),
          presentedView: JSON.stringify(this.view!.view),
        })
        this.cachedPresentation(true)
      } catch (error) {
        this.hideCachedPresentation()
        if (!this.abort.signal.aborted) {
          this.canvas.dataset.presentationCache = 'failed'
          this.canvas.dataset.presentationCacheError = String(error).slice(0, 512)
        }
      } finally {
        // A lease remains charged until every submitted read has drained, including cancellation.
        if (submitted && !fenced) await device.queue.onSubmittedWorkDone().catch(() => undefined)
        lease.release()
      }
    })().finally(() => {
      if (this.restoring === work) this.restoring = undefined
      this.canvas.dataset.retainedPresentationBytes = String(presentationCache.bytes)
      if (!this.abort.signal.aborted) void this.restoreCached()
    })
    this.restoring = work
    return work
  }
  setBitmap(bitmap: ImageBitmap) {
    void bitmap /* The SDR proof stays on the previous surface until replacement. */
  }
  setComparison(mode: string, split: number) {
    if (mode !== this.mode || split !== this.split) this.invalidate()
    this.mode = mode
    this.split = split
    this.checkCachedIdentity()
  }
  setHdrRanges(enabled: boolean) {
    if (enabled !== this.hdrRanges) this.invalidate()
    this.hdrRanges = enabled
    this.checkCachedIdentity()
  }
  setTarget(target: DisplayTarget) {
    try {
      validateTarget(target)
      if (target.generation === this.target.generation) return
      this.target = target
      this.invalidate()
      this.checkCachedIdentity()
    } catch (error) {
      this.ready = false
      this.canvas.style.visibility = 'hidden'
      this.lost(`Canvas configuration failed: ${String(error)}`)
      return
    }
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  private prepareRendering() {
    this.renderingGeneration = -1
    this.renderingWorker.postMessage({ content: true })
  }
  private configure(target: DisplayTarget) {
    const previous = this.context!.getConfiguration()
    if (previous?.colorSpace !== target.colorSpace) {
      // Chromium can retain the previous drawing-buffer primaries across configure().
      // An unconfigured reused canvas no longer reports those previous primaries.
      // A same-size reset clears that state before the completed frame is blitted.
      const { width } = this.canvas
      this.canvas.width = width
    }
    this.context!.configure({
      device: this.device!,
      format: 'rgba16float',
      colorSpace: target.colorSpace,
      alphaMode: 'opaque',
      toneMapping: { mode: target.mode === 'hdr' ? 'extended' : 'standard' },
    })
    const config = this.context!.getConfiguration()
    if (
      config?.format !== 'rgba16float' ||
      config.colorSpace !== target.colorSpace ||
      config.toneMapping?.mode !== (target.mode === 'hdr' ? 'extended' : 'standard')
    )
      throw new Error('HDR canvas configuration unavailable.')
  }
  setWorking(frame: WorkingFrame) {
    if (!frame.hdr || this.frame?.identity === frame.identity) return
    this.invalidate()
    this.hideCachedPresentation()
    this.frame = frame
    this.nativePresented = false
    this.attemptedRestore = ''
    this.ready = false
    this.canvas.style.visibility = 'hidden'
    const release = this.activity?.()
    void this.load(frame)
      .catch((error) => {
        console.warn('HDR presentation initialization:', error)
        if (!this.abort.signal.aborted) this.lost(String(error))
      })
      .finally(() => release?.())
  }
  private async load(frame: WorkingFrame) {
    const started = performance.now()
    const device = await hdrDevice()
    if (this.abort.signal.aborted) return
    this.releaseBitmaps = reservePresentationBitmaps(256 * 1024 ** 2)
    this.device = device
    if (PRESENTATION_CACHE && !presentationDevices.has(device)) {
      presentationDevices.add(device)
      void device.lost.then(() => presentationCache.invalidate(device))
    }
    this.deviceObserver = {
      lost: () => {
        if (!this.abort.signal.aborted) {
          this.completedSurface = undefined
          this.hideCachedPresentation()
          this.canvas.style.visibility = 'hidden'
          this.lost('Presentation device lost.')
        }
      },
    }
    observePresenterLoss(device, this.deviceObserver)
    const gpuTimingRequested = import.meta.env.VITE_LUMA_HDR_GPU_TIMINGS === '1'
    this.canvas.dataset.gpuTimings = gpuTimingRequested ? 'unavailable' : 'disabled'
    if (gpuTimingRequested && device.features.has('timestamp-query')) {
      const failed = (reason: string) => {
        if (this.abort.signal.aborted) return
        this.canvas.dataset.gpuTimings = 'error'
        this.canvas.dataset.gpuTimingError = reason
      }
      try {
        this.canvas.dataset.gpuTimings = 'initializing'
        const timings = new HdrGpuTimings(
          device,
          (result) => {
            this.canvas.dataset.gpuFrameTimings = JSON.stringify(result)
          },
          failed,
        )
        this.gpuTimings = timings
        void timings.ready.then((ready) => {
          if (this.abort.signal.aborted || this.gpuTimings !== timings) {
            timings.dispose()
            return
          }
          if (ready) this.canvas.dataset.gpuTimings = 'available'
          else this.gpuTimings = undefined
        })
      } catch (error) {
        failed(String(error))
      }
    }
    this.context = this.canvas.getContext('webgpu') ?? undefined
    if (!this.context) throw new Error('HDR canvas unavailable.')
    this.levels = Math.floor(Math.log2(Math.max(frame.width, frame.height))) + 1
    if (
      hdrPresentationMemory(
        frame.width,
        frame.height,
        0,
        0,
        HDR_CACHE_MAX_TILES,
        this.gpuTimings ? HDR_GPU_TIMING_BYTES : 0,
        presentationReservation,
      ).total > HDR_PRESENTATION_BUDGET
    )
      throw new Error('This HDR frame exceeds the renderer memory limit.')
    if (
      frame.width > device.limits.maxTextureDimension2D ||
      frame.height > device.limits.maxTextureDimension2D
    )
      throw new Error('This HDR frame exceeds the adapter texture dimension limit.')
    device.addEventListener(
      'uncapturederror',
      (event) => {
        console.warn('HDR GPU validation:', event.error.message)
        if (!this.abort.signal.aborted) {
          if (PRESENTATION_CACHE) presentationCache.invalidate(device)
          this.completedSurface = undefined
          this.hideCachedPresentation()
          this.lost(`${event.error.constructor.name}: ${event.error.message}`)
        }
      },
      { signal: this.abort.signal },
    )
    this.context.unconfigure()
    if (PRESENTATION_CACHE) {
      const memory = hdrPresentationMemory(
        frame.width,
        frame.height,
        Math.round((this.view?.viewport.width ?? 0) * (window.devicePixelRatio || 1)),
        Math.round((this.view?.viewport.height ?? 0) * (window.devicePixelRatio || 1)),
        device.limits.maxTextureArrayLayers,
        this.gpuTimings ? HDR_GPU_TIMING_BYTES : 0,
        presentationReservation,
      )
      if (memory.total <= HDR_PRESENTATION_BUDGET) await this.restoreCached()
      if (this.abort.signal.aborted) return
    }
    {
      // The full surface is allocated after upload strips; exact retained surfaces share its budget.
      this.texture = device.createTexture({
        size: [frame.width, frame.height],
        format: 'rgba32float',
        mipLevelCount: this.levels,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.STORAGE_BINDING,
      })
      const loading = performance.now()
      const timings: Record<string, number> = {
        readMs: 0,
        hashMs: 0,
        validateMs: 0,
        writeTextureMs: 0,
      }
      let submitted = 0
      for await (const strip of uploadHdr(frame.hdr!, this.abort.signal)) {
        for (const [key, value] of Object.entries(strip.timings)) timings[key] += value
        const writing = performance.now()
        device.queue.writeTexture(
          { texture: this.texture, origin: [0, strip.row] },
          strip.data,
          { bytesPerRow: frame.width * 16 },
          [frame.width, strip.data.length / (frame.width * 4)],
        )
        timings.writeTextureMs += performance.now() - writing
        if (++submitted % 3 === 0) await device.queue.onSubmittedWorkDone()
      }
      timings.streamMs = performance.now() - loading
      const pipelines = performance.now()
      const mipLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: 'unfilterable-float' },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba32float' },
          },
        ],
      })
      const mip = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
        compute: { module: device.createShaderModule({ code: hdrMipShader }), entryPoint: 'down' },
      })
      if (this.abort.signal.aborted) return
      const encoder = device.createCommandEncoder()
      for (let level = 1; level < this.levels; level++) {
        const group = device.createBindGroup({
          layout: mipLayout,
          entries: [
            {
              binding: 0,
              resource: this.texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
            },
            {
              binding: 1,
              resource: this.texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            },
          ],
        })
        const pass = encoder.beginComputePass()
        pass.setPipeline(mip)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(
          Math.ceil(Math.max(1, frame.width >> level) / 8),
          Math.ceil(Math.max(1, frame.height >> level) / 8),
        )
        pass.end()
      }
      device.queue.submit([encoder.finish()])
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          {
            binding: 3,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'read-only-storage' },
          },
        ],
      })
      this.layout = layout
      const module = device.createShaderModule({ code: hdrShader })
      this.pipeline = await device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      })
      if (this.abort.signal.aborted) return
      this.uniform = device.createBuffer({
        size: 176,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      const tableUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      this.rendering = device.createBuffer({
        size: ACES_DATA_BYTES,
        usage: tableUsage,
      })
      for (const space of ['srgb', 'display-p3'])
        this.sdrRendering.set(
          space,
          device.createBuffer({
            size: ACES_DATA_BYTES,
            usage: tableUsage,
          }),
        )
      this.histogramUniform = device.createBuffer({
        size: 176,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.histogramBuffer = device.createBuffer({
        size: HDR_HISTOGRAM_WORDS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      })
      this.histogramReadback = device.createBuffer({
        size: HDR_HISTOGRAM_WORDS * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      this.histogramPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: hdrHistogramShader }),
          entryPoint: 'sampleHistogram',
        },
      })
      if (this.abort.signal.aborted) return
      this.histogramGroup = device.createBindGroup({
        layout: this.histogramPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.histogramUniform } },
          { binding: 1, resource: this.texture.createView({ mipLevelCount: 1 }) },
          { binding: 4, resource: { buffer: this.rendering } },
          { binding: 6, resource: { buffer: this.histogramBuffer } },
        ],
      })
      this.blit ??= await presentationBlit(device)
      if (this.abort.signal.aborted) return
      const tileSize = hdrPresentationMemory(frame.width, frame.height).tileSize
      this.lookup = device.createBuffer({
        size: Math.ceil(frame.width / tileSize) * Math.ceil(frame.height / tileSize) * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      this.jobs = device.createBuffer({
        size: HDR_CACHE_MAX_TILES * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      this.cacheLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: 'unfilterable-float' },
          },
          {
            binding: 3,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {
              access: 'write-only',
              format: 'rgba32float',
              viewDimension: '2d-array',
            },
          },
          {
            binding: 4,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: 'read-only-storage' },
          },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        ],
      })
      this.cachePipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.cacheLayout] }),
        compute: {
          module: device.createShaderModule({ code: this.cacheKernel.shader }),
          entryPoint: 'renderTile',
        },
      })
      if (this.abort.signal.aborted) return
      if (INTERACTIVE_PRECISION)
        this.interactivePipeline = await device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [this.cacheLayout] }),
          compute: {
            module: device.createShaderModule({
              code: hdrCacheKernel(this.cacheKernel.kind, 'interactive').shader,
            }),
            entryPoint: 'renderTile',
          },
        })
      if (this.abort.signal.aborted) return
      await device.queue.onSubmittedWorkDone()
      timings.pipelinesMs = performance.now() - pipelines
      this.canvas.dataset.loadTimings = JSON.stringify(timings)
    }
    if (this.abort.signal.aborted) return
    this.canvas.dataset.uploadMs = String(performance.now() - started)
    this.canvas.dataset.sourceUploads = String(Number(this.canvas.dataset.sourceUploads ?? 0) + 1)
    this.ready = true
    this.prepareRendering()
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  setEditing(gesturing: boolean, epoch: number) {
    const released = this.gesturing && !gesturing
    if (epoch !== this.epoch || (gesturing && !this.gesturing)) {
      this.invalidate()
      this.refinementPending = false
    }
    this.refinementPending ||= released
    this.epoch = epoch
    this.gesturing = gesturing
    this.checkCachedIdentity()
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    this.view = { image, viewport, view, parameters }
    this.checkCachedIdentity()
    if (PRESENTATION_CACHE) void this.restoreCached()
    if (
      !this.ready ||
      !this.device ||
      !this.context ||
      !this.frame ||
      this.renderingGeneration !== 0 ||
      !viewport.width ||
      !viewport.height
    )
      return
    const editsKey = JSON.stringify(parameters)
    const changed = this.editsKey !== editsKey
    if (changed && !this.gesturing) this.invalidate()
    this.editsKey = editsKey
    this.releaseActivity ??= this.activity?.()
    const intent = this.gesturing
      ? 'interactive'
      : this.refinementPending
        ? 'refinement'
        : changed
          ? 'interactive'
          : 'navigation'
    this.refinementPending = false
    const requestedAt = performance.now()
    const sourceIdentity = this.frame.identity ?? this.frame.hdr!.sha256
    this.queue.request(
      {
        image: { ...image },
        viewport: { ...viewport },
        view: { ...view },
        parameters: structuredClone(parameters),
        target: structuredClone(this.target),
        mode: this.mode,
        split: this.split,
        ranges: this.hdrRanges,
        inputSerial: ++this.inputSerial,
        analysisSamples: this.gesturing ? 8192 : 65536,
        requestedAt,
        sourceIdentity,
        epoch: this.epoch,
        interactivePrecision: INTERACTIVE_PRECISION && this.gesturing && this.mode === 'after',
      },
      intent,
    )
    this.canvas.dataset.requestedParameters = editsKey
    this.canvas.dataset.requestedView = JSON.stringify(view)
    this.canvas.dataset.requestedAt = String(requestedAt)
    this.canvas.dataset.requestedSourceIdentity = sourceIdentity
    this.canvas.dataset.requestedEpoch = String(this.epoch)
    this.canvas.dataset.requestedSerial = String(this.inputSerial)
    this.canvas.dataset.requestIntent = intent
    void this.run()
  }
  private async run() {
    if (this.running) return
    const request = this.queue.take()
    if (!request || this.abort.signal.aborted) return
    this.running = true
    const gpuFrame = this.gpuTimings?.begin(
      request.value.inputSerial,
      request.value.epoch,
      request.value.sourceIdentity,
    )
    let imagePresented = false
    try {
      const rendered = await this.render(request, gpuFrame)
      const present = this.queue.finish(request)
      if (present && rendered && !this.abort.signal.aborted) {
        imagePresented = await this.present(request, rendered, gpuFrame)
      }
    } catch (error) {
      this.queue.finish(request)
      if (!this.abort.signal.aborted) this.lost(`GPU presentation failed: ${String(error)}`)
    } finally {
      this.gpuTimings?.finish(gpuFrame, imagePresented)
    }
    this.running = false
    if (!this.queue.hasPending) {
      this.releaseActivity?.()
      this.releaseActivity = undefined
    }
    if (!this.abort.signal.aborted) void this.run()
  }
  private async render(request: HdrEditRequest<PresentationRequest>, gpuFrame?: HdrGpuTimingFrame) {
    // This mutable offscreen surface is ineligible as soon as another render can write it.
    this.completedSurface = undefined
    this.canvas.dataset.presentationCacheEligible = 'false'
    const startedAt = performance.now()
    const timings: HdrFrameTimings = {
      inputSerial: request.value.inputSerial,
      queueMs: startedAt - request.value.requestedAt,
      planningMs: 0,
      tileSubmissionMs: 0,
      tileFenceMs: 0,
      tileFenceCount: 0,
      tileDispatchCount: 0,
      renderedTiles: 0,
      computedTexels: 0,
      renderSubmissionMs: 0,
      offscreenFenceMs: 0,
      blitSubmissionMs: 0,
      retainedCopyMs: 0,
      finalBlitFenceMs: 0,
      totalMs: 0,
      unattributedMs: 0,
      sourceMip: 0,
      tileSize: 0,
      cacheSlots: 0,
      surfacePixels: 0,
    }
    const { image, viewport, view, parameters, target, mode, split, ranges } = request.value
    const device = this.device!,
      dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    const memory = hdrPresentationMemory(
      this.frame!.width,
      this.frame!.height,
      width,
      height,
      device.limits.maxTextureArrayLayers,
      this.gpuTimings ? HDR_GPU_TIMING_BYTES : 0,
      presentationReservation,
    )
    this.canvas.dataset.allocatedBytes = String(memory.total)
    if (memory.total > HDR_PRESENTATION_BUDGET)
      throw new Error(
        'Presentation memory limit exceeded by the source texture and canvas allocations.',
      )
    if (this.cache?.capacity !== memory.cacheSlots) {
      this.cacheTexture?.destroy()
      this.cache = new HdrRenderCache(memory.cacheSlots)
      this.cacheGroups.clear()
      this.cacheTexture = device.createTexture({
        size: [memory.tileSize + 2, memory.tileSize + 2, memory.cacheSlots],
        format: 'rgba32float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.group = device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 2, resource: { buffer: this.lookup! } },
          { binding: 3, resource: this.cacheTexture.createView({ dimension: '2d-array' }) },
        ],
      })
    }
    const surfaceSize = `${width}:${height}`
    if (surfaceSize !== this.surfaceSize) {
      this.surface?.destroy()
      this.surfaceSize = surfaceSize
      this.surface = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.blitGroup = device.createBindGroup({
        layout: this.blit!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: this.surface.createView() }],
      })
    }
    const p = new Float32Array(44)
    p.set([
      viewport.width,
      viewport.height,
      image.width,
      image.height,
      view.x,
      view.y,
      view.scale,
      dpr,
      parameters.exposureEv,
      parameters.contrast,
      parameters.highlights,
      parameters.shadows,
      parameters.whites,
      parameters.blacks,
      target.mode === 'hdr' ? 10 : 1,
      Number(ranges),
      mode === 'before' ? 1 : mode === 'split' ? 2 : 0,
      split,
      this.levels,
      0,
    ])
    const wb = hdrAdjustmentMatrix(parameters, this.frame!.hdr?.whiteBalance)
    p[19] = Number(!!wb)
    for (let row = 0; row < 3; row++)
      p.set((wb ?? identityMatrix).slice(row * 3, row * 3 + 3), 20 + row * 4)
    p[31] = Number(!!this.frame!.hdr?.source.display)
    p[37] = target.peak
    p[38] = target.colorSpace === 'display-p3' ? 2 : 1
    p[39] = Number(target.mode === 'hdr')
    p[42] = Number(target.headroom !== null)
    p[43] = target.headroom ?? 1
    const neutral =
      !wb &&
      [
        parameters.exposureEv,
        parameters.contrast,
        parameters.highlights,
        parameters.shadows,
        parameters.whites,
        parameters.blacks,
      ].every((v) => v === 0)
    this.cache!.setEdits(JSON.stringify(parameters))
    // Both policies retain the source detail, mip, coordinates and alpha. Only
    // active gesture arithmetic can use the separately versioned approximation.
    const plan = hdrCachePlan(this.frame!, image, viewport, view, mode, split, memory.tileSize)
    plan.variant = target.mode === 'hdr' ? 'content-hdr' : `sdr-${target.colorSpace}`
    const interactivePrecision = request.value.interactivePrecision
    if (interactivePrecision) plan.variant += `:${ACES_INTERACTIVE_PREVIEW_VERSION}`
    const quality = interactivePrecision ? ('interactive' as const) : ('normal' as const)
    p.set([plan.columns, plan.columns * plan.rows, plan.width, plan.height], 32)
    p[40] = plan.level
    const histogramParams = p.slice()
    histogramParams[14] = 10
    histogramParams[36] = Math.min(request.value.analysisSamples, image.width * image.height)
    const statisticsKey = JSON.stringify([
      mode === 'before' ? 'before' : parameters,
      histogramParams[36],
      target.generation,
      target.mode,
      target.colorSpace,
      target.peak,
      target.headroom,
    ])
    timings.sourceMip = plan.level
    timings.tileSize = memory.tileSize
    timings.cacheSlots = memory.cacheSlots
    timings.surfacePixels = width * height
    const surface = this.surface!.createView()
    timings.planningMs = performance.now() - startedAt
    let first = true
    const drawPlan = async (
      selected: typeof plan,
      parameters: Float32Array<ArrayBuffer>,
      table: GPUBuffer,
    ) => {
      const preparing = performance.now()
      device.queue.writeBuffer(this.uniform!, 0, parameters)
      const groupKey =
        selected.level * 3 +
        (table === this.rendering ? 0 : table === this.sdrRendering.get('srgb') ? 1 : 2)
      let cacheGroup = this.cacheGroups.get(groupKey)
      if (!cacheGroup) {
        cacheGroup = device.createBindGroup({
          layout: this.cacheLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.uniform! } },
            {
              binding: 1,
              resource: this.texture!.createView({
                baseMipLevel: selected.level,
                mipLevelCount: 1,
              }),
            },
            { binding: 3, resource: this.cacheTexture!.createView({ dimension: '2d-array' }) },
            { binding: 4, resource: { buffer: table } },
            { binding: 5, resource: { buffer: this.jobs! } },
          ],
        })
        this.cacheGroups.set(groupKey, cacheGroup)
      }
      timings.planningMs += performance.now() - preparing
      for (const batch of this.cache!.batches(selected, neutral)) {
        device.queue.writeBuffer(this.lookup!, 0, batch.lookup)
        for (let start = 0; start < batch.jobs.length; start += HDR_TILE_BATCH * 4) {
          const jobs = batch.jobs.subarray(start, start + HDR_TILE_BATCH * 4)
          const submitting = performance.now()
          device.queue.writeBuffer(this.jobs!, 0, jobs)
          const computation = device.createCommandEncoder()
          const compute = computation.beginComputePass({
            timestampWrites: this.gpuTimings?.writes(gpuFrame, 'tile'),
          })
          compute.setPipeline(
            interactivePrecision ? this.interactivePipeline! : this.cachePipeline!,
          )
          compute.setBindGroup(0, cacheGroup)
          compute.dispatchWorkgroups(
            ...this.cacheKernel.dispatch(memory.tileSize + 2, jobs.length / 4),
          )
          compute.end()
          this.renderedTiles += jobs.length / 4
          device.queue.submit([computation.finish()])
          timings.tileSubmissionMs += performance.now() - submitting
          timings.tileDispatchCount++
          timings.renderedTiles += jobs.length / 4
          timings.computedTexels += ((memory.tileSize + 2) ** 2 * jobs.length) / 4
          // The last compute chunk and its render share one completion fence.
          // Each candidate retains an explicit bounded cancellation checkpoint.
          if (start + jobs.length < batch.jobs.length) {
            const fencing = performance.now()
            await device.queue.onSubmittedWorkDone()
            timings.tileFenceMs += performance.now() - fencing
            timings.tileFenceCount++
            if (this.abort.signal.aborted || this.queue.superseded(request)) {
              const unfinished = new Set<number>()
              for (let i = start + jobs.length + 2; i < batch.jobs.length; i += 4)
                unfinished.add(batch.jobs[i])
              this.cache!.discardSlots(unfinished)
              return false
            }
          }
        }
        const submitting = performance.now()
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
          timestampWrites: this.gpuTimings?.writes(gpuFrame, 'offscreen'),
          colorAttachments: [
            {
              view: surface,
              loadOp: first ? 'clear' : 'load',
              storeOp: 'store',
              clearValue: [0.059, 0.063, 0.067, 1],
            },
          ],
        })
        pass.setPipeline(this.pipeline!)
        pass.setBindGroup(0, this.group!)
        pass.draw(3)
        pass.end()
        device.queue.submit([encoder.finish()])
        timings.renderSubmissionMs += performance.now() - submitting
        first = false
        // Queue order protects lookup buffers and reused cache slots. The final
        // image fence is independent of histogram readback.
        if (this.abort.signal.aborted || this.queue.superseded(request)) return false
      }
      return true
    }
    if (target.mode === 'sdr') p[15] = 0
    if (
      !(await drawPlan(
        plan,
        p,
        target.mode === 'hdr' ? this.rendering! : this.sdrRendering.get(target.colorSpace)!,
      ))
    )
      return undefined
    if (ranges && target.mode === 'sdr') {
      const rangeParams = p.slice()
      rangeParams[14] = 10
      rangeParams[41] = 1
      const rangeVariant = interactivePrecision
        ? `content-hdr:${ACES_INTERACTIVE_PREVIEW_VERSION}`
        : 'content-hdr'
      if (!(await drawPlan({ ...plan, variant: rangeVariant }, rangeParams, this.rendering!)))
        return undefined
    }
    if (this.abort.signal.aborted) return undefined
    // Presentation has its own completion boundary; mapping an unrelated analysis
    // buffer must never delay an already sharp completed image.
    const fencing = performance.now()
    await device.queue.onSubmittedWorkDone()
    timings.offscreenFenceMs = performance.now() - fencing
    return {
      startedAt,
      timings,
      quality,
      histogram: { key: statisticsKey, parameters: histogramParams, presentation: request.value },
    } satisfies RenderedPresentation
  }

  private async present(
    request: HdrEditRequest<PresentationRequest>,
    rendered: RenderedPresentation,
    gpuFrame?: HdrGpuTimingFrame,
  ) {
    if (this.restoring) await this.restoring
    if (this.abort.signal.aborted || this.queue.superseded(request)) return false
    const { viewport, view, parameters, target, mode, ranges, inputSerial } = request.value
    const { timings } = rendered
    const submitting = performance.now()
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    const configured = `${target.mode}:${target.colorSpace}`
    if (configured !== this.configured) {
      this.configure(target)
      this.configured = configured
    }
    const encoder = this.device!.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      timestampWrites: this.gpuTimings?.writes(gpuFrame, 'blit'),
      colorAttachments: [
        { view: this.context!.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    })
    pass.setPipeline(this.blit!)
    pass.setBindGroup(0, this.blitGroup!)
    pass.draw(3)
    pass.end()
    this.device!.queue.submit([encoder.finish()])
    timings.blitSubmissionMs = performance.now() - submitting
    // Copy before Chromium can expire the drawing buffer, then fence the image's
    // final blit explicitly. Analysis readback remains independently scheduled.
    const copying = performance.now()
    this.retainCompletedFrame()
    timings.retainedCopyMs = performance.now() - copying
    const fencing = performance.now()
    await this.device!.queue.onSubmittedWorkDone()
    timings.finalBlitFenceMs = performance.now() - fencing
    if (this.abort.signal.aborted || this.queue.superseded(request)) return false
    // These elapsed CPU stages include scheduling/queue waits, not hardware timestamps.
    timings.totalMs = performance.now() - rendered.startedAt
    timings.unattributedMs = Math.max(
      0,
      timings.totalMs -
        timings.planningMs -
        timings.tileSubmissionMs -
        timings.tileFenceMs -
        timings.renderSubmissionMs -
        timings.offscreenFenceMs -
        timings.blitSubmissionMs -
        timings.retainedCopyMs -
        timings.finalBlitFenceMs,
    )
    this.canvas.dataset.frameTimings = JSON.stringify(timings)
    this.canvas.style.visibility = 'visible'
    Object.assign(this.canvas.dataset, {
      renderedTiles: String(this.renderedTiles),
      cachedTiles: String(this.cache!.size),
      cacheBytes: String(
        hdrPresentationMemory(
          this.frame!.width,
          this.frame!.height,
          width,
          height,
          this.device!.limits.maxTextureArrayLayers,
          this.gpuTimings ? HDR_GPU_TIMING_BYTES : 0,
          presentationReservation,
        ).cacheBytes,
      ),
      presentationSerial: String(Number(this.canvas.dataset.presentationSerial ?? 0) + 1),
      completedEditSerial: String(inputSerial),
      presentedSourceIdentity: request.value.sourceIdentity,
      presentedEpoch: String(request.value.epoch),
      displayedAnalysisKey: rendered.histogram.key,
      quality: rendered.quality,
      presentedPolicy:
        rendered.quality === 'interactive' ? ACES_INTERACTIVE_PREVIEW_VERSION : 'reference',
      presentationIntent: request.intent,
      targetGeneration: String(target.generation),
      editing: 'ready',
      exposure: String(parameters.exposureEv),
      contrast: String(parameters.contrast),
      highlights: String(parameters.highlights),
      shadows: String(parameters.shadows),
      whites: String(parameters.whites),
      blacks: String(parameters.blacks),
      whiteBalance: JSON.stringify(parameters.whiteBalance),
      comparison: mode,
      hdrRanges: String(ranges),
      nativeEditingReadyAt: String(performance.now()),
      presentedView: JSON.stringify(view),
    })
    this.nativePresented = true
    this.hideCachedPresentation()
    const completedIdentity = this.presentationIdentity(request.value)
    if (rendered.quality === 'normal' && completedIdentity) {
      this.completedSurface = {
        surface: this.surface!,
        identity: completedIdentity,
        serial: Number(this.canvas.dataset.presentationSerial),
      }
    }
    this.canvas.dataset.presentationCacheEligible = String(!!this.completedSurface)
    if (this.retainedCanvas)
      this.retainedCanvas.dataset.presentationSerial = this.canvas.dataset.presentationSerial
    this.loaded()
    this.requestHistogram(rendered.histogram)
    return true
  }
  private requestHistogram(snapshot: HistogramRequest) {
    if (snapshot.key === this.publishedStatisticsKey) {
      this.histogramQueue.invalidate()
      this.requestedStatisticsKey = snapshot.key
      this.canvas.dataset.analysisPending = 'false'
      this.statisticsPending(false)
      return
    }
    if (snapshot.key === this.statisticsCache?.key) {
      this.histogramQueue.invalidate()
      this.requestedStatisticsKey = ''
      this.publishHistogram(snapshot, this.statisticsCache.result)
      return
    }
    if (snapshot.key === this.requestedStatisticsKey) return
    this.requestedStatisticsKey = snapshot.key
    this.histogramQueue.request(snapshot, 'interactive')
    this.canvas.dataset.analysisPending = 'true'
    this.statisticsPending(true)
    this.releaseHistogramActivity ??= this.activity?.()
    void this.runHistogram()
  }
  private async runHistogram() {
    const request = this.histogramQueue.take()
    if (!request || this.abort.signal.aborted) return
    const { parameters, presentation, key } = request.value
    const frame = this.frame!
    const device = this.device!
    let mapped = false
    try {
      device.queue.writeBuffer(this.histogramUniform!, 0, parameters)
      const encoder = device.createCommandEncoder()
      encoder.clearBuffer(this.histogramBuffer!)
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.histogramPipeline!)
      pass.setBindGroup(0, this.histogramGroup!)
      pass.dispatchWorkgroups(Math.ceil(parameters[36] / 64))
      pass.end()
      encoder.copyBufferToBuffer(
        this.histogramBuffer!,
        0,
        this.histogramReadback!,
        0,
        HDR_HISTOGRAM_WORDS * 4,
      )
      device.queue.submit([encoder.finish()])
      await this.histogramReadback!.mapAsync(GPUMapMode.READ)
      mapped = true
      const result = readHdrHistogram(
        new Uint32Array(this.histogramReadback!.getMappedRange()),
        presentation.target,
        frame.hdr!,
        presentation.inputSerial,
      )
      if (this.histogramQueue.finish(request) && !this.abort.signal.aborted) {
        this.statisticsCache = { key, result }
        this.publishHistogram(request.value, result)
      }
    } catch (error) {
      this.histogramQueue.finish(request)
      if (!this.abort.signal.aborted) this.lost(`GPU histogram failed: ${String(error)}`)
    } finally {
      if (mapped) this.histogramReadback!.unmap()
      if (!this.histogramQueue.hasPending) {
        this.releaseHistogramActivity?.()
        this.releaseHistogramActivity = undefined
      }
      if (!this.abort.signal.aborted) void this.runHistogram()
    }
  }
  private publishHistogram(snapshot: HistogramRequest, result: HdrStatistics) {
    const { parameters, mode, inputSerial } = snapshot.presentation
    if (inputSerial < this.publishedStatisticsSerial) return
    this.publishedStatisticsSerial = inputSerial
    this.publishedStatisticsKey = snapshot.key
    this.canvas.dataset.analysisSerial = String(inputSerial)
    this.canvas.dataset.analysisKey = snapshot.key
    const pending = snapshot.key !== this.requestedStatisticsKey && !!this.requestedStatisticsKey
    this.canvas.dataset.analysisPending = String(pending)
    this.statisticsPending(pending)
    const statistics = { ...result, editSerial: inputSerial }
    retainHdrContent(
      this.frame!.hdr!.sha256,
      mode === 'before' ? neutralAdjustments : parameters,
      statistics,
    )
    this.statistics(statistics)
  }

  private retainCompletedFrame() {
    const surface = this.retainedCanvas
    if (!surface) return
    const scale = Math.min(1, 1024 / Math.max(this.canvas.width, this.canvas.height))
    const width = Math.max(1, Math.round(this.canvas.width * scale)),
      height = Math.max(1, Math.round(this.canvas.height * scale))
    if (surface.width !== width || surface.height !== height) {
      surface.width = width
      surface.height = height
    }
    const context = surface.getContext('2d', { willReadFrequently: true })!
    context.drawImage(this.canvas, 0, 0, width, height)
    // Complete the copy before the WebGPU drawing buffer expires or is lost.
    // The retained surface is at most 4 MiB and never enters analysis.
    context.getImageData(0, 0, 1, 1)
    surface.dataset.presentationSerial = this.canvas.dataset.presentationSerial
  }
  dispose() {
    this.releaseActivity?.()
    this.releaseActivity = undefined
    this.releaseHistogramActivity?.()
    this.releaseHistogramActivity = undefined
    this.abort.abort()
    if (this.deviceObserver) this.deviceObserver.lost = undefined
    this.hideCachedPresentation()
    this.statisticsPending(false)
    this.releaseBitmaps?.()
    this.ready = false
    this.texture?.destroy()
    this.cacheTexture?.destroy()
    this.lookup?.destroy()
    this.jobs?.destroy()
    this.gpuTimings?.dispose()
    this.uniform?.destroy()
    this.rendering?.destroy()
    for (const buffer of this.sdrRendering.values()) buffer.destroy()
    this.histogramUniform?.destroy()
    this.histogramBuffer?.destroy()
    this.histogramReadback?.destroy()
    const completed = this.completedSurface
    if (
      PRESENTATION_CACHE &&
      this.device &&
      completed &&
      !this.running &&
      !this.queue.hasPending &&
      !this.restoring &&
      completed.surface === this.surface &&
      this.presentationIdentity()?.key === completed.identity.key &&
      presentationCache.retain(this.device, completed.identity, {
        surface: completed.surface,
        width: completed.identity.width,
        height: completed.identity.height,
        completed: true,
        quality: 'normal',
        transient: false,
        serial: completed.serial,
      })
    )
      this.surface = undefined
    this.surface?.destroy()
    this.canvas.dataset.retainedPresentationBytes = String(presentationCache.bytes)
    this.invalidate()
    this.renderingWorker.terminate()
    this.context?.unconfigure()
  }
}
