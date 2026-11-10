import {
  maskCapabilities,
  maskHash,
  validateMaskId,
  maskHasEdges,
  type PreparedMaskCoverage,
  type ResolvedMask,
} from './masks'
import type { CropAdmission } from './crop-resources'
import { packLocalMasks } from './masks-gpu'
import { identityMaskGeometry } from './mask-geometry'
import { validateManagedImageBytes, RESOURCE_POLICY_VERSION } from './resource-policy'

export const MASK_EDGE_ALGORITHM_VERSION = 'canonical-gray-disk16-gaussian-radius64-strips128-r8-v1'
export interface MaskCoverageRequest {
  requestId?: string
  photoId: string
  revision: number
  maskIds: string[]
}
export interface MaskCoverageResult {
  photoId: string
  revision: number
  sourceIdentity: string
  coverages: Record<string, PreparedMaskCoverage>
}
export function validateMaskCoverageRequest(value: MaskCoverageRequest) {
  if (
    !value ||
    Object.keys(value).some(
      (key) => !['photoId', 'revision', 'maskIds', 'requestId'].includes(key),
    ) ||
    !maskHash.test(value.photoId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.maskIds) ||
    value.maskIds.length > maskCapabilities.maxMasks ||
    new Set(value.maskIds).size !== value.maskIds.length
  )
    throw new Error('Invalid mask coverage request.')
  for (const id of value.maskIds) validateMaskId(id)
  if (value.requestId !== undefined) validateMaskId(value.requestId)
  return structuredClone(value)
}
/** Photo-independent pixel input; source/grid identity is bound separately by the owner. */
export function maskEdgePixelIdentity(mask: ResolvedMask) {
  return JSON.stringify([
    MASK_EDGE_ALGORITHM_VERSION,
    mask.base?.hash ?? null,
    mask.gradient ?? null,
    mask.head,
    mask.strokes,
    mask.inverted,
    mask.edge,
  ])
}
export function maskEdgeOwnBytes(width: number, height: number, masks: readonly ResolvedMask[]) {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 32768) ||
    width * height > maskCapabilities.maxBasePixels
  )
    throw new Error(
      'Mask edges exceed the native coverage size limit. Reset Mask edges to keep using manual masking.',
    )
  const active = masks.filter(maskHasEdges),
    pixels = width * height
  let scratch = 0,
    geometry = 0,
    encoded = 0
  for (const mask of active) {
    const halo = Math.abs(mask.edge.shiftPx) + Math.ceil(mask.edge.featherPx)
    scratch = Math.max(scratch, 8 * (width + 2 * halo) * (Math.min(128, height) + 2 * halo))
    geometry = Math.max(
      geometry,
      packLocalMasks(
        {
          localMasks: [
            { ...mask, edge: { featherPx: 0, shiftPx: 0 }, preparedCoverage: undefined },
          ],
          maskGeometry: identityMaskGeometry(width, height),
        },
        { width, height },
      ).byteLength,
    )
    encoded += mask.base ? Math.ceil((mask.base.pngBase64.length * 3) / 4) : 0
  }
  const strip = width * Math.min(128, height) + 256
  const ownGpu = active.length ? scratch + geometry + pixels + 2 * strip + 4096 : 0
  const ownRam = active.length
    ? pixels * 6 + geometry + encoded * 3 + maskCapabilities.maxLiveBaseEncodedBytes * 4
    : 0
  return { ownGpu, ownRam, scratch }
}
export function maskEdgeMemoryPlan(
  width: number,
  height: number,
  masks: readonly ResolvedMask[],
  admission: CropAdmission,
) {
  validateManagedImageBytes(admission.reservation)
  if (
    admission.policy.version !== RESOURCE_POLICY_VERSION ||
    admission.policy.scope !== 'managed-image-resources'
  )
    throw new Error('Invalid mask edge resource policy.')
  const own = maskEdgeOwnBytes(width, height, masks)
  const ramBytes = admission.reservation.ramBytes + own.ownRam
  const vramBytes = admission.reservation.vramBytes + own.ownGpu
  return {
    ...own,
    ramBytes,
    vramBytes,
    accepted:
      ramBytes <= admission.policy.ram.effectiveBytes &&
      vramBytes <= admission.policy.vram.effectiveBytes,
  }
}
