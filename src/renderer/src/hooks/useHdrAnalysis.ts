import { observeHdrSample, reuseHdrContent } from '../preview/hdr-sample'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  sameAdjustments,
  type WorkingFrame,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
import type { EditState } from '../../../shared/edits'
import { SDR_TARGET, type DisplayTarget } from '../../../shared/hdr'
import type { HdrAnalysisDomain, HdrStatistics } from '../../../shared/hdr-statistics'
import { NATIVE_HDR_MASK_VERSION } from '../../../shared/native-hdr-mask'
import {
  NativeMaskRelay,
  type NativeMaskDraft,
  type ReserveNativeMask,
} from '../preview/native-mask-relay'
import type { ClippingMask } from './usePreviewAnalysis'
export interface NativeMaskContext {
  readonly confirmed: EditState | null
  readonly comparison: 'before' | 'after'
  readonly presentationSerial: number
  readonly reserve: ReserveNativeMask
}
export function useHdrAnalysis(
  frame: WorkingFrame | null,
  parameters: AdjustmentParameters,
  target: DisplayTarget,
  domain: HdrAnalysisDomain,
  masks: boolean,
  statistics: (result?: HdrStatistics) => void,
  mask: (result?: ClippingMask) => void,
  gesturing = false,
  sampleStatistics = true,
  activity?: () => () => void,
  nativeContext?: NativeMaskContext,
) {
  const [failure, setFailure] = useState<{
    identity: string
    message: string
    kind: 'statistics' | 'mask'
  }>()
  const [backend, setBackend] = useState<'native' | 'javascript'>()
  const releaseActivity = useRef<(() => void) | undefined>(undefined)
  const [unavailable, setUnavailable] = useState<{
    frame: WorkingFrame
    message: string
    kind: 'statistics' | 'mask'
  }>()
  const worker = useRef<Worker | null>(null),
    relay = useRef<NativeMaskRelay | undefined>(undefined),
    generation = useRef(0),
    requestIdentity = useRef(''),
    sessionId = useRef(crypto.randomUUID())
  const key = JSON.stringify(parameters)
  // Display reports carry changing timings. Analysis depends on actual pixel
  // fields, so those reports cannot restart an identical full-mask job.
  const selectedTarget = useMemo<DisplayTarget>(
    () =>
      domain === 'working-hdr'
        ? SDR_TARGET
        : {
            generation: target.generation,
            requested: target.requested,
            mode: target.mode,
            colorSpace: target.colorSpace,
            peak: target.peak,
            headroom: target.headroom,
            outputVersion: target.outputVersion,
            physicalOutputVerified: false,
            reason: 'Current HDR analysis pixel target.',
          },
    [
      domain,
      target.generation,
      target.requested,
      target.mode,
      target.colorSpace,
      target.peak,
      target.headroom,
      target.outputVersion,
    ],
  )
  const confirmed = nativeContext?.confirmed
  const reserveNativeMask = nativeContext?.reserve
  const comparison = nativeContext?.comparison
  const nativeEligible = !!(
    frame?.cpuSource &&
    frame.hdr &&
    confirmed &&
    confirmed.photoId === frame.cpuSource.photoId &&
    frame.cpuSource.workingSha256 === frame.hdr.sha256 &&
    (nativeContext?.comparison === 'before' || sameAdjustments(confirmed.settings, parameters))
  )
  const identity = JSON.stringify([
    frame?.identity,
    key,
    selectedTarget.generation,
    selectedTarget.requested,
    selectedTarget.mode,
    selectedTarget.colorSpace,
    selectedTarget.peak,
    selectedTarget.headroom,
    selectedTarget.outputVersion,
    domain,
    masks,
    backend === 'native'
      ? [
          nativeEligible,
          confirmed?.revision,
          nativeContext?.comparison,
          nativeContext?.presentationSerial,
        ]
      : null,
  ])
  useEffect(() => {
    let current = true
    void window.luma.getCpuPreviewBackend().then(
      (value) => {
        if (current) setBackend(value)
      },
      (error) => {
        if (current)
          setFailure({
            identity: requestIdentity.current,
            message: String(error),
            kind: 'statistics',
          })
      },
    )
    return () => {
      current = false
    }
  }, [])
  useEffect(() => {
    if (!frame?.hdr || !backend) return
    const instance = new Worker(new URL('../preview/hdr-analysis-worker.ts', import.meta.url), {
      type: 'module',
    })
    let closing = false,
      failed = false
    const operationGeneration = generation
    const ownedRelay =
      backend === 'native' && reserveNativeMask
        ? new NativeMaskRelay(instance, window.luma, frame, reserveNativeMask)
        : undefined
    const unsubscribe = observeHdrSample(frame.hdr.sha256, (sample, draftSample) =>
      instance.postMessage({ sample, draftSample }),
    )
    worker.current = instance
    relay.current = ownedRelay
    instance.postMessage({ asset: frame.hdr })
    instance.onmessage = ({ data }) => {
      if (data.nativeStart) {
        ownedRelay?.start(data.nativeStart as NativeMaskDraft)
        return
      }
      if (data.nativeCancel) {
        ownedRelay?.cancel(data.nativeCancel.generation)
        return
      }
      if (data.nativeDrained) {
        void ownedRelay?.drained(data.nativeDrained.generation)
        return
      }
      if (closing || failed) return
      if (data.generation !== generation.current) return
      if (data.done || data.error) {
        releaseActivity.current?.()
        releaseActivity.current = undefined
        setUnavailable(undefined)
      }
      if (data.error || data.maskError)
        setFailure({
          identity: requestIdentity.current,
          message: data.error ?? data.maskError,
          kind: data.maskError || data.errorKind === 'mask' ? 'mask' : 'statistics',
        })
      if (data.statistics && sampleStatistics) {
        setFailure(undefined)
        statistics(
          domain === 'content-hdr'
            ? reuseHdrContent(frame.hdr!.sha256, data.parameters, data.statistics)
            : data.statistics,
        )
      }
      if (data.mask) mask(data.mask)
    }
    instance.onerror = (event) => {
      failed = true
      const kind = sampleStatistics ? ('statistics' as const) : ('mask' as const)
      if (worker.current === instance) worker.current = null
      if (!closing) {
        setUnavailable({ frame, message: event.message, kind })
        setFailure({ identity: requestIdentity.current, message: event.message, kind })
      }
      // Keep the receiver responsive until it actually reports hash/reducer
      // drain. Termination is not evidence that an underlying digest finished.
      void (ownedRelay?.workerFailed() ?? Promise.resolve()).finally(() => {
        instance.terminate()
        if (!closing) {
          releaseActivity.current?.()
          releaseActivity.current = undefined
        }
      })
    }
    return () => {
      closing = true
      unsubscribe()
      const release = releaseActivity.current
      releaseActivity.current = undefined
      if (worker.current === instance) worker.current = null
      if (relay.current === ownedRelay) relay.current = undefined
      instance.postMessage({ cancel: { generation: ++operationGeneration.current } })
      // The presenter already retains the same receiver-drain promise before
      // IPC starts. Keep this worker alive until its real hash/reducer finishes.
      void (ownedRelay?.close() ?? Promise.resolve()).finally(() => {
        instance.terminate()
        release?.()
      })
    }
  }, [frame, statistics, mask, sampleStatistics, domain, backend, reserveNativeMask])
  useEffect(() => {
    if (!frame?.hdr || !backend || !worker.current) return
    const current = ++generation.current
    requestIdentity.current = identity
    mask(undefined)
    if (!sampleStatistics && !masks) {
      worker.current?.postMessage({ cancel: { generation: current } })
      return
    }
    releaseActivity.current ??= activity?.()
    const nativeMask: NativeMaskDraft | undefined =
      backend === 'native' && nativeEligible && frame.cpuSource && confirmed
        ? {
            version: NATIVE_HDR_MASK_VERSION,
            requestId: crypto.randomUUID(),
            sessionId: sessionId.current,
            source: frame.cpuSource,
            generation: current,
            expectedSettingsRevision: confirmed.revision,
            comparison: comparison!,
            parameters: JSON.parse(key),
            target: selectedTarget,
            domain,
          }
        : undefined
    worker.current?.postMessage({
      request: {
        parameters: JSON.parse(key),
        target: selectedTarget,
        domain,
        // Supported Linux never falls through to the slow JS full scan while
        // history confirmation or presenter admission is unavailable.
        masks: masks && (backend !== 'native' || (!!nativeMask && !gesturing)),
        nativeMask,
        generation: current,
        sampleCount: gesturing ? 8192 : 65536,
        sampleStatistics,
      },
    })
  }, [
    frame,
    key,
    selectedTarget,
    domain,
    masks,
    mask,
    statistics,
    gesturing,
    sampleStatistics,
    identity,
    activity,
    backend,
    nativeEligible,
    confirmed,
    comparison,
  ])
  const workerFailure = unavailable?.frame === frame ? unavailable : undefined
  const currentFailure =
    workerFailure ?? (frame?.hdr && failure?.identity === identity ? failure : undefined)
  return {
    statisticsError: currentFailure?.kind === 'statistics' ? currentFailure.message : undefined,
    maskError: masks && currentFailure?.kind === 'mask' ? currentFailure.message : undefined,
  }
}
