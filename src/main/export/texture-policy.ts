import { MASKED_TEXTURE_POLICY, hasMaskedTexture } from '../../shared/masked-texture'
import type { ExportRenderJob } from './types'

export const exportTexturePolicy = Object.freeze({
  stage: MASKED_TEXTURE_POLICY,
  algorithm: 'masked-texture-llf-residual-v1',
})
export function validateExportTexturePolicy(job: ExportRenderJob) {
  const policy = job.texturePolicy
  if (
    policy &&
    (Object.keys(policy).sort().join(',') !== 'algorithm,stage' ||
      policy.stage !== exportTexturePolicy.stage ||
      policy.algorithm !== exportTexturePolicy.algorithm)
  )
    throw new Error('This frozen Texture export policy is unsupported. Its files were preserved.')
  if (hasMaskedTexture(job.source.processing.adjustments ?? {}) && !policy)
    throw new Error('Texture export requires its frozen processing policy.')
}
