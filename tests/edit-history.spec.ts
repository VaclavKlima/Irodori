import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewEngine } from '../src/main/preview-engine'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
const id = 'a'.repeat(64)
test('migrates v3 choices and revisions, commits shared history atomically, rejects conflicts, branches redo and cleans deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-edits-'))
  await mkdir(join(root, 'originals', id), { recursive: true })
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  db.exec(
    'CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT, photo TEXT); CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT); PRAGMA user_version = 3',
  )
  db.prepare('INSERT INTO photos VALUES (?, ?, ?)').run(
    id,
    '2026',
    JSON.stringify({ id, filename: 'test.arw' }),
  )
  const metadata = processingMetadata({
    'IFD0:Make': 'SONY',
    'IFD0:Model': 'ZV-1',
    'SubIFD:DistortionCorrParams': '3 100 0 -100',
  })
  db.prepare('INSERT INTO processing VALUES (?, ?)').run(
    id,
    JSON.stringify({ metadata, settings: noLensSettings, revision: 7 }),
  )
  db.close()
  const events: number[] = []
  let library = new PhotoLibrary(root, new PreviewEngine(), (event) => {
    if (event.editsChanged) events.push(event.editsChanged.revision)
  })
  try {
    await library.open()
    expect(await library.getEdits(id)).toMatchObject({
      revision: 7,
      settings: {
        shadows: 0,
        whites: 0,
        blacks: 0,
        version: 7,
        processing: 'hdr-v1',
        whiteBalance: { mode: 'as-shot' },
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
        lens: noLensSettings,
      },
      canUndo: false,
    })
    await library.updateEdits(id, { exposureEv: 1.25 }, 7)
    await library.updateLensSettings(id, 'distortion', true)
    expect((await library.getEditHistory(id)).snapshots).toHaveLength(3)
    expect(await library.undoEdit(id, 9)).toMatchObject({
      revision: 10,
      settings: { exposureEv: 1.25, lens: noLensSettings },
      canRedo: true,
    })
    await library.redoEdit(id, 10)
    await library.undoEdit(id, 11)
    await library.updateEdits(id, { exposureEv: -2 }, 12)
    expect(await library.getEdits(id)).toMatchObject({ revision: 13, canRedo: false })
    const concurrent = await Promise.allSettled([
      library.updateEdits(id, { exposureEv: 0.5 }, 13),
      library.updateEdits(id, { exposureEv: 0.75 }, 13),
    ])
    expect(concurrent.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    for (const exposureEv of [NaN, Infinity, 5.1, -5.01, 0.001, '1'])
      await expect(
        library.updateEdits(id, { exposureEv: exposureEv as number }, 14),
      ).rejects.toThrow('Exposure')
    await expect(library.updateEdits(id, { lens: { vignetting: true } }, 14)).rejects.toThrow(
      'unavailable',
    )
    const before = await library.getEditHistory(id)
    const fault = new DatabaseSync(join(root, 'catalog.sqlite'))
    fault.exec(
      "CREATE TRIGGER fail_edits BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'Test disk failure'); END",
    )
    await expect(library.updateEdits(id, { exposureEv: -1 }, 14)).rejects.toThrow(
      'Test disk failure',
    )
    expect(await library.getEditHistory(id)).toEqual(before)
    fault.exec('DROP TRIGGER fail_edits')
    fault.close()
    await library.close()
    library = new PhotoLibrary(root, new PreviewEngine(), () => {})
    await library.open()
    expect(await library.getEditHistory(id)).toEqual(before)
    expect(events).toEqual([8, 9, 10, 11, 12, 13, 14])
    const deletion = new DatabaseSync(join(root, 'catalog.sqlite'))
    deletion.prepare('DELETE FROM photos WHERE id = ?').run(id)
    expect(deletion.prepare('SELECT COUNT(*) AS count FROM edits').get()).toMatchObject({
      count: 0,
    })
    deletion.close()
    await expect(library.getEdits(id)).rejects.toThrow('unavailable')
  } finally {
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})
