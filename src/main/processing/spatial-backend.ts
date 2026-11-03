/** Retired overrides fail explicitly; a failed selected GPU never restarts CPU work. */
export function spatialExecutionBackend(
  value: string | undefined,
  stage: 'detail' | 'crop',
): 'gpu' {
  if (value === undefined || value === 'auto' || value === 'gpu') return 'gpu'
  throw new Error(`Unsupported ${stage} processing backend: ${value}. Use the shared GPU stage.`)
}
