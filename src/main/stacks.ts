import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { PAGE_SIZE, type Photo, type PhotoReference } from '../shared/contracts'
import type { MergeManifest } from '../shared/merge'
import {
  detectCaptureSequences,
  preciseCaptureTime,
  type CaptureMetadata,
} from '../shared/capture-sequence'
import {
  galleryPosition,
  projectGallery,
  type GalleryPage,
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

/** The caller owns publication/removal transactions; public mutations own short transactions. */
export class StackStore {
  constructor(private db: DatabaseSync) {}

  migrate() {
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

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private bump() {
    this.db.exec('UPDATE stack_state SET revision = revision + 1 WHERE singleton = 1')
  }
  private validateOffset(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid page offset.')
  }
  private photo(id: string): Photo {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid photo ID.')
    const row = this.db.prepare('SELECT photo FROM photos WHERE id = ?').get(id) as
      { photo: string } | undefined
    if (!row) throw new Error('This photo is unavailable.')
    return JSON.parse(row.photo)
  }
  private row(id: string, revision?: number): StackRow {
    if (typeof id !== 'string') throw new Error('Invalid stack ID.')
    const row = this.db.prepare('SELECT * FROM stacks WHERE id = ?').get(id) as StackRow | undefined
    if (!row) throw new Error('This stack is unavailable.')
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision !== row.revision))
      throw new Error('Stale stack revision. Reload the stack.')
    return row
  }
  private expected(id: string, revision: number): StackRow {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid stack revision.')
    return this.row(id, revision)
  }
  private ids(id: string): string[] {
    return (
      this.db
        .prepare('SELECT photo_id FROM stack_members WHERE stack_id = ? ORDER BY position')
        .all(id) as { photo_id: string }[]
    ).map((r) => r.photo_id)
  }
  private summary(row: StackRow): StackSummary {
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
      .all(id, PAGE_SIZE, offset) as { photo: string }[]
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
  private remember(ids: string[], reason: string) {
    for (const id of ids)
      this.db.prepare('INSERT OR REPLACE INTO stack_overrides VALUES (?, ?)').run(id, reason)
  }
  private ordered(ids: string[], coverId: string): string[] {
    const photos = ids.map((id) => {
      const row = this.db.prepare('SELECT rowid, photo FROM photos WHERE id = ?').get(id) as {
        rowid: number
        photo: string
      }
      const photo = JSON.parse(row.photo) as Photo
      const metadata = this.capture(id)
      const time =
        preciseCaptureTime(metadata?.preciseTime) ??
        preciseCaptureTime(
          photo.capturedAt
            ?.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T')
            .replace(/(T\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/, '$1.0$2'),
        )
      const imported = Date.parse(photo.importedAt)
      // A per-photo fallback produces a total order even when only some dates are known.
      const sortTime =
        time ?? (Number.isFinite(imported) ? BigInt(imported) * 10n ** 15n : BigInt(row.rowid))
      return { photo, rowid: row.rowid, sortTime }
    })
    return photos
      .sort((a, b) => {
        if (a.photo.id === coverId) return -1
        if (b.photo.id === coverId) return 1
        if (a.photo.assetKind === 'derived' || b.photo.assetKind === 'derived') {
          if (a.photo.assetKind !== b.photo.assetKind)
            return a.photo.assetKind === 'derived' ? -1 : 1
          return b.photo.importedAt.localeCompare(a.photo.importedAt) || b.rowid - a.rowid
        }
        if (a.sortTime !== b.sortTime) return a.sortTime < b.sortTime ? -1 : 1
        return a.photo.importedAt.localeCompare(b.photo.importedAt) || a.rowid - b.rowid
      })
      .map((p) => p.photo.id)
  }
  private membership(id: string, ids: string[], coverId: string) {
    this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(id)
    for (const [position, photoId] of this.ordered(ids, coverId).entries())
      this.db.prepare('INSERT INTO stack_members VALUES (?, ?, ?)').run(photoId, id, position)
  }
  group(ids: string[], coverId: string, revision: number): StackSummary {
    return this.transaction(() => {
      if (!Number.isSafeInteger(revision) || revision !== this.overview().revision)
        throw new Error('Stale gallery revision. Reload the library.')
      if (
        !Array.isArray(ids) ||
        ids.length < 2 ||
        new Set(ids).size !== ids.length ||
        !ids.includes(coverId)
      )
        throw new Error('Select at least two ungrouped photos and a selected cover.')
      for (const id of ids)
        if (this.forPhoto(id)) throw new Error('Manual grouping requires ungrouped photos.')
      const id = randomUUID()
      this.db
        .prepare("INSERT INTO stacks (id, cover_id, origin, touched) VALUES (?, ?, 'manual', 1)")
        .run(id, coverId)
      this.membership(id, ids, coverId)
      this.remember(ids, 'manual-group')
      this.bump()
      return this.summary(this.row(id))
    })
  }
  ungroup(id: string, revision: number) {
    this.transaction(() => {
      this.expected(id, revision)
      this.remember(this.ids(id), 'ungroup')
      this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(id)
      this.db.prepare('DELETE FROM stacks WHERE id = ?').run(id)
      this.bump()
    })
  }
  remove(photoId: string, revision: number): StackSummary | null {
    return this.transaction(() => {
      const stack = this.forPhoto(photoId)
      if (!stack) throw new Error('This photo is not in a stack.')
      this.expected(stack.id, revision)
      this.remember(this.ids(stack.id), 'membership-change')
      this.db.prepare('UPDATE stacks SET touched = 1 WHERE id = ?').run(stack.id)
      this.repairRemoval(photoId)
      return this.forPhoto(this.ids(stack.id)[0] ?? photoId)
    })
  }
  setCover(id: string, photoId: string, revision: number): StackSummary {
    return this.transaction(() => {
      this.expected(id, revision)
      const ids = this.ids(id)
      if (!ids.includes(photoId)) throw new Error('The cover must belong to this stack.')
      if (this.row(id).cover_id !== photoId) {
        this.remember(ids, 'cover-change')
        this.membership(id, ids, photoId)
        this.db
          .prepare(
            'UPDATE stacks SET cover_id = ?, touched = 1, revision = revision + 1 WHERE id = ?',
          )
          .run(photoId, id)
        this.bump()
      }
      return this.summary(this.row(id))
    })
  }
  setExpanded(id: string, expanded: boolean, revision: number): StackSummary {
    return this.transaction(() => {
      const row = this.expected(id, revision)
      if (typeof expanded !== 'boolean') throw new Error('Invalid stack expansion.')
      if (!!row.expanded !== expanded) {
        this.db
          .prepare('UPDATE stacks SET expanded = ?, revision = revision + 1 WHERE id = ?')
          .run(Number(expanded), id)
        this.bump()
      }
      return this.summary(this.row(id))
    })
  }
  /** Called after catalog removal, inside the same recovery/deletion transaction. */
  repairRemoval(photoId: string) {
    const member = this.db
      .prepare('SELECT stack_id FROM stack_members WHERE photo_id = ?')
      .get(photoId) as { stack_id: string } | undefined
    if (!member) return
    const row = this.row(member.stack_id)
    this.db.prepare('DELETE FROM stack_members WHERE photo_id = ?').run(photoId)
    const ids = this.ids(row.id)
    if (row.origin === 'capture') this.remember(ids, 'membership-change')
    if (ids.length < 2) {
      this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(row.id)
      this.db.prepare('DELETE FROM stacks WHERE id = ?').run(row.id)
    } else {
      const newestMerge = ids
        .map((id) => this.photo(id))
        .filter((p) => p.assetKind === 'derived')
        .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0]
      const coverId = row.cover_id === photoId ? (newestMerge?.id ?? ids[0]) : row.cover_id
      this.membership(row.id, ids, coverId)
      this.db
        .prepare(
          'UPDATE stacks SET cover_id = ?, revision = revision + 1, touched = 1 WHERE id = ?',
        )
        .run(coverId, row.id)
    }
    this.bump()
  }
  /** Publication/backfill unions complete memberships, retaining unused sources and older masters. */
  attachMerge(manifest: MergeManifest) {
    const related = new Set([
      manifest.photo.id,
      ...manifest.recipe.sources
        .map((s) => s.id)
        .filter((id) => !!this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id)),
    ])
    const groups = new Set<string>()
    for (const id of related) {
      const stack = this.forPhoto(id)
      if (stack) groups.add(stack.id)
    }
    for (const id of groups) for (const member of this.ids(id)) related.add(member)
    if (related.size < 2) return
    const id = groups.values().next().value ?? randomUUID()
    for (const group of groups) {
      this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(group)
      if (group !== id) this.db.prepare('DELETE FROM stacks WHERE id = ?').run(group)
    }
    if (!groups.size)
      this.db
        .prepare("INSERT INTO stacks (id, cover_id, origin, touched) VALUES (?, ?, 'merge', 1)")
        .run(id, manifest.photo.id)
    else
      this.db
        .prepare(
          "UPDATE stacks SET cover_id = ?, expanded = 0, origin = 'merge', automatic_key = NULL, touched = 1, revision = revision + 1 WHERE id = ?",
        )
        .run(manifest.photo.id, id)
    this.membership(id, [...related], manifest.photo.id)
    this.bump()
  }
  backfillMerges() {
    const rows = this.db
      .prepare(
        'SELECT manifest FROM derived_assets JOIN photos ON derived_assets.id = photos.id ORDER BY imported_at, photos.rowid',
      )
      .all() as { manifest: string }[]
    for (const row of rows) this.attachMerge(JSON.parse(row.manifest))
  }
  putCapture(photoId: string, metadata: CaptureMetadata) {
    this.db
      .prepare('INSERT OR REPLACE INTO capture_metadata VALUES (?, ?)')
      .run(photoId, JSON.stringify(metadata))
  }
  capture(photoId: string): CaptureMetadata | undefined {
    const row = this.db
      .prepare('SELECT data FROM capture_metadata WHERE photo_id = ?')
      .get(photoId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }
  reconcileCaptures(): number {
    return this.transaction(() => {
      const captures = (
        this.db
          .prepare(
            'SELECT photo_id, data FROM capture_metadata JOIN photos ON photo_id = photos.id',
          )
          .all() as { photo_id: string; data: string }[]
      ).map((r) => ({ id: r.photo_id, metadata: JSON.parse(r.data) as CaptureMetadata }))
      let changed = 0
      for (const sequence of detectCaptureSequences(captures)) {
        if (
          sequence.ids.some(
            (id) => !!this.db.prepare('SELECT 1 FROM stack_overrides WHERE photo_id = ?').get(id),
          )
        )
          continue
        const groups = new Set(
          sequence.ids.map((id) => this.forPhoto(id)?.id).filter((id): id is string => !!id),
        )
        if (
          [...groups].some((id) => {
            const r = this.row(id)
            return (
              r.origin !== 'capture' ||
              r.touched ||
              this.ids(id).some((member) => !sequence.ids.includes(member))
            )
          })
        )
          continue
        // Keep the group containing the earliest already grouped frame. A refreshed
        // profile or newly imported start can change the key without changing intent.
        const id =
          sequence.ids.map((member) => this.forPhoto(member)?.id).find((id) => !!id) ?? randomUUID()
        if (groups.size) {
          const ids = this.ids(id)
          if (
            groups.size === 1 &&
            ids.length === sequence.ids.length &&
            this.row(id).automatic_key === sequence.key
          )
            continue
          for (const group of groups) {
            this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(group)
            if (group !== id) this.db.prepare('DELETE FROM stacks WHERE id = ?').run(group)
          }
          this.db
            .prepare('UPDATE stacks SET automatic_key = ?, revision = revision + 1 WHERE id = ?')
            .run(sequence.key, id)
        } else
          this.db
            .prepare(
              "INSERT INTO stacks (id, cover_id, origin, automatic_key) VALUES (?, ?, 'capture', ?)",
            )
            .run(id, sequence.ids[0], sequence.key)
        this.membership(id, sequence.ids, this.row(id).cover_id)
        this.bump()
        changed++
      }
      return changed
    })
  }
  private galleryView() {
    const photos = (
      this.db.prepare('SELECT photo FROM photos ORDER BY imported_at DESC, rowid DESC').all() as {
        photo: string
      }[]
    ).map((r) => JSON.parse(r.photo) as Photo)
    const overview = this.overview()
    const memberIds = new Map<string, string[]>()
    const covers = new Map<string, string>()
    const rows = this.db
      .prepare('SELECT stack_id, photo_id FROM stack_members ORDER BY stack_id, position')
      .all() as { stack_id: string; photo_id: string }[]
    for (const row of rows) {
      const ids = memberIds.get(row.stack_id) ?? []
      ids.push(row.photo_id)
      memberIds.set(row.stack_id, ids)
    }
    for (const stack of overview.stacks)
      for (const id of memberIds.get(stack.id) ?? []) covers.set(id, stack.coverId)
    const counts = new Map(
      (
        this.db
          .prepare(
            "SELECT id, json_array_length(manifest, '$.recipe.sources') AS count FROM derived_assets",
          )
          .all() as { id: string; count: number }[]
      ).map((r) => [r.id, r.count]),
    )
    const entries = projectGallery(
      photos,
      overview.stacks.map((summary) => ({ summary, memberIds: memberIds.get(summary.id) ?? [] })),
      counts,
    )
    return {
      photos: new Map(photos.map((photo) => [photo.id, photo])),
      memberIds,
      covers,
      page: {
        entries,
        total: entries.length,
        storedTotal: photos.length,
        revision: overview.revision,
        hiddenSelectedIds: [] as string[],
      },
    }
  }
  gallery(offset = 0, selectedIds: string[] = []): GalleryPage {
    this.validateOffset(offset)
    if (
      !Array.isArray(selectedIds) ||
      selectedIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new Error('Invalid photo selection.')
    const { page } = this.galleryView()
    const visible = new Set(page.entries.map((e) => e.photo.id))
    return {
      ...page,
      entries: page.entries.slice(offset, offset + PAGE_SIZE),
      hiddenSelectedIds: selectedIds.filter(
        (id) => !visible.has(id) && !!this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id),
      ),
    }
  }
  locate(photoId: string, direction: -1 | 0 | 1 = 0): GalleryLocation | null {
    if (![-1, 0, 1].includes(direction)) throw new Error('Invalid photo navigation.')
    const photo = this.photo(photoId),
      page = this.galleryView().page
    const position = galleryPosition(page.entries, photoId, this.forPhoto(photoId)?.coverId)
    const index = position + direction
    if (position < 0 || index < 0 || index >= page.total) return null
    const offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE
    return {
      ...page,
      entries: page.entries.slice(offset, offset + PAGE_SIZE),
      offset,
      index,
      photo: direction === 0 ? photo : page.entries[index].photo,
    }
  }
  range(fromId: string, toId: string): PhotoReference[] {
    if (![fromId, toId].every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))
      throw new Error('Invalid photo selection.')
    const { page, photos, memberIds, covers } = this.galleryView()
    if (!photos.has(toId)) throw new Error('This photo is unavailable.')
    const { entries } = page
    const to = galleryPosition(entries, toId, covers.get(toId))
    const from = photos.has(fromId) ? galleryPosition(entries, fromId, covers.get(fromId)) : to
    const selected = new Map<string, PhotoReference>()
    for (const entry of entries.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      const ids =
        entry.stack?.coverId === entry.photo.id
          ? (memberIds.get(entry.stack.id) ?? [])
          : [entry.photo.id]
      for (const id of ids) {
        const photo = photos.get(id)
        if (photo) selected.set(id, { id, filename: photo.filename })
      }
    }
    return [...selected.values()]
  }
}
