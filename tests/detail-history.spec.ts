import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import { processingMetadata } from '../src/main/processing/metadata'
import type { LibraryEvent } from '../src/shared/contracts'
import { neutralNoiseReduction, neutralDetailSharpening } from '../src/shared/spatial-detail'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-detail-history-')),
    id = 'a'.repeat(64),
    bytes = Buffer.from('History checks preserve this original and never decode it.'),
    events: LibraryEvent[] = [],
    make = () =>
      new PhotoLibrary(
        root,
        {
          process: async () => {
            throw new Error('History checks must not decode photographs.')
          },
          close: async () => {},
        },
        (event) => events.push(structuredClone(event)),
      )
  let library = make()
  await library.open()
  await mkdir(join(root, 'originals', id))
  const original = join(root, 'originals', id, 'original.png')
  await writeFile(original, bytes)
  await library.catalogCommands.command({
    operation: 'original.publish',
    payload: {
      photo: {
        id,
        filename: 'detail.png',
        width: 19,
        height: 17,
        bytes: bytes.length,
        format: 'PNG',
        importedAt: '2026-10-28T12:00:00.000Z',
        previewSource: 'image',
        thumbnailUrl: '',
        previewUrl: '',
      },
      processingIdentity: 'display-referred-v1',
      metadata: processingMetadata({}, []),
      createdAt: '2026-10-28T12:00:00.000Z',
    },
  })
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  return {
    id,
    db,
    events,
    get library() {
      return library
    },
    async restart() {
      await library.close()
      library = make()
      await library.open()
    },
    async close() {
      try {
        await library.close()
        expect(await readFile(original)).toEqual(bytes)
      } finally {
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

test('spatial controls share one atomic history, source notifications, no-op redo, conflict handling and restart', async () => {
  const t = await fixture()
  try {
    const initial = await t.library.getEdits(t.id),
      first = await t.library.updateEdits(
        t.id,
        {
          exposureEv: 0.5,
          noiseReduction: { luminance: 25 },
          detailSharpening: { amount: 40, radius: 1.7 },
        },
        initial.revision,
      )
    expect(first.settings).toMatchObject({
      noiseReduction: { ...neutralNoiseReduction, luminance: 25 },
      detailSharpening: { ...neutralDetailSharpening, amount: 40, radius: 1.7 },
    })
    expect((await t.library.getEditHistory(t.id)).snapshots).toHaveLength(2)
    expect(
      t.events.filter((event) => event.sourceChanged).map((event) => event.sourceChanged!.revision),
    ).toEqual([first.revision])
    const second = await t.library.updateEdits(
      t.id,
      { noiseReduction: { chroma: 45 }, detailSharpening: { threshold: 30 } },
      first.revision,
    )
    expect(second.settings.noiseReduction).toEqual({ version: 1, luminance: 25, chroma: 45 })
    expect(second.settings.detailSharpening).toEqual({
      version: 1,
      amount: 40,
      radius: 1.7,
      threshold: 30,
    })
    const undone = await t.library.undoEdit(t.id, second.revision),
      retained = await t.library.getEditHistory(t.id)
    expect(undone.settings).toEqual(first.settings)
    expect(undone.canRedo).toBe(true)
    await t.library.updateEdits(
      t.id,
      { noiseReduction: {}, detailSharpening: { radius: 1.7 } },
      undone.revision,
    )
    expect(await t.library.getEditHistory(t.id)).toEqual(retained)
    await expect(
      t.library.updateEdits(t.id, { noiseReduction: { luminance: 50 } }, first.revision),
    ).rejects.toThrow('conflict')
    const redone = await t.library.redoEdit(t.id, undone.revision)
    expect(redone.settings).toEqual(second.settings)
    const beforePoint = t.events.filter((event) => event.sourceChanged).length,
      point = await t.library.updateEdits(t.id, { contrast: 15 }, redone.revision)
    expect(t.events.filter((event) => event.sourceChanged)).toHaveLength(beforePoint)
    await t.restart()
    expect((await t.library.getEdits(t.id)).settings).toEqual(point.settings)
    const back = await t.library.undoEdit(t.id, point.revision),
      reset = await t.library.updateEdits(
        t.id,
        { noiseReduction: neutralNoiseReduction, detailSharpening: neutralDetailSharpening },
        back.revision,
      )
    expect(reset.canRedo).toBe(false)
    expect(reset.settings).toMatchObject({
      exposureEv: 0.5,
      noiseReduction: neutralNoiseReduction,
      detailSharpening: neutralDetailSharpening,
    })
  } finally {
    await t.close()
  }
})

test('a failed spatial transaction publishes no state or source invalidation', async () => {
  const t = await fixture()
  try {
    const before = await t.library.getEditHistory(t.id),
      events = t.events.length
    t.db.exec(
      "CREATE TRIGGER fail_detail BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'Detail disk failure'); END",
    )
    await expect(
      t.library.updateEdits(
        t.id,
        { noiseReduction: { luminance: 35 }, detailSharpening: { amount: 20 } },
        before.revision,
      ),
    ).rejects.toThrow('Detail disk failure')
    expect(await t.library.getEditHistory(t.id)).toEqual(before)
    expect(t.events).toHaveLength(events)
    t.db.exec('DROP TRIGGER fail_detail')
    await t.restart()
    expect(await t.library.getEditHistory(t.id)).toEqual(before)
  } finally {
    await t.close()
  }
})
