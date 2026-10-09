import type { AdjustmentParameters } from './adjustments'
import { whiteBalanceMatrix, type WhiteBalanceProfile } from './white-balance'
import type { PreviewPreference } from './hdr-display'
import { renderDisplay, renderHdrContent, DISPLAY_RENDERING_VERSION } from './display-rendering'
import { encodeDiagnosticChannel } from './hdr-display'

export type ProcessingIdentity = 'display-referred-v1' | 'hdr-v1'
export const HDR_SOURCE_VERSION = 'hdr-source-v2-capture-scale-1'
export const SENSOR_BLEND_VERSION = 'sensor-blend-v1'
export const HDR_RAW_SOURCE_VERSION = `${HDR_SOURCE_VERSION}-${SENSOR_BLEND_VERSION}`
export const HDR_ADJUSTMENT_VERSION = 'hdr-adjustments-v1'
export const HDR_OUTPUT_VERSION =
  `hdr-output-v6-content-proof-${DISPLAY_RENDERING_VERSION}` as const
export const HDR_ANALYSIS_VERSION = `hdr-analysis-v4-content-${DISPLAY_RENDERING_VERSION}` as const
export type RGB = [number, number, number]
export const REC2020_LUMA: RGB = [0.2627002120112671, 0.6779980715188708, 0.059301716469862]
export const SRGB_TO_2020 = [
  0.627403895934699, 0.3292830383778837, 0.0433130656874172, 0.0690972893582321, 0.9195403950754588,
  0.0113623155663092, 0.0163914388751503, 0.0880133078772258, 0.895595253247624,
]
export const REC2020_TO_SRGB = [
  1.6604910021084345, -0.5876411387885495, -0.0728498633198849, -0.1245504745215907,
  1.1328998971259603, -0.0083494226043695, -0.0181507633549053, -0.1005788980080074,
  1.1187296613629127,
]
export const REC2020_TO_P3 = [
  1.343578252584332, -0.282179670526758, -0.061398582057574, -0.06529745278943, 1.075787915848575,
  -0.010490463059145, 0.002821787261, -0.019598494524, 1.016776707263,
]
export interface HdrNormalization {
  black: number[]
  maximum: number
  gains: number[]
  restoreGain: number
  referenceWhite: number
  sourceSaturation: { thresholds: number[]; saturatedSites: number; totalSites: number } | null
}
export interface HdrSource {
  composite?: { kind: 'hdr' | 'noise'; sourceCount: number }
  highlightBlend?: typeof SENSOR_BLEND_VERSION
  version: typeof HDR_SOURCE_VERSION | 'hdr-source-v1'
  processing: 'hdr-v1'
  colorSpace: 'rec2020'
  whitePoint: 'D65'
  transfer: 'linear'
  alpha: 'straight'
  normalization: HdrNormalization
  decoder: string
  cameraProfile: string
  orientation: 'applied-once'
}
export interface DisplayTarget {
  capabilities?: DisplayCapabilities
  presentation?: import('./preview-diagnostics').PreviewPresentation
  generation: number
  requested: PreviewPreference
  mode: 'sdr' | 'hdr'
  colorSpace: 'srgb' | 'display-p3'
  peak: number
  headroom: number | null
  reason: string
  physicalOutputVerified: false
  outputVersion: typeof HDR_OUTPUT_VERSION
}
export interface DisplayCapabilities {
  monitor?: {
    label: string
    left: number
    top: number
    width: number
    height: number
    scale: number
  }
  adapter?: { vendor: string; architecture: string; device: string; description: string }
  permission?: 'granted' | 'denied' | 'unavailable'
  failure?:
    | 'headroom-unavailable'
    | 'no-headroom'
    | 'permission-denied'
    | 'adapter-unavailable'
    | 'canvas-unsupported'
    | 'device-lost'

  headroomStops: number | null
  hardware: boolean
  extended: boolean
  p3: boolean
  reason: string
}
export interface HdrWorkingAsset {
  kind: 'hdr-working-v1'
  url?: string
  width: number
  height: number
  byteLength: number
  sha256: string
  /** Contiguous 64-row chunks, validated before the working texture becomes visible. */
  strips: { byteLength: number; sha256: string }[]
  source: HdrSource
  whiteBalance?: WhiteBalanceProfile
}
export const SDR_TARGET: DisplayTarget = {
  generation: 0,
  requested: 'sdr',
  mode: 'sdr',
  colorSpace: 'srgb',
  peak: 1,
  headroom: null,
  reason: 'SDR rendition.',
  physicalOutputVerified: false,
  outputVersion: HDR_OUTPUT_VERSION,
}
export function validateTarget(target: DisplayTarget): void {
  if (
    !target ||
    target.outputVersion !== HDR_OUTPUT_VERSION ||
    !['sdr', 'hdr'].includes(target.mode) ||
    !['srgb', 'display-p3'].includes(target.colorSpace) ||
    !Number.isSafeInteger(target.generation) ||
    target.generation < 0 ||
    !Number.isFinite(target.peak) ||
    target.peak < 1 ||
    target.peak > 100 ||
    (target.mode === 'sdr' && target.peak !== 1)
  )
    throw new Error('Invalid display target.')
}
export function matrixRgb(m: readonly number[], rgb: readonly number[]): RGB {
  return [0, 1, 2].map(
    (r) => m[r * 3] * rgb[0] + m[r * 3 + 1] * rgb[1] + m[r * 3 + 2] * rgb[2],
  ) as RGB
}
export function luminance(rgb: readonly number[]): number {
  return rgb[0] * REC2020_LUMA[0] + rgb[1] * REC2020_LUMA[1] + rgb[2] * REC2020_LUMA[2]
}
export function hdrWhiteBalance(profile?: WhiteBalanceProfile): WhiteBalanceProfile | undefined {
  if (!profile) return undefined
  const m = profile.cameraToWorking
  return {
    ...profile,
    cameraToWorking: [0, 1, 2].flatMap((r) =>
      [0, 1, 2].map(
        (c) =>
          SRGB_TO_2020[r * 3] * m[c] +
          SRGB_TO_2020[r * 3 + 1] * m[3 + c] +
          SRGB_TO_2020[r * 3 + 2] * m[6 + c],
      ),
    ),
  }
}
export function hdrAdjustmentMatrix(p: AdjustmentParameters, profile?: WhiteBalanceProfile) {
  return whiteBalanceMatrix(p.whiteBalance, profile)
}
/** Fixed reference white is already incorporated into the prepared asset. */
export function adjustHdr(rgb: RGB, p: AdjustmentParameters, wb?: readonly number[]): RGB {
  let out = wb ? matrixRgb(wb, rgb) : ([...rgb] as RGB)
  const gain = 2 ** p.exposureEv
  out = out.map((v) => v * gain) as RGB
  const scale = (next: (y: number) => number) => {
    const y = luminance(out)
    if (y > 0) {
      const k = next(y) / y
      out = out.map((v) => v * k) as RGB
    }
  }
  if (p.contrast)
    scale((y) =>
      y >= 1
        ? y
        : y <= 0.18
          ? 0.18 * (y / 0.18) ** (2 ** (p.contrast / 100))
          : 1 - 0.82 * ((1 - y) / 0.82) ** (2 ** (p.contrast / 100)),
    )
  if (p.highlights)
    scale((y) =>
      y <= 0.18
        ? y
        : (1 + p.highlights / 100) * y -
          (p.highlights / 100) * (0.18 + (0.82 * (y - 0.18)) / (0.82 + y - 0.18)),
    )
  if (p.shadows)
    scale((y) => (y >= 0.18 ? y : y * 2 ** (((2 * p.shadows) / 100) * (1 - y / 0.18) ** 2)))
  if (p.whites)
    scale((y) => {
      const t = Math.max(0, Math.min(1, (y - 0.18) / 0.82))
      return y * 2 ** ((p.whites / 100) * t * t * (3 - 2 * t))
    })
  if (p.blacks) {
    const y = luminance(out)
    if (y >= 0) {
      const d = ((0.04 * p.blacks) / 100) * Math.max(1 - y / 0.18, 0) ** 3
      if (p.blacks > 0) out = out.map((v) => v + d) as RGB
      else scale((v) => Math.max(0, v + d))
    }
  }
  return out
}
export function outputHdr(rgb: RGB, target: DisplayTarget) {
  if (target.mode === 'sdr') {
    const rendered = renderDisplay(rgb, target)
    return { ...rendered, gamutLimited: false }
  }
  return { ...presentHdrContent(renderHdrContent(rgb).rgb, target), gamutCompressed: false }
}
/** Reference proof: convert primaries, limit representable channels, then encode once. */
export function presentHdrContent(content: RGB, target: DisplayTarget) {
  const rendered = matrixRgb(
    target.colorSpace === 'display-p3' ? REC2020_TO_P3 : REC2020_TO_SRGB,
    content,
  )
  const rgb = rendered.map((v) => Math.max(0, Math.min(target.peak, v))) as RGB
  const weights =
    target.colorSpace === 'display-p3'
      ? [0.2289745640697488, 0.6917385218365064, 0.0792869140937448]
      : [0.2126390058715103, 0.715168678767756, 0.0721923153607337]
  return {
    rgb,
    rendered,
    luminance: rgb.reduce((sum, v, c) => sum + v * weights[c], 0),
    clipped: rendered.some((v) => v < -2e-6 || v > target.peak + 2e-6),
    gamutLimited: rendered.some((v) => v < -2e-6),
  }
}
export const encodeHdr = encodeDiagnosticChannel

/** Validate provenance before a working asset can enter any HDR processing stage. */
export function validateHdrSource(source: HdrSource): void {
  if (
    source?.composite &&
    (!['hdr', 'noise'].includes(source.composite.kind) ||
      !Number.isInteger(source.composite.sourceCount) ||
      source.composite.sourceCount < 2 ||
      source.composite.sourceCount > 32 ||
      source.normalization?.sourceSaturation !== null)
  )
    throw new Error('Invalid composite provenance.')
  const normalization = source?.normalization
  if (
    !source ||
    (source.highlightBlend !== undefined &&
      (source.highlightBlend !== SENSOR_BLEND_VERSION || !!source.composite)) ||
    (source.version !== HDR_SOURCE_VERSION &&
      !(source.composite && source.version === 'hdr-source-v1')) ||
    source.processing !== 'hdr-v1' ||
    source.colorSpace !== 'rec2020' ||
    source.whitePoint !== 'D65' ||
    source.transfer !== 'linear' ||
    source.alpha !== 'straight' ||
    source.orientation !== 'applied-once' ||
    typeof source.decoder !== 'string' ||
    !source.decoder ||
    typeof source.cameraProfile !== 'string' ||
    !source.cameraProfile ||
    !normalization ||
    !Array.isArray(normalization.black) ||
    normalization.black.length !== 4 ||
    !normalization.black.every((v) => Number.isFinite(v) && v >= 0) ||
    !Array.isArray(normalization.gains) ||
    normalization.gains.length !== 4 ||
    !normalization.gains.every((v) => Number.isFinite(v) && v > 0) ||
    ![normalization.maximum, normalization.restoreGain, normalization.referenceWhite].every(
      (v) => Number.isFinite(v) && v > 0,
    )
  )
    throw new Error('Invalid HDR source provenance.')
  const saturation = normalization.sourceSaturation
  if (
    saturation !== null &&
    (!saturation ||
      !Array.isArray(saturation.thresholds) ||
      saturation.thresholds.length !== 4 ||
      !saturation.thresholds.every((v) => Number.isFinite(v) && v > 0) ||
      !Number.isSafeInteger(saturation.saturatedSites) ||
      !Number.isSafeInteger(saturation.totalSites) ||
      saturation.saturatedSites < 0 ||
      saturation.totalSites < 1 ||
      saturation.saturatedSites > saturation.totalSites)
  )
    throw new Error('Invalid RAW saturation provenance.')
}
