export const PREPARED_COMPARISON_VERSION = 'unfiltered-spatial-comparison-v1' as const

/** A capability for a prepared cache entry, never a filesystem path. */
export interface PreparedPreviewSourceRef {
  readonly photoId: string
  readonly cacheId: string
  readonly workingSha256: string
}

/** Before retains current geometry/lens preparation and bypasses detail and point edits. */
export interface PreparedComparisonIdentity {
  readonly version: typeof PREPARED_COMPARISON_VERSION
  readonly after: PreparedPreviewSourceRef
  readonly settingsRevision: number
}

export function validatePreparedPreviewSourceRef(
  value: unknown,
): asserts value is PreparedPreviewSourceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid prepared comparison source.')
  const ref = value as PreparedPreviewSourceRef
  if (
    Object.keys(ref).sort().join(',') !== 'cacheId,photoId,workingSha256' ||
    typeof ref.photoId !== 'string' ||
    typeof ref.cacheId !== 'string' ||
    typeof ref.workingSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.photoId) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.cacheId) ||
    !/^[a-f0-9]{64}$/.test(ref.workingSha256)
  )
    throw new Error('Invalid prepared comparison source.')
}
