import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreparedSource } from '../src/main/merge/prepare'
import { bandData, mergeReadBytes, resetMergeReads } from '../src/main/merge/sampling'
import { identityTransform } from '../src/main/merge/alignment'
import { nativePlane } from '../src/main/merge/native-plane'
import { mergeReadMeasurements } from '../src/main/merge/read-metrics'

async function sourceFixture(width = 13, height = 139, channel?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'luma-merge-io-')),
    path = join(directory, 'source.f32'),
    rgba = new Float32Array(width * height * 4)
  for (let i = 0; i < width * height; i++)
    rgba.set(
      [i / 17 - 4, (i % 31) / 29, -(i % 7) / 19, channel === undefined ? Number(i % 5 > 0) : i % 8],
      i * 4,
    )
  const bytes = Buffer.from(rgba.buffer)
  await writeFile(path, bytes)
  const source: PreparedSource = {
    path,
    width,
    height,
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, strip) =>
      createHash('sha256')
        .update(bytes.subarray(strip * 64 * width * 16, (strip + 1) * 64 * width * 16))
        .digest('hex'),
    ),
    plane: { width: 1, height: 1, data: new Float32Array(1) },
    decoder: 'independent-io-fixture',
    cameraProfile: 'test',
    normalization: {
      black: [0, 0, 0, 0],
      maximum: 1,
      gains: [1, 1, 1, 1],
      restoreGain: 1,
      referenceWhite: 1,
      sourceSaturation: null,
    },
    registrationChannel: channel,
  }
  return { source, rgba, bytes, close: () => rm(directory, { recursive: true, force: true }) }
}

test.beforeEach(() => resetMergeReads())

test('verified bands coalesce misses and preserve signed pixels and the partial final strip', async () => {
  const f = await sourceFixture()
  try {
    const staging = Buffer.allocUnsafe(f.bytes.length),
      result = await bandData(f.source, identityTransform(), 0, f.source.height, staging)
    expect(result.data).toEqual(f.rgba)
    const first = structuredClone(mergeReadMeasurements().bands)
    expect(first).toMatchObject({
      requests: 1,
      cacheMisses: 3,
      fileReads: 1,
      readBytes: f.bytes.length,
      verifiedBytes: f.bytes.length,
      allocatedBytes: f.bytes.length,
    })
    staging.fill(0x67)
    expect(
      (await bandData(f.source, identityTransform(), 0, f.source.height, staging)).data,
    ).toEqual(f.rgba)
    expect(mergeReadBytes()).toBe(f.bytes.length)
    expect(mergeReadMeasurements().bands).toMatchObject({
      requests: 2,
      cacheHits: 3,
      cacheMisses: 3,
      verifiedBytes: f.bytes.length,
    })
  } finally {
    await f.close()
  }
})

test('reusing staging for another band cannot overwrite verified cached strips', async () => {
  const f = await sourceFixture()
  try {
    const staging = Buffer.allocUnsafe(f.source.width * 64 * 16)
    for (const top of [0, 64, 0]) {
      const result = await bandData(f.source, identityTransform(), top, 63, staging)
      expect(result.data).toEqual(
        f.rgba.subarray(top * f.source.width * 4, (top + 64) * f.source.width * 4),
      )
    }
    expect(mergeReadMeasurements().bands).toMatchObject({ cacheHits: 1, cacheMisses: 2 })
    await expect(
      bandData(f.source, identityTransform(), 0, f.source.height, staging),
    ).rejects.toThrow('CPU staging allocation')
  } finally {
    await f.close()
  }
})

test('native luminance uses one bounded strip buffer and keeps immutable planes across attempts', async () => {
  const f = await sourceFixture()
  try {
    const expected = Float32Array.from({ length: f.source.width * f.source.height }, (_, i) =>
      f.rgba[i * 4 + 3]
        ? f.rgba[i * 4] * 0.2627 + f.rgba[i * 4 + 1] * 0.678 + f.rgba[i * 4 + 2] * 0.0593
        : NaN,
    )
    const plane = await nativePlane(f.source, async () => {})
    expect(plane).toEqual(expected)
    expect(mergeReadMeasurements().nativePlanes).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      readBytes: f.bytes.length,
      verifiedBytes: f.bytes.length,
      stripBufferBytes: f.source.width * 64 * 16,
      allocatedBytes: plane.byteLength + f.source.width * 64 * 16,
    })
    resetMergeReads()
    expect(await nativePlane(f.source, async () => {})).toBe(plane)
    expect(mergeReadMeasurements().nativePlanes).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      readBytes: 0,
      verifiedBytes: 0,
      allocatedBytes: 0,
    })
  } finally {
    await f.close()
  }
})

test('native camera evidence retains its selected channel and per-channel validity', async () => {
  const f = await sourceFixture(11, 131, 2)
  try {
    expect(await nativePlane(f.source, async () => {})).toEqual(
      Float32Array.from({ length: f.source.width * f.source.height }, (_, i) =>
        f.rgba[i * 4 + 3] & 4 ? f.rgba[i * 4 + 2] : NaN,
      ),
    )
    await expect(
      nativePlane({ ...f.source, registrationChannel: 3 }, async () => {}),
    ).rejects.toThrow('Invalid camera registration channel')
  } finally {
    await f.close()
  }
})

test('a corrupt partial native strip never publishes a plane and can be repaired before retry', async () => {
  const f = await sourceFixture()
  try {
    const file = await open(f.source.path, 'r+')
    try {
      await file.write(Buffer.from([f.bytes.at(-1)! ^ 0xff]), 0, 1, f.bytes.length - 1)
    } finally {
      await file.close()
    }
    await expect(nativePlane(f.source, async () => {})).rejects.toThrow(
      'Damaged merge source strip',
    )
    expect(mergeReadMeasurements().nativePlanes.verifiedBytes).toBe(f.source.width * 128 * 16)
    await writeFile(f.source.path, f.bytes)
    resetMergeReads()
    await nativePlane(f.source, async () => {})
    expect(mergeReadMeasurements().nativePlanes).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      verifiedBytes: f.bytes.length,
    })
  } finally {
    await f.close()
  }
})
