import { expect, test } from '@playwright/test'
import { copyFile, mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { BrowseStore } from '../src/main/browse'
import { PhotoLibrary } from '../src/main/library'
import { processingMetadata } from '../src/main/processing/metadata'
import type { Photo } from '../src/shared/contracts'
import type { BrowseQuery } from '../src/shared/browse'
import type { ProcessingMetadata } from '../src/shared/lens'
import type { PreviewProcessor } from '../src/main/preview-types'
import { stackFixture, finishTask } from './stack.helpers'
import { scan, commit } from './library.helpers'
import { sequenceMetadata } from './capture.helpers'

const query: BrowseQuery = { search: '', grouping: 'date' }

function indexPhoto(
  fixture: Awaited<ReturnType<typeof stackFixture>>,
  index: number,
  changes: Partial<Photo> = {},
  metadata?: ProcessingMetadata,
) {
  const photo = { ...fixture.photos[index], ...changes }
  fixture.photos[index] = photo
  fixture.db
    .prepare('UPDATE photos SET imported_at = ?, photo = ? WHERE id = ?')
    .run(photo.importedAt, JSON.stringify(photo), photo.id)
  new BrowseStore(fixture.db).put(photo, metadata)
  return photo
}

test('all managed photos remain individual across collapsed stacks and calendar grouping', async () => {
  const t = await stackFixture(6)
  try {
    const dates = [
      '2026-10-01T00:05:00+14:00',
      '2026-09-30T23:55:00-12:00',
      '2026-10-01T23:05:00-12:00',
      '2025-12-31',
      '2026-02-30',
      undefined,
    ]
    for (let i = 0; i < dates.length; i++) indexPhoto(t, i, { capturedAt: dates[i] })
    const ids = t.photos.map((p) => p.id)
    t.library.groupPhotos(ids.slice(0, 3), ids[0], t.library.listStacks().revision)
    expect(t.library.listGallery().total).toBe(4)
    expect(t.library.getBrowseSummary(query).sections).toEqual([
      { key: '2026-10-01', label: '1 October 2026', offset: 0, count: 2, selected: 0 },
      { key: '2026-09-30', label: '30 September 2026', offset: 2, count: 1, selected: 0 },
      { key: '2025-12-31', label: '31 December 2025', offset: 3, count: 1, selected: 0 },
      { key: 'unknown', label: 'Unknown date', offset: 4, count: 2, selected: 0 },
    ])
    expect(
      t.library
        .getBrowseSummary({ ...query, grouping: 'month' })
        .sections.map((s) => [s.key, s.count]),
    ).toEqual([
      ['2026-10', 2],
      ['2026-09', 1],
      ['2025-12', 1],
      ['unknown', 2],
    ])
    expect(
      t.library
        .getBrowseSummary({ ...query, grouping: 'year' })
        .sections.map((s) => [s.key, s.count]),
    ).toEqual([
      ['2026', 3],
      ['2025', 1],
      ['unknown', 2],
    ])
    expect(t.library.getBrowseChunk(query).photos.map((p) => p.id)).toEqual([
      ids[2],
      ids[0],
      ids[1],
      ids[3],
      ids[5],
      ids[4],
    ])
    expect(t.library.getBrowseChunk(query).photos[0].dateOrigin).toEqual({ kind: 'camera' })
    expect(t.library.getBrowseChunk(query).photos.at(-1)?.dateOrigin).toEqual({ kind: 'unknown' })
    expect(t.library.getBrowseRange(query, ids[2], ids[1]).map((p) => p.id)).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ])
  } finally {
    await t.close()
  }
})

test('metadata terms match across fields, ISO dates and literal punctuation with deterministic ties', async () => {
  const t = await stackFixture(5)
  try {
    const metadata = processingMetadata(
      {
        'IFD0:Make': 'SONY',
        'IFD0:Model': 'ZV-1',
        'ExifIFD:LensModel': 'ZEISS 24–70mm',
        'ExifIFD:DateTimeOriginal': '2026:10:01 12:00:00',
      },
      [],
    )
    indexPhoto(t, 0, { filename: 'Holiday_50%.ARW', format: 'ARW' }, metadata)
    indexPhoto(t, 1, { filename: 'Holiday_50A.ARW', format: 'ARW', camera: 'Canon', lens: 'Prime' })
    const tied = { capturedAt: '2026-10-01T12:00:00', importedAt: '2026-10-10T12:00:00Z' }
    indexPhoto(t, 2, tied)
    indexPhoto(t, 3, tied)
    indexPhoto(t, 4, { ...tied, importedAt: '2026-10-11T12:00:00Z' })
    const ids = t.photos.map((p) => p.id)
    for (const search of ['holiday SONY zeiss arw 2026-10', '50%', 'holiday_50%'])
      expect(t.library.getBrowseChunk({ ...query, search }).photos.map((p) => p.id)).toEqual([
        ids[0],
      ])
    expect(t.library.getBrowseSummary({ ...query, search: 'canon prime' }).total).toBe(1)
    expect(t.library.getBrowseSummary({ ...query, search: '%' }).total).toBe(1)
    expect(t.library.getBrowseSummary({ ...query, search: "' OR 1=1" }).total).toBe(0)
    expect(t.library.getBrowseSummary({ ...query, search: 'camera:sony' }).total).toBe(0)
    expect(
      t.library.getBrowseChunk({ ...query, search: '2026-10' }).photos.map((p) => p.id),
    ).toEqual([ids[4], ids[3], ids[2], ids[0]])
  } finally {
    await t.close()
  }
})

test('large sections expose bounded chunks and complete references and selection counts outside results', async () => {
  const t = await stackFixture(183)
  try {
    for (let i = 0; i < 183; i++)
      indexPhoto(t, i, {
        capturedAt: i < 181 ? '2026-10-01' : '2026-09-30',
        importedAt: '2026-10-02',
        camera: i % 2 ? 'SONY' : 'Canon',
      })
    const ids = t.photos.map((p) => p.id)
    const summary = t.library.getBrowseSummary(query, [
      ids[0],
      ids[80],
      ids[180],
      ids[182],
      ids[80],
      'f'.repeat(64),
    ])
    expect(summary).toMatchObject({ total: 183, selected: 4, outsideSelected: 0 })
    expect(summary.sections.map((s) => [s.key, s.count, s.selected, s.offset])).toEqual([
      ['2026-10-01', 181, 3, 0],
      ['2026-09-30', 2, 1, 181],
    ])
    expect(t.library.getBrowseChunk(query, 0, summary.revision).photos).toHaveLength(60)
    expect(t.library.getBrowseChunk(query, 60, summary.revision).photos).toHaveLength(60)
    expect(t.library.getBrowseChunk(query, 180, summary.revision).photos).toHaveLength(3)
    expect(t.library.getBrowseChunk(query, 183).photos).toEqual([])
    expect(t.library.locateBrowsePhoto(query, ids[80], summary.revision)).toMatchObject({
      index: 100,
      photo: { id: ids[80] },
    })
    const section = t.library.getBrowseSection(query, '2026-10-01')
    expect(section.map((p) => p.id)).toEqual(ids.slice(0, 181).reverse())
    expect(Object.keys(section[0]).sort()).toEqual(['filename', 'id'])
    expect(t.library.getBrowseRange(query, ids[0], ids[180]).map((p) => p.id)).toEqual(
      section.map((p) => p.id),
    )
    const filtered = { ...query, search: 'sony' }
    expect(
      t.library.getBrowseSummary(
        filtered,
        section.map((p) => p.id),
      ),
    ).toMatchObject({
      total: 91,
      selected: 181,
      outsideSelected: 91,
    })
    expect(
      t.library.getBrowseSummary(
        filtered,
        section.map((p) => p.id),
      ).sections[0],
    ).toMatchObject({ count: 90, selected: 90 })
    expect(t.library.getBrowseSection(filtered, '2026-10-01')).toHaveLength(90)
    expect(t.library.getBrowseRange(filtered, ids[179], ids[1])).toHaveLength(90)
    expect(t.library.getBrowseRange(filtered, ids[180], ids[1])).toEqual([
      { id: ids[1], filename: t.photos[1].filename },
    ])
    expect(t.library.locateBrowsePhoto(filtered, ids[0])).toBeNull()
  } finally {
    await t.close()
  }
})

test('catalog revisions reject stale chunks and locations and deletion removes indexed selections', async () => {
  const t = await stackFixture(3)
  try {
    for (let i = 0; i < 3; i++) indexPhoto(t, i, { capturedAt: '2026-10-01' })
    const before = t.library.getBrowseSummary(query)
    new BrowseStore(t.db).put(t.photos[0])
    expect(t.library.getBrowseSummary(query).revision).toBe(before.revision)
    indexPhoto(t, 0, { capturedAt: '2026-10-02' })
    expect(() => t.library.getBrowseChunk(query, 0, before.revision)).toThrow(
      'browse catalog changed',
    )
    expect(() => t.library.locateBrowsePhoto(query, t.photos[0].id, before.revision)).toThrow(
      'browse catalog changed',
    )
    const ids = t.photos.map((p) => p.id)
    expect((await finishTask(t.library, t.library.deletePhotos([ids[0]])!)).status).toBe(
      'completed',
    )
    expect(t.library.getBrowseSummary(query, ids)).toMatchObject({ total: 2, selected: 2 })
    expect(t.library.getBrowseSection(query, '2026-10-02')).toEqual([])
    expect(t.library.locateBrowsePhoto(query, ids[0])).toBeNull()
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM photo_browse').get()).toMatchObject({
      count: 2,
    })
    expect(() => t.library.getBrowseChunk(query, -1)).toThrow('offset')
    expect(() => t.library.getBrowseSummary({ ...query, search: 'a'.repeat(501) })).toThrow('query')
    expect(() => t.library.getBrowseSummary(query, ['../../originals'])).toThrow('ID')
    expect(() => t.library.getBrowseSection(query, "unknown' OR 1=1")).toThrow('section')
    await t.restart()
    expect(t.library.getBrowseSummary(query, ids)).toMatchObject({ total: 2, selected: 2 })
  } finally {
    await t.close()
  }
})

test('accepted imports publish dates and metadata atomically without changing earlier browse results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-browse-import-'))
  const fixture = resolve('tests/fixtures/photos/alpine-lake.jpg')
  const processor: PreviewProcessor = {
    process: async (path, output) => {
      await copyFile(fixture, join(output, 'thumb.jpg'))
      await copyFile(fixture, join(output, 'preview.jpg'))
      const first = (await readFile(path, 'utf8')) === 'first original'
      return {
        metadata: {
          width: 1200,
          height: 800,
          camera: 'Sony ZV-1',
          lens: 'ZEISS',
          capturedAt: '1999-01-01',
        },
        source: 'embedded',
        processing: processingMetadata({ 'ExifIFD:DateTimeOriginal': '2000:01:01 12:00:00' }, []),
        captureMetadata: sequenceMetadata(
          first ? 1 : 2,
          first ? '2026-10-01T00:01:00+14:00' : '2026-09-30T23:59:00-12:00',
        ),
      }
    },
    close: async () => {},
  }
  await mkdir(join(root, 'trash'))
  const library = new PhotoLibrary(
    join(root, 'library'),
    processor,
    () => {},
    undefined,
    async (path) => {
      await rename(path, join(root, 'trash', basename(path)))
    },
  )
  try {
    await library.open()
    const paths = ['first', 'second'].map((name) => join(root, `${name}.ARW`))
    await writeFile(paths[0], 'first original')
    await writeFile(paths[1], 'second original')
    await commit(library, await scan(library, [paths[0]]))
    const before = library.getBrowseSummary(query)
    const first = library.getBrowseChunk(query).photos[0]
    expect(first.captureDate?.slice(0, 10)).toBe('2026-10-01')
    await commit(library, await scan(library, [paths[1]]))
    expect(library.getBrowseSummary(query, [first.id])).toMatchObject({ total: 2, selected: 1 })
    expect(library.getBrowseSummary({ ...query, search: 'sony zeiss 2026-09' }).total).toBe(1)
    expect(library.getBrowseChunk(query).photos[0].id).toBe(first.id)
    expect(library.locateBrowsePhoto(query, first.id)?.index).toBe(0)
    expect(() => library.getBrowseChunk(query, 0, before.revision)).toThrow(
      'browse catalog changed',
    )
    for (const [i, photo] of library.getBrowseChunk(query).photos.entries())
      expect(
        await readFile(join(root, 'library', 'originals', photo.id, 'original.arw'), 'utf8'),
      ).toBe(i ? 'second original' : 'first original')
  } finally {
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('metadata and capture refresh update search and grouping without reimporting originals', async () => {
  const t = await stackFixture(1)
  try {
    indexPhoto(t, 0)
    const metadata = processingMetadata(
      {
        'IFD0:Make': 'Sony',
        'IFD0:Model': 'ZV-1',
        'ExifIFD:LensModel': 'Refreshed lens',
        'ExifIFD:DateTimeOriginal': '2026:10:03 12:00:00',
      },
      [],
    )
    let calls = 0
    ;(
      t.library as unknown as {
        metadataProcessor: {
          inspect: () => Promise<ProcessingMetadata>
          close: () => Promise<void>
        }
      }
    ).metadataProcessor = {
      inspect: async () => {
        calls++
        return metadata
      },
      close: async () => {},
    }
    const before = t.library.getBrowseSummary(query)
    await t.library.getEdits(t.photos[0].id)
    expect(calls).toBe(1)
    expect(
      t.library.getBrowseSummary({ ...query, search: 'sony refreshed 2026-10-03' }).total,
    ).toBe(1)
    expect(t.library.getBrowseSummary(query).revision).toBeGreaterThan(before.revision)
    ;(
      t.library as unknown as {
        captureProcessor: {
          inspectCapture: () => Promise<ReturnType<typeof sequenceMetadata>>
          close: () => Promise<void>
        }
      }
    ).captureProcessor = {
      inspectCapture: async () => sequenceMetadata(1, '2026-10-04T00:05:00+14:00'),
      close: async () => {},
    }
    expect((await finishTask(t.library, t.library.groupCaptureSequences())).status).toBe(
      'completed',
    )
    expect(t.library.getBrowseSummary(query).sections[0].key).toBe('2026-10-04')
    expect(
      await readFile(join(t.root, 'library', 'originals', t.photos[0].id, 'original.jpg'), 'utf8'),
    ).toBe('original-0')
    await t.restart()
    expect(t.library.getBrowseSummary(query).sections[0].key).toBe('2026-10-04')
  } finally {
    await t.close()
  }
})
