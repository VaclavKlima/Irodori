import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { processingMetadata } from '../src/main/processing/metadata'
import type { BrowseQuery } from '../src/shared/browse'
import { initialSettings } from '../src/shared/edits'
import { noLensSettings } from '../src/shared/lens'
import { MERGE_VERSION, type MergeManifest } from '../src/shared/merge'
import { sequenceMetadata } from './capture.helpers'
import { syntheticMerge } from './merge.helpers'
import { stackFixture, finishTask } from './stack.helpers'

const query: BrowseQuery = { search: '', grouping: 'date' }

function removeBrowseIndex(fixture: Awaited<ReturnType<typeof stackFixture>>) {
  fixture.db.exec(
    'DROP TRIGGER remove_browse; DROP TABLE photo_browse; DROP TABLE browse_state; PRAGMA user_version = 14;',
  )
}

test('version 14 backfills stored capture and processing metadata transactionally without decoding and preserves edits on restart', async () => {
  const t = await stackFixture(3)
  try {
    const ids = t.photos.map((p) => p.id)
    const metadata = processingMetadata(
      {
        'IFD0:Make': 'SONY',
        'IFD0:Model': 'ZV-1',
        'ExifIFD:LensModel': 'Legacy ZEISS lens',
        'ExifIFD:DateTimeOriginal': '2026:09:30 23:59:00-1200',
      },
      [],
    )
    t.db
      .prepare('INSERT INTO processing VALUES (?, ?)')
      .run(ids[1], JSON.stringify({ metadata, settings: noLensSettings, revision: 0 }))
    const snapshots = [-1.25, 0.5, 2.25].map((exposureEv, i) => ({
      settings: {
        ...initialSettings(noLensSettings),
        processing: 'display-referred-v1',
        exposureEv,
      },
      createdAt: `2026-09-0${i + 1}T12:00:00.000Z`,
    }))
    const history = {
      photoId: ids[1],
      revision: 17,
      settings: snapshots[1].settings,
      snapshots,
      cursor: 1,
      canUndo: true,
      canRedo: true,
    }
    t.db.prepare('INSERT INTO edits VALUES (?, ?)').run(ids[1], JSON.stringify(history))
    t.capture(0, sequenceMetadata(1, '2026-10-01T00:01:00+14:00'))
    t.capture(2, {
      ...sequenceMetadata(2, 'malformed precise time'),
      dateTimeOriginal: '2024:02:29 23:59:59-1200',
    })
    t.db
      .prepare('UPDATE photos SET photo = ? WHERE id = ?')
      .run(JSON.stringify({ ...t.photos[0], capturedAt: '1999-01-01' }), ids[0])
    t.db
      .prepare('UPDATE photos SET photo = ? WHERE id = ?')
      .run(JSON.stringify({ ...t.photos[2], capturedAt: '2026-02-29' }), ids[2])
    await t.library.close()
    removeBrowseIndex(t)
    const originalRows = t.db.prepare('SELECT id, photo FROM photos ORDER BY id').all()
    // The fixture processor throws if invoked; migration must use only catalog metadata.
    await t.restart()
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 15 })
    expect(t.db.prepare('SELECT id, photo FROM photos ORDER BY id').all()).toEqual(originalRows)
    expect(t.library.getBrowseSummary(query).sections.map((s) => [s.key, s.count])).toEqual([
      ['2026-10-01', 1],
      ['2026-09-30', 1],
      ['2024-02-29', 1],
    ])
    expect(t.library.getBrowseSummary({ ...query, search: 'sony zeiss 2026-09' }).total).toBe(1)
    expect(await t.library.getEditHistory(ids[1])).toMatchObject(history)
    const indexed = t.library.getBrowseChunk(query)
    expect(indexed.photos.map((p) => p.dateOrigin)).toEqual([
      { kind: 'camera' },
      { kind: 'camera' },
      { kind: 'camera' },
    ])
    await t.restart()
    expect(t.library.getBrowseChunk(query)).toEqual(indexed)
    expect(await t.library.getEditHistory(ids[1])).toMatchObject(history)
    expect((await t.library.redoEdit(ids[1], 17)).settings.exposureEv).toBe(2.25)
    for (const [i, id] of ids.entries())
      expect(await readFile(join(t.root, 'library', 'originals', id, 'original.jpg'), 'utf8')).toBe(
        `original-${i}`,
      )
  } finally {
    await t.close()
  }
})

test('failed browse backfill rolls back its partial rows and schema version before a clean retry', async () => {
  const t = await stackFixture(2)
  try {
    t.capture(0, sequenceMetadata(1))
    t.capture(1, sequenceMetadata(2))
    await t.library.close()
    removeBrowseIndex(t)
    t.db
      .prepare('UPDATE capture_metadata SET data = ? WHERE photo_id = ?')
      .run('{invalid json', t.photos[1].id)
    const originals = t.db.prepare('SELECT * FROM photos ORDER BY id').all()
    await expect(t.restart()).rejects.toThrow()
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 14 })
    expect(
      t.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('photo_browse', 'browse_state')",
        )
        .all(),
    ).toEqual([])
    expect(t.db.prepare('SELECT * FROM photos ORDER BY id').all()).toEqual(originals)
    await t.library.close()
    t.capture(1, sequenceMetadata(2))
    await t.restart()
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 15 })
    expect(t.library.getBrowseSummary(query).total).toBe(2)
    const before = t.library.getBrowseChunk(query)
    await t.restart()
    expect(t.library.getBrowseChunk(query)).toEqual(before)
  } finally {
    await t.close()
  }
})

test('legacy merge dates inherit surviving references, persist after their deletion and keep immutable manifests', async () => {
  const t = await stackFixture(4)
  const f = await syntheticMerge([1, 1])
  try {
    const ids = t.photos.map((p) => p.id)
    t.capture(1, sequenceMetadata(1, '2024-02-29T00:05:00+14:00'))
    const manifests: string[] = []
    for (const index of [2, 3]) {
      const photo = {
        ...t.photos[index],
        assetKind: 'derived' as const,
        filename: `Legacy-${index}.luma`,
        format: 'LUMA HDR',
      }
      const recipe = structuredClone(f.result.recipe)
      if (index === 3) {
        recipe.settings.referenceId = 'e'.repeat(64)
        recipe.sources[1].id = recipe.settings.referenceId
      }
      const manifest: MergeManifest = {
        version: MERGE_VERSION,
        asset: f.result.asset,
        recipe,
        photo,
        metadata: { ...f.sources[1].metadata, capturedAt: undefined },
      }
      const json = JSON.stringify(manifest)
      manifests.push(json)
      t.db
        .prepare('UPDATE photos SET photo = ? WHERE id = ?')
        .run(JSON.stringify(photo), ids[index])
      t.db.prepare('INSERT INTO derived_assets VALUES (?, ?)').run(ids[index], json)
      await writeFile(join(t.root, 'library', 'originals', ids[index], 'manifest.json'), json)
    }
    await t.library.close()
    removeBrowseIndex(t)
    await t.restart()
    const inherited = t.library.locateBrowsePhoto(query, ids[2])!.photo
    expect(inherited.captureDate).toBe('2024-02-29T00:05:00.000000000000000000')
    expect(inherited.dateOrigin).toEqual({
      kind: 'merge-reference',
      photoId: ids[1],
      filename: f.sources[1].photo.filename,
    })
    const unknown = t.library.locateBrowsePhoto(query, ids[3])!.photo
    expect(unknown.captureDate).toBeNull()
    expect(unknown.dateOrigin).toMatchObject({ kind: 'merge-reference', photoId: 'e'.repeat(64) })
    expect(t.library.getBrowseSection(query, '2024-02-29').map((p) => p.id)).toEqual([
      ids[2],
      ids[1],
    ])
    expect((await finishTask(t.library, t.library.deletePhotos([ids[0], ids[1]])!)).status).toBe(
      'completed',
    )
    expect(t.library.locateBrowsePhoto(query, ids[2])!.photo).toEqual(inherited)
    await t.restart()
    expect(t.library.locateBrowsePhoto(query, ids[2])!.photo).toEqual(inherited)
    expect(t.library.getBrowseSummary(query).sections.map((s) => [s.key, s.count])).toEqual([
      ['2024-02-29', 1],
      ['unknown', 1],
    ])
    for (const [i, index] of [2, 3].entries()) {
      expect(
        await readFile(join(t.root, 'library', 'originals', ids[index], 'manifest.json'), 'utf8'),
      ).toBe(manifests[i])
      expect(
        t.db.prepare('SELECT manifest FROM derived_assets WHERE id = ?').get(ids[index]),
      ).toMatchObject({ manifest: manifests[i] })
    }
  } finally {
    await f.close()
    await t.close()
  }
})
