import { test, expect } from '@playwright/test'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewProcess } from '../src/main/preview-process'
import { PreviewEngine } from '../src/main/preview-engine'
import { MergeReviews } from '../src/main/merge/reviews'
import { MERGE_VERSION, type MergeManifest } from '../src/shared/merge'
import { syntheticMerge } from './merge.helpers'
import { verifyMaster } from '../src/main/merge/store'
import { WorkScheduler } from '../src/main/work-scheduler'

test('closing a queued merge inspection cancels admission and releases source pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-merge-queued-'))
  const scheduler = new WorkScheduler()
  let inspected = false
  const reviews = new MergeReviews(
    root,
    async () => {
      inspected = true
      throw new Error('Queued inspection must not start')
    },
    undefined,
    scheduler,
  )
  const ids = ['a'.repeat(64), 'b'.repeat(64)]
  try {
    scheduler.activity('visible edit', true)
    const creating = reviews.create(ids, 'noise')
    const cancelled = expect(creating).rejects.toThrow()
    expect(reviews.leased(ids)).toBe(true)
    await reviews.close()
    await cancelled
    expect(inspected).toBe(false)
    expect(reviews.leased(ids)).toBe(false)
    expect(reviews.active()).toBeNull()
    scheduler.activity('visible edit', false)
    await scheduler.background(async () => {}, new AbortController().signal)
  } finally {
    scheduler.close()
    await reviews.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const version of ['sony-merge-v1', 'sony-merge-v2', 'sony-merge-v3', MERGE_VERSION] as const)
  test(`${version} journal recovery preserves derived master, neutral history, fixed lens and source-independent previews`, async () => {
    const f = await syntheticMerge([0.25, 1, 4]),
      root = await mkdtemp(join(tmpdir(), 'luma-merge-library-')),
      id = 'a'.repeat(64)
    const make = () =>
      new PhotoLibrary(
        root,
        new PreviewEngine(),
        () => {},
        undefined,
        async (path) => {
          await rename(path, join(root, 'test-trash'))
        },
      )
    let library = make()
    try {
      await library.open()
      await library.close()
      const stage = join(root, 'merge-publications', id)
      await mkdir(stage, { recursive: true })
      for (const name of ['linear.f32', 'motion.mask', 'thumb.jpg', 'preview.jpg'])
        await cp(join(f.output, name), join(stage, name))
      const manifest: MergeManifest = {
        version,
        asset: f.result.asset,
        recipe: f.result.recipe,
        metadata: f.sources[1].metadata,
        photo: {
          ...f.sources[1].photo,
          id,
          assetKind: 'derived',
          filename: 'Result.luma',
          format: 'LUMA HDR',
          bytes: f.result.asset.byteLength,
          importedAt: new Date().toISOString(),
        },
      }
      manifest.recipe.version = version
      manifest.asset.source.decoder = version
      if (version === 'sony-merge-v1') {
        delete manifest.recipe.alignment
        for (const source of manifest.recipe.sources) delete source.transform.matrix
      }
      const json = JSON.stringify(manifest)
      await writeFile(join(stage, 'manifest.json'), json)
      const db = new DatabaseSync(join(root, 'catalog.sqlite'))
      db.prepare('INSERT INTO merge_publications VALUES (?, ?)').run(
        id,
        createHash('sha256').update(json).digest('hex'),
      )
      db.close()
      library = make()
      await library.open()
      expect(library.list().photos[0].assetKind).toBe('derived')
      expect((await library.getMergeProvenance(id)).reproducible).toBe(false)
      const initial = await library.getEdits(id)
      expect(initial.settings).toMatchObject({
        processing: 'hdr-v1',
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
      })
      expect(initial.referenceWhiteBalance).toBe(true)
      await expect(library.updateEdits(id, { lens: { distortion: true } }, 0)).rejects.toThrow(
        'fixed',
      )
      await library.updateEdits(id, { exposureEv: 1 }, 0)
      await library.undoEdit(id, 1)
      const options = (
        library as unknown as {
          processingOptions: (id: string) => Promise<import('../src/shared/lens').ProcessingOptions>
        }
      ).processingOptions(id)
      const worker = new PreviewProcess(resolve('out/main/preview-worker.js')),
        output = join(root, 'test-preview')
      await mkdir(output)
      try {
        const result = await worker.renderFull(
          join(root, 'originals', id, 'linear.f32'),
          output,
          new AbortController().signal,
          await options,
        )
        expect(result.width).toBe(f.result.asset.width)
      } finally {
        await worker.close()
      }
      await library.close()
      await rm(join(root, 'cache'), { recursive: true, force: true })
      library = make()
      await library.open()
      expect((await library.getEdits(id)).revision).toBe(2)
      expect(await readFile(join(root, 'originals', id, 'linear.f32'))).toEqual(
        await readFile(join(f.output, 'linear.f32')),
      )
      const task = library.deletePhotos([id])!
      await expect
        .poll(() => library.listTasks().find((t) => t.id === task)?.status)
        .toBe('completed')
      expect(library.list().total).toBe(0)
      expect((await readFile(join(root, 'test-trash', 'linear.f32'))).length).toBeGreaterThan(0)
    } finally {
      await library.close()
      await f.close()
      await rm(root, { recursive: true, force: true })
    }
  })
test('review leases, strict compatibility and stale revisions are enforced before worker preparation', async () => {
  const f = await syntheticMerge([1, 1]),
    reviews = new MergeReviews(f.directory, async (id) => ({
      source: f.sources.find((s) => s.photo.id === id)!,
      path: 'unused',
    }))
  try {
    const ids = f.sources.map((s) => s.photo.id),
      r = await reviews.create(ids, 'noise')
    expect(reviews.leased(ids)).toBe(true)
    await expect(reviews.update(r.id, 1, r.settings)).rejects.toThrow('Stale')
    expect(() => reviews.accept(r.id, 0)).toThrow('Wait')
    const next = await reviews.update(r.id, 0, { ...r.settings, strength: 0 })
    expect(next.revision).toBe(1)
    await expect(reviews.preview(r.id, 0)).rejects.toThrow('Stale')
    await reviews.dispose(r.id)
    expect(reviews.leased(ids)).toBe(false)
    await expect(reviews.create([ids[0], ids[0]], 'noise')).rejects.toThrow('Duplicate')
  } finally {
    await reviews.close()
    await f.close()
  }
})
test('native review renders once per revision and publishes the exact reviewed master', async () => {
  const f = await syntheticMerge([1, 1], { comparisons: true }),
    reviews = new MergeReviews(f.directory, async (id) => ({
      source: f.sources.find((s) => s.photo.id === id)!,
      path: 'unused',
    }))
  let calls = 0,
    release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  reviews.worker.run = async (job) => {
    calls++
    expect(job.comparisons).toBe(true)
    expect(job).not.toHaveProperty('preview')
    await wait
    await cp(f.output, job.output, { recursive: true })
    return structuredClone(f.result)
  }
  try {
    const review = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    const requests = [reviews.preview(review.id, 0), reviews.preview(review.id, 0)]
    await expect.poll(() => calls).toBe(1)
    expect(reviews.diagnostics(review.id, 0).status).toBe('pending')
    expect(() => reviews.accept(review.id, 0)).toThrow('Wait')
    release()
    const [preview, same] = await Promise.all(requests)
    expect(same).toEqual(preview)
    expect(preview.width).toBe(f.result.asset.width)
    expect(preview.height).toBe(f.result.asset.height)
    expect(Object.keys(preview).sort()).toEqual([
      'height',
      'overlayUrl',
      'recipe',
      'referenceUrl',
      'resultUrl',
      'reviewId',
      'revision',
      'width',
    ])
    const sharp = (await import('sharp')).default
    for (const name of ['result', 'reference', 'overlay']) {
      const path = reviews.imagePath([review.id, '0', name])!
      expect(await sharp(path).metadata()).toMatchObject({
        width: preview.width,
        height: preview.height,
      })
    }
    for (const name of ['native-result', 'final-result', '../result'])
      expect(reviews.imagePath([review.id, '0', name])).toBeUndefined()
    await reviews.preview(review.id, 0)
    expect(calls).toBe(1)
    const next = await reviews.update(review.id, 0, { ...review.settings, strength: 25 })
    expect(reviews.imagePath([review.id, '0', 'result'])).toBeUndefined()
    await expect(reviews.preview(review.id, 0)).rejects.toThrow('Stale')
    const updated = await reviews.preview(review.id, next.revision)
    expect(calls).toBe(2)
    expect(updated.recipe.resolution).toBe('native')
    const accepted = reviews.accept(review.id, next.revision)
    const { result, output } = await accepted.render(new AbortController().signal)
    expect(result.asset.sha256).toBe(f.result.asset.sha256)
    expect(await readFile(join(output, 'linear.f32'))).toEqual(
      await readFile(join(f.output, 'linear.f32')),
    )
    expect(calls).toBe(2)
    const abort = new AbortController()
    abort.abort()
    await expect(accepted.render(abort.signal)).rejects.toThrow()
    await reviews.dispose(review.id, true)
    expect(reviews.leased(f.sources.map((s) => s.photo.id))).toBe(false)
  } finally {
    release()
    await reviews.close()
    await f.close()
  }
})

test('revision changes and closing cancel pending native work without publishing stale assets', async () => {
  const f = await syntheticMerge([1, 1]),
    reviews = new MergeReviews(f.directory, async (id) => ({
      source: f.sources.find((s) => s.photo.id === id)!,
      path: 'unused',
    }))
  let calls = 0,
    cancelled = 0
  reviews.worker.run = (_job, signal) => {
    calls++
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled++
          reject(new Error('Native work cancelled.'))
        },
        { once: true },
      )
    })
  }
  try {
    const review = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    const first = expect(reviews.preview(review.id, 0)).rejects.toThrow('cancelled')
    await expect.poll(() => calls).toBe(1)
    const next = await reviews.update(review.id, 0, { ...review.settings, strength: 25 })
    await first
    expect(cancelled).toBe(1)
    expect(reviews.diagnostics(review.id, next.revision).status).toBe('pending')
    const second = expect(reviews.preview(review.id, next.revision)).rejects.toThrow('cancelled')
    await expect.poll(() => calls).toBe(2)
    await reviews.dispose(review.id)
    await second
    expect(cancelled).toBe(2)
    expect(reviews.active()).toBeNull()
    expect(reviews.imagePath([review.id, String(next.revision), 'result'])).toBeUndefined()
  } finally {
    await reviews.close()
    await f.close()
  }
})
test('damaged masters and masks fail validation before publication', async () => {
  const f = await syntheticMerge([1, 1])
  try {
    const manifest: MergeManifest = {
      version: MERGE_VERSION,
      asset: f.result.asset,
      recipe: f.result.recipe,
      metadata: f.sources[0].metadata,
      photo: { ...f.sources[0].photo, assetKind: 'derived' },
    }
    await verifyMaster(f.output, manifest)
    const original = await readFile(join(f.output, 'linear.f32')),
      updatePixels = async (bytes: Buffer) => {
        await writeFile(join(f.output, 'linear.f32'), bytes)
        manifest.asset.sha256 = createHash('sha256').update(bytes).digest('hex')
        let offset = 0
        for (const strip of manifest.asset.strips) {
          strip.sha256 = createHash('sha256')
            .update(bytes.subarray(offset, offset + strip.byteLength))
            .digest('hex')
          offset += strip.byteLength
        }
      }
    // Recompute valid checksums so pixel validation must independently reject these values.
    for (const [channel, value] of [
      [0, NaN],
      [1, Infinity],
      [2, -Infinity],
      [3, NaN],
      [3, -0.1],
      [3, 1.1],
    ]) {
      const bytes = Buffer.from(original)
      bytes.writeFloatLE(value, channel * 4)
      await updatePixels(bytes)
      await expect(verifyMaster(f.output, manifest)).rejects.toThrow('Invalid master pixels')
    }
    const signed = Buffer.from(original)
    signed.writeFloatLE(-0.25, 0)
    signed.writeFloatLE(4, 4)
    signed.writeFloatLE(-0, 12)
    await updatePixels(signed)
    await verifyMaster(f.output, manifest)
    await updatePixels(original)
    await writeFile(join(f.output, 'motion.mask'), Buffer.from([0]))
    await expect(verifyMaster(f.output, manifest)).rejects.toThrow('Damaged merge mask')
  } finally {
    await f.close()
  }
})

for (const boundary of ['staged', 'journaled', 'published', 'committed'] as const)
  test(`interrupted merge publication at ${boundary} recovers complete masters without source loss`, async () => {
    const f = await syntheticMerge([1, 1]),
      root = await mkdtemp(join(tmpdir(), 'luma-merge-boundary-'))
    let fail = true
    const make = () =>
      new PhotoLibrary(
        root,
        new PreviewEngine(),
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async (stage) => {
          if (fail && stage === boundary)
            throw new Error(
              boundary === 'staged'
                ? 'ENOSPC injected before publication'
                : 'Injected publication interruption',
            )
        },
        {
          inspectCapture: async (path) => ({
            version: 2,
            format: 'ARW',
            dateTimeOriginal: path.includes(f.sources[1].photo.id)
              ? '2026:10:01 00:05:00+1400'
              : '2025:09:30 23:55:00-1200',
          }),
          close: async () => {},
        },
      )
    let library = make()
    try {
      await library.open()
      const db = new DatabaseSync(join(root, 'catalog.sqlite'))
      for (const source of f.sources) {
        const directory = join(root, 'originals', source.photo.id)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'original.arw'), 'isolated synthetic test source')
        db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
          source.photo.id,
          '2026',
          JSON.stringify(source.photo),
        )
        db.prepare('INSERT INTO processing VALUES (?, ?)').run(
          source.photo.id,
          JSON.stringify({
            metadata: { ...source.metadata, capture: source.capture },
            settings: { distortion: false, vignetting: false, chromaticAberration: false },
            revision: 0,
          }),
        )
      }
      db.close()
      library.merges.worker.run = async (job) => {
        await cp(f.output, job.output, { recursive: true })
        return f.result
      }
      const ids = f.sources.map((s) => s.photo.id),
        review = await library.createMergeReview(ids, 'noise')
      expect(() => library.deletePhotos(ids)).toThrow('merge review')
      await library.requestMergePreview(review.id, 0)
      const task = library.startMerge(review.id, 0)
      await expect
        .poll(() => library.listTasks().find((t) => t.id === task)?.finishedAt)
        .toBeTruthy()
      expect(library.listTasks().find((t) => t.id === task)?.status).toBe('failed')
      await library.close()
      fail = false
      library = make()
      await library.open()
      expect(library.list().total).toBe(boundary === 'staged' ? 2 : 3)
      for (const id of ids)
        expect(await readFile(join(root, 'originals', id, 'original.arw'), 'utf8')).toBe(
          'isolated synthetic test source',
        )
      if (boundary !== 'staged') {
        const result = library.list().photos.find((p) => p.assetKind === 'derived')!
        expect(result.capturedAt).toBe('2026-10-01T00:05:00.000000000000000000')
        expect(result.captureDateOrigin).toEqual({
          kind: 'merge-reference',
          photoId: ids[1],
          filename: f.sources[1].photo.filename,
        })
        expect(
          library.locateBrowsePhoto({ search: '', grouping: 'date' }, result.id)?.photo,
        ).toMatchObject({ captureDate: result.capturedAt, dateOrigin: result.captureDateOrigin })
        const frozen = (await library.getMergeProvenance(result.id)).manifest
        expect(frozen.photo.capturedAt).toBe(result.capturedAt)
        expect(frozen.metadata.capturedAt).toBe(result.capturedAt)
        expect(library.getPhotoStack(result.id)).toMatchObject({
          coverId: result.id,
          count: 3,
          expanded: false,
          origin: 'merge',
        })
        expect(library.listGallery()).toMatchObject({ total: 1, storedTotal: 3 })
        expect((await library.getMergeProvenance(result.id)).manifest.asset.sha256).toBe(
          f.result.asset.sha256,
        )
      }
    } finally {
      await library.close()
      await f.close()
      await rm(root, { recursive: true, force: true })
    }
  })

test('read-only review diagnostics retain structured worker failure without rerunning and reject stale revisions', async () => {
  const f = await syntheticMerge([1, 1])
  const failure = {
    code: 'alignment',
    message: 'source-1.ARW: insufficient static support.',
    filenames: ['source-1.ARW'],
    diagnostics: [],
  }
  const worker = join(f.directory, 'failure.cjs'),
    counter = join(f.directory, 'calls')
  await writeFile(
    worker,
    `process.on('disconnect',()=>process.exit());process.on('message',m=>{if(m.type==='run'){require('node:fs').appendFileSync(${JSON.stringify(counter)},'1');process.send({error:${JSON.stringify(failure)}})}})`,
  )
  const reviews = new MergeReviews(
    f.directory,
    async (id) => ({ source: f.sources.find((s) => s.photo.id === id)!, path: 'unused' }),
    worker,
  )
  try {
    expect(reviews.active()).toBeNull()
    const review = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    expect(reviews.active()).toEqual(review)
    expect(reviews.diagnostics(review.id, 0).status).toBe('pending')
    await expect(reviews.preview(review.id, 0)).rejects.toMatchObject({
      message: failure.message,
      failure,
    })
    for (let i = 0; i < 2; i++)
      expect(reviews.diagnostics(review.id, 0)).toMatchObject({ status: 'failed', error: failure })
    await expect(reviews.preview(review.id, 0)).rejects.toMatchObject({ failure })
    expect(await readFile(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(reviews.diagnostics(review.id, 0))).not.toContain(f.directory)
    await reviews.update(review.id, 0, { ...review.settings, strength: 25 })
    expect(() => reviews.diagnostics(review.id, 0)).toThrow('Stale')
    expect(reviews.diagnostics(review.id, 1).status).toBe('pending')
    await reviews.dispose(review.id)
    expect(reviews.active()).toBeNull()
  } finally {
    await reviews.close()
    await f.close()
  }
})
