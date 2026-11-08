import type { BrowsePhoto, BrowseQuery, BrowseGrouping } from './browse'
import type { CollectionAnchor } from './collections'
import type { Photo, PhotoReference } from './contracts'
import type { ColorRangeId } from './color-mixer'
import type { GradingToneId } from './color-grading'
import { DEFAULT_PRESET_WORKSPACE, type PresetWorkspace } from './presets'

export const CONSOLE_HEIGHT_MIN = 120
export const CONSOLE_HEIGHT_MAX = 1600
export function recoverConsoleHeight(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CONSOLE_HEIGHT_MIN &&
    value <= CONSOLE_HEIGHT_MAX
    ? value
    : null
}
export const WORKSPACE_VERSION = 1
export const DEFAULT_INSPECTOR_SECTIONS = {
  histogram: true,
  light: true,
  curves: true,
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
export const inspectorGroups = [
  'light',
  'color',
  'masks',
  'detail',
  'geometry',
  'presets',
  'info',
] as const
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
export type MaskDetailTab = 'coverage' | 'adjustments'
export interface MaskWorkspace {
  photoId: string | null
  selectedId: string | null
  overlay: boolean
  brush: boolean
  mode: 'add' | 'subtract'
  /** Brush diameter as a percentage of the canonical image's shorter edge. */
  size: number
  feather: number
  detailTab: MaskDetailTab
}
export const DEFAULT_MASK_WORKSPACE: MaskWorkspace = {
  photoId: null,
  selectedId: null,
  overlay: false,
  brush: false,
  mode: 'add',
  size: 10,
  feather: 50,
  detailTab: 'adjustments',
}
export function validMaskWorkspace(value: unknown): value is MaskWorkspace {
  const v = value as MaskWorkspace | null
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length === 8 &&
    Object.keys(v).every((k) => k in DEFAULT_MASK_WORKSPACE) &&
    (v.photoId === null || (typeof v.photoId === 'string' && /^[a-f0-9]{64}$/.test(v.photoId))) &&
    (v.selectedId === null ||
      (typeof v.selectedId === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.selectedId))) &&
    typeof v.overlay === 'boolean' &&
    typeof v.brush === 'boolean' &&
    (v.mode === 'add' || v.mode === 'subtract') &&
    Number.isFinite(v.size) &&
    v.size >= 0.1 &&
    v.size <= 100 &&
    Number.isFinite(v.feather) &&
    v.feather >= 0 &&
    v.feather <= 100 &&
    (v.detailTab === 'coverage' || v.detailTab === 'adjustments')
  )
}
export function recoverMaskWorkspace(value: unknown): MaskWorkspace {
  if (validMaskWorkspace(value)) return value
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'detailTab')
  ) {
    const recovered = { ...value, detailTab: DEFAULT_MASK_WORKSPACE.detailTab }
    if (validMaskWorkspace(recovered)) return recovered
  }
  return { ...DEFAULT_MASK_WORKSPACE }
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
  consoleHeight: number | null
  consoleOpen: boolean
  inspector: InspectorSections
  inspectorGroup: InspectorGroup
  colorTab: ColorTab
  hoverControls: boolean
  creativeColor: CreativeColorSelection
  presets: PresetWorkspace
  masks: MaskWorkspace
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
  consoleHeight: null,
  consoleOpen: false,
  inspector: DEFAULT_INSPECTOR_SECTIONS,
  inspectorGroup: 'light',
  colorTab: 'basic',
  hoverControls: false,
  creativeColor: DEFAULT_CREATIVE_COLOR_SELECTION,
  presets: DEFAULT_PRESET_WORKSPACE,
  masks: DEFAULT_MASK_WORKSPACE,
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
