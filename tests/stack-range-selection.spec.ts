import { test, expect } from '@playwright/test'
import { basename, join } from 'node:path'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import type { MergeManifest } from '../src/shared/merge'
import { stackFixture, finishTask } from './stack.helpers'
import { sequenceMetadata } from './capture.helpers'

for (const expanded of [false, true]) {
  test(`${expanded ? 'expanded' : 'collapsed'} covers at endpoints and inside reversed ranges contribute complete, ordered groups`, async () => {
    const t = await stackFixture(10)
    try {
      const ids = t.photos.map((p) => p.id)
      for (const members of [ids.slice(1, 4), ids.slice(5, 9)]) {
        const stack = await t.library.groupPhotos(
          members,
          members.at(-1)!,
          t.library.listStacks().revision,
        )
        if (expanded) await t.library.setStackExpanded(stack.id, true, stack.revision)
      }
      const cases: [string, string, string[]][] = [
        [ids[8], ids[8], [ids[8], ids[5], ids[6], ids[7]]],
        [ids[9], ids[8], [ids[9], ids[8], ids[5], ids[6], ids[7]]],
        [ids[8], ids[4], [ids[8], ids[5], ids[6], ids[7], ids[4]]],
        [ids[8], ids[3], [ids[8], ids[5], ids[6], ids[7], ids[4], ids[3], ids[1], ids[2]]],
        [ids[4], ids[0], [ids[4], ids[3], ids[1], ids[2], ids[0]]],
        [
          ids[9],
          ids[0],
          [ids[9], ids[8], ids[5], ids[6], ids[7], ids[4], ids[3], ids[1], ids[2], ids[0]],
        ],
      ]
      for (const [from, to, expected] of cases) {
        const range = t.library.getGalleryRange(from, to)
        expect(range).toEqual(
          expected.map((id) => ({ id, filename: t.photos.find((p) => p.id === id)!.filename })),
        )
        expect(t.library.getGalleryRange(to, from)).toEqual(range)
        expect(new Set(range.map((p) => p.id)).size).toBe(range.length)
      }
    } finally {
      await t.close()
    }
  })
}

test('member-only ranges stay narrow; hidden boundaries use covers and missing anchors fall back to the target', async () => {
  const t = await stackFixture(7)
  try {
    const ids = t.photos.map((p) => p.id)
    const stack = await t.library.groupPhotos(
      ids.slice(1, 6),
      ids[5],
      t.library.listStacks().revision,
    )
    const all = [ids[5], ids[1], ids[2], ids[3], ids[4]]
    expect(t.library.getGalleryRange(ids[1], ids[4]).map((p) => p.id)).toEqual(all)
    const expanded = await t.library.setStackExpanded(stack.id, true, stack.revision)
    for (const [from, to, expected] of [
      [ids[2], ids[4], [ids[2], ids[3], ids[4]]],
      [ids[2], ids[2], [ids[2]]],
      [ids[5], ids[1], all],
      [ids[3], ids[0], [ids[3], ids[4], ids[0]]],
    ] as [string, string, string[]][]) {
      expect(t.library.getGalleryRange(from, to).map((p) => p.id)).toEqual(expected)
      expect(t.library.getGalleryRange(to, from).map((p) => p.id)).toEqual(expected)
    }
    expect(t.library.getGalleryRange('f'.repeat(64), ids[3]).map((p) => p.id)).toEqual([ids[3]])
    await t.library.setStackExpanded(stack.id, false, expanded.revision)
    expect(t.library.getGalleryRange('f'.repeat(64), ids[5]).map((p) => p.id)).toEqual(all)
    expect(() => t.library.getGalleryRange(ids[0], 'f'.repeat(64))).toThrow('unavailable')
    expect(() => t.library.getGalleryRange('../photo', ids[5])).toThrow('Invalid')
  } finally {
    await t.close()
  }
})

test('groups larger than two chunks resolve completely while member-only and individual ranges retain their own boundaries', async () => {
  const t = await stackFixture(130)
  try {
    await t.restart()
    const ids = t.photos.map((p) => p.id)
    const flatBefore = t.library.getBrowseRange({ search: '', grouping: 'date' }, ids[0], ids[129])
    expect(flatBefore.length).toBeGreaterThan(0)
    const stack = await t.library.groupPhotos(
      ids.slice(5),
      ids[129],
      t.library.listStacks().revision,
    )
    const ordered = [0, 60, 120]
      .flatMap((offset) => t.library.getStackMembers(stack.id, offset).photos)
      .map(({ id, filename }) => ({ id, filename }))
    expect(ordered).toHaveLength(125)
    expect(t.library.getGalleryRange(ids[129], ids[129])).toEqual(ordered)
    await t.library.setStackExpanded(stack.id, true, stack.revision)
    expect(t.library.listGallery(60).entries[0].memberIndex).toBe(60)
    expect(t.library.getGalleryRange(ids[129], ordered[58].id)).toEqual(ordered)
    const narrow = ordered.slice(58, 123)
    expect(t.library.getGalleryRange(ordered[58].id, ordered[122].id)).toEqual(narrow)
    expect(t.library.getGalleryRange(ordered[122].id, ordered[58].id)).toEqual(narrow)
    expect(t.library.getBrowseRange({ search: '', grouping: 'date' }, ids[0], ids[129])).toEqual(
      flatBefore,
    )
    expect(t.library.list().total).toBe(130)
  } finally {
    await t.close()
  }
})

test('capture and merge covers use current membership, including older results and unused originals, independently of recipes', async () => {
  const t = await stackFixture(9)
  try {
    const ids = t.photos.map((p) => p.id)
    for (let i = 0; i < 3; i++) t.capture(i, sequenceMetadata(i + 1))
    expect(t.store.reconcileCaptures()).toBe(1)
    expect(t.library.getPhotoStack(ids[0])?.origin).toBe('capture')
    expect(t.library.getGalleryRange(ids[0], ids[0]).map((p) => p.id)).toEqual(ids.slice(0, 3))
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
    expect(stack).toMatchObject({ origin: 'merge', count: 8, coverId: ids[7] })
    expect(
      t.library.listGallery().entries.find((e) => e.photo.id === ids[7])?.mergeSourceCount,
    ).toBe(2)
    expect(t.library.getGalleryRange(ids[7], ids[7]).map((p) => p.id)).toEqual([
      ids[7],
      ids[6],
      ...ids.slice(3, 6),
      ...ids.slice(0, 3),
    ])
    const changed = (await t.library.removeFromStack(ids[1], stack.revision))!
    const cover = await t.library.setStackCover(stack.id, ids[6], changed.revision)
    expect(t.library.getGalleryRange(ids[6], ids[6]).map((p) => p.id)).toEqual([
      ids[6],
      ids[7],
      ...ids.slice(3, 6),
      ids[0],
      ids[2],
    ])
    expect(cover.count).toBe(7)
    await t.restart()
    expect(t.library.getGalleryRange(ids[6], ids[6])).toHaveLength(7)
  } finally {
    await t.close()
  }
})

test('deletion moves exactly the frozen range bundles despite later regrouping and preserves every external source', async () => {
  const t = await stackFixture(8)
  try {
    const ids = t.photos.map((p) => p.id)
    const sources = join(t.root, 'sources')
    await mkdir(sources)
    for (const [index, photo] of t.photos.entries())
      await writeFile(join(sources, photo.filename), `original-${index}`)
    const stack = await t.library.groupPhotos(
      ids.slice(2, 6),
      ids[5],
      t.library.listStacks().revision,
    )
    const frozen = t.library.getGalleryRange(ids[7], ids[5]).map((p) => p.id)
    expect(frozen).toEqual([ids[7], ids[6], ids[5], ids[2], ids[3], ids[4]])
    await t.library.ungroupStack(stack.id, stack.revision)
    await t.library.groupPhotos(ids.slice(1, 6), ids[5], t.library.listStacks().revision)
    expect(await finishTask(t.library, t.library.deletePhotos(frozen)!)).toMatchObject({
      status: 'completed',
      items: { completed: 6, total: 6 },
    })
    const trashed = await readdir(join(t.root, 'trash'))
    expect(trashed.map((name) => name.slice(0, 64)).sort()).toEqual([...frozen].sort())
    for (const bundle of trashed) {
      const index = ids.indexOf(bundle.slice(0, 64))
      expect(await readFile(join(t.root, 'trash', bundle, 'original.jpg'), 'utf8')).toBe(
        `original-${index}`,
      )
    }
    for (const [index, photo] of t.photos.entries())
      expect(await readFile(join(sources, photo.filename), 'utf8')).toBe(`original-${index}`)
    expect(t.library.list().photos.map((p) => p.id)).toEqual([ids[1], ids[0]])
    expect(t.library.listStacks().stacks).toEqual([])
    await t.restart()
    expect(t.library.list().total).toBe(2)
    expect(t.db.prepare('SELECT * FROM removals').all()).toEqual([])
  } finally {
    await t.close()
  }
})

test('range deletion restores a failed cover and waits for an in-flight move before cancelling and repairing the survivors', async () => {
  const t = await stackFixture(5)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const ids = t.photos.map((p) => p.id)
    const stack = await t.library.groupPhotos(ids, ids[0], t.library.listStacks().revision)
    let attempts = 0
    await t.restart(async (path) => {
      if (++attempts === 1) throw new Error('Trash unavailable for the cover')
      await gate
      await rename(path, join(t.root, 'trash', basename(path)))
    })
    const range = t.library.getGalleryRange(ids[0], ids[0]).map((p) => p.id)
    const task = t.library.deletePhotos(range)!
    await expect.poll(() => attempts).toBe(2)
    const cancellation = t.library.cancelTask(task)
    expect(t.library.listTasks().find((t) => t.id === task)?.status).toBe('cancelling')
    expect(
      await readFile(join(t.root, 'library', 'originals', ids[0], 'original.jpg'), 'utf8'),
    ).toBe('original-0')
    release()
    await cancellation
    expect(await finishTask(t.library, task)).toMatchObject({
      status: 'cancelled',
      errorCount: 1,
      items: { completed: 1, total: 5 },
    })
    expect(t.library.getPhotoStack(ids[0])).toMatchObject({
      id: stack.id,
      count: 4,
      coverId: ids[0],
    })
    expect((await readdir(join(t.root, 'trash'))).map((name) => name.slice(0, 64))).toEqual([
      ids[1],
    ])
    await t.restart()
    expect(t.library.getPhotoStack(ids[0])?.count).toBe(4)
    expect(t.db.prepare('SELECT * FROM removals').all()).toEqual([])
  } finally {
    release()
    await t.close()
  }
})
