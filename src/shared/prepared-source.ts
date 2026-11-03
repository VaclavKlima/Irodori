export interface PreparedHdrSourceRef {
  readonly photoId: string
  /** Token of the actual main-owned prepared source, never a path or URL. */
  readonly cacheId: string
  readonly renderingIdentity: string
  readonly workingSha256: string
}
export function validatePreparedHdrSourceRef(
  value: unknown,
): asserts value is PreparedHdrSourceRef {
  const ref = value as PreparedHdrSourceRef | null
  if (
    !ref ||
    typeof ref !== 'object' ||
    Array.isArray(ref) ||
    Object.keys(ref).sort().join(',') !== 'cacheId,photoId,renderingIdentity,workingSha256' ||
    typeof ref.photoId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.photoId) ||
    typeof ref.cacheId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.cacheId) ||
    typeof ref.workingSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.workingSha256) ||
    typeof ref.renderingIdentity !== 'string' ||
    !ref.renderingIdentity ||
    ref.renderingIdentity.length > 512
  )
    throw new Error('Invalid prepared HDR source reference.')
}

export interface PreparedHdrSourceRequest {
  readonly source: PreparedHdrSourceRef
  readonly expectedSettingsRevision: number
}
