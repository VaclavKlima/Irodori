import { test, expect } from '@playwright/test'
import { readFile, rename, mkdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import type { ProcessingOptions } from '../src/shared/lens'
import { transferFixture } from './edit-transfer.helpers'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const boundary of ['validation', 'publication'] as const)
  test(`shutdown drains accepted edits held at ${boundary} and reopens committed history with unchanged originals`, async () => {
    const t = await transferFixture(1),
      entered = gate(),
      release = gate()
    let closing: Promise<void> | undefined
    try {
      if (boundary === 'validation') {
        t.library.fullPreviews.validateCropEdit = async (_id, _revision, crop) => {
          entered.resolve()
          await release.promise
          return cropGeometry({ width: 8, height: 6 }, crop)
        }
      } else {
        const command = t.library.catalogCommands.command.bind(t.library.catalogCommands)
        t.library.catalogCommands.command = async (request) => {
          if (request.operation === 'edits.commit') {
            entered.resolve()
            await release.promise
          }
          return command(request)
        }
      }
      const pending = t.library.updateEdits(
        t.ids[0],
        boundary === 'validation'
          ? { crop: { ...identityCrop, width: 0.8, height: 0.8 } }
          : { exposureEv: 1.25 },
        0,
      )
      await entered.promise
      let finished = false
      closing = t.library.close().then(() => {
        finished = true
      })
      await expect(t.library.updateEdits(t.ids[0], { exposureEv: 2 }, 0)).rejects.toThrow('closing')
      expect(finished).toBe(false)
      expect(t.library.catalogCommands.isClosed).toBe(false)
      release.resolve()
      expect((await pending).revision).toBe(1)
      await closing
      expect(t.library.catalogCommands.isClosed).toBe(true)
      await t.restart()
      const history = await t.library.getEditHistory(t.ids[0])
      expect(history.snapshots).toHaveLength(2)
      expect(history.revision).toBe(1)
      if (boundary === 'validation') expect(history.settings.crop.width).toBe(0.8)
      else expect(history.settings.exposureEv).toBe(1.25)
      await t.originalsUnchanged()
    } finally {
      release.resolve()
      await closing
      await t.close()
    }
  })

for (const operation of ['undo', 'redo', 'lens'] as const)
  test(`shutdown retains entry ownership for ${operation} before validation and for the queued lens tail`, async () => {
    const t = await transferFixture(1),
      entered = gate(),
      release = gate()
    let closing: Promise<void> | undefined
    try {
      await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
      if (operation === 'redo') await t.library.undoEdit(t.ids[0], 1)
      const internals = t.library as unknown as {
        processingOptions(id: string): Promise<ProcessingOptions>
      }
      const options = internals.processingOptions.bind(t.library)
      let held = false
      internals.processingOptions = async (id) => {
        if (!held) {
          held = true
          entered.resolve()
          await release.promise
        }
        return options(id)
      }
      const pending =
        operation === 'undo'
          ? t.library.undoEdit(t.ids[0], 1)
          : operation === 'redo'
            ? t.library.redoEdit(t.ids[0], 2)
            : t.library
                .updateLensSettings(t.ids[0], 'distortion', true)
                .catch((error: Error) => error)
      const queued =
        operation === 'lens'
          ? t.library
              .updateLensSettings(t.ids[0], 'vignetting', true)
              .catch((error: Error) => error)
          : undefined
      await entered.promise
      closing = t.library.close()
      expect(t.library.catalogCommands.isClosed).toBe(false)
      release.resolve()
      const result = await pending
      if (operation === 'lens') {
        expect(result).toMatchObject({ message: 'This correction is unavailable.' })
        expect(await queued).toMatchObject({ message: 'This correction is unavailable.' })
      }
      await closing
      await t.restart()
      expect((await t.library.getEdits(t.ids[0])).settings.exposureEv).toBe(
        operation === 'undo' ? 0 : 1,
      )
      await t.originalsUnchanged()
    } finally {
      release.resolve()
      await closing
      await t.close()
    }
  })

test('paused task admission permits flush writes and resumes; a queued group publication drains on close', async () => {
  const t = await transferFixture(2),
    entered = gate(),
    release = gate()
  let closing: Promise<void> | undefined
  try {
    t.library.pauseTaskAdmission(true)
    await expect(t.library.scan([], false)).rejects.toThrow('closing')
    expect(() => t.library.deletePhotos(t.ids)).toThrow('closing')
    await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
    await t.library.saveWorkspaceState({ state: { consoleOpen: true } })
    t.library.pauseTaskAdmission(false)
    const command = t.library.catalogCommands.command.bind(t.library.catalogCommands)
    t.library.catalogCommands.command = async (request) => {
      if (request.operation === 'stack.group') {
        entered.resolve()
        await release.promise
      }
      return command(request)
    }
    const grouping = t.library.groupPhotos(t.ids, t.ids[0], t.library.listStacks().revision)
    await entered.promise
    closing = t.library.close()
    expect(t.library.catalogCommands.isClosed).toBe(false)
    release.resolve()
    await grouping
    await closing
    await t.restart()
    expect(t.library.getPhotoStack(t.ids[0])?.id).toBeTruthy()
    expect(t.library.getWorkspaceState().state?.consoleOpen).toBe(true)
    await t.originalsUnchanged()
  } finally {
    release.resolve()
    await closing
    await t.close()
  }
})

test('shutdown waits for an isolated in-flight Trash call and preserves recoverable bundles', async () => {
  const t = await transferFixture(2),
    entered = gate(),
    release = gate()
  const trash = join(t.root, 'isolated-trash')
  let closing: Promise<void> | undefined
  let destination = ''
  try {
    await mkdir(trash)
    const original = await readFile(join(t.library.root, 'originals', t.ids[0], 'original.png'))
    const removal = (t.library as unknown as { removals: { trash(path: string): Promise<void> } })
      .removals
    removal.trash = async (path) => {
      entered.resolve()
      await release.promise
      destination = join(trash, basename(path))
      await rename(path, destination)
    }
    t.library.deletePhotos([t.ids[0]])
    await entered.promise
    const db = new DatabaseSync(join(t.library.root, 'catalog.sqlite'), { readOnly: true })
    expect(db.prepare('SELECT COUNT(*) AS n FROM removals').get()).toMatchObject({ n: 1 })
    db.close()
    closing = t.library.close()
    expect(t.library.catalogCommands.isClosed).toBe(false)
    release.resolve()
    await closing
    expect(await readFile(join(destination, 'original.png'))).toEqual(original)
    await t.restart()
    expect(t.library.list().photos.map((p) => p.id)).toEqual([t.ids[1]])
    expect(await readFile(join(destination, 'original.png'))).toEqual(original)
  } finally {
    release.resolve()
    await closing
    await t.close()
  }
})

test('a cleanup failure still drains the real catalog worker and closes the read connection', async () => {
  const t = await transferFixture(1)
  const processor = (t.library as unknown as { metadataProcessor: { close(): Promise<void> } })
    .metadataProcessor
  const originalClose = processor.close.bind(processor)
  processor.close = async () => {
    await originalClose()
    throw new Error('Injected cleanup failure')
  }
  try {
    await expect(t.library.close()).rejects.toThrow('Could not close every application service')
    expect(t.library.catalogCommands.isClosed).toBe(true)
    expect(() => t.library.getWorkspaceState()).toThrow(/not open|closed/i)
  } finally {
    await t.library.close().catch(() => {})
    await rm(t.root, { recursive: true, force: true })
  }
})
