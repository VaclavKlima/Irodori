import { seedFixtureEdits } from './catalog-fixture.helpers'
import { test, expect } from '@playwright/test'
import { copyFile, mkdtemp, rm, writeFile, readFile, access, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { PreviewProcess } from '../src/main/preview-process'
import { PhotoLibrary } from './photo-library.helpers'
import { detectCaptureSequences, type CaptureMetadata } from '../src/shared/capture-sequence'
import { sequenceMetadata } from './capture.helpers'
import { stackFixture, finishTask } from './stack.helpers'
import { scan, commit } from './library.helpers'
import type { CaptureMetadataProcessor, PreviewProcessor } from '../src/main/preview-types'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
import { identityMatrix, WHITE_BALANCE_MODEL } from '../src/shared/white-balance'
import type { WorkScheduler } from '../src/main/work-scheduler'

test('real ZV-1A twelve-frame burst is positive evidence and nine shutter-varied single shots are negative', async () => {
  const directory = resolve(
    process.env.LUMA_CAPTURE_FIXTURES ?? 'artifacts/fixtures/sony-2026-10-04',
  )
  test.skip(
    !(await access(join(directory, 'DSC03246.ARW')).then(
      () => true,
      () => false,
    )),
    'Private supplied camera fixtures are unavailable; set LUMA_CAPTURE_FIXTURES. BRK is not verified.',
  )
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const burst: { id: string; metadata: CaptureMetadata }[] = [],
    single: typeof burst = []
  try {
    for (let index = 3246; index <= 3266; index++) {
      const path = join(directory, `DSC0${index}.ARW`)
      const before = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
      const metadata = await worker.inspectCapture(path, new AbortController().signal)
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ).toBe(before)
      ;(index <= 3257 ? burst : single).push({ id: before, metadata })
    }
    expect(burst).toHaveLength(12)
    expect(burst[1].metadata.subSecTimeOriginal).toBe('006')
    expect(burst[11].metadata.subSecTimeOriginal).toBe('006')
    expect(detectCaptureSequences([...burst].reverse())[0].ids).toEqual(burst.map((p) => p.id))
    expect(detectCaptureSequences(single)).toEqual([])
    expect(detectCaptureSequences([...single, ...burst])).toHaveLength(1)
  } finally {
    await worker.close()
  }
})

test('successful shuffled imports reconcile cached sequences across batches and preserve manual overrides on scans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-capture-import-'))
  const fixture = resolve('tests/fixtures/photos/alpine-lake.jpg')
  const processor: PreviewProcessor = {
    process: async (path, output) => {
      await copyFile(fixture, join(output, 'thumb.jpg'))
      await copyFile(fixture, join(output, 'preview.jpg'))
      return {
        metadata: { width: 1200, height: 800 },
        source: 'embedded',
        captureMetadata: sequenceMetadata(
          Number((await readFile(path, 'utf8')).split(' ').at(-1)) + 1,
        ),
      }
    },
    close: async () => {},
  }
  const library = new PhotoLibrary(
    join(root, 'library'),
    processor,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      inspectCapture: async () => {
        throw new Error('Committed metadata must be reused.')
      },
      close: async () => {},
    },
  )
  try {
    await library.open()
    const paths: string[] = []
    for (let i = 0; i < 5; i++) {
      const path = join(root, `frame-${i}.ARW`)
      await writeFile(path, `isolated frame ${i}`)
      paths.push(path)
    }
    await commit(library, await scan(library, [paths[1], paths[0]]))
    const first = library.listStacks().stacks[0]
    expect(first).toMatchObject({ count: 2, expanded: false, origin: 'capture' })
    await library.setStackExpanded(first.id, true, first.revision)
    await commit(library, await scan(library, [paths[3], paths[2]]))
    const extended = library.listStacks().stacks[0]
    expect(extended).toMatchObject({
      id: first.id,
      coverId: first.coverId,
      count: 4,
      expanded: true,
    })
    const removedId = library.getStackMembers(first.id).photos[2].id
    await library.removeFromStack(removedId, extended.revision)
    await commit(library, await scan(library, [paths[4]]))
    expect(library.listStacks().stacks[0].count).toBe(3)
    expect((await finishTask(library, library.groupCaptureSequences())).status).toBe('completed')
    expect(library.getPhotoStack(removedId)).toBeNull()
    const current = library.listStacks().stacks[0]
    await library.ungroupStack(current.id, current.revision)
    await finishTask(library, library.groupCaptureSequences())
    expect(library.listStacks().stacks).toEqual([])
  } finally {
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('existing-original scan uses metadata only, fixed totals and cancellation without publishing partial stacks', async () => {
  const t = await stackFixture(4)
  let calls = 0
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const processor = {
    inspectCapture: async (path: string, signal: AbortSignal) => {
      calls++
      if (calls === 2) {
        entered()
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('Cancelled metadata inspection')),
            { once: true },
          ),
        )
      }
      const index = t.photos.findIndex((p) => path.includes(p.id))
      return sequenceMetadata(index + 1)
    },
    close: async () => {},
  }
  try {
    ;(t.library as unknown as { captureProcessor: typeof processor }).captureProcessor = processor
    const id = t.library.groupCaptureSequences()
    await started
    expect(t.library.listTasks().find((t) => t.id === id)).toMatchObject({
      kind: 'capture-grouping',
      progress: { completed: 1, total: 4 },
      items: { completed: 1, total: 4 },
    })
    expect(() => t.library.deletePhotos([t.photos[0].id])).toThrow('Finish or cancel')
    await expect(
      t.library.scan([resolve('tests/fixtures/photos/alpine-lake.jpg')], true),
    ).rejects.toThrow('Finish or cancel')
    await t.library.cancelTask(id)
    expect(t.library.listTasks().find((t) => t.id === id)?.status).toBe('cancelled')
    expect(t.library.listStacks().stacks).toEqual([])
    processor.inspectCapture = async (path) => {
      calls++
      return sequenceMetadata(t.photos.findIndex((p) => path.includes(p.id)) + 1)
    }
    const retry = t.library.groupCaptureSequences()
    expect((await finishTask(t.library, retry)).status).toBe('completed')
    expect(calls).toBe(5)
    expect(t.library.listStacks().stacks[0].count).toBe(4)
    expect(t.library.list().total).toBe(4)
    for (const p of t.photos)
      expect(
        await readFile(join(t.root, 'library', 'originals', p.id, 'original.jpg'), 'utf8'),
      ).toBe(`original-${Number(basename(p.filename).match(/\d+/)![0])}`)
    await t.restart()
    expect(t.library.listStacks().stacks[0].count).toBe(4)
  } finally {
    await t.close()
  }
})

test('a scan error remains visible and untouched automatic membership does not absorb a manual group', async () => {
  const t = await stackFixture(4)
  try {
    for (let i = 0; i < 4; i++) t.capture(i, sequenceMetadata(i + 1))
    const manual = await t.library.groupPhotos(
      t.photos.slice(0, 2).map((p) => p.id),
      t.photos[0].id,
      t.library.listStacks().revision,
    )
    await finishTask(t.library, t.library.groupCaptureSequences())
    expect(t.library.listStacks().stacks).toEqual([manual])
    await t.restart()
    await finishTask(t.library, t.library.groupCaptureSequences())
    expect(t.library.listStacks().stacks).toEqual([manual])
    t.db.prepare('DELETE FROM capture_metadata WHERE photo_id = ?').run(t.photos[3].id)
    ;(
      t.library as unknown as {
        captureProcessor: {
          inspectCapture: () => Promise<CaptureMetadata>
          close: () => Promise<void>
        }
      }
    ).captureProcessor = {
      inspectCapture: async () => {
        throw new Error('Invalid camera metadata')
      },
      close: async () => {},
    }
    const task = t.library.groupCaptureSequences()
    expect((await finishTask(t.library, task)).status).toBe('failed')
    expect(t.library.taskErrors(task).errors).toEqual([
      { filename: t.photos[3].filename, message: 'Invalid camera metadata' },
    ])
    expect(t.library.listStacks().stacks).toEqual([manual])
  } finally {
    await t.close()
  }
})

test('committed capture batches retain one owned worker, preserve fresh metadata and bytes, and close on abort or read failure', async () => {
  const fixtureRoot = resolve('tests/fixtures/research-sony'),
    manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
      files: { name: string; path: string; sha256: string; captureMetadata: CaptureMetadata }[]
    },
    sources = ['DSC03243.ARW', 'DSC03244.ARW', 'DSC03245.ARW'].map((name) =>
      manifest.files.find((entry) => entry.name === name)!,
    ),
    paths = sources.map((entry) => join(fixtureRoot, entry.path)),
    root = await mkdtemp(join(tmpdir(), 'luma-capture-session-')),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js')),
    state = worker as unknown as { child?: { pid?: number }; captureSession: boolean },
    signal = new AbortController().signal
  const hash = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  try {
    const expected: CaptureMetadata[] = []
    for (const [index, path] of paths.entries()) {
      expect(await hash(path)).toBe(sources[index].sha256)
      expected.push(await worker.inspectCapture(path, signal))
      expect(state.child).toBeUndefined()
    }
    const pids: number[] = [],
      actual = await worker.inspectCaptures(paths, signal, async (index) => {
        if (!index) return
        const pid = state.child!.pid!
        pids.push(pid)
        if (index === 1) {
          // These competing operations have different cleanup paths: standalone
          // close, fallback pre-close, and the statistics idle-close timer.
          const rejected = await Promise.allSettled([
            worker.inspectCapture(paths[0], signal),
            worker.prepare(paths[0], join(root, 'unused-output'), signal, true),
            worker.statistics(paths[0], { width: 1, height: 1, sha256: '0'.repeat(64) }, signal),
          ])
          expect(
            rejected.every(
              (result) =>
                result.status === 'rejected' && String(result.reason).includes('worker is busy'),
            ),
          ).toBe(true)
          expect(state.child?.pid).toBe(pid)
        }
      })
    expect(actual).toEqual(expected)
    for (const [index, metadata] of actual.entries())
      expect(metadata).toMatchObject({ ...sources[index].captureMetadata })
    expect(pids).toHaveLength(2)
    expect(new Set(pids).size).toBe(1)
    expect(state.child).toBeUndefined()
    expect(state.captureSession).toBe(false)

    const abort = new AbortController(),
      visited: number[] = []
    await expect(
      worker.inspectCaptures(paths, abort.signal, async (index) => {
        visited.push(index)
        if (index === 1) abort.abort(new Error('Capture boundary cancelled.'))
      }),
    ).rejects.toThrow('Capture boundary cancelled.')
    expect(visited).toEqual([0, 1])
    expect(state.child).toBeUndefined()
    expect(state.captureSession).toBe(false)
    await expect(
      worker.inspectCaptures([paths[0], join(root, 'missing.ARW')], signal),
    ).rejects.toThrow()
    expect(state.child).toBeUndefined()
    expect(state.captureSession).toBe(false)
    expect(await worker.inspectCaptures([paths[0]], signal)).toEqual([expected[0]])
    expect(state.child).toBeUndefined()
    for (const [index, path] of paths.entries())
      expect(await hash(path)).toBe(sources[index].sha256)
  } finally {
    await worker.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function mergeCaptureFixture(processor: CaptureMetadataProcessor) {
  const t = await stackFixture(2)
  try {
    // Admission-only synthetic catalog; no RAW decoding or image rendering occurs.
    const metadata = processingMetadata({ 'IFD0:Make': 'SONY', 'IFD0:Model': 'ZV-1' }, [])
    metadata.hdrEligible = true
    metadata.capture = { shutterSeconds: 1 / 125, iso: 100, aperture: 4, focalLength: 9.4 }
    metadata.whiteBalance = {
      provider: 'test',
      version: '1',
      identity: 'capture-admission',
      model: WHITE_BALANCE_MODEL,
      asShotGains: [1, 1, 1],
      cameraToWorking: identityMatrix,
      xyzToCamera: identityMatrix,
      ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
      estimate: { kelvin: 6500, tint: 0 },
    }
    for (const [index, photo] of t.photos.entries()) {
      await rename(
        join(t.root, 'library', 'originals', photo.id, 'original.jpg'),
        join(t.root, 'library', 'originals', photo.id, 'original.arw'),
      )
      photo.filename = `capture-${index}.ARW`
      photo.format = 'ARW'
      photo.bytes = Buffer.byteLength(`original-${index}`)
      t.db
        .prepare("UPDATE photos SET photo = ?, processing_identity = 'hdr-v1' WHERE id = ?")
        .run(JSON.stringify(photo), photo.id)
      t.db
        .prepare('INSERT INTO processing VALUES (?, ?)')
        .run(photo.id, JSON.stringify({ metadata, settings: noLensSettings, revision: 0 }))
      seedFixtureEdits(t.db)
      t.capture(index, sequenceMetadata(index + 1))
    }
    ;(t.library as unknown as { captureProcessor: CaptureMetadataProcessor }).captureProcessor =
      processor
    return t
  } catch (error) {
    await t.close()
    throw error
  }
}

test('merge capture batches checkpoint between fresh reads and preserve the sequential adapter fallback', async () => {
  let firstRead!: () => void
  const started = new Promise<void>((resolve) => {
      firstRead = resolve
    }),
    reads: number[] = [],
    fresh = [sequenceMetadata(10), sequenceMetadata(11)],
    processor: CaptureMetadataProcessor = {
      inspectCapture: async () => {
        throw new Error('The batch operation must own capture reads.')
      },
      inspectCaptures: async (paths, _signal, beforeRead) => {
        for (let index = 0; index < paths.length; index++) {
          await beforeRead!(index)
          reads.push(index)
          if (!index) {
            scheduler.activity('capture-test-edit', true)
            firstRead()
          }
        }
        return fresh
      },
      close: async () => {},
    },
    t = await mergeCaptureFixture(processor),
    ids = t.photos.map((photo) => photo.id)
  const scheduler = (t.library as unknown as { scheduler: WorkScheduler }).scheduler
  try {
    const creating = t.library.createMergeReview(ids, 'noise')
    void creating.catch(() => {})
    await started
    expect(reads).toEqual([0])
    expect(t.library.merges.leased(ids)).toBe(true)
    expect(() => t.library.deletePhotos(ids)).toThrow('merge review')
    scheduler.activity('capture-test-edit', false)
    const review = await creating
    expect(review.sources.map((source) => source.captureMetadata)).toEqual(fresh)
    expect(t.store.capture(ids[0])).toEqual(sequenceMetadata(1))
    await t.library.disposeMergeReview(review.id)
    expect(t.library.merges.leased(ids)).toBe(false)
    delete processor.inspectCaptures
    processor.inspectCapture = async (path) => fresh[ids.findIndex((id) => path.includes(id))]
    const fallback = await t.library.createMergeReview(ids, 'noise')
    expect(fallback.sources.map((source) => source.captureMetadata)).toEqual(fresh)
    await t.library.disposeMergeReview(fallback.id)
  } finally {
    scheduler.activity('capture-test-edit', false)
    await t.close()
  }
})

for (const failure of ['missing-source', 'shutdown'] as const)
  test(`merge capture ${failure} retains source leases through awaited session cleanup`, async () => {
    let firstRead!: () => void, cleanupEntered!: () => void, finishCleanup!: () => void
    const started = new Promise<void>((resolve) => {
        firstRead = resolve
      }),
      cleaning = new Promise<void>((resolve) => {
        cleanupEntered = resolve
      }),
      cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve
      }),
      reads: number[] = [],
      processor: CaptureMetadataProcessor = {
        inspectCapture: async () => {
          throw new Error('Unexpected standalone capture read.')
        },
        inspectCaptures: async (paths, signal, beforeRead) => {
          try {
            await beforeRead!(0)
            reads.push(0)
            if (failure === 'missing-source') await rm(paths[1])
            firstRead()
            if (failure === 'shutdown')
              await new Promise<void>((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(new Error('Capture cancelled.')), {
                  once: true,
                }),
              )
            await beforeRead!(1)
            reads.push(1)
            throw new Error('The unavailable second source must never be read.')
          } finally {
            cleanupEntered()
            await cleanup
          }
        },
        close: async () => {},
      },
      t = await mergeCaptureFixture(processor),
      ids = t.photos.map((photo) => photo.id)
    let closing: Promise<void> | undefined
    try {
      const creating = t.library.createMergeReview(ids, 'noise'),
        rejected = expect(creating).rejects.toThrow(
          failure === 'missing-source' ? 'photo is unavailable' : 'Capture cancelled',
        )
      await started
      if (failure === 'shutdown') closing = t.library.close()
      await cleaning
      expect(reads).toEqual([0])
      expect(t.library.merges.leased(ids)).toBe(true)
      if (failure === 'missing-source')
        expect(() => t.library.deletePhotos(ids)).toThrow('merge review')
      finishCleanup()
      await rejected
      await closing
      expect(t.library.merges.leased(ids)).toBe(false)
      expect(t.library.getActiveMergeReview()).toBeNull()
    } finally {
      finishCleanup()
      await closing
      await t.close()
    }
  })
