import { test, expect } from '@playwright/test'
import { copyFile, mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { PreviewProcess } from '../src/main/preview-process'
import { PhotoLibrary } from '../src/main/library'
import { detectCaptureSequences, type CaptureMetadata } from '../src/shared/capture-sequence'
import { sequenceMetadata } from './capture.helpers'
import { stackFixture, finishTask } from './stack.helpers'
import { scan, commit } from './library.helpers'
import type { PreviewProcessor } from '../src/main/preview-types'

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
    library.setStackExpanded(first.id, true, first.revision)
    await commit(library, await scan(library, [paths[3], paths[2]]))
    const extended = library.listStacks().stacks[0]
    expect(extended).toMatchObject({
      id: first.id,
      coverId: first.coverId,
      count: 4,
      expanded: true,
    })
    const removedId = library.getStackMembers(first.id).photos[2].id
    library.removeFromStack(removedId, extended.revision)
    await commit(library, await scan(library, [paths[4]]))
    expect(library.listStacks().stacks[0].count).toBe(3)
    expect((await finishTask(library, library.groupCaptureSequences())).status).toBe('completed')
    expect(library.getPhotoStack(removedId)).toBeNull()
    const current = library.listStacks().stacks[0]
    library.ungroupStack(current.id, current.revision)
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
    const manual = t.library.groupPhotos(
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
