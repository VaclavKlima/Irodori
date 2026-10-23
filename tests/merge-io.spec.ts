import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PreparedSource } from '../src/main/merge/prepare'
import { bandData, mergeReadBytes, resetMergeReads } from '../src/main/merge/sampling'
import { identityTransform } from '../src/main/merge/alignment'
import { nativePlane } from '../src/main/merge/native-plane'
import { mergeReadMeasurements } from '../src/main/merge/read-metrics'
import {
  recoverMerges,
  verifyMaster,
  type MasterVerificationMeasurements,
} from '../src/main/merge/store'
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

    // A rejected retired publication must keep every recovery byte and journal
    // row, rather than being renamed, published or mistaken for disposable data.
    for (const retiredVersion of [
      'hdr-source-v1',
      'sony-merge-v1',
      'sony-merge-v2',
      'sony-merge-v3',
      'retired-merge-format',
    ]) {
      const retired = structuredClone(manifest),
        unsupportedReason =
          retiredVersion === 'hdr-source-v1'
            ? 'Unsupported HDR capture source version.'
            : 'Unsupported merge version.'
      if (retiredVersion === 'hdr-source-v1')
        Object.assign(retired.asset.source, { version: retiredVersion })
      else {
        Object.assign(retired, { version: retiredVersion })
        Object.assign(retired.recipe, { version: retiredVersion })
      }
      const recoveryRoot = await mkdtemp(join(tmpdir(), 'luma-retired-publication-'))
      let db: DatabaseSync | undefined
      try {
        const stage = join(recoveryRoot, 'merge-publications', id),
          originals = join(recoveryRoot, 'originals'),
          names = ['linear.f32', 'motion.mask', 'thumb.jpg', 'preview.jpg', 'manifest.json'],
          retiredBytes = Buffer.from(JSON.stringify(retired)),
          retiredHash = createHash('sha256').update(retiredBytes).digest('hex')
        await mkdir(stage, { recursive: true })
        await mkdir(originals)
        for (const name of names.slice(0, -1)) await cp(join(directory, name), join(stage, name))
        await writeFile(join(stage, 'manifest.json'), retiredBytes)
        const before = await Promise.all(names.map((name) => readFile(join(stage, name))))
        db = new DatabaseSync(join(recoveryRoot, 'catalog.sqlite'))
        db.exec(
          'CREATE TABLE merge_publications (id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL)',
        )
        db.prepare('INSERT INTO merge_publications VALUES (?, ?)').run(id, retiredHash)
        let publications = 0
        const recover = () =>
          recoverMerges(recoveryRoot, db!, () => {
            publications++
          })
        await expect(verifyMaster(stage, retired)).rejects.toThrow(unsupportedReason)
        expect(await recover()).toEqual([
          {
            id,
            manifestSha256: retiredHash,
            filename: retired.photo.filename,
            reason: expect.stringContaining(unsupportedReason),
          },
        ])
        // Invalid common geometry must fail before a source is opened or staging
        // storage allocated, even when the version itself is unsupported.
        const heldMaster = join(stage, 'linear.held')
        await rename(join(stage, 'linear.f32'), heldMaster)
        try {
          const malformed: Array<(value: MergeManifest) => void> = [
            (value) => {
              value.asset.width = 1.5
              value.recipe.crop.width = 1.5
            },
            (value) => {
              value.asset.height = 0
              value.recipe.crop.height = 0
            },
            (value) => {
              value.asset.byteLength = 2 * 1024 ** 3
            },
            (value) => {
              value.asset.strips[0].sha256 = 'invalid'
            },
            (value) => {
              value.recipe.maskDimensions.width = 0
            },
          ]
          for (const change of malformed) {
            const invalid = structuredClone(retired)
            change(invalid)
            const bytes = Buffer.from(JSON.stringify(invalid))
            await writeFile(join(stage, 'manifest.json'), bytes)
            db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
              createHash('sha256').update(bytes).digest('hex'),
              id,
            )
            await expect(recover()).rejects.toThrow(/dimensions|strip manifest|merge manifest/)
          }
        } finally {
          await rename(heldMaster, join(stage, 'linear.f32'))
          await writeFile(join(stage, 'manifest.json'), retiredBytes)
          db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
            retiredHash,
            id,
          )
        }
        // Correct strip, whole-file and journal hashes cannot excuse NaN pixels.
        const nonfinite = Buffer.from(f.bytes),
          invalidPixels = structuredClone(retired)
        nonfinite.writeFloatLE(NaN, 0)
        invalidPixels.asset.sha256 = createHash('sha256').update(nonfinite).digest('hex')
        for (const [index, strip] of invalidPixels.asset.strips.entries()) {
          const bytes = nonfinite.subarray(
            index * f.source.width * 64 * 16,
            Math.min(f.source.height, (index + 1) * 64) * f.source.width * 16,
          )
          strip.sha256 = createHash('sha256').update(bytes).digest('hex')
        }
        const invalidBytes = Buffer.from(JSON.stringify(invalidPixels))
        await writeFile(join(stage, 'linear.f32'), nonfinite)
        await writeFile(join(stage, 'manifest.json'), invalidBytes)
        db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
          createHash('sha256').update(invalidBytes).digest('hex'),
          id,
        )
        await expect(recover()).rejects.toThrow('Invalid master pixels.')
        await writeFile(join(stage, 'linear.f32'), f.bytes)
        await writeFile(join(stage, 'manifest.json'), retiredBytes)
        db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
          retiredHash,
          id,
        )
        // Unsupported is not a shortcut around any actual byte/provenance check.
        const pixelDamage = Buffer.from(f.bytes)
        pixelDamage[pixelDamage.length - 1] ^= 0xff
        await writeFile(join(stage, 'linear.f32'), pixelDamage)
        await expect(recover()).rejects.toThrow('Damaged master strip.')
        await writeFile(join(stage, 'linear.f32'), f.bytes)
        const oversizedMask = await open(join(stage, 'motion.mask'), 'r+')
        try {
          // Actual sparse filesystem length exceeds both the admitted mask and
          // a hash strip. Metadata must reject it before a full-file allocation.
          await oversizedMask.truncate(64 * 1024 ** 2 + 1)
        } finally {
          await oversizedMask.close()
        }
        await expect(recover()).rejects.toThrow('Damaged merge mask.')
        await writeFile(join(stage, 'motion.mask'), mask.subarray(0, mask.length - 1))
        await expect(recover()).rejects.toThrow('Damaged merge mask.')
        await writeFile(join(stage, 'motion.mask'), Buffer.alloc(mask.length, 7))
        await expect(recover()).rejects.toThrow('Damaged merge mask.')
        await writeFile(join(stage, 'motion.mask'), mask)
        const malformed = structuredClone(retired)
        malformed.asset.source.normalization.referenceWhite = 0
        const malformedBytes = Buffer.from(JSON.stringify(malformed))
        await writeFile(join(stage, 'manifest.json'), malformedBytes)
        db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
          createHash('sha256').update(malformedBytes).digest('hex'),
          id,
        )
        await expect(recover()).rejects.toThrow('Invalid HDR source provenance.')
        const currentBytes = Buffer.from(JSON.stringify(manifest))
        await writeFile(join(stage, 'manifest.json'), currentBytes)
        db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
          createHash('sha256').update(currentBytes).digest('hex'),
          id,
        )
        await writeFile(join(stage, 'linear.f32'), pixelDamage)
        await expect(recover()).rejects.toThrow('Damaged master strip.')
        await writeFile(join(stage, 'linear.f32'), f.bytes)
        await writeFile(join(stage, 'manifest.json'), retiredBytes)
        db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
          retiredHash,
          id,
        )
        expect(await recover()).toHaveLength(1)
        expect(publications).toBe(0)
        expect(db.prepare('SELECT id, manifest_sha256 FROM merge_publications').all()).toEqual([
          { id, manifest_sha256: retiredHash },
        ])
        expect(await readdir(originals)).toEqual([])
        expect((await readdir(stage)).sort()).toEqual([...names].sort())
        expect(await Promise.all(names.map((name) => readFile(join(stage, name))))).toEqual(before)
        expect(await readFile(path)).toEqual(f.bytes)
        expect(manifest).toEqual(frozen)
      } finally {
        db?.close()
        await rm(recoveryRoot, { recursive: true, force: true })
      }
    }
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
