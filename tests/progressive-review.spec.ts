import { expect, test } from '@playwright/test'
import { copyFile, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { PhotoLibrary } from '../src/main/library'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import { ReviewThumbnails } from '../src/main/review-thumbnails'
import type { ThumbnailProcessor } from '../src/main/preview-types'
import { commit, scan, setup } from './library.helpers'

const photo = resolve('tests/fixtures/photos/alpine-lake.jpg')
const other = resolve('tests/fixtures/photos/mountain-ridge.jpg')

test('reviews files and recursive folders newest first while preserving choices as discoveries reorder records', async () => {
  const t = await setup()
  try {
    const source = join(t.root, 'source')
    await mkdir(source)
    const bytes = await readFile(photo)
    const paths: string[] = []
    for (let index = 0; index < 65; index++) {
      const path = join(source, `${String(index).padStart(3, '0')}.jpg`)
      await writeFile(path, bytes)
      const date = new Date(Date.UTC(2024, 0, 1) + index * 60_000)
      await utimes(path, date, date)
      paths.push(path)
    }
    // Oldest-first discovery makes each subsequent row move to the front.
    const id = await t.service.scan(paths, false)
    while (!t.service.review(id).total) await new Promise<void>((resolve) => setImmediate(resolve))
    const early = t.service.review(id)
    expect(early.phase).toBe('scanning')
    const chosen = early.candidates[0]
    t.service.select(id, [chosen.id], false)
    await expect.poll(() => t.service.review(id).phase).toBe('review')
    const firstPage = t.service.review(id)
    const lastPage = t.service.review(id, 60)
    expect(firstPage.candidates.map((candidate) => candidate.filename)).toEqual(
      paths
        .slice(5)
        .reverse()
        .map((path) => basename(path)),
    )
    expect(lastPage.candidates.map((candidate) => candidate.filename)).toEqual([
      '004.jpg',
      '003.jpg',
      '002.jpg',
      '001.jpg',
      '000.jpg',
    ])
    const ordered = [...firstPage.candidates, ...lastPage.candidates]
    expect(ordered.findIndex((candidate) => candidate.id === chosen.id)).toBeGreaterThan(0)
    expect(ordered.find((candidate) => candidate.id === chosen.id)).toMatchObject({
      filename: chosen.filename,
      selected: false,
      status: 'unchecked',
      thumbnailState: 'idle',
    })
    expect(firstPage).toMatchObject({ selected: 64, selectionRevision: 1 })
    const folder = await scan(t.service, [source], true)
    expect(t.service.review(folder).candidates.map((candidate) => candidate.filename)).toEqual(
      firstPage.candidates.map((candidate) => candidate.filename),
    )
    expect(t.service.review(folder, 60).candidates.map((candidate) => candidate.filename)).toEqual(
      lastPage.candidates.map((candidate) => candidate.filename),
    )
    expect(t.service.review(folder).selected).toBe(65)
  } finally {
    await t.close()
  }
})

test('enumeration, paging and selection proceed while visible thumbnails are held behind a gate', async () => {
  const t = await setup()
  await t.service.close()
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let exited = false
  const held: ThumbnailProcessor = {
    thumbnail: async (_path, _output, signal) => {
      started()
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            exited = true
            reject(new Error('Cancelled'))
          },
          { once: true },
        ),
      )
    },
    close: async () => {},
  }
  let preparations = 0
  const engine = new PreviewEngine()
  const service = new PhotoLibrary(
    join(t.root, 'library'),
    {
      process: async (...args) => {
        preparations++
        return engine.process(args[0], args[1])
      },
      close: () => engine.close(),
    },
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (onState) => new ReviewThumbnails(onState, held, held),
  )
  await service.open()
  try {
    const source = join(t.root, 'source')
    await mkdir(source)
    const bytes = await readFile(photo)
    for (let i = 0; i < 121; i++)
      await writeFile(
        join(source, `${String(i).padStart(3, '0')}.jpg`),
        Buffer.concat([bytes, Buffer.from(String(i))]),
      )
    const id = await service.scan([source], true)
    // Bulk intent applies to rows discovered after this synchronous selection.
    service.select(id, null, false)
    await expect.poll(() => service.review(id).total).toBeGreaterThan(0)
    const first = service.review(id).candidates[0]
    service.requestReviewThumbnails(id, [first.id])
    await entered
    await expect.poll(() => service.review(id).phase).toBe('review')
    expect(preparations).toBe(0)
    expect(service.review(id)).toMatchObject({
      total: 121,
      unchecked: 121,
      selected: 0,
      selectionRevision: 1,
    })
    const secondPage = service.review(id, 60)
    expect(secondPage.candidates).toHaveLength(60)
    expect(secondPage.candidates.every((c) => c.status === 'unchecked' && !c.selected)).toBe(true)
    service.select(id, [secondPage.candidates[0].id], true)
    service.select(id, [secondPage.candidates[0].id], false)
    service.select(id, [secondPage.candidates[0].id], true)
    expect(service.review(id)).toMatchObject({ selected: 1, selectionRevision: 4 })
    service.importSelected(id)
    await expect.poll(() => service.review(id).phase).toBe('complete')
    expect(exited).toBe(true)
    expect(preparations).toBe(1)
    expect(service.list().photos[0].filename).toBe(secondPage.candidates[0].filename)
    expect(service.listTasks()[0]).toMatchObject({
      outcomes: { processed: 1, imported: 1, duplicates: 0, failed: 0 },
    })
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    await service.close()
    await t.close()
  }
})

test('accepts unchecked files and prepares selected unique staged originals only with fixed totals', async () => {
  const prepared: string[] = []
  const engine = new PreviewEngine()
  const t = await setup({
    process: async (...args) => {
      prepared.push(args[0])
      return engine.process(args[0], args[1])
    },
    close: () => engine.close(),
  })
  try {
    const a = join(t.root, 'a.jpg'),
      duplicate = join(t.root, 'duplicate.jpg'),
      invalid = join(t.root, 'invalid.jpg')
    const missing = join(t.root, 'missing.jpg'),
      excluded = join(t.root, 'excluded.jpg')
    await copyFile(photo, a)
    await copyFile(photo, duplicate)
    await writeFile(invalid, 'broken image')
    await copyFile(other, missing)
    await copyFile(other, excluded)
    const id = await scan(t.service, [a, duplicate, invalid, missing, excluded])
    const review = t.service.review(id)
    expect(review).toMatchObject({ unchecked: 5, selected: 5, errors: 0, duplicates: 0 })
    expect(prepared).toEqual([])
    t.service.select(
      id,
      [review.candidates.find((candidate) => candidate.filename === 'excluded.jpg')!.id],
      false,
    )
    await rm(missing)
    const totalBytes = t.service.review(id).selectedBytes
    await commit(t.service, id)
    expect(prepared).toHaveLength(2)
    expect(
      prepared.every((path) =>
        path.includes(`${join('staging', id)}${process.platform === 'win32' ? '\\' : '/'}`),
      ),
    ).toBe(true)
    expect(t.service.listTasks()[0]).toMatchObject({
      progress: { total: 4, completed: 4, unit: 'items' },
      transfer: { totalBytes },
      items: { total: 4, completed: 1 },
      outcomes: { processed: 4, imported: 1, duplicates: 1, failed: 2 },
      errorCount: 2,
    })
    expect(t.service.list().total).toBe(1)
    expect(
      await readFile(
        join(t.root, 'library', 'originals', t.service.list().photos[0].id, 'original.jpg'),
      ),
    ).toEqual(await readFile(photo))
    const next = await scan(t.service, [duplicate])
    await commit(t.service, next)
    expect(prepared).toHaveLength(2)
    expect(t.service.listTasks()[1]).toMatchObject({
      outcomes: { processed: 1, imported: 0, duplicates: 1, failed: 0 },
    })
  } finally {
    await t.close()
  }
})

test('retries identical selected content after preparation fails and skips only published duplicates', async () => {
  const engine = new PreviewEngine()
  let preparations = 0
  const t = await setup({
    process: async (...args) => {
      if (++preparations === 1) throw new Error('The preparation worker exited')
      return engine.process(args[0], args[1])
    },
    close: () => engine.close(),
  })
  try {
    const paths = ['first.jpg', 'retry.jpg', 'duplicate.jpg'].map((name) => join(t.root, name))
    for (const path of paths) await copyFile(photo, path)
    const id = await scan(t.service, paths)
    const totalBytes = t.service.review(id).selectedBytes
    await commit(t.service, id)
    expect(preparations).toBe(2)
    expect(t.service.listTasks()[0]).toMatchObject({
      items: { total: 3, completed: 1 },
      progress: { total: 3, completed: 3, unit: 'items' },
      transfer: { totalBytes, bytes: totalBytes },
      outcomes: { processed: 3, imported: 1, duplicates: 1, failed: 1 },
      errorCount: 1,
    })
    const imported = t.service.list().photos
    expect(imported).toHaveLength(1)
    expect(imported[0].filename).toBe('retry.jpg')
    expect(
      await readFile(join(t.root, 'library', 'originals', imported[0].id, 'original.jpg')),
    ).toEqual(await readFile(photo))
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    await t.close()
  }
})

test('checks source identity before and after copying, including same-size replacement', async () => {
  const t = await setup()
  try {
    const source = join(t.root, 'source.jpg')
    await copyFile(photo, source)
    const id = await scan(t.service, [source])
    const bytes = await readFile(source)
    await rm(source)
    await writeFile(source, bytes)
    await commit(t.service, id)
    expect(t.service.review(id).candidates[0].message).toContain('source changed')
    expect(t.service.list().total).toBe(0)
  } finally {
    await t.close()
  }
  const changed = await setup()
  await changed.service.close()
  const service = new PhotoLibrary(
    join(changed.root, 'library'),
    new PreviewEngine(),
    () => {},
    async (source, destination, signal, progress) => {
      const { copyOriginal } = await import('../src/main/copy-original')
      const hash = await copyOriginal(source, destination, signal, progress)
      await writeFile(source, await readFile(other))
      return hash
    },
    undefined,
    new PreviewProcess(resolve('out/main/preview-worker.js')),
  )
  await service.open()
  try {
    const source = join(changed.root, 'source.jpg')
    await copyFile(photo, source)
    await commit(service, await scan(service, [source]))
    expect(service.listTasks()[0].outcomes?.failed).toBe(1)
    expect(service.list().total).toBe(0)
    expect(await readdir(join(changed.root, 'library', 'originals'))).toEqual([])
  } finally {
    await service.close()
    await changed.close()
  }
})

test('source replacement waits for active thumbnail cleanup and ignores expired review results', async () => {
  const t = await setup()
  await t.service.close()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let work = Promise.resolve()
  const service = new PhotoLibrary(
    join(t.root, 'library'),
    new PreviewEngine(),
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (onState) => ({
      request: (inputs) => {
        if (!inputs.length) return
        const input = inputs[0]
        onState(input.id, { state: 'loading' })
        work = (async () => {
          await mkdir(input.output, { recursive: true })
          started()
          await gate
          // A worker finishing after cancellation must not republish this row.
          await writeFile(join(input.output, 'thumb.jpg'), 'late worker output')
          onState(input.id, { state: 'ready' })
        })()
      },
      cancel: () => work,
    }),
  )
  await service.open()
  try {
    const first = await scan(service, [photo])
    const candidate = service.review(first).candidates[0]
    service.requestReviewThumbnails(first, [candidate.id])
    await entered
    let replaced = false
    const replacing = service.scan([other], true).then((id) => {
      replaced = true
      return id
    })
    expect(() => service.importSelected(first)).toThrow('Finish or cancel')
    expect(() => service.select(first, null, true)).toThrow('no longer selectable')
    expect((await readdir(join(t.root, 'library', 'staging', first))).length).toBe(1)
    expect(replaced).toBe(false)
    release()
    const second = await replacing
    await expect.poll(() => service.review(second).phase).toBe('review')
    expect(service.review(second).candidates[0]).toMatchObject({
      filename: 'mountain-ridge.jpg',
      thumbnailState: 'idle',
    })
    expect(() => service.review(first)).toThrow('expired')
    expect(() => service.requestReviewThumbnails(first, [candidate.id])).not.toThrow()
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
    // Discovery itself is cancellable, with no need to enter a photo worker.
    const cancelled = await service.scan([photo], true)
    await service.cancel(cancelled)
    expect(service.review(cancelled).phase).toBe('cancelled')
    expect(service.list().total).toBe(0)
  } finally {
    release()
    await service.close()
    await t.close()
  }
})
