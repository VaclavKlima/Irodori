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

export type WorkingAsset = NonNullable<ProcessingOptions['workingAsset']>
export interface WorkingAssetLease {
  identity: string
  asset: WorkingAsset
  backend?: 'cpu' | 'gpu'
  fallback?: string
  release: () => void
}

/** Preparation depends on source/corrections, while committed Light edits stay frozen separately. */
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
  if (!hdr) throw new Error('Missing HDR working descriptor.')
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
      while (offset < chunk.length) {
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
      stripIndex !== hdr.strips.length ||
      stripBytes !== 0
    )
      throw new Error('Damaged HDR working asset.')
  } finally {
    await file.close()
  }
}
