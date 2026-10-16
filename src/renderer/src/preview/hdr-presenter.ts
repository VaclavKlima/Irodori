import { hdrPresentationMemory, HDR_PRESENTATION_BUDGET } from './hdr-memory'
import { reservePresentationBitmaps } from './frame-cache'
import { hdrAdjustmentMatrix, validateTarget, type DisplayTarget } from '../../../shared/hdr'
import { identityMatrix } from '../../../shared/white-balance'
import {
  neutralAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
import { retainHdrContent } from './hdr-sample'
import type { Size, View } from './geometry'
import { hdrDevice } from './hdr-device'
import { uploadHdr } from './hdr-upload'
import { hdrShader, hdrMipShader, hdrCacheShader } from './hdr-shader'
import { ACES_DATA_BYTES } from '../../../shared/aces-data'
import { hdrCachePlan, HdrRenderCache, HDR_CACHE_MAX_TILES } from './hdr-render-cache'
import { HdrEditQueue, type HdrEditRequest } from './hdr-edit-queue'
import { hdrHistogramShader, HDR_HISTOGRAM_WORDS, readHdrHistogram } from './hdr-histogram'
import type { HdrStatistics } from '../../../shared/hdr-statistics'

// Paired application trials retain the bounded 32-tile default; eight remains an internal comparison.
const HDR_TILE_BATCH = import.meta.env.VITE_LUMA_HDR_TILE_BATCH === '8' ? 8 : 32

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
}
interface HistogramRequest {
  key: string
  parameters: Float32Array<ArrayBuffer>
  presentation: PresentationRequest
}
interface RenderedPresentation {
  startedAt: number
  timings: HdrFrameTimings
  quality: 'normal'
  histogram: HistogramRequest
}

export class HdrPresenter {
  private abort = new AbortController()
  private device?: GPUDevice
  private context?: GPUCanvasContext
  private texture?: GPUTexture
  private uniform?: GPUBuffer
  private pipeline?: GPURenderPipeline
  private group?: GPUBindGroup
  private layout?: GPUBindGroupLayout
  private cacheLayout?: GPUBindGroupLayout
  private cachePipeline?: GPUComputePipeline
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
  constructor(
    private canvas: HTMLCanvasElement,
    private target: DisplayTarget,
    private lost: (reason: string) => void,
    private loaded: () => void,
    private statistics: (result: HdrStatistics) => void = () => undefined,
    private retainedCanvas?: HTMLCanvasElement,
    private activity?: () => () => void,
    private statisticsPending: (pending: boolean) => void = () => undefined,
  ) {
    canvas.dataset.backend = 'webgpu-hdr'
    canvas.dataset.tileBatch = String(HDR_TILE_BATCH)
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
  }
  setBitmap(bitmap: ImageBitmap) {
    void bitmap /* The SDR proof stays on the previous surface until replacement. */
  }
  setComparison(mode: string, split: number) {
    if (mode !== this.mode || split !== this.split) this.invalidate()
    this.mode = mode
    this.split = split
  }
  setHdrRanges(enabled: boolean) {
    if (enabled !== this.hdrRanges) this.invalidate()
    this.hdrRanges = enabled
  }
  setTarget(target: DisplayTarget) {
    try {
      validateTarget(target)
      if (target.generation === this.target.generation) return
      this.target = target
      this.invalidate()
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
    this.frame = frame
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
    this.context = this.canvas.getContext('webgpu') ?? undefined
    if (!this.context) throw new Error('HDR canvas unavailable.')
    this.levels = Math.floor(Math.log2(Math.max(frame.width, frame.height))) + 1
    if (hdrPresentationMemory(frame.width, frame.height).total > HDR_PRESENTATION_BUDGET)
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
        if (!this.abort.signal.aborted)
          this.lost(`${event.error.constructor.name}: ${event.error.message}`)
      },
      { signal: this.abort.signal },
    )
    {
      // The previous surface may be large. Allocate it only after upload strips are released.
      this.context.unconfigure()
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
      this.rendering = device.createBuffer({
        size: ACES_DATA_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      for (const space of ['srgb', 'display-p3'])
        this.sdrRendering.set(
          space,
          device.createBuffer({
            size: ACES_DATA_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
      this.histogramGroup = device.createBindGroup({
        layout: this.histogramPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.histogramUniform } },
          { binding: 1, resource: this.texture.createView({ mipLevelCount: 1 }) },
          { binding: 4, resource: { buffer: this.rendering } },
          { binding: 6, resource: { buffer: this.histogramBuffer } },
        ],
      })
      const blitModule = device.createShaderModule({
        code: `
        @group(0) @binding(0) var image:texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
          let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.);
        }
        @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f { return textureLoad(image,vec2i(p.xy),0); }
      `,
      })
      this.blit = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: blitModule, entryPoint: 'vs' },
        fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      })
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
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        ],
      })
      this.cachePipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.cacheLayout] }),
        compute: {
          module: device.createShaderModule({ code: hdrCacheShader }),
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
    void device.lost.then(() => {
      if (!this.abort.signal.aborted) {
        this.canvas.style.visibility = 'hidden'
        this.lost('Presentation device lost.')
      }
    })
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
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    this.view = { image, viewport, view, parameters }
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
        requestedAt: performance.now(),
      },
      intent,
    )
    this.canvas.dataset.requestedParameters = editsKey
    this.canvas.dataset.requestedSerial = String(this.inputSerial)
    this.canvas.dataset.requestIntent = intent
    void this.run()
  }
  private async run() {
    if (this.running) return
    const request = this.queue.take()
    if (!request || this.abort.signal.aborted) return
    this.running = true
    try {
      const rendered = await this.render(request)
      const present = this.queue.finish(request)
      if (present && rendered && !this.abort.signal.aborted) {
        await this.present(request, rendered)
      }
    } catch (error) {
      this.queue.finish(request)
      if (!this.abort.signal.aborted) this.lost(`GPU presentation failed: ${String(error)}`)
    }
    this.running = false
    if (!this.queue.hasPending) {
      this.releaseActivity?.()
      this.releaseActivity = undefined
    }
    if (!this.abort.signal.aborted) void this.run()
  }
  private async render(request: HdrEditRequest<PresentationRequest>) {
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
    // Coalesce input requests instead of lowering source detail. Cached navigation
    // and interactive edits use the same mip/texel, coordinate and alpha policy.
    const plan = hdrCachePlan(this.frame!, image, viewport, view, mode, split, memory.tileSize)
    plan.variant = target.mode === 'hdr' ? 'content-hdr' : `sdr-${target.colorSpace}`
    const quality = 'normal' as const
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
        (selected.variant === 'content-hdr' ? 0 : target.colorSpace === 'srgb' ? 1 : 2)
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
          const compute = computation.beginComputePass()
          compute.setPipeline(this.cachePipeline!)
          compute.setBindGroup(0, cacheGroup)
          compute.dispatchWorkgroups(
            Math.ceil((memory.tileSize + 2) / 8),
            Math.ceil((memory.tileSize + 2) / 8),
            jobs.length / 4,
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
      if (!(await drawPlan({ ...plan, variant: 'content-hdr' }, rangeParams, this.rendering!)))
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
  ) {
    const { viewport, parameters, target, mode, ranges, inputSerial } = request.value
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
    if (this.abort.signal.aborted || this.queue.superseded(request)) return
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
        ).cacheBytes,
      ),
      presentationSerial: String(Number(this.canvas.dataset.presentationSerial ?? 0) + 1),
      completedEditSerial: String(inputSerial),
      displayedAnalysisKey: rendered.histogram.key,
      quality: rendered.quality,
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
    })
    if (this.retainedCanvas)
      this.retainedCanvas.dataset.presentationSerial = this.canvas.dataset.presentationSerial
    this.loaded()
    this.requestHistogram(rendered.histogram)
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
    this.statisticsPending(false)
    this.releaseBitmaps?.()
    this.ready = false
    this.texture?.destroy()
    this.cacheTexture?.destroy()
    this.lookup?.destroy()
    this.jobs?.destroy()
    this.uniform?.destroy()
    this.rendering?.destroy()
    for (const buffer of this.sdrRendering.values()) buffer.destroy()
    this.histogramUniform?.destroy()
    this.histogramBuffer?.destroy()
    this.histogramReadback?.destroy()
    this.surface?.destroy()
    this.invalidate()
    this.renderingWorker.terminate()
    this.context?.unconfigure()
  }
}
