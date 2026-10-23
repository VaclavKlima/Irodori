import type { AdjustmentParameters, WorkingFrame } from '../../../shared/adjustments'
import type { DisplayTarget } from '../../../shared/hdr'
import {
  NativeMaskReservationOwner,
  sameMaskFrame,
  type NativeMaskReservation,
} from './native-mask-reservation'
import type {
  NativeCpuPreviewBridge,
  CpuPreviewPair,
  CpuPreviewPlane,
  CpuPreviewSourceRef,
} from '../../../shared/native-cpu-preview'
import { NATIVE_CPU_PREVIEW_VERSION } from '../../../shared/native-cpu-preview'
import {
  nativeCpuMemory,
  nativeCpuExistingOwners,
  nativeCpuResidentMemory,
} from '../../../shared/native-cpu-memory'

export interface CpuClientInput {
  readonly frame: WorkingFrame
  readonly generation: number
  readonly settingsRevision: number
  readonly parameters: AdjustmentParameters
  readonly hdrRanges: boolean
  readonly target?: DisplayTarget
  readonly viewport: { width: number; height: number; dpr: number }
}
export interface CpuClientReply {
  generation: number
  parameters: AdjustmentParameters
  hdrRanges: boolean
  draft: boolean
  bitmap: ImageBitmap
  neutral: ImageBitmap
  sample: Float32Array<ArrayBuffer>
  draftSample: Float32Array<ArrayBuffer>
  native: CpuPreviewPair
  target?: DisplayTarget
}
function sameSource(a: CpuPreviewSourceRef, b: CpuPreviewSourceRef) {
  return (
    a.photoId === b.photoId &&
    a.cacheId === b.cacheId &&
    a.workingSha256 === b.workingSha256 &&
    a.renderingIdentity === b.renderingIdentity
  )
}
async function checkedBytes(
  url: string,
  byteLength: number,
  expectedSha: string,
  signal: AbortSignal,
) {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok || Number(response.headers.get('content-length')) !== byteLength)
    throw new Error('Incomplete native CPU output.')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength !== byteLength) throw new Error('Incorrect native CPU output length.')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const actual = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')
  if (actual !== expectedSha) throw new Error('Damaged native CPU output.')
  signal.throwIfAborted()
  return bytes
}
async function bitmap(plane: CpuPreviewPlane, signal: AbortSignal) {
  if (plane.format !== 'rgba8-srgb' || plane.byteLength !== plane.width * plane.height * 4)
    throw new Error('Invalid native CPU plane geometry.')
  const bytes = await checkedBytes(plane.url, plane.byteLength, plane.sha256, signal)
  const image = await createImageBitmap(
    new ImageData(new Uint8ClampedArray(bytes), plane.width, plane.height, { colorSpace: 'srgb' }),
  )
  if (signal.aborted || image.width !== plane.width || image.height !== plane.height) {
    image.close()
    signal.throwIfAborted()
    throw new Error('Native CPU bitmap dimensions do not match.')
  }
  return image
}

/** One latest request and one receiver pipeline. Native errors are terminal for
 * this owner; there is no automatic JS recovery after native selection. */
export class NativeCpuClient {
  private sessionId = crypto.randomUUID()
  private source?: CpuPreviewSourceRef
  private pending?: CpuClientInput
  private current?: { abort: AbortController; requestId: string; suppressCancel: boolean }
  private work?: Promise<void>
  private displayed?: CpuPreviewPair
  private failed = false
  private closed = false
  private draining?: Promise<void>
  private constructing?: { width: number; height: number; threads: 1 | 4 | 8 }
  private readonly maskReservation = new NativeMaskReservationOwner()
  private reservationInput?: CpuClientInput
  private observation?: {
    readonly limits: {
      readonly ramBytes: number
      readonly gpuBytes: number
      readonly revision: number
    }
    readonly peak: { readonly ramBytes: number; readonly gpuBytes: number }
  }
  get memory() {
    return this.observation
  }
  get hasMaskReservation(): boolean {
    return this.maskReservation.active
  }
  cancelMasks(): Promise<void> {
    return this.maskReservation.cancelAndDrain()
  }
  reserveMask(
    frame: WorkingFrame,
    cancel: () => void,
    drained: Promise<void>,
  ): NativeMaskReservation | undefined {
    const pair = this.displayed,
      input = this.reservationInput
    // Actual bitmap/sample receiver work has finished before suppressCancel.
    // Publication may still be awaiting its disk-capability ACK; no new image
    // allocation is authorized by that final control-only acknowledgement.
    if (
      this.closed ||
      this.failed ||
      (this.current && !this.current.suppressCancel) ||
      this.pending ||
      this.constructing ||
      !pair ||
      pair.quality !== 'normal' ||
      !input ||
      !sameMaskFrame(input.frame, frame) ||
      this.maskReservation.active ||
      !this.canDraw(input)
    )
      return undefined
    const memory = this.observation!
    const scope = this.maskReservation.reserve(
      frame.width,
      frame.height,
      { ramBytes: memory.peak.ramBytes, vramBytes: memory.peak.gpuBytes },
      pair.policy,
      cancel,
      drained,
    )
    if (scope)
      this.observation = {
        ...memory,
        peak: {
          ramBytes: memory.peak.ramBytes + scope.additionalReservation.ramBytes,
          gpuBytes: memory.peak.gpuBytes + scope.additionalReservation.vramBytes,
        },
      }
    return scope
  }
  private existingOwners(input: CpuClientInput, width: number, height: number) {
    const ordinary = nativeCpuExistingOwners(input.frame.width, input.frame.height, width, height),
      mask = this.maskReservation.bytes
    return {
      ramBytes: ordinary.ramBytes + mask.ramBytes,
      gpuBytes: ordinary.gpuBytes + mask.vramBytes,
    }
  }
  constructor(
    private readonly bridge: NativeCpuPreviewBridge,
    private readonly prerequisite: Promise<void>,
    /** True transfers both bitmap owners to the presenter synchronously. */
    private readonly publish: (reply: CpuClientReply) => boolean,
    private readonly failure: (error: unknown) => void,
    private readonly limitation?: (fullBlocked: boolean) => void,
  ) {}
  post(input: CpuClientInput) {
    if (this.closed || this.failed) return
    // Presentation owns priority. Its next IPC waits the same native/browser drain.
    void this.cancelMasks()
    // Native consumes the leased source, never WorkingFrame.data. Snapshot only
    // metadata; a caller must not accidentally clone a full F32 image here.
    this.pending = structuredClone({
      ...input,
      frame: { ...input.frame, data: new Float32Array(0) },
    })
    this.current?.abort.abort(new Error('CPU renderer input superseded.'))
    this.start()
  }
  cancel() {
    this.pending = undefined
    this.current?.abort.abort(new Error('CPU render invalidated.'))
  }
  private start() {
    if (this.work || this.closed || this.failed) return
    const work = this.pump()
    this.work = work
    const finished = () => {
      if (this.work === work) this.work = undefined
      if (this.pending) this.start()
    }
    void work.then(finished, finished)
  }
  private async pump() {
    while (this.pending && !this.closed && !this.failed) {
      const input = this.pending
      this.pending = undefined
      const active = { abort: new AbortController(), requestId: '', suppressCancel: false }
      this.current = active
      try {
        await this.prerequisite
        await this.cancelMasks()
        active.abort.signal.throwIfAborted()
        const source = input.frame.cpuSource
        if (!source || !input.frame.hdr || source.workingSha256 !== input.frame.hdr.sha256)
          throw new Error('CPU source has no trusted prepared-cache reference.')
        if (this.source && !sameSource(this.source, source)) {
          await this.bridge.releaseCpuPreview(this.sessionId, null)
          this.sessionId = crypto.randomUUID()
          this.displayed = undefined
          this.limitation?.(false)
        }
        this.source = source
        const qualities =
          Math.max(input.frame.width, input.frame.height) > 1024
            ? (['draft', 'normal'] as const)
            : (['normal'] as const)
        for (const quality of qualities) {
          active.abort.signal.throwIfAborted()
          active.requestId = crypto.randomUUID()
          active.suppressCancel = false
          const requestedScale =
            quality === 'draft' ? 1024 / Math.max(input.frame.width, input.frame.height) : 1
          this.constructing = {
            width: Math.max(1, Math.round(input.frame.width * requestedScale)),
            height: Math.max(1, Math.round(input.frame.height * requestedScale)),
            threads: 8,
          }
          const cancel = () => {
            if (!active.suppressCancel)
              void this.bridge
                .cancelCpuPreview(this.sessionId, active.requestId)
                .catch((error: unknown) => this.failure(error))
          }
          active.abort.signal.addEventListener('abort', cancel, { once: true })
          let pair: CpuPreviewPair | undefined,
            after: ImageBitmap | undefined,
            before: ImageBitmap | undefined,
            adopted = false
          try {
            const outcome = await this.bridge.renderCpuPreview({
              version: NATIVE_CPU_PREVIEW_VERSION,
              requestId: active.requestId,
              sessionId: this.sessionId,
              source,
              generation: input.generation,
              expectedSettingsRevision: input.settingsRevision,
              parameters: input.parameters,
              quality,
              hdrRanges: input.hdrRanges,
              headroom: input.target?.headroom ?? null,
              viewport: input.viewport,
            })
            active.abort.signal.throwIfAborted()
            if ('kind' in outcome) {
              if (
                outcome.version !== NATIVE_CPU_PREVIEW_VERSION ||
                outcome.requestId !== active.requestId ||
                outcome.sessionId !== this.sessionId ||
                outcome.generation !== input.generation
              )
                throw new Error('Native CPU admission metadata is stale or mismatched.')
              // Local cancellation already unwinds through the abort check above.
              // A still-current request must finish through failure, not stay loading.
              if (outcome.kind === 'cancelled')
                throw new Error('Native CPU request was cancelled while still current.')
              if (
                outcome.kind !== 'memory-limit' ||
                (this.displayed && outcome.policy.revision !== this.displayed.policy.revision)
              )
                throw new Error('Native CPU admission metadata is stale or mismatched.')
              if (quality === 'normal' && this.hasMatchingDraft(input)) {
                // No new output owners exist. Keep the acknowledged current
                // draft and its session; subsequent edits can still request drafts.
                this.constructing = undefined
                this.limitation?.(true)
                break
              }
              throw new Error(
                'CPU preview exceeds its managed image resource budget before a matching draft is available.',
              )
            }
            pair = outcome
            if (
              pair.version !== NATIVE_CPU_PREVIEW_VERSION ||
              pair.quality !== quality ||
              pair.requestId !== active.requestId ||
              pair.sessionId !== this.sessionId ||
              pair.generation !== input.generation ||
              pair.settingsRevision !== input.settingsRevision ||
              !sameSource(pair.source, source) ||
              JSON.stringify(pair.parameters) !== JSON.stringify(input.parameters) ||
              pair.hdrRanges !== input.hdrRanges ||
              pair.headroom !== (input.target?.headroom ?? null) ||
              pair.sourceDimensions.width !== input.frame.width ||
              pair.sourceDimensions.height !== input.frame.height ||
              (this.displayed && pair.policy.revision !== this.displayed.policy.revision)
            )
              throw new Error('Native CPU response metadata is stale or mismatched.')
            const base = `luma-photo://library/${source.photoId}/cpu/${pair.pairId}`
            if (
              pair.after.url !== `${base}/after` ||
              pair.before.url !== `${base}/before` ||
              pair.samples.url !== `${base}/samples`
            )
              throw new Error('Native CPU response capability URLs do not match their pair.')
            const scale =
              quality === 'draft' ? 1024 / Math.max(input.frame.width, input.frame.height) : 1
            const width = Math.max(1, Math.round(input.frame.width * scale)),
              height = Math.max(1, Math.round(input.frame.height * scale))
            if (
              pair.after.width !== width ||
              pair.after.height !== height ||
              pair.before.width !== width ||
              pair.before.height !== height
            )
              throw new Error('Native CPU response changed the requested detail geometry.')
            this.admit(input, pair)
            this.constructing = { width, height, threads: pair.diagnostics.threads }
            after = await bitmap(pair.after, active.abort.signal)
            before = await bitmap(pair.before, active.abort.signal)
            const n = input.frame.width * input.frame.height,
              sampleCount = Math.min(65536, n),
              draftCount = Math.min(8192, n)
            if (
              pair.samples.format !== 'rgba-f32le-straight' ||
              pair.samples.sampleCount !== sampleCount ||
              pair.samples.draftCount !== draftCount ||
              pair.samples.byteLength !== (sampleCount + draftCount) * 16
            )
              throw new Error('Native CPU source samples have incorrect dimensions.')
            const bytes = await checkedBytes(
              pair.samples.url,
              pair.samples.byteLength,
              pair.samples.sha256,
              active.abort.signal,
            )
            const all = new Float32Array(bytes)
            for (let i = 0; i < all.length; i += 4)
              if (
                ![all[i], all[i + 1], all[i + 2], all[i + 3]].every(Number.isFinite) ||
                all[i + 3] < 0 ||
                all[i + 3] > 1
              )
                throw new Error('Invalid native CPU source sample.')
            active.abort.signal.throwIfAborted()
            this.constructing = undefined
            active.suppressCancel = true
            const previousPair = this.displayed
            this.displayed = pair
            adopted = this.publish({
              generation: input.generation,
              parameters: input.parameters,
              hdrRanges: input.hdrRanges,
              draft: pair.quality === 'draft',
              bitmap: after,
              neutral: before,
              sample: new Float32Array(bytes, 0, sampleCount * 4),
              draftSample: new Float32Array(bytes, sampleCount * 16, draftCount * 4),
              native: pair,
              target: input.target,
            })
            if (!adopted) {
              this.displayed = previousPair
              throw new Error('CPU pair was rejected before publication.')
            }
            if (pair.quality === 'normal') this.limitation?.(false)
            await this.bridge.acknowledgeCpuPreview(
              this.sessionId,
              pair.pairId,
              previousPair?.pairId ?? null,
            )
            // Both old bitmaps were closed by publish before this ACK. Only now
            // may the next full-quality job allocate another pair.
          } finally {
            active.abort.signal.removeEventListener('abort', cancel)
            if (!adopted) {
              after?.close()
              before?.close()
              if (pair) await this.bridge.releaseCpuPreview(this.sessionId, pair.pairId)
            }
          }
        }
      } catch (error) {
        if (!active.abort.signal.aborted && !this.closed) {
          this.failed = true
          this.pending = undefined
          await this.bridge.releaseCpuPreview(this.sessionId, null).catch(() => undefined)
          this.failure(error)
        }
      } finally {
        this.constructing = undefined
        if (this.current === active) this.current = undefined
      }
    }
  }
  private admit(input: CpuClientInput, pair: CpuPreviewPair) {
    const width = Math.max(1, Math.round(input.viewport.width * input.viewport.dpr)),
      height = Math.max(1, Math.round(input.viewport.height * input.viewport.dpr))
    const plan = nativeCpuMemory(
      {
        sourceWidth: input.frame.width,
        sourceHeight: input.frame.height,
        outputWidth: pair.after.width,
        outputHeight: pair.after.height,
        canvasWidth: width,
        canvasHeight: height,
        threads: pair.diagnostics.threads,
        oldPairBytes: this.displayed
          ? this.displayed.after.byteLength + this.displayed.before.byteLength
          : 0,
        existingOwners: this.existingOwners(input, width, height),
      },
      {
        ramBytes: pair.policy.ram.effectiveBytes,
        gpuBytes: pair.policy.vram.effectiveBytes,
        revision: pair.policy.revision,
      },
    )
    if (!plan.accepted)
      throw new Error('CPU bitmap construction exceeds its frozen resource policy.')
    this.observation = plan
    return plan
  }
  /** Receipt for keeping existing pixels, never permission for new allocation. */
  hasMatchingDraft(input: CpuClientInput) {
    const pair = this.displayed
    const source = input.frame.cpuSource
    return (
      !!pair &&
      pair.quality === 'draft' &&
      !!source &&
      sameSource(pair.source, source) &&
      pair.generation === input.generation &&
      pair.settingsRevision === input.settingsRevision &&
      JSON.stringify(pair.parameters) === JSON.stringify(input.parameters) &&
      pair.hdrRanges === input.hdrRanges &&
      pair.headroom === (input.target?.headroom ?? null)
    )
  }
  canRetainWhileConstructing(input: CpuClientInput) {
    const source = input.frame.cpuSource
    return (
      !!this.constructing &&
      !!this.displayed &&
      !!source &&
      sameSource(this.displayed.source, source)
    )
  }
  canDraw(input: CpuClientInput) {
    if (!this.displayed) return false
    try {
      if (this.constructing) {
        this.admit(input, {
          ...this.displayed,
          after: {
            ...this.displayed.after,
            width: this.constructing.width,
            height: this.constructing.height,
          },
          diagnostics: { ...this.displayed.diagnostics, threads: this.constructing.threads },
        })
        this.reservationInput = input
        return true
      }
      const width = Math.max(1, Math.round(input.viewport.width * input.viewport.dpr)),
        height = Math.max(1, Math.round(input.viewport.height * input.viewport.dpr))
      const pair = this.displayed
      const plan = nativeCpuResidentMemory(
        {
          sourceWidth: input.frame.width,
          sourceHeight: input.frame.height,
          outputWidth: pair.after.width,
          outputHeight: pair.after.height,
          canvasWidth: width,
          canvasHeight: height,
          threads: pair.diagnostics.threads,
          oldPairBytes: 0,
          existingOwners: this.existingOwners(input, width, height),
        },
        {
          ramBytes: pair.policy.ram.effectiveBytes,
          gpuBytes: pair.policy.vram.effectiveBytes,
          revision: pair.policy.revision,
        },
      )
      if (plan.accepted) {
        this.observation = plan
        this.reservationInput = input
      }
      return plan.accepted
    } catch {
      return false
    }
  }
  dispose(): Promise<void> {
    if (this.draining) return this.draining
    this.closed = true
    this.pending = undefined
    this.current?.abort.abort(new Error('CPU presenter disposed.'))
    const maskDrained = this.cancelMasks()
    this.draining = (async () => {
      // Eager cache retirement may exist before the first post. Do not let a
      // following GPU owner allocate while that prerequisite can still clear it.
      await Promise.allSettled([this.prerequisite, this.work, maskDrained])
      await this.bridge.releaseCpuPreview(this.sessionId, null)
    })()
    return this.draining
  }
}
