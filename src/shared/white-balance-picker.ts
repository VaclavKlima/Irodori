import type { HdrNormalization } from './hdr'
import {
  customGains,
  inverseMatrix,
  locusUv,
  multiplyVector,
  validateWhiteBalanceProfile,
  whiteBalanceNormal,
  type WhiteBalanceProfile,
} from './white-balance'

export const WHITE_BALANCE_PICKER_VERSION = 'neutral-camera-roi-v1' as const
export const WHITE_BALANCE_PICKER_LIMITS = {
  minimumPixels: 16,
  minimumCoverage: 0.75,
  minimumSensorSignal: 0.005,
  maximumSaturationFraction: 0.8,
  maximumLogScatter: 0.04,
  maximumNeutralResidual: 0.01,
} as const
export const whiteBalanceSampleSizes = [7, 15, 31] as const
export interface WhiteBalanceSample {
  /** Oriented, lens-corrected native working-image coordinates, before creative edits. */
  x: number
  y: number
  diameter: (typeof whiteBalanceSampleSizes)[number]
}
export interface WhiteBalanceSampleArea {
  x: number
  y: number
  width: number
  height: number
  centerX: number
  centerY: number
}
export type WhiteBalanceSampleFailure =
  | 'unsupported-source'
  | 'source-limits-unavailable'
  | 'dark'
  | 'clipped'
  | 'insufficient-coverage'
  | 'uneven-sample'
  | 'out-of-model'
interface SampleDetails {
  version: typeof WHITE_BALANCE_PICKER_VERSION
  provider: string | null
  total: number
  accepted: number
  rejected: { dark: number; clipped: number; invalid: number }
  scatter: number | null
  residual: number | null
}
export type NeutralWhiteBalanceProposal = SampleDetails &
  (
    | { status: 'valid'; settings: { mode: 'custom'; kelvin: number; tint: number } }
    | { status: 'invalid'; reason: WhiteBalanceSampleFailure }
  )
export type SampledWhiteBalanceProposal = NeutralWhiteBalanceProposal & {
  area: WhiteBalanceSampleArea
}
export type PhotoWhiteBalanceProposal = SampledWhiteBalanceProposal & {
  photoId: string
  revision: number
  renderingIdentity: string
  sample: WhiteBalanceSample
}

export function validateWhiteBalanceSample(value: unknown): asserts value is WhiteBalanceSample {
  const v = value as WhiteBalanceSample | null
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'diameter,x,y' ||
    !Number.isFinite(v.x) ||
    v.x < 0 ||
    v.x > 1 ||
    !Number.isFinite(v.y) ||
    v.y < 0 ||
    v.y > 1 ||
    !whiteBalanceSampleSizes.includes(v.diameter)
  )
    throw new Error(
      'Choose normalized sample coordinates between 0 and 1 and an area of 7, 15 or 31 pixels.',
    )
}

/** Floor normalized coordinates to a source pixel; the right/bottom endpoint selects the last pixel. */
export function whiteBalanceSampleArea(
  sample: WhiteBalanceSample,
  width: number,
  height: number,
): WhiteBalanceSampleArea {
  validateWhiteBalanceSample(sample)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('Invalid white-balance sample geometry.')
  const centerX = Math.min(width - 1, Math.floor(sample.x * width)),
    centerY = Math.min(height - 1, Math.floor(sample.y * height)),
    radius = (sample.diameter - 1) / 2,
    x = Math.max(0, centerX - radius),
    y = Math.max(0, centerY - radius)
  return {
    x,
    y,
    width: Math.min(width - 1, centerX + radius) - x + 1,
    height: Math.min(height - 1, centerY + radius) - y + 1,
    centerX,
    centerY,
  }
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Small robust sample in the provider's camera domain; never accepts rendered or adjusted pixels. */
export function proposeNeutralWhiteBalance(
  pixels: Float32Array,
  profile: WhiteBalanceProfile | undefined,
  normalization: HdrNormalization | undefined,
): NeutralWhiteBalanceProposal {
  if (pixels.length % 4 || pixels.length > 31 * 31 * 4)
    throw new Error('Invalid bounded white-balance sample.')
  const limits = WHITE_BALANCE_PICKER_LIMITS
  const details: SampleDetails = {
    version: WHITE_BALANCE_PICKER_VERSION,
    provider: profile?.identity ?? null,
    total: pixels.length / 4,
    accepted: 0,
    rejected: { dark: 0, clipped: 0, invalid: 0 },
    scatter: null,
    residual: null,
  }
  const invalid = (reason: WhiteBalanceSampleFailure): NeutralWhiteBalanceProposal => ({
    ...details,
    status: 'invalid',
    reason,
  })
  if (!profile) return invalid('unsupported-source')
  validateWhiteBalanceProfile(profile)
  if (
    profile.ranges.kelvin.length !== 2 ||
    profile.ranges.tint.length !== 2 ||
    profile.ranges.kelvin.some(
      (v) => !Number.isInteger(v) || v < 2000 || v > 25000 || v % 50 !== 0,
    ) ||
    profile.ranges.tint.some((v) => !Number.isInteger(v) || Math.abs(v) > 100) ||
    profile.ranges.kelvin[0] > profile.ranges.kelvin[1] ||
    profile.ranges.tint[0] > profile.ranges.tint[1]
  )
    return invalid('unsupported-source')
  const normal = normalization,
    saturation = normal?.sourceSaturation
  if (
    !normal ||
    !saturation ||
    normal.gains.length !== 4 ||
    normal.black.length !== 4 ||
    saturation.thresholds.length !== 4 ||
    !Number.isFinite(normal.maximum) ||
    normal.maximum <= 0 ||
    normal.gains.some(
      (gain, c) =>
        !Number.isFinite(gain) ||
        gain <= 0 ||
        Math.abs(gain - profile.asShotGains[c === 3 ? 1 : c]) > 1e-6 * Math.max(1, gain),
    )
  )
    return invalid('source-limits-unavailable')
  const inverse = inverseMatrix(profile.cameraToWorking),
    minimumGain = Math.min(...normal.gains)
  const thresholds = [0, 1, 2].map((c) => {
    const channels = c === 1 ? [1, 3] : [c]
    return (
      limits.maximumSaturationFraction *
      Math.min(
        ...channels.map((i) => (saturation.thresholds[i] - normal.black[i]) / normal.maximum),
      )
    )
  })
  if (thresholds.some((v) => !Number.isFinite(v) || v <= limits.minimumSensorSignal))
    return invalid('source-limits-unavailable')
  const samples: [number, number][] = []
  for (let i = 0; i < pixels.length; i += 4) {
    const input = [pixels[i], pixels[i + 1], pixels[i + 2]]
    if (
      !input.every(Number.isFinite) ||
      !Number.isFinite(pixels[i + 3]) ||
      pixels[i + 3] < 0.99 ||
      pixels[i + 3] > 1
    ) {
      details.rejected.invalid++
      continue
    }
    const camera = multiplyVector(inverse, input).map(
      (v, c) => (v * minimumGain) / profile.asShotGains[c],
    )
    if (camera.some((v) => !Number.isFinite(v) || v < limits.minimumSensorSignal)) {
      details.rejected.dark++
      continue
    }
    if (camera.some((v, c) => v >= thresholds[c])) {
      details.rejected.clipped++
      continue
    }
    samples.push([Math.log(camera[0] / camera[1]), Math.log(camera[2] / camera[1])])
  }
  details.accepted = samples.length
  const enough = (count: number) =>
    count >= limits.minimumPixels && count / details.total >= limits.minimumCoverage
  if (!enough(samples.length))
    return invalid(
      details.rejected.clipped > details.total / 4
        ? 'clipped'
        : details.rejected.dark > details.total / 4
          ? 'dark'
          : 'insufficient-coverage',
    )
  const red = median(samples.map((v) => v[0])),
    blue = median(samples.map((v) => v[1]))
  const scatter = samples
    .map((v) => Math.max(Math.abs(v[0] - red), Math.abs(v[1] - blue)))
    .sort((a, b) => a - b)
  details.scatter = scatter[Math.ceil(scatter.length * 0.9) - 1]
  const inliers = samples.filter(
    (v) => Math.max(Math.abs(v[0] - red), Math.abs(v[1] - blue)) <= limits.maximumLogScatter,
  )
  details.accepted = inliers.length
  if (details.scatter > limits.maximumLogScatter || !enough(inliers.length))
    return invalid('uneven-sample')
  const response = [
    Math.exp(median(inliers.map((v) => v[0]))),
    1,
    Math.exp(median(inliers.map((v) => v[1]))),
  ]
  const xyz = multiplyVector(inverseMatrix(profile.xyzToCamera), response)
  const denominator = xyz[0] + 15 * xyz[1] + 3 * xyz[2]
  if (!xyz.every(Number.isFinite) || denominator <= 0) return invalid('out-of-model')
  const uv = [(4 * xyz[0]) / denominator, (6 * xyz[1]) / denominator]
  let best: { mode: 'custom'; kelvin: number; tint: number } | undefined
  let residual = Infinity
  for (let kelvin = profile.ranges.kelvin[0]; kelvin <= profile.ranges.kelvin[1]; kelvin += 50) {
    const locus = locusUv(kelvin),
      normal = whiteBalanceNormal(kelvin)
    const projected = Math.round(
      ((uv[0] - locus[0]) * normal[0] + (uv[1] - locus[1]) * normal[1]) / 0.0001,
    )
    for (const tint of [projected - 1, projected, projected + 1]) {
      if (tint < profile.ranges.tint[0] || tint > profile.ranges.tint[1]) continue
      const gains = customGains(profile, kelvin, tint)
      const corrected = response.map((v, c) => v * gains[c])
      const error = Math.max(
        Math.abs(corrected[0] / corrected[1] - 1),
        Math.abs(corrected[2] / corrected[1] - 1),
      )
      if (error < residual) {
        residual = error
        best = { mode: 'custom', kelvin, tint }
      }
    }
  }
  details.residual = Number.isFinite(residual) ? residual : null
  if (!best || residual > limits.maximumNeutralResidual) return invalid('out-of-model')
  return { ...details, status: 'valid', settings: best }
}
