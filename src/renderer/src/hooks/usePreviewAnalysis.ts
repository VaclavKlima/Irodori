import { useEffect, useRef, useState } from 'react'
import type { AdjustmentParameters, WorkingFrame } from '../../../shared/adjustments'
import {
  sampleWorking,
  type ImageStatistics,
  type clippingPyramid,
} from '../../../shared/statistics'
import { AnalysisQueue } from '../preview/analysis-queue'
import { hasLocalMasks } from '../../../shared/masks-gpu'
export type ClippingMask = ReturnType<typeof clippingPyramid>
export function usePreviewAnalysis(
  frame: WorkingFrame | null,
  identity: string,
  parameters: AdjustmentParameters,
  masks: boolean,
  gesturing: boolean,
  onStatistics: (value?: ImageStatistics) => void,
  onMask: (mask?: ClippingMask) => void,
  activity?: () => () => void,
) {
  const masked = hasLocalMasks(parameters)
  const [failure, setFailure] = useState<{ identity: string; message: string }>()
  const histogram = useRef<AnalysisQueue | null>(null),
    clipping = useRef<AnalysisQueue | null>(null)
  useEffect(() => {
    if (!frame || masked) return
    onStatistics(undefined)
    const worker = new Worker(new URL('../preview/analysis-worker.ts', import.meta.url), {
      type: 'module',
    })
    const queue = new AnalysisQueue(worker, identity, false, activity)
    histogram.current = queue
    const sample = sampleWorking(frame.data)
    worker.postMessage(
      { frame: { ...frame, data: sample }, identity },
      { transfer: [sample.buffer] },
    )
    worker.onmessage = ({ data }) => {
      if (queue.accepts(data)) {
        if (data.error) setFailure({ identity, message: data.error })
        if (data.statistics) {
          setFailure(undefined)
          onStatistics(data.statistics)
        }
      }
      if (data.done) queue.finished()
    }
    worker.onerror = (event) => {
      queue.close()
      setFailure({ identity, message: event.message })
    }
    return () => {
      histogram.current = null
      queue.close()
    }
  }, [frame, identity, masked, onStatistics, activity])
  useEffect(() => {
    onMask(undefined)
    if (!frame || !masks || masked) return
    const worker = new Worker(new URL('../preview/analysis-worker.ts', import.meta.url), {
      type: 'module',
    })
    const queue = new AnalysisQueue(worker, identity, true, activity)
    clipping.current = queue
    worker.postMessage({ frame, identity })
    worker.onmessage = ({ data }) => {
      if (queue.accepts(data) && data.mask) onMask(data.mask)
      if (data.done) queue.finished()
    }
    worker.onerror = () => queue.close()
    return () => {
      clipping.current = null
      queue.close()
    }
  }, [frame, identity, masks, masked, onMask, activity])
  const key = JSON.stringify(parameters)
  useEffect(() => {
    if (!masked) histogram.current?.update(JSON.parse(key), !gesturing)
  }, [frame, identity, key, gesturing, masked])
  useEffect(() => {
    onMask(undefined)
    if (!masked) clipping.current?.update(JSON.parse(key), !gesturing)
  }, [frame, identity, key, masks, gesturing, onMask, masked])
  return !masked && frame && failure?.identity === identity ? failure.message : undefined
}
