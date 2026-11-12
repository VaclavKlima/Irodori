import {
  RGB_TO_XYZ,
  workingToOklab,
  oklabToWorking,
  type ColorPrimaries,
  type ColorTriple,
} from './color-model'

export const MASK_RANGE_VERSION = 'neutral-source-oklab-relative-chroma-r8-v1'
export interface MaskRangeColorSample {
  /** Brightness-normalized Oklab a/L and b/L, not ordinary Oklab coordinates. */
  a: number
  b: number
}
export type MaskRange =
  | { version: 1; kind: 'color'; samples: MaskRangeColorSample[]; range: number; softness: number }
  | { version: 1; kind: 'luminance'; lower: number; upper: number | null; softness: number }

export const maskRangeCapabilities = {
  version: MASK_RANGE_VERSION,
  source: 'neutral-canonical-before-creative-edits',
  colorSpace: 'oklab-relative-chroma',
  sampleDiameter: 7,
  maxColorSamples: 5,
  range: { min: 0, max: 100, step: 1, default: 20 },
  softness: { min: 0, max: 100, step: 1, default: 25 },
  luminance: { unit: 'percent-source-white', referenceWhite: 100, step: 0.1, unboundedUpper: null },
} as const
export const defaultLuminanceMaskRange: Extract<MaskRange, { kind: 'luminance' }> = {
  version: 1,
  kind: 'luminance',
  lower: 25,
  upper: 75,
  softness: 25,
}

const fields = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const percentControl = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
const brightness = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  Number.isFinite(Math.fround(value / 100))

export function validateMaskRange(value: unknown): asserts value is MaskRange {
  if (!value || typeof value !== 'object') throw new Error('Invalid mask range.')
  const v = value as Record<string, unknown>
  if (v.kind === 'color') {
    if (
      !fields(v, ['version', 'kind', 'samples', 'range', 'softness']) ||
      v.version !== 1 ||
      !Array.isArray(v.samples) ||
      !v.samples.length ||
      v.samples.length > 5 ||
      !percentControl(v.range) ||
      !percentControl(v.softness) ||
      v.samples.some(
        (sample) =>
          !fields(sample, ['a', 'b']) ||
          [sample.a, sample.b].some(
            (n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e7,
          ),
      )
    )
      throw new Error(
        'Color ranges require one to five valid color samples and integer Range/Softness from 0 to 100.',
      )
  } else if (v.kind === 'luminance') {
    if (
      !fields(v, ['version', 'kind', 'lower', 'upper', 'softness']) ||
      v.version !== 1 ||
      !brightness(v.lower) ||
      (v.upper !== null && (!brightness(v.upper) || v.upper < v.lower)) ||
      !percentControl(v.softness)
    )
      throw new Error(
        'Luminance ranges require nonnegative Lower/Upper source-white percentages, ordered bounds and integer Softness from 0 to 100.',
      )
  } else throw new Error('Choose Color range or Luminance range.')
  maskRangeParameters(v as MaskRange)
}

/** Only coefficient preparation; full-image coverage belongs to the shared GPU stage. */
export function maskRangeParameters(range: MaskRange) {
  if (range.kind === 'color') {
    const radius = range.range / 100
    return { radius, outer: Math.min(1, radius + (Math.max(radius, 0.01) * range.softness) / 100) }
  }
  const lower = range.lower / 100,
    upper = range.upper === null ? null : range.upper / 100
  const transition = (range.softness / 100) * Math.max(upper === null ? lower : upper - lower, 0.01)
  if (
    ![
      lower,
      upper ?? 0,
      transition,
      lower + transition,
      upper === null ? 0 : upper + transition,
    ].every((n) => Number.isFinite(Math.fround(n)))
  )
    throw new Error('The luminance range exceeds the supported Float32 numerical range.')
  return { lower, upper, transition }
}

/** A bounded color query. Normalize first so very dark and very bright versions share a color. */
export function maskRangeColorSample(
  rgb: ColorTriple,
  primaries: ColorPrimaries,
): MaskRangeColorSample | null {
  if (!rgb.every(Number.isFinite))
    throw new Error('The range sample contains nonfinite source pixels.')
  const scale = Math.max(...rgb.map(Math.abs))
  if (scale === 0) return null
  const normalized = rgb.map((n) => n / scale) as unknown as ColorTriple
  const y = RGB_TO_XYZ[primaries][1].reduce((sum, weight, i) => sum + weight * normalized[i], 0)
  const [l, a, b] = workingToOklab(normalized, primaries)
  if (y <= 0 || l <= 1e-6) return null
  const result = { a: a / l, b: b / l }
  return Object.values(result).every((n) => Number.isFinite(n) && Math.abs(n) <= 1e7)
    ? result
    : null
}

/** At most one fixed seven-pixel neighborhood; this is not an image-processing backend. */
export function sampleMaskRangePixels(pixels: Float32Array, primaries: ColorPrimaries) {
  if (!pixels.length || pixels.length % 4 || pixels.length > 7 * 7 * 4)
    throw new Error('Range sampling requires one bounded 7 × 7 source neighborhood.')
  let weight = 0,
    validPixels = 0
  const sum = [0, 0, 0]
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]
    if (
      ![pixels[i], pixels[i + 1], pixels[i + 2], alpha].every(Number.isFinite) ||
      alpha < 0 ||
      alpha > 1
    )
      throw new Error('The range sample contains invalid source pixels.')
    if (alpha === 0) continue
    weight += alpha
    validPixels++
    for (let c = 0; c < 3; c++) sum[c] += pixels[i + c] * alpha
  }
  if (!validPixels)
    throw new Error('The sampled area is fully transparent. Choose a visible source area.')
  const rgb = sum.map((n) => n / weight) as unknown as ColorTriple
  const luminance =
    RGB_TO_XYZ[primaries][1].reduce((total, coefficient, i) => total + coefficient * rgb[i], 0) *
    100
  if (!Number.isFinite(luminance)) throw new Error('The sampled source brightness is not finite.')
  return { color: maskRangeColorSample(rgb, primaries), luminance, validPixels }
}

export function defaultColorMaskRange(
  sample: MaskRangeColorSample,
): Extract<MaskRange, { kind: 'color' }> {
  const range: Extract<MaskRange, { kind: 'color' }> = {
    version: 1,
    kind: 'color',
    samples: [sample],
    range: 20,
    softness: 25,
  }
  validateMaskRange(range)
  return structuredClone(range)
}
export function sampledLuminanceMaskRange(
  value: number,
): Extract<MaskRange, { kind: 'luminance' }> {
  if (!brightness(value)) throw new Error('Choose a source area with nonnegative brightness.')
  const halfWidth = Math.max(value * 0.1, 1)
  const range: Extract<MaskRange, { kind: 'luminance' }> = {
    version: 1,
    kind: 'luminance',
    lower: Math.max(0, value - halfWidth),
    upper: value + halfWidth,
    softness: 25,
  }
  validateMaskRange(range)
  return range
}
export function maskRangeColorFromHex(value: string): MaskRangeColorSample {
  if (!/^#[a-f\d]{6}$/i.test(value)) throw new Error('Enter an sRGB color as #RRGGBB.')
  const rgb = [1, 3, 5].map((offset) => {
    const encoded = parseInt(value.slice(offset, offset + 2), 16) / 255
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4
  }) as unknown as ColorTriple
  const sample = maskRangeColorSample(rgb, 'srgb')
  if (!sample) throw new Error('Black has no defined color. Use Luminance range to select black.')
  return sample
}
/** A constant-lightness sRGB swatch; classification always uses the original normalized color. */
export function maskRangeColorToHex(sample: MaskRangeColorSample): string {
  const rgb = oklabToWorking([0.7, sample.a * 0.7, sample.b * 0.7], 'srgb')
  return (
    '#' +
    rgb
      .map((value) => {
        const linear = Math.max(0, Math.min(1, value))
        const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055
        return Math.round(encoded * 255)
          .toString(16)
          .padStart(2, '0')
      })
      .join('')
      .toUpperCase()
  )
}
