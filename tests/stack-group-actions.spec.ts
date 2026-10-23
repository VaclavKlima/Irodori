import { seedFixtureEdits } from './catalog-fixture.helpers'
import { test, expect } from '@playwright/test'
import { basename, join } from 'node:path'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { stackFixture, finishTask } from './stack.helpers'
import { sequenceMetadata } from './capture.helpers'
import { syntheticMerge } from './merge.helpers'
import { MergeReviews } from '../src/main/merge/reviews'
import { groupMergeUnavailable, type MergeManifest } from '../src/shared/merge'

test('revision-checked snapshots resolve more than two transport chunks in persisted order and survive restart', async () => {
  const t = await stackFixture(130)
  try {
    const ids = t.photos.slice(5).map((p) => p.id)
    const stack = await t.library.groupPhotos(ids, ids[90], t.library.listStacks().revision)
    const snapshot = t.library.getStackSnapshot(stack.id, stack.revision)
    const chunks = [0, 60, 120].flatMap(
      (offset) => t.library.getStackMembers(stack.id, offset).photos,
    )
    expect(snapshot).toEqual({ stack, photos: chunks })
    expect(snapshot.photos).toHaveLength(125)
    expect(snapshot.photos[0].id).toBe(stack.coverId)
    expect(t.library.listGallery().total).toBe(6)
    const expanded = await t.library.setStackExpanded(stack.id, true, stack.revision)
    expect(t.library.listGallery(60).entries[0].stack?.id).toBe(stack.id)
    expect(t.library.getStackSnapshot(stack.id, expanded.revision).photos).toEqual(chunks)
    expect(() => t.library.getStackSnapshot(stack.id, stack.revision)).toThrow('Stale')
    for (const revision of [undefined, -1, 0.5, NaN, '1'])
      expect(() => t.library.getStackSnapshot(stack.id, revision as number)).toThrow('revision')
    expect(() => t.library.getStackSnapshot('missing', 0)).toThrow('unavailable')
    await t.restart()
    expect(t.library.getStackSnapshot(stack.id, expanded.revision)).toEqual({
      stack: expanded,
      photos: chunks,
    })
    const removed = (await t.library.removeFromStack(ids[0], expanded.revision))!
    expect(() => t.library.getStackSnapshot(stack.id, expanded.revision)).toThrow('Stale')
    expect(t.library.getStackSnapshot(stack.id, removed.revision).photos).toHaveLength(124)
    await t.library.ungroupStack(stack.id, removed.revision)
    expect(() => t.library.getStackSnapshot(stack.id, removed.revision)).toThrow('unavailable')
  } finally {
    await t.close()
  }
})

test('capture and merge snapshots include unused originals and older results independently of recipe sources', async () => {
  const t = await stackFixture(9)
  const f = await syntheticMerge([1, 1, 1, 1, 1, 1])
  ;(
    t.library as unknown as {
      captureProcessor: { inspectCapture: () => Promise<unknown>; close: () => Promise<void> }
    }
  ).captureProcessor = {
    inspectCapture: async () => ({ version: 2, format: 'ARW' }),
    close: async () => {},
  }
  try {
    const ids = t.photos.map((p) => p.id)
    for (let i = 0; i < 6; i++) {
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify({ ...t.photos[i], format: 'ARW', filename: `source-${i}.ARW` }), ids[i])
      await rename(
        join(t.root, 'library', 'originals', ids[i], 'original.jpg'),
        join(t.root, 'library', 'originals', ids[i], 'original.arw'),
      )
      t.db.prepare('INSERT INTO processing VALUES (?, ?)').run(
        ids[i],
        JSON.stringify({
          metadata: { ...f.sources[i].metadata, capture: f.sources[i].capture },
          settings: { distortion: false, vignetting: false, chromaticAberration: false },
          revision: 0,
        }),
      )
      seedFixtureEdits(t.db)
    }
    for (let i = 0; i < 3; i++) t.capture(i, sequenceMetadata(i + 1))
    expect(t.store.reconcileCaptures()).toBe(1)
    const capture = t.library.getPhotoStack(ids[0])!
    expect(t.library.getStackSnapshot(capture.id, capture.revision)).toMatchObject({
      stack: { origin: 'capture', count: 3 },
    })
    await t.library.groupPhotos(ids.slice(3, 6), ids[5], t.library.listStacks().revision)
    for (const index of [6, 7]) {
      const manifest = {
        photo: { ...t.photos[index], assetKind: 'derived' },
        recipe: { sources: [ids[index - 6], ids[index - 3]].map((id) => ({ id })) },
      } as MergeManifest
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify(manifest.photo), ids[index])
      t.db
        .prepare('INSERT INTO derived_assets VALUES (?, ?)')
        .run(ids[index], JSON.stringify(manifest))
      t.store.attachMerge(manifest)
    }
    const stack = t.library.getPhotoStack(ids[7])!
    const snapshot = t.library.getStackSnapshot(stack.id, stack.revision)
    expect(snapshot.stack).toMatchObject({ origin: 'merge', count: 8, coverId: ids[7] })
    expect(snapshot.photos.map((p) => p.id)).toEqual([
      ids[7],
      ids[6],
      ...ids.slice(3, 6),
      ...ids.slice(0, 3),
    ])
    const originals = snapshot.photos.filter((p) => p.assetKind !== 'derived')
    expect(groupMergeUnavailable(originals)).toBeUndefined()
    const sources = originals.map((p) => p.id)
    expect(sources).toHaveLength(6)
    expect(
      t.library.listGallery().entries.find((e) => e.photo.id === ids[7])?.mergeSourceCount,
    ).toBe(2)
    for (const mode of ['hdr', 'noise'] as const) {
      const review = await t.library.createMergeReview(sources, mode)
      expect(review.sources.map((s) => s.photo.id)).toEqual(sources)
      expect(t.library.merges.leased(sources)).toBe(true)
      expect(t.library.merges.leased(ids.slice(6))).toBe(false)
      expect(() => t.library.deletePhotos(snapshot.photos.map((p) => p.id))).toThrow('merge review')
      await t.library.disposeMergeReview(review.id)
      expect(t.library.merges.leased(sources)).toBe(false)
    }
    await t.restart()
    expect(t.library.getStackSnapshot(stack.id, stack.revision)).toEqual(snapshot)
  } finally {
    await f.close()
    await t.close()
  }
})

test('early source limits and format checks never omit unsupported originals; review eligibility stays authoritative', async () => {
  const f = await syntheticMerge([1, 1])
  let sources = structuredClone(f.sources)
  const reviews = new MergeReviews(f.directory, async (id) => ({
    source: sources.find((s) => s.photo.id === id)!,
    path: 'unused',
  }))
  try {
    const photos = sources.map((s) => s.photo)
    expect(groupMergeUnavailable([])).toContain('at least two')
    expect(groupMergeUnavailable(photos.slice(0, 1))).toContain('at least two')
    expect(groupMergeUnavailable(Array.from({ length: 32 }, () => photos[0]))).toBeUndefined()
    expect(groupMergeUnavailable(Array.from({ length: 33 }, () => photos[0]))).toContain('32')
    expect(groupMergeUnavailable([photos[0], { ...photos[1], format: 'PNG' }])).toContain(
      'cannot be omitted',
    )
    expect(groupMergeUnavailable(photos)).toBeUndefined()
    sources[1].metadata.model = 'Unverified camera'
    await expect(
      reviews.create(
        photos.map((p) => p.id),
        'hdr',
      ),
    ).rejects.toThrow('verified Sony RAW')
    expect(reviews.leased(photos.map((p) => p.id))).toBe(false)
    sources = structuredClone(f.sources)
    sources[1].capture.shutterSeconds *= 2
    await expect(
      reviews.create(
        photos.map((p) => p.id),
        'noise',
      ),
    ).rejects.toThrow('within 0.1 EV')
    expect(reviews.active()).toBeNull()
  } finally {
    await reviews.close()
    await f.close()
  }
})

test('frozen group deletion includes results and excludes later members, with exact Trash bundles and untouched sources', async () => {
  const t = await stackFixture(8)
  try {
    const ids = t.photos.map((p) => p.id)
    const sources = join(t.root, 'sources')
    await mkdir(sources)
    for (const [index, photo] of t.photos.entries())
      await writeFile(join(sources, photo.filename), `original-${index}`)
    for (const index of [0, 1])
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify({ ...t.photos[index], assetKind: 'derived' }), ids[index])
    const stack = await t.library.groupPhotos(
      ids.slice(0, 5),
      ids[0],
      t.library.listStacks().revision,
    )
    const frozen = t.library.getStackSnapshot(stack.id, stack.revision).photos.map((p) => p.id)
    expect(frozen).toHaveLength(5)
    await t.library.ungroupStack(stack.id, stack.revision)
    await t.library.groupPhotos(ids.slice(0, 7), ids[0], t.library.listStacks().revision)
    expect(await finishTask(t.library, t.library.deletePhotos(frozen)!)).toMatchObject({
      status: 'completed',
      items: { completed: 5, total: 5 },
    })
    const trashed = await readdir(join(t.root, 'trash'))
    expect(trashed.map((name) => name.slice(0, 64)).sort()).toEqual([...frozen].sort())
    for (const bundle of trashed)
      expect(await readFile(join(t.root, 'trash', bundle, 'original.jpg'), 'utf8')).toBe(
        `original-${ids.indexOf(bundle.slice(0, 64))}`,
      )
    for (const [index, photo] of t.photos.entries())
      expect(await readFile(join(sources, photo.filename), 'utf8')).toBe(`original-${index}`)
    expect(t.library.getPhotoStack(ids[5])).toMatchObject({ count: 2, coverId: ids[5] })
    await t.restart()
    expect(t.library.list().photos.map((p) => p.id)).toEqual([ids[7], ids[6], ids[5]])
    expect(t.library.getPhotoStack(ids[5])?.count).toBe(2)
    expect(t.db.prepare('SELECT * FROM removals').all()).toEqual([])
  } finally {
    await t.close()
  }
})

test('group deletion cancellation waits for Trash, repairs survivors and recovers an interrupted frozen target on restart', async () => {
  const t = await stackFixture(5)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const ids = t.photos.map((p) => p.id)
    const stack = await t.library.groupPhotos(ids, ids[0], t.library.listStacks().revision)
    const frozen = t.library.getStackSnapshot(stack.id, stack.revision).photos.map((p) => p.id)
    let attempts = 0
    await t.restart(async (path) => {
      if (++attempts === 1) throw new Error('Trash unavailable for the cover')
      await gate
      await rename(path, join(t.root, 'trash', basename(path)))
    })
    const task = t.library.deletePhotos(frozen)!
    await expect.poll(() => attempts).toBe(2)
    const cancelled = t.library.cancelTask(task)
    expect(t.library.listTasks().find((t) => t.id === task)?.status).toBe('cancelling')
    release()
    await cancelled
    expect(await finishTask(t.library, task)).toMatchObject({
      status: 'cancelled',
      errorCount: 1,
      items: { completed: 1, total: 5 },
    })
    expect(t.library.getPhotoStack(ids[0])).toMatchObject({ coverId: ids[0], count: 4 })
    expect((await readdir(join(t.root, 'trash'))).map((name) => name.slice(0, 64))).toEqual([
      ids[1],
    ])
    await t.library.close()
    const bundle = `${ids[0]}-${randomUUID()}`
    t.db.prepare('INSERT INTO removals VALUES (?, ?)').run(ids[0], bundle)
    await rename(join(t.root, 'library', 'originals', ids[0]), join(t.root, 'trash', bundle))
    const restored = join(t.root, 'library', 'removed', `${ids[2]}-${randomUUID()}`)
    await mkdir(restored)
    await writeFile(join(restored, 'original.jpg'), 'OS restored')
    await t.restart()
    expect(t.library.getPhotoStack(ids[2])).toMatchObject({ coverId: ids[2], count: 3 })
    expect(await readFile(join(restored, 'original.jpg'), 'utf8')).toBe('OS restored')
    expect(t.db.prepare('SELECT * FROM removals').all()).toEqual([])
  } finally {
    release()
    await t.close()
  }
})
