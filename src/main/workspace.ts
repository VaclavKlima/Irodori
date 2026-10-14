import type { DatabaseSync } from 'node:sqlite'
import type { Photo, PhotoReference } from '../shared/contracts'
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_VERSION,
  type WorkspaceChange,
  type WorkspaceState,
  type WorkspaceSnapshot,
} from '../shared/workspace'
import type { BrowseStore } from './browse'
import type { CollectionAnchor } from '../shared/collections'

const hash = /^[a-f0-9]{64}$/
const id = (value: unknown) => value === null || (typeof value === 'string' && hash.test(value))
function anchor(value: CollectionAnchor | null) {
  return (
    value === null ||
    (typeof value === 'object' &&
      id(value.id) &&
      value.id !== null &&
      Number.isFinite(value.inset) &&
      Math.abs(value.inset) <= 1e9 &&
      Number.isSafeInteger(value.index) &&
      value.index >= 0 &&
      [value.coverId, value.beforeId, value.afterId].every((v) => v === undefined || id(v)) &&
      Object.keys(value).every((k) =>
        ['id', 'inset', 'index', 'coverId', 'beforeId', 'afterId'].includes(k),
      ))
  )
}
function validate(state: WorkspaceState) {
  if (
    !state ||
    Object.keys(state).some((k) => !(k in DEFAULT_WORKSPACE)) ||
    state.version !== WORKSPACE_VERSION ||
    !['editor', 'library'].includes(state.mode) ||
    ![state.activeId, state.editorFocusId, state.libraryFocusId, state.rangeAnchorId].every(id) ||
    typeof state.consoleOpen !== 'boolean' ||
    !anchor(state.editorAnchor) ||
    !anchor(state.libraryAnchor) ||
    !state.query ||
    typeof state.query.search !== 'string' ||
    state.query.search.length > 500 ||
    !['date', 'month', 'year'].includes(state.query.grouping) ||
    Object.keys(state.query).some((k) => !['search', 'grouping'].includes(k)) ||
    !state.folds ||
    Object.keys(state.folds).some((k) => !['date', 'month', 'year'].includes(k)) ||
    !['date', 'month', 'year'].every((key) => {
      const values = state.folds[key as keyof typeof state.folds]
      return (
        Array.isArray(values) &&
        values.length <= 100000 &&
        values.every(
          (v) => typeof v === 'string' && (v === 'unknown' || /^\d{4}(?:-\d{2}){0,2}$/.test(v)),
        )
      )
    }) ||
    (state.preview !== null &&
      (!state.preview ||
        !id(state.preview.photoId) ||
        state.preview.photoId === null ||
        typeof state.preview.fit !== 'boolean' ||
        !Number.isFinite(state.preview.scale) ||
        state.preview.scale <= 0 ||
        state.preview.scale > 32 ||
        ![state.preview.centerX, state.preview.centerY].every(
          (v) => Number.isFinite(v) && v >= 0 && v <= 1,
        ) ||
        Object.keys(state.preview).some(
          (k) => !['photoId', 'fit', 'scale', 'centerX', 'centerY'].includes(k),
        )))
  )
    throw new Error('Invalid workspace state.')
}

/** Checkpoints and selection deltas commit together, without touching photo edits or order. */
export class WorkspaceStore {
  constructor(
    private db: DatabaseSync,
    private browse: BrowseStore,
  ) {}
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), checkpoint INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_selection (photo_id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS remove_workspace_selection AFTER DELETE ON photos BEGIN DELETE FROM workspace_selection WHERE photo_id = old.id; END;
      CREATE TABLE IF NOT EXISTS collection_catalog_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO collection_catalog_state VALUES (1, 0);
      CREATE TRIGGER IF NOT EXISTS collection_insert AFTER INSERT ON photos BEGIN UPDATE collection_catalog_state SET revision = revision + 1; END;
      CREATE TRIGGER IF NOT EXISTS collection_update AFTER UPDATE OF photo, imported_at ON photos BEGIN UPDATE collection_catalog_state SET revision = revision + 1; END;
      CREATE TRIGGER IF NOT EXISTS collection_delete AFTER DELETE ON photos BEGIN UPDATE collection_catalog_state SET revision = revision + 1; END;
    `)
  }
  private photo(id: string | null): Photo | null {
    const row =
      id &&
      (this.db.prepare('SELECT photo FROM photos WHERE id = ?').get(id) as
        { photo: string } | undefined)
    return row ? JSON.parse(row.photo) : null
  }
  private prune(state: WorkspaceState): WorkspaceState {
    const live = (value: string | null) => this.photo(value)?.id ?? null
    const recover = (value: CollectionAnchor | null): CollectionAnchor | null => {
      if (!value) return null
      const recovered = [value.id, value.coverId, value.afterId, value.beforeId].find(
        (v) => v && this.photo(v),
      )
      if (recovered) return { ...value, id: recovered }
      const row = this.db
        .prepare('SELECT id FROM photos ORDER BY imported_at DESC, rowid DESC LIMIT 1 OFFSET ?')
        .get(
          Math.min(
            value.index,
            Math.max(
              0,
              (this.db.prepare('SELECT COUNT(*) AS count FROM photos').get() as { count: number })
                .count - 1,
            ),
          ),
        ) as { id: string } | undefined
      return row ? { id: row.id, index: value.index, inset: value.inset } : null
    }
    return {
      ...state,
      activeId: live(state.activeId),
      editorFocusId: live(state.editorFocusId),
      libraryFocusId: live(state.libraryFocusId),
      rangeAnchorId: live(state.rangeAnchorId),
      editorAnchor: recover(state.editorAnchor),
      libraryAnchor: recover(state.libraryAnchor),
      preview:
        state.preview &&
        this.photo(state.preview.photoId) &&
        state.preview.photoId === state.activeId
          ? state.preview
          : null,
    }
  }
  read(): WorkspaceSnapshot {
    const row = this.db
      .prepare('SELECT checkpoint, data FROM workspace_state WHERE singleton = 1')
      .get() as { checkpoint: number; data: string } | undefined
    const state = row ? this.prune(JSON.parse(row.data)) : null
    const selected = this.db
      .prepare(
        "SELECT p.id, json_extract(p.photo, '$.filename') AS filename FROM workspace_selection s JOIN photos p ON s.photo_id = p.id ORDER BY s.rowid",
      )
      .all() as unknown as PhotoReference[]
    return {
      checkpoint: row?.checkpoint ?? 0,
      state,
      selected,
      activePhoto: this.photo(state?.activeId ?? null),
      libraryPhoto: state?.libraryFocusId
        ? (this.browse.locate(state.query, state.libraryFocusId)?.photo ?? null)
        : null,
    }
  }
  save(change: WorkspaceChange): number {
    if (!change || Object.keys(change).some((k) => !['state', 'selection'].includes(k)))
      throw new Error('Invalid workspace checkpoint.')
    const selection = change.selection
    if (
      selection &&
      (Object.keys(selection).some((k) => !['added', 'removed'].includes(k)) ||
        ![selection.added, selection.removed].every(
          (ids) => Array.isArray(ids) && ids.every((v) => typeof v === 'string' && hash.test(v)),
        ))
    )
      throw new Error('Invalid workspace selection.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare('SELECT checkpoint, data FROM workspace_state WHERE singleton = 1')
        .get() as { checkpoint: number; data: string } | undefined
      const state = {
        ...(row ? JSON.parse(row.data) : DEFAULT_WORKSPACE),
        ...change.state,
      } as WorkspaceState
      validate(state)
      const checkpoint = (row?.checkpoint ?? 0) + 1
      this.db
        .prepare(
          'INSERT INTO workspace_state VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET checkpoint = excluded.checkpoint, data = excluded.data',
        )
        .run(checkpoint, JSON.stringify(this.prune(state)))
      if (selection) {
        const remove = this.db.prepare('DELETE FROM workspace_selection WHERE photo_id = ?')
        const add = this.db.prepare(
          'INSERT OR IGNORE INTO workspace_selection SELECT id FROM photos WHERE id = ?',
        )
        for (const value of selection.removed) remove.run(value)
        for (const value of selection.added) add.run(value)
      }
      this.db.exec('COMMIT')
      return checkpoint
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
