import {
  mergeRecomputationReason,
  type CameraPreparationPolicy,
  type MergeRecipe,
  type ReferencePreparationPolicy,
} from '../../shared/merge'

function requireExecutor(recipe?: MergeRecipe) {
  const reason = mergeRecomputationReason(recipe)
  if (reason) throw new Error(reason)
}

/** Accepted CPU camera/reference arithmetic is common to both platforms.
 * Historical GPU policy identifiers remain provenance, never runtime overrides. */
export function cameraPreparationPolicy(recipe?: MergeRecipe): CameraPreparationPolicy | undefined {
  requireExecutor(recipe)
  return undefined
}

export function referencePreparationPolicy(
  recipe?: MergeRecipe,
): ReferencePreparationPolicy | undefined {
  requireExecutor(recipe)
  return undefined
}
