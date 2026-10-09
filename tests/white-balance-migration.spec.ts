import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewEngine } from '../src/main/preview-engine'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'

test('catalog v7 migration preserves tonal edits, every snapshot and redo transactionally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-wb-migration-'))
  const id = 'b'.repeat(64)
  await mkdir(join(root, 'originals', id), { recursive: true })
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  db.exec(
    'CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT, photo TEXT); CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT); PRAGMA user_version = 7',
  )
  db.prepare('INSERT INTO photos VALUES (?, ?, ?)').run(
    id,
    '2026',
    JSON.stringify({ id, filename: 'sample.png' }),
  )
  db.prepare('INSERT INTO processing VALUES (?, ?)').run(
    id,
    JSON.stringify({ metadata: processingMetadata({}, []), settings: noLensSettings, revision: 1 }),
  )
  const snapshots = [0, 1, -2].map((exposureEv, index) => ({
    settings: {
      version: 4,
      shadows: 0,
      whites: 0,
      blacks: 0,
      highlights: index * 15,
      exposureEv,
      contrast: index * 20 - 10,
      lens: noLensSettings,
    },
    createdAt: `2026-09-01T12:00:0${index}.000Z`,
  }))
  const original = {
    photoId: id,
    revision: 9,
    settings: snapshots[1].settings,
    snapshots,
    cursor: 1,
    canUndo: true,
    canRedo: true,
  }
  db.prepare('INSERT INTO edits VALUES (?, ?)').run(id, JSON.stringify(original))
  db.prepare('INSERT INTO edits VALUES (?, ?)').run('c'.repeat(64), JSON.stringify(original))
  // A failed migration must roll back all rows and the catalog version.
  db.exec(
    "CREATE TRIGGER fail_migration BEFORE UPDATE ON edits WHEN old.id = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' BEGIN SELECT RAISE(ABORT, 'migration fault'); END",
  )
  let library = new PhotoLibrary(root, new PreviewEngine(), () => {})
  try {
    await expect(library.open()).rejects.toThrow('migration fault')
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
    expect(
      JSON.parse((db.prepare('SELECT data FROM edits ORDER BY id').get() as { data: string }).data),
    ).toEqual(original)
    await library.close()
    db.exec('DROP TRIGGER fail_migration')
    library = new PhotoLibrary(root, new PreviewEngine(), () => {})
    await library.open()
    const expected = {
      ...original,
      settings: {
        ...original.settings,
        version: 7,
        processing: 'display-referred-v1',
        whiteBalance: { mode: 'as-shot' },
        shadows: 0,
        whites: 0,
        blacks: 0,
      },
      snapshots: snapshots.map((snapshot) => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          version: 7,
          processing: 'display-referred-v1',
          whiteBalance: { mode: 'as-shot' },
          shadows: 0,
          whites: 0,
          blacks: 0,
        },
      })),
    }
    expect(await library.getEditHistory(id)).toEqual(expected)
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 12 })
    expect(await library.redoEdit(id, 9)).toMatchObject({
      revision: 10,
      settings: { shadows: 0, whites: 0, blacks: 0, exposureEv: -2, contrast: 30, highlights: 30 },
    })
    await library.updateEdits(
      id,
      { shadows: 65, whites: -35, blacks: 20, highlights: -40, exposureEv: 0.5 },
      10,
    )
    await expect(library.updateEdits(id, { blacks: -10 }, 10)).rejects.toThrow('conflict')
    await library.undoEdit(id, 11)
    const before = await library.getEditHistory(id)
    await library.close()
    library = new PhotoLibrary(root, new PreviewEngine(), () => {})
    await library.open()
    expect(await library.getEditHistory(id)).toEqual(before)
    expect(await library.redoEdit(id, 12)).toMatchObject({
      settings: {
        shadows: 65,
        whites: -35,
        blacks: 20,
        exposureEv: 0.5,
        contrast: 30,
        highlights: -40,
      },
    })
  } finally {
    db.close()
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})
