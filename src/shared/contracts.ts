import type { HdrAnalysisRequest, HdrPhotoStatistics } from './hdr-statistics'
import type { HdrPhotoPixel } from './hdr-pixel'
import type { PhotoStatistics } from './statistics'
import type { AdjustmentParameters } from './adjustments'
import type { DisplayTransform } from './adjustments'
import type { HdrWorkingAsset, DisplayTarget, DisplayCapabilities } from './hdr'
import type { PreviewPreference } from './hdr-display'
import type { EditState, EditPatch, EditHistory } from './edits'
import type { CorrectionKind, LensSettings, LensState } from './lens'
export interface AppInfo {
  version: string
  platform: 'linux' | 'darwin' | 'win32'
}

export interface LumaApi {
  listStacks(): Promise<import('./stacks').StackOverview>
  getPhotoStack(photoId: string): Promise<import('./stacks').StackSummary | null>
  getStackMembers(stackId: string, offset?: number): Promise<import('./stacks').StackMembers>
  groupPhotos(
    ids: string[],
    coverId: string,
    expectedRevision: number,
  ): Promise<import('./stacks').StackSummary>
  ungroupStack(stackId: string, expectedRevision: number): Promise<void>
  removeFromStack(
    photoId: string,
    expectedRevision: number,
  ): Promise<import('./stacks').StackSummary | null>
  setStackCover(
    stackId: string,
    photoId: string,
    expectedRevision: number,
  ): Promise<import('./stacks').StackSummary>
  setStackExpanded(
    stackId: string,
    expanded: boolean,
    expectedRevision: number,
  ): Promise<import('./stacks').StackSummary>
  listGallery(offset?: number, selectedIds?: string[]): Promise<import('./stacks').GalleryPage>
  locateGalleryPhoto(
    photoId: string,
    direction?: -1 | 0 | 1,
  ): Promise<import('./stacks').GalleryLocation | null>
  getGalleryRange(fromId: string, toId: string): Promise<PhotoReference[]>
  groupCaptureSequences(): Promise<string>
  getActiveMergeReview(): Promise<import('./merge').MergeReview | null>
  getMergeDiagnostics(id: string, revision: number): Promise<import('./merge').MergeDiagnostics>
  createMergeReview(
    ids: string[],
    mode: import('./merge').MergeMode,
  ): Promise<import('./merge').MergeReview>
  updateMergeReview(
    id: string,
    revision: number,
    settings: import('./merge').MergeSettings,
  ): Promise<import('./merge').MergeReview>
  requestMergePreview(id: string, revision: number): Promise<import('./merge').MergePreview>
  startMerge(id: string, revision: number): Promise<string>
  disposeMergeReview(id: string): Promise<void>
  getMergeProvenance(
    photoId: string,
  ): Promise<{ manifest: import('./merge').MergeManifest; reproducible: boolean }>

  getPreviewDiagnostics(): Promise<import('./preview-diagnostics').PreviewDiagnostics>
  reportPreviewPresentation(
    value: import('./preview-diagnostics').PreviewPresentation,
  ): Promise<void>
  getDisplayState(): Promise<DisplayTarget>
  setPreviewPreference(preference: PreviewPreference): Promise<DisplayTarget>
  reportDisplayCapabilities(capabilities: DisplayCapabilities): Promise<DisplayTarget>
  onDisplayState(listener: (state: DisplayTarget) => void): () => void
  onDisplayRefresh(listener: () => void): () => void
  onFlushEdits(listener: () => Promise<void>): () => void
  getPhotoStatistics(photoId: string, expectedRevision: number): Promise<PhotoStatistics>
  getPhotoStatistics(
    photoId: string,
    expectedRevision: number,
    request: HdrAnalysisRequest,
  ): Promise<HdrPhotoStatistics>
  getEdits(photoId: string): Promise<EditState>
  getPhotoPixel(
    photoId: string,
    expectedRevision: number,
    x: number,
    y: number,
    request: HdrAnalysisRequest,
  ): Promise<HdrPhotoPixel>
  updateEdits(photoId: string, patch: EditPatch, expectedRevision: number): Promise<EditState>
  getEditHistory(photoId: string): Promise<EditHistory>
  undoEdit(photoId: string, expectedRevision: number): Promise<EditState>
  redoEdit(photoId: string, expectedRevision: number): Promise<EditState>
  getLensSettings(photoId: string): Promise<LensState>
  updateLensSettings(photoId: string, kind: CorrectionKind, enabled: boolean): Promise<LensState>
  getAppInfo(): Promise<AppInfo>
  listPhotos(offset?: number): Promise<PhotoPage>
  locatePhoto(id: string, direction?: -1 | 0 | 1): Promise<PhotoLocation | null>
  getPhotoRange(fromId: string, toId: string): Promise<PhotoReference[]>
  requestHdrPreview(
    photoId: string,
    requestId: string,
    regenerate?: boolean,
  ): Promise<HdrPreview | null>
  requestEditingPreview(photoId: string, requestId: string): Promise<FullPreview>
  requestFullPreview(photoId: string, requestId: string, regenerate?: boolean): Promise<FullPreview>
  requestCachedFullPreview(photoId: string, requestId: string): Promise<FullPreview | null>
  releaseFullPreview(requestId: string): Promise<void>
  deletePhotos(ids: string[]): Promise<string | null>
  listTasks(): Promise<BackgroundTask[]>
  cancelTask(id: string): Promise<void>
  dismissTask(id: string): Promise<void>
  getTaskErrors(id: string, offset?: number): Promise<TaskErrorPage>
  chooseSource(kind: 'files' | 'folder', recursive: boolean): Promise<string | null>
  getReview(sessionId: string, offset?: number): Promise<ImportReview>
  selectCandidates(sessionId: string, ids: string[] | null, selected: boolean): Promise<void>
  importSelected(sessionId: string): Promise<void>
  cancelImport(sessionId: string): Promise<void>
  disposeImport(sessionId: string): Promise<void>
  onLibraryEvent(listener: (event: LibraryEvent) => void): () => void
}

export interface PhotoMetadata {
  width: number
  height: number
  camera?: string
  lens?: string
  capturedAt?: string
  aperture?: string
  shutter?: string
  iso?: string
  focalLength?: string
}

export interface Photo extends PhotoMetadata {
  assetKind?: 'original' | 'derived'
  id: string
  filename: string
  format: string
  bytes: number
  importedAt: string
  thumbnailUrl: string
  previewUrl: string
  previewSource: 'image' | 'embedded' | 'decoded'
}

export interface LinearAsset {
  hdr?: HdrWorkingAsset
  url?: string
  byteLength: number
  sha256: string
  transform: DisplayTransform
}
export interface HdrPreview extends Omit<FullPreview, 'format'> {
  format: 'hdr-working'
  linear: LinearAsset & { hdr: HdrWorkingAsset; url: string }
}
export type DisplayPreview = FullPreview | HdrPreview

export interface FullPreview {
  adjustments?: AdjustmentParameters
  linear?: LinearAsset
  settingsRevision?: number
  appliedCorrections?: LensSettings
  photoId: string
  requestId: string
  url: string
  width: number
  height: number
  format: 'rgba8-srgb'
  byteLength: number
  sha256: string
  renderId: string
  placeholderUrl?: string
}

export type PhotoReference = Pick<Photo, 'id' | 'filename'>

export interface PhotoPage {
  photos: Photo[]
  total: number
}

export interface PhotoLocation extends PhotoPage {
  offset: number
  index: number
}

export interface BackgroundTask {
  mergeMeasurements?: import('./merge').MergeMeasurements
  kind: 'import' | 'delete' | 'merge' | 'capture-grouping'
  phase?: string
  resultPhotoId?: string
  id: string
  title: string
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  detail?: string
  progress?: { completed: number; total: number; unit: 'bytes' | 'items' }
  items?: { completed: number; total: number; label: string }
  errorCount: number
  finishedAt?: number
}

export interface TaskErrorPage {
  errors: { filename: string; message: string }[]
  total: number
}

export type CandidateStatus = 'processing' | 'ready' | 'duplicate' | 'error' | 'imported'
export interface ImportCandidate {
  id: string
  filename: string
  relativePath: string
  bytes: number
  status: CandidateStatus
  selected: boolean
  thumbnailUrl?: string
  message?: string
}

export interface ImportReview {
  sessionId: string
  source: string
  phase: 'scanning' | 'review' | 'importing' | 'complete' | 'cancelled'
  candidates: ImportCandidate[]
  total: number
  selected: number
  selectedBytes: number
  ready: number
  duplicates: number
  errors: number
  imported: number
  skipped: number
  firstImportedId?: string
}

export interface LibraryEvent {
  editsChanged?: { photoId: string; revision: number }
  lensChanged?: { photoId: string; revision: number }
  sessionId?: string
  libraryChanged?: boolean
  tasksChanged?: boolean
  firstImportedId?: string
  deletedIds?: string[]
  replacementId?: string
}

export const PAGE_SIZE = 60
