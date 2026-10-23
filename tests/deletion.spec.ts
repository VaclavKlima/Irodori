import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import type { PreviewProcessor } from '../src/main/preview-types'

const fixture = resolve('tests/fixtures/photos/alpine-lake.jpg')
const preview: PreviewProcessor = {
  process: async (_path, output) => {
    await copyFile(fixture, join(output, 'thumb.jpg'))
    await copyFile(fixture, join(output, 'preview.jpg'))
    return { metadata: { width: 1200, height: 800 }, source: 'image' }
  },
  close: async () => {},
}
async function setup(trash?: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'luma-delete-'))
  await mkdir(join(root, 'trash'))
  const move =
    trash ??
    (async (path: string) => {
      await rename(path, join(root, 'trash', basename(path)))
    })
  const service = new PhotoLibrary(join(root, 'library'), preview, () => {}, undefined, move)
  await service.open()
  return {
    root,
    service,
    close: async () => {
      await service.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
async function populate(service: PhotoLibrary, root: string, count = 3) {
  const sources: string[] = []
  for (let index = 0; index < count; index++) {
    const path = join(root, `photo-${index}.jpg`)
    await writeFile(path, `photo ${index}`)
    sources.push(path)
  }
  const session = await service.scan(sources, true)
  await expect.poll(() => service.review(session).phase).toBe('review')
  service.importSelected(session)
  await expect.poll(() => service.review(session).phase).toBe('complete')
  return sources
}
async function finished(service: PhotoLibrary, id: string) {
  await expect
    .poll(() => service.listTasks().find((task) => task.id === id)?.status)
    .not.toMatch(/^(running|cancelling)$/)
  return service.listTasks().find((task) => task.id === id)!
}

test('trashes managed bundles, preserves sources, reports fixed totals, and allows reimport', async () => {
  const t = await setup()
  try {
    const sources = await populate(t.service, t.root)
    const photos = t.service.list().photos
    expect(() => t.service.deletePhotos(['../source'])).toThrow('Invalid photo selection')
    const id = t.service.deletePhotos([photos[0].id, photos[0].id, photos[1].id])!
    expect(await finished(t.service, id)).toMatchObject({
      kind: 'delete',
      status: 'completed',
      items: { completed: 2, total: 2 },
      progress: { completed: 2, total: 2 },
    })
    expect(t.service.list().photos.map((photo) => photo.id)).toEqual([photos[2].id])
    const bundles = await readdir(join(t.root, 'trash'))
    expect(bundles).toHaveLength(2)
    for (const bundle of bundles)
      expect(await readdir(join(t.root, 'trash', bundle))).toEqual([
        'original.jpg',
        'preview.jpg',
        'thumb.jpg',
      ])
    expect(await readdir(join(t.root, 'library', 'removed'))).toEqual([])
    for (let index = 0; index < sources.length; index++)
      expect(await readFile(sources[index], 'utf8')).toBe(`photo ${index}`)
    const review = await t.service.scan(sources, true)
    await expect.poll(() => t.service.review(review).phase).toBe('review')
    expect(t.service.review(review)).toMatchObject({ unchecked: 3, duplicates: 0 })
    expect(t.service.deletePhotos([photos[0].id])).toBeNull()
  } finally {
    await t.close()
  }
})

test('a Trash failure restores its original and keeps the photo while the batch continues', async () => {
  let attempts = 0
  let root = ''
  const t = await setup(async (path) => {
    if (++attempts === 1) throw new Error('Trash is unavailable')
    await rename(path, join(root, 'trash', basename(path)))
  })
  root = t.root
  try {
    await populate(t.service, t.root)
    const photos = t.service.list().photos
    const id = t.service.deletePhotos(photos.map((photo) => photo.id))!
    expect(await finished(t.service, id)).toMatchObject({
      status: 'failed',
      errorCount: 1,
      items: { completed: 2, total: 3 },
      progress: { completed: 3, total: 3 },
    })
    expect(t.service.list().photos).toEqual([photos[0]])
    expect(
      await readFile(join(root, 'library', 'originals', photos[0].id, 'original.jpg'), 'utf8'),
    ).toBe('photo 2')
    expect(t.service.taskErrors(id)).toEqual({
      total: 1,
      errors: [{ filename: 'photo-2.jpg', message: 'Trash is unavailable' }],
    })
    expect(await readdir(join(root, 'library', 'removed'))).toEqual([])
  } finally {
    await t.close()
  }
})

test('cancellation waits for the current Trash move and queues subsequent confirmed deletion', async () => {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let root = ''
  const t = await setup(async (path) => {
    entered()
    await gate
    await rename(path, join(root, 'trash', basename(path)))
  })
  root = t.root
  try {
    await populate(t.service, t.root)
    const photos = t.service.list().photos
    const id = t.service.deletePhotos(photos.map((photo) => photo.id))!
    await started
    await expect(t.service.scan([fixture], true)).rejects.toThrow('Finish or cancel')
    const queued = t.service.deletePhotos([photos[1].id])!
    const queuedCancellation = t.service.cancelTask(queued)
    expect(await readFile(t.service.imagePath(photos[0].previewUrl)!)).toEqual(
      await readFile(fixture),
    )
    const cancel = t.service.cancelTask(id)
    expect(t.service.listTasks().find((task) => task.id === id)?.status).toBe('cancelling')
    release()
    await Promise.all([cancel, queuedCancellation])
    expect(await finished(t.service, queued)).toMatchObject({
      status: 'cancelled',
      items: { completed: 0 },
      progress: { completed: 0 },
    })
    expect(await finished(t.service, id)).toMatchObject({
      status: 'cancelled',
      items: { completed: 1, total: 3 },
    })
    expect(t.service.list().total).toBe(2)
    expect(await readdir(join(root, 'library', 'removed'))).toEqual([])
  } finally {
    release()
    await t.close()
  }
})

test('current catalogs reconcile interrupted removals without erasing OS-restored bundles', async () => {
  const t = await setup()
  try {
    await populate(t.service, t.root)
    const photos = t.service.list().photos
    await t.service.close()
    const library = join(t.root, 'library')
    const journal = new DatabaseSync(join(library, 'catalog.sqlite'))
    for (const photo of photos)
      journal
        .prepare('INSERT INTO removals VALUES (?, ?)')
        .run(photo.id, `${photo.id}-${randomUUID()}`)
    const entries = journal.prepare('SELECT id, staged FROM removals').all() as {
      id: string
      staged: string
    }[]
    // First: staged before crash. Second: already trashed. Third: intent before rename.
    await rename(
      join(library, 'originals', entries[0].id),
      join(library, 'removed', entries[0].staged),
    )
    await rename(
      join(library, 'originals', entries[1].id),
      join(t.root, 'trash', entries[1].staged),
    )
    const restored = join(library, 'removed', 'manually-restored')
    await mkdir(restored)
    await writeFile(join(restored, 'original.jpg'), 'keep this recovered original')
    journal.close()
    const recovered = new PhotoLibrary(library, preview, () => {})
    await recovered.open()
    try {
      expect(recovered.list().total).toBe(2)
      expect(await readFile(join(library, 'originals', entries[0].id, 'original.jpg'))).toBeTruthy()
      expect(await readFile(join(restored, 'original.jpg'), 'utf8')).toBe(
        'keep this recovered original',
      )
      const check = new DatabaseSync(join(library, 'catalog.sqlite'))
      expect(check.prepare('SELECT * FROM removals').all()).toEqual([])
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 17 })
      check.close()
    } finally {
      await recovered.close()
    }
  } finally {
    await t.close()
  }
})
