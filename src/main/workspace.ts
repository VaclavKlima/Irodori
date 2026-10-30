import type { DatabaseSync } from 'node:sqlite'
import type { Photo, PhotoReference } from '../shared/contracts'
import {
  DEFAULT_WORKSPACE,
  DEFAULT_INSPECTOR_SECTIONS,
  type WorkspaceState,
  type WorkspaceSnapshot,
} from '../shared/workspace'
import type { BrowseStore } from './browse'
import type { CollectionAnchor } from '../shared/collections'

/** Workspace reads; the dedicated writer commits checkpoints and selection deltas together. */
export class WorkspaceStore {
  constructor(
    protected db: DatabaseSync,
    private browse: BrowseStore,
  ) {}
  initialize() {
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
  protected prune(state: WorkspaceState): WorkspaceState {
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
    const saved = row ? JSON.parse(row.data) : undefined
    const state = saved
      ? this.prune({
          ...DEFAULT_WORKSPACE,
          ...saved,
          inspector: { ...DEFAULT_INSPECTOR_SECTIONS, ...saved.inspector },
        })
      : null
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
}
