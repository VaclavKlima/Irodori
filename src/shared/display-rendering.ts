import {
  AP0,
  beginAcesPixel,
  endAcesPixel,
  AP0_XYZ_TO_RGB,
  RGBtoXYZ_f33,
  init_ODTParams,
  clamp_AP0_to_AP1,
  RGB_to_JMh,
  tonemap_and_compress_fwd,
  gamut_compress_fwd,
  JMh_to_RGB,
  type Chromaticities,
  type ODTParams,
} from './aces-core'

export const DISPLAY_RENDERING_VERSION = 'aces2-069b0bc3-v1'
export const RENDERING_REFERENCE = 100
export const MAX_RENDERING_HEADROOM = 100
export type RenderingRGB = [number, number, number]
export interface RenderingTarget {
  mode: 'sdr' | 'hdr'
  peak: number
  colorSpace: 'srgb' | 'display-p3' | 'rec2020'
}
export const HDR_CONTENT_VERSION = 'hdr-content-v1-aces2-rec2020-1000-d65' as const
/** A software reference rendition, never a measurement of the attached panel. */
export const HDR_CONTENT = {
  version: HDR_CONTENT_VERSION,
  rendering: DISPLAY_RENDERING_VERSION,
  colorSpace: 'rec2020',
  whitePoint: 'D65',
  transfer: 'linear',
  referenceWhiteNits: 100,
  nominalPeakNits: 1000,
  relativePeak: 10,
} as const
export const HDR_CONTENT_TARGET: RenderingTarget = { mode: 'hdr', peak: 10, colorSpace: 'rec2020' }
const D65 = [0.3127, 0.329]
const primaries: Record<RenderingTarget['colorSpace'] | 'rec2020', Chromaticities> = {
  srgb: { red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], white: D65 },
  'display-p3': { red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06], white: D65 },
  rec2020: { red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046], white: D65 },
}
const mul = (v: readonly number[], m: readonly number[][]): RenderingRGB =>
  [0, 1, 2].map((c) => v[0] * m[0][c] + v[1] * m[1][c] + v[2] * m[2][c]) as RenderingRGB
const product = (a: number[][], b: number[][]) => a.map((row) => mul(row, b))
// Von Kries Bradford D65 -> ACES D60, using the official CTL row-vector convention.
const bradford = [
  [0.8951, -0.7502, 0.0389],
  [0.2664, 1.7135, -0.0685],
  [-0.1614, 0.0367, 1.0296],
]
const inverseBradford = [
  [0.9869929054667123, 0.4323052697233945, -0.008528664575177328],
  [-0.14705425642099013, 0.5183602715367776, 0.04004282165408487],
  [0.15996265166373125, 0.0492912282128556, 0.96848669578755],
]
const xyzWhite = ([x, y]: number[]) => [x / y, 1, (1 - x - y) / y]
const sourceCone = mul(xyzWhite(D65), bradford)
const destCone = mul(xyzWhite(AP0.white), bradford)
const adaptation = product(
  product(
    bradford,
    sourceCone.map((v, i) => [0, 1, 2].map((c) => (c === i ? destCone[i] / v : 0))),
  ),
  inverseBradford,
)
export const REC2020_TO_ACES = product(
  product(RGBtoXYZ_f33(primaries.rec2020, 1), adaptation),
  AP0_XYZ_TO_RGB,
)
export function rec2020ToAces(rgb: RenderingRGB): RenderingRGB {
  return mul(rgb, REC2020_TO_ACES)
}
export function effectiveHeadroom(target: RenderingTarget): number {
  return target.mode === 'sdr' || !Number.isFinite(target.peak) || target.peak < 1
    ? 1
    : Math.min(MAX_RENDERING_HEADROOM, target.peak)
}
// Bounded per-worker target cache; no image contents enter target preparation.
const tables = new Map<string, ODTParams>()
let recent: { peak: number; space: string; prepared: ODTParams } | undefined
export function prepareDisplayRendering(target: RenderingTarget): ODTParams {
  const peak = effectiveHeadroom(target)
  if (recent?.peak === peak && recent.space === target.colorSpace) return recent.prepared
  const key = `${target.colorSpace}:${peak}`
  const existing = tables.get(key)
  if (existing) {
    recent = { peak, space: target.colorSpace, prepared: existing }
    return existing
  }
  const prepared = init_ODTParams(RENDERING_REFERENCE * peak, primaries[target.colorSpace])
  if (tables.size >= 4) tables.delete(tables.keys().next().value!)
  tables.set(key, prepared)
  recent = { peak, space: target.colorSpace, prepared }
  return prepared
}
/** Complete reference rendering, in relative display-linear units (1 = nominal 100-nit white). */
export function renderDisplay(rgb: RenderingRGB, target: RenderingTarget) {
  const p = prepareDisplayRendering(target)
  let rendered: RenderingRGB, gamutCompressed: boolean
  beginAcesPixel()
  try {
    const aces = clamp_AP0_to_AP1(rec2020ToAces(rgb), 0, p.ts.forward_limit)
    const toned = tonemap_and_compress_fwd(RGB_to_JMh(aces, p.input_params), p)
    const gamut = gamut_compress_fwd(toned, p)
    rendered = JMh_to_RGB(gamut, p.limit_params).slice() as RenderingRGB
    gamutCompressed = Math.abs(gamut[1] - toned[1]) > 1e-7 || Math.abs(gamut[0] - toned[0]) > 1e-7
  } finally {
    endAcesPixel()
  }
  const peak = effectiveHeadroom(target)
  // Reference white limiting is separate from canvas transfer encoding.
  const clipped = rendered.some((v) => v < -2e-6 || v > peak + 2e-6)
  const out = rendered.map((v) => Math.max(0, Math.min(peak, v))) as RenderingRGB
  const weights =
    target.colorSpace === 'rec2020'
      ? [0.2627002120112671, 0.6779980715188708, 0.059301716469862]
      : target.colorSpace === 'display-p3'
        ? [0.2289745640697488, 0.6917385218365064, 0.0792869140937448]
        : [0.2126390058715103, 0.715168678767756, 0.0721923153607337]
  return {
    rgb: out,
    rendered,
    luminance: out.reduce((s, v, c) => s + v * weights[c], 0),
    gamutCompressed,
    clipped,
  }
}
export function renderHdrContent(rgb: RenderingRGB) {
  return renderDisplay(rgb, HDR_CONTENT_TARGET)
}
