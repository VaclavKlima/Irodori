import {
  hdrPresentationMemory,
  hdrRestoredUploadMemory,
  HdrPresentationHeadroom,
  HDR_BITMAP_RESERVATION,
  type HdrMemoryLimits,
  type HdrManagedBytes,
  type HdrMemoryRequest,
  type HdrRetentionMethod,
} from './hdr-memory'
import { reservePresentationBitmaps } from './frame-cache'
import {
  NativeMaskReservationOwner,
  sameMaskFrame,
  maskPixelTarget,
  type NativeMaskReservation,
} from './native-mask-reservation'
import type { ResourcePolicySnapshot } from '../../../shared/resource-policy'
import type { HdrFirstSurfaceOffer } from '../../../shared/hdr-first-surface'
import {
  checkedFirstSurfaceOffer,
  freezeFirstSurfacePolicy,
  readFirstSurface,
} from './hdr-first-surface-client'
import {
  HdrRecovery,
  HDR_RECOVERY_VERSION,
  supportsHdrRecovery,
  type HdrRecoveryCapture,
  type HdrRecoverySnapshot,
} from './hdr-recovery'
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
import { retainHdrContent, publishHdrSample } from './hdr-sample'
import type { Size, View } from './geometry'
import { hdrDevice } from './hdr-device'
import { uploadHdr, type HdrUploadedSource } from './hdr-upload'
import { hdrSourceIdentity, type HdrSourceLease } from './hdr-source-cache'
import type { EditorPreviewPolicy } from '../../../shared/editor-preview-policy'
import { prepareHdrRenderingTables } from './hdr-rendering-tables'
import { hdrCacheKernel } from './hdr-shader'
import { prepareHdrPipelines, presentationBlit } from './hdr-pipelines'
import { ACES_DATA_BYTES } from '../../../shared/aces-data'
import {
  ACES_INTERACTIVE_PREVIEW_VERSION,
  ACES_SDR_INTERACTIVE_PREVIEW_VERSION,
  ACES_HDR_INTERACTIVE_PREVIEW_VERSION,
  selectInteractivePreviewPolicy,
  type AcesInteractivePreviewPolicy,
  type AcesPreviewPolicy,
} from '../../../shared/aces-preview-wgsl'
import { hdrCachePlan, HdrRenderCache, HDR_CACHE_MAX_TILES } from './hdr-render-cache'
import { HdrEditQueue, type HdrEditRequest } from './hdr-edit-queue'
import type { EditGestureCommit } from './edit-gesture'
import { HdrGestureHandoff, type HdrGestureStage } from './hdr-gesture-handoff'
import { HDR_HISTOGRAM_WORDS, readHdrHistogram } from './hdr-histogram'
import type { HdrStatistics } from '../../../shared/hdr-statistics'
import { HdrGpuTimings, HDR_GPU_TIMING_BYTES, type HdrGpuTimingFrame } from './hdr-gpu-timings'
import { hdrPresentationIdentity, type HdrPresentationIdentity } from './hdr-presentation-cache'
import {
  sourceCache,
  presentationCache,
  retiredPreviewOwners,
  captureHdrPreviewRetirement,
  hdrFirstSurfaceExistingOwners,
} from './hdr-preview-resources'

const presentationDevices = new WeakSet<GPUDevice>()
const sourceDevices = new WeakSet<GPUDevice>()

export interface HdrPresentationState {
  revision: number
  settings: AdjustmentParameters
}

export interface HdrFirstSurfaceLineage {
  parentWorkingKey: string
  workingSha256: string
}
export type HdrFirstSurfacePhase = 'fenced' | 'painted' | 'invalidated'
interface FirstSurfaceReceiver {
  offer: HdrFirstSurfaceOffer
  isCurrent: () => boolean
  abort: AbortController
  valid: boolean
  fenced: boolean
  attached: boolean
}

function observePresenterLoss(device: GPUDevice, observer: { lost?: () => void }) {
  // Closed presenters release their callback; a long-lived device retains only this small holder.
  void device.lost.then(() => observer.lost?.())
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
  offscreenFenceDeferred: number
  blitSubmissionMs: number
  retainedCopyMs: number
  retainedRawHalfUsed: number
  retainedCpuStagingUsed: number
  retainedMapMs: number
  retainedCpuCopyMs: number
  retainedDrawMs: number
  retainedReadMs: number
  /** Recovery-copy submission fence when cachedCanvasReused is set; otherwise the normal blit fence. */
  finalBlitFenceMs: number
  cachedCanvasReused?: number
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
  /** Captured only for non-gesture parameters matching the confirmed edit state. */
  settingsRevision: number | null
  epoch: number
  interactivePrecision: boolean
  context: string
  handoff?: { id: number; stage: HdrGestureStage }
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
  arithmeticPolicy: AcesPreviewPolicy
  rangeArithmeticPolicy: AcesPreviewPolicy | null
  offscreenCompletionDeferred: boolean
  completionFenced: boolean
  retentionMethod: HdrRetentionMethod
  cacheBytes: number
  histogram: HistogramRequest
}
interface RetainedFrameCopy {
  method: HdrRetentionMethod
  surface: HTMLCanvasElement
  context: CanvasRenderingContext2D
  width: number
  height: number
  drawMs: number
  drawFailure?: { error: unknown }
  readbackComplete: boolean
  finished: Promise<void>
  release: () => void
}
type HdrPresentationDepartureReason =
  | 'retained'
  | 'disabled'
  | 'memory-bypass'
  | 'closed'
  | 'unconfirmed'
  | 'running'
  | 'pending'
  | 'restoring'
  | 'not-completed'
  | 'identity-changed'
  | 'not-admitted'

export class HdrPresenter {
  private abort = new AbortController()
  private device?: GPUDevice
  private deviceLost = false
  private retainedStaging?: HTMLCanvasElement
  private retainedCopy?: RetainedFrameCopy
  private recovery = new HdrRecovery()
  private gpuTimings?: HdrGpuTimings
  private context?: GPUCanvasContext
  private texture?: GPUTexture
  private sourceLease?: HdrSourceLease<GPUTexture>
  private loadWork?: Promise<void>
  private retirement?: Promise<void>
  private readonly maskReservation = new NativeMaskReservationOwner()
  private maskKey?: string
  /** Retry hint from actual normal publication; never authorizes source/edits. */
  get maskPublicationKey(): string | undefined {
    return this.maskKey
  }
  private sourceFailed = false
  private uniform?: GPUBuffer
  private pipeline?: GPURenderPipeline
  private group?: GPUBindGroup
  private layout?: GPUBindGroupLayout
  private cacheLayout?: GPUBindGroupLayout
  private cachePipeline?: GPUComputePipeline
  private interactivePipelines = new Map<AcesInteractivePreviewPolicy, GPUComputePipeline>()
  private cacheKernel = hdrCacheKernel()
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
  private latestHistogram?: HistogramRequest
  private releaseHistogramActivity?: () => void
  private gesturing = false
  private gestureHandoff = new HdrGestureHandoff()
  private handoffSnapshot?: PresentationRequest
  private editingConfirmation: HdrPresentationState | null = null
  private refinementPending = false
  private epoch = -1
  private inputSerial = 0
  private editsKey = ''
  private statisticsCache?: { key: string; result: HdrStatistics }
  private publishedStatisticsKey = ''
  private publishedStatisticsSerial = 0
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
  private presentationHeadroom?: HdrPresentationHeadroom
  private resourcePolicyRequest?: Promise<ResourcePolicySnapshot>
  private resourcePolicy?: ResourcePolicySnapshot
  private gpuInitialization?: Promise<GPUDevice>
  private firstSurface?: FirstSurfaceReceiver
  private firstSurfaceWork?: Promise<void>
  private completedSurface?: {
    surface: GPUTexture
    identity: HdrPresentationIdentity
    serial: number
  }
  private restoredIdentity?: string
  private cachedPaintReceipt?: Readonly<{
    identity: HdrPresentationIdentity
    serial: number
    device: GPUDevice
    context: GPUCanvasContext
    epoch: number
  }>
  private attemptedRestore = ''
  private restoring?: Promise<void>
  private nativePresented = false
  private presentationVersion = 0
  private deviceObserver?: { lost?: () => void }
  constructor(
    private canvas: HTMLCanvasElement,
    private target: DisplayTarget,
    private readonly previewPolicy: EditorPreviewPolicy,
    private lost: (reason: string) => void,
    private loaded: () => void,
    private statistics: (result: HdrStatistics) => void = () => undefined,
    private retainedCanvas?: HTMLCanvasElement,
    private activity?: () => () => void,
    private statisticsPending: (pending: boolean) => void = () => undefined,
    private cachedPresentation: (presented: boolean) => void = () => undefined,
    private firstSurfacePhase: (
      offer: HdrFirstSurfaceOffer,
      phase: HdrFirstSurfacePhase,
    ) => void = () => undefined,
  ) {
    this.resetNativePublication()
    canvas.dataset.sourceUploads = '0'
    canvas.dataset.sourceCache = 'pending'
    canvas.dataset.cachedDisplayReady = 'false'
    delete canvas.dataset.cachedFencedAt
    delete canvas.dataset.cachedPostPaintAt
    canvas.dataset.firstSurface = 'pending'
    for (const field of [
      'firstSurfaceId',
      'firstSurfaceParentWorkingKey',
      'firstSurfaceSha256',
      'firstSurfaceFencedAt',
      'firstSurfacePostPaintAt',
      'firstSurfaceMemory',
      'firstSurfaceBypass',
      'firstSurfaceTimings',
    ])
      delete canvas.dataset[field]
    canvas.dataset.backend = 'webgpu-hdr'
    canvas.dataset.tileBatch = String(this.previewPolicy.tileBatch)
    canvas.dataset.tileKernel = this.cacheKernel.kind
    canvas.dataset.interactiveFence = this.finalInteractiveFence ? 'final' : 'separate'
    canvas.dataset.interactivePolicy = this.interactivePrecision
      ? ACES_INTERACTIVE_PREVIEW_VERSION
      : 'reference'
    canvas.dataset.presentationCache = this.previewPolicy.presentationCache ? 'pending' : 'disabled'
  }
  private get interactivePrecision(): boolean {
    return this.previewPolicy.interactivePrecision === 'f32'
  }
  private get finalInteractiveFence(): boolean {
    return this.previewPolicy.interactiveFence === 'final'
  }
  get memoryLimits(): Readonly<HdrMemoryLimits> | undefined {
    return this.presentationHeadroom?.limits
  }
  get whenDisposed(): Promise<void> {
    return this.retirement ?? Promise.resolve()
  }
  reserveMask(
    frame: WorkingFrame,
    cancel: () => void,
    drained: Promise<void>,
  ): NativeMaskReservation | undefined {
    const headroom = this.presentationHeadroom,
      policy = this.resourcePolicy
    if (
      this.abort.signal.aborted ||
      !this.ready ||
      this.deviceLost ||
      !headroom ||
      !policy ||
      !this.sourceLease ||
      !this.cache ||
      !sameMaskFrame(this.frame, frame) ||
      this.maskReservation.active
    )
      return undefined
    // Account for the actual current backing and tile capacity, including other
    // pinned sources, recovery replacement and exact-presentation reservation.
    const plan = hdrPresentationMemory(
      {
        ...this.memoryRequest(frame, this.canvas.width, this.canvas.height, this.cache.capacity),
        retainedPresentationBytes: headroom.reservationBytes,
      },
      headroom.limits,
    )
    if (!plan.accepted || plan.cacheSlots !== this.cache.capacity) return undefined
    return this.maskReservation.reserve(
      frame.width,
      frame.height,
      plan.peak,
      policy,
      cancel,
      drained,
    )
  }
  setFirstSurfacePolicy(policy: ResourcePolicySnapshot) {
    const frozen = freezeFirstSurfacePolicy(policy)
    if (this.resourcePolicy) {
      if (JSON.stringify(this.resourcePolicy) !== JSON.stringify(frozen))
        throw new Error('HDR presentation resource policy is already frozen.')
      return
    }
    if (this.resourcePolicyRequest)
      throw new Error('HDR presentation resource policy is already resolving.')
    this.resourcePolicy = frozen
  }
  private firstSurfaceCurrent(receiver: FirstSurfaceReceiver): boolean {
    if (
      this.firstSurface !== receiver ||
      !receiver.valid ||
      this.abort.signal.aborted ||
      this.deviceLost ||
      this.sourceFailed ||
      this.nativePresented ||
      !receiver.isCurrent()
    )
      return false
    const { identity } = receiver.offer,
      target = identity.target,
      snapshot = this.view
    if (
      !snapshot ||
      target.generation !== this.target.generation ||
      target.outputVersion !== this.target.outputVersion ||
      target.mode !== this.target.mode ||
      target.colorSpace !== this.target.colorSpace ||
      target.peak !== this.target.peak ||
      target.headroom !== this.target.headroom ||
      identity.dpr !== (window.devicePixelRatio || 1) ||
      identity.viewport.width !== snapshot.viewport.width ||
      identity.viewport.height !== snapshot.viewport.height ||
      identity.view.fit !== snapshot.view.fit ||
      identity.view.x !== snapshot.view.x ||
      identity.view.y !== snapshot.view.y ||
      (!identity.view.fit &&
        (identity.view.scale !== snapshot.view.scale ||
          identity.image.width !== snapshot.image.width ||
          identity.image.height !== snapshot.image.height)) ||
      !sameAdjustments(identity.parameters, snapshot.parameters) ||
      identity.comparison !== this.mode ||
      identity.split !== this.split ||
      identity.hdrRanges !== this.hdrRanges ||
      identity.kernel !== this.cacheKernel.kind ||
      this.gesturing ||
      (!!this.editingConfirmation &&
        (this.editingConfirmation.revision !== identity.settingsRevision ||
          !sameAdjustments(this.editingConfirmation.settings, identity.parameters)))
    )
      return false
    if (
      this.frame &&
      (!receiver.attached ||
        this.frame.width !== identity.image.width ||
        this.frame.height !== identity.image.height)
    )
      return false
    return true
  }
  invalidateFirstSurface() {
    const receiver = this.firstSurface
    if (!receiver?.valid) return
    receiver.valid = false
    receiver.abort.abort()
    if (!this.nativePresented) this.canvas.style.visibility = 'hidden'
    this.canvas.dataset.firstSurface = 'invalidated'
    this.firstSurfacePhase(receiver.offer, 'invalidated')
  }
  private checkFirstSurfaceIdentity() {
    if (this.firstSurface?.valid && !this.firstSurfaceCurrent(this.firstSurface))
      this.invalidateFirstSurface()
  }
  private checkFirstSurfaceMemory(offer: HdrFirstSurfaceOffer) {
    const existing = hdrFirstSurfaceExistingOwners(),
      diagnosticRam = this.gpuTimings ? HDR_GPU_TIMING_BYTES / 3 : 0,
      diagnosticGpu = this.gpuTimings ? HDR_GPU_TIMING_BYTES : 0,
      canvasBytes = offer.width * offer.height * 32,
      ramBytes = existing.ramBytes + diagnosticRam + offer.byteLength * 4 + canvasBytes,
      vramBytes = existing.vramBytes + diagnosticGpu + offer.byteLength + canvasBytes,
      limits = this.presentationHeadroom!.limits
    if (
      !Number.isSafeInteger(ramBytes) ||
      !Number.isSafeInteger(vramBytes) ||
      ramBytes > limits.ramBytes ||
      vramBytes > limits.vramBytes
    )
      throw new Error('First HDR surface exceeds the managed image resource budgets.')
    this.canvas.dataset.firstSurfaceMemory = JSON.stringify({ ramBytes, vramBytes, limits })
  }
  setFirstSurface(offer: HdrFirstSurfaceOffer, isCurrent: () => boolean): Promise<void> {
    if (this.firstSurface?.offer.surfaceId === offer.surfaceId) {
      if (this.firstSurface.offer.requestId !== offer.requestId)
        return Promise.reject(new Error('First HDR surface request identity changed.'))
      this.firstSurface.isCurrent = isCurrent
      this.checkFirstSurfaceIdentity()
      // The capability was released after its first fence. A React effect rerun
      // keeps that completed surface; it must never try fetching the URL again.
      return this.firstSurfaceWork ?? Promise.resolve()
    }
    // Capture earlier owners before this receiver can register its own retirement.
    const previousOwners = captureHdrPreviewRetirement(),
      previousReceiver = this.firstSurfaceWork?.catch(() => undefined),
      offeredBeforeWorking = !this.frame,
      requestId = offer.requestId,
      surfaceId = offer.surfaceId
    this.invalidateFirstSurface()
    const receiver: FirstSurfaceReceiver = {
      offer,
      isCurrent,
      abort: new AbortController(),
      valid: true,
      fenced: false,
      attached: false,
    }
    this.firstSurface = receiver
    const abort = () => receiver.abort.abort()
    this.abort.signal.addEventListener('abort', abort, { once: true })
    const work = (async () => {
      let texture: GPUTexture | undefined,
        bytes: ArrayBuffer | undefined,
        device: GPUDevice | undefined,
        written = false,
        fenced = false
      try {
        receiver.offer = checkedFirstSurfaceOffer(offer)
        const descriptor = receiver.offer
        this.setFirstSurfacePolicy(receiver.offer.policy)
        await Promise.all([previousOwners, previousReceiver])
        if (!offeredBeforeWorking || !this.firstSurfaceCurrent(receiver)) return
        device = await this.initializeGpu()
        if (!this.firstSurfaceCurrent(receiver)) return
        if (
          descriptor.width > device.limits.maxTextureDimension2D ||
          descriptor.height > device.limits.maxTextureDimension2D
        )
          throw new Error('First HDR surface exceeds the adapter texture dimension limit.')
        this.checkFirstSurfaceMemory(receiver.offer)
        bytes = await readFirstSurface(receiver.offer, receiver.abort.signal, (timings) => {
          if (this.firstSurface === receiver)
            this.canvas.dataset.firstSurfaceTimings = JSON.stringify({
              requestId: descriptor.requestId,
              surfaceId: descriptor.surfaceId,
              ...timings,
            })
        })
        if (!this.firstSurfaceCurrent(receiver)) return
        this.blit ??= await presentationBlit(device)
        if (!this.firstSurfaceCurrent(receiver)) return
        this.checkFirstSurfaceMemory(receiver.offer)
        texture = device.createTexture({
          size: [descriptor.width, descriptor.height],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        })
        // writeTexture's staging remains owned until the same real fence as the blit.
        written = true
        device.queue.writeTexture({ texture }, bytes, { bytesPerRow: descriptor.width * 8 }, [
          descriptor.width,
          descriptor.height,
        ])
        this.cachedPaintReceipt = undefined
        this.canvas.width = descriptor.width
        this.canvas.height = descriptor.height
        this.configure(this.target)
        this.configured = `${this.target.mode}:${this.target.colorSpace}`
        const group = device.createBindGroup({
          layout: this.blit.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: texture.createView() }],
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
        await device.queue.onSubmittedWorkDone()
        fenced = true
        if (!this.firstSurfaceCurrent(receiver)) return
        receiver.fenced = true
        Object.assign(this.canvas.dataset, {
          firstSurface: 'fenced',
          firstSurfaceId: descriptor.surfaceId,
          firstSurfaceParentWorkingKey: descriptor.identity.parentWorkingKey,
          firstSurfaceSha256: descriptor.sha256,
          firstSurfaceFencedAt: String(performance.now()),
        })
        this.canvas.style.visibility = 'visible'
        this.firstSurfacePhase(receiver.offer, 'fenced')
        // A hidden desktop may never paint. Source loading and receiver retirement
        // depend only on the actual queue fence, never these paint observations.
        void this.afterPaint(receiver.abort.signal).then(() => {
          if (!this.firstSurfaceCurrent(receiver)) return
          this.canvas.dataset.firstSurface = 'painted'
          this.canvas.dataset.firstSurfacePostPaintAt = String(performance.now())
          this.firstSurfacePhase(receiver.offer, 'painted')
        })
      } catch (error) {
        if (this.firstSurface === receiver) this.invalidateFirstSurface()
        if (
          !this.abort.signal.aborted &&
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          throw error
      } finally {
        try {
          if (written && !fenced) await device?.queue.onSubmittedWorkDone().catch(() => undefined)
        } finally {
          texture?.destroy()
          // eslint-disable-next-line no-useless-assignment -- Drop host storage before capability retirement can wait for other streams.
          bytes = undefined
          this.abort.signal.removeEventListener('abort', abort)
          try {
            if (
              this.firstSurface === receiver &&
              receiver.valid &&
              (!receiver.fenced || !this.firstSurfaceCurrent(receiver))
            )
              this.invalidateFirstSurface()
          } finally {
            await window.luma.releaseHdrFirstSurface(requestId, surfaceId)
          }
        }
      }
    })()
    this.firstSurfaceWork = work
    return work
  }
  private resetNativePublication() {
    this.maskKey = undefined
    this.canvas.dataset.editing = 'loading'
    for (const field of [
      'quality',
      'presentedPolicy',
      'presentedArithmeticPolicy',
      'rangeArithmeticPolicy',
      'completedEditSerial',
      'nativeEditingReadyAt',
      'normalCanvasWriteStartedAt',
      'normalCanvasSubmittedAt',
      'normalCanvasSubmittedSerial',
      'normalCanvasSubmittedEpoch',
      'presentedSourceIdentity',
      'presentedSettingsRevision',
      'presentedEpoch',
      'presentedView',
      'uploadMs',
      'loadTimings',
      'exposure',
      'contrast',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'whiteBalance',
      'comparison',
      'hdrRanges',
      'retentionMethod',
      'plannedRetentionMethod',
      'retentionWillReadFrequently',
      'recoveryPolicy',
      'recoverySnapshot',
    ])
      delete this.canvas.dataset[field]
  }
  private invalidate(preserveGesture = false) {
    this.queue.invalidate()
    if (preserveGesture) this.gestureHandoff.invalidateQueued()
    else {
      this.gestureHandoff.invalidate()
      this.handoffSnapshot = undefined
    }
    this.histogramQueue.invalidate()
    this.requestedStatisticsKey = ''
    this.latestHistogram = undefined
    this.completedSurface = undefined
    this.canvas.dataset.presentationCacheEligible = 'false'
    this.presentationVersion++
  }
  setPresentationState(state: HdrPresentationState | null) {
    if (!this.previewPolicy.presentationCache) return
    if (
      state?.revision === this.presentationState?.revision &&
      (!state || sameAdjustments(this.presentationState?.settings, state.settings))
    )
      return
    this.presentationState = state ? structuredClone(state) : null
    // The own event may unconfirm before setEditing receives its already-issued pending token.
    if (!state) this.invalidate(this.interactivePrecision)
    else {
      this.completedSurface = undefined
      this.canvas.dataset.presentationCacheEligible = 'false'
      this.presentationVersion++
    }
    this.checkCachedIdentity()
    void this.restoreCached()
  }
  private presentationIdentity(snapshot = this.view, rendered?: PresentationRequest) {
    const state = this.presentationState,
      frame = this.frame,
      target = rendered?.target ?? this.target,
      mode = rendered?.mode ?? this.mode
    if (!this.presentationHeadroom?.eligible || !snapshot || !frame?.hdr || !state) return null
    if (!['before', 'after', 'split'].includes(mode)) return null
    if (
      rendered &&
      (rendered.settingsRevision !== state.revision ||
        rendered.epoch !== this.epoch ||
        rendered.sourceIdentity !== (frame.identity ?? frame.hdr.sha256))
    )
      return null
    return hdrPresentationIdentity({
      confirmed: !this.gesturing && sameAdjustments(state.settings, snapshot.parameters),
      sourceIdentity: frame.identity ?? frame.hdr.sha256,
      sourceSha256: frame.hdr.sha256,
      renderingPolicy: `${HDR_OUTPUT_VERSION}:${HDR_ADJUSTMENT_VERSION}:normal-detail-v1`,
      settingsRevision: state.revision,
      adjustments: snapshot.parameters,
      target,
      comparison: mode as 'before' | 'after' | 'split',
      split: rendered?.split ?? this.split,
      hdrRanges: rendered?.ranges ?? this.hdrRanges,
      image: snapshot.image,
      viewport: snapshot.viewport,
      view: snapshot.view,
      dpr: window.devicePixelRatio || 1,
    })
  }
  /** A readiness update does not replace pixels; every actual canvas write retires this receipt. */
  private cachedCanvasCurrent() {
    const receipt = this.cachedPaintReceipt
    if (!receipt) return false
    const configuration = receipt.context.getConfiguration()
    return (
      !this.abort.signal.aborted &&
      !this.deviceLost &&
      !this.sourceFailed &&
      this.device === receipt.device &&
      this.context === receipt.context &&
      receipt.context.canvas === this.canvas &&
      configuration?.device === receipt.device &&
      configuration.format === 'rgba16float' &&
      configuration.colorSpace === this.target.colorSpace &&
      configuration.toneMapping?.mode === (this.target.mode === 'hdr' ? 'extended' : 'standard') &&
      this.canvas.width === receipt.identity.width &&
      this.canvas.height === receipt.identity.height &&
      this.epoch === receipt.epoch &&
      this.restoredIdentity === receipt.identity.key &&
      this.presentationIdentity()?.key === receipt.identity.key &&
      this.canvas.dataset.cachedPresentationSerial === String(receipt.serial)
    )
  }
  private checkCachedIdentity() {
    if (this.restoredIdentity && this.presentationIdentity()?.key !== this.restoredIdentity)
      this.hideCachedPresentation()
  }
  private hideCachedPresentation() {
    this.cachedPaintReceipt = undefined
    if (!this.restoredIdentity) return
    this.restoredIdentity = undefined
    if (!this.nativePresented) this.canvas.style.visibility = 'hidden'
    this.canvas.dataset.cachedDisplayReady = 'false'
    delete this.canvas.dataset.cachedFencedAt
    this.cachedPresentation(false)
  }
  private afterPaint(signal = this.abort.signal) {
    return new Promise<void>((resolve) => {
      let animation = 0
      const finish = () => {
        cancelAnimationFrame(animation)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      if (signal.aborted) return finish()
      signal.addEventListener('abort', finish, { once: true })
      animation = requestAnimationFrame(() => {
        animation = requestAnimationFrame(finish)
      })
    })
  }
  private memoryRequest(
    frame: Pick<WorkingFrame, 'width' | 'height'>,
    width = 0,
    height = 0,
    maximumLayers = HDR_CACHE_MAX_TILES,
    restoredUpload?: HdrManagedBytes,
  ): HdrMemoryRequest {
    const readbackBytes = width && height ? Math.ceil((width * 8) / 256) * 256 * height : 0
    return {
      width: frame.width,
      height: frame.height,
      canvasWidth: width,
      canvasHeight: height,
      maximumLayers,
      bitmapReservation: HDR_BITMAP_RESERVATION,
      rawHalfSupported:
        !!this.retainedCanvas &&
        supportsHdrRecovery() &&
        !!this.device &&
        readbackBytes <= this.device.limits.maxBufferSize,
      diagnostic: this.gpuTimings
        ? { ramBytes: HDR_GPU_TIMING_BYTES / 3, vramBytes: HDR_GPU_TIMING_BYTES }
        : { ramBytes: 0, vramBytes: 0 },
      restoredUpload,
      recovery: this.recovery.reservation(width, height),
      otherReservations: this.sourceAndMaskReservation(),
    }
  }
  private sourceAndMaskReservation(): HdrManagedBytes {
    const source = this.sourceReservation(),
      mask = this.maskReservation.bytes
    return {
      ramBytes: source.ramBytes + mask.ramBytes,
      vramBytes: source.vramBytes + mask.vramBytes,
    }
  }
  private sourceReservation(): HdrManagedBytes {
    const reserved = sourceCache.memory(this.sourceLease)
    const total = sourceCache.memory()
    Object.assign(this.canvas.dataset, {
      sourceCacheEntries: String(total.entries),
      sourceCacheRamBytes: String(total.ramBytes),
      sourceCacheGpuBytes: String(total.vramBytes),
      sourceReservationRamBytes: String(reserved.ramBytes),
      sourceReservationGpuBytes: String(reserved.vramBytes),
    })
    return { ramBytes: reserved.ramBytes, vramBytes: reserved.vramBytes }
  }
  private pruneInactiveSources(request: HdrMemoryRequest): void | Promise<void> {
    if (this.abort.signal.aborted) this.abort.signal.throwIfAborted()
    const headroom = this.presentationHeadroom!
    const reservation = this.sourceReservation()
    if (!reservation.ramBytes && !reservation.vramBytes) return
    const ordinary = hdrPresentationMemory(
      {
        ...request,
        otherReservations: this.maskReservation.bytes,
        retainedPresentationBytes: headroom.reservationBytes,
      },
      headroom.limits,
    )
    // A failing ordinary frame is handled after its own lease is released, before CPU fallback.
    if (!ordinary.accepted) return
    const retained = hdrPresentationMemory(
      {
        ...request,
        otherReservations: {
          ramBytes: reservation.ramBytes + this.maskReservation.bytes.ramBytes,
          vramBytes: reservation.vramBytes + this.maskReservation.bytes.vramBytes,
        },
        retainedPresentationBytes: headroom.reservationBytes,
      },
      headroom.limits,
    )
    const worsens =
      !retained.accepted ||
      retained.cacheSlots < ordinary.cacheSlots ||
      (retained.retentionMethod === 'cpu-staging' && ordinary.retentionMethod === 'raw-half-cpu')
    if (!worsens) return
    if (sourceCache.evictOldestUnpinned()) return this.pruneInactiveSources(request)
    const retiring = [...retiredPreviewOwners].filter((owner) => owner !== this.retirement)
    if (retiring.length) return Promise.all(retiring).then(() => this.pruneInactiveSources(request))
    // Do not clearAndDrain while holding this presenter's pin. Its error cleanup releases it first.
    throw new Error('Retained GPU sources exceed the managed image resource budgets.')
  }
  private presentationMemory(
    frame: Pick<WorkingFrame, 'width' | 'height'>,
    width = 0,
    height = 0,
    maximumLayers = HDR_CACHE_MAX_TILES,
    restoredUpload?: HdrManagedBytes,
  ): ReturnType<typeof hdrPresentationMemory> | Promise<ReturnType<typeof hdrPresentationMemory>> {
    const headroom = this.presentationHeadroom
    if (!headroom) throw new Error('HDR resource policy has not resolved.')
    if (this.maskReservation.active) {
      const request = this.memoryRequest(frame, width, height, maximumLayers, restoredUpload),
        mask = this.maskReservation.bytes,
        withMask = hdrPresentationMemory(
          { ...request, retainedPresentationBytes: headroom.reservationBytes },
          headroom.limits,
        ),
        withoutMask = hdrPresentationMemory(
          {
            ...request,
            otherReservations: {
              ramBytes: request.otherReservations!.ramBytes - mask.ramBytes,
              vramBytes: request.otherReservations!.vramBytes - mask.vramBytes,
            },
            retainedPresentationBytes: headroom.reservationBytes,
          },
          headroom.limits,
        )
      if (
        !withMask.accepted ||
        withMask.cacheSlots < withoutMask.cacheSlots ||
        (withMask.retentionMethod === 'cpu-staging' &&
          withoutMask.retentionMethod === 'raw-half-cpu')
      )
        // Optional analysis cannot force cache retirement or healthy GPU fallback.
        return this.maskReservation
          .cancelAndDrain()
          .then(() => this.presentationMemory(frame, width, height, maximumLayers, restoredUpload))
    }
    const finish = () => {
      this.abort.signal.throwIfAborted()
      const bypassed = headroom.bypassed
      const memory = headroom.plan(
        this.memoryRequest(frame, width, height, maximumLayers, restoredUpload),
      )
      if (!bypassed && headroom.bypassed) {
        this.completedSurface = undefined
        this.presentationVersion++
        this.canvas.dataset.presentationCache = 'memory-bypass'
        this.canvas.dataset.presentationCacheEligible = 'false'
        this.hideCachedPresentation()
      }
      this.canvas.dataset.presentationReservationBytes = String(headroom.reservationBytes)
      if (memory instanceof Promise && !bypassed && headroom.bypassed) {
        // Dropping the exact-frame reservation can change ordinary tile/recovery headroom.
        // Reconsider inactive sources after that drain, using the now-current reservation.
        return memory.then(() => {
          const request = this.memoryRequest(frame, width, height, maximumLayers, restoredUpload)
          const pruning = this.pruneInactiveSources(request)
          const replan = () => {
            this.abort.signal.throwIfAborted()
            return headroom.plan(
              this.memoryRequest(frame, width, height, maximumLayers, restoredUpload),
            )
          }
          return pruning instanceof Promise ? pruning.then(replan) : replan()
        })
      }
      return memory
    }
    const pruning = this.pruneInactiveSources(
      this.memoryRequest(frame, width, height, maximumLayers, restoredUpload),
    )
    return pruning instanceof Promise ? pruning.then(finish) : finish()
  }
  private publishMemory(memory: ReturnType<typeof hdrPresentationMemory>) {
    Object.assign(this.canvas.dataset, {
      allocatedBytes: String(memory.total),
      allocatedRamBytes: String(memory.peak.ramBytes),
      allocatedGpuBytes: String(memory.peak.vramBytes),
      ramBudgetBytes: String(memory.limits.ramBytes),
      vramBudgetBytes: String(memory.limits.vramBytes),
      resourcePolicyRevision: String(memory.limits.revision),
    })
  }
  private publishRejectedMemory(memory: ReturnType<typeof hdrPresentationMemory>) {
    Object.assign(this.canvas.dataset, {
      admissionRejectedRamBytes: String(memory.peak.ramBytes),
      admissionRejectedGpuBytes: String(memory.peak.vramBytes),
      admissionRamBudgetBytes: String(memory.limits.ramBytes),
      admissionVramBudgetBytes: String(memory.limits.vramBytes),
      admissionPolicyRevision: String(memory.limits.revision),
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
      !this.presentationHeadroom ||
      this.nativePresented ||
      this.firstSurface?.valid ||
      this.abort.signal.aborted ||
      this.attemptedRestore === attempt
    )
      return Promise.resolve()
    this.attemptedRestore = attempt
    const memory = this.presentationMemory(
      this.frame!,
      identity.width,
      identity.height,
      this.device.limits.maxTextureArrayLayers,
    )
    if (memory instanceof Promise) {
      // Install the coalescing promise before yielding; bypass already made this identity ineligible.
      const work = memory
        .then(() => undefined)
        .finally(() => {
          if (this.restoring === work) this.restoring = undefined
          this.canvas.dataset.retainedPresentationBytes = String(presentationCache.bytes)
        })
      this.restoring = work
      return work
    }
    const lease = presentationCache.acquire(this.device, identity)
    this.canvas.dataset.retainedPresentationBytes = String(presentationCache.bytes)
    if (!lease) {
      this.canvas.dataset.presentationCache = 'miss'
      return Promise.resolve()
    }
    const restoredUpload = this.ready
      ? { ramBytes: 0, vramBytes: 0 }
      : hdrRestoredUploadMemory(identity.width, identity.height)
    if (
      !hdrPresentationMemory(
        {
          ...this.memoryRequest(
            this.frame!,
            identity.width,
            identity.height,
            this.device.limits.maxTextureArrayLayers,
            restoredUpload,
          ),
          retainedPresentationBytes: this.presentationHeadroom.reservationBytes,
        },
        this.presentationHeadroom.limits,
      ).accepted
    ) {
      // Never wait for a drain while holding the candidate lease that the drain must release.
      lease.release()
      const plan = this.presentationMemory(
          this.frame!,
          identity.width,
          identity.height,
          this.device.limits.maxTextureArrayLayers,
          restoredUpload,
        ),
        work = Promise.resolve(plan)
          .then(() => undefined)
          .finally(() => {
            if (this.restoring === work) this.restoring = undefined
            this.canvas.dataset.retainedPresentationBytes = String(presentationCache.bytes)
          })
      this.restoring = work
      return work
    }
    this.canvas.dataset.restoredUploadBytes = String(
      restoredUpload.ramBytes + restoredUpload.vramBytes,
    )
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
        this.cachedPaintReceipt = undefined
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
        // Logical draw invalidation does not replace these already fenced canvas bytes.
        const receipt = Object.freeze({
          identity,
          serial: lease.serial,
          device,
          context: this.context!,
          epoch,
        })
        this.cachedPaintReceipt = receipt
        const paintCurrent = () => this.cachedPaintReceipt === receipt && this.cachedCanvasCurrent()
        // Attribute the completed cache blit before it can become visible. Readiness
        // and its clock still wait for the following actual paint observations.
        Object.assign(this.canvas.dataset, {
          cachedFencedAt: String(performance.now()),
          cachedPresentationSerial: String(lease.serial),
          cachedParameters: JSON.stringify(this.view!.parameters),
          cachedSourceIdentity: this.frame!.identity ?? this.frame!.hdr!.sha256,
          cachedSettingsRevision: String(this.presentationState!.revision),
          cachedTargetGeneration: String(this.target.generation),
          cachedEpoch: String(epoch),
          presentedView: JSON.stringify(this.view!.view),
        })
        this.canvas.style.visibility = 'visible'
        // Painting may stop while a window is hidden or minimized. It must not
        // block source preparation, normal presentation, or the fenced lease drain.
        // Record a cache hit only after real paints while this exact blit still owns
        // the canvas; a late observer must never hide a newer normal presentation.
        void this.afterPaint()
          .then(() => {
            if (!paintCurrent()) return
            Object.assign(this.canvas.dataset, {
              presentationCache: 'hit',
              cachedDisplayReady: 'true',
              cachedPostPaintAt: String(performance.now()),
            })
            this.cachedPresentation(true)
          })
          .catch((error: unknown) => {
            if (!paintCurrent()) return
            this.hideCachedPresentation()
            this.canvas.dataset.presentationCache = 'failed'
            this.canvas.dataset.presentationCacheError = String(error).slice(0, 512)
          })
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
    if (mode !== this.mode || split !== this.split) {
      this.invalidate()
      this.invalidateFirstSurface()
    }
    this.mode = mode
    this.split = split
    this.checkCachedIdentity()
  }
  setHdrRanges(enabled: boolean) {
    if (enabled !== this.hdrRanges) {
      this.invalidate()
      this.invalidateFirstSurface()
    }
    this.hdrRanges = enabled
    this.checkCachedIdentity()
  }
  setTarget(target: DisplayTarget) {
    try {
      validateTarget(target)
      if (target.generation === this.target.generation) return
      this.target = target
      this.invalidate()
      this.invalidateFirstSurface()
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
  private configure(target: DisplayTarget) {
    this.cachedPaintReceipt = undefined
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
  private async releaseSource() {
    const texture = this.texture,
      lease = this.sourceLease,
      device = this.device
    this.texture = undefined
    this.sourceLease = undefined
    const fence = Promise.resolve().then(() => device?.queue.onSubmittedWorkDone())
    if (lease) await lease.releaseAfter(fence)
    else {
      await fence.catch(() => undefined)
      texture?.destroy()
    }
  }
  private initializeGpu(): Promise<GPUDevice> {
    return (this.gpuInitialization ??= (async () => {
      const device = await hdrDevice()
      this.abort.signal.throwIfAborted()
      const policy =
        this.resourcePolicy ??
        (await (this.resourcePolicyRequest ??= window.luma.getResourcePolicy({
          vendor: device.adapterInfo.vendor,
          architecture: device.adapterInfo.architecture,
          device: device.adapterInfo.device,
          description: device.adapterInfo.description,
        })))
      this.abort.signal.throwIfAborted()
      this.resourcePolicy ??= freezeFirstSurfacePolicy(policy)
      this.presentationHeadroom ??= new HdrPresentationHeadroom(
        {
          ramBytes: this.resourcePolicy.ram.effectiveBytes,
          vramBytes: this.resourcePolicy.vram.effectiveBytes,
          revision: this.resourcePolicy.revision,
        },
        this.previewPolicy.presentationCache ? presentationCache : null,
      )
      this.canvas.dataset.resourcePolicy = JSON.stringify(this.resourcePolicy)
      this.releaseBitmaps ??= reservePresentationBitmaps(HDR_BITMAP_RESERVATION.ramBytes)
      this.device = device
      this.deviceLost = false
      this.sourceFailed = false
      if (!sourceDevices.has(device)) {
        sourceDevices.add(device)
        void device.lost
          .then(() => sourceCache.invalidate(device))
          .catch((error) => console.warn('HDR source retirement:', error))
      }
      if (this.previewPolicy.presentationCache && !presentationDevices.has(device)) {
        presentationDevices.add(device)
        void device.lost.then(() => presentationCache.invalidate(device))
      }
      this.deviceObserver = {
        lost: () => {
          if (!this.abort.signal.aborted) {
            this.deviceLost = true
            this.sourceFailed = true
            if (this.interactivePrecision) this.invalidate()
            this.invalidateFirstSurface()
            this.completedSurface = undefined
            this.hideCachedPresentation()
            // The CPU-owned completed plane remains valid after device destruction.
            this.recoverCompletedFrame()
            this.canvas.style.visibility = 'hidden'
            this.lost('Presentation device lost.')
          }
        },
      }
      observePresenterLoss(device, this.deviceObserver)
      device.addEventListener(
        'uncapturederror',
        (event) => {
          console.warn('HDR GPU validation:', event.error.message)
          if (!this.abort.signal.aborted) {
            this.sourceFailed = true
            void sourceCache
              .invalidate(device)
              .catch((error) => console.warn('HDR source retirement:', error))
            if (this.interactivePrecision) this.invalidate()
            if (this.previewPolicy.presentationCache) presentationCache.invalidate(device)
            this.invalidateFirstSurface()
            this.completedSurface = undefined
            this.hideCachedPresentation()
            this.lost(`${event.error.constructor.name}: ${event.error.message}`)
          }
        },
        { signal: this.abort.signal },
      )
      this.context = this.canvas.getContext('webgpu') ?? undefined
      if (!this.context) throw new Error('HDR canvas unavailable.')
      return device
    })())
  }
  setWorking(frame: WorkingFrame, lineage?: HdrFirstSurfaceLineage) {
    if (!frame.hdr) return
    const identity = frame.identity ?? frame.hdr.sha256
    if (this.frame) {
      if ((this.frame.identity ?? this.frame.hdr!.sha256) === identity) return
      // PhotoPreview recreates this owner whenever working.hdr or the photo generation changes.
      throw new Error('Create a new HDR presenter when its working source changes.')
    }
    const first = this.firstSurface,
      preserveFirst =
        !!first &&
        this.firstSurfaceCurrent(first) &&
        !!lineage &&
        lineage.parentWorkingKey === first.offer.identity.parentWorkingKey &&
        lineage.workingSha256 === frame.hdr.sha256 &&
        frame.width === first.offer.identity.image.width &&
        frame.height === first.offer.identity.image.height &&
        frame.hdr.width === frame.width &&
        frame.hdr.height === frame.height &&
        frame.hdr.byteLength === frame.width * frame.height * 16
    if (preserveFirst) first!.attached = true
    else this.invalidateFirstSurface()
    this.invalidate()
    this.hideCachedPresentation()
    this.frame = frame
    this.nativePresented = false
    this.attemptedRestore = ''
    this.ready = false
    this.resetNativePublication()
    if (!preserveFirst) this.canvas.style.visibility = 'hidden'
    const release = this.activity?.()
    const work = this.load(frame)
    this.loadWork = work
    void work
      .catch(async (error) => {
        console.warn('HDR presentation initialization:', error)
        if (this.abort.signal.aborted) return
        await this.releaseSource()
        if (this.abort.signal.aborted) return
        if (String(error).includes('resource budget')) {
          // The current pin is already released. Never ban a healthy device for budget pressure.
          await sourceCache.clearAndDrain()
        }
        if (!this.abort.signal.aborted) this.lost(String(error))
      })
      .finally(() => release?.())
  }
  private async load(frame: WorkingFrame) {
    const started = performance.now()
    const sourcePhotoId =
      frame.cpuSource &&
      frame.cpuSource.workingSha256 === frame.hdr?.sha256 &&
      /^[a-f0-9]{64}$/.test(frame.cpuSource.photoId)
        ? frame.cpuSource.photoId
        : undefined
    // CPU receivers register in this same barrier before a new photo can allocate.
    // Capture only earlier owners. A warm pin taken before their retirement could
    // otherwise keep an older clearAndDrain alive while this load waits for it.
    const previousOwners = captureHdrPreviewRetirement()
    await previousOwners
    if (this.abort.signal.aborted || this.frame !== frame) return
    const receiver = this.firstSurface
    if (receiver?.valid && !receiver.fenced) {
      // Only reuse initialization already started by this receiver. Do not start
      // another device, policy reservation or image allocation to probe a warm hit.
      const initializing = this.gpuInitialization,
        device = this.device ?? (initializing ? await initializing : undefined)
      if (
        device &&
        !this.abort.signal.aborted &&
        !this.deviceLost &&
        !this.sourceFailed &&
        this.frame === frame &&
        this.firstSurface === receiver &&
        receiver.valid &&
        !receiver.fenced
      ) {
        // Admission to this cache already verified every source strip and the
        // real mip fence. The final descriptor must match that exact device/key.
        const resident = sourceCache.acquire(device, hdrSourceIdentity(frame.hdr!), sourcePhotoId)
        if (resident) {
          this.sourceLease = resident
          this.invalidateFirstSurface()
          this.canvas.dataset.firstSurfaceBypass = 'resident-source'
        }
      }
    }
    // An aborted digest or submitted blit is noninterruptible. Its receiver and
    // capability still drain before the resident source can make new image owners.
    await this.firstSurfaceWork?.catch(() => undefined)
    if (this.abort.signal.aborted || this.frame !== frame) return
    this.checkFirstSurfaceIdentity()
    this.renderingGeneration = -1
    const preparation = prepareHdrRenderingTables(this.abort.signal)
    // Observe failures immediately while source/device preparation is still in flight.
    const preparedTables = preparation.tables.then(
      (tables) => ({ ok: true as const, tables }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    // A previous source's copy keeps its owner until the image fence settles.
    // Staging never overlaps source upload and is charged only during presentation.
    await this.releaseRetainedStaging()
    await this.recovery.releaseTransient()
    this.recovery.clear()
    if (this.abort.signal.aborted || this.frame !== frame) return
    const timings: Record<string, number> = {
      readMs: 0,
      hashMs: 0,
      validateMs: 0,
      writeTextureMs: 0,
    }
    const device = await this.initializeGpu()
    if (this.abort.signal.aborted || this.deviceLost || this.sourceFailed || this.frame !== frame)
      return
    const pipelineStarted = performance.now(),
      pipelinePreparation = prepareHdrPipelines(device, {
        interactive: this.interactivePrecision,
      })
    // Observe failure while upload is in flight. A cancelled photo never owns
    // or cancels these device-only programs shared by subsequent photographs.
    const preparedPipelines = pipelinePreparation.pipelines.then(
      (pipelines) => {
        timings.pipelinePreparationMs = performance.now() - pipelineStarted
        return { ok: true as const, pipelines }
      },
      (error: unknown) => {
        timings.pipelinePreparationMs = performance.now() - pipelineStarted
        return { ok: false as const, error }
      },
    )
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
    const sourceIdentity = hdrSourceIdentity(frame.hdr!)
    this.levels = sourceIdentity.mipLevels
    this.sourceLease ??= sourceCache.acquire(device, sourceIdentity, sourcePhotoId) ?? undefined
    this.texture = this.sourceLease?.resource
    this.canvas.dataset.sourceCache = this.sourceLease ? 'hit' : 'miss'
    timings.sourceCacheHit = Number(!!this.sourceLease)
    const first = this.firstSurface,
      firstUpload =
        first?.fenced && this.firstSurfaceCurrent(first)
          ? hdrRestoredUploadMemory(first.offer.width, first.offer.height)
          : undefined,
      uploadPlan = this.presentationMemory(frame, 0, 0, HDR_CACHE_MAX_TILES, firstUpload),
      uploadMemory = uploadPlan instanceof Promise ? await uploadPlan : uploadPlan
    if (this.abort.signal.aborted) return
    if (!uploadMemory.accepted) {
      this.publishRejectedMemory(uploadMemory)
      throw new Error('This HDR frame exceeds the managed image resource budgets.')
    }
    this.publishMemory(uploadMemory)
    if (
      frame.width > device.limits.maxTextureDimension2D ||
      frame.height > device.limits.maxTextureDimension2D
    )
      throw new Error('This HDR frame exceeds the adapter texture dimension limit.')
    if (!firstUpload) {
      this.cachedPaintReceipt = undefined
      this.context!.unconfigure()
    }
    if (this.previewPolicy.presentationCache) {
      const plan = this.presentationMemory(
          frame,
          Math.round((this.view?.viewport.width ?? 0) * (window.devicePixelRatio || 1)),
          Math.round((this.view?.viewport.height ?? 0) * (window.devicePixelRatio || 1)),
          device.limits.maxTextureArrayLayers,
        ),
        memory = plan instanceof Promise ? await plan : plan
      if (this.abort.signal.aborted) return
      if (memory.accepted) await this.restoreCached()
      if (this.abort.signal.aborted) return
    }
    {
      const uploaded: { value?: HdrUploadedSource } = {}
      if (!this.sourceLease) {
        // A miss remains presenter-owned until verified EOF and the mip completion fence.
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
        let submitted = 0
        for await (const strip of uploadHdr(frame.hdr!, this.abort.signal, (result) => {
          uploaded.value = result
        })) {
          for (const [key, value] of Object.entries(strip.timings)) timings[key] += value
          const writing = performance.now()
          device.queue.writeTexture(
            { texture: this.texture!, origin: [0, strip.row] },
            strip.data,
            { bytesPerRow: frame.width * 16 },
            [frame.width, strip.data.length / (frame.width * 4)],
          )
          timings.writeTextureMs += performance.now() - writing
          if (++submitted % 3 === 0) await device.queue.onSubmittedWorkDone()
        }
        timings.streamMs = performance.now() - loading
      } else timings.streamMs = 0
      const pipelines = performance.now()
      const prepared = await preparedPipelines
      if (
        this.abort.signal.aborted ||
        this.deviceLost ||
        this.sourceFailed ||
        this.device !== device ||
        this.frame !== frame
      )
        return
      timings.pipelineWaitMs = performance.now() - pipelines
      timings.pipelinePreparationReused = Number(pipelinePreparation.state !== 'cold')
      timings.pipelineReadyAtAcquire = Number(pipelinePreparation.state === 'ready')
      if (!prepared.ok) throw prepared.error
      const compiled = prepared.pipelines,
        mipLayout = compiled.mipLayout,
        mip = compiled.mip
      this.layout = compiled.layout
      this.pipeline = compiled.presentation
      this.histogramPipeline = compiled.histogram
      this.cacheLayout = compiled.cacheLayout
      this.cachePipeline = compiled.cache
      this.blit = compiled.blit
      this.interactivePipelines.clear()
      for (const policy of [
        ACES_HDR_INTERACTIVE_PREVIEW_VERSION,
        ACES_SDR_INTERACTIVE_PREVIEW_VERSION,
      ]) {
        const program = compiled.interactive[policy]
        if (program) this.interactivePipelines.set(policy, program)
      }
      if (!this.sourceLease) {
        const encoder = device.createCommandEncoder()
        for (let level = 1; level < this.levels; level++) {
          const group = device.createBindGroup({
            layout: mipLayout,
            entries: [
              {
                binding: 0,
                resource: this.texture!.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
              },
              {
                binding: 1,
                resource: this.texture!.createView({ baseMipLevel: level, mipLevelCount: 1 }),
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
        const completed = uploaded.value
        if (!completed) throw new Error('HDR source upload completed without verification.')
        const fence = device.queue.onSubmittedWorkDone()
        const lease = await sourceCache.admit(
          device,
          {
            identity: sourceIdentity,
            resource: this.texture!,
            samples: completed.samples,
            verification: completed.verification,
            mipCompletion: fence,
            photoId: sourcePhotoId,
          },
          {
            signal: this.abort.signal,
            isCurrent: () =>
              !this.sourceFailed &&
              !this.deviceLost &&
              this.frame === frame &&
              this.device === device,
          },
        )
        this.sourceLease = lease ?? undefined
        if (
          this.abort.signal.aborted ||
          this.sourceFailed ||
          this.deviceLost ||
          this.frame !== frame
        )
          return
        this.canvas.dataset.sourceCache = lease ? 'miss-retained' : 'miss-unretained'
        publishHdrSample(frame.hdr!.sha256, completed.samples.sample, completed.samples.draft)
        this.canvas.dataset.sourceUploads = String(
          Number(this.canvas.dataset.sourceUploads ?? 0) + 1,
        )
      } else {
        // Cached source samples are immutable. No previous edits, target or statistics are reused.
        publishHdrSample(
          frame.hdr!.sha256,
          this.sourceLease.samples.sample,
          this.sourceLease.samples.draft,
        )
      }
      this.sourceReservation()
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
      this.histogramGroup = device.createBindGroup({
        layout: this.histogramPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.histogramUniform } },
          { binding: 1, resource: this.texture!.createView({ mipLevelCount: 1 }) },
          { binding: 4, resource: { buffer: this.rendering } },
          { binding: 6, resource: { buffer: this.histogramBuffer } },
        ],
      })
      const tileSize = uploadMemory.tileSize
      this.lookup = device.createBuffer({
        size: Math.ceil(frame.width / tileSize) * Math.ceil(frame.height / tileSize) * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      this.jobs = device.createBuffer({
        size: HDR_CACHE_MAX_TILES * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      if (
        this.abort.signal.aborted ||
        this.deviceLost ||
        this.sourceFailed ||
        this.device !== device ||
        this.frame !== frame
      )
        return
      await device.queue.onSubmittedWorkDone()
      timings.pipelinesMs = performance.now() - pipelines
    }
    if (
      this.abort.signal.aborted ||
      this.deviceLost ||
      this.sourceFailed ||
      this.device !== device ||
      this.frame !== frame
    )
      return
    this.canvas.dataset.uploadMs = String(performance.now() - started)
    const waiting = performance.now()
    const prepared = await preparedTables
    if (
      this.abort.signal.aborted ||
      this.deviceLost ||
      this.sourceFailed ||
      this.device !== device ||
      this.frame !== frame
    )
      return
    if (!prepared.ok) throw prepared.error
    this.device!.queue.writeBuffer(this.rendering!, 0, prepared.tables.packed)
    for (const space of ['srgb', 'display-p3'] as const)
      this.device!.queue.writeBuffer(this.sdrRendering.get(space)!, 0, prepared.tables.sdr[space])
    this.renderingGeneration = 0
    timings.tablePreparationMs = prepared.tables.preparationMs
    timings.tableWaitMs = performance.now() - waiting
    timings.tablePreparationReused = Number(preparation.state !== 'cold')
    this.canvas.dataset.loadTimings = JSON.stringify(timings)
    this.ready = true
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  setEditing(
    gesturing: boolean,
    epoch: number,
    commit: EditGestureCommit | null = null,
    confirmed: HdrPresentationState | null = null,
  ) {
    const released = this.gesturing && !gesturing
    // Recovery identity also needs the accepted revision on the reference path.
    this.editingConfirmation = confirmed
    const continuing =
      this.interactivePrecision &&
      this.gestureHandoff.update({
        gesturing,
        epoch,
        commit,
        confirmed,
        context: this.mode === 'after' ? this.gestureContext() : null,
        nativePresented: this.nativePresented,
      })
    if ((epoch !== this.epoch && !continuing) || (gesturing && !this.gesturing)) {
      this.invalidate(this.interactivePrecision)
      this.refinementPending = false
    }
    this.refinementPending ||= released
    this.epoch = epoch
    this.gesturing = gesturing
    if (this.interactivePrecision) this.canvas.dataset.gestureHandoff = this.gestureHandoff.phase
    this.checkCachedIdentity()
    this.checkFirstSurfaceIdentity()
  }
  private gestureContext(snapshot = this.view) {
    if (!snapshot || !this.frame?.hdr) return null
    return JSON.stringify([
      this.frame.identity ?? this.frame.hdr.sha256,
      snapshot.image,
      snapshot.viewport,
      snapshot.view,
      this.target,
      this.mode,
      this.split,
      this.hdrRanges,
      window.devicePixelRatio || 1,
    ])
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    this.view = { image, viewport, view, parameters }
    this.checkFirstSurfaceIdentity()
    this.checkCachedIdentity()
    if (this.previewPolicy.presentationCache) void this.restoreCached()
    if (
      (this.previewPolicy.presentationCache && !this.presentationState) ||
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
    const context = this.interactivePrecision ? this.gestureContext()! : '',
      handoff = this.interactivePrecision
        ? this.gestureHandoff.plan(context, parameters)
        : 'ordinary'
    if (this.interactivePrecision) this.canvas.dataset.gestureHandoff = this.gestureHandoff.phase
    if (handoff === 'hold') return
    if (changed && !this.gesturing && handoff === 'ordinary') this.invalidate()
    this.editsKey = editsKey
    this.releaseActivity ??= this.activity?.()
    const intent =
      handoff === 'feedback'
        ? 'interactive'
        : handoff === 'refinement'
          ? 'refinement'
          : this.gesturing
            ? 'interactive'
            : this.refinementPending
              ? 'refinement'
              : changed
                ? 'interactive'
                : 'navigation'
    this.refinementPending = false
    const requestedAt = performance.now()
    const sourceIdentity = this.frame.identity ?? this.frame.hdr!.sha256
    let snapshot: PresentationRequest = {
      image: { ...image },
      viewport: { ...viewport },
      view: { ...view },
      parameters: structuredClone(parameters),
      target: structuredClone(this.target),
      mode: this.mode,
      split: this.split,
      ranges: this.hdrRanges,
      inputSerial: ++this.inputSerial,
      analysisSamples: this.gesturing || handoff === 'feedback' ? 8192 : 65536,
      requestedAt,
      sourceIdentity,
      settingsRevision:
        !this.gesturing &&
        (this.editingConfirmation ?? this.presentationState) &&
        sameAdjustments((this.editingConfirmation ?? this.presentationState)!.settings, parameters)
          ? (this.editingConfirmation ?? this.presentationState)!.revision
          : null,
      epoch: this.epoch,
      interactivePrecision:
        this.interactivePrecision &&
        (this.gesturing || handoff === 'feedback') &&
        handoff !== 'refinement' &&
        this.mode === 'after',
      context,
    }
    if (handoff === 'feedback' || handoff === 'refinement') {
      const id = this.gestureHandoff.id!
      if (!this.handoffSnapshot || this.handoffSnapshot.handoff?.id !== id)
        this.handoffSnapshot = structuredClone(snapshot)
      snapshot = {
        ...structuredClone(this.handoffSnapshot),
        inputSerial: snapshot.inputSerial,
        requestedAt,
        epoch: this.epoch,
        settingsRevision:
          handoff === 'refinement'
            ? this.gestureHandoff.authorize(id, handoff, context, parameters)!.revision
            : null,
        analysisSamples: handoff === 'feedback' ? 8192 : 65536,
        interactivePrecision: handoff === 'feedback',
        handoff: { id, stage: handoff },
      }
      this.handoffSnapshot = structuredClone(snapshot)
      this.gestureHandoff.queued(handoff, snapshot.inputSerial)
    }
    this.queue.request(snapshot, intent)
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
    const deviceQueue = this.device!.queue
    try {
      let rendered: RenderedPresentation | undefined
      try {
        rendered = await this.render(request, gpuFrame)
        const present = this.queue.finish(request)
        if (present && rendered && !this.abort.signal.aborted) {
          imagePresented = await this.present(request, rendered, gpuFrame)
        }
      } finally {
        // Discarded frames retain rendering ownership until their deferred work drains.
        if (
          this.finalInteractiveFence &&
          request.value.interactivePrecision &&
          !rendered?.completionFenced
        )
          await deviceQueue.onSubmittedWorkDone()
      }
    } catch (error) {
      this.queue.finish(request)
      if (this.interactivePrecision) this.invalidate()
      if (!this.abort.signal.aborted && String(error).includes('resource budget')) {
        // A larger viewport may fail admission even after its source fitted at upload time.
        // Stop new work, release our pin after the final source read, then drain optional sources.
        this.ready = false
        this.invalidate()
        await this.releaseSource()
        if (!this.abort.signal.aborted) await sourceCache.clearAndDrain()
      }
      if (!this.abort.signal.aborted) this.lost(`GPU presentation failed: ${String(error)}`)
    } finally {
      this.gpuTimings?.finish(gpuFrame, imagePresented)
    }
    if (this.interactivePrecision && request.value.handoff) {
      if (!imagePresented)
        this.gestureHandoff.invalidateQueued(request.value.handoff.id, request.value.inputSerial)
      // The next phase is admitted only after the final feedback image was published.
      if (imagePresented && this.view && !this.abort.signal.aborted)
        this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
    }
    this.running = false
    if (!this.queue.hasPending) {
      this.releaseActivity?.()
      this.releaseActivity = undefined
    }
    if (!this.abort.signal.aborted) void this.run()
  }
  private requestSuperseded(request: HdrEditRequest<PresentationRequest>) {
    if (this.queue.superseded(request)) return true
    if (!this.interactivePrecision) return false
    const { handoff, context, parameters, epoch } = request.value
    // Only the exact owned final snapshot may cross its own accepted epoch transition.
    return handoff
      ? !this.gestureHandoff.authorize(
          handoff.id,
          handoff.stage,
          context,
          parameters,
          request.value.inputSerial,
        )
      : epoch !== this.epoch
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
      offscreenFenceDeferred: 0,
      blitSubmissionMs: 0,
      retainedCopyMs: 0,
      retainedRawHalfUsed: 0,
      retainedCpuStagingUsed: 0,
      retainedMapMs: 0,
      retainedCpuCopyMs: 0,
      retainedDrawMs: 0,
      retainedReadMs: 0,
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
    const memoryPlan = this.presentationMemory(
        this.frame!,
        width,
        height,
        device.limits.maxTextureArrayLayers,
      ),
      memory = memoryPlan instanceof Promise ? await memoryPlan : memoryPlan
    if (this.abort.signal.aborted || this.requestSuperseded(request)) return undefined
    this.canvas.dataset.plannedRetentionMethod = memory.retentionMethod
    if (!memory.accepted) {
      this.publishRejectedMemory(memory)
      throw new Error('Presentation exceeds the managed RAM or GPU image resource budget.')
    }
    this.publishMemory(memory)
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
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
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
    const arithmeticPolicy = selectInteractivePreviewPolicy(
      interactivePrecision ? 'f32' : undefined,
      target.mode,
    )
    if (interactivePrecision) plan.variant += `:${arithmeticPolicy}`
    const rangeArithmeticPolicy =
      ranges && target.mode === 'sdr'
        ? selectInteractivePreviewPolicy(interactivePrecision ? 'f32' : undefined, 'hdr')
        : null
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
      policy: AcesPreviewPolicy,
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
        for (let start = 0; start < batch.jobs.length; start += this.previewPolicy.tileBatch * 4) {
          const jobs = batch.jobs.subarray(start, start + this.previewPolicy.tileBatch * 4)
          const submitting = performance.now()
          device.queue.writeBuffer(this.jobs!, 0, jobs)
          const computation = device.createCommandEncoder()
          const compute = computation.beginComputePass({
            timestampWrites: this.gpuTimings?.writes(gpuFrame, 'tile'),
          })
          compute.setPipeline(
            policy === 'reference' ? this.cachePipeline! : this.interactivePipelines.get(policy)!,
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
            if (this.abort.signal.aborted || this.requestSuperseded(request)) {
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
        if (this.abort.signal.aborted || this.requestSuperseded(request)) return false
      }
      return true
    }
    if (target.mode === 'sdr') p[15] = 0
    if (
      !(await drawPlan(
        plan,
        p,
        target.mode === 'hdr' ? this.rendering! : this.sdrRendering.get(target.colorSpace)!,
        arithmeticPolicy,
      ))
    )
      return undefined
    if (ranges && target.mode === 'sdr') {
      const rangeParams = p.slice()
      rangeParams[14] = 10
      rangeParams[41] = 1
      const rangeVariant = interactivePrecision
        ? `content-hdr:${rangeArithmeticPolicy}`
        : 'content-hdr'
      if (
        !(await drawPlan(
          { ...plan, variant: rangeVariant },
          rangeParams,
          this.rendering!,
          rangeArithmeticPolicy!,
        ))
      )
        return undefined
    }
    if (this.abort.signal.aborted) return undefined
    // Presentation has its own completion boundary; mapping an unrelated analysis
    // buffer must never delay an already sharp completed image.
    const offscreenCompletionDeferred = this.finalInteractiveFence && interactivePrecision
    if (offscreenCompletionDeferred) timings.offscreenFenceDeferred = 1
    else {
      const fencing = performance.now()
      await device.queue.onSubmittedWorkDone()
      timings.offscreenFenceMs = performance.now() - fencing
    }
    return {
      startedAt,
      timings,
      quality,
      arithmeticPolicy,
      rangeArithmeticPolicy,
      offscreenCompletionDeferred,
      completionFenced: false,
      retentionMethod: memory.retentionMethod,
      cacheBytes: memory.cacheBytes,
      histogram: { key: statisticsKey, parameters: histogramParams, presentation: request.value },
    } satisfies RenderedPresentation
  }

  private async present(
    request: HdrEditRequest<PresentationRequest>,
    rendered: RenderedPresentation,
    gpuFrame?: HdrGpuTimingFrame,
  ) {
    if (this.restoring) await this.restoring
    if (this.abort.signal.aborted || this.deviceLost || this.requestSuperseded(request))
      return false
    const { viewport, view, parameters, target, mode, ranges, inputSerial } = request.value
    const confirmed = () =>
      !this.previewPolicy.presentationCache ||
      (!!this.presentationState &&
        (this.nativePresented || sameAdjustments(this.presentationState.settings, parameters)))
    if (!confirmed()) return false
    const { timings } = rendered
    const submitting = performance.now()
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    const device = this.device!,
      deviceQueue = device.queue,
      encoder = device.createCommandEncoder()
    const retentionMethod: HdrRetentionMethod =
      rendered.retentionMethod === 'raw-half-cpu' &&
      Math.ceil((width * 8) / 256) * 256 * height <= device.limits.maxBufferSize &&
      supportsHdrRecovery()
        ? 'raw-half-cpu'
        : 'cpu-staging'
    rendered.retentionMethod = retentionMethod
    const cachedReceipt = this.cachedPaintReceipt,
      renderedIdentity = this.presentationIdentity(request.value, request.value),
      reuseCanvas =
        retentionMethod === 'raw-half-cpu' &&
        !!this.retainedCanvas &&
        rendered.quality === 'normal' &&
        rendered.arithmeticPolicy === 'reference' &&
        (rendered.rangeArithmeticPolicy === null ||
          rendered.rangeArithmeticPolicy === 'reference') &&
        !!cachedReceipt &&
        renderedIdentity?.key === cachedReceipt.identity.key &&
        this.cachedCanvasCurrent()
    timings.cachedCanvasReused = Number(reuseCanvas)
    if (!reuseCanvas) {
      // A normal blit takes canvas ownership before its map/fence can publish readiness.
      this.cachedPaintReceipt = undefined
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width
        this.canvas.height = height
      }
      const configured = `${target.mode}:${target.colorSpace}`
      if (configured !== this.configured) {
        this.configure(target)
        this.configured = configured
      }
      const pass = encoder.beginRenderPass({
        timestampWrites: this.gpuTimings?.writes(gpuFrame, 'blit'),
        colorAttachments: [
          {
            view: this.context!.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      pass.setPipeline(this.blit!)
      pass.setBindGroup(0, this.blitGroup!)
      pass.draw(3)
      pass.end()
    }
    let retained: RetainedFrameCopy | undefined
    let raw: HdrRecoveryCapture | undefined
    let recoverySnapshot: HdrRecoverySnapshot | undefined
    const current = () =>
      !this.abort.signal.aborted &&
      !this.deviceLost &&
      !this.requestSuperseded(request) &&
      confirmed() &&
      (!reuseCanvas || (this.cachedPaintReceipt === cachedReceipt && this.cachedCanvasCurrent()))
    try {
      if (retentionMethod === 'raw-half-cpu' && this.retainedCanvas) {
        const copying = performance.now()
        // Copy the exact encoded output, not Chromium's expiring drawing buffer.
        raw = this.recovery.encode(device, encoder, this.surface!, width, height)
        timings.retainedCopyMs = performance.now() - copying
      }
      deviceQueue.submit([encoder.finish()])
      const submittedAt = performance.now()
      timings.blitSubmissionMs = submittedAt - submitting - timings.retainedCopyMs
      // Same renderer clock as cachedFencedAt/nativeEditingReadyAt. The start
      // precedes canvas ownership changes; submittedAt follows the real submit.
      if (!reuseCanvas)
        Object.assign(this.canvas.dataset, {
          normalCanvasWriteStartedAt: String(submitting),
          normalCanvasSubmittedAt: String(submittedAt),
          normalCanvasSubmittedSerial: String(inputSerial),
          normalCanvasSubmittedEpoch: String(request.value.epoch),
        })
      // Tight-memory and unsupported-format fallback retains the earlier exact
      // CPU Canvas2D path, including its synchronous read/commit contract.
      if (retentionMethod === 'cpu-staging') retained = this.stageCompletedFrame()
      if (retained?.drawFailure) throw retained.drawFailure.error
      timings.retainedDrawMs = retained?.drawMs ?? 0
      timings.retainedCopyMs += timings.retainedDrawMs
      timings.retainedRawHalfUsed = Number(!!raw)
      timings.retainedCpuStagingUsed = Number(retained?.method === 'cpu-staging')
      const fencing = performance.now()
      const fence = deviceQueue.onSubmittedWorkDone().then(() => {
        rendered.completionFenced = true
        timings.finalBlitFenceMs = performance.now() - fencing
      })
      if (raw) {
        const completed = await raw.complete(fence)
        timings.retainedMapMs = completed.mapMs
        timings.retainedCpuCopyMs = completed.copyMs
        timings.retainedReadMs = completed.mapMs
        timings.retainedCopyMs += completed.copyMs
      } else await fence
      if (!current()) return false
      if (raw) {
        recoverySnapshot = {
          serial: inputSerial,
          presentationSerial: Number(this.canvas.dataset.presentationSerial ?? 0) + 1,
          sourceIdentity: request.value.sourceIdentity,
          epoch: request.value.epoch,
          settingsRevision: request.value.settingsRevision,
          target: {
            mode: target.mode,
            colorSpace: target.colorSpace,
            peak: target.peak,
            headroom: target.headroom,
            generation: target.generation,
          },
          quality: rendered.quality,
          arithmeticPolicy: rendered.arithmeticPolicy,
          width,
          height,
        }
        raw.commit(recoverySnapshot)
      } else {
        const retaining = performance.now(),
          completed = this.completeRetainedFrame(retained, current)
        timings.retainedCopyMs += performance.now() - retaining
        timings.retainedDrawMs += completed.drawMs
        timings.retainedReadMs = completed.readMs
        if (retained && current()) {
          this.recovery.clear()
          void this.recovery.releaseTransient()
        }
      }
      if (!current()) return false
    } finally {
      // A staging failure still owns the submitted source blit. Drain that
      // failure path before its source or next render can be released.
      try {
        if (!rendered.completionFenced)
          await deviceQueue.onSubmittedWorkDone().catch(() => undefined)
      } finally {
        retained?.release()
        raw?.release()
      }
    }
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
      cacheBytes: String(rendered.cacheBytes),
      presentationSerial: String(Number(this.canvas.dataset.presentationSerial ?? 0) + 1),
      completedEditSerial: String(inputSerial),
      retainedPresentationBytes: String(presentationCache.bytes),
      presentedSourceIdentity: request.value.sourceIdentity,
      presentedEpoch: String(request.value.epoch),
      displayedAnalysisKey: rendered.histogram.key,
      quality: rendered.quality,
      presentedPolicy:
        rendered.quality === 'interactive' ? ACES_INTERACTIVE_PREVIEW_VERSION : 'reference',
      presentedArithmeticPolicy: rendered.arithmeticPolicy,
      rangeArithmeticPolicy: rendered.rangeArithmeticPolicy ?? '',
      retentionMethod: rendered.retentionMethod,
      retentionWillReadFrequently: raw
        ? 'deferred-cpu-conversion'
        : String(retained?.context.getContextAttributes().willReadFrequently),
      recoveryPolicy: raw ? HDR_RECOVERY_VERSION : 'canvas2d-cpu-staging-v1',
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
    if (request.value.settingsRevision === null)
      delete this.canvas.dataset.presentedSettingsRevision
    else this.canvas.dataset.presentedSettingsRevision = String(request.value.settingsRevision)
    if (recoverySnapshot) this.canvas.dataset.recoverySnapshot = JSON.stringify(recoverySnapshot)
    else delete this.canvas.dataset.recoverySnapshot
    this.nativePresented = true
    this.invalidateFirstSurface()
    if (this.interactivePrecision) {
      this.gestureHandoff.published(
        request.value.context,
        request.value.epoch,
        parameters,
        rendered.quality === 'interactive',
        request.value.handoff
          ? { ...request.value.handoff, serial: request.value.inputSerial }
          : undefined,
      )
      this.canvas.dataset.gestureHandoff = this.gestureHandoff.phase
    }
    if (!reuseCanvas) this.hideCachedPresentation()
    const completedIdentity = this.presentationIdentity(request.value)
    if (rendered.quality === 'normal' && completedIdentity) {
      this.completedSurface = {
        surface: this.surface!,
        identity: completedIdentity,
        serial: Number(this.canvas.dataset.presentationSerial),
      }
    }
    this.canvas.dataset.presentationCacheEligible = String(!!this.completedSurface)
    if (this.retainedCanvas && retained)
      this.retainedCanvas.dataset.presentationSerial = this.canvas.dataset.presentationSerial
    this.maskKey =
      rendered.quality === 'normal'
        ? JSON.stringify([
            this.frame?.cpuSource,
            request.value.sourceIdentity,
            request.value.settingsRevision,
            request.value.mode === 'before' ? neutralAdjustments : request.value.parameters,
            maskPixelTarget(request.value.target),
            request.value.mode,
            request.value.ranges,
            rendered.quality,
          ])
        : undefined
    this.loaded()
    this.requestHistogram(rendered.histogram, request.intent === 'navigation')
    return true
  }
  private requestHistogram(snapshot: HistogramRequest, navigation: boolean) {
    this.latestHistogram = snapshot
    const published = snapshot.key === this.publishedStatisticsKey
    // A view change does not change this analysis. Preserve its settled curve;
    // real adjustment draws still publish their matching input serial.
    if (
      published &&
      (navigation || snapshot.presentation.inputSerial === this.publishedStatisticsSerial)
    ) {
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
    // A published key without its matching owned result cannot satisfy a newer draw.
    if (published) this.requestedStatisticsKey = ''
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
        const latest = this.latestHistogram
        // The key includes every histogram input; view-only draws reuse its real
        // result while retaining the serial of the latest completed presentation.
        this.publishHistogram(latest?.key === key ? latest : request.value, result)
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

  private stageCompletedFrame(): RetainedFrameCopy | undefined {
    if (!this.retainedCanvas) return undefined
    const surface = (this.retainedStaging ??= document.createElement('canvas'))
    const scale = Math.min(1, 1024 / Math.max(this.canvas.width, this.canvas.height))
    const width = Math.max(1, Math.round(this.canvas.width * scale)),
      height = Math.max(1, Math.round(this.canvas.height * scale))
    if (surface.width !== width || surface.height !== height) {
      surface.width = width
      surface.height = height
    }
    const context = surface.getContext('2d', {
      colorSpace: 'srgb',
      willReadFrequently: true,
    })!
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    let released = false
    const copy: RetainedFrameCopy = {
      method: 'cpu-staging',
      surface,
      context,
      width,
      height,
      drawMs: 0,
      readbackComplete: false,
      finished,
      release: () => {
        if (released) return
        released = true
        // Discard unflushed drawing commands and their source owner after an
        // interrupted frame. Never read or commit a stale stage to do cleanup.
        try {
          if (!copy.readbackComplete) {
            surface.width = 0
            surface.height = 0
          }
        } finally {
          if (this.retainedCopy === copy) this.retainedCopy = undefined
          finish()
        }
      },
    }
    this.retainedCopy = copy
    const drawing = performance.now()
    try {
      context.drawImage(this.canvas, 0, 0, width, height)
    } catch (error) {
      // Return the owner even if staging throws, so present drains the captured
      // source queue before discarding the private canvas and releasing load.
      copy.drawFailure = { error }
    }
    copy.drawMs = performance.now() - drawing
    return copy
  }
  private async releaseRetainedStaging() {
    if (this.retainedCopy) await this.retainedCopy.finished
    if (this.retainedStaging) {
      this.retainedStaging.width = 0
      this.retainedStaging.height = 0
    }
    this.retainedStaging = undefined
  }
  private completeRetainedFrame(copy: RetainedFrameCopy | undefined, current: () => boolean) {
    const surface = this.retainedCanvas
    if (!copy || !surface) return { drawMs: 0, readMs: 0 }
    if (copy.context.isContextLost()) throw new Error('The recovery staging context was lost.')
    const reading = performance.now()
    copy.context.getImageData(0, 0, 1, 1)
    if (copy.context.isContextLost()) throw new Error('The recovery staging readback was lost.')
    copy.readbackComplete = true
    let readMs = performance.now() - reading
    if (!current()) return { drawMs: 0, readMs }
    if (surface.width !== copy.width || surface.height !== copy.height) {
      surface.width = copy.width
      surface.height = copy.height
    }
    const context = surface.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!
    const drawing = performance.now()
    context.drawImage(copy.surface, 0, 0)
    const drawMs = performance.now() - drawing
    const committing = performance.now()
    context.getImageData(0, 0, 1, 1)
    readMs += performance.now() - committing
    return { drawMs, readMs }
  }
  /** Materialize before a DOM ref is cleared; no lost-device access is needed. */
  recoverCompletedFrame(surface = this.retainedCanvas): boolean {
    if (!surface || this.canvas.dataset.editing !== 'ready') return false
    const snapshot = this.recovery.snapshot
    if (this.canvas.dataset.retentionMethod !== 'raw-half-cpu')
      return surface.dataset.presentationSerial === this.canvas.dataset.presentationSerial
    if (
      !snapshot ||
      String(snapshot.serial) !== this.canvas.dataset.completedEditSerial ||
      String(snapshot.presentationSerial) !== this.canvas.dataset.presentationSerial ||
      snapshot.sourceIdentity !== this.canvas.dataset.presentedSourceIdentity ||
      String(snapshot.epoch) !== this.canvas.dataset.presentedEpoch ||
      String(snapshot.target.generation) !== this.canvas.dataset.targetGeneration
    )
      return false
    if (
      surface.dataset.presentationSerial === String(snapshot.presentationSerial) &&
      surface.dataset.recoverySnapshot === this.canvas.dataset.recoverySnapshot &&
      surface.dataset.recoveryMaterialized === 'true'
    )
      return true
    try {
      return this.recovery.recover(surface)
    } catch (error) {
      this.canvas.dataset.recoveryError = String(error).slice(0, 512)
      return false
    }
  }
  dispose() {
    if (this.abort.signal.aborted) return
    const completed = this.completedSurface,
      currentIdentity = this.presentationIdentity(),
      confirmed =
        !!this.presentationState &&
        !!this.view &&
        !this.gesturing &&
        sameAdjustments(this.presentationState.settings, this.view.parameters),
      running = this.running,
      pending = this.queue.hasPending,
      restoring = !!this.restoring,
      identityMatches = !!completed && currentIdentity?.key === completed.identity.key,
      cacheEligible = this.presentationHeadroom?.eligible ?? false,
      reservationBytes = this.presentationHeadroom?.reservationBytes ?? 0,
      bytesBefore = presentationCache.bytes
    let departureReason: HdrPresentationDepartureReason = !this.previewPolicy.presentationCache
      ? 'disabled'
      : this.presentationHeadroom?.bypassed
        ? 'memory-bypass'
        : !cacheEligible
          ? 'closed'
          : !confirmed
            ? 'unconfirmed'
            : running
              ? 'running'
              : pending
                ? 'pending'
                : restoring
                  ? 'restoring'
                  : !completed
                    ? 'not-completed'
                    : !identityMatches || completed.surface !== this.surface
                      ? 'identity-changed'
                      : 'not-admitted'
    this.releaseActivity?.()
    this.releaseActivity = undefined
    this.releaseHistogramActivity?.()
    this.releaseHistogramActivity = undefined
    this.abort.abort()
    const maskDrained = this.maskReservation.cancelAndDrain()
    this.invalidateFirstSurface()
    const retentionDrained = Promise.all([
      maskDrained,
      this.releaseRetainedStaging(),
      this.recovery.dispose(),
      this.loadWork?.catch(() => undefined),
      this.firstSurfaceWork?.catch(() => undefined),
    ]).then(async () => {
      await this.releaseSource()
      this.cachedPaintReceipt = undefined
      this.context?.unconfigure()
    })
    const retired = retentionDrained.finally(() => retiredPreviewOwners.delete(retired))
    this.retirement = retired
    retiredPreviewOwners.add(retired)
    if (this.deviceObserver) this.deviceObserver.lost = undefined
    this.hideCachedPresentation()
    this.statisticsPending(false)
    const releaseBitmaps = this.releaseBitmaps
    this.releaseBitmaps = undefined
    void retentionDrained.then(releaseBitmaps, releaseBitmaps)
    this.ready = false
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
    if (
      cacheEligible &&
      this.device &&
      completed &&
      !running &&
      !pending &&
      !restoring &&
      completed.surface === this.surface &&
      identityMatches &&
      presentationCache.retain(this.device, completed.identity, {
        surface: completed.surface,
        width: completed.identity.width,
        height: completed.identity.height,
        completed: true,
        quality: 'normal',
        transient: false,
        serial: completed.serial,
      })
    ) {
      this.surface = undefined
      departureReason = 'retained'
    }
    this.surface?.destroy()
    this.canvas.dataset.retainedPresentationBytes = String(presentationCache.bytes)
    this.canvas.dataset.presentationDeparture = JSON.stringify({
      reason: departureReason,
      completed: !!completed,
      confirmed,
      running,
      pending,
      restoring,
      identityMatches,
      cacheEligible,
      reservationBytes,
      bytesBefore,
      bytesAfter: presentationCache.bytes,
    })
    this.presentationHeadroom?.dispose()
    this.invalidate()
  }
}
