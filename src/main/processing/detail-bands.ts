import { setImmediate } from 'node:timers/promises'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  detailLuminance,
  spatialDetailSourceBounds,
  spatialDetailTile,
  DETAIL_TILE_EDGE,
  type DetailSize,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../../shared/spatial-detail'
import {
  detailStreamMemoryPlan,
  detailFrameMemoryPlan,
  DETAIL_BAND_ROWS,
  type DetailAdmission,
} from '../../shared/detail-resources'
import type { ColorPrimaries } from '../../shared/color-model'
import { frameByteLength } from '../../shared/preview-frame'
import { createSpatialDetailGpu, type SpatialDetailGpu } from '../gpu/spatial-detail'

export type DetailBackend = 'auto' | 'cpu' | 'gpu'
export interface DetailBandJob extends DetailAdmission {
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
  readonly primaries: ColorPrimaries
  readonly backend: DetailBackend
}
export type DetailBandSource =
  | { readonly kind: 'strips'; readonly values: AsyncIterable<Float32Array> }
  | {
      readonly kind: 'frame'
      readonly data: Float32Array<ArrayBuffer>
      readonly retainOutput: boolean
    }
export interface DetailBandDiagnostics {
  backend: 'identity' | 'cpu' | 'gpu' | 'mixed'
  cpuTiles: number
  gpuTiles: number
  precisionRecoveryTiles: number
  maxSourceStrips: number
  adapter?: string
  fallback?: string
}

/**
 * The source lends immutable, native-width 64-row strips until they leave the
 * three-strip halo window. The consumer finishes a borrowed output band before
 * advancing. Its source lease spans the iterator, GPU retirement and cleanup.
 */
export async function* detailBands(
  image: DetailSize,
  source: DetailBandSource,
  job: DetailBandJob,
  signal: AbortSignal,
  diagnostics: DetailBandDiagnostics,
  makeGpu: () => SpatialDetailGpu = createSpatialDetailGpu,
): AsyncGenerator<Float32Array<ArrayBuffer>> {
  signal.throwIfAborted()
  const frozen = structuredClone(job),
    size = { ...image },
    noise = compileNoiseReduction(frozen.noiseReduction),
    sharp = compileDetailSharpening(frozen.detailSharpening),
    active = noise.active || sharp.active
  if (source.kind !== 'strips' && source.kind !== 'frame')
    throw new Error('Invalid detail band source.')
  const borrowed = source.kind === 'frame' ? source.data : undefined
  if (
    source.kind === 'frame' &&
    (!(borrowed instanceof Float32Array) ||
      !(borrowed.buffer instanceof ArrayBuffer) ||
      borrowed.byteLength !== frameByteLength(size.width, size.height) * 4)
  )
    throw new Error('Invalid borrowed detail source.')
  if (source.kind === 'frame' && !active)
    throw new Error('Neutral detail frames must reuse their source.')
  const memory =
      source.kind === 'frame'
        ? detailFrameMemoryPlan(size, frozen, source.retainOutput, source.data.buffer.byteLength)
        : detailStreamMemoryPlan(size, frozen, active),
    admission = { policy: frozen.policy, reservation: memory.tileReservation }
  detailLuminance(frozen.primaries)
  if (!['auto', 'cpu', 'gpu'].includes(frozen.backend))
    throw new Error('Invalid detail processing backend.')
  if (!memory.cpuAccepted)
    throw new Error('Detail streaming exceeds the frozen managed image budgets.')
  if (active && frozen.backend === 'gpu' && !memory.gpuAccepted)
    throw new Error('Detail GPU streaming exceeds the frozen managed image budgets.')

  const values =
      source.kind === 'strips'
        ? source.values
        : (async function* () {
            for (let y = 0; y < size.height; y += DETAIL_BAND_ROWS)
              yield borrowed!.subarray(y * size.width * 4, (y + DETAIL_BAND_ROWS) * size.width * 4)
          })(),
    iterator = values[Symbol.asyncIterator](),
    strips = new Map<number, Float32Array<ArrayBuffer>>()
  let loadedRows = 0,
    ended = false,
    gpu: SpatialDetailGpu | undefined,
    recoveryCount = 0
  const update = () => {
    diagnostics.backend = !active
      ? 'identity'
      : diagnostics.gpuTiles
        ? diagnostics.cpuTiles
          ? 'mixed'
          : 'gpu'
        : 'cpu'
  }
  const harvestRecoveries = () => {
    const current = gpu?.precisionRecoveryTiles ?? 0,
      delta = current - recoveryCount
    diagnostics.precisionRecoveryTiles += delta
    recoveryCount = current
    return delta
  }
  const loadThrough = async (bottom: number) => {
    while (loadedRows < bottom) {
      signal.throwIfAborted()
      const next = await iterator.next(),
        height = Math.min(DETAIL_BAND_ROWS, size.height - loadedRows)
      signal.throwIfAborted()
      if (
        next.done ||
        !(next.value instanceof Float32Array) ||
        !(next.value.buffer instanceof ArrayBuffer) ||
        next.value.length !== size.width * height * 4
      )
        throw new Error('Incomplete detail source strip.')
      for (let i = 0; i < next.value.length; i++)
        if (
          !Number.isFinite(next.value[i]) ||
          (i % 4 === 3 && (next.value[i] < 0 || next.value[i] > 1))
        )
          throw new Error('Invalid detail source pixels.')
      strips.set(
        loadedRows / DETAIL_BAND_ROWS,
        new Float32Array(next.value.buffer, next.value.byteOffset, next.value.length),
      )
      loadedRows += height
      diagnostics.maxSourceStrips = Math.max(diagnostics.maxSourceStrips, strips.size)
      if (strips.size > 3) throw new Error('The detail source strip window exceeded its bound.')
    }
    if (loadedRows === size.height && !ended) {
      // Advancing the verified disk iterator also checks its whole-source digest.
      const next = await iterator.next()
      signal.throwIfAborted()
      if (!next.done) throw new Error('Unexpected detail source pixels.')
      ended = true
    }
  }
  try {
    if (active && frozen.backend !== 'cpu') {
      if (memory.gpuAccepted) {
        try {
          gpu = makeGpu()
        } catch (error) {
          signal.throwIfAborted()
          if (frozen.backend === 'gpu') throw error
          diagnostics.fallback = String(error)
        }
      } else
        diagnostics.fallback =
          'GPU detail admission was unavailable; using the equivalent CPU operators.'
    }
    if (!active) {
      for (let y = 0; y < size.height; y += DETAIL_BAND_ROWS) {
        strips.clear()
        await loadThrough(Math.min(size.height, y + DETAIL_BAND_ROWS))
        signal.throwIfAborted()
        yield strips.get(y / DETAIL_BAND_ROWS)!
      }
      return
    }
    const band = new Float32Array(size.width * Math.min(DETAIL_BAND_ROWS, size.height) * 4)
    for (let y = 0; y < size.height; y += DETAIL_BAND_ROWS) {
      const height = Math.min(DETAIL_BAND_ROWS, size.height - y),
        firstTile = { left: 0, top: y, width: Math.min(DETAIL_TILE_EDGE, size.width), height },
        vertical = spatialDetailSourceBounds(size, firstTile, noise, sharp)
      for (const index of strips.keys())
        if ((index + 1) * DETAIL_BAND_ROWS <= vertical.top) strips.delete(index)
      await loadThrough(vertical.top + vertical.height)
      for (let x = 0; x < size.width; x += DETAIL_TILE_EDGE) {
        if (!gpu) await setImmediate()
        signal.throwIfAborted()
        const tile = { left: x, top: y, width: Math.min(DETAIL_TILE_EDGE, size.width - x), height },
          bounds = spatialDetailSourceBounds(size, tile, noise, sharp),
          pixels = new Float32Array(bounds.width * bounds.height * 4)
        for (let row = 0; row < bounds.height; row++) {
          const globalY = bounds.top + row,
            stripIndex = Math.floor(globalY / DETAIL_BAND_ROWS),
            strip = strips.get(stripIndex)
          if (!strip) throw new Error('Missing detail source halo.')
          const start = ((globalY % DETAIL_BAND_ROWS) * size.width + bounds.left) * 4
          pixels.set(strip.subarray(start, start + bounds.width * 4), row * bounds.width * 4)
        }
        const window = { ...bounds, data: pixels }
        let result: Float32Array
        if (gpu) {
          try {
            result = await gpu.render(
              { ...frozen, image: size, tile, source: window, admission },
              signal,
            )
            diagnostics.adapter = gpu.adapter
            if (harvestRecoveries()) diagnostics.cpuTiles++
            else diagnostics.gpuTiles++
          } catch (error) {
            signal.throwIfAborted()
            if (frozen.backend === 'gpu') throw error
            diagnostics.fallback = String(error)
            harvestRecoveries()
            await gpu.close()
            gpu = undefined
            recoveryCount = 0
            signal.throwIfAborted()
            await setImmediate()
            signal.throwIfAborted()
            result = spatialDetailTile(size, tile, window, noise, sharp, frozen.primaries)
            diagnostics.cpuTiles++
          }
        } else {
          result = spatialDetailTile(size, tile, window, noise, sharp, frozen.primaries)
          diagnostics.cpuTiles++
        }
        signal.throwIfAborted()
        if (
          !(result instanceof Float32Array) ||
          !(result.buffer instanceof ArrayBuffer) ||
          result.length !== tile.width * height * 4
        )
          throw new Error('Invalid detail tile result.')
        const resultWords = new Uint32Array(result.buffer, result.byteOffset, result.length),
          sourceWords = new Uint32Array(pixels.buffer)
        for (let row = 0; row < height; row++)
          for (let column = 0; column < tile.width; column++) {
            const at = (row * tile.width + column) * 4,
              original = ((y + row - bounds.top) * bounds.width + x + column - bounds.left) * 4
            if (resultWords[at + 3] !== sourceWords[original + 3])
              throw new Error('The detail tile changed source alpha.')
            for (let c = 0; c < 3; c++)
              if (!Number.isFinite(result[at + c])) throw new Error('Invalid detail tile pixels.')
          }
        for (let row = 0; row < height; row++)
          band.set(
            result.subarray(row * tile.width * 4, (row + 1) * tile.width * 4),
            (row * size.width + x) * 4,
          )
      }
      update()
      signal.throwIfAborted()
      yield band.subarray(0, height * size.width * 4)
    }
  } finally {
    try {
      if (gpu) {
        harvestRecoveries()
        await gpu.close()
      }
    } finally {
      try {
        await iterator.return?.()
      } finally {
        strips.clear()
        update()
      }
    }
  }
}
