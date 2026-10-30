import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import type { ProcessingOptions } from '../shared/lens'
import {
  HDR_JPEG_SOURCE_VERSION,
  HDR_RAW_SOURCE_VERSION,
  HDR_SOURCE_VERSION,
  validateHdrSource,
} from '../shared/hdr'
import { frameByteLength } from '../shared/preview-frame'
import { CROP_POLICY, LENS_RENDER_VERSION } from './processing/lens-correction'
import { rawDecoderDefinitions } from './processing/formats'
import { cameraProfiles } from './processing/cameras'
import {
  CROP_GEOMETRY_VERSION,
  cropGeometry,
  type CropGeometry,
  type CropSettings,
} from '../shared/crop'
import { CROP_FILTER_VERSION } from '../shared/crop-filter'
import { validateDetailTransform } from './processing/detail-identity'

export type WorkingAsset = NonNullable<ProcessingOptions['workingAsset']>
export type WorkingAssetRendition = 'working' | 'primary'
export interface WorkingAssetLease {
  identity: string
  asset: WorkingAsset
  backend?: 'cpu' | 'gpu'
  fallback?: string
  detailSource?: import('./processing/detail-identity').DetailSourceLineage
  release: () => void
}

/** Pixel identity excludes authoring constraints that leave the compiled sampling map unchanged. */
export function croppedWorkingIdentity(base: string, geometry: CropGeometry): string {
  if (geometry.identity) return base
  return createHash('sha256')
    .update(
      JSON.stringify([
        base,
        CROP_GEOMETRY_VERSION,
        geometry.pixelAligned ? 'native-copy-v1' : CROP_FILTER_VERSION,
        geometry.source.width,
        geometry.source.height,
        geometry.width,
        geometry.height,
        geometry.outputToSource,
      ]),
    )
    .digest('hex')
}

export function currentWorkingIdentity(
  base: string,
  source: CropGeometry['source'],
  settings?: CropSettings,
): string {
  return settings ? croppedWorkingIdentity(base, cropGeometry(source, settings)) : base
}

/** Source/corrections own this uncropped identity; point edits and geometry are frozen separately. */
export function workingSourceIdentity(
  id: string,
  options: ProcessingOptions,
  workingOnly = true,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        id,
        options.metadata.hdrJpeg
          ? workingOnly
            ? HDR_JPEG_SOURCE_VERSION
            : 'jpeg-sdr-primary-v1'
          : null,
        options.processing ?? 'display-referred-v1',
        options.processing === 'hdr-v1'
          ? options.metadata.mergeMaster
            ? HDR_SOURCE_VERSION
            : HDR_RAW_SOURCE_VERSION
          : null,
        LENS_RENDER_VERSION,
        CROP_POLICY,
        rawDecoderDefinitions,
        cameraProfiles,
        options.metadata.lensProfile.identity,
        options.metadata.whiteBalance?.identity,
        options.settings,
      ]),
    )
    .digest('hex')
}

/** Validate cache/preparation metadata and bytes without loading decoder or encoder libraries. */
export async function validateWorkingAsset(
  asset: WorkingAsset,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const hdr = asset.hdr
  if (!hdr) {
    if (
      asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
      asset.byteLength > 512 * 1024 ** 2 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw new Error('Invalid raster working asset.')
    validateDetailTransform(asset.transform)
  } else {
    validateHdrSource(hdr.source)
    if (
      hdr.kind !== 'hdr-working-v1' ||
      hdr.source.processing !== 'hdr-v1' ||
      asset.width !== hdr.width ||
      asset.height !== hdr.height ||
      asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
      asset.byteLength !== hdr.byteLength ||
      asset.byteLength > 512 * 1024 ** 2 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      asset.sha256 !== hdr.sha256 ||
      !Array.isArray(hdr.strips) ||
      hdr.strips.length !== Math.ceil(asset.height / 64) ||
      hdr.strips.some(
        (strip, index) =>
          strip.byteLength !== Math.min(64, asset.height - index * 64) * asset.width * 16 ||
          !/^[a-f0-9]{64}$/.test(strip.sha256),
      )
    )
      throw new Error('Invalid HDR working asset.')
  }
  const info = await lstat(asset.path)
  signal.throwIfAborted()
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.byteLength)
    throw new Error('Incomplete HDR working asset.')
  const file = await open(asset.path, 'r')
  try {
    const opened = await file.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== asset.byteLength)
      throw new Error('HDR working asset changed during validation.')
    signal.throwIfAborted()
    const digest = createHash('sha256')
    let stripDigest = createHash('sha256'),
      stripIndex = 0,
      stripBytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      digest.update(chunk)
      let offset = 0
      while (hdr && offset < chunk.length) {
        const strip = hdr.strips[stripIndex]
        if (!strip) throw new Error('Unexpected HDR working bytes.')
        const count = Math.min(chunk.length - offset, strip.byteLength - stripBytes)
        stripDigest.update(chunk.subarray(offset, offset + count))
        offset += count
        stripBytes += count
        if (stripBytes === strip.byteLength) {
          if (stripDigest.digest('hex') !== strip.sha256)
            throw new Error('Damaged HDR working strip.')
          stripDigest = createHash('sha256')
          stripIndex++
          stripBytes = 0
        }
      }
    }
    signal.throwIfAborted()
    if (
      digest.digest('hex') !== asset.sha256 ||
      (hdr && stripIndex !== hdr.strips.length) ||
      stripBytes !== 0
    )
      throw new Error(`Damaged ${hdr ? 'HDR' : 'raster'} working asset.`)
  } finally {
    await file.close()
  }
}
