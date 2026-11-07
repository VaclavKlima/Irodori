import {
  OUTPUT_SHARPENING_STAGE,
  OUTPUT_SHARPENING_VERSION,
  outputSharpeningMode,
} from '../../shared/output-sharpening'
import { validateExportAdmission } from '../../shared/export-resources'
import type { ExportOutputSharpeningPolicy, ExportRenderJob } from './types'

export const exportOutputSharpeningPolicy: Readonly<ExportOutputSharpeningPolicy> = Object.freeze({
  filter: OUTPUT_SHARPENING_VERSION,
  stage: OUTPUT_SHARPENING_STAGE,
})

export function validateExportOutputSharpeningPolicy(job: ExportRenderJob): void {
  const policy = job.outputSharpeningPolicy
  if (
    policy &&
    (Object.keys(policy).sort().join(',') !== 'filter,stage' ||
      policy.filter !== exportOutputSharpeningPolicy.filter ||
      policy.stage !== exportOutputSharpeningPolicy.stage)
  )
    throw new Error('This output sharpening policy is unsupported. Its files were preserved.')
  if (outputSharpeningMode(job.options) !== 'off') {
    if (!policy) throw new Error('Output sharpening requires a frozen operator and stage policy.')
    if (!job.outputSharpeningAdmission)
      throw new Error('Output sharpening requires frozen resource admission.')
  }
  if (job.outputSharpeningAdmission) validateExportAdmission(job.outputSharpeningAdmission)
}
