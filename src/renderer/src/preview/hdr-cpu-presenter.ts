import { publishHdrSample, selectHdrSampleSources } from './hdr-sample'
import { checkedHdrComparison } from './hdr-comparison-source'
import { imageResourceOwners } from './image-resource-owners'
import {
  sameAdjustments,
  neutralAdjustments,
  type WorkingFrame,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
import type { DisplayTarget } from '../../../shared/hdr'
import type { CpuPreviewPair } from '../../../shared/native-cpu-preview'
import type { Size, View } from './geometry'
import { reservePresentationBitmaps } from './frame-cache'
import type { HdrPresentationState } from './hdr-presenter'
import {
  captureHdrPreviewRetirement,
  retainHdrPreviewRetirement,
  prepareHdrCpuFallback,
} from './hdr-preview-resources'
import { NativeCpuClient, type CpuClientReply } from './native-cpu-client'
import {
  sameMaskFrame,
  maskPixelTarget,
  type NativeMaskReservation,
} from './native-mask-reservation'
type CpuReply = Partial<CpuClientReply> & {
  generation: number
  beforeSha256?: string
  error?: string
}
type CpuBackend = 'native' | 'javascript'

export class HdrCpuPresenter {
  private readonly imageOwner: ReturnType<typeof imageResourceOwners.register>
  private imageBytes() {
    const memory = this.native?.memory
    if (memory) return { ramBytes: memory.peak.ramBytes, vramBytes: memory.peak.gpuBytes }
    // Unsupported-platform JS fallback: full source/bitmap construction and canvas mirrors.
    const source = this.frame ? this.frame.width * this.frame.height : 0,
      canvas = this.canvas.width * this.canvas.height,
      beforeSamples = this.comparisonFrame
        ? (Math.min(65536, source) + Math.min(8192, source)) * 16
        : 0
    return {
      ramBytes: source * 48 + beforeSamples + canvas * 32,
      vramBytes: source * 8 + canvas * 32,
    }
  }
  private worker?: Worker
  private native?: NativeCpuClient
  private backendReady: Promise<void>
  private retired = Promise.resolve()
  private disposed = false
  private retirementAbort = new AbortController()
  get whenDisposed() {
    return this.retired
  }
  private context: CanvasRenderingContext2D
  private frame?: WorkingFrame
  private comparisonInput?: WorkingFrame
  private comparisonFrame?: WorkingFrame
  private comparisonRequired = false
  private bitmap?: ImageBitmap
  private completedParameters?: AdjustmentParameters
  private completedRanges = false
  private completedNative?: CpuPreviewPair
  private completedTarget?: DisplayTarget
  private maskKey?: string
  /** Retry hint from actual pixel publication; never authorizes source/edits. */
  get maskPublicationKey(): string | undefined {
    return this.maskKey
  }
  private neutral?: ImageBitmap
  private generation = 0
  private key = ''
  private mode = 'after'
  private split = 0.5
  private hdrRanges = false
  private target?: DisplayTarget
  private release = reservePresentationBitmaps(256 * 1024 ** 2)
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  private releaseActivity?: () => void
  private presentationState?: HdrPresentationState | null
  private nativePresented = false
  private fullBlocked = false
  private maskResizeWork?: Promise<void>
  reserveMask(
    frame: WorkingFrame,
    cancel: () => void,
    drained: Promise<void>,
  ): NativeMaskReservation | undefined {
    const selected = this.mode === 'before' ? (this.comparisonFrame ?? this.frame) : this.frame
    if (this.disposed || this.comparisonMissing() || !sameMaskFrame(selected, frame))
      return undefined
    return this.native?.reserveMask(frame, cancel, drained)
  }
  private drainMaskForResize() {
    if (!this.native?.hasMaskReservation || this.maskResizeWork) return
    const work = this.native.cancelMasks().then(() => {
      if (this.maskResizeWork === work) this.maskResizeWork = undefined
      if (!this.disposed && this.view)
        this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
    })
    this.maskResizeWork = work
    void work.catch(() => undefined)
  }
  constructor(
    private canvas: HTMLCanvasElement,
    private loaded: () => void,
    private failed: () => void,
    private activity?: () => () => void,
    retirement = Promise.resolve(),
    selectBackend: () => CpuBackend | Promise<CpuBackend> = () =>
      window.irodori.getCpuPreviewBackend(),
    private readonly limitation?: (fullBlocked: boolean) => void,
  ) {
    const context = canvas.getContext('2d', { colorSpace: 'srgb' })
    if (!context) throw new Error('CPU presentation unavailable.')
    this.context = context
    this.imageOwner = imageResourceOwners.register(() => this.imageBytes())
    this.resetPublication()
    canvas.dataset.backend = 'canvas2d-hdr-sdr'
    canvas.dataset.fullBlocked = 'false'
    // Snapshot synchronously, before backend lookup or this owner's retirement
    // registration. A later GPU owner must wait us; we must never await ourselves.
    const priorPreviewOwners = captureHdrPreviewRetirement()
    void priorPreviewOwners.catch(() => undefined)
    this.backendReady = (async () => {
      // Production always uses main's explicit platform policy. Pure fixtures
      // inject a synchronous backend; an absent real bridge is a visible failure.
      const selection = selectBackend()
      const backend = typeof selection === 'string' ? selection : await selection
      if (this.disposed) return
      if (backend === 'native') {
        this.canvas.dataset.cpuRenderer = 'native'
        const prerequisite = prepareHdrCpuFallback(
          Promise.all([retirement, priorPreviewOwners]).then(() => undefined),
          this.retirementAbort.signal,
        )
        // Preparation is eager and may reject before a first render is posted.
        // Keep the rejection observable by the client without an unhandled event.
        void prerequisite.catch(() => undefined)
        this.native = new NativeCpuClient(
          window.irodori,
          prerequisite,
          (reply) => this.acceptReply(reply, false),
          (error) => this.failCpu(error),
          (fullBlocked) => this.setFullBlocked(fullBlocked),
        )
      } else if (backend === 'javascript') {
        this.canvas.dataset.cpuRenderer = 'javascript-unsupported-platform'
        this.worker = new Worker(new URL('./hdr-presentation-worker.ts', import.meta.url), {
          type: 'module',
        })
        this.worker.onmessage = ({ data }) => {
          this.acceptReply(data, true)
        }
        this.worker.onerror = (event) => this.failCpu(new Error(event.message))
      } else throw new Error('Unknown CPU presentation backend.')
      this.key = ''
      if (this.view)
        this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
    })().catch((error: unknown) => {
      if (!this.disposed) this.failCpu(error)
    })
  }
  private setFullBlocked(fullBlocked: boolean) {
    const changed = this.fullBlocked !== fullBlocked
    this.fullBlocked = fullBlocked
    this.canvas.dataset.fullBlocked = String(fullBlocked)
    if (fullBlocked) {
      // A denied refinement owns no worker. Do not leave import/background
      // publication paused while the acknowledged draft remains usable.
      this.releaseActivity?.()
      this.releaseActivity = undefined
    }
    if (changed) this.limitation?.(fullBlocked)
    if (fullBlocked && this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  private failCpu(error: unknown) {
    this.canvas.dataset.cpuFailure = String(error).slice(0, 512)
    this.releaseActivity?.()
    this.releaseActivity = undefined
    this.failed()
  }
  private acceptReply(data: CpuReply, closeRejected: boolean): boolean {
    const reject = () => {
      if (closeRejected) {
        data.bitmap?.close()
        data.neutral?.close()
      }
      return false
    }
    if (this.disposed || data.generation !== this.generation) {
      return reject()
    }
    if (data.error) {
      this.releaseActivity?.()
      this.releaseActivity = undefined
      this.failed()
      return reject()
    }
    if (!data.bitmap || !data.neutral || !data.parameters) {
      this.failCpu(new Error('CPU renderer returned an incomplete pair.'))
      return reject()
    }
    if (
      this.comparisonFrame &&
      (!data.beforeSample ||
        !data.beforeDraftSample ||
        (closeRejected && data.beforeSha256 !== this.comparisonFrame.hdr!.sha256))
    ) {
      this.failCpu(new Error('CPU renderer returned incomplete comparison samples.'))
      return reject()
    }
    if (
      this.presentationState === null ||
      (!this.nativePresented &&
        this.presentationState &&
        !sameAdjustments(this.presentationState.settings, data.parameters))
    ) {
      this.key = ''
      this.releaseActivity?.()
      this.releaseActivity = undefined
      return reject()
    }
    this.maskKey = undefined
    this.bitmap?.close()
    this.neutral?.close()
    this.bitmap = data.bitmap
    this.neutral = data.neutral
    this.completedParameters = data.parameters
    this.completedRanges = !!data.hdrRanges
    this.completedNative = data.native
    this.completedTarget = data.target ? structuredClone(data.target) : undefined
    this.canvas.dataset.quality = data.draft ? 'draft' : 'normal'
    if (data.native) {
      this.canvas.dataset.resourcePolicy = JSON.stringify(data.native.policy)
      this.canvas.dataset.resourcePolicyRevision = String(data.native.policy.revision)
      this.canvas.dataset.presentedSettingsRevision = String(data.native.settingsRevision)
      this.canvas.dataset.presentedSourceIdentity = this.frame?.identity ?? ''
      this.canvas.dataset.cpuGeneration = String(data.generation)
      this.canvas.dataset.nativeCpuPair = data.native.pairId
      this.canvas.dataset.cpuRenderingIdentity = data.native.source.renderingIdentity
    }
    if (data.sample && data.draftSample && this.frame?.hdr)
      publishHdrSample(this.frame.hdr.sha256, data.sample, data.draftSample)
    if (data.beforeSample && data.beforeDraftSample && this.comparisonFrame?.hdr)
      publishHdrSample(this.comparisonFrame.hdr.sha256, data.beforeSample, data.beforeDraftSample)
    if (this.presentationState === undefined && !this.comparisonMissing()) this.loaded()
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
    if (!data.draft) {
      this.releaseActivity?.()
      this.releaseActivity = undefined
    }
    return true
  }
  setTarget(target: DisplayTarget) {
    this.target = target
  }
  setPresentationState(state: HdrPresentationState | null) {
    if (
      this.presentationState !== undefined &&
      state?.revision === this.presentationState?.revision &&
      (!state || sameAdjustments(this.presentationState?.settings, state.settings))
    )
      return
    this.presentationState = state ? structuredClone(state) : null
    this.native?.cancel()
    // Keep completed pixels while a commit is confirmed, but reject unfinished old work.
    this.generation++
    this.key = ''
    this.releaseActivity?.()
    this.releaseActivity = undefined
  }
  setWorking(frame: WorkingFrame) {
    if (
      this.frame === frame ||
      (this.frame?.identity &&
        this.frame.identity === frame.identity &&
        JSON.stringify(this.frame.hdr) === JSON.stringify(frame.hdr) &&
        JSON.stringify(this.frame.cpuSource) === JSON.stringify(frame.cpuSource))
    )
      return
    this.resetSourcePixels()
    this.frame = frame
    this.comparisonInput = undefined
    this.comparisonFrame = undefined
    this.comparisonRequired = false
    if (frame.hdr) selectHdrSampleSources(frame.hdr.sha256)
  }
  /** Main/loader lineage checks precede this local domain validation. */
  setComparisonSource(input: WorkingFrame | null, required = true) {
    if (this.disposed) return
    if (this.comparisonInput === (input ?? undefined) && this.comparisonRequired === required)
      return
    if (input && !this.frame)
      throw new Error('The CPU edited frame must load before its comparison source.')
    const accepted = input ? checkedHdrComparison(this.frame!, input) : undefined
    if (input && !accepted) {
      input = null
      required = false
    }
    if (this.comparisonInput === (input ?? undefined) && this.comparisonRequired === required)
      return
    this.resetSourcePixels()
    this.comparisonInput = input ?? undefined
    this.comparisonFrame = accepted?.frame
    this.comparisonRequired = required
    if (this.frame?.hdr)
      selectHdrSampleSources(this.frame.hdr.sha256, this.comparisonFrame?.hdr?.sha256)
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  private comparisonMissing() {
    return this.mode !== 'after' && this.comparisonRequired && !this.comparisonFrame
  }
  private resetSourcePixels() {
    void this.native?.cancelMasks()
    // A new corrected source cannot inherit another source's completed bitmaps or first-paint authority.
    this.generation++
    this.native?.cancel()
    this.bitmap?.close()
    this.neutral?.close()
    this.bitmap = undefined
    this.neutral = undefined
    this.completedParameters = undefined
    this.completedRanges = false
    this.completedNative = undefined
    this.completedTarget = undefined
    this.nativePresented = false
    this.resetPublication()
    this.releaseActivity?.()
    this.releaseActivity = undefined
    this.setFullBlocked(false)
    this.key = ''
  }
  private resetPublication() {
    this.maskKey = undefined
    for (const field of [
      'editing',
      'quality',
      'exposure',
      'contrast',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'saturation',
      'vibrance',
      'whiteBalance',
      'comparison',
      'hdrRanges',
      'nativeCpuPair',
      'cpuRenderingIdentity',
      'presentedSourceIdentity',
      'presentedBeforeSourceIdentity',
      'presentedBeforeSourceSha256',
      'presentedSettingsRevision',
      'presentedView',
    ])
      delete this.canvas.dataset[field]
    this.canvas.style.visibility = 'hidden'
  }
  setBitmap(bitmap: ImageBitmap) {
    void bitmap /* HDR data is rendered by the worker. */
  }
  setComparison(mode: string, split: number) {
    this.mode = mode
    this.split = split
  }
  setHdrRanges(enabled: boolean) {
    this.hdrRanges = enabled
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    this.view = { image, viewport, view, parameters }
    if (this.comparisonMissing()) {
      this.resetPublication()
      return
    }
    if (
      this.presentationState === null ||
      (!this.nativePresented &&
        this.presentationState &&
        !sameAdjustments(this.presentationState.settings, parameters))
    )
      return
    if (!this.frame?.hdr || !viewport.width || !viewport.height) return
    const key = JSON.stringify([parameters, this.hdrRanges, this.target?.headroom])
    if (key !== this.key) {
      if (!this.native && !this.worker) return
      this.releaseActivity ??= this.activity?.()
      this.key = key
      const generation = ++this.generation
      this.native?.post({
        frame: this.frame,
        beforeFrame: this.comparisonFrame,
        parameters,
        hdrRanges: this.hdrRanges,
        generation,
        settingsRevision: this.presentationState?.revision ?? 0,
        target: this.target,
        viewport: { ...viewport, dpr: devicePixelRatio || 1 },
      })
      this.worker?.postMessage({
        asset: this.frame.hdr,
        beforeAsset: this.comparisonFrame?.hdr,
        parameters,
        hdrRanges: this.hdrRanges,
        generation,
        target: this.target,
      })
    }
    if (!this.bitmap || !this.neutral) return
    const dpr = devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    if (!this.native && width * height * 16 > 64 * 1024 ** 2) {
      this.failed()
      return
    }
    if (this.native) {
      const input = {
        frame: this.frame,
        beforeFrame: this.comparisonFrame,
        parameters,
        hdrRanges: this.hdrRanges,
        generation: this.generation,
        settingsRevision: this.presentationState?.revision ?? 0,
        target: this.target,
        viewport: { ...viewport, dpr },
      }
      if (!this.native.canDraw(input)) {
        if (this.native.hasMaskReservation) {
          // Keep current pixels and backing. Optional analysis drains before a
          // resize is retried against the ordinary frozen CPU policy.
          this.drainMaskForResize()
          return
        }
        // Keep existing same-source pixels unchanged while admission/receiver
        // work settles. This branch never resizes or allocates a new canvas.
        if (this.native.canRetainWhileConstructing(input)) return
        this.failCpu(new Error('CPU canvas resize exceeds its frozen resource policy.'))
        return
      }
    }
    const memory = this.native?.memory
    if (memory)
      Object.assign(this.canvas.dataset, {
        allocatedRamBytes: String(memory.peak.ramBytes),
        allocatedGpuBytes: String(memory.peak.gpuBytes),
        ramBudgetBytes: String(memory.limits.ramBytes),
        vramBudgetBytes: String(memory.limits.gpuBytes),
        resourcePolicyRevision: String(memory.limits.revision),
      })
    this.canvas.width = width
    this.canvas.height = height
    const context = this.context
    context.scale(dpr, dpr)
    context.clearRect(0, 0, viewport.width, viewport.height)
    context.imageSmoothingEnabled = view.scale < 1
    const x = (viewport.width - image.width * view.scale) / 2 + view.x,
      y = (viewport.height - image.height * view.scale) / 2 + view.y
    context.drawImage(
      this.mode === 'before' ? this.neutral : this.bitmap,
      x,
      y,
      image.width * view.scale,
      image.height * view.scale,
    )
    if (this.mode === 'split') {
      context.save()
      context.beginPath()
      context.rect(0, 0, viewport.width * this.split, viewport.height)
      context.clip()
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.drawImage(this.neutral, x, y, image.width * view.scale, image.height * view.scale)
      context.restore()
    }
    if (view.scale >= 8) {
      context.strokeStyle = 'rgba(128,128,128,0.15)'
      context.lineWidth = 1 / dpr
      context.beginPath()
      for (
        let px = Math.max(0, Math.ceil(-x / view.scale));
        px <= Math.min(image.width, Math.floor((viewport.width - x) / view.scale));
        px++
      ) {
        context.moveTo(x + px * view.scale, Math.max(0, y))
        context.lineTo(
          x + px * view.scale,
          Math.min(viewport.height, y + image.height * view.scale),
        )
      }
      for (
        let py = Math.max(0, Math.ceil(-y / view.scale));
        py <= Math.min(image.height, Math.floor((viewport.height - y) / view.scale));
        py++
      ) {
        context.moveTo(Math.max(0, x), y + py * view.scale)
        context.lineTo(Math.min(viewport.width, x + image.width * view.scale), y + py * view.scale)
      }
      context.stroke()
    }
    this.canvas.style.visibility = 'visible'
    const completed = this.completedParameters!
    Object.assign(this.canvas.dataset, {
      editing: 'ready',
      exposure: String(completed.exposureEv),
      contrast: String(completed.contrast),
      highlights: String(completed.highlights),
      shadows: String(completed.shadows),
      whites: String(completed.whites),
      blacks: String(completed.blacks),
      saturation: String(completed.saturation),
      vibrance: String(completed.vibrance),
      whiteBalance: JSON.stringify(completed.whiteBalance),
      comparison: this.mode,
      hdrRanges: String(this.completedRanges),
      presentedView: JSON.stringify(view),
    })
    this.nativePresented = true
    if (this.mode !== 'after' && this.comparisonFrame) {
      this.canvas.dataset.presentedBeforeSourceIdentity =
        this.comparisonFrame.identity ?? this.comparisonFrame.hdr!.sha256
      this.canvas.dataset.presentedBeforeSourceSha256 = this.comparisonFrame.hdr!.sha256
    } else {
      delete this.canvas.dataset.presentedBeforeSourceIdentity
      delete this.canvas.dataset.presentedBeforeSourceSha256
    }
    const published = this.completedNative
    this.maskKey =
      published?.quality === 'normal'
        ? JSON.stringify([
            published.pairId,
            this.mode === 'before'
              ? (published.beforeSource ?? published.source)
              : published.source,
            this.mode === 'before' && published.beforeSource ? published.source : null,
            published.settingsRevision,
            this.mode === 'before' ? neutralAdjustments : published.parameters,
            maskPixelTarget(this.completedTarget),
            this.mode,
            this.completedRanges,
            published.quality,
          ])
        : undefined
    if (this.presentationState !== undefined) this.loaded()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    const maskDrained = this.native?.cancelMasks() ?? Promise.resolve()
    this.retirementAbort.abort(new Error('CPU presentation owner disposed.'))
    this.releaseActivity?.()
    this.releaseActivity = undefined
    this.worker?.terminate()
    this.retired = Promise.all([this.backendReady, maskDrained])
      .then(() => this.native?.dispose())
      .then(() => undefined)
      .finally(() => {
        this.bitmap?.close()
        this.neutral?.close()
        this.release()
      })
    this.imageOwner.retire(this.retired)
    // Register synchronously before React can construct the next photo owner.
    // NativeCpuClient releases its main session only after its browser receivers
    // have settled, so this barrier covers arrays/bitmaps beyond fetch completion.
    retainHdrPreviewRetirement(this.retired)
  }
}
