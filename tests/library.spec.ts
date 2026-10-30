import { expect, test } from '@playwright/test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewEngine } from '../src/main/preview-engine'
import type { PreviewProcessor } from '../src/main/preview-types'

const photo = resolve('tests/fixtures/photos/alpine-lake.jpg')
const other = resolve('tests/fixtures/photos/mountain-ridge.jpg')

import { commit, scan, setup } from './library.helpers'

test('deduplicates by content within a batch and across imports, and preserves same-name files', async () => {
  const t = await setup()
  try {
    await mkdir(join(t.root, 'a'))
    await mkdir(join(t.root, 'b'))
    const first = join(t.root, 'a', 'same.jpg')
    const second = join(t.root, 'b', 'same.jpg')
    const duplicate = join(t.root, 'renamed.jpg')
    await copyFile(photo, first)
    await copyFile(other, second)
    await copyFile(photo, duplicate)
    const id = await scan(t.service, [first, second, duplicate])
    expect(t.service.review(id)).toMatchObject({ unchecked: 3, duplicates: 0, selected: 3 })
    await commit(t.service, id)
    expect(t.service.list().total).toBe(2)
    const repeated = await scan(t.service, [duplicate])
    expect(t.service.review(repeated)).toMatchObject({ unchecked: 1, selected: 1 })
    await commit(t.service, repeated)
    expect(t.service.review(repeated)).toMatchObject({ duplicates: 1, selected: 0 })
    expect(t.service.review(repeated).candidates[0].message).toBe('Already imported')
    expect(t.service.list().photos.map((photo) => photo.filename)).toEqual(['same.jpg', 'same.jpg'])
  } finally {
    await t.close()
  }
})

test('rejects a changed source and missing source without publishing incomplete records', async () => {
  const t = await setup()
  try {
    const source = join(t.root, 'source.jpg')
    const missing = join(t.root, 'missing.jpg')
    await copyFile(photo, source)
    await copyFile(other, missing)
    const id = await scan(t.service, [source, missing])
    await copyFile(other, source)
    await rm(missing)
    await commit(t.service, id)
    expect(t.service.review(id)).toMatchObject({ errors: 2, imported: 0 })
    expect(
      t.service.review(id).candidates.find((candidate) => candidate.filename === 'source.jpg')
        ?.message,
    ).toContain('source changed')
    expect(t.service.list().total).toBe(0)
    expect(await readdir(join(t.root, 'library', 'originals'))).toEqual([])
    await t.service.dispose(id)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    await t.close()
  }
})

test('reports a staging write failure and leaves the original intact', async () => {
  const t = await setup()
  try {
    const id = await scan(t.service, [photo])
    const candidate = t.service.review(id).candidates[0]
    // An existing file blocks the staging directory, simulating a filesystem write failure.
    await mkdir(join(t.root, 'library', 'staging', id), { recursive: true })
    await writeFile(join(t.root, 'library', 'staging', id, `copy-${candidate.id}`), 'blocked')
    await commit(t.service, id)
    expect(t.service.review(id)).toMatchObject({ errors: 1, imported: 0 })
    expect(t.service.list().total).toBe(0)
    expect((await readFile(photo)).length).toBeGreaterThan(0)
  } finally {
    await t.close()
  }
})

test('cancels scanning, cleans up the session and skips symlink loops and its own library', async () => {
  const engine = new PreviewEngine()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const t = await setup({
    process: async (_path, _output, signal) => {
      entered()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }),
      )
    },
    close: () => engine.close(),
  })
  try {
    const id = await t.service.scan([photo], true)
    await expect.poll(() => t.service.review(id).phase).toBe('review')
    t.service.importSelected(id)
    await started
    await t.service.cancel(id)
    expect(t.service.review(id).phase).toBe('cancelled')
    expect(t.service.list().total).toBe(0)
    await t.service.dispose(id)
    const source = join(t.root, 'source')
    await mkdir(source)
    await symlink(source, join(source, 'loop'))
    await symlink(join(t.root, 'library'), join(source, 'library'))
    const empty = await scan(t.service, [source, join(t.root, 'library')])
    expect(t.service.review(empty)).toMatchObject({ total: 0, skipped: 2 })
  } finally {
    await t.close()
  }
})

test('recovers orphan staging and unpublished originals while keeping committed photos', async () => {
  const t = await setup()
  try {
    const id = await scan(t.service, [photo])
    await commit(t.service, id)
    const saved = t.service.list().photos[0]
    await t.service.close()
    await mkdir(join(t.root, 'library', 'staging', 'interrupted'), { recursive: true })
    const orphan = 'a'.repeat(64)
    await mkdir(join(t.root, 'library', 'originals', orphan))
    const reopened = new PhotoLibrary(join(t.root, 'library'), new PreviewEngine(), () => {})
    await reopened.open()
    try {
      expect(reopened.list().photos).toEqual([saved])
      expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
      expect(await readdir(join(t.root, 'library', 'originals'))).toEqual([saved.id])
      const path = reopened.imagePath(saved.previewUrl)
      expect(path).toBe(join(t.root, 'library', 'originals', saved.id, 'preview.jpg'))
      for (const url of [
        'irodori-photo://library/../../catalog.sqlite',
        `irodori-photo://library/${saved.id}/original`,
        'irodori-photo://review/no-session/no-candidate/thumb',
        `irodori-photo://library/${orphan}/preview`,
      ])
        expect(reopened.imagePath(url)).toBeUndefined()
    } finally {
      await reopened.close()
    }
  } finally {
    await t.close()
  }
})

test('creates correctly oriented previews for JPEG, PNG and TIFF and rejects corrupt ARW', async () => {
  const t = await setup()
  try {
    const oriented = join(t.root, 'portrait.jpg')
    const png = join(t.root, 'image.png')
    const tiff = join(t.root, 'image.tiff')
    const invalid = join(t.root, 'invalid.ARW')
    await sharp({ create: { width: 80, height: 40, channels: 3, background: '#bf6525' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(oriented)
    await sharp(photo).resize(100).png().toFile(png)
    await sharp(photo).resize(120).tiff().toFile(tiff)
    await writeFile(invalid, 'invalid raw data')
    const id = await scan(t.service, [oriented, png, tiff, invalid])
    expect(t.service.review(id)).toMatchObject({ unchecked: 4, errors: 0, selected: 4 })
    await commit(t.service, id)
    expect(t.service.review(id)).toMatchObject({ imported: 3, errors: 1 })
    const record = t.service.list().photos.find((photo) => photo.filename === 'portrait.jpg')!
    expect(record).toMatchObject({ width: 40, height: 80 })
    const rendered = await sharp(t.service.imagePath(record.previewUrl)).metadata()
    expect(rendered).toMatchObject({ width: 40, height: 80 })
    expect(rendered.orientation).toBeUndefined()
  } finally {
    await t.close()
  }
})

test('cancellation keeps completed imports and prevents a second import from interleaving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-cancel-'))
  let committed!: () => void
  const firstCommitted = new Promise<void>((resolve) => {
    committed = resolve
  })
  const service = new PhotoLibrary(join(root, 'library'), new PreviewEngine(), (event) => {
    if (event.libraryChanged) committed()
  })
  await service.open()
  try {
    const id = await scan(service, [photo, other])
    service.importSelected(id)
    expect(() => service.importSelected(id)).toThrow('Finish or cancel')
    await expect(service.scan([photo], true)).rejects.toThrow('Finish or cancel')
    await firstCommitted
    await service.cancel(id)
    expect(service.review(id)).toMatchObject({ phase: 'cancelled', imported: 1 })
    expect(service.listTasks()[0]).toMatchObject({
      status: 'cancelled',
      errorCount: 0,
      items: { completed: 1, total: 2 },
    })
    expect(service.hasActiveTask()).toBe(false)
    expect(service.list().total).toBe(1)
    expect(
      await readFile(
        join(root, 'library', 'originals', service.list().photos[0].id, 'original.jpg'),
      ),
    ).toEqual(await readFile(photo))
    await service.dispose(id)
    expect(await readdir(join(root, 'library', 'staging'))).toEqual([])
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('delivers progress for the latest session when sources are replaced quickly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-events-'))
  const events: string[] = []
  const service = new PhotoLibrary(join(root, 'library'), new PreviewEngine(), (event) => {
    if (event.sessionId) events.push(event.sessionId)
  })
  await service.open()
  try {
    const first = await service.scan([], true)
    await expect.poll(() => service.review(first).phase, { intervals: [1] }).toBe('review')
    const second = await service.scan([], true)
    await expect.poll(() => service.review(second).phase, { intervals: [1] }).toBe('review')
    await expect.poll(() => events.includes(second)).toBe(true)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps fixed task totals and chunked errors after staging and review are disposed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-task-errors-'))
  const processor: PreviewProcessor = {
    process: async (_path, output) => {
      await copyFile(photo, join(output, 'thumb.jpg'))
      await copyFile(photo, join(output, 'preview.jpg'))
      return { metadata: { width: 1200, height: 800 }, source: 'image' }
    },
    close: async () => {},
  }
  const service = new PhotoLibrary(
    join(root, 'library'),
    processor,
    () => {},
    async () => {
      throw new Error('The card disconnected during copying.')
    },
  )
  await service.open()
  try {
    const sources: string[] = []
    for (let index = 0; index < 61; index++) {
      const path = join(root, `${index}.jpg`)
      await writeFile(path, String(index))
      sources.push(path)
    }
    const id = await scan(service, sources)
    const totalBytes = service.review(id).selectedBytes
    service.importSelected(id)
    expect(service.listTasks()[0]).toMatchObject({
      status: 'running',
      items: { completed: 0, total: 61 },
      progress: { completed: 0, total: 61 },
      transfer: { bytes: 0, totalBytes },
    })
    await expect(service.dismissTask(id)).rejects.toThrow('Cancel the task')
    await expect.poll(() => service.listTasks()[0].status).toBe('failed')
    expect(service.listTasks()[0]).toMatchObject({
      errorCount: 61,
      items: { completed: 0, total: 61 },
      progress: { completed: 61, total: 61 },
      transfer: { bytes: 0, totalBytes },
    })
    expect(await readdir(join(root, 'library', 'staging'))).toEqual([])
    await scan(service, [])
    expect(service.taskErrors(id).errors).toHaveLength(60)
    expect(service.taskErrors(id, 60)).toEqual({
      total: 61,
      errors: [{ filename: '60.jpg', message: 'The card disconnected during copying.' }],
    })
    const snapshot = service.listTasks()
    snapshot[0].items!.total = 0
    expect(service.listTasks()[0].items!.total).toBe(61)
    expect(() => service.taskErrors(id, -1)).toThrow('Invalid collection offset')
    await service.dismissTask(id)
    expect(service.listTasks()).toEqual([])
    expect(() => service.taskErrors(id)).toThrow('dismissed')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('locates the selected photo and its neighbors after new imports move it to another page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-navigation-'))
  const processor: PreviewProcessor = {
    process: async (_path, output) => {
      await copyFile(photo, join(output, 'thumb.jpg'))
      await copyFile(photo, join(output, 'preview.jpg'))
      return { metadata: { width: 1200, height: 800 }, source: 'image' }
    },
    close: async () => {},
  }
  const service = new PhotoLibrary(join(root, 'library'), processor, () => {})
  await service.open()
  try {
    const id = await scan(service, [photo])
    await commit(service, id)
    const selected = service.list().photos[0].id
    const sources: string[] = []
    for (let index = 0; index < 60; index++) {
      const path = join(root, `${index}.jpg`)
      await writeFile(path, String(index))
      sources.push(path)
    }
    await commit(service, await scan(service, sources))
    expect(service.locateGalleryPhoto(selected)).toMatchObject({
      index: 60,
      offset: 60,
      total: 61,
      entries: [{ photo: { id: selected } }],
    })
    expect(service.locateGalleryPhoto(selected, 1)).toBeNull()
    const previous = service.locateGalleryPhoto(selected, -1)!
    expect(previous).toMatchObject({ index: 59, offset: 0, total: 61 })
    expect(previous.entries.map((e) => e.photo)[59].filename).toBe('0.jpg')
    const newest = previous.entries.map((e) => e.photo)[0].id
    const range = service.getGalleryRange(newest, selected)
    expect(range).toHaveLength(61)
    expect(service.getGalleryRange(selected, newest)).toEqual(range)
    expect(range[60].id).toBe(selected)
    expect(service.getGalleryRange('f'.repeat(64), selected)).toEqual([
      { id: selected, filename: 'alpine-lake.jpg' },
    ])
    expect(
      service.locateGalleryPhoto(previous.entries.map((e) => e.photo)[59].id, 1)?.entries[0].photo
        .id,
    ).toBe(selected)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
