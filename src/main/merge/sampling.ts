import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { PreparedSource } from './prepare'
import type { MergeTransform } from '../../shared/merge'
import { warp } from './math'
import { transformMatrix, tileOffset } from './matrix'
import { mergeReadMeasurements, resetMergeReadMeasurements } from './read-metrics'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
let readBytes = 0
type CachedStrip = { source: PreparedSource; row: number; bytes: Buffer }
const strips = new Map<PreparedSource, Map<number, CachedStrip>>()
const recent = new Map<CachedStrip, true>()
let cachedBytes = 0
const cacheLimit = 128 * 1024 ** 2
export function resetMergeReads() {
  readBytes = 0
  resetMergeReadMeasurements()
  strips.clear()
  recent.clear()
  cachedBytes = 0
}
export function mergeReadBytes() {
  return readBytes
}
export function noteMergeRead(bytes: number) {
  readBytes += bytes
}
/** Read a bounded source band covering the inverse-warped output strip. */
export function bandBounds(source: PreparedSource, t: MergeTransform, top: number, rows: number) {
  const ys = [
    warp(0, top, source.width, source.height, t)[1],
    warp(source.width - 1, top, source.width, source.height, t)[1],
    warp(0, top + rows - 1, source.width, source.height, t)[1],
    warp(source.width - 1, top + rows - 1, source.width, source.height, t)[1],
  ]
  const margin = t.tiles ? Math.max(...t.tiles.offsets.map(Math.abs)) : 0
  const first = Math.max(0, Math.floor((Math.min(...ys) - margin) / 64) * 64),
    last = Math.min(source.height - 1, Math.ceil((Math.max(...ys) + 1 + margin) / 64) * 64 - 1)
  return { first, rows: Math.max(0, last - first + 1) }
}
export async function bandData(
  source: PreparedSource,
  t: MergeTransform,
  top: number,
  rows: number,
  staging?: Buffer<ArrayBuffer>,
) {
  const metrics = mergeReadMeasurements().bands,
    { first, rows: count } = bandBounds(source, t, top, rows),
    last = first + count - 1,
    // Every byte is filled from a verified strip before this band is exposed.
    byteLength = count * source.width * 16,
    bytes = staging ? staging.subarray(0, byteLength) : Buffer.allocUnsafe(byteLength),
    cache = strips.get(source) ?? new Map<number, CachedStrip>()
  metrics.requests++
  metrics.peakCacheBytes = Math.max(metrics.peakCacheBytes, cachedBytes)
  if (!staging) metrics.allocatedBytes += bytes.byteLength
  strips.set(source, cache)
  if (bytes.length !== byteLength)
    throw new Error('Source band exceeds its CPU staging allocation.')
  if (!source.strips || source.strips.length !== Math.ceil(source.height / 64))
    throw new Error('Missing source strip checksums.')
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    for (let row = first; row <= last;) {
      const found = cache.get(row)
      if (found) {
        metrics.cacheHits++
        recent.delete(found)
        recent.set(found, true)
        const copying = performance.now()
        found.bytes.copy(bytes, (row - first) * source.width * 16)
        metrics.copyingMs += performance.now() - copying
        row += 64
        continue
      }
      // Coalesce consecutive cache misses into one file read. Each original
      // 64-row checksum is still verified before any pixels are exposed.
      const start = row
      do {
        row += 64
      } while (row <= last && !cache.has(row))
      const end = Math.min(row, source.height, last + 1),
        length = (end - start) * source.width * 16,
        destination = (start - first) * source.width * 16,
        reading = performance.now()
      file ??= await open(source.path, 'r')
      let offset = 0
      while (offset < length) {
        const read = await file.read(
          bytes,
          destination + offset,
          length - offset,
          start * source.width * 16 + offset,
        )
        if (!read.bytesRead) throw new Error('Damaged merge source strip.')
        offset += read.bytesRead
        readBytes += read.bytesRead
        metrics.fileReads++
        metrics.readBytes += read.bytesRead
      }
      metrics.readingMs += performance.now() - reading
      for (let r = start; r < end; r += 64) {
        metrics.cacheMisses++
        const position = (r - first) * source.width * 16,
          view = bytes.subarray(
            position,
            position + Math.min(64, source.height - r) * source.width * 16,
          )
        const hashing = performance.now(),
          digest = hash(view)
        metrics.hashingMs += performance.now() - hashing
        if (digest !== source.strips[r / 64]) throw new Error('Damaged merge source strip.')
        metrics.verifiedBytes += view.byteLength
        if (view.length > cacheLimit) continue
        // Own only the strip bytes: retaining a view would pin the entire band
        // and violate the 128 MiB physical cache bound after eviction.
        let reusable: Buffer | undefined
        while (cachedBytes + view.length > cacheLimit) {
          const oldest = recent.keys().next().value!
          recent.delete(oldest)
          strips.get(oldest.source)?.delete(oldest.row)
          cachedBytes -= oldest.bytes.length
          if (!strips.get(oldest.source)?.size) strips.delete(oldest.source)
          if (oldest.bytes.length === view.length) reusable = oldest.bytes
        }
        const strip = reusable ?? Buffer.allocUnsafe(view.length)
        if (reusable) metrics.reusedStripBuffers++
        else metrics.allocatedBytes += strip.byteLength
        const copying = performance.now()
        view.copy(strip)
        metrics.copyingMs += performance.now() - copying
        const entry = { source, row: r, bytes: strip }
        strips.set(source, cache)
        cache.set(r, entry)
        cachedBytes += strip.length
        metrics.peakCacheBytes = Math.max(metrics.peakCacheBytes, cachedBytes)
        recent.set(entry, true)
      }
    }
  } finally {
    await file?.close()
  }
  const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  return { data, first, rows: last - first + 1 }
}
export async function band(source: PreparedSource, t: MergeTransform, top: number, rows: number) {
  const { data, first } = await bandData(source, t, top, rows),
    m = transformMatrix(t, source.width, source.height)
  return (x: number, y: number, out: number[]) => {
    const w = m[6] * x + m[7] * y + m[8],
      delta = t.tiles ? tileOffset(t, x, y) : [0, 0],
      sx = (m[0] * x + m[1] * y + m[2]) / w + delta[0],
      sy = (m[3] * x + m[4] * y + m[5]) / w + delta[1]
    if (sx < 0 || sy < 0 || sx > source.width - 1 || sy > source.height - 1) return false
    const ix = Math.floor(sx),
      iy = Math.floor(sy),
      dx = sx - ix,
      dy = sy - iy
    out.fill(0)
    out[3] = 1
    for (let yy = 0; yy < 2; yy++)
      for (let xx = 0; xx < 2; xx++) {
        const i =
            ((Math.min(source.height - 1, iy + yy) - first) * source.width +
              Math.min(source.width - 1, ix + xx)) *
            4,
          w = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy)
        if (w === 0) continue
        for (let c = 0; c < 3; c++) out[c] += data[i + c] * w
        if (w > 0 && data[i + 3] < 1) out[3] = 0
      }
    return true
  }
}
