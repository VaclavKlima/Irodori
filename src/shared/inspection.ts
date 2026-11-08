/** Inspection coordinates always address the complete committed photograph, never a viewport. */
export interface InspectionBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface InspectionRegion extends InspectionBounds {
  units: 'pixels' | 'normalized'
  gridIdentity: string
}
export type InspectionEncoding = { format: 'jpeg'; quality?: number } | { format: 'png' }
export interface InspectionOptions {
  region?: InspectionRegion
  resolutionPercent?: number
  encoding?: InspectionEncoding
  comparison?: 'after' | 'before' | 'pair'
  hdr?: boolean
}
export const INSPECTION_IMAGE_LIMIT = 8 * 1024 ** 2
export const INSPECTION_PAIR_LIMIT = 16 * 1024 ** 2
export const inspectionHdrCapability = Object.freeze({
  available: false as const,
  reason:
    'HDR image delivery is unavailable: no client/version/model/transport combination is qualified to preserve HDR values or gain maps. Request an explicitly labelled SDR rendition.',
})
export interface PreviewContext {
  photoId: string
  revision: number
  width: number
  height: number
  gridIdentity: string
  geometry?: import('./mask-geometry').MaskGeometry
  coordinateSpace: 'oriented-lens-corrected-cropped-photo'
  sourceDynamicRange: 'sdr' | 'hdr'
  sourceMetadata?: { authoredHeadroom?: number; primaries?: string; transfer?: string }
  formats: readonly ['jpeg', 'png']
  hdr: typeof inspectionHdrCapability
  limits: { imageBytes: number; pairBytes: number }
}
export interface InspectionImage {
  label: 'before' | 'after'
  photoId: string
  revision: number
  renderingIdentity: string
  gridIdentity: string
  width: number
  height: number
  native: 'photo-native' | 'export-native'
  /** Bounds in the photo grid, shared by matched members. */
  photoBounds: InspectionBounds
  /** Actual resolved bounds in this member's native grid. */
  bounds: InspectionBounds
  nativeGrid: { width: number; height: number }
  encoding: { format: 'jpeg'; quality: number; lossless: false } | { format: 'png'; lossless: true }
  mimeType: 'image/jpeg' | 'image/png'
  colorSpace: 'srgb'
  sourceDynamicRange: 'sdr' | 'hdr'
  sourceMetadata?: PreviewContext['sourceMetadata']
  requestedRendition: 'sdr' | 'hdr'
  effectiveRendition: 'sdr'
  hdr: typeof inspectionHdrCapability
  rendition: 'sRGB SDR rendition'
  comparison: 'current revision' | 'neutral rendition derived from current revision'
  byteLength: number
  data: string
}
export interface InspectionResult {
  photoId: string
  revision: number
  gridIdentity: string
  members: InspectionImage[]
}
function record(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid inspection options.')
}
/** Snap representation noise at integral pixel edges without quantizing real fractions. */
const stablePixelEdge = (value: number) =>
  Math.abs(value - Math.round(value)) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 4
    ? Math.round(value)
    : value

export function validateInspectionOptions(value: unknown): InspectionOptions {
  record(value, ['region', 'resolutionPercent', 'encoding', 'comparison', 'hdr'])
  if (
    value.resolutionPercent !== undefined &&
    (typeof value.resolutionPercent !== 'number' ||
      !Number.isFinite(value.resolutionPercent) ||
      value.resolutionPercent <= 0 ||
      value.resolutionPercent > 100)
  )
    throw new Error('Inspection resolutionPercent must be greater than 0 through 100.')
  if (
    value.comparison !== undefined &&
    (typeof value.comparison !== 'string' ||
      !['after', 'before', 'pair'].includes(value.comparison))
  )
    throw new Error('Invalid inspection comparison.')
  if (value.hdr !== undefined && typeof value.hdr !== 'boolean')
    throw new Error('Invalid HDR inspection request.')
  if (value.region !== undefined) {
    record(value.region, ['units', 'gridIdentity', 'x', 'y', 'width', 'height'])
    const r = value.region
    if (
      typeof r.units !== 'string' ||
      !['pixels', 'normalized'].includes(r.units) ||
      typeof r.gridIdentity !== 'string' ||
      !r.gridIdentity ||
      r.gridIdentity.length > 4096 ||
      ![r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
      Number(r.x) < 0 ||
      Number(r.y) < 0 ||
      Number(r.width) <= 0 ||
      Number(r.height) <= 0 ||
      (r.units === 'pixels' && ![r.x, r.y, r.width, r.height].every(Number.isSafeInteger))
    )
      throw new Error(
        'Use positive, in-bounds inspection dimensions and a matching gridIdentity; pixel bounds must be integers.',
      )
  }
  if (value.encoding !== undefined) {
    record(value.encoding, ['format', 'quality'])
    if (
      (value.encoding.format !== 'jpeg' && value.encoding.format !== 'png') ||
      (value.encoding.format === 'png' && value.encoding.quality !== undefined) ||
      (value.encoding.quality !== undefined &&
        (!Number.isSafeInteger(value.encoding.quality) ||
          Number(value.encoding.quality) < 1 ||
          Number(value.encoding.quality) > 100))
    )
      throw new Error(
        'Use JPEG quality 1–100 or lossless PNG without quality. JPEG quality 100 remains lossy.',
      )
  }
  return structuredClone(value) as InspectionOptions
}
export function resolveInspectionRegion(
  region: InspectionRegion | undefined,
  context: Pick<PreviewContext, 'width' | 'height' | 'gridIdentity'>,
): InspectionBounds {
  if (!region) return { x: 0, y: 0, width: context.width, height: context.height }
  validateInspectionOptions({ region })
  if (region.gridIdentity !== context.gridIdentity)
    throw new Error(
      'The inspection grid changed. Read preview context and select the region again; stale coordinates cannot be reused.',
    )
  const sx = region.units === 'normalized' ? context.width : 1,
    sy = region.units === 'normalized' ? context.height : 1,
    right = stablePixelEdge((region.x + region.width) * sx),
    bottom = stablePixelEdge((region.y + region.height) * sy)
  if (
    region.x >= context.width / sx ||
    region.y >= context.height / sy ||
    right > context.width ||
    bottom > context.height
  )
    throw new Error(
      'The inspection region is outside the current photograph. Read preview context and choose in-bounds coordinates.',
    )
  const x = Math.min(context.width - 1, Math.floor(stablePixelEdge(region.x * sx))),
    y = Math.min(context.height - 1, Math.floor(stablePixelEdge(region.y * sy)))
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(right) - x),
    height: Math.max(1, Math.ceil(bottom) - y),
  }
}
export function resolveInspection(
  options: InspectionOptions,
  context: PreviewContext,
  nativeGrid: { width: number; height: number } = context,
) {
  options = validateInspectionOptions(options)
  if (options.hdr) throw new Error(inspectionHdrCapability.reason)
  const photoBounds = resolveInspectionRegion(options.region, context),
    x = Math.floor(stablePixelEdge((photoBounds.x * nativeGrid.width) / context.width)),
    y = Math.floor(stablePixelEdge((photoBounds.y * nativeGrid.height) / context.height)),
    bounds = {
      x,
      y,
      width:
        Math.ceil(
          stablePixelEdge(((photoBounds.x + photoBounds.width) * nativeGrid.width) / context.width),
        ) - x,
      height:
        Math.ceil(
          stablePixelEdge(
            ((photoBounds.y + photoBounds.height) * nativeGrid.height) / context.height,
          ),
        ) - y,
    },
    scale =
      options.resolutionPercent === undefined
        ? Math.min(1, 1024 / Math.max(bounds.width, bounds.height))
        : options.resolutionPercent / 100,
    encoding =
      options.encoding?.format === 'png'
        ? { format: 'png' as const, lossless: true as const }
        : {
            format: 'jpeg' as const,
            quality: options.encoding?.quality ?? 80,
            lossless: false as const,
          }
  return {
    photoBounds,
    bounds,
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale)),
    encoding,
    labels: (options.comparison === 'pair'
      ? ['before', 'after']
      : [options.comparison ?? 'after']) as ('before' | 'after')[],
  }
}
