import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { CROP_GEOMETRY_VERSION, cropGeometry, type CropSettings } from '../../shared/crop'
import { CROP_FILTER_VERSION } from '../../shared/crop-filter'
import {
  cropMemoryPlan,
  type CropAdmission,
  type CropMemoryPlan,
} from '../../shared/crop-resources'
import type { HdrWorkingAsset } from '../../shared/hdr'
import { createCropGpu, type CropGpu } from '../gpu/crop'
import { readHdrStrips } from './hdr-processing'
import { writeHdrStrip } from './write-hdr-strip'
import { prepareIntegerCrop, type CroppedWorkingAsset } from './crop-working'
import { cropBands, type CropBandDiagnostics } from './crop-bands'

export interface CropPreparationJob extends CropAdmission {
  readonly asset: HdrWorkingAsset
  readonly settings: CropSettings
  readonly backend: 'auto' | 'cpu' | 'gpu'
}
export interface CropPreparationResult extends CroppedWorkingAsset {
  readonly geometryVersion: typeof CROP_GEOMETRY_VERSION
  readonly filterVersion: typeof CROP_FILTER_VERSION | 'native-copy-v1'
  readonly backend: 'identity' | 'copy' | 'cpu' | 'gpu' | 'mixed'
  readonly adapter?: string
  readonly fallback?: string
  readonly memory: CropMemoryPlan
  readonly cpuTiles: number
  readonly gpuTiles: number
  readonly precisionRecoveryTiles: number
}
export interface CropPreparationProgress {
  phase: 'source' | 'output'
  completed: number
  total: number
}

/** Prepared pixels are loaded once into admitted RAM; output is streamed in 64-row bands. */
export async function prepareCropWorkingAsset(
  sourcePath: string,
  job: CropPreparationJob,
  outputPath: string,
  signal: AbortSignal,
  progress?: (value: CropPreparationProgress) => void | Promise<void>,
  makeGpu: () => Promise<CropGpu> = createCropGpu,
): Promise<CropPreparationResult> {
  signal.throwIfAborted()
  const frozen = structuredClone(job),
    { asset, settings } = frozen,
    geometry = cropGeometry(asset, settings),
    memory = cropMemoryPlan(geometry, frozen)
  if (!['auto', 'cpu', 'gpu'].includes(frozen.backend))
    throw new Error('Invalid crop processing backend.')
  if (!memory.cpuAccepted)
    throw new Error('Crop preparation exceeds the frozen managed image budgets.')
  const base = {
    geometryVersion: CROP_GEOMETRY_VERSION,
    filterVersion: 'native-copy-v1' as const,
    memory,
    cpuTiles: 0,
    gpuTiles: 0,
    precisionRecoveryTiles: 0,
  } as const
  if (geometry.identity)
    return { ...base, path: sourcePath, asset, geometry, reused: true, backend: 'identity' }
  if (geometry.pixelAligned) {
    const destination = new Float32Array(geometry.width * geometry.height * 4),
      result = await prepareIntegerCrop(
        sourcePath,
        asset,
        settings,
        outputPath,
        signal,
        destination,
        (completed, total) => progress?.({ phase: 'source', completed, total }),
      )
    return { ...base, ...result, backend: 'copy' }
  }
  if (frozen.backend === 'gpu' && !memory.gpuAccepted)
    throw new Error('Crop GPU preparation exceeds the frozen managed image budgets.')
  const file = await open(outputPath, 'wx')
  let complete = false
  const diagnostics: CropBandDiagnostics = {
    backend: 'cpu',
    cpuTiles: 0,
    gpuTiles: 0,
    precisionRecoveryTiles: 0,
  }
  try {
    signal.throwIfAborted()
    const data = new Float32Array(asset.width * asset.height * 4)
    let top = 0
    for await (const strip of readHdrStrips(sourcePath, asset)) {
      signal.throwIfAborted()
      data.set(strip, top * asset.width * 4)
      top += strip.length / (asset.width * 4)
      await progress?.({ phase: 'source', completed: top, total: asset.height })
    }
    signal.throwIfAborted()
    if (top !== asset.height) throw new Error('Incomplete crop preparation source.')
    const source = { left: 0, top: 0, width: asset.width, height: asset.height, data },
      digest = createHash('sha256'),
      strips: HdrWorkingAsset['strips'] = []
    let y = 0
    for await (const strip of cropBands(
      geometry,
      source,
      memory,
      frozen.backend,
      signal,
      diagnostics,
      makeGpu,
    )) {
      const bytes = new Uint8Array(strip.buffer, strip.byteOffset, strip.byteLength)
      await writeHdrStrip(file, bytes, y * geometry.width * 16, signal)
      digest.update(bytes)
      strips.push({
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      y += strip.length / (geometry.width * 4)
      await progress?.({ phase: 'output', completed: y, total: geometry.height })
    }
    signal.throwIfAborted()
    const resultAsset: HdrWorkingAsset = {
      ...asset,
      width: geometry.width,
      height: geometry.height,
      byteLength: geometry.width * geometry.height * 16,
      sha256: digest.digest('hex'),
      strips,
    }
    delete resultAsset.url
    await file.close()
    signal.throwIfAborted()
    complete = true
    return {
      path: outputPath,
      asset: resultAsset,
      geometry,
      reused: false,
      geometryVersion: CROP_GEOMETRY_VERSION,
      filterVersion: CROP_FILTER_VERSION,
      memory,
      ...diagnostics,
    }
  } finally {
    if (!complete) {
      await file.close().catch(() => undefined)
      await rm(outputPath, { force: true })
    }
  }
}
