import {
  NOISE_REDUCTION_VERSION,
  DETAIL_SHARPENING_VERSION,
  SPATIAL_DETAIL_STAGE,
} from '../../shared/spatial-detail'
import {
  resolveDetailSettings,
  detailLineageKey,
  detailPreparationKey,
} from '../processing/detail-identity'
import { validatePreparedPreviewLineage } from '../prepared-preview-lineage'
import { workingSourceIdentity, type WorkingAssetLease } from '../working-assets'
import type { ExportDetailPolicy, ExportRenderJob, ExportSource } from './types'
import { srgbTransform } from '../../shared/adjustments'

export const exportDetailPolicy: Readonly<ExportDetailPolicy> = Object.freeze({
  stage: SPATIAL_DETAIL_STAGE,
  noiseReduction: NOISE_REDUCTION_VERSION,
  detailSharpening: DETAIL_SHARPENING_VERSION,
})

/** Neutral legacy jobs remain supported; active spatial controls freeze their numerical policy. */
export function validateExportDetailPolicy(job: ExportRenderJob): void {
  const policy = job.detailPolicy,
    controls = resolveDetailSettings(job.source.processing)
  if (
    policy &&
    (Object.keys(policy).sort().join(',') !== 'detailSharpening,noiseReduction,stage' ||
      policy.stage !== exportDetailPolicy.stage ||
      policy.noiseReduction !== exportDetailPolicy.noiseReduction ||
      policy.detailSharpening !== exportDetailPolicy.detailSharpening)
  )
    throw new Error('This detail export policy is unsupported. Its files were preserved.')
  if (controls.active && !policy)
    throw new Error('Noise reduction/detail export requires a frozen operator and stage policy.')
}

/** A frozen job can use either its verified upstream source or its exact filtered variant. */
export function matchesExportWorkingAsset(
  source: ExportSource,
  lease: Omit<WorkingAssetLease, 'release'>,
  primary = false,
): boolean {
  const hdr = source.hdr && !primary,
    upstream = workingSourceIdentity(source.photo.id, source.processing, hdr),
    controls = resolveDetailSettings(source.processing)
  if (Boolean(lease.asset.hdr) !== hdr) return false
  if (!hdr) {
    const transform = lease.asset.transform
    if (
      !transform ||
      transform.white !== srgbTransform.white ||
      transform.threshold !== srgbTransform.threshold ||
      transform.offset !== srgbTransform.offset ||
      transform.quantize !== srgbTransform.quantize ||
      transform.whiteBalance
    )
      return false
  }
  if (!lease.detailSource) return lease.identity === upstream
  if (!controls.active || lease.detailSource.sourceIdentity !== upstream) return false
  try {
    const key = detailLineageKey(lease.detailSource)
    if (
      key !== lease.identity ||
      detailPreparationKey(
        upstream,
        lease.detailSource.asset,
        controls.noiseReduction,
        controls.detailSharpening,
      ) !== key
    )
      return false
    validatePreparedPreviewLineage(
      {
        width: lease.asset.width,
        height: lease.asset.height,
        linear: lease.asset,
      },
      key,
      { detailSource: lease.detailSource },
    )
    return true
  } catch {
    return false
  }
}
