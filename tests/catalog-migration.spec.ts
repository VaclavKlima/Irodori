import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import { processingMetadata } from '../src/main/processing/metadata'
import { initialSettings, SETTINGS_VERSION, type EditHistory } from '../src/shared/edits'
import { CATALOG_VERSION } from '../src/main/catalog/editing-migration'
import { noLensSettings } from '../src/shared/lens'
import type { Photo } from '../src/shared/contracts'
import { identityCrop } from '../src/shared/crop'
import { mergeEditPatch } from '../src/shared/edits'

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
  const root = await mkdtemp(join(tmpdir(), 'irodori-current-catalog-'))
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

function storedHistory(history: EditHistory, catalogVersion: number): EditHistory {
  const result = structuredClone(history)
  if (catalogVersion === CATALOG_VERSION) return result
  for (const settings of [result.settings, ...result.snapshots.map((s) => s.settings)]) {
    const legacy = settings as unknown as Record<string, unknown>
    legacy.version = catalogVersion - 10
    delete legacy.noiseReduction
    delete legacy.detailSharpening
    if (catalogVersion < 20) {
      delete legacy.colorMixer
      delete legacy.colorGrading
    }
    if (catalogVersion < 19) delete legacy.crop
    if (catalogVersion === 17) {
      delete legacy.saturation
      delete legacy.vibrance
    }
  }
  return result
}

test('an empty unversioned catalog initializes the current schema and reopens with a read-only main connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-empty-catalog-'))
  const empty = new DatabaseSync(join(root, 'catalog.sqlite'))
  empty.close()
  let library = new PhotoLibrary(root, processor, () => {})
  try {
    await library.open()
    expect(library.list().total).toBe(0)
    const db = Reflect.get(library, 'db') as DatabaseSync
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: CATALOG_VERSION })
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
  const root = await mkdtemp(join(tmpdir(), 'irodori-unversioned-originals-'))
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
    for (const version of [
      -1,
      0,
      ...Array.from({ length: 16 }, (_, i) => i + 1),
      CATALOG_VERSION + 1,
    ]) {
      f.db.exec(`PRAGMA user_version=${version}`)
      await rejectedBeforeWrites(
        f,
        version > CATALOG_VERSION ? 'requires a newer version' : 'catalog format is unsupported',
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
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, SETTINGS_VERSION + 1]) {
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

for (const previousVersion of [17, 18, 19, 20, 21])
  test(`catalog ${previousVersion} preserves original bytes, every history snapshot, cursor, revision and redo on reopen`, async () => {
    const f = await fixture()
    try {
      const histories = f.photos.map((photo, index): EditHistory => {
        const snapshots = [-1.25, 0.37, 2.12].map(
          (exposureEv, ordinal): EditHistory['snapshots'][number] => ({
            createdAt: `2026-10-0${ordinal + 1}T12:00:00.000Z`,
            settings: mergeEditPatch(
              {
                ...initialSettings(noLensSettings),
                processing: index ? ('display-referred-v1' as const) : ('hdr-v1' as const),
                exposureEv,
                contrast: ordinal * 13,
                highlights: -(ordinal * 17) || 0,
                saturation: previousVersion === 17 ? 0 : ordinal * 17,
                vibrance: previousVersion === 17 ? 0 : -ordinal * 13 || 0,
                crop: {
                  ...identityCrop,
                  quarterTurns: previousVersion >= 19 && ordinal === 2 ? 1 : 0,
                },
              },
              previousVersion >= 20
                ? {
                    colorMixer: {
                      ranges: { blue: { hue: ordinal * 15, saturation: -ordinal * 10 || 0 } },
                    },
                    colorGrading: {
                      tones: { shadows: { hue: 234.5, saturation: ordinal * 20 } },
                      balance: ordinal * 10,
                    },
                    ...(previousVersion === 21
                      ? {
                          noiseReduction: { luminance: ordinal * 20, chroma: ordinal * 15 },
                          detailSharpening: { amount: ordinal * 25, radius: 1.3, threshold: 35 },
                        }
                      : {}),
                  }
                : {},
            ),
          }),
        )
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
      f.db.exec(`PRAGMA user_version=${previousVersion}`)
      for (const history of histories) {
        f.db
          .prepare('UPDATE edits SET data = ? WHERE id = ?')
          .run(JSON.stringify(storedHistory(history, previousVersion)), history.photoId)
      }
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
      expect(f.db.prepare('PRAGMA user_version').get()).toMatchObject({
        user_version: CATALOG_VERSION,
      })
      await f.assertFiles(f.originals)
    } finally {
      await f.close()
    }
  })

test('crop history preflight rejects malformed current and legacy geometry, including redo, before recovery writes', async () => {
  const f = await fixture()
  try {
    const id = f.photos[1].id
    const retained = JSON.parse(
      (f.db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as { data: string }).data,
    ) as EditHistory
    retained.snapshots = [0, 1, 2].map((exposureEv) => ({
      settings: { ...retained.settings, exposureEv },
      createdAt: timestamp,
    }))
    retained.cursor = 1
    retained.settings = retained.snapshots[1].settings
    retained.canUndo = retained.canRedo = true
    for (const catalogVersion of [17, 18, 19, 20]) {
      f.db.exec(`PRAGMA user_version=${catalogVersion}`)
      // Every row must match its catalog version, even when only the other row is malformed.
      for (const photo of f.photos) {
        f.db
          .prepare('UPDATE edits SET data = ? WHERE id = ?')
          .run(
            JSON.stringify(storedHistory({ ...retained, photoId: photo.id }, catalogVersion)),
            photo.id,
          )
      }
      const invalidCrops = [
        null,
        { ...identityCrop, version: 2 },
        { ...identityCrop, centerX: 0 },
        { ...identityCrop, angle: 0.001 },
        { ...identityCrop, aspectRatio: 0 },
        { ...identityCrop, extra: true },
        ...(catalogVersion >= 19
          ? [undefined]
          : [
              { ...identityCrop, width: 0.8 },
              { ...identityCrop, aspectRatio: 1.5 },
            ]),
      ]
      for (const crop of invalidCrops) {
        for (const target of ['current', 0, 2] as const) {
          const history = storedHistory(retained, catalogVersion)
          Object.assign(
            target === 'current' ? history.settings : history.snapshots[target].settings,
            { crop },
          )
          f.db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(JSON.stringify(history), id)
          await rejectedBeforeWrites(f, 'edit history format is unsupported')
        }
      }
    }
  } finally {
    await f.close()
  }
})

for (const previousVersion of [17, 18, 19])
  test(`catalog ${previousVersion} edit migration validates every snapshot and rolls back an interrupted transaction`, async () => {
    const f = await fixture()
    try {
      f.db.exec(`PRAGMA user_version=${previousVersion}`)
      const rows = f.db.prepare('SELECT id, data FROM edits ORDER BY id').all() as {
        id: string
        data: string
      }[]
      for (const row of rows) {
        const legacy = storedHistory(JSON.parse(row.data), previousVersion)
        f.db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(JSON.stringify(legacy), row.id)
      }
      const retained = f.db.prepare('SELECT data FROM edits WHERE id = ?').get(rows[1].id) as {
        data: string
      }
      const invalid = JSON.parse(retained.data)
      if (previousVersion === 17) invalid.snapshots[0].settings.saturation = 10
      else if (previousVersion === 18)
        invalid.snapshots[0].settings.crop = { ...identityCrop, quarterTurns: 1 }
      else invalid.snapshots[0].settings.colorMixer = {}
      f.db
        .prepare('UPDATE edits SET data = ? WHERE id = ?')
        .run(JSON.stringify(invalid), rows[1].id)
      await rejectedBeforeWrites(f, 'edit history format is unsupported')
      f.db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(retained.data, rows[1].id)
      f.db.exec(
        `CREATE TRIGGER interrupt_edit_migration BEFORE UPDATE ON edits WHEN old.id = '${rows[1].id}' BEGIN SELECT RAISE(ABORT, 'Migration interrupted'); END`,
      )
      const before = catalogSnapshot(f.db)
      const library = f.make()
      await expect(library.open()).rejects.toThrow('Migration interrupted')
      await library.close()
      // WAL mode may change before the transaction, while schema/version/data must be atomic.
      expect({ ...catalogSnapshot(f.db), journalMode: before.journalMode }).toEqual(before)
      await f.assertFiles()
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
      settings: { version: SETTINGS_VERSION, processing: 'hdr-v1', crop: identityCrop },
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

test('creative color preflight rejects malformed current and redo groups before catalog or recovery writes', async () => {
  const f = await fixture()
  try {
    const id = f.photos[0].id
    const original = JSON.parse(
      (f.db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as { data: string }).data,
    ) as EditHistory
    original.snapshots = [0, 1, 2].map((exposureEv) => ({
      settings: { ...original.settings, exposureEv },
      createdAt: timestamp,
    }))
    original.cursor = 1
    original.settings = original.snapshots[1].settings
    const corrupt = [
      { noiseReduction: { version: 2, luminance: 0, chroma: 0 } },
      { detailSharpening: { version: 1, amount: 0, radius: 4, threshold: 50 } },
      { colorMixer: undefined },
      { colorMixer: null },
      { colorMixer: { version: 1, ranges: { red: { hue: 0, saturation: 0, luminance: 0 } } } },
      { colorMixer: { ...initialSettings().colorMixer, version: 2 } },
      { colorGrading: undefined },
      { colorGrading: {} },
      { colorGrading: { ...initialSettings().colorGrading, balance: 101 } },
      {
        colorGrading: {
          ...initialSettings().colorGrading,
          tones: { shadows: { hue: 360, saturation: 10, luminance: 0 } },
        },
      },
    ]
    for (const patch of corrupt)
      for (const target of ['current', 0, 2] as const) {
        const history = structuredClone(original)
        Object.assign(
          target === 'current' ? history.settings : history.snapshots[target].settings,
          patch,
        )
        f.db.prepare('UPDATE edits SET data = ? WHERE id = ?').run(JSON.stringify(history), id)
        await rejectedBeforeWrites(f, 'edit history format is unsupported')
      }
  } finally {
    await f.close()
  }
})
