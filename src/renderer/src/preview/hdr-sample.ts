export { collectHdrSample } from '../../../shared/hdr-source-sample'
import { sameAdjustments, type AdjustmentParameters } from '../../../shared/adjustments'
import type { HdrStatistics } from '../../../shared/hdr-statistics'
// Retain the active photo's two sample resolutions in each selected source domain.
// Near bin boundaries CPU/GPU rounding can differ despite numerical conformance.
const content = new Map<
  string,
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
  if (!selected.has(hash)) return
  const count = statistics.visiblePixels
  const key = `${hash}:${count}`
  content.delete(key)
  content.set(key, {
    hash,
    parameters: structuredClone(parameters),
    statistics: structuredClone(statistics),
  })
  const matching = [...content].filter(([, entry]) => entry.hash === hash)
  if (matching.length > 2) content.delete(matching[0][0])
}
export function reuseHdrContent(
  hash: string,
  parameters: AdjustmentParameters,
  statistics: HdrStatistics,
) {
  const retained = content.get(`${hash}:${statistics.visiblePixels}`)
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
/** At most the active After/Before pair, with no copies of immutable verified planes. */
let selected = new Set<string>()
const current = new Map<string, { data: Float32Array; draft: Float32Array }>()
type SampleListener = (data: Float32Array, draft: Float32Array) => void
const listeners = new Map<string, Set<SampleListener>>()
export function selectHdrSampleSources(after: string, before?: string) {
  const next = new Set(before ? [after, before] : [after])
  if ([...next].some((hash) => !/^[a-f0-9]{64}$/.test(hash)))
    throw new Error('Invalid HDR sample source identity.')
  selected = next
  for (const hash of current.keys()) if (!selected.has(hash)) current.delete(hash)
  for (const [key, entry] of content) if (!selected.has(entry.hash)) content.delete(key)
}
export function publishHdrSample(hash: string, data: Float32Array, draft: Float32Array) {
  // An earlier presenter can finish after the next source was selected.
  if (!selected.has(hash)) return
  const previous = current.get(hash)
  if (previous?.data === data && previous.draft === draft) return
  current.set(hash, { data, draft })
  for (const listener of listeners.get(hash) ?? []) listener(data, draft)
}
/** Charge backing buffers once, including views sharing a native sample/draft allocation. */
export function hdrSampleMemory(owned: (buffer: ArrayBufferLike) => boolean = () => false) {
  const buffers = new Set<ArrayBufferLike>()
  for (const { data, draft } of current.values()) {
    if (!owned(data.buffer)) buffers.add(data.buffer)
    if (!owned(draft.buffer)) buffers.add(draft.buffer)
  }
  return [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0)
}
export function observeHdrSample(
  hash: string,
  accept: (data: Float32Array, draft: Float32Array) => void,
) {
  const observers = listeners.get(hash) ?? new Set<SampleListener>()
  listeners.set(hash, observers)
  observers.add(accept)
  const sample = current.get(hash)
  if (sample) accept(sample.data, sample.draft)
  return () => {
    observers.delete(accept)
    if (!observers.size) listeners.delete(hash)
  }
}
