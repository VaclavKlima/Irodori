import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PreparedSource } from '../src/main/merge/prepare'
import { bandData, mergeReadBytes, resetMergeReads } from '../src/main/merge/sampling'
import { identityTransform } from '../src/main/merge/alignment'
import { nativePlane } from '../src/main/merge/native-plane'
import { mergeReadMeasurements } from '../src/main/merge/read-metrics'
import { verifyMaster, type MasterVerificationMeasurements } from '../src/main/merge/store'
import {
  MERGE_LIMITS,
  MERGE_PIPELINE,
  MERGE_VERSION,
  type MergeManifest,
} from '../src/shared/merge'
import { HDR_SOURCE_VERSION } from '../src/shared/hdr'
import { PROCESSING_METADATA_VERSION } from '../src/shared/lens'
import { unavailableProfile } from '../src/main/processing/metadata'

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

test('master verification attributes disjoint work without changing partial-strip validation or recovery', async () => {
  const f = await sourceFixture(),
    directory = dirname(f.source.path),
    path = join(directory, 'linear.f32'),
    mask = Buffer.from([0, 1, 0, 1, 0, 1]),
    id = 'a'.repeat(64),
    capture = { shutterSeconds: 0.01, iso: 100, aperture: 2.8, focalLength: 9.4 },
    manifest: MergeManifest = {
      version: MERGE_VERSION,
      photo: {
        id,
        assetKind: 'derived',
        filename: 'independent-io-fixture.luma',
        format: 'LUMA HDR',
        bytes: f.bytes.length,
        width: f.source.width,
        height: f.source.height,
        importedAt: '2026-10-17',
        thumbnailUrl: '',
        previewUrl: '',
        previewSource: 'decoded',
      },
      metadata: { version: PROCESSING_METADATA_VERSION, lensProfile: unavailableProfile },
      asset: {
        kind: 'hdr-working-v1',
        width: f.source.width,
        height: f.source.height,
        byteLength: f.bytes.length,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        strips: f.source.strips.map((sha256, index) => ({
          byteLength: Math.min(
            f.source.width * 64 * 16,
            f.bytes.length - index * 64 * f.source.width * 16,
          ),
          sha256,
        })),
        source: {
          version: HDR_SOURCE_VERSION,
          processing: 'hdr-v1',
          colorSpace: 'rec2020',
          whitePoint: 'D65',
          transfer: 'linear',
          alpha: 'straight',
          decoder: MERGE_VERSION,
          cameraProfile: 'independent-io-fixture',
          orientation: 'applied-once',
          composite: { kind: 'noise', sourceCount: 2 },
          normalization: { ...f.source.normalization, gains: [1, 1, 1, 1] },
        },
      },
      recipe: {
        version: MERGE_VERSION,
        pipeline: MERGE_PIPELINE,
        constants: MERGE_LIMITS,
        resolution: 'native',
        width: f.source.width,
        height: f.source.height,
        crop: { left: 0, top: 0, width: f.source.width, height: f.source.height },
        maskDimensions: { width: 3, height: 2 },
        maskSha256: createHash('sha256').update(mask).digest('hex'),
        affectedPercent: 0,
        referenceClippedPercent: 0,
        settings: {
          mode: 'noise',
          referenceId: id,
          autoAlign: false,
          autoCrop: false,
          deghost: false,
          strength: 50,
        },
        sources: [id, 'b'.repeat(64)].map((sourceId) => ({
          id: sourceId,
          filename: 'independent-io-fixture.ARW',
          capture,
          scale: 1,
          transform: identityTransform(),
          decoder: 'independent-io-fixture',
          cameraProfile: 'test',
          lensIdentity: 'none',
        })),
      },
    },
    emptyMeasurements = (): MasterVerificationMeasurements => ({
      readingMs: 0,
      hashingMs: 0,
      pixelValidationMs: 0,
      metadataMs: 0,
      closingMs: 0,
    }),
    assertMeasurements = (measurements: MasterVerificationMeasurements, elapsed: number) => {
      expect(Object.values(measurements)).toHaveLength(5)
      for (const duration of Object.values(measurements)) {
        expect(Number.isFinite(duration)).toBe(true)
        expect(duration).toBeGreaterThan(0)
      }
      expect(
        Object.values(measurements).reduce((total, duration) => total + duration, 0),
      ).toBeLessThanOrEqual(elapsed)
    }
  try {
    await Promise.all([
      writeFile(path, f.bytes),
      writeFile(join(directory, 'motion.mask'), mask),
      writeFile(join(directory, 'thumb.jpg'), 'independent preview presence fixture'),
      writeFile(join(directory, 'preview.jpg'), 'independent preview presence fixture'),
    ])
    const frozen = structuredClone(manifest),
      measurements = emptyMeasurements(),
      started = performance.now()
    await verifyMaster(directory, manifest, measurements)
    assertMeasurements(measurements, performance.now() - started)
    expect(manifest).toEqual(frozen)
    expect(await readFile(path)).toEqual(f.bytes)

    const damaged = Buffer.from(f.bytes)
    damaged[damaged.length - 1] ^= 0xff
    await writeFile(path, damaged)
    const failed = emptyMeasurements(),
      failedStarted = performance.now()
    await expect(verifyMaster(directory, manifest, failed)).rejects.toThrow('Damaged master strip.')
    assertMeasurements(failed, performance.now() - failedStarted)
    await expect(verifyMaster(directory, manifest)).rejects.toThrow('Damaged master strip.')

    await writeFile(path, f.bytes)
    await verifyMaster(directory, manifest)
    expect(await readFile(path)).toEqual(f.bytes)
    expect(manifest).toEqual(frozen)
  } finally {
    await f.close()
  }
})
