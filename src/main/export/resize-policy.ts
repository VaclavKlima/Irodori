import { EXPORT_RESIZE_VERSION, exportAllowsEnlargement } from '../../shared/export'
import { validateExportAdmission } from '../../shared/export-resources'
import type { ExportRenderJob, ExportResizePolicy } from './types'

export const exportResizePolicy: Readonly<ExportResizePolicy> = Object.freeze({
  filter: EXPORT_RESIZE_VERSION,
})

/** Old jobs keep their no-enlargement default; new enlargement freezes policy and resources. */
export function validateExportResizePolicy(job: ExportRenderJob): void {
  const policy = job.resizePolicy
  if (
    policy &&
    (Object.keys(policy).join(',') !== 'filter' || policy.filter !== exportResizePolicy.filter)
  )
    throw new Error('This export resize policy is unsupported. Its files were preserved.')
  if (exportAllowsEnlargement(job.options.size)) {
    if (!policy) throw new Error('Enlargement requires a frozen resize policy.')
    if (!job.resizeAdmission) throw new Error('Enlargement requires frozen resource admission.')
  }
  if (job.resizeAdmission) validateExportAdmission(job.resizeAdmission)
}
