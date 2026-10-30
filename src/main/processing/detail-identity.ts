import { createHash } from 'node:crypto'
import type { DisplayTransform } from '../../shared/adjustments'
import { validateHdrSource, type HdrWorkingAsset } from '../../shared/hdr'
import { frameByteLength, MAX_FRAME_BYTES } from '../../shared/preview-frame'
import { validateWhiteBalanceProfile } from '../../shared/white-balance'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  NOISE_REDUCTION_VERSION,
  DETAIL_SHARPENING_VERSION,
  SPATIAL_DETAIL_STAGE,
  neutralNoiseReduction,
  neutralDetailSharpening,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../../shared/spatial-detail'

export const DETAIL_PREPARATION_VERSION = 'prepared-native-detail-v2'
export interface DetailIdentitySource {
  readonly width: number
  readonly height: number
  readonly sha256: string
  readonly source?: HdrWorkingAsset['source']
  readonly whiteBalance?: HdrWorkingAsset['whiteBalance']
  readonly transform?: DisplayTransform
}
export interface DetailSourceLineage {
  readonly sourceIdentity: string
  readonly asset: DetailIdentitySource
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
}

export function resolveDetailSettings(options: {
  noiseReduction?: NoiseReductionSettings
  detailSharpening?: DetailSharpeningSettings
}) {
  const noise = compileNoiseReduction(
      options.noiseReduction === undefined ? neutralNoiseReduction : options.noiseReduction,
    ),
    sharp = compileDetailSharpening(
      options.detailSharpening === undefined ? neutralDetailSharpening : options.detailSharpening,
    )
  return {
    noiseReduction: noise.settings,
    detailSharpening: sharp.settings,
    active: noise.active || sharp.active,
  }
}

export function validateDetailTransform(transform: DisplayTransform): void {
  if (
    !transform ||
    !Number.isFinite(transform.white) ||
    transform.white <= 0 ||
    !Number.isFinite(transform.threshold) ||
    transform.threshold < 0 ||
    transform.threshold > 1 ||
    !Number.isFinite(transform.offset) ||
    transform.offset < 0 ||
    transform.offset > 1 ||
    typeof transform.quantize !== 'boolean'
  )
    throw new Error('Invalid detail source transform.')
  if (transform.whiteBalance) validateWhiteBalanceProfile(transform.whiteBalance)
}

/** Path-free upstream metadata remains valid when an idle parent cache entry is evicted. */
export function detailLineageKey(lineage: DetailSourceLineage): string {
  if (
    !lineage?.asset ||
    Object.keys(lineage).some(
      (key) => !['sourceIdentity', 'asset', 'noiseReduction', 'detailSharpening'].includes(key),
    ) ||
    Object.keys(lineage.asset).some(
      (key) => !['width', 'height', 'sha256', 'source', 'whiteBalance', 'transform'].includes(key),
    ) ||
    frameByteLength(lineage.asset.width, lineage.asset.height) * 4 > MAX_FRAME_BYTES
  )
    throw new Error('Invalid detail cache source.')
  const asset = lineage.asset,
    settings = resolveDetailSettings(lineage)
  if (!settings.active) throw new Error('Neutral detail must reuse its upstream cache entry.')
  if (asset.source) {
    validateHdrSource(asset.source)
    if (asset.whiteBalance) validateWhiteBalanceProfile(asset.whiteBalance)
  } else {
    if (asset.whiteBalance) throw new Error('Invalid raster detail source domain.')
    validateDetailTransform(asset.transform!)
  }
  return detailPreparationKey(
    lineage.sourceIdentity,
    asset,
    settings.noiseReduction,
    settings.detailSharpening,
  )
}

/** Cache-safe identity helper; importing it does not load decoders or native modules. */
export function detailPreparationKey(
  sourceIdentity: string,
  asset: DetailIdentitySource,
  noiseReduction: NoiseReductionSettings,
  detailSharpening: DetailSharpeningSettings,
): string {
  if (!/^[a-f0-9]{64}$/.test(sourceIdentity) || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw new Error('Invalid detail source identity.')
  const noise = compileNoiseReduction(noiseReduction),
    sharp = compileDetailSharpening(detailSharpening)
  if (!noise.active && !sharp.active) return sourceIdentity
  return createHash('sha256')
    .update(
      JSON.stringify([
        DETAIL_PREPARATION_VERSION,
        SPATIAL_DETAIL_STAGE,
        sourceIdentity,
        asset.sha256,
        noise.active ? [NOISE_REDUCTION_VERSION, noiseReduction] : null,
        sharp.active ? [DETAIL_SHARPENING_VERSION, detailSharpening] : null,
        asset.width,
        asset.height,
        asset.source ?? 'authored-linear-srgb-v1',
        asset.source ? asset.whiteBalance : asset.transform,
      ]),
    )
    .digest('hex')
}
