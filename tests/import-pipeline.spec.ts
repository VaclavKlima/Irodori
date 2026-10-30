import { seedFixtureEdits } from './catalog-fixture.helpers'
import type { PreviewProcess } from '../src/main/preview-process'
import { expect, test } from '@playwright/test'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PhotoLibrary } from './photo-library.helpers'
import { copyOriginal } from '../src/main/copy-original'
import type { PreviewProcessor, PreviewResult } from '../src/main/preview-types'
import type { ImportPipelineOptions } from '../src/main/import-pipeline'
import { scan } from './library.helpers'
import { DeviceUnavailableError, type DeviceSource } from '../src/main/import-devices'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { syntheticMerge } from './merge.helpers'
import { PROCESSING_METADATA_VERSION, type ProcessingMetadata } from '../src/shared/lens'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const result: PreviewResult = { metadata: { width: 12, height: 8 }, source: 'image' }
async function setup(
  processor: PreviewProcessor,
  transfer = copyOriginal,
  options: ImportPipelineOptions = {},
  trash?: (path: string) => Promise<void>,
  capture?: Pick<PreviewProcess, 'inspectCapture' | 'close'>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'irodori-pipeline-')))
  const library = new PhotoLibrary(
    join(root, 'library'),
    processor,
    () => {},
    transfer,
    trash ??
      (async (path) => {
        await rename(path, join(root, basename(path)))
      }),
    undefined,
    undefined,
    undefined,
    capture,
    undefined,
    undefined,
    options,
  )
  await library.open()
  const paths = []
  for (let i = 0; i < 8; i++) {
    const path = join(root, `${i}.jpg`)
    await writeFile(path, `photo ${i}`)
    paths.push(path)
  }
  return {
    root,
    library,
    paths,
    close: async () => {
      await library.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
async function finished(library: PhotoLibrary, id: string) {
  await expect
    .poll(() => library.listTasks().find((t) => t.id === id)?.status)
    .not.toMatch(/^(running|cancelling)$/)
  return library.listTasks().find((t) => t.id === id)!
}
test('accepted import copies and prepares during local GPU activity while publication waits', async () => {
  const t = await setup({ process: async () => result, close: async () => {} })
  try {
    const id = await scan(t.library, t.paths)
    t.library.scheduler.activity('local GPU slider', true)
    await t.library.importSelected(id)
    await expect
      .poll(() => t.library.listTasks().find((task) => task.id === id)?.transfer?.prepared)
      .toBeGreaterThan(0)
    await expect
      .poll(() => t.library.listTasks().find((task) => task.id === id)?.transfer?.copied)
      .toBeGreaterThan(1)
    expect(t.library.list().total).toBe(0)
    expect(t.library.listTasks().find((task) => task.id === id)?.status).toBe('running')
    t.library.scheduler.activity('local GPU slider', false)
    expect(await finished(t.library, id)).toMatchObject({
      status: 'completed',
      errorCount: 0,
      outcomes: { imported: t.paths.length },
      transfer: { copied: t.paths.length, prepared: t.paths.length },
    })
    expect(t.library.list().total).toBe(t.paths.length)
  } finally {
    t.library.scheduler.activity('local GPU slider', false)
    await t.close()
  }
})
test('copying overlaps two preparation workers and respects candidate and reserved-byte limits', async () => {
  const hold = gate()
  let preparing = 0,
    peakWorkers = 0,
    copied = 0
  const factory = (): PreviewProcessor => ({
    createWorker: factory,
    process: async () => {
      preparing++
      peakWorkers = Math.max(peakWorkers, preparing)
      await hold.promise
      preparing--
      return result
    },
    close: async () => {},
  })
  const t = await setup(
    factory(),
    async (...args) => {
      const hash = await copyOriginal(...args)
      copied++
      return hash
    },
    { workers: 2, maxBytes: 21 },
  )
  try {
    const id = await scan(t.library, t.paths)
    t.library.importSelected(id)
    await expect.poll(() => [copied, preparing]).toEqual([3, 2])
    expect(t.library.listTasks()[0]).toMatchObject({
      transfer: { copied: 3, prepared: 0 },
      progress: { completed: 0, total: 8 },
      importMeasurements: { stagingPeakBytes: 21, inFlightPeak: 3 },
    })
    hold.release()
    expect(await finished(t.library, id)).toMatchObject({
      status: 'completed',
      transfer: { copied: 8, prepared: 8, bytes: 56, totalBytes: 56 },
      outcomes: { imported: 8, processed: 8 },
    })
    expect(peakWorkers).toBe(2)
    for (const photo of t.library.list().photos)
      expect(
        await readFile(join(t.root, 'library', 'originals', photo.id, 'original.jpg'), 'utf8'),
      ).toBe(`photo ${photo.filename[0]}`)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    hold.release()
    await t.close()
  }
})
test('a file larger than the staging budget runs alone and cancellation drains admitted workers', async () => {
  const hold = gate()
  let calls = 0
  const t = await setup(
    {
      process: async (_p, _o, signal) => {
        calls++
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
          void hold.promise.then(resolve)
        })
        signal.throwIfAborted()
        return result
      },
      close: async () => {},
    },
    copyOriginal,
    { maxBytes: 4 },
  )
  try {
    const id = await scan(t.library, t.paths)
    t.library.importSelected(id)
    await expect.poll(() => calls).toBe(1)
    expect(t.library.listTasks()[0].importMeasurements).toMatchObject({
      inFlightPeak: 1,
      stagingPeakBytes: 7,
    })
    await t.library.cancelTask(id)
    expect(t.library.list().total).toBe(0)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    hold.release()
    await t.close()
  }
})
test('a waiting duplicate is promoted after its owner crashes; published content alone counts as a duplicate', async () => {
  const hold = gate()
  let calls = 0,
    copies = 0
  const t = await setup(
    {
      process: async () => {
        if (++calls === 1) {
          await hold.promise
          throw new Error('Worker crashed')
        }
        return result
      },
      close: async () => {},
    },
    async (...args) => {
      const h = await copyOriginal(...args)
      copies++
      return h
    },
  )
  try {
    for (const path of t.paths) await writeFile(path, 'identical')
    const id = await scan(t.library, t.paths.slice(0, 3))
    t.library.importSelected(id)
    await expect.poll(() => copies).toBe(3)
    hold.release()
    expect(await finished(t.library, id)).toMatchObject({
      status: 'failed',
      outcomes: { processed: 3, imported: 1, failed: 1, duplicates: 1 },
    })
    expect(calls).toBe(2)
  } finally {
    hold.release()
    await t.close()
  }
})
test('disposing accepted review preserves import lifetime; paused copy cancellation unblocks without publication', async () => {
  const t = await setup({ process: async () => result, close: async () => {} })
  const hold = gate()
  let foreground: Promise<void> | undefined
  try {
    const id = await scan(t.library, t.paths)
    foreground = t.library.scheduler.run('interactive', () => hold.promise)
    t.library.importSelected(id)
    await t.library.dispose(id)
    expect(t.library.listTasks()[0]).toMatchObject({
      status: 'running',
      waitingReason: 'foreground',
      transfer: { copied: 0 },
    })
    await t.library.cancelTask(id)
    expect(await finished(t.library, id)).toMatchObject({
      status: 'cancelled',
      outcomes: { imported: 0 },
    })
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    hold.release()
    await foreground
    await t.close()
  }
})
test('deletion during import suppresses later copies of that content only for this task', async () => {
  let pause = false
  const entered = gate(),
    resume = gate()
  const t = await setup({ process: async () => result, close: async () => {} }, async (...args) => {
    if (pause) {
      entered.release()
      await resume.promise
    }
    return copyOriginal(...args)
  })
  try {
    const first = await scan(t.library, [t.paths[0]])
    t.library.importSelected(first)
    await finished(t.library, first)
    const photo = t.library.list().photos[0]
    await t.library.dispose(first)
    const repeated = join(t.root, 'repeat.jpg')
    await writeFile(repeated, 'photo 0')
    const id = await scan(t.library, [t.paths[1], repeated])
    pause = true
    t.library.importSelected(id)
    await entered.promise
    const deletion = t.library.deletePhotos([photo.id])!
    expect(await finished(t.library, deletion)).toMatchObject({ status: 'completed' })
    resume.release()
    expect(await finished(t.library, id)).toMatchObject({
      status: 'completed',
      skippedAfterDeletion: 1,
      outcomes: { processed: 2, imported: 1, duplicates: 0 },
    })
    expect(t.library.listTasks().find((t) => t.id === first)?.outcomes?.imported).toBe(1)
    await t.library.dispose(id)
    const next = await scan(t.library, [repeated])
    t.library.importSelected(next)
    await finished(t.library, next)
    expect(t.library.list().total).toBe(2)
  } finally {
    resume.release()
    await t.close()
  }
})
test('failed and unattempted deletion targets remain eligible while successful partial deletion suppresses import duplicates', async () => {
  const copying = gate(),
    resumeCopy = gate(),
    trashEntered = gate(),
    finishTrash = gate()
  let pause = false,
    attempts = 0,
    root = ''
  const t = await setup(
    { process: async () => result, close: async () => {} },
    async (...args) => {
      if (pause) {
        copying.release()
        await resumeCopy.promise
      }
      return copyOriginal(...args)
    },
    {},
    async (path) => {
      if (++attempts === 1) throw new Error('Isolated Trash failed')
      trashEntered.release()
      await finishTrash.promise
      await rename(path, join(root, basename(path)))
    },
  )
  root = t.root
  try {
    const initial = await scan(t.library, t.paths.slice(0, 3))
    t.library.importSelected(initial)
    await finished(t.library, initial)
    const targets = [0, 1, 2].map(
      (i) => t.library.list().photos.find((p) => p.filename === `${i}.jpg`)!.id,
    )
    await t.library.dispose(initial)
    const id = await scan(t.library, [t.paths[3], ...t.paths.slice(0, 3)])
    pause = true
    t.library.importSelected(id)
    await copying.promise
    const deletion = t.library.deletePhotos(targets)!
    await trashEntered.promise
    const cancelling = t.library.cancelTask(deletion)
    finishTrash.release()
    await cancelling
    expect(await finished(t.library, deletion)).toMatchObject({
      status: 'cancelled',
      errorCount: 1,
      items: { completed: 1, total: 3 },
      progress: { completed: 2, total: 3 },
    })
    expect(attempts).toBe(2)
    expect(
      await readFile(join(root, 'library', 'originals', targets[0], 'original.jpg'), 'utf8'),
    ).toBe('photo 0')
    expect(await readdir(join(root, 'library', 'removed'))).toEqual([])
    resumeCopy.release()
    expect(await finished(t.library, id)).toMatchObject({
      status: 'completed',
      skippedAfterDeletion: 1,
      outcomes: { processed: 4, imported: 1, duplicates: 2, failed: 0 },
    })
    expect(t.library.list().total).toBe(3)
    expect(t.library.listTasks().find((t) => t.id === initial)?.outcomes?.imported).toBe(3)
  } finally {
    resumeCopy.release()
    finishTrash.release()
    await t.close()
  }
})

test('cached edits and lens settings remain readable during an in-flight Trash move without touching the staged original', async () => {
  const entered = gate(),
    finishTrash = gate()
  const processing: ProcessingMetadata = {
    version: PROCESSING_METADATA_VERSION,
    lensProfile: {
      provider: 'test',
      version: '1',
      label: 'Raster fixture',
      identity: 'test-raster',
      unavailable: {},
    },
  }
  let root = ''
  const t = await setup(
    { process: async () => ({ ...result, processing }), close: async () => {} },
    copyOriginal,
    {},
    async (path) => {
      entered.release()
      await finishTrash.promise
      await rename(path, join(root, basename(path)))
    },
  )
  root = t.root
  try {
    const id = await scan(t.library, t.paths.slice(0, 1))
    t.library.importSelected(id)
    await finished(t.library, id)
    const photo = t.library.list().photos[0]
    const deletion = t.library.deletePhotos([photo.id])!
    await entered.promise
    expect(await readdir(join(root, 'library', 'originals'))).toEqual([])
    const reads: unknown[] = []
    const lens = t.library.getLensSettings(photo.id).then((value) => {
      reads.push(value)
      return value
    })
    const edits = t.library.getEdits(photo.id).then((value) => {
      reads.push(value)
      return value
    })
    await expect.poll(() => reads.length).toBe(2)
    expect(await lens).toMatchObject({
      photoId: photo.id,
      revision: 0,
      profile: processing.lensProfile,
    })
    expect(await edits).toMatchObject({ photoId: photo.id, revision: 0 })
    expect(t.library.listTasks().find((t) => t.id === deletion)?.status).toBe('running')
    finishTrash.release()
    expect(await finished(t.library, deletion)).toMatchObject({ status: 'completed' })
    await expect(t.library.getLensSettings(photo.id)).rejects.toThrow('unavailable')
    await expect(t.library.getEdits(photo.id)).rejects.toThrow('unavailable')
  } finally {
    finishTrash.release()
    await t.close()
  }
})

test('replaced device stops source admission but allows validated staging to finish and reports one source error', async () => {
  const held = gate()
  const t = await setup({
    process: async () => {
      await held.promise
      return result
    },
    close: async () => {},
  })
  try {
    const info = await stat(t.root)
    const source: DeviceSource = {
      deviceId: 'test',
      displayName: 'card',
      roots: [
        {
          path: t.root,
          identity: 'volume',
          filesystemDevice: String(info.dev),
          filesystemIdentity: `${info.dev}:${info.ino}`,
          nestedMounts: [],
        },
      ],
    }
    const id = await t.library.scan(t.paths, false, {
      source,
      validate: async () => {
        if (t.library.listTasks().some((task) => task.transfer?.copied === 1))
          throw new DeviceUnavailableError()
      },
    })
    await expect.poll(() => t.library.review(id).phase).toBe('review')
    await t.library.importSelected(id)
    await expect.poll(() => t.library.listTasks()[0].errorCount).toBe(1)
    held.release()
    expect(await finished(t.library, id)).toMatchObject({
      status: 'failed',
      errorCount: 1,
      unprocessed: 6,
      transfer: { copied: 1 },
      outcomes: { imported: 1, failed: 1, processed: 2 },
    })
  } finally {
    held.release()
    await t.close()
  }
})
test('unresolved removal journal prevents queued import publication', async () => {
  const hold = gate(),
    entered = gate()
  const t = await setup({
    process: async () => {
      entered.release()
      await hold.promise
      return result
    },
    close: async () => {},
  })
  try {
    const id = await scan(t.library, [t.paths[0]])
    t.library.importSelected(id)
    await entered.promise
    const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    const hash = 'f'.repeat(64)
    db.prepare('INSERT INTO removals VALUES (?, ?)').run(hash, `${hash}-${randomUUID()}`)
    db.close()
    hold.release()
    expect(await finished(t.library, id)).toMatchObject({
      status: 'failed',
      outcomes: { imported: 0 },
    })
    expect(t.library.taskErrors(id).errors[0].message).toContain('needs recovery')
  } finally {
    hold.release()
    await t.close()
  }
})

test('merge inspection, computation and publication run during accepted import; idle reviews release priority and retain source pins', async () => {
  const held = gate(),
    entered = gate(),
    computing = gate(),
    renderStarted = gate()
  const f = await syntheticMerge([1, 1])
  const t = await setup(
    { process: async () => result, close: async () => {} },
    async (...args) => {
      entered.release()
      await held.promise
      return copyOriginal(...args)
    },
    {},
    undefined,
    {
      inspectCapture: async (_path, signal) => {
        signal.throwIfAborted()
        return { version: 2, format: 'ARW' }
      },
      close: async () => {},
    },
  )
  try {
    const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    for (const source of f.sources) {
      const directory = join(t.root, 'library', 'originals', source.photo.id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'original.arw'), 'isolated managed merge source')
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
      seedFixtureEdits(db)
    }
    db.close()
    const id = await scan(t.library, t.paths.slice(0, 2))
    t.library.importSelected(id)
    await entered.promise
    const review = await t.library.createMergeReview(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    expect(t.library.scheduler.waitingReason).toBeUndefined()
    expect(() => t.library.deletePhotos([f.sources[0].photo.id])).toThrow('merge review')
    t.library.merges.worker.run = async (job) => {
      renderStarted.release()
      await computing.promise
      await cp(f.output, job.output, { recursive: true })
      return f.result
    }
    const preview = t.library.requestMergePreview(review.id, 0)
    await renderStarted.promise
    expect(t.library.scheduler.waitingReason).toBe('library-operation')
    computing.release()
    await preview
    expect(t.library.scheduler.waitingReason).toBeUndefined()
    const merge = t.library.startMerge(review.id, 0)
    expect(await finished(t.library, merge)).toMatchObject({ status: 'completed' })
    expect(t.library.listTasks().find((t) => t.id === id)?.status).toBe('running')
    held.release()
    await finished(t.library, id)
    expect(t.library.list().total).toBe(5)
  } finally {
    held.release()
    computing.release()
    await t.close()
    await f.close()
  }
})

test('resuming a partial copy freshly validates source identity before reading another chunk', async () => {
  const paused = gate()
  const t = await setup(
    { process: async () => result, close: async () => {} },
    async (source, destination, signal, progress, control) =>
      copyOriginal(
        source,
        destination,
        signal,
        (bytes) => {
          progress(bytes)
          t.library.scheduler.activity('editing', true)
          paused.release()
        },
        control,
      ),
  )
  const library = t.library
  try {
    await writeFile(t.paths[0], Buffer.alloc(3 * 1024 ** 2, 7))
    const id = await scan(library, [t.paths[0]])
    library.importSelected(id)
    await paused.promise
    await writeFile(t.paths[0], Buffer.alloc(3 * 1024 ** 2, 8))
    library.scheduler.activity('editing', false)
    expect(await finished(library, id)).toMatchObject({
      status: 'failed',
      transfer: { copied: 0, prepared: 0 },
    })
    expect(library.taskErrors(id).errors[0].message).toContain('source changed')
    expect(library.list().total).toBe(0)
  } finally {
    library.scheduler.activity('editing', false)
    await t.close()
  }
})

test('RAW fallback occupies one slot, yields only after exit, and retries from the staged original', async () => {
  const exit = gate(),
    entered = gate(),
    foregroundGate = gate()
  let fallbacks = 0,
    activeFallbacks = 0,
    peakFallbacks = 0,
    foreground = false
  const factory = (): PreviewProcessor => ({
    createWorker: factory,
    process: async () => result,
    prepare: async (path, directory, signal, fallback, seed) => {
      if (!fallback) return { ...result, needsFallback: true }
      expect(seed?.needsFallback).toBe(true)
      activeFallbacks++
      peakFallbacks = Math.max(peakFallbacks, activeFallbacks)
      try {
        if (++fallbacks === 1) {
          await writeFile(join(directory, 'preview.jpg'), 'incomplete native asset')
          entered.release()
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          await exit.promise
          expect(await readFile(path, 'utf8')).toMatch(/^photo/)
          throw new Error('Decoder exited after preemption')
        }
        return result
      } finally {
        activeFallbacks--
      }
    },
    close: async () => {},
  })
  const t = await setup(factory(), copyOriginal, { workers: 2 })
  try {
    const id = await scan(t.library, t.paths.slice(0, 3))
    t.library.importSelected(id)
    await entered.promise
    const work = t.library.scheduler.run('interactive', async () => {
      foreground = true
      await foregroundGate.promise
    })
    expect(foreground).toBe(false)
    exit.release()
    await expect.poll(() => foreground).toBe(true)
    expect(t.library.list().total).toBe(0)
    foregroundGate.release()
    await work
    expect(await finished(t.library, id)).toMatchObject({
      status: 'completed',
      transfer: { prepared: 3, copied: 3 },
      outcomes: { imported: 3 },
    })
    expect(fallbacks).toBe(4)
    expect(peakFallbacks).toBe(1)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    exit.release()
    foregroundGate.release()
    await t.close()
  }
})
