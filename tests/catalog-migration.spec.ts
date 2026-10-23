import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import { processingMetadata } from '../src/main/processing/metadata'
import { initialSettings, type EditHistory } from '../src/shared/edits'
import { noLensSettings } from '../src/shared/lens'
import type { Photo } from '../src/shared/contracts'

const timestamp = '2026-10-22T12:00:00.000Z'
const processor = {
  process: async () => {
    throw new Error('Catalog checks must not decode originals.')
  },
  close: async () => {},
}

function catalogSnapshot(db: DatabaseSync) {
  const schema = db
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name')
    .all()
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all() as { name: string }[]
  return {
    schema,
    version: db.prepare('PRAGMA user_version').get(),
    journalMode: db.prepare('PRAGMA journal_mode').get(),
    rows: tables.map(({ name }) => ({
      name,
      rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    })),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'luma-current-catalog-'))
  let library = new PhotoLibrary(root, processor, () => {})
  await library.open()
  const originals = new Map<string, Buffer>()
  const photos: Photo[] = []
  for (let index = 0; index < 2; index++) {
    const id = (index ? 'b' : 'a').repeat(64)
    const photo: Photo = {
      id,
      filename: index ? 'Authored.png' : 'Capture.ARW',
      format: index ? 'PNG' : 'ARW',
      width: 3,
      height: 2,
      bytes: 12,
      importedAt: timestamp,
      previewSource: 'image',
      thumbnailUrl: '',
      previewUrl: '',
    }
    const path = join(root, 'originals', id, index ? 'original.png' : 'original.arw')
    const bytes = Buffer.from(`untouched-original-${index}`)
    await mkdir(join(root, 'originals', id))
    await writeFile(path, bytes)
    originals.set(path, bytes)
    photos.push(photo)
    await library.catalogCommands.command({
      operation: 'original.publish',
      payload: {
        photo,
        processingIdentity: index ? 'display-referred-v1' : 'hdr-v1',
        metadata: { ...processingMetadata({}, []), hdrEligible: !index },
        createdAt: timestamp,
      },
    })
  }
  await library.close()
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  db.exec('PRAGMA journal_mode=DELETE')
  const preserved = new Map(originals)
  for (const relative of [
    'staging/unfinished',
    'merge-publications/unpublished/evidence',
    'removed/os-restored/original.png',
  ]) {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    const bytes = Buffer.from(`retained-${relative}`)
    await writeFile(path, bytes)
    preserved.set(path, bytes)
  }
  return {
    root,
    db,
    photos,
    originals,
    preserved,
    make: () => (library = new PhotoLibrary(root, processor, () => {})),
    closeLibrary: () => library.close(),
    assertFiles: async (files = preserved) => {
      for (const [path, bytes] of files) expect(await readFile(path)).toEqual(bytes)
    },
    close: async () => {
      try {
        await library.close()
      } finally {
        db.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

async function rejectedBeforeWrites(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
  let writerStarted = false
  const args: ConstructorParameters<typeof PhotoLibrary> = [f.root, processor, () => {}]
  args[17] = () => {
    writerStarted = true
    throw new Error('Unsupported catalogs must not start the writer.')
  }
  const library = new PhotoLibrary(...args)
  const before = catalogSnapshot(f.db)
  try {
    await expect(library.open()).rejects.toThrow(expected)
  } finally {
    await library.close()
  }
  expect(writerStarted).toBe(false)
  expect(catalogSnapshot(f.db)).toEqual(before)
  await f.assertFiles()
}

test('an empty unversioned catalog initializes the current schema and reopens with a read-only main connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-empty-catalog-'))
  const empty = new DatabaseSync(join(root, 'catalog.sqlite'))
  empty.close()
  let library = new PhotoLibrary(root, processor, () => {})
  try {
    await library.open()
    expect(library.list().total).toBe(0)
    const db = Reflect.get(library, 'db') as DatabaseSync
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 17 })
    expect(() => db.prepare('DELETE FROM photos').run()).toThrow(/readonly|read-only/i)
    await library.close()
    library = new PhotoLibrary(root, processor, () => {})
    await library.open()
    expect(library.list().total).toBe(0)
    expect(library.listTasks()).toEqual([])
  } finally {
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty unversioned catalog beside managed originals rejects before orphan cleanup or schema writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-unversioned-originals-'))
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  const original = join(root, 'originals', 'a'.repeat(64), 'original.arw')
  const bytes = Buffer.from('irreplaceable managed original without a catalog')
  await mkdir(join(root, 'originals', 'a'.repeat(64)), { recursive: true })
  await writeFile(original, bytes)
  let writerStarted = false
  const args: ConstructorParameters<typeof PhotoLibrary> = [root, processor, () => {}]
  args[17] = () => {
    writerStarted = true
    throw new Error('Must not start a writer for an orphaned library.')
  }
  const library = new PhotoLibrary(...args)
  const before = catalogSnapshot(db)
  try {
    await expect(library.open()).rejects.toThrow('unversioned library contains managed originals')
    await library.close()
    expect(writerStarted).toBe(false)
    expect(catalogSnapshot(db)).toEqual(before)
    expect(await readFile(original)).toEqual(bytes)
  } finally {
    try {
      await library.close()
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('older, nonempty unversioned and future catalogs reject before catalog writes or recovery cleanup', async () => {
  const f = await fixture()
  try {
    f.db.prepare('INSERT INTO merge_publications VALUES (?, ?)').run('c'.repeat(64), 'd'.repeat(64))
    f.db.prepare('INSERT INTO removals VALUES (?, ?)').run(f.photos[0].id, 'retained-removal')
    for (const version of [-1, 0, ...Array.from({ length: 16 }, (_, i) => i + 1), 18]) {
      f.db.exec(`PRAGMA user_version=${version}`)
      await rejectedBeforeWrites(
        f,
        version > 17 ? 'requires a newer version' : 'catalog format is unsupported',
      )
    }
  } finally {
    await f.close()
  }
})

test('current catalogs reject older and unknown settings without rewriting any snapshot, source or journal', async () => {
  const f = await fixture()
  try {
    f.db.prepare('INSERT INTO merge_publications VALUES (?, ?)').run('c'.repeat(64), 'd'.repeat(64))
    const id = f.photos[0].id
    const original = JSON.parse(
      (f.db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as { data: string }).data,
    ) as EditHistory
    for (const version of [1, 2, 3, 4, 5, 6, 8]) {
      for (const snapshotOnly of [false, true]) {
        const history = structuredClone(original)
        Object.assign(snapshotOnly ? history.snapshots[0].settings : history.settings, { version })
        f.db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(JSON.stringify(history), id)
        await rejectedBeforeWrites(f, 'edit history format is unsupported')
      }
    }
    const history = structuredClone(original)
    Object.assign(history.settings, { processing: 'legacy-sdr-v1' })
    f.db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(JSON.stringify(history), id)
    await rejectedBeforeWrites(f, 'edit history format is unsupported')
    f.db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(JSON.stringify(original), id)
    f.db.prepare('UPDATE photos SET processing_identity = ? WHERE id = ?').run('legacy-sdr-v1', id)
    await rejectedBeforeWrites(f, 'unsupported processing identity')
  } finally {
    await f.close()
  }
})

test('current schema and settings preserve original bytes, every history snapshot, cursor, revision and redo on reopen', async () => {
  const f = await fixture()
  try {
    const histories = f.photos.map((photo, index): EditHistory => {
      const snapshots = [-1.25, 0.37, 2.12].map((exposureEv, ordinal) => ({
        createdAt: `2026-10-0${ordinal + 1}T12:00:00.000Z`,
        settings: {
          ...initialSettings(noLensSettings),
          processing: index ? ('display-referred-v1' as const) : ('hdr-v1' as const),
          exposureEv,
          contrast: ordinal * 13,
          highlights: -(ordinal * 17) || 0,
        },
      }))
      return {
        photoId: photo.id,
        revision: 17,
        cursor: 1,
        settings: snapshots[1].settings,
        snapshots,
        canUndo: true,
        canRedo: true,
      }
    })
    for (const history of histories)
      f.db
        .prepare('UPDATE edits SET data = ? WHERE id = ?')
        .run(JSON.stringify(history), history.photoId)
    // These owned disposable leftovers may be recovered for supported catalogs.
    const beforeRows = f.db.prepare('SELECT * FROM photos ORDER BY id').all()
    let library = f.make()
    await library.open()
    for (const history of histories)
      expect(await library.getEditHistory(history.photoId)).toEqual(history)
    expect(f.db.prepare('SELECT * FROM photos ORDER BY id').all()).toEqual(beforeRows)
    await f.assertFiles(f.originals)
    await library.close()
    library = f.make()
    await library.open()
    for (const history of histories) {
      expect(await library.getEditHistory(history.photoId)).toEqual(history)
      expect((await library.redoEdit(history.photoId, 17)).settings.exposureEv).toBe(2.12)
    }
    expect(f.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 17 })
    await f.assertFiles(f.originals)
  } finally {
    await f.close()
  }
})

test('current metadata can initialize missing current history without upgrading stale metadata or replacing existing history', async () => {
  const f = await fixture()
  try {
    const id = f.photos[0].id
    f.db.prepare('DELETE FROM edits WHERE id = ?').run(id)
    const row = f.db.prepare('SELECT data FROM processing WHERE id = ?').get(id) as { data: string }
    const processing = JSON.parse(row.data)
    processing.revision = 7
    processing.metadata.version = 3
    const stale = JSON.stringify(processing)
    f.db.prepare('UPDATE processing SET data = ? WHERE id = ?').run(stale, id)
    const retained = f.db.prepare('SELECT data FROM edits WHERE id = ?').get(f.photos[1].id)
    const library = f.make()
    await library.open()
    expect(f.db.prepare('SELECT data FROM processing WHERE id = ?').get(id)).toEqual({
      data: stale,
    })
    const seeded = JSON.parse(
      (f.db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as { data: string }).data,
    )
    expect(seeded).toMatchObject({
      revision: 7,
      cursor: 0,
      settings: { version: 7, processing: 'hdr-v1' },
      canUndo: false,
      canRedo: false,
    })
    expect(f.db.prepare('SELECT data FROM edits WHERE id = ?').get(f.photos[1].id)).toEqual(
      retained,
    )
    await f.assertFiles(f.originals)
  } finally {
    await f.close()
  }
})
