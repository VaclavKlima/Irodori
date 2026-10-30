import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { cropGeometry, type CropGeometry, type CropSettings } from '../../shared/crop'
import type { HdrWorkingAsset } from '../../shared/hdr'
import { copyIntegerCropStrip } from './crop'
import { readHdrStrips } from './hdr-processing'
import { writeHdrStrip } from './write-hdr-strip'

export interface CroppedWorkingAsset {
  path: string
  asset: HdrWorkingAsset
  geometry: CropGeometry
  reused: boolean
}

/**
 * Worker-only preparation; the caller holds the source lease and lends an admitted
 * destination until completion. No original/master file is overwritten. Identity
 * reuses the validated source without another read, write or float allocation.
 */
export async function prepareIntegerCrop(
  sourcePath: string,
  descriptor: HdrWorkingAsset,
  settings: CropSettings,
  outputPath: string,
  signal: AbortSignal,
  destination?: Float32Array,
  progress?: (processedRows: number, totalRows: number) => void | Promise<void>,
): Promise<CroppedWorkingAsset> {
  signal.throwIfAborted()
  const asset = structuredClone(descriptor),
    geometry = cropGeometry(asset, settings)
  if (geometry.identity) return { path: sourcePath, asset, geometry, reused: true }
  if (!geometry.pixelAligned)
    throw new Error('A fractional crop requires the validated spatial-filter path.')
  const byteLength = geometry.width * geometry.height * 16
  if (!destination || destination.byteLength !== byteLength || byteLength > 512 * 1024 ** 2)
    throw new Error('The crop requires an admitted native-size destination allocation.')

  // Exclusive creation establishes ownership. A pre-existing file is never removed.
  const file = await open(outputPath, 'wx')
  let complete = false
  try {
    signal.throwIfAborted()
    let top = 0,
      copied = 0
    for await (const strip of readHdrStrips(sourcePath, asset)) {
      signal.throwIfAborted()
      copied += copyIntegerCropStrip(strip, top, geometry, destination)
      top += strip.length / (asset.width * 4)
      await progress?.(top, asset.height)
      signal.throwIfAborted()
    }
    if (top !== asset.height || copied !== geometry.width * geometry.height)
      throw new Error('Incomplete cropped working pixels.')

    const digest = createHash('sha256'),
      strips: HdrWorkingAsset['strips'] = []
    for (let y = 0; y < geometry.height; y += 64) {
      signal.throwIfAborted()
      const offset = y * geometry.width * 16,
        count = Math.min(64, geometry.height - y) * geometry.width * 16,
        bytes = new Uint8Array(destination.buffer, destination.byteOffset + offset, count)
      await writeHdrStrip(file, bytes, offset, signal)
      digest.update(bytes)
      strips.push({ byteLength: count, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    signal.throwIfAborted()
    // The directory owner publishes only after this descriptor and closed file return.
    const result: HdrWorkingAsset = {
      ...asset,
      width: geometry.width,
      height: geometry.height,
      byteLength,
      sha256: digest.digest('hex'),
      strips,
    }
    delete result.url
    await file.close()
    signal.throwIfAborted()
    complete = true
    return { path: outputPath, asset: result, geometry, reused: false }
  } finally {
    if (!complete) {
      await file.close().catch(() => undefined)
      await rm(outputPath, { force: true })
    }
  }
}
