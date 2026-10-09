import { encodeHdr, type DisplayTarget } from './hdr'
export const RGB_HISTOGRAM_VERSION = 'rgb-histogram-v2-fixed-axis'
export interface RgbHistogram {
  version: typeof RGB_HISTOGRAM_VERSION
  targetGeneration: number
  mode: 'hdr' | 'sdr'
  colorSpace: DisplayTarget['colorSpace'] | 'rec2020'
  mapping: 'encoded-sdr-256' | 'encoded-sdr-256-log2-hdr-256'
  referenceWhite: 1
  maxStops: number
  displayLimitStops: number | null
  rgb: [number[], number[], number[]]
  visiblePixels: number
}
export function rgbHistogram(target: DisplayTarget): RgbHistogram {
  const hdr = target.mode === 'hdr'
  return {
    version: RGB_HISTOGRAM_VERSION,
    targetGeneration: target.generation,
    mode: target.mode,
    colorSpace: target.colorSpace,
    mapping: hdr ? 'encoded-sdr-256-log2-hdr-256' : 'encoded-sdr-256',
    referenceWhite: 1,
    maxStops: hdr ? 4 : 0,
    displayLimitStops: target.headroom === null ? null : Math.log2(target.headroom),
    rgb: [
      Array(hdr ? 512 : 256).fill(0),
      Array(hdr ? 512 : 256).fill(0),
      Array(hdr ? 512 : 256).fill(0),
    ],
    visiblePixels: 0,
  }
}
export function contentRgbHistogram(target: DisplayTarget): RgbHistogram {
  return { ...rgbHistogram({ ...target, mode: 'hdr' }), colorSpace: 'rec2020' }
}
/** Reference white belongs to SDR's last bin. The HDR half uses equal log2 intervals. */
export function rgbHistogramBin(linear: number, histogram: RgbHistogram): number {
  if (linear <= 1 || histogram.mode === 'sdr')
    return Math.round(Math.max(0, Math.min(1, encodeHdr(linear))) * 255)
  return 256 + Math.min(255, Math.floor((Math.log2(linear) * 256) / histogram.maxStops))
}
export function addRgbHistogram(histogram: RgbHistogram, rgb: readonly number[], alpha: number) {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || !rgb.every(Number.isFinite))
    throw new Error('Invalid RGB histogram sample.')
  if (!alpha) return
  histogram.visiblePixels++
  for (let c = 0; c < 3; c++) histogram.rgb[c][rgbHistogramBin(rgb[c], histogram)]++
}
