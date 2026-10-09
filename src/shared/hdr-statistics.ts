import {
  rgbHistogram,
  contentRgbHistogram,
  addRgbHistogram,
  type RgbHistogram,
} from './rgb-histogram'
import { HDR_CONTENT, renderHdrContent } from './display-rendering'
import type { AdjustmentParameters } from './adjustments'
import {
  HDR_ANALYSIS_VERSION,
  adjustHdr,
  hdrAdjustmentMatrix,
  luminance,
  outputHdr,
  presentHdrContent,
  type DisplayTarget,
  type HdrWorkingAsset,
} from './hdr'
export type HdrAnalysisDomain = 'working-hdr' | 'content-hdr' | 'output'
export interface HdrAnalysisRequest {
  domain: HdrAnalysisDomain
  target?: 'current' | 'sdr'
  targetGeneration?: number
}
export interface HdrStatistics {
  content: typeof HDR_CONTENT
  editSerial?: number
  rgbHistogram?: RgbHistogram
  analysisVersion: typeof HDR_ANALYSIS_VERSION
  domain: HdrAnalysisDomain
  dynamicRange: 'hdr'
  colorSpace: 'rec2020' | 'srgb' | 'display-p3'
  referenceWhite: 1
  units: 'stops-relative-to-white'
  bins: number[]
  binEdges: number[]
  visiblePixels: number
  zero: number
  negative: number
  underflow: number
  overflow: number
  aboveWhite: number
  exceedingHeadroom: number | null
  gamutCompressed: number | null
  gamutLimited: number | null
  outputClipped: number | null
  exact: boolean
  sourceSaturation: HdrWorkingAsset['source']['normalization']['sourceSaturation']
  target?: DisplayTarget
}
export interface HdrPhotoStatistics extends HdrStatistics {
  photoId: string
  revision: number
  renderingIdentity: string
}
export function hdrStatistics(
  domain: HdrAnalysisDomain,
  target: DisplayTarget,
  asset: HdrWorkingAsset,
  exact = true,
): HdrStatistics {
  return {
    content: HDR_CONTENT,
    rgbHistogram:
      domain === 'content-hdr'
        ? contentRgbHistogram(target)
        : domain === 'output'
          ? rgbHistogram(target)
          : undefined,
    analysisVersion: HDR_ANALYSIS_VERSION,
    domain,
    dynamicRange: 'hdr',
    colorSpace: domain !== 'output' ? 'rec2020' : target.colorSpace,
    referenceWhite: 1,
    units: 'stops-relative-to-white',
    bins: Array(256).fill(0),
    binEdges: Array.from({ length: 257 }, (_, i) => -16 + i / 8),
    visiblePixels: 0,
    zero: 0,
    negative: 0,
    underflow: 0,
    overflow: 0,
    aboveWhite: 0,
    exceedingHeadroom: domain !== 'working-hdr' && target.headroom !== null ? 0 : null,
    gamutCompressed: domain !== 'working-hdr' ? 0 : null,
    gamutLimited: domain !== 'working-hdr' ? 0 : null,
    outputClipped: domain !== 'working-hdr' ? 0 : null,
    exact,
    sourceSaturation: asset.source.normalization.sourceSaturation,
    target: domain !== 'working-hdr' ? target : undefined,
  }
}
export function analyzeHdr(
  data: Float32Array,
  p: AdjustmentParameters,
  asset: HdrWorkingAsset,
  target: DisplayTarget,
  result: HdrStatistics,
  mask?: Uint8Array,
  maskOffset = 0,
) {
  const wb = hdrAdjustmentMatrix(p, asset.whiteBalance) ?? undefined
  for (let i = 0; i < data.length; i += 4) {
    if (![data[i], data[i + 1], data[i + 2], data[i + 3]].every(Number.isFinite))
      throw new Error('Invalid HDR analysis sample.')
    if (data[i + 3] === 0) continue
    const rgb = adjustHdr([data[i], data[i + 1], data[i + 2]], p, wb),
      y = luminance(rgb)
    const content = result.domain !== 'working-hdr' || mask ? renderHdrContent(rgb) : undefined
    const proof = content ? presentHdrContent(content.rgb, target) : undefined
    const output = result.domain === 'output' ? outputHdr(rgb, target) : undefined
    const renderedY = content?.luminance ?? y
    const beyond = target.headroom !== null && renderedY > target.headroom
    const value =
      result.domain === 'working-hdr'
        ? y
        : result.domain === 'content-hdr'
          ? renderedY
          : output!.luminance
    if (result.rgbHistogram)
      addRgbHistogram(
        result.rgbHistogram,
        result.domain === 'content-hdr' ? content!.rgb : output!.rgb,
        data[i + 3],
      )
    result.visiblePixels++
    result.aboveWhite += Number(value > 1)
    if (result.domain !== 'working-hdr') {
      if (result.exceedingHeadroom !== null) result.exceedingHeadroom += Number(beyond)
      result.gamutCompressed! += Number(content!.gamutCompressed)
      result.gamutLimited! += Number(proof!.gamutLimited)
      result.outputClipped! += Number(proof!.clipped)
    }
    if (value === 0) result.zero++
    else if (value < 0) result.negative++
    else {
      const stops = Math.log2(value)
      if (stops < -16) result.underflow++
      else if (stops >= 16) result.overflow++
      else result.bins[Math.floor((stops + 16) * 8)]++
    }
    if (mask)
      mask[maskOffset + i / 4] =
        Number(proof!.clipped) |
        (Number(beyond) << 1) |
        (Number(renderedY > 1) << 2) |
        (Number(proof!.gamutLimited) << 3)
  }
}
export function reduceHdrMask(data: Uint8Array<ArrayBuffer>, width: number, height: number) {
  const levels = [{ data, width, height }]
  while (width > 1 || height > 1) {
    const previous = levels[levels.length - 1],
      w = Math.ceil(width / 2),
      h = Math.ceil(height / 2)
    const next = new Uint8Array(w * h)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        next[Math.floor(y / 2) * w + Math.floor(x / 2)] |= previous.data[y * width + x]
    levels.push({ data: next, width: w, height: h })
    width = w
    height = h
  }
  return { levels }
}
