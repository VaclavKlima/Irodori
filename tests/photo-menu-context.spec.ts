import { test, expect } from '@playwright/test'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { PhotoActionsStore } from '../src/main/photo-actions'
import { MergeReviews } from '../src/main/merge/reviews'
import { stackFixture } from './stack.helpers'

test('context reads stay bulk and metadata-only for empty, single, and large unloaded selections', async () => {
  const t = await stackFixture(130)
  try {
    const ids = t.photos.map((p) => p.id)
    const stack = await t.library.groupPhotos(
      ids.slice(0, 125),
      ids[0],
      t.library.listStacks().revision,
    )
    // Catalog menu reads succeed even when no managed originals can be opened.
    await rename(join(t.root, 'library/originals'), join(t.root, 'unavailable-originals'))
    let reads = 0
    const db = new Proxy(t.db, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            reads++
            return target.prepare(sql)
          }
        return Reflect.get(target, key, target)
      },
    }) as DatabaseSync
    for (const selection of [[], [ids[0]], ids]) {
      reads = 0
      const c = new PhotoActionsStore(db).read(ids[0], selection)
      expect(reads).toBe(5)
      expect(c.selection.map((p) => p.id)).toEqual(selection)
      expect(c.group?.stack).toEqual(stack)
      expect(c.group?.photos).toHaveLength(125)
      expect(c.targetsCurrent).toBe(true)
      expect(JSON.stringify(c)).not.toMatch(/thumbnailUrl|previewUrl|original\.jpg/)
    }
    const empty = t.library.getPhotoActionsContext(null, [])
    expect(empty.photo).toBeNull()
    expect(empty.group).toBeNull()
    expect(Object.values(empty.availability).every((a) => a.kind === 'inapplicable')).toBe(true)
    const single = t.library.getPhotoActionsContext(ids[0], [ids[0], ids[0]])
    expect(single.equivalent.photoSelection).toBe(true)
    expect(single.availability['photo-cover'].kind).toBe('inapplicable')
    expect(single.availability['photo-remove'].kind).toBe('applicable')
    expect(single.availability['selection-hdr'].kind).toBe('inapplicable')
    expect(single.availability['selection-group'].kind).toBe('inapplicable')
    const full = t.library.getPhotoActionsContext(ids[0], ids.slice(0, 125))
    expect(full.equivalent.groupSelection).toBe(true)
    expect(full.availability['group-select'].kind).toBe('inapplicable')
  } finally {
    await t.close()
  }
})

test('selection and group share early merge eligibility while ordered originals preserve behavior', async () => {
  const t = await stackFixture(36)
  try {
    const ids = t.photos.map((p) => p.id)
    for (const photo of t.photos)
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify({ ...photo, format: 'ARW' }), photo.id)
    let c = t.library.getPhotoActionsContext(ids[0], ids.slice(0, 2))
    expect(c.availability['selection-hdr'].kind).toBe('applicable')
    expect(c.availability['selection-group'].kind).toBe('applicable')
    expect(c.availability['library-scan'].kind).toBe('applicable')
    expect(
      t.library.getPhotoActionsContext(null, ids.slice(0, 33)).availability['selection-hdr'].kind,
    ).toBe('inapplicable')
    const stack = await t.library.groupPhotos(ids.slice(0, 3), ids[1], c.galleryRevision)
    const ordered = t.library.getStackSnapshot(stack.id, stack.revision).photos.map((p) => p.id)
    c = t.library.getPhotoActionsContext(ids[0], ordered)
    expect(c.equivalent).toMatchObject({ groupSelection: true, mergeInputs: true })
    expect(c.availability['group-hdr'].kind).toBe('applicable')
    expect(
      t.library.getPhotoActionsContext(ids[0], [...ordered].reverse()).equivalent.mergeInputs,
    ).toBe(false)
    t.db
      .prepare('UPDATE photos SET photo = ? WHERE id = ?')
      .run(JSON.stringify({ ...t.photos[1], format: 'IRODORI HDR', assetKind: 'derived' }), ids[1])
    c = t.library.getPhotoActionsContext(ids[1], ordered)
    expect(c.group?.originals.map((p) => p.id)).toEqual(ordered.filter((id) => id !== ids[1]))
    expect(c.availability['selection-hdr'].kind).toBe('inapplicable')
    expect(c.availability['group-hdr'].kind).toBe('applicable')
    expect(c.equivalent.mergeInputs).toBe(false)
    for (const format of ['PNG', 'DNG', 'JPG']) {
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify({ ...t.photos[0], format }), ids[0])
      c = t.library.getPhotoActionsContext(ids[0], [ids[0], ids[2]])
      expect(c.availability['selection-hdr'].kind).toBe('inapplicable')
      expect(c.availability['group-hdr'].kind).toBe('inapplicable')
    }
    expect(
      t.library.getPhotoActionsContext(null, [ids[3], ids[0]]).availability['selection-group'].kind,
    ).toBe('inapplicable')
  } finally {
    await t.close()
  }
})

test('task and lease availability mirrors admission and imports leave foreground actions available', async () => {
  const t = await stackFixture(3)
  const ids = t.photos.map((p) => p.id)
  const tasks = (
    t.library as unknown as { tasks: Map<string, { snapshot: { kind: string; status: string } }> }
  ).tasks
  const stack = await t.library.groupPhotos(ids, ids[0], t.library.listStacks().revision)
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const merges = new MergeReviews(t.root, async () => {
    await hold
    throw new Error('Fixture source unavailable.')
  })
  const original = t.library.merges
  ;(t.library as unknown as { merges: MergeReviews }).merges = merges
  try {
    tasks.set('import', { snapshot: { kind: 'import', status: 'running' } })
    let c = t.library.getPhotoActionsContext(ids[0], [ids[0]])
    expect(c.availability['group-ungroup']).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('library operation'),
    })
    expect(c.availability['selection-trash'].kind).toBe('applicable')
    await expect(t.library.ungroupStack(stack.id, stack.revision)).rejects.toThrow(
      'library operation',
    )
    tasks.clear()
    const creation = merges.create(ids.slice(0, 2), 'hdr').catch((error: Error) => error.message)
    c = t.library.getPhotoActionsContext(ids[0], [ids[0]])
    expect(c.availability['selection-trash']).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining('merge review'),
    })
    expect(c.availability['group-trash'].kind).toBe('blocked')
    expect(() => t.library.deletePhotos([ids[0]])).toThrow('merge review')
    expect(
      t.library.getPhotoActionsContext(ids[2], [ids[2]]).availability['selection-trash'].kind,
    ).toBe('applicable')
    release()
    expect(await creation).toContain('Fixture source unavailable')
    expect(
      t.library.getPhotoActionsContext(ids[0], [ids[0]]).availability['group-trash'].kind,
    ).toBe('applicable')
    tasks.set('scan', { snapshot: { kind: 'capture-grouping', status: 'cancelling' } })
    c = t.library.getPhotoActionsContext(ids[0], [ids[0]])
    expect(c.availability['selection-trash'].kind).toBe('blocked')
    await expect(t.library.createMergeReview(ids.slice(0, 2), 'hdr')).rejects.toThrow(
      'library operation',
    )
    expect(() => t.library.deletePhotos([ids[0]])).toThrow('library operation')
  } finally {
    release()
    tasks.clear()
    await merges.close()
    ;(t.library as unknown as { merges: MergeReviews }).merges = original
    await t.close()
  }
})

test('only relevant target changes alter identity and missing or invalid targets are explicit', async () => {
  const t = await stackFixture(4)
  try {
    const ids = t.photos.map((p) => p.id)
    const before = t.library.getPhotoActionsContext(ids[0], [ids[0]])
    await t.library.groupPhotos(ids.slice(2), ids[2], before.galleryRevision)
    const unrelated = t.library.getPhotoActionsContext(ids[0], [ids[0]])
    expect(unrelated.galleryRevision).toBeGreaterThan(before.galleryRevision)
    expect(unrelated.targetIdentity).toBe(before.targetIdentity)
    await t.library.groupPhotos(ids.slice(0, 2), ids[0], unrelated.galleryRevision)
    expect(t.library.getPhotoActionsContext(ids[0], [ids[0]]).targetIdentity).not.toBe(
      before.targetIdentity,
    )
    const missing = 'f'.repeat(64)
    expect(t.library.getPhotoActionsContext(missing, [ids[0], missing]).targetsCurrent).toBe(false)
    for (const [photo, selection] of [
      ['path', []],
      [null, ['path']],
      [null, null],
    ] as const)
      expect(() =>
        t.library.getPhotoActionsContext(photo, selection as unknown as string[]),
      ).toThrow('Invalid')
  } finally {
    await t.close()
  }
})

test('incomplete persisted group targets never present partial counts or commands', async () => {
  const t = await stackFixture(3)
  try {
    const ids = t.photos.map((p) => p.id)
    await t.library.groupPhotos(ids, ids[0], t.library.listStacks().revision)
    t.db.prepare('DELETE FROM photos WHERE id = ?').run(ids[1])
    expect(() => t.library.getPhotoActionsContext(ids[0], [ids[0]])).toThrow(
      'unavailable photographs',
    )
  } finally {
    await t.close()
  }
})
