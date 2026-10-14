import type { BrowsePhoto, BrowseQuery, BrowseGrouping } from './browse'
import type { CollectionAnchor } from './collections'
import type { Photo, PhotoReference } from './contracts'

export const WORKSPACE_VERSION = 1
export interface PreviewViewState {
  photoId: string
  fit: boolean
  scale: number
  centerX: number
  centerY: number
}
export interface WorkspaceState {
  version: typeof WORKSPACE_VERSION
  mode: 'editor' | 'library'
  activeId: string | null
  editorFocusId: string | null
  libraryFocusId: string | null
  rangeAnchorId: string | null
  query: BrowseQuery
  folds: Record<BrowseGrouping, string[]>
  editorAnchor: CollectionAnchor | null
  libraryAnchor: CollectionAnchor | null
  consoleOpen: boolean
  preview: PreviewViewState | null
}
export interface WorkspaceSnapshot {
  checkpoint: number
  state: WorkspaceState | null
  selected: PhotoReference[]
  activePhoto: Photo | null
  libraryPhoto: BrowsePhoto | null
}
export interface WorkspaceChange {
  state?: Partial<WorkspaceState>
  selection?: { added: string[]; removed: string[] }
}
export const DEFAULT_WORKSPACE: WorkspaceState = {
  version: WORKSPACE_VERSION,
  mode: 'editor',
  activeId: null,
  editorFocusId: null,
  libraryFocusId: null,
  rangeAnchorId: null,
  query: { search: '', grouping: 'date' },
  folds: { date: [], month: [], year: [] },
  editorAnchor: null,
  libraryAnchor: null,
  consoleOpen: false,
  preview: null,
}
