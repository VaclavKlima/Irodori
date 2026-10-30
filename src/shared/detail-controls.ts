import {
  neutralNoiseReduction,
  neutralDetailSharpening,
  validateNoiseReduction,
  validateDetailSharpening,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
  NOISE_REDUCTION_VERSION,
  DETAIL_SHARPENING_VERSION,
  SPATIAL_DETAIL_STAGE,
} from './spatial-detail'

export type NoiseReductionPatch = Partial<NoiseReductionSettings>
export type DetailSharpeningPatch = Partial<DetailSharpeningSettings>
export interface SpatialControls {
  noiseReduction?: NoiseReductionSettings
  detailSharpening?: DetailSharpeningSettings
}
const amount = { min: 0, max: 100, step: 1, precision: 0, default: 0, unit: 'amount' } as const
export const detailCapabilities = {
  spatialDetail: {
    stage: SPATIAL_DETAIL_STAGE,
    stageOrder: ['noiseReduction', 'detailSharpening'],
    preview: 'committed-native-source',
    domains: ['linear-srgb', 'linear-rec2020'],
  },
  noiseReduction: {
    supported: true,
    settingsVersion: 1,
    algorithm: NOISE_REDUCTION_VERSION,
    parameters: { luminance: { ...amount }, chroma: { ...amount } },
  },
  detailSharpening: {
    supported: true,
    settingsVersion: 1,
    algorithm: DETAIL_SHARPENING_VERSION,
    parameters: {
      amount: { ...amount },
      radius: { min: 0.5, max: 3, step: 0.1, precision: 1, default: 1, unit: 'source-pixels' },
      threshold: { ...amount, default: 50 },
    },
  },
} as const
function partial(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Invalid spatial edit group.')
}
export function validateNoiseReductionPatch(value: unknown): asserts value is NoiseReductionPatch {
  partial(value, ['version', 'luminance', 'chroma'])
  validateNoiseReduction({ ...neutralNoiseReduction, ...(value as NoiseReductionPatch) })
}
export function validateDetailSharpeningPatch(
  value: unknown,
): asserts value is DetailSharpeningPatch {
  partial(value, ['version', 'amount', 'radius', 'threshold'])
  validateDetailSharpening({ ...neutralDetailSharpening, ...(value as DetailSharpeningPatch) })
}
export function mergeNoiseReduction(base: NoiseReductionSettings, patch: NoiseReductionPatch) {
  validateNoiseReductionPatch(patch)
  return {
    version: 1 as const,
    luminance: patch.luminance ?? base.luminance,
    chroma: patch.chroma ?? base.chroma,
  }
}
export function mergeDetailSharpening(
  base: DetailSharpeningSettings,
  patch: DetailSharpeningPatch,
) {
  validateDetailSharpeningPatch(patch)
  return {
    version: 1 as const,
    amount: patch.amount ?? base.amount,
    radius: patch.radius ?? base.radius,
    threshold: patch.threshold ?? base.threshold,
  }
}
export function spatialControlsActive(settings: SpatialControls): boolean {
  return (
    (settings.noiseReduction?.luminance ?? 0) > 0 ||
    (settings.noiseReduction?.chroma ?? 0) > 0 ||
    (settings.detailSharpening?.amount ?? 0) > 0
  )
}
/** Authored controls matter to history even when Amount is zero. */
export function spatialControlsKey(settings: SpatialControls): string {
  const noise = settings.noiseReduction ?? neutralNoiseReduction,
    detail = settings.detailSharpening ?? neutralDetailSharpening
  return JSON.stringify([
    noise.version,
    noise.luminance,
    noise.chroma,
    detail.version,
    detail.amount,
    detail.radius,
    detail.threshold,
  ])
}
