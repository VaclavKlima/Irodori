import {
  GPU_CAMERA_PREPARATION,
  GPU_REFERENCE_PREPARATION,
  type CameraPreparationPolicy,
  type ReferencePreparationPolicy,
  type MergeRecipe,
} from '../../shared/merge'

/** Old recipes retain their CPU arithmetic. The new backend stays opt-in during validation. */
export function cameraPreparationPolicy(recipe?: MergeRecipe): CameraPreparationPolicy | undefined {
  if (recipe) {
    if (
      recipe.cameraPreparation !== undefined &&
      recipe.cameraPreparation !== GPU_CAMERA_PREPARATION
    )
      throw new Error('Unsupported camera preparation policy.')
    if (
      recipe.sources.some(
        (source) =>
          source.cameraPreparation !== undefined &&
          (source.cameraPreparation !== GPU_CAMERA_PREPARATION ||
            recipe.cameraPreparation !== GPU_CAMERA_PREPARATION),
      )
    )
      throw new Error('Unsupported source camera preparation policy.')
    return recipe.cameraPreparation
  }
  return process.env.LUMA_MERGE_CAMERA_PREPARATION === 'gpu' ? GPU_CAMERA_PREPARATION : undefined
}

export function referencePreparationPolicy(
  recipe?: MergeRecipe,
): ReferencePreparationPolicy | undefined {
  if (recipe) {
    if (
      recipe.referenceFallbackPreparation !== undefined &&
      recipe.referenceFallbackPreparation !== GPU_REFERENCE_PREPARATION
    )
      throw new Error('Unsupported reference fallback preparation policy.')
    return recipe.referenceFallbackPreparation
  }
  return process.env.LUMA_MERGE_REFERENCE_PREPARATION === 'gpu'
    ? GPU_REFERENCE_PREPARATION
    : undefined
}
