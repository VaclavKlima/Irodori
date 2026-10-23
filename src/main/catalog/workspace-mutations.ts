import { catalogTransaction } from './transaction'
import { WorkspaceStore } from '../workspace'
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_VERSION,
  type WorkspaceChange,
  type WorkspaceState,
} from '../../shared/workspace'
import type { CollectionAnchor } from '../../shared/collections'

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

export class WorkspaceMutations extends WorkspaceStore {
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
    return catalogTransaction(this.db, () => {
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
      return checkpoint
    })
  }
}
