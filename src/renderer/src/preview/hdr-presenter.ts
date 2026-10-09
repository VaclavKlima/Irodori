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

interface PresentationRequest {
  image: Size
  viewport: Size
  view: View
  parameters: AdjustmentParameters
  target: DisplayTarget
  mode: string
  split: number
  ranges: boolean
  refinement: boolean
  inputSerial: number
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
  private gesturing = false
  private epoch = -1
  private inputSerial = 0
  private editsKey = ''
  private statisticsCache?: { key: string; result: HdrStatistics }
  private renderingWorker = new Worker(new URL('./display-rendering-worker.ts', import.meta.url), {
    type: 'module',
  })
  private frame?: WorkingFrame
  private mode = 'after'
  private split = 0.5
  private hdrRanges = false
  private levels = 1
  private ready = false
  private releaseBitmaps?: () => void
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  constructor(
    private canvas: HTMLCanvasElement,
    private target: DisplayTarget,
    private lost: (reason: string) => void,
    private loaded: () => void,
    private statistics: (result: HdrStatistics) => void = () => undefined,
    private retainedCanvas?: HTMLCanvasElement,
  ) {
    canvas.dataset.backend = 'webgpu-hdr'
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
  setBitmap(bitmap: ImageBitmap) {
    void bitmap /* The SDR proof stays on the previous surface until replacement. */
  }
  setComparison(mode: string, split: number) {
    this.mode = mode
    this.split = split
  }
  setHdrRanges(enabled: boolean) {
    this.hdrRanges = enabled
  }
  setTarget(target: DisplayTarget) {
    try {
      validateTarget(target)
      if (target.generation === this.target.generation) return
      this.target = target
      this.queue.invalidate()
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
    this.frame = frame
    this.ready = false
    this.canvas.style.visibility = 'hidden'
    void this.load(frame).catch((error) => {
      console.warn('HDR presentation initialization:', error)
      if (!this.abort.signal.aborted) this.lost(String(error))
    })
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
    if (epoch !== this.epoch || (gesturing && !this.gesturing)) this.queue.invalidate()
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
    this.editsKey = editsKey
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
        refinement: !this.gesturing && !changed,
        inputSerial: ++this.inputSerial,
      },
      this.gesturing || changed,
    )
    this.canvas.dataset.requestedSerial = String(this.inputSerial)
    void this.run()
  }
  private async run() {
    const request = this.queue.take()
    if (!request || this.abort.signal.aborted) return
    try {
      const statistics = await this.render(request)
      const present = this.queue.finish(request)
      if (present && !this.abort.signal.aborted) {
        this.present(request, statistics)
        if (
          !this.gesturing &&
          !request.value.refinement &&
          !this.queue.hasPending &&
          request.value.inputSerial === this.inputSerial
        )
          this.queue.request({ ...request.value, refinement: true }, false)
      }
    } catch (error) {
      this.queue.finish(request)
      if (!this.abort.signal.aborted) this.lost(`GPU presentation failed: ${String(error)}`)
    }
    if (!this.abort.signal.aborted) void this.run()
  }
  private async render(request: HdrEditRequest<PresentationRequest>) {
    const { image, viewport, view, parameters, target, mode, split, ranges, refinement } =
      request.value
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
    // Drafts evaluate a bounded source footprint. Native geometry remains unchanged.
    const visible =
      Math.min(image.width, viewport.width / view.scale) *
      Math.min(image.height, viewport.height / view.scale)
    const draftLevel = Math.max(0, Math.ceil(Math.log2(Math.max(1, visible / 8192)) / 2))
    const plan = hdrCachePlan(
      this.frame!,
      image,
      viewport,
      view,
      mode,
      split,
      memory.tileSize,
      refinement ? 0 : draftLevel,
    )
    plan.variant = target.mode === 'hdr' ? 'content-hdr' : `sdr-${target.colorSpace}`
    p.set([plan.columns, plan.columns * plan.rows, plan.width, plan.height], 32)
    p[40] = plan.level
    const histogramParams = p.slice()
    histogramParams[14] = 10
    histogramParams[36] = Math.min(request.draft ? 8192 : 65536, image.width * image.height)
    const statisticsKey = JSON.stringify([
      mode === 'before' ? 'before' : parameters,
      histogramParams[36],
      target.generation,
      target.mode,
      target.colorSpace,
      target.peak,
      target.headroom,
    ])
    const analyze = this.statisticsCache?.key !== statisticsKey
    if (analyze) {
      device.queue.writeBuffer(this.histogramUniform!, 0, histogramParams)
      const analysis = device.createCommandEncoder()
      analysis.clearBuffer(this.histogramBuffer!)
      const histogram = analysis.beginComputePass()
      histogram.setPipeline(this.histogramPipeline!)
      histogram.setBindGroup(0, this.histogramGroup!)
      histogram.dispatchWorkgroups(Math.ceil(histogramParams[36] / 64))
      histogram.end()
      analysis.copyBufferToBuffer(
        this.histogramBuffer!,
        0,
        this.histogramReadback!,
        0,
        HDR_HISTOGRAM_WORDS * 4,
      )
      device.queue.submit([analysis.finish()])
    }
    const surface = this.surface!.createView()
    let first = true
    const drawPlan = async (
      selected: typeof plan,
      parameters: Float32Array<ArrayBuffer>,
      table: GPUBuffer,
    ) => {
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
      for (const batch of this.cache!.batches(selected, neutral)) {
        device.queue.writeBuffer(this.lookup!, 0, batch.lookup)
        for (let start = 0; start < batch.jobs.length; start += 8 * 4) {
          const jobs = batch.jobs.subarray(start, start + 8 * 4)
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
          await device.queue.onSubmittedWorkDone()
          if (this.abort.signal.aborted || this.queue.superseded(request)) {
            const unfinished = new Set<number>()
            for (let i = start + jobs.length + 2; i < batch.jobs.length; i += 4)
              unfinished.add(batch.jobs[i])
            this.cache!.discardSlots(unfinished)
            return false
          }
        }
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
        first = false
        await device.queue.onSubmittedWorkDone()
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
    await device.queue.onSubmittedWorkDone()
    if (this.abort.signal.aborted) return undefined
    if (analyze) {
      await this.histogramReadback!.mapAsync(GPUMapMode.READ)
      const result = readHdrHistogram(
        new Uint32Array(this.histogramReadback!.getMappedRange()),
        target,
        this.frame!.hdr!,
        request.value.inputSerial,
      )
      this.histogramReadback!.unmap()
      this.statisticsCache = { key: statisticsKey, result }
    }
    const statistics = { ...this.statisticsCache!.result, editSerial: request.value.inputSerial }
    return statistics
  }
  private present(request: HdrEditRequest<PresentationRequest>, statistics?: HdrStatistics) {
    const { viewport, parameters, target, mode, ranges, refinement, inputSerial } = request.value
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
      quality: refinement ? 'normal' : 'draft',
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
    this.retainCompletedFrame()
    this.loaded()
    if (statistics) {
      retainHdrContent(
        this.frame!.hdr!.sha256,
        mode === 'before' ? neutralAdjustments : parameters,
        statistics,
      )
      this.statistics(statistics)
    }
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
    this.abort.abort()
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
    this.queue.invalidate()
    this.renderingWorker.terminate()
    this.context?.unconfigure()
  }
}
