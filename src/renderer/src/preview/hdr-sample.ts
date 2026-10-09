import type { HdrWorkingAsset } from '../../../shared/hdr'
import { sameAdjustments, type AdjustmentParameters } from '../../../shared/adjustments'
import type { HdrStatistics } from '../../../shared/hdr-statistics'
// Retain the active photo's two sample resolutions across presentation/device changes.
// Near bin boundaries CPU/GPU rounding can differ despite numerical conformance.
const content = new Map<
  number,
  {
    hash: string
    parameters: AdjustmentParameters
    statistics: HdrStatistics
  }
>()
export function retainHdrContent(
  hash: string,
  parameters: AdjustmentParameters,
  statistics: HdrStatistics,
) {
  if ([...content.values()].some((entry) => entry.hash !== hash)) content.clear()
  const count = statistics.visiblePixels
  content.delete(count)
  content.set(count, {
    hash,
    parameters: structuredClone(parameters),
    statistics: structuredClone(statistics),
  })
  if (content.size > 2) content.delete(content.keys().next().value!)
}
export function reuseHdrContent(
  hash: string,
  parameters: AdjustmentParameters,
  statistics: HdrStatistics,
) {
  const retained = content.get(statistics.visiblePixels)
  if (!retained || retained.hash !== hash || !sameAdjustments(retained.parameters, parameters))
    return statistics
  const previous = retained.statistics
  return {
    ...statistics,
    bins: previous.bins,
    zero: previous.zero,
    negative: previous.negative,
    underflow: previous.underflow,
    overflow: previous.overflow,
    aboveWhite: previous.aboveWhite,
    rgbHistogram: { ...statistics.rgbHistogram!, rgb: previous.rgbHistogram!.rgb },
  }
}
/** A single active source sample; replacing it releases the previous photograph's data. */
let current: { hash: string; data: Float32Array; draft: Float32Array } | undefined
const listeners = new Set<() => void>()
export function publishHdrSample(hash: string, data: Float32Array, draft: Float32Array) {
  current = { hash, data, draft }
  for (const listener of listeners) listener()
}
export function observeHdrSample(
  hash: string,
  accept: (data: Float32Array, draft: Float32Array) => void,
) {
  const notify = () => {
    if (current?.hash === hash) accept(current.data, current.draft)
  }
  listeners.add(notify)
  notify()
  return () => {
    listeners.delete(notify)
  }
}
export function collectHdrSample(asset: HdrWorkingAsset) {
  const total = asset.width * asset.height,
    count = Math.min(65536, total)
  const sample = new Float32Array(count * 4)
  const draft = new Float32Array(Math.min(8192, total) * 4)
  const samplers = [sample, draft].map((data) => ({ data, next: 0 }))
  return {
    sample,
    draft,
    add(data: Float32Array, row: number) {
      const start = row * asset.width,
        end = start + data.length / 4
      for (const sampler of samplers) {
        const count = sampler.data.length / 4
        while (sampler.next < count) {
          const position = Math.floor(((sampler.next + 0.5) * total) / count)
          if (position >= end) break
          sampler.data.set(
            data.subarray((position - start) * 4, (position - start) * 4 + 4),
            sampler.next++ * 4,
          )
        }
      }
    },
  }
}
