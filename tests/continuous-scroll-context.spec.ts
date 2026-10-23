import { expect, test } from '@playwright/test'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CollectionChangedError } from '../src/shared/collections'
import { stackFixture } from './stack.helpers'
import { setup } from './library.helpers'

test('gallery summaries and 60-record chunks share catalog and stack revisions without full-photo projection or decoding', async () => {
  const t = await stackFixture(185)
  try {
    const summary = t.library.getGallerySummary()
    expect(summary).toMatchObject({ total: 185, storedTotal: 185, catalogRevision: 185 })
    expect(t.library.getGalleryChunk(60, summary).entries).toHaveLength(60)
    expect(t.library.getGalleryChunk(180, summary).entries).toHaveLength(5)
    const target = t.library.getGalleryChunk(60, summary).entries[15].photo
    expect(t.library.locateGalleryPhoto(target.id, 0, summary)).toMatchObject({
      index: 75,
      photo: target,
    })
    const stack = await t.library.groupPhotos(
      t.photos.slice(0, 125).map((p) => p.id),
      t.photos[0].id,
      summary.revision,
    )
    expect(() => t.library.getGalleryChunk(60, summary)).toThrow(CollectionChangedError)
    const collapsed = t.library.getGallerySummary([t.photos[1].id])
    expect(collapsed).toMatchObject({
      total: 61,
      storedTotal: 185,
      hiddenSelectedIds: [t.photos[1].id],
    })
    const cover = t.library.locateGalleryPhoto(t.photos[1].id, 0, collapsed)!
    expect(cover.entries[cover.index - cover.offset].photo.id).toBe(stack.coverId)
    expect(t.library.getGalleryRange(stack.coverId, stack.coverId)).toHaveLength(125)
    await t.library.setStackExpanded(stack.id, true, stack.revision)
    expect(() => t.library.locateGalleryPhoto(target.id, 0, collapsed)).toThrow(
      CollectionChangedError,
    )
    const expanded = t.library.getGallerySummary()
    expect(expanded.total).toBe(185)
    expect(t.library.listGallery(60)).toEqual({ ...t.library.getGalleryChunk(60, expanded) })
    // A metadata update is coherent even when its ID and order stay the same.
    const photo = { ...t.photos[184], camera: 'Updated camera' }
    t.db.prepare('UPDATE photos SET photo = ? WHERE id = ?').run(JSON.stringify(photo), photo.id)
    expect(() => t.library.getGalleryChunk(0, expanded)).toThrow(CollectionChangedError)
    expect(
      t.library
        .getGalleryChunk(0, t.library.getGallerySummary())
        .entries.some((e) => e.photo.camera === 'Updated camera'),
    ).toBe(true)
    expect(() => t.library.getGalleryChunk(-1, expanded)).toThrow('Invalid collection offset')
  } finally {
    await t.close()
  }
})
test('discovery prepends invalidate indexed review reads while content and selection updates preserve ordering', async () => {
  const t = await setup()
  try {
    const directory = join(t.root, 'continuous-source')
    await mkdir(directory)
    const bytes = await readFile('tests/fixtures/photos/alpine-lake.jpg')
    const paths: string[] = []
    for (let i = 0; i < 125; i++) {
      const path = join(directory, `${String(i).padStart(3, '0')}.jpg`)
      await writeFile(path, bytes)
      const date = new Date(1700000000000 + i * 60000)
      await utimes(path, date, date)
      paths.push(path)
    }
    const id = await t.service.scan(paths, false)
    while (!t.service.reviewSummary(id).total)
      await new Promise<void>((resolve) => setImmediate(resolve))
    const early = t.service.reviewSummary(id),
      anchor = t.service.reviewChunk(id, 0, early.orderingRevision).candidates[0]
    t.service.select(id, [anchor.id], false)
    await expect.poll(() => t.service.reviewSummary(id).phase).toBe('review')
    const summary = t.service.reviewSummary(id)
    expect(summary).toMatchObject({ total: 125, selected: 124, selectionRevision: 1 })
    expect(summary.contentRevision).toBeGreaterThan(early.contentRevision)
    expect(() => t.service.reviewChunk(id, 0, early.orderingRevision)).toThrow(
      CollectionChangedError,
    )
    const chunks = [0, 60, 120].flatMap(
      (offset) => t.service.reviewChunk(id, offset, summary.orderingRevision).candidates,
    )
    expect(chunks).toHaveLength(125)
    expect(chunks[0].filename).toBe('124.jpg')
    expect(
      t.service.locateReviewCandidate(id, anchor.id, summary.orderingRevision)?.candidate.selected,
    ).toBe(false)
    t.service.select(id, null, false)
    const unselected = t.service.reviewSummary(id)
    expect(unselected.orderingRevision).toBe(summary.orderingRevision)
    expect(t.service.reviewChunk(id, 60, summary.orderingRevision)).toMatchObject({
      selectionRevision: 2,
    })
    expect(
      t.service.reviewChunk(id, 60, summary.orderingRevision).candidates.every((c) => !c.selected),
    ).toBe(true)
    t.service.requestReviewThumbnails(id, { generation: 2, visible: [], lookahead: [] })
    // A delayed priority update cannot replace the newer empty set.
    t.service.requestReviewThumbnails(id, {
      generation: 1,
      visible: ['unavailable'],
      lookahead: [],
    })
    await t.service.cancel(id)
    await t.service.dispose(id)
    expect(() => t.service.reviewSummary(id)).toThrow('expired')
  } finally {
    await t.close()
  }
})
