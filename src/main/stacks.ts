import type { DatabaseSync } from 'node:sqlite'
import { COLLECTION_CHUNK_SIZE, type Photo, type PhotoReference } from '../shared/contracts'
import { CollectionChangedError } from '../shared/collections'
import { type CaptureMetadata } from '../shared/capture-sequence'
import {
  type GalleryRead,
  type GalleryChunk,
  type GallerySummary,
  type GalleryRevision,
  type GalleryEntry,
  type GalleryLocation,
  type StackSummary,
  type StackOverview,
  type StackMembers,
  type StackSnapshot,
} from '../shared/stacks'

interface StackRow {
  id: string
  cover_id: string
  expanded: number
  origin: StackSummary['origin']
  revision: number
  automatic_key: string | null
  touched: number
}

/** Catalog reads; schema setup runs only during the explicit startup phase. */
export class StackStore {
  private index?: {
    key: string
    references: Map<string, PhotoReference>
    memberIds: Map<string, string[]>
    covers: Map<string, string>
    entries: {
      id: string
      stack?: StackSummary
      cover?: PhotoReference
      memberIndex?: number
      mergeSourceCount?: number
    }[]
    positions: Map<string, number>
    revision: GalleryRevision
  }
  constructor(protected db: DatabaseSync) {}

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stacks (id TEXT PRIMARY KEY, cover_id TEXT NOT NULL, expanded INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, automatic_key TEXT UNIQUE, touched INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS stack_members (photo_id TEXT PRIMARY KEY, stack_id TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS stack_member_order ON stack_members(stack_id, position);
      CREATE TABLE IF NOT EXISTS capture_metadata (photo_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stack_overrides (photo_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stack_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO stack_state VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS remove_capture_metadata AFTER DELETE ON photos BEGIN DELETE FROM capture_metadata WHERE photo_id = old.id; DELETE FROM stack_overrides WHERE photo_id = old.id; END;
    `)
  }

  private validateOffset(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid collection offset.')
  }
  protected photo(id: string): Photo {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid photo ID.')
    const row = this.db.prepare('SELECT photo FROM photos WHERE id = ?').get(id) as
      { photo: string } | undefined
    if (!row) throw new Error('This photo is unavailable.')
    return JSON.parse(row.photo)
  }
  protected row(id: string, revision?: number): StackRow {
    if (typeof id !== 'string') throw new Error('Invalid stack ID.')
    const row = this.db.prepare('SELECT * FROM stacks WHERE id = ?').get(id) as StackRow | undefined
    if (!row) throw new Error('This stack is unavailable.')
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision !== row.revision))
      throw new Error('Stale stack revision. Reload the stack.')
    return row
  }
  protected expected(id: string, revision: number): StackRow {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid stack revision.')
    return this.row(id, revision)
  }
  protected ids(id: string): string[] {
    return (
      this.db
        .prepare('SELECT photo_id FROM stack_members WHERE stack_id = ? ORDER BY position')
        .all(id) as { photo_id: string }[]
    ).map((r) => r.photo_id)
  }
  protected summary(row: StackRow): StackSummary {
    const { total } = this.db
      .prepare('SELECT COUNT(*) AS total FROM stack_members WHERE stack_id = ?')
      .get(row.id) as { total: number }
    return {
      id: row.id,
      coverId: row.cover_id,
      count: total,
      expanded: !!row.expanded,
      origin: row.origin,
      revision: row.revision,
    }
  }
  overview(): StackOverview {
    const { revision } = this.db
      .prepare('SELECT revision FROM stack_state WHERE singleton = 1')
      .get() as { revision: number }
    return {
      revision,
      stacks: (
        this.db.prepare('SELECT * FROM stacks ORDER BY rowid').all() as unknown as StackRow[]
      ).map((r) => this.summary(r)),
    }
  }
  forPhoto(photoId: string): StackSummary | null {
    this.photo(photoId)
    const row = this.db
      .prepare(
        'SELECT stacks.* FROM stacks JOIN stack_members ON stack_id = stacks.id WHERE photo_id = ?',
      )
      .get(photoId) as StackRow | undefined
    return row ? this.summary(row) : null
  }
  members(id: string, offset = 0): StackMembers {
    this.validateOffset(offset)
    const stack = this.summary(this.row(id))
    const rows = this.db
      .prepare(
        'SELECT photo FROM stack_members JOIN photos ON photo_id = photos.id WHERE stack_id = ? ORDER BY position LIMIT ? OFFSET ?',
      )
      .all(id, COLLECTION_CHUNK_SIZE, offset) as { photo: string }[]
    return { stack, photos: rows.map((r) => JSON.parse(r.photo)), total: stack.count }
  }
  snapshot(id: string, revision: number): StackSnapshot {
    const stack = this.summary(this.expected(id, revision))
    const rows = this.db
      .prepare(
        'SELECT photo FROM stack_members JOIN photos ON photo_id = photos.id WHERE stack_id = ? ORDER BY position',
      )
      .all(id) as { photo: string }[]
    if (rows.length !== stack.count) throw new Error('This stack has unavailable photographs.')
    return { stack, photos: rows.map((row) => JSON.parse(row.photo) as Photo) }
  }

  capture(photoId: string): CaptureMetadata | undefined {
    const row = this.db
      .prepare('SELECT data FROM capture_metadata WHERE photo_id = ?')
      .get(photoId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  private galleryView(expected?: GalleryRevision) {
    const catalogRevision = (
      this.db
        .prepare('SELECT revision FROM collection_catalog_state WHERE singleton = 1')
        .get() as { revision: number }
    ).revision
    const revision = (
      this.db.prepare('SELECT revision FROM stack_state WHERE singleton = 1').get() as {
        revision: number
      }
    ).revision
    if (
      expected &&
      (expected.catalogRevision !== catalogRevision || expected.revision !== revision)
    )
      throw new CollectionChangedError()
    const key = `${catalogRevision}:${revision}`
    if (this.index?.key === key) return this.index
    // A revision-keyed ID/order projection avoids parsing every full photo on every read.
    const ordered = this.db
      .prepare(
        "SELECT id, json_extract(photo, '$.filename') AS filename FROM photos ORDER BY imported_at DESC, rowid DESC",
      )
      .all() as unknown as PhotoReference[]
    const references = new Map(ordered.map((p) => [p.id, p]))
    const overview = this.overview()
    const memberIds = new Map<string, string[]>()
    const covers = new Map<string, string>()
    const memberships = new Map<string, StackSummary>()
    const rows = this.db
      .prepare('SELECT stack_id, photo_id FROM stack_members ORDER BY stack_id, position')
      .all() as { stack_id: string; photo_id: string }[]
    for (const row of rows) {
      const ids = memberIds.get(row.stack_id) ?? []
      ids.push(row.photo_id)
      memberIds.set(row.stack_id, ids)
    }
    for (const stack of overview.stacks)
      for (const id of memberIds.get(stack.id) ?? []) {
        covers.set(id, stack.coverId)
        memberships.set(id, stack)
      }
    const counts = new Map(
      (
        this.db
          .prepare(
            "SELECT id, json_array_length(manifest, '$.recipe.sources') AS count FROM derived_assets",
          )
          .all() as { id: string; count: number }[]
      ).map((r) => [r.id, r.count]),
    )
    const entries = ordered.flatMap((photo) => {
      const stack = memberships.get(photo.id)
      if (!stack) return [{ id: photo.id, mergeSourceCount: counts.get(photo.id) }]
      if (stack.coverId !== photo.id) return []
      const ids = [photo.id, ...(memberIds.get(stack.id) ?? []).filter((id) => id !== photo.id)]
      return (stack.expanded ? ids : [photo.id])
        .filter((id) => references.has(id))
        .map((id, memberIndex) => ({
          id,
          stack,
          cover: photo,
          memberIndex,
          mergeSourceCount: counts.get(id),
        }))
    })
    this.index = {
      key,
      references,
      memberIds,
      covers,
      entries,
      positions: new Map(entries.map((entry, index) => [entry.id, index])),
      revision: { catalogRevision, revision },
    }
    return this.index
  }
  gallerySummary(selectedIds: string[] = [], expected?: GalleryRevision): GallerySummary {
    if (
      !Array.isArray(selectedIds) ||
      selectedIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new Error('Invalid photo selection.')
    const view = this.galleryView(expected)
    return {
      ...view.revision,
      total: view.entries.length,
      storedTotal: view.references.size,
      hiddenSelectedIds: selectedIds.filter(
        (id) => !view.positions.has(id) && view.references.has(id),
      ),
    }
  }
  galleryChunk(offset: number, expected: GalleryRevision): GalleryChunk {
    this.validateOffset(offset)
    if (
      !expected ||
      !Number.isSafeInteger(expected.catalogRevision) ||
      !Number.isSafeInteger(expected.revision) ||
      Object.keys(expected).some(
        (k) =>
          !['catalogRevision', 'revision', 'total', 'storedTotal', 'hiddenSelectedIds'].includes(k),
      )
    )
      throw new Error('Invalid gallery collection revision.')
    const view = this.galleryView(expected)
    const window = view.entries.slice(offset, offset + COLLECTION_CHUNK_SIZE)
    const photos = new Map(
      (
        this.db
          .prepare('SELECT id, photo FROM photos WHERE id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(window.map((e) => e.id))) as { id: string; photo: string }[]
      ).map((r) => [r.id, JSON.parse(r.photo) as Photo]),
    )
    const entries: GalleryEntry[] = window.map(({ id, ...entry }) => ({
      ...entry,
      photo: photos.get(id)!,
    }))
    return { ...this.gallerySummary([], expected), offset, entries }
  }
  gallery(offset = 0, selectedIds: string[] = []): GalleryRead {
    const summary = this.gallerySummary(selectedIds)
    return { ...this.galleryChunk(offset, summary), ...summary }
  }
  locate(
    photoId: string,
    direction: -1 | 0 | 1 = 0,
    expected?: GalleryRevision,
  ): GalleryLocation | null {
    if (![-1, 0, 1].includes(direction)) throw new Error('Invalid photo navigation.')
    const view = this.galleryView(expected)
    const position =
      view.positions.get(photoId) ?? view.positions.get(view.covers.get(photoId) ?? '')
    if (position === undefined) return null
    const index = position + direction
    if (index < 0 || index >= view.entries.length) return null
    const offset = Math.floor(index / COLLECTION_CHUNK_SIZE) * COLLECTION_CHUNK_SIZE
    const chunk = this.galleryChunk(offset, view.revision)
    return {
      ...chunk,
      index,
      photo: direction === 0 ? this.photo(photoId) : chunk.entries[index - offset].photo,
    }
  }
  range(fromId: string, toId: string): PhotoReference[] {
    if (![fromId, toId].every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))
      throw new Error('Invalid photo selection.')
    const { entries, references, memberIds, covers, positions } = this.galleryView()
    if (!references.has(toId)) throw new Error('This photo is unavailable.')
    const to = positions.get(toId) ?? positions.get(covers.get(toId) ?? '')!
    const from = positions.get(fromId) ?? positions.get(covers.get(fromId) ?? '') ?? to
    const selected = new Map<string, PhotoReference>()
    for (const entry of entries.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      const ids =
        entry.stack?.coverId === entry.id ? (memberIds.get(entry.stack.id) ?? []) : [entry.id]
      for (const id of ids) {
        const reference = references.get(id)
        if (reference) selected.set(id, reference)
      }
    }
    return [...selected.values()]
  }
}
