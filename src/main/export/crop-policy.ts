import { CROP_GEOMETRY_VERSION, isUncropped } from '../../shared/crop'
import { CROP_FILTER_VERSION } from '../../shared/crop-filter'
import type { ExportCropPolicy, ExportRenderJob } from './types'

export const exportCropPolicy: Readonly<ExportCropPolicy> = Object.freeze({
  geometry: CROP_GEOMETRY_VERSION,
  filter: CROP_FILTER_VERSION,
})

/** Older identity-only jobs remain readable; a spatial edit must freeze its pixel policy. */
export function validateExportCropPolicy(job: ExportRenderJob): void {
  const policy = job.cropPolicy
  if (
    policy &&
    (Object.keys(policy).sort().join(',') !== 'filter,geometry' ||
      policy.geometry !== exportCropPolicy.geometry ||
      policy.filter !== exportCropPolicy.filter)
  )
    throw new Error('This crop export policy is unsupported. Its files were preserved.')
  if (job.source.processing.crop && !isUncropped(job.source.processing.crop) && !policy)
    throw new Error('Crop export requires a frozen geometry and filter policy.')
}
