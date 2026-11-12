import type { MaskPoint } from './masks'
import type { MaskRangeColorSample } from './mask-ranges'

/** Coordinates address the current cropped output; main owns canonical mapping. */
export interface MaskRangeSampleRequest {
  photoId: string
  expectedRevision: number
  renderingIdentity: string
  point: MaskPoint
}

export interface MaskRangeSampleResult {
  photoId: string
  revision: number
  sourceIdentity: string
  canonicalPoint: MaskPoint
  color: MaskRangeColorSample | null
  /** Linear source luminance as a percentage of fixed source white. */
  luminance: number
  validPixels: number
  reason?: string
}

export function validateMaskRangeSampleRequest(value: unknown): MaskRangeSampleRequest {
  const request = value as MaskRangeSampleRequest | null
  if (
    !request ||
    Object.keys(request).sort().join(',') !== 'expectedRevision,photoId,point,renderingIdentity' ||
    typeof request.photoId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.photoId) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0 ||
    typeof request.renderingIdentity !== 'string' ||
    request.renderingIdentity.length < 1 ||
    request.renderingIdentity.length > 1024 ||
    !request.point ||
    Object.keys(request.point).sort().join(',') !== 'x,y' ||
    [request.point.x, request.point.y].some(
      (coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1,
    )
  )
    throw new Error('Supply the confirmed photograph, revision, geometry and a normalized point.')
  return structuredClone(request)
}
