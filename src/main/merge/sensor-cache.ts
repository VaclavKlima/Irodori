import { createHash } from 'node:crypto'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RawSource } from '../gpu/raw-source'
import type { CorrectionPlan } from '../processing/lens-correction'
import { MERGE_LIMITS } from '../../shared/merge'
import { noteMergeRead } from './sampling'
import { mergeReadMeasurements } from './read-metrics'

interface BinaryPlane {
  path: string
  sha256: string
  bytes: number
}
export interface SensorCache {
  version: 'sony-sensor-u16le-v1'
  raw: Omit<RawSource, 'pixels'>
  gains: number[]
  correction: Omit<CorrectionPlan, 'lut'>
  sensor: BinaryPlane
  alpha: BinaryPlane
  lens: BinaryPlane
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function packedBits(mask: Uint8Array) {
  const bits = new Uint32Array(Math.ceil(mask.length / 32))
  for (let i = 0; i < mask.length; i++) if (mask[i]) bits[i >>> 5] |= 1 << (i & 31)
  return bits
}
export async function saveSensorCache(
  directory: string,
  index: number,
  raw: RawSource,
  gains: number[],
  correction: CorrectionPlan,
  alpha: Uint32Array<ArrayBuffer>,
): Promise<SensorCache> {
  // The supported worker platforms are little endian; the on-disk format is explicit.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1)
    throw new Error('Sensor cache requires a little-endian worker.')
  const write = async (suffix: string, data: ArrayBufferView<ArrayBuffer>) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      path = join(directory, `source-${index}.${suffix}`)
    await writeFile(path, bytes)
    return { path, bytes: bytes.length, sha256: hash(bytes) }
  }
  const { pixels, ...metadata } = raw,
    { lut, ...plan } = correction
  return {
    version: 'sony-sensor-u16le-v1',
    raw: metadata,
    gains: [...gains],
    correction: plan,
    sensor: await write('sensor', pixels),
    alpha: await write('alpha', alpha),
    lens: await write('lens', lut),
  }
}
/** Validate review-owned paths and metadata before any GPU allocation. */
export async function validateSensorCache(
  cache: SensorCache,
  directory: string,
  index: number,
  width: number,
  height: number,
) {
  const r = cache.raw,
    p = cache.correction,
    finite = (a: number[] | undefined, length: number) =>
      Array.isArray(a) && a.length === length && a.every(Number.isFinite),
    natural = (v: number) => Number.isSafeInteger(v) && v >= 0
  if (
    cache.version !== 'sony-sensor-u16le-v1' ||
    ![r.width, r.height, r.rawWidth, r.left, r.top, r.flip, p.width, p.height, p.left, p.top].every(
      natural,
    ) ||
    !r.width ||
    !r.height ||
    r.width * r.height > MERGE_LIMITS.maxPixels ||
    !p.width ||
    !p.height ||
    r.flip > 7 ||
    r.left + r.width > r.rawWidth ||
    p.left + p.width > r.width ||
    p.top + p.height > r.height ||
    width !== (r.flip & 4 ? p.height : p.width) ||
    height !== (r.flip & 4 ? p.width : p.height) ||
    !finite(r.black, 4) ||
    !finite(r.scale, 4) ||
    r.scale.some((v) => v <= 0) ||
    !finite(r.matrix, 12) ||
    !finite(r.cfa, 4) ||
    r.cfa.some((v) => !natural(v) || v > 3) ||
    !finite(cache.gains, 3) ||
    cache.gains.some((v) => v <= 0) ||
    !finite(r.normalization?.gains, 4) ||
    r.normalization!.gains.some((v) => v <= 0) ||
    !finite(r.normalization?.sourceSaturation?.thresholds, 4) ||
    cache.sensor.bytes % 2 ||
    cache.sensor.bytes < (r.top + r.height) * r.rawWidth * 2 ||
    cache.sensor.bytes > 512 * 1024 ** 2 ||
    cache.alpha.bytes !== Math.ceil((width * height) / 32) * 4 ||
    cache.lens.bytes !== 4096 * 16
  )
    throw new Error('Invalid merge sensor cache.')
  for (const [plane, suffix] of [
    [cache.sensor, 'sensor'],
    [cache.alpha, 'alpha'],
    [cache.lens, 'lens'],
  ] as const)
    if (
      plane.path !== join(directory, `source-${index}.${suffix}`) ||
      !/^[a-f0-9]{64}$/.test(plane.sha256) ||
      (await stat(plane.path)).size !== plane.bytes
    )
      throw new Error('Invalid merge sensor cache.')
}
export async function readSensorCache(cache: SensorCache) {
  const metrics = mergeReadMeasurements().sensors
  const read = async (p: BinaryPlane) => {
    const reading = performance.now()
    const bytes = await readFile(p.path)
    metrics.readingMs += performance.now() - reading
    metrics.files++
    metrics.readBytes += bytes.length
    noteMergeRead(bytes.length)
    const hashing = performance.now(),
      digest = hash(bytes)
    metrics.hashingMs += performance.now() - hashing
    if (bytes.length !== p.bytes || digest !== p.sha256)
      throw new Error('Damaged merge sensor cache.')
    metrics.verifiedBytes += bytes.length
    return bytes
  }
  const bytes = await read(cache.sensor),
    alpha = await read(cache.alpha),
    lens = await read(cache.lens)
  return {
    raw: {
      ...cache.raw,
      pixels: new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2),
    },
    alpha: new Uint32Array(alpha.buffer, alpha.byteOffset, alpha.length / 4),
    correction: {
      ...cache.correction,
      lut: new Float32Array(lens.buffer, lens.byteOffset, lens.length / 4),
    },
  }
}
