import {
  INSPECTION_IMAGE_LIMIT,
  INSPECTION_PAIR_LIMIT,
  resolveInspection,
  validateInspectionOptions,
  type InspectionBounds,
  type InspectionOptions,
  type InspectionRegion,
  type PreviewContext,
} from './inspection'
import { maskHash, validateMaskId } from './masks'
import type { ResolvedMask } from './masks'
import type { CropAdmission } from './crop-resources'
import { maskBaseAtlasPlan, packLocalMasks } from './masks-gpu'
import { RESOURCE_POLICY_VERSION, validateManagedImageBytes } from './resource-policy'

export const MASK_PREVIEW_VERSION = 'stored-root-current-grid-sdr-orange-v1'
export const MASK_PREVIEW_ROWS = 64
export const maskPreviewOverlay = Object.freeze({
  color: [0.96, 0.3, 0.16] as readonly number[],
  opacity: 0.38,
})
export type MaskPreviewView = 'coverage' | 'overlay' | 'pair'
export interface MaskPreviewRequest {
  photoId: string
  expectedRevision: number
  maskId: string
  view?: MaskPreviewView
  inspection?: { region?: InspectionRegion; resolutionPercent?: number }
}
export interface MaskPreviewImage {
  label: 'coverage' | 'overlay'
  photoId: string
  revision: number
  maskId: string
  gridIdentity: string
  renderingIdentity: string
  hash: string
  width: number
  height: number
  native: 'photo-native'
  photoBounds: InspectionBounds
  bounds: InspectionBounds
  nativeGrid: { width: number; height: number }
  encoding: { format: 'png'; lossless: true }
  mimeType: 'image/png'
  colorSpace: 'coverage' | 'srgb'
  sourceDynamicRange: 'sdr' | 'hdr'
  rendition: 'mask coverage, black 0 and white 1' | 'sRGB SDR mask overlay'
  byteLength: number
  data: string
}
export interface MaskPreviewResult {
  photoId: string
  revision: number
  maskId: string
  maskName: string
  enabled: boolean
  adjustmentsNeutral: boolean
  coverageSemantics: 'stored-mask-shape'
  gridIdentity: string
  overlay: typeof maskPreviewOverlay
  members: MaskPreviewImage[]
}
export const maskPreviewLimits = Object.freeze({
  imageBytes: INSPECTION_IMAGE_LIMIT,
  pairBytes: INSPECTION_PAIR_LIMIT,
})
export function validateMaskPreviewRequest(value: unknown): MaskPreviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Mask preview requires photoId, expectedRevision and an existing root maskId.')
  const request = value as Record<string, unknown>
  if (
    Object.keys(request).some(
      (key) => !['photoId', 'expectedRevision', 'maskId', 'view', 'inspection'].includes(key),
    ) ||
    typeof request.photoId !== 'string' ||
    !maskHash.test(request.photoId)
  )
    throw new Error('Mask preview photoId must identify a managed photograph.')
  if (!Number.isSafeInteger(request.expectedRevision) || Number(request.expectedRevision) < 0)
    throw new Error(
      'Mask preview expectedRevision must be the current non-negative integer revision.',
    )
  validateMaskId(request.maskId)
  if (
    request.view !== undefined &&
    (typeof request.view !== 'string' || !['coverage', 'overlay', 'pair'].includes(request.view))
  )
    throw new Error(
      'Mask preview view must be coverage, overlay or pair. Example: {"view":"pair"}.',
    )
  if (request.inspection !== undefined) {
    const inspection = request.inspection
    if (
      !inspection ||
      typeof inspection !== 'object' ||
      Array.isArray(inspection) ||
      Object.keys(inspection).some((key) => !['region', 'resolutionPercent'].includes(key))
    )
      throw new Error(
        'Mask preview inspection accepts only region and resolutionPercent; images use lossless PNG.',
      )
    validateInspectionOptions(inspection)
  }
  return structuredClone(request) as unknown as MaskPreviewRequest
}
export function maskPreviewInspection(request: MaskPreviewRequest): InspectionOptions {
  return { ...request.inspection, comparison: 'after', encoding: { format: 'png' }, hdr: false }
}
export function resolveMaskPreview(request: MaskPreviewRequest, context: PreviewContext) {
  const resolved = resolveInspection(maskPreviewInspection(request), context)
  return {
    ...resolved,
    labels: (request.view === 'coverage'
      ? ['coverage']
      : request.view === 'overlay'
        ? ['overlay']
        : ['coverage', 'overlay']) as ('coverage' | 'overlay')[],
  }
}

/** Own decoded/encoded outputs, immutable-base transfer, atlas and bounded GPU strips. */
export function maskPreviewMemoryPlan(
  request: MaskPreviewRequest,
  context: PreviewContext,
  mask: ResolvedMask,
  admission: CropAdmission,
) {
  validateManagedImageBytes(admission.reservation)
  if (
    admission.policy.version !== RESOURCE_POLICY_VERSION ||
    admission.policy.scope !== 'managed-image-resources'
  )
    throw new Error('Invalid mask preview resource policy.')
  if (!context.geometry)
    throw new Error('The mask preview photo geometry is unavailable. Refresh preview context.')
  const resolved = resolveMaskPreview(request, context)
  const { width, height, labels } = resolved
  if (width * height > 32 * 1024 ** 2)
    throw new Error(
      'Mask preview exceeds the native image size limit. Reduce resolutionPercent or choose a smaller region.',
    )
  const parameters = { localMasks: [mask], maskGeometry: context.geometry }
  const atlas = maskBaseAtlasPlan(parameters, true)
  const descriptors = packLocalMasks(parameters, context, true).byteLength
  const strips = width * Math.min(MASK_PREVIEW_ROWS, height) * 4
  const overlay = labels.includes('overlay')
  const encodedBases = atlas.bases.reduce(
    (sum, base) => sum + Math.ceil((base.pngBase64.length * 3) / 4),
    0,
  )
  const ownRam =
    width * height * 4 * (labels.length + Number(overlay)) +
    atlas.decodeBytes +
    encodedBases * 8 +
    strips +
    descriptors +
    INSPECTION_IMAGE_LIMIT * (labels.length * 3 + Number(overlay))
  const ownGpu = atlas.bytes + strips * 4 + descriptors + 32
  const ramBytes = admission.reservation.ramBytes + ownRam
  const vramBytes = admission.reservation.vramBytes + ownGpu
  if (![ownRam, ownGpu, ramBytes, vramBytes].every(Number.isSafeInteger))
    throw new Error('Invalid mask preview memory accounting.')
  return {
    ownRam,
    ownGpu,
    ramBytes,
    vramBytes,
    accepted:
      ramBytes <= admission.policy.ram.effectiveBytes &&
      vramBytes <= admission.policy.vram.effectiveBytes,
  }
}
