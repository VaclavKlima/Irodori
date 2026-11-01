/** Automatic spatial filtering is strict GPU; explicit CPU remains a legacy diagnostic route. */
export function spatialExecutionBackend(
  value: string | undefined,
  stage: 'detail' | 'crop',
): 'cpu' | 'gpu' {
  if (value === 'cpu') return 'cpu'
  if (value === undefined || value === 'auto' || value === 'gpu') return 'gpu'
  throw new Error(`Invalid ${stage} processing backend.`)
}
