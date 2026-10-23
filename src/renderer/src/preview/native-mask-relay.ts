import type { WorkingFrame } from '../../../shared/adjustments'
import {
  type NativeHdrMaskBridge,
  type NativeHdrMaskRequest,
  type NativeHdrMaskOutcome,
} from '../../../shared/native-hdr-mask'
import { nativeHdrMaskMemory } from '../../../shared/native-hdr-mask-memory'
import { verifyNativeMaskMath } from './native-mask-math'
import type { NativeMaskReservation } from './native-mask-reservation'
export type NativeMaskDraft = Omit<NativeHdrMaskRequest, 'existingOwners'>
export type ReserveNativeMask = (
  frame: WorkingFrame,
  cancel: () => void,
  drained: Promise<void>,
) => NativeMaskReservation | undefined
interface Flight {
  request: NativeHdrMaskRequest
  result?: NativeHdrMaskOutcome
  scope: NativeMaskReservation
  native: Promise<void>
  cancel?: Promise<void>
  done: Promise<void>
  finish: () => void
}
/** One relay for the existing worker's one current operation. It owns no queue. */
export class NativeMaskRelay {
  private flight?: Flight
  private closed = false
  constructor(
    private readonly worker: Worker,
    private readonly bridge: NativeHdrMaskBridge,
    private readonly frame: WorkingFrame,
    private readonly reserve: ReserveNativeMask,
  ) {}
  start(draft: NativeMaskDraft) {
    if (this.closed || this.flight) {
      this.worker.postMessage({
        nativeReply: {
          generation: draft.generation,
          error: 'Native mask owner is no longer available.',
        },
      })
      return
    }
    if (
      !this.frame.cpuSource ||
      JSON.stringify(draft.source) !== JSON.stringify(this.frame.cpuSource) ||
      draft.source.workingSha256 !== this.frame.hdr?.sha256
    ) {
      this.worker.postMessage({
        nativeReply: {
          generation: draft.generation,
          error: 'Native mask source changed before admission.',
        },
      })
      return
    }
    try {
      verifyNativeMaskMath()
    } catch (error) {
      this.worker.postMessage({
        nativeReply: { generation: draft.generation, error: String(error) },
      })
      return
    }
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const flight: { current?: Flight } = {}
    const cancel = () => {
      this.worker.postMessage({
        cancel: {
          generation: draft.generation,
          maskError: 'Clipping overlay was interrupted. Enable it again to retry.',
        },
      })
      if (flight.current) this.cancel(flight.current.request.generation)
    }
    const scope = this.reserve(this.frame, cancel, done)
    if (!scope) {
      finish()
      this.worker.postMessage({
        nativeReply: {
          generation: draft.generation,
          error: 'Clipping overlay exceeds its current presenter resource budget.',
        },
      })
      return
    }
    const request: NativeHdrMaskRequest = { ...draft, existingOwners: scope.existingOwners }
    const owned: Flight = { request, scope, done, finish, native: Promise.resolve() }
    flight.current = owned
    this.flight = owned
    // Register the complete receiver lifetime before IPC can allocate its child.
    owned.native = this.bridge
      .renderHdrMask(request)
      .then((result) => {
        owned.result = result
        if (result.kind === 'mask') {
          if (
            result.policy.version !== 'managed-image-memory-v1' ||
            result.policy.scope !== 'managed-image-resources' ||
            !Number.isSafeInteger(result.policy.revision) ||
            result.policy.revision < 0 ||
            ![result.policy.ram.effectiveBytes, result.policy.vram.effectiveBytes].every(
              (value) => Number.isSafeInteger(value) && value >= 0,
            )
          )
            throw new Error('Invalid main native mask policy.')
          const mainPlan = nativeHdrMaskMemory(
            this.frame.width,
            this.frame.height,
            scope.existingOwners,
            result.policy,
          )
          const localPlan = nativeHdrMaskMemory(
            this.frame.width,
            this.frame.height,
            scope.existingOwners,
            scope.policy,
          )
          if (
            !mainPlan.accepted ||
            !localPlan.accepted ||
            result.additionalReservation.ramBytes !== scope.additionalReservation.ramBytes ||
            result.additionalReservation.vramBytes !== scope.additionalReservation.vramBytes ||
            result.additionalReservation.ramBytes !== mainPlan.additional.ramBytes ||
            result.additionalReservation.vramBytes !== mainPlan.additional.vramBytes
          )
            throw new Error('Native mask reservation changed after admission.')
        }
        this.worker.postMessage({
          nativeReply: { generation: request.generation, request, result },
        })
      })
      .catch((error) => {
        this.worker.postMessage({
          nativeReply: { generation: request.generation, error: String(error) },
        })
      })
  }
  cancel(generation: number) {
    const flight = this.flight
    if (!flight || flight.request.generation !== generation) return
    flight.cancel ??= this.bridge.cancelHdrMask(flight.request.sessionId, flight.request.requestId)
    // Observed again by drain; do not produce an unhandled rejection meanwhile.
    void flight.cancel.catch(() => undefined)
  }
  async drained(generation: number) {
    const flight = this.flight
    if (!flight || flight.request.generation !== generation) {
      this.worker.postMessage({ nativeReleased: { generation } })
      return
    }
    let failure: unknown
    try {
      try {
        await flight.native
      } catch (error) {
        failure = error
      }
      try {
        if (flight.cancel) await flight.cancel
      } catch (error) {
        failure ??= error
      }
      // Cancellation failure cannot skip release of an already issued output.
      try {
        if (flight.result?.kind === 'mask')
          await this.bridge.releaseHdrMask(flight.request.sessionId, flight.result.maskId)
      } catch (error) {
        failure ??= error
      }
    } finally {
      flight.scope.release()
      flight.finish()
      if (this.flight === flight) this.flight = undefined
      this.worker.postMessage({
        nativeReleased: { generation, error: failure === undefined ? undefined : String(failure) },
      })
    }
  }
  /** An unrelated uncaught error does not prove a WebCrypto owner is gone. */
  async workerFailed() {
    this.closed = true
    const flight = this.flight
    if (!flight) return
    this.cancel(flight.request.generation)
    this.worker.postMessage({ cancel: { generation: flight.request.generation } })
    // Keep the worker alive: only its genuine nativeDrained message may finish
    // a receiver already awaiting a real digest. An unresponsive worker remains
    // fail-closed; it cannot authorize a new HDR owner by synthetic completion.
    await flight.done
  }
  close() {
    this.closed = true
    const flight = this.flight
    if (flight) this.cancel(flight.request.generation)
    return flight?.done ?? Promise.resolve()
  }
}
