import { createHash } from 'node:crypto'
import { croppedMaskGeometry, identityMaskGeometry } from '../../shared/mask-geometry'
import { neutralAdjustments } from '../../shared/adjustments'
import { cropGeometry, identityCrop } from '../../shared/crop'
import {
  INSPECTION_IMAGE_LIMIT,
  INSPECTION_PAIR_LIMIT,
  inspectionHdrCapability,
  type PreviewContext,
} from '../../shared/inspection'
import { neutralNoiseReduction, neutralDetailSharpening } from '../../shared/spatial-detail'
import { workingSourceIdentity } from '../working-assets'
import type { ExportSource } from '../export/types'

export function neutralInspectionSource(source: ExportSource): ExportSource {
  const neutral = structuredClone(source)
  neutral.processing.adjustments = structuredClone(neutralAdjustments)
  neutral.processing.noiseReduction = { ...neutralNoiseReduction }
  neutral.processing.detailSharpening = { ...neutralDetailSharpening }
  return neutral
}
/** Geometry identity excludes tonal edits and revision, but includes equal-sized rotations. */
export function inspectionContext(
  source: ExportSource,
  size: {
    width: number
    height: number
    maskGeometry?: import('../../shared/mask-geometry').MaskGeometry
    hdr?: { maskGeometry?: import('../../shared/mask-geometry').MaskGeometry }
  },
): PreviewContext {
  const crop = source.processing.crop ?? identityCrop,
    geometry = cropGeometry(size, crop)
  const gridIdentity = createHash('sha256')
    .update(
      JSON.stringify({
        version: 'inspection-photo-grid-v1',
        photoId: source.photo.id,
        source: source.identity,
        size: { width: size.width, height: size.height },
        crop: { ...crop, aspectRatio: null },
        orientation: source.processing.metadata.orientation ?? 1,
        lens: source.processing.metadata.lensProfile.identity,
        settings: {
          distortion: source.processing.settings.distortion,
          chromaticAberration: source.processing.settings.chromaticAberration,
        },
      }),
    )
    .digest('hex')
  const authored = source.processing.metadata.hdrJpeg
  const baseGeometry =
    size.maskGeometry ?? size.hdr?.maskGeometry ?? identityMaskGeometry(size.width, size.height)
  return {
    photoId: source.photo.id,
    revision: source.processing.revision,
    width: geometry.width,
    height: geometry.height,
    gridIdentity,
    geometry: geometry.identity ? baseGeometry : croppedMaskGeometry(baseGeometry, geometry),
    coordinateSpace: 'oriented-lens-corrected-cropped-photo',
    sourceDynamicRange: source.hdr ? 'hdr' : 'sdr',
    sourceMetadata:
      authored?.state === 'supported' ? { authoredHeadroom: authored.headroom } : undefined,
    formats: ['jpeg', 'png'],
    hdr: { ...inspectionHdrCapability },
    limits: { imageBytes: INSPECTION_IMAGE_LIMIT, pairBytes: INSPECTION_PAIR_LIMIT },
  }
}

/** Cold RAWs can require full-source preparation; this is not an ROI-only decoder. */
export async function prepareInspectionContext(
  source: ExportSource,
  directory: string,
  signal: AbortSignal,
  working?: Omit<import('../working-assets').WorkingAssetLease, 'release'>,
) {
  if (working) return { context: inspectionContext(source, working.asset), working }
  const existing = source.processing.workingAsset
  if (existing)
    return {
      context: inspectionContext(source, existing),
      working: {
        asset: existing,
        identity: workingSourceIdentity(source.photo.id, source.processing, source.hdr),
      },
    }
  const { PreviewProcess } = await import('../preview-process')
  const decoder = new PreviewProcess()
  try {
    const frame = await decoder.renderFull(source.path, directory, signal, {
      ...neutralInspectionSource(source).processing,
      crop: undefined,
      noiseReduction: undefined,
      detailSharpening: undefined,
      prepareLinear: true,
      workingOnly: source.hdr,
    })
    const asset = frame.linear
      ? {
          ...frame.linear,
          path: (await import('node:path')).join(directory, 'linear.f32'),
          width: frame.width,
          height: frame.height,
        }
      : undefined
    return {
      context: inspectionContext(source, {
        width: frame.width,
        height: frame.height,
        maskGeometry: frame.linear?.maskGeometry ?? frame.linear?.hdr?.maskGeometry,
      }),
      working: asset
        ? { asset, identity: workingSourceIdentity(source.photo.id, source.processing, source.hdr) }
        : undefined,
    }
  } finally {
    await decoder.close(true)
  }
}
