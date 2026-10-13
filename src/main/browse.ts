import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Photo, PhotoReference } from '../shared/contracts'
import type { ProcessingMetadata } from '../shared/lens'
import type { MergeManifest } from '../shared/merge'
import type { CaptureMetadata } from '../shared/capture-sequence'
import {
  BROWSE_CHUNK_SIZE,
  BrowseCatalogChangedError,
  browseTerms,
  browseSectionLabel,
  validatedCaptureDate,
  type BrowseQuery,
  type BrowseSummary,
  type BrowseChunk,
  type BrowseLocation,
  type BrowsePhoto,
  type CaptureDateOrigin,
} from '../shared/browse'

interface Row {
  id: string
  filename: string
  captured_at: string | null
  origin: string
  photo: string
}
const order = 'b.captured_at DESC, b.imported_at DESC, b.id DESC'
const hash = /^[a-f0-9]{64}$/

/** Only summaries and references span the catalog. Full photo records stay in 60-item chunks. */
export class BrowseStore {
  constructor(private db: DatabaseSync) {}

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS photo_browse (id TEXT PRIMARY KEY, filename TEXT NOT NULL, imported_at TEXT NOT NULL, captured_at TEXT, origin TEXT NOT NULL, search_text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS browse_order ON photo_browse(captured_at DESC, imported_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS browse_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO browse_state VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS remove_browse AFTER DELETE ON photos BEGIN DELETE FROM photo_browse WHERE id = old.id; END;
      CREATE TRIGGER IF NOT EXISTS browse_insert AFTER INSERT ON photo_browse BEGIN UPDATE browse_state SET revision = revision + 1; END;
      CREATE TRIGGER IF NOT EXISTS browse_update AFTER UPDATE ON photo_browse BEGIN UPDATE browse_state SET revision = revision + 1; END;
      CREATE TRIGGER IF NOT EXISTS browse_delete AFTER DELETE ON photo_browse BEGIN UPDATE browse_state SET revision = revision + 1; END;
    `)
  }

  backfill() {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.photo, processing.data, derived_assets.manifest, capture_metadata.data AS capture FROM photos p
      LEFT JOIN processing ON processing.id = p.id LEFT JOIN derived_assets ON derived_assets.id = p.id LEFT JOIN capture_metadata ON capture_metadata.photo_id = p.id
      LEFT JOIN photo_browse b ON b.id = p.id WHERE b.id IS NULL`,
      )
      .all() as {
      photo: string
      data: string | null
      manifest: string | null
      capture: string | null
    }[]
    // Originals first, so legacy merge references resolve even when the source predates the index.
    for (const row of rows.filter((r) => (JSON.parse(r.photo) as Photo).assetKind !== 'derived'))
      this.put(
        JSON.parse(row.photo),
        row.data ? JSON.parse(row.data).metadata : undefined,
        undefined,
        row.capture ? JSON.parse(row.capture) : undefined,
      )
    for (const row of rows.filter((r) => (JSON.parse(r.photo) as Photo).assetKind === 'derived'))
      this.put(
        JSON.parse(row.photo),
        row.data ? JSON.parse(row.data).metadata : undefined,
        row.manifest ? JSON.parse(row.manifest) : undefined,
      )
  }

  put(
    photo: Photo,
    metadata?: ProcessingMetadata,
    manifest?: MergeManifest,
    capture?: CaptureMetadata,
  ) {
    let capturedAt =
      [capture?.preciseTime, capture?.dateTimeOriginal, metadata?.capturedAt, photo.capturedAt]
        .map(validatedCaptureDate)
        .find((date) => date !== null) ?? null
    let origin: CaptureDateOrigin = capturedAt ? { kind: 'camera' } : { kind: 'unknown' }
    if (photo.assetKind === 'derived') {
      const recipe = manifest?.recipe ?? metadata?.mergeMaster?.recipe
      const referenceId =
        photo.captureDateOrigin?.kind === 'merge-reference'
          ? photo.captureDateOrigin.photoId
          : recipe?.settings?.referenceId
      const source = recipe?.sources?.find((s) => s.id === referenceId)
      if (referenceId) {
        origin = photo.captureDateOrigin ?? {
          kind: 'merge-reference',
          photoId: referenceId,
          filename: source?.filename ?? 'Unknown reference',
        }
        // Once recovered, keep the date independently of source deletion and immutable manifests.
        const existing = this.db
          .prepare('SELECT captured_at FROM photo_browse WHERE id = ?')
          .get(photo.id) as { captured_at: string | null } | undefined
        const reference = this.db
          .prepare('SELECT captured_at FROM photo_browse WHERE id = ?')
          .get(referenceId) as { captured_at: string | null } | undefined
        capturedAt =
          photo.captureDateOrigin?.kind === 'merge-reference'
            ? validatedCaptureDate(photo.capturedAt ?? metadata?.capturedAt)
            : (existing?.captured_at ?? reference?.captured_at ?? null)
      } else capturedAt = null
    }
    const search = [
      photo.filename,
      photo.camera,
      metadata?.make,
      metadata?.model,
      photo.lens,
      metadata?.lens,
      photo.format,
      photo.capturedAt,
      capturedAt?.replace(/\.0+$/, ''),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    const importedAt =
      typeof photo.importedAt === 'string'
        ? photo.importedAt
        : ((
            this.db.prepare('SELECT imported_at FROM photos WHERE id = ?').get(photo.id) as
              { imported_at: string | null } | undefined
          )?.imported_at ?? '')
    this.db
      .prepare(
        `INSERT INTO photo_browse VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, imported_at=excluded.imported_at, captured_at=excluded.captured_at, origin=excluded.origin, search_text=excluded.search_text
      WHERE filename != excluded.filename OR imported_at != excluded.imported_at OR captured_at IS NOT excluded.captured_at OR origin != excluded.origin OR search_text != excluded.search_text`,
      )
      .run(photo.id, photo.filename, importedAt, capturedAt, JSON.stringify(origin), search)
  }

  private revision(expected?: number) {
    const revision = (
      this.db.prepare('SELECT revision FROM browse_state').get() as { revision: number }
    ).revision
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== revision))
      throw new BrowseCatalogChangedError()
    return revision
  }
  private filter(query: BrowseQuery) {
    if (
      !query ||
      typeof query.search !== 'string' ||
      query.search.length > 500 ||
      !['date', 'month', 'year'].includes(query.grouping) ||
      Object.keys(query).some((k) => !['search', 'grouping'].includes(k))
    )
      throw new Error('Invalid browse query.')
    const terms = browseTerms(query.search)
    return {
      sql: terms.length ? terms.map(() => 'instr(b.search_text, ?) > 0').join(' AND ') : '1',
      values: terms as SQLInputValue[],
    }
  }
  private id(id: string) {
    if (typeof id !== 'string' || !hash.test(id)) throw new Error('Invalid browse photo ID.')
  }
  private sectionExpression(query: BrowseQuery) {
    return `COALESCE(substr(b.captured_at, 1, ${query.grouping === 'date' ? 10 : query.grouping === 'month' ? 7 : 4}), 'unknown')`
  }
  summary(query: BrowseQuery, selectedIds: string[] = []): BrowseSummary {
    const filter = this.filter(query),
      revision = this.revision()
    if (!Array.isArray(selectedIds)) throw new Error('Invalid browse selection.')
    for (const id of selectedIds) this.id(id)
    const selected = JSON.stringify([...new Set(selectedIds)])
    const rows = this.db
      .prepare(
        `SELECT ${this.sectionExpression(query)} AS key, COUNT(*) AS count, SUM(b.id IN (SELECT value FROM json_each(?))) AS selected FROM photo_browse b WHERE ${filter.sql} GROUP BY key ORDER BY key = 'unknown', key DESC`,
      )
      .all(selected, ...filter.values) as { key: string; count: number; selected: number }[]
    let total = 0,
      matchingSelected = 0
    const sections = rows.map((row) => {
      const section = { ...row, label: browseSectionLabel(row.key), offset: total }
      total += row.count
      matchingSelected += row.selected
      return section
    })
    const selectedCount = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS count FROM photo_browse WHERE id IN (SELECT value FROM json_each(?))',
        )
        .get(selected) as { count: number }
    ).count
    return {
      revision,
      total,
      selected: selectedCount,
      outsideSelected: selectedCount - matchingSelected,
      sections,
    }
  }
  private photo(row: Row): BrowsePhoto {
    return {
      ...JSON.parse(row.photo),
      captureDate: row.captured_at,
      dateOrigin: JSON.parse(row.origin),
    }
  }
  chunk(query: BrowseQuery, offset = 0, expectedRevision?: number): BrowseChunk {
    const filter = this.filter(query),
      revision = this.revision(expectedRevision)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid browse offset.')
    const rows = this.db
      .prepare(
        `SELECT b.*, p.photo FROM photo_browse b JOIN photos p ON p.id = b.id WHERE ${filter.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...filter.values, BROWSE_CHUNK_SIZE, offset) as unknown as Row[]
    return { revision, offset, photos: rows.map((row) => this.photo(row)) }
  }
  locate(query: BrowseQuery, id: string, expectedRevision?: number): BrowseLocation | null {
    const filter = this.filter(query),
      revision = this.revision(expectedRevision)
    this.id(id)
    const row = this.db
      .prepare(
        `WITH ordered AS (SELECT b.*, ROW_NUMBER() OVER (ORDER BY ${order}) - 1 AS position FROM photo_browse b WHERE ${filter.sql}) SELECT ordered.*, p.photo FROM ordered JOIN photos p ON p.id = ordered.id WHERE ordered.id = ?`,
      )
      .get(...filter.values, id) as unknown as (Row & { position: number }) | undefined
    return row ? { revision, index: row.position, photo: this.photo(row) } : null
  }
  range(query: BrowseQuery, fromId: string, toId: string): PhotoReference[] {
    const filter = this.filter(query)
    this.id(fromId)
    this.id(toId)
    return this.db
      .prepare(
        `WITH ordered AS (SELECT b.id, b.filename, ROW_NUMBER() OVER (ORDER BY ${order}) AS position FROM photo_browse b WHERE ${filter.sql}),
      endpoints AS (SELECT COALESCE((SELECT position FROM ordered WHERE id = ?), (SELECT position FROM ordered WHERE id = ?)) AS a, (SELECT position FROM ordered WHERE id = ?) AS z)
      SELECT id, filename FROM ordered, endpoints WHERE position BETWEEN MIN(a,z) AND MAX(a,z) ORDER BY position`,
      )
      .all(...filter.values, fromId, toId, toId) as unknown as PhotoReference[]
  }
  section(query: BrowseQuery, key: string): PhotoReference[] {
    const filter = this.filter(query)
    if (typeof key !== 'string' || (key !== 'unknown' && !/^\d{4}(?:-\d{2}){0,2}$/.test(key)))
      throw new Error('Invalid browse section.')
    return this.db
      .prepare(
        `SELECT b.id, b.filename FROM photo_browse b WHERE ${filter.sql} AND ${this.sectionExpression(query)} = ? ORDER BY ${order}`,
      )
      .all(...filter.values, key) as unknown as PhotoReference[]
  }
}
