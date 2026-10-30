import type { CropGeometry } from '../../shared/crop'
import { setImmediate } from 'node:timers/promises'
import {
  CROP_TILE_EDGE,
  cropTileSourceBounds,
  resampleCropTile,
  type CropSourceWindow,
} from '../../shared/crop-filter'
import type { CropMemoryPlan } from '../../shared/crop-resources'
import { createCropGpu, type CropGpu } from '../gpu/crop'

export type CropBackend = 'auto' | 'cpu' | 'gpu'
export interface CropBandDiagnostics {
  backend: 'copy' | 'cpu' | 'gpu' | 'mixed'
  adapter?: string
  fallback?: string
  cpuTiles: number
  gpuTiles: number
  precisionRecoveryTiles: number
}

/** One borrowed output band at a time, shared by file and authored-raster adapters. */
export async function* cropBands(
  geometry: CropGeometry,
  source: CropSourceWindow,
  memory: CropMemoryPlan,
  backend: CropBackend,
  signal: AbortSignal,
  diagnostics: CropBandDiagnostics,
  makeGpu: () => Promise<CropGpu> = createCropGpu,
): AsyncGenerator<Float32Array<ArrayBuffer>> {
  signal.throwIfAborted()
  if (!['auto', 'cpu', 'gpu'].includes(backend)) throw new Error('Invalid crop processing backend.')
  if (
    source.left !== 0 ||
    source.top !== 0 ||
    source.width !== geometry.source.width ||
    source.height !== geometry.source.height ||
    source.data.length !== source.width * source.height * 4
  )
    throw new Error('Invalid complete crop source frame.')
  if (!memory.cpuAccepted)
    throw new Error('Crop preparation exceeds the frozen managed image budgets.')
  if (!geometry.pixelAligned && backend === 'gpu' && !memory.gpuAccepted)
    throw new Error('Crop GPU preparation exceeds the frozen managed image budgets.')
  let gpu: CropGpu | undefined
  const update = () => {
    diagnostics.backend = geometry.pixelAligned
      ? 'copy'
      : diagnostics.gpuTiles
        ? diagnostics.cpuTiles
          ? 'mixed'
          : 'gpu'
        : 'cpu'
  }
  try {
    if (!geometry.pixelAligned && backend !== 'cpu') {
      if (memory.gpuAccepted) {
        try {
          gpu = await makeGpu()
          diagnostics.adapter = gpu.adapter
        } catch (error) {
          signal.throwIfAborted()
          if (backend === 'gpu') throw error
          diagnostics.fallback = String(error)
        }
      } else
        diagnostics.fallback =
          'GPU crop admission was unavailable; using the equivalent CPU filter.'
    }
    signal.throwIfAborted()
    const strip = new Float32Array(geometry.width * Math.min(64, geometry.height) * 4)
    for (let y = 0; y < geometry.height; y += 64) {
      const height = Math.min(64, geometry.height - y)
      for (let x = 0; x < geometry.width; x += CROP_TILE_EDGE) {
        if (!gpu) await setImmediate()
        signal.throwIfAborted()
        const tile = {
          left: x,
          top: y,
          width: Math.min(CROP_TILE_EDGE, geometry.width - x),
          height,
        }
        let result: Float32Array
        if (gpu) {
          const bounds = cropTileSourceBounds(geometry, tile),
            pixels = new Float32Array(bounds.width * bounds.height * 4)
          for (let row = 0; row < bounds.height; row++) {
            const start = ((bounds.top + row) * source.width + bounds.left) * 4
            pixels.set(
              source.data.subarray(start, start + bounds.width * 4),
              row * bounds.width * 4,
            )
          }
          try {
            result = await gpu.render(geometry, tile, { ...bounds, data: pixels }, signal)
            diagnostics.gpuTiles++
          } catch (error) {
            signal.throwIfAborted()
            if (backend === 'gpu') throw error
            diagnostics.fallback = String(error)
            diagnostics.precisionRecoveryTiles += gpu.precisionRecoveryTiles
            await gpu.close()
            gpu = undefined
            result = resampleCropTile(geometry, tile, source)
            diagnostics.cpuTiles++
          }
        } else {
          result = resampleCropTile(geometry, tile, source)
          diagnostics.cpuTiles++
        }
        if (!(result instanceof Float32Array) || result.length !== tile.width * tile.height * 4)
          throw new Error('Invalid crop tile result.')
        for (let i = 0; i < result.length; i++)
          if (!Number.isFinite(result[i]) || (i % 4 === 3 && (result[i] < 0 || result[i] > 1)))
            throw new Error('Invalid crop tile pixels.')
        for (let row = 0; row < height; row++)
          strip.set(
            result.subarray(row * tile.width * 4, (row + 1) * tile.width * 4),
            (row * geometry.width + x) * 4,
          )
      }
      update()
      signal.throwIfAborted()
      // The consumer must finish reading this band before requesting the next one.
      yield strip.subarray(0, height * geometry.width * 4)
    }
  } finally {
    if (gpu) {
      diagnostics.precisionRecoveryTiles += gpu.precisionRecoveryTiles
      await gpu.close()
    }
    update()
  }
}
