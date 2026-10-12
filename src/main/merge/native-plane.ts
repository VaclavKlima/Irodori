import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { PreparedSource } from './prepare'
import type { MergeTransform } from '../../shared/merge'
import { bandBounds, noteMergeRead } from './sampling'

// Two maximum-size luminance planes fit within 192 MiB. The alignment worker
// owns this immutable cache and releases it when its review terminates.
const cache = new Map<PreparedSource, Float32Array>()
const limit = 192 * 1024 ** 2
let bytes = 0
export async function nativePlane(source: PreparedSource, checkpoint: () => Promise<void>) {
  const found = cache.get(source)
  if (found) {
    cache.delete(source)
    cache.set(source, found)
    return found
  }
  const plane = new Float32Array(source.width * source.height),
    file = await open(source.path, 'r')
  try {
    if ((await file.stat()).size !== plane.length * 16)
      throw new Error('Damaged merge source dimensions.')
    for (let top = 0; top < source.height; top += 64) {
      await checkpoint()
      const strip = Buffer.alloc(source.width * Math.min(64, source.height - top) * 16)
      let offset = 0
      while (offset < strip.length) {
        const read = await file.read(
          strip,
          offset,
          strip.length - offset,
          top * source.width * 16 + offset,
        )
        if (!read.bytesRead) throw new Error('Damaged merge source strip.')
        offset += read.bytesRead
        noteMergeRead(read.bytesRead)
      }
      if (createHash('sha256').update(strip).digest('hex') !== source.strips[top / 64])
        throw new Error('Damaged merge source strip.')
      const rgba = new Float32Array(strip.buffer, strip.byteOffset, strip.byteLength / 4)
      const channel = source.registrationChannel
      if (channel !== undefined && (!Number.isInteger(channel) || channel < 0 || channel > 2))
        throw new Error('Invalid camera registration channel.')
      for (let k = 0; k < rgba.length / 4; k++) {
        if (
          channel !== undefined &&
          (!Number.isInteger(rgba[k * 4 + 3]) ||
            rgba[k * 4 + 3] < 0 ||
            rgba[k * 4 + 3] > 7 ||
            !Number.isFinite(rgba[k * 4 + channel]))
        )
          throw new Error('Damaged native camera registration sample.')
        plane[top * source.width + k] =
          channel === undefined
            ? rgba[k * 4 + 3] > 0
              ? rgba[k * 4] * 0.2627 + rgba[k * 4 + 1] * 0.678 + rgba[k * 4 + 2] * 0.0593
              : NaN
            : rgba[k * 4 + 3] & (1 << channel)
              ? rgba[k * 4 + channel]
              : NaN
      }
    }
  } finally {
    await file.close()
  }
  while (bytes + plane.byteLength > limit && cache.size) {
    const oldest = cache.keys().next().value!,
      entry = cache.get(oldest)!
    bytes -= entry.byteLength
    cache.delete(oldest)
  }
  cache.set(source, plane)
  bytes += plane.byteLength
  return plane
}
export async function nativeBand(
  source: PreparedSource,
  transform: MergeTransform,
  top: number,
  rows: number,
  checkpoint: () => Promise<void>,
) {
  const plane = await nativePlane(source, checkpoint),
    bounds = bandBounds(source, transform, top, rows)
  return {
    ...bounds,
    data: plane.subarray(bounds.first * source.width, (bounds.first + bounds.rows) * source.width),
  }
}
