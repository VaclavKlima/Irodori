import type { BrowsePhoto, BrowseQuery, BrowseGrouping } from './browse'
import type { CollectionAnchor } from './collections'
import type { Photo, PhotoReference } from './contracts'
import type { ColorRangeId } from './color-mixer'
import type { GradingToneId } from './color-grading'

export const WORKSPACE_VERSION = 1
export const DEFAULT_INSPECTOR_SECTIONS = {
  histogram: true,
  light: true,
  color: true,
  colorIntensity: true,
  colorMixer: true,
  colorGrading: true,
  toneBlending: true,
  detail: true,
  sharpening: true,
  crop: true,
  lens: true,
  metadata: true,
}
export type InspectorSectionId = keyof typeof DEFAULT_INSPECTOR_SECTIONS
export type InspectorSections = Record<InspectorSectionId, boolean>
export const inspectorGroups = ['light', 'color', 'detail', 'geometry', 'info'] as const
export type InspectorGroup = (typeof inspectorGroups)[number]
export const colorTabs = ['basic', 'mixer', 'grading'] as const
export type ColorTab = (typeof colorTabs)[number]
export interface CreativeColorSelection {
  range: ColorRangeId
  tone: GradingToneId
}
export const DEFAULT_CREATIVE_COLOR_SELECTION: CreativeColorSelection = {
  range: 'red',
  tone: 'midtones',
}
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
  inspector: InspectorSections
  inspectorGroup: InspectorGroup
  colorTab: ColorTab
  hoverControls: boolean
  creativeColor: CreativeColorSelection
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
  inspector: DEFAULT_INSPECTOR_SECTIONS,
  inspectorGroup: 'light',
  colorTab: 'basic',
  hoverControls: false,
  creativeColor: DEFAULT_CREATIVE_COLOR_SELECTION,
  preview: null,
}
export function recoverWorkspaceNavigation(value?: {
  inspectorGroup?: unknown
  colorTab?: unknown
  hoverControls?: unknown
}): Pick<WorkspaceState, 'inspectorGroup' | 'colorTab' | 'hoverControls'> {
  return {
    inspectorGroup: inspectorGroups.includes(value?.inspectorGroup as InspectorGroup)
      ? (value!.inspectorGroup as InspectorGroup)
      : 'light',
    colorTab: colorTabs.includes(value?.colorTab as ColorTab)
      ? (value!.colorTab as ColorTab)
      : 'basic',
    hoverControls: typeof value?.hoverControls === 'boolean' ? value.hoverControls : false,
  }
}
