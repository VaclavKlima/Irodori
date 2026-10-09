import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewEngine } from '../src/main/preview-engine'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
import { initialSettings } from '../src/shared/edits'

test('Automatic rendering cutover rewrites metadata and preserves every numeric snapshot and revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-hdr-migration-'))
  const ids = ['a'.repeat(64), 'b'.repeat(64)]
  for (const id of ids) await mkdir(join(root, 'originals', id), { recursive: true })
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  db.exec(
    'CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT, photo TEXT); CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT); PRAGMA user_version = 8',
  )
  for (const id of ids)
    db.prepare('INSERT INTO photos VALUES (?, ?, ?)').run(
      id,
      '2026',
      JSON.stringify({ id, filename: 'source.ARW' }),
    )
  const metadata = { ...processingMetadata({}, []), hdrEligible: true }
  db.prepare('INSERT INTO processing VALUES (?, ?)').run(
    ids[0],
    JSON.stringify({ metadata, settings: noLensSettings, revision: 0 }),
  )
  const settings = { ...initialSettings(noLensSettings), version: 5, exposureEv: 1.25 }
  delete (settings as { processing?: string }).processing
  const original = {
    photoId: ids[0],
    revision: 3,
    settings,
    snapshots: [{ settings, createdAt: '2026-01-01' }],
    cursor: 0,
    canUndo: false,
    canRedo: false,
  }
  db.prepare('INSERT INTO edits VALUES (?, ?)').run(ids[0], JSON.stringify(original))
  const inspector = { inspect: async () => metadata, close: async () => {} }
  let library = new PhotoLibrary(
    root,
    new PreviewEngine(),
    () => {},
    undefined,
    undefined,
    inspector,
    true,
  )
  try {
    db.exec(
      "CREATE TRIGGER fail_hdr BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'hdr migration fault'); END",
    )
    await expect(library.open()).rejects.toThrow('hdr migration fault')
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
    expect(
      db
        .prepare('PRAGMA table_info(photos)')
        .all()
        .some((column) => column.name === 'processing_identity'),
    ).toBe(false)
    await library.close()
    db.exec('DROP TRIGGER fail_hdr')
    library = new PhotoLibrary(
      root,
      new PreviewEngine(),
      () => {},
      undefined,
      undefined,
      inspector,
      true,
    )
    await library.open()
    expect((await library.getEdits(ids[1])).settings.processing).toBe('hdr-v1')
    const state = await library.getEditHistory(ids[0])
    expect(state.settings).toMatchObject({
      version: 7,
      processing: 'hdr-v1',
      exposureEv: 1.25,
    })
    expect(state.snapshots[0].settings).toEqual(state.settings)
    expect(state.snapshots).toHaveLength(1)
    expect(state.revision).toBe(3)
    await library.updateEdits(ids[0], { exposureEv: 2 }, 3)
    expect((await library.undoEdit(ids[0], 4)).settings).toMatchObject({
      processing: 'hdr-v1',
      exposureEv: 1.25,
    })
    expect((await library.redoEdit(ids[0], 5)).settings).toMatchObject({
      processing: 'hdr-v1',
      exposureEv: 2,
    })
    const saved = await library.getEditHistory(ids[0])
    await library.close()
    library = new PhotoLibrary(
      root,
      new PreviewEngine(),
      () => {},
      undefined,
      undefined,
      inspector,
      true,
    )
    await library.open()
    expect(await library.getEditHistory(ids[0])).toEqual(saved)
    await expect(library.updateEdits(ids[0], { exposureEv: 1 }, 3)).rejects.toThrow('conflict')
  } finally {
    db.close()
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('schema 11 cutover preserves original bytes, numeric snapshots, cursor and redo for RAW and raster photos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-rendering-cutover-'))
  const ids = ['c'.repeat(64), 'd'.repeat(64)]
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  db.exec(
    'CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT, photo TEXT, processing_identity TEXT); CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT); PRAGMA user_version = 11',
  )
  const metadata = processingMetadata({}, [])
  const histories = ids.map((id) => {
    const snapshots = [-1.25, 0.37, 2.12].map((exposureEv, i) => ({
      createdAt: `2026-01-0${i + 1}`,
      settings: {
        ...initialSettings(noLensSettings),
        version: 6,
        processing: 'legacy-sdr-v1',
        exposureEv,
        contrast: i * 13,
        highlights: -(i * 17) || 0,
        whiteBalance: { mode: 'custom', kelvin: 7000, tint: 15 },
      },
    }))
    return {
      photoId: id,
      revision: 17,
      cursor: 1,
      settings: snapshots[1].settings,
      snapshots,
      canUndo: true,
      canRedo: true,
    }
  })
  let library = new PhotoLibrary(root, new PreviewEngine(), () => {})
  try {
    for (const [i, id] of ids.entries()) {
      const filename = i ? 'authored.jpg' : 'capture.ARW'
      await mkdir(join(root, 'originals', id), { recursive: true })
      await writeFile(join(root, 'originals', id, filename), Buffer.from(`original-${id}`))
      db.prepare('INSERT INTO photos VALUES (?, ?, ?, ?)').run(
        id,
        '2026',
        JSON.stringify({ id, filename }),
        'legacy-sdr-v1',
      )
      db.prepare('INSERT INTO processing VALUES (?, ?)').run(
        id,
        JSON.stringify({ metadata, settings: noLensSettings, revision: 0 }),
      )
      db.prepare('INSERT INTO edits VALUES (?, ?)').run(id, JSON.stringify(histories[i]))
    }
    await library.open()
    for (const [i, id] of ids.entries()) {
      const migrated = await library.getEditHistory(id)
      const expected = structuredClone(histories[i])
      for (const settings of [expected.settings, ...expected.snapshots.map((s) => s.settings)]) {
        settings.version = 7
        settings.processing = i ? 'display-referred-v1' : 'hdr-v1'
      }
      expect(migrated).toMatchObject(expected)
      expect(migrated.snapshots).toHaveLength(3)
      expect(
        await readFile(join(root, 'originals', id, i ? 'authored.jpg' : 'capture.ARW')),
      ).toEqual(Buffer.from(`original-${id}`))
    }
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 12 })
    const saved = await library.getEditHistory(ids[0])
    await library.close()
    library = new PhotoLibrary(root, new PreviewEngine(), () => {})
    await library.open()
    expect(await library.getEditHistory(ids[0])).toEqual(saved)
    expect((await library.redoEdit(ids[0], 17)).settings.exposureEv).toBe(2.12)
  } finally {
    db.close()
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})
