import type { DatabaseSync } from 'node:sqlite'
import { COLLECTION_CHUNK_SIZE, CollectionChangedError } from '../shared/collections'
import {
  EDIT_CHECKPOINT_STORE_VERSION,
  editCheckpointNameKey,
  editCheckpointName,
  exactCheckpointFields,
  validateCheckpointId,
  validateCheckpointPhotoId,
  validateCheckpointRevision,
  validateEditCheckpoint,
  validateCheckpointSettings,
  type EditCheckpoint,
  type EditCheckpointPage,
  type EditCheckpointQuery,
  type EditCheckpointRevisionRequest,
  type RenameEditCheckpointRequest,
} from '../shared/edit-checkpoints'
import { MaskContentStore } from './mask-store'
import { migrateEditingSettings, supportsEditingSettings } from './catalog/editing-migration'
import { SETTINGS_VERSION } from '../shared/edits'

/** Reads never initialize or repair storage; runtime writes belong to the catalog worker. */
export class EditCheckpointReadStore {
  constructor(protected db: DatabaseSync) {}
  validateExisting() {
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('checkpoint_store', 'edit_checkpoints')",
        )
        .all()
      if (!tables.length) return
      const state = this.db.prepare('SELECT * FROM checkpoint_store').all() as {
        singleton: number
        version: number
        revision: number
      }[]
      if (
        tables.length !== 2 ||
        state.length !== 1 ||
        state[0].singleton !== 1 ||
        state[0].version !== EDIT_CHECKPOINT_STORE_VERSION ||
        !Number.isSafeInteger(state[0].revision) ||
        state[0].revision < 0
      )
        throw new Error('Invalid checkpoint store version.')
      for (const row of this.db
        .prepare('SELECT id, photo_id, name_key, created_at, data FROM edit_checkpoints')
        .iterate() as Iterable<{
        id: string
        photo_id: string
        name_key: string
        created_at: string
        data: string
      }>) {
        const checkpoint = JSON.parse(row.data)
        validateEditCheckpoint(checkpoint, (settings) => {
          if (!supportsEditingSettings(settings as Record<string, unknown>))
            throw new Error('Unsupported checkpoint settings.')
          validateCheckpointSettings(migrateEditingSettings(settings as Record<string, unknown>))
        })
        if (
          checkpoint.id !== row.id ||
          checkpoint.photoId !== row.photo_id ||
          editCheckpointNameKey(checkpoint.name) !== row.name_key ||
          checkpoint.createdAt !== row.created_at ||
          !this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(row.photo_id)
        )
          throw new Error('Invalid checkpoint index or photograph.')
        const settings = migrateEditingSettings(
          checkpoint.settings as unknown as Record<string, unknown>,
        )
        validateCheckpointSettings(settings)
        new MaskContentStore(this.db).content(checkpoint.photoId, settings.maskStack)
      }
    } catch (cause) {
      throw new Error(
        'This checkpoint store format is unsupported or incomplete. Its library was preserved.',
        { cause },
      )
    }
  }
  initialize() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS checkpoint_store (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO checkpoint_store VALUES (1, ${EDIT_CHECKPOINT_STORE_VERSION}, 0);
      CREATE TABLE IF NOT EXISTS edit_checkpoints (id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, name_key TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(photo_id, name_key));
      CREATE INDEX IF NOT EXISTS checkpoint_photo_order ON edit_checkpoints(photo_id, created_at DESC, id DESC);
      CREATE TRIGGER IF NOT EXISTS remove_edit_checkpoints AFTER DELETE ON photos BEGIN DELETE FROM edit_checkpoints WHERE photo_id = old.id; UPDATE checkpoint_store SET revision = revision + 1 WHERE singleton = 1; END;`)
    const update = this.db.prepare('UPDATE edit_checkpoints SET data = ? WHERE id = ?')
    for (const row of this.db
      .prepare('SELECT id, data FROM edit_checkpoints')
      .iterate() as Iterable<{ id: string; data: string }>) {
      const checkpoint = JSON.parse(row.data)
      if (checkpoint.settings.version === SETTINGS_VERSION) continue
      checkpoint.settings = migrateEditingSettings(checkpoint.settings)
      validateEditCheckpoint(checkpoint)
      update.run(JSON.stringify(checkpoint), row.id)
    }
  }
  protected photo(photoId: string) {
    validateCheckpointPhotoId(photoId)
    if (!this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(photoId))
      throw new Error('This photograph is unavailable.')
  }
  get(photoId: string, id: string): EditCheckpoint {
    this.photo(photoId)
    validateCheckpointId(id)
    const row = this.db
      .prepare('SELECT data FROM edit_checkpoints WHERE id = ? AND photo_id = ?')
      .get(id, photoId) as { data: string } | undefined
    if (!row) throw new Error('This saved version is unavailable. Refresh Versions.')
    const checkpoint = JSON.parse(row.data)
    validateEditCheckpoint(checkpoint)
    return checkpoint
  }
  expected(request: EditCheckpointRevisionRequest) {
    validateCheckpointRevision(request.expectedCheckpointRevision)
    const checkpoint = this.get(request.photoId, request.checkpointId)
    if (checkpoint.revision !== request.expectedCheckpointRevision)
      throw new Error('Checkpoint revision conflict. Refresh Versions and try again.')
    return checkpoint
  }
  list(photoId: string, query: EditCheckpointQuery = {}): EditCheckpointPage {
    this.photo(photoId)
    if (
      !exactCheckpointFields(
        query,
        [],
        ['search', 'offset', 'expectedStoreRevision', 'anchorId'],
      ) ||
      (query.search !== undefined &&
        (typeof query.search !== 'string' || query.search.length > 500)) ||
      !Number.isSafeInteger(query.offset ?? 0) ||
      (query.offset ?? 0) < 0 ||
      (query.expectedStoreRevision !== undefined &&
        (!Number.isSafeInteger(query.expectedStoreRevision) || query.expectedStoreRevision < 0))
    )
      throw new Error('Invalid saved-version query.')
    if (query.anchorId !== undefined) validateCheckpointId(query.anchorId)
    this.db.exec('BEGIN')
    try {
      const { revision } = this.db
        .prepare('SELECT revision FROM checkpoint_store WHERE singleton = 1')
        .get() as { revision: number }
      if (query.expectedStoreRevision !== undefined && query.expectedStoreRevision !== revision)
        throw new CollectionChangedError()
      const search = editCheckpointNameKey(query.search?.trim() ?? '')
      const total = (
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM edit_checkpoints WHERE photo_id = ? AND instr(name_key, ?) > 0',
          )
          .get(photoId, search) as { count: number }
      ).count
      const rows = this.db
        .prepare(
          'SELECT data FROM edit_checkpoints WHERE photo_id = ? AND instr(name_key, ?) > 0 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(photoId, search, COLLECTION_CHUNK_SIZE, query.offset ?? 0) as { data: string }[]
      const anchor =
        query.anchorId &&
        (this.db
          .prepare(
            'SELECT id, created_at FROM edit_checkpoints WHERE photo_id = ? AND id = ? AND instr(name_key, ?) > 0',
          )
          .get(photoId, query.anchorId, search) as { id: string; created_at: string } | undefined)
      const anchorIndex = anchor
        ? (
            this.db
              .prepare(
                'SELECT COUNT(*) AS count FROM edit_checkpoints WHERE photo_id = ? AND instr(name_key, ?) > 0 AND (created_at > ? OR (created_at = ? AND id > ?))',
              )
              .get(photoId, search, anchor.created_at, anchor.created_at, anchor.id) as {
              count: number
            }
          ).count
        : null
      return {
        total,
        storeRevision: revision,
        anchorIndex,
        checkpoints: rows.map((row) => {
          const checkpoint = JSON.parse(row.data) as EditCheckpoint
          return {
            id: checkpoint.id,
            photoId: checkpoint.photoId,
            name: checkpoint.name,
            revision: checkpoint.revision,
            createdAt: checkpoint.createdAt,
            updatedAt: checkpoint.updatedAt,
            capturedFromRevision: checkpoint.capturedFromRevision,
          }
        }),
      }
    } finally {
      this.db.exec('ROLLBACK')
    }
  }
}

/** All operations run inside the catalog writer transaction. */
export class EditCheckpointMutations extends EditCheckpointReadStore {
  private changed() {
    this.db.exec('UPDATE checkpoint_store SET revision = revision + 1 WHERE singleton = 1')
  }
  private unique(photoId: string, name: string, except?: string) {
    const row = this.db
      .prepare('SELECT id FROM edit_checkpoints WHERE photo_id = ? AND name_key = ?')
      .get(photoId, editCheckpointNameKey(name)) as { id: string } | undefined
    if (row && row.id !== except)
      throw new Error('A saved version with this name already exists for this photograph.')
  }
  create(checkpoint: EditCheckpoint) {
    validateEditCheckpoint(checkpoint)
    this.photo(checkpoint.photoId)
    if (checkpoint.revision !== 1) throw new Error('A new checkpoint must start at revision 1.')
    this.unique(checkpoint.photoId, checkpoint.name)
    new MaskContentStore(this.db).content(checkpoint.photoId, checkpoint.settings.maskStack)
    this.db
      .prepare('INSERT INTO edit_checkpoints VALUES (?, ?, ?, ?, ?)')
      .run(
        checkpoint.id,
        checkpoint.photoId,
        editCheckpointNameKey(checkpoint.name),
        checkpoint.createdAt,
        JSON.stringify(checkpoint),
      )
    this.changed()
    return checkpoint
  }
  rename(request: RenameEditCheckpointRequest, updatedAt: string) {
    const before = this.expected(request),
      name = editCheckpointName(request.name)
    this.unique(request.photoId, name, before.id)
    if (name === before.name) return before
    const checkpoint = { ...before, name, revision: before.revision + 1, updatedAt }
    validateEditCheckpoint(checkpoint)
    this.db
      .prepare('UPDATE edit_checkpoints SET name_key = ?, data = ? WHERE id = ?')
      .run(editCheckpointNameKey(name), JSON.stringify(checkpoint), checkpoint.id)
    this.changed()
    return checkpoint
  }
  delete(request: EditCheckpointRevisionRequest) {
    this.expected(request)
    this.db
      .prepare('DELETE FROM edit_checkpoints WHERE id = ? AND photo_id = ?')
      .run(request.checkpointId, request.photoId)
    this.changed()
  }
}
