import { observeHdrSample } from '../preview/hdr-sample'
import { useEffect, useRef, useState } from 'react'
import type { WorkingFrame, AdjustmentParameters } from '../../../shared/adjustments'
import { SDR_TARGET, type DisplayTarget } from '../../../shared/hdr'
import type { HdrAnalysisDomain, HdrStatistics } from '../../../shared/hdr-statistics'
import type { ClippingMask } from './usePreviewAnalysis'
export function useHdrAnalysis(
  frame: WorkingFrame | null,
  parameters: AdjustmentParameters,
  target: DisplayTarget,
  domain: HdrAnalysisDomain,
  masks: boolean,
  statistics: (result?: HdrStatistics) => void,
  mask: (result?: ClippingMask) => void,
) {
  const [failure, setFailure] = useState<{ identity: string; message: string }>()
  const worker = useRef<Worker | null>(null),
    generation = useRef(0),
    requestIdentity = useRef('')
  const key = JSON.stringify(parameters)
  const selectedTarget = domain === 'working-hdr' ? SDR_TARGET : target
  const identity = JSON.stringify([
    frame?.identity,
    key,
    selectedTarget.generation,
    selectedTarget.mode,
    selectedTarget.colorSpace,
    selectedTarget.peak,
    domain,
    masks,
  ])
  useEffect(() => {
    if (!frame?.hdr) return
    const instance = new Worker(new URL('../preview/hdr-analysis-worker.ts', import.meta.url), {
      type: 'module',
    })
    const unsubscribe = observeHdrSample(frame.hdr.sha256, (sample) =>
      instance.postMessage({ sample }),
    )
    worker.current = instance
    instance.postMessage({ asset: frame.hdr })
    instance.onmessage = ({ data }) => {
      if (data.error && (data.generation === undefined || data.generation === generation.current))
        setFailure({
          identity: requestIdentity.current,
          message: data.error,
        })
      if (data.generation !== generation.current) return
      if (data.statistics) {
        setFailure(undefined)
        statistics(data.statistics)
      }
      if (data.mask) mask(data.mask)
    }
    instance.onerror = (event) =>
      setFailure({
        identity: requestIdentity.current,
        message: event.message,
      })
    return () => {
      unsubscribe()
      instance.terminate()
      worker.current = null
    }
  }, [frame, statistics, mask])
  useEffect(() => {
    if (!frame?.hdr) return
    const current = ++generation.current
    requestIdentity.current = identity
    mask(undefined)
    statistics(undefined)
    const timer = setTimeout(
      () =>
        worker.current?.postMessage({
          request: {
            parameters: JSON.parse(key),
            target: selectedTarget,
            domain,
            masks,
            generation: current,
          },
        }),
      100,
    )
    return () => clearTimeout(timer)
  }, [frame, key, selectedTarget, domain, masks, mask, statistics, identity])
  return frame?.hdr && failure && failure.identity === identity ? failure.message : undefined
}
