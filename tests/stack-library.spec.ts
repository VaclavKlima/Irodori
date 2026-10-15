import { test, expect } from '@playwright/test'
import { readFile, rename, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MergeManifest } from '../src/shared/merge'
import { stackFixture, finishTask } from './stack.helpers'
import { sequenceMetadata } from './capture.helpers'

function relation(
  resultId: string,
  ids: string[],
  photo: import('../src/shared/contracts').Photo,
): MergeManifest {
  // This catalog-only fixture exercises grouping, never the pixel/provenance validator.
  return {
    photo: { ...photo, id: resultId, assetKind: 'derived' },
    recipe: { sources: ids.map((id) => ({ id })) },
  } as MergeManifest
}

test('manual grouping, cover, order and expansion persist independently of flat enumeration', async () => {
  const t = await stackFixture()
  try {
    const ids = t.photos.slice(0, 3).map((p) => p.id)
    t.capture(0, sequenceMetadata(1, '2026-10-04T14:42:32.240'))
    t.capture(1, sequenceMetadata(2, '2026-10-04T14:42:32.080'))
    const initialFlat = t.library.list()
    const stack = t.library.groupPhotos(ids, ids[2], t.library.listStacks().revision)
    expect(stack).toMatchObject({ coverId: ids[2], count: 3, expanded: false, origin: 'manual' })
    expect(t.library.getStackMembers(stack.id).photos.map((p) => p.id)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ])
    expect(t.library.listGallery()).toMatchObject({ total: 3, storedTotal: 5 })
    expect(t.library.list()).toEqual(initialFlat)
    expect(() => t.library.groupPhotos(ids, ids[0], 0)).toThrow('Stale')
    expect(() =>
      t.library.groupPhotos([ids[0], t.photos[3].id], ids[0], t.library.listStacks().revision),
    ).toThrow('ungrouped')
    expect(() =>
      t.library.setStackExpanded(stack.id, true, undefined as unknown as number),
    ).toThrow('revision')
    const expanded = t.library.setStackExpanded(stack.id, true, stack.revision)
    expect(() => t.library.setStackCover(stack.id, ids[0], stack.revision)).toThrow('Stale')
    const changed = t.library.setStackCover(stack.id, ids[0], expanded.revision)
    await t.restart()
    expect(t.library.getPhotoStack(ids[1])).toEqual(changed)
    expect(t.library.listGallery().total).toBe(5)
    expect(
      await readFile(join(t.root, 'library', 'originals', ids[0], 'original.jpg'), 'utf8'),
    ).toBe('original-0')
    const removed = t.library.removeFromStack(ids[1], changed.revision)!
    expect(removed.count).toBe(2)
    expect(t.library.getPhotoStack(ids[1])).toBeNull()
    t.library.removeFromStack(ids[2], removed.revision)
    expect(t.library.listStacks().stacks).toEqual([])
  } finally {
    await t.close()
  }
})

test('mixed capture and import timestamps form a deterministic order when covers change', async () => {
  const t = await stackFixture(5)
  try {
    const ids = t.photos.map((p) => p.id)
    t.db
      .prepare('UPDATE photos SET photo = ? WHERE id = ?')
      .run(JSON.stringify({ ...t.photos[0], capturedAt: '2026-10-04T12:00:02Z' }), ids[0])
    t.capture(2, sequenceMetadata(1, '2026-10-04T12:00:00.0060'))
    const stack = t.library.groupPhotos(
      [ids[3], ids[0], ids[1], ids[2], ids[4]],
      ids[4],
      t.library.listStacks().revision,
    )
    expect(t.library.getStackMembers(stack.id).photos.map((p) => p.id)).toEqual([
      ids[4],
      ids[2],
      ids[1],
      ids[0],
      ids[3],
    ])
    const changed = t.library.setStackCover(stack.id, ids[0], stack.revision)
    const restored = t.library.setStackCover(stack.id, ids[4], changed.revision)
    await t.restart()
    expect(t.library.getPhotoStack(ids[0])).toEqual(restored)
    expect(t.library.getStackMembers(stack.id).photos.map((p) => p.id)).toEqual([
      ids[4],
      ids[2],
      ids[1],
      ids[0],
      ids[3],
    ])
  } finally {
    await t.close()
  }
})

test('merge relationships union complete stacks and backfill once, with newest cover and actual recipe counts', async () => {
  const t = await stackFixture(8)
  try {
    const ids = t.photos.map((p) => p.id)
    t.library.groupPhotos(ids.slice(0, 3), ids[0], t.library.listStacks().revision)
    t.library.groupPhotos(ids.slice(3, 6), ids[3], t.library.listStacks().revision)
    const first = relation(ids[6], [ids[0], ids[3]], t.photos[6])
    const second = relation(ids[7], [ids[1], ids[4]], t.photos[7])
    for (const manifest of [first, second]) {
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify(manifest.photo), manifest.photo.id)
      t.db
        .prepare('INSERT INTO derived_assets VALUES (?, ?)')
        .run(manifest.photo.id, JSON.stringify(manifest))
    }
    t.db.exec('PRAGMA user_version = 10')
    await t.restart()
    const stack = t.library.listStacks().stacks[0]
    expect(t.library.listStacks().stacks).toHaveLength(1)
    expect(stack).toMatchObject({ coverId: ids[7], count: 8, origin: 'merge', expanded: false })
    expect(t.library.listGallery().entries[0]).toMatchObject({
      photo: { id: ids[7] },
      mergeSourceCount: 2,
    })
    const changed = t.library.setStackCover(stack.id, ids[0], stack.revision)
    t.library.ungroupStack(stack.id, changed.revision)
    await t.restart()
    expect(t.library.listStacks().stacks).toEqual([])
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 17 })
  } finally {
    await t.close()
  }
})

test('deleting a cover promotes the newest surviving result, then an ordered original, dissolving small stacks', async () => {
  const t = await stackFixture(5)
  try {
    const ids = t.photos.map((p) => p.id)
    for (const index of [3, 4])
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify({ ...t.photos[index], assetKind: 'derived' }), ids[index])
    const stack = t.library.groupPhotos(ids, ids[0], t.library.listStacks().revision)
    expect((await finishTask(t.library, t.library.deletePhotos([ids[0]])!)).status).toBe(
      'completed',
    )
    expect(t.library.getPhotoStack(ids[4])?.coverId).toBe(ids[4])
    await finishTask(t.library, t.library.deletePhotos([ids[4]])!)
    expect(t.library.getPhotoStack(ids[3])?.coverId).toBe(ids[3])
    await finishTask(t.library, t.library.deletePhotos([ids[3]])!)
    expect(t.library.getPhotoStack(ids[1])?.coverId).toBe(ids[1])
    await finishTask(t.library, t.library.deletePhotos([ids[1]])!)
    expect(t.library.listStacks().stacks).toEqual([])
    expect(t.library.list().total).toBe(1)
    expect(() => t.library.getStackMembers(stack.id)).toThrow('unavailable')
  } finally {
    await t.close()
  }
})

test('failed Trash leaves membership unchanged; cancelling waits for the current move and repairs only committed photos', async () => {
  const t = await stackFixture(4)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const ids = t.photos.map((p) => p.id)
    const stack = t.library.groupPhotos(ids, ids[0], t.library.listStacks().revision)
    await t.restart(async () => {
      throw new Error('Trash unavailable')
    })
    expect((await finishTask(t.library, t.library.deletePhotos([ids[0]])!)).status).toBe('failed')
    expect(t.library.getPhotoStack(ids[0])).toEqual(stack)
    await t.restart(async (path) => {
      await gate
      await rename(path, join(t.root, 'trash', path.split('/').at(-1)!))
    })
    const task = t.library.deletePhotos(ids)!
    await expect
      .poll(() => t.db.prepare('SELECT COUNT(*) AS count FROM removals').get())
      .toMatchObject({ count: 1 })
    const cancelled = t.library.cancelTask(task)
    expect(t.library.listTasks().find((t) => t.id === task)?.status).toBe('cancelling')
    release()
    await cancelled
    expect(t.library.getPhotoStack(ids[1])).toMatchObject({ count: 3, coverId: ids[1] })
    expect(t.library.list().total).toBe(3)
  } finally {
    release()
    await t.close()
  }
})

test('removal recovery repairs membership atomically and preserves OS-restored bundles', async () => {
  const t = await stackFixture(3)
  try {
    const ids = t.photos.map((p) => p.id)
    t.library.groupPhotos(ids, ids[0], t.library.listStacks().revision)
    await t.library.close()
    const bundle = `${ids[0]}-${randomUUID()}`
    t.db.prepare('INSERT INTO removals VALUES (?, ?)').run(ids[0], bundle)
    await rename(join(t.root, 'library', 'originals', ids[0]), join(t.root, 'trash', bundle))
    const restored = join(t.root, 'library', 'removed', `${ids[1]}-${randomUUID()}`)
    await mkdir(restored)
    await writeFile(join(restored, 'original.jpg'), 'OS restored')
    await t.restart()
    expect(t.library.getPhotoStack(ids[1])).toMatchObject({ count: 2, coverId: ids[1] })
    expect(await readFile(join(restored, 'original.jpg'), 'utf8')).toBe('OS restored')
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM removals').get()).toMatchObject({ count: 0 })
  } finally {
    await t.close()
  }
})

test('gallery chunk windows, hidden boundaries and individual selection remain distinct', async () => {
  const t = await stackFixture(5)
  try {
    await t.restart()
    const ids = t.photos.map((p) => p.id)
    const stack = t.library.groupPhotos(ids.slice(0, 3), ids[2], t.library.listStacks().revision)
    const gallery = t.library.listGallery(0, [ids[0], ids[4]])
    expect(gallery.hiddenSelectedIds).toEqual([ids[0]])
    expect(t.library.locateGalleryPhoto(ids[0])?.photo.id).toBe(ids[0])
    expect(t.library.locateGalleryPhoto(ids[0])?.index).toBe(2)
    expect(t.library.locateGalleryPhoto(ids[0], -1)?.photo.id).toBe(ids[3])
    expect(t.library.getGalleryRange(ids[0], ids[4]).map((p) => p.id)).toEqual([
      ids[4],
      ids[3],
      ids[2],
      ids[0],
      ids[1],
    ])
    t.library.setStackExpanded(stack.id, true, stack.revision)
    expect(t.library.getGalleryRange(ids[0], ids[4]).map((p) => p.id)).toEqual([
      ids[4],
      ids[3],
      ids[2],
      ids[0],
      ids[1],
    ])
    expect(t.library.getBrowseRange({ search: '', grouping: 'date' }, ids[0], ids[4])).toHaveLength(
      5,
    )
  } finally {
    await t.close()
  }
})
