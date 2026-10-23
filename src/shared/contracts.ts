import type { HdrAnalysisRequest, HdrPhotoStatistics } from './hdr-statistics'
import type { HdrPhotoPixel } from './hdr-pixel'
import type { PhotoStatistics } from './statistics'
import type { AdjustmentParameters } from './adjustments'
import type { DisplayTransform } from './adjustments'
import type { HdrWorkingAsset, DisplayTarget, DisplayCapabilities } from './hdr'
import type { PreviewPreference } from './hdr-display'
import type { EditState, EditPatch, EditHistory, EditFlushScope } from './edits'
import type { CorrectionKind, LensSettings, LensState } from './lens'
export interface AppInfo {
  version: string
  platform: 'linux' | 'darwin' | 'win32'
}

export interface ForegroundActivity {
  activityId: string
  sequence: number
  active: boolean
  photoId?: string
  reviewId?: string
}

export interface LumaApi extends NativeCpuPreviewBridge, NativeHdrMaskBridge {
  getResourceSettings(): Promise<import('./resource-policy').ResourceSettingsView>
  setResourceSettings(
    value: import('./resource-policy').ResourceSettings,
  ): Promise<import('./resource-policy').ResourceSettingsView>
  getResourcePolicy(
    adapter: import('./resource-policy').ResourceAdapterIdentity | null,
  ): Promise<import('./resource-policy').ResourcePolicySnapshot>
  getExportCapabilities(): Promise<import('./export').ExportCapabilities>
  getExportPreferences(): Promise<import('./export').ExportPreferences>
  chooseExportDestination(): Promise<import('./export').ExportDestination | null>
  prepareExport(ids: string[]): Promise<import('./export').ExportPreparation>
  disposeExportPreparation(id: string): Promise<void>
  startExport(request: import('./export').ExportStart): Promise<string>
  getExportResults(
    id: string,
    offset?: number,
  ): Promise<{ results: import('./export').ExportResult[]; total: number }>
  showExportFolder(id: string): Promise<void>
  getPhotoActionsContext(
    photoId: string | null,
    selectedIds: string[],
  ): Promise<import('./photo-actions').PhotoActionsContext>
  getBrowseSummary(
    query: import('./browse').BrowseQuery,
    selectedIds?: string[],
  ): Promise<import('./browse').BrowseSummary>
  getBrowseChunk(
    query: import('./browse').BrowseQuery,
    offset?: number,
    expectedRevision?: number,
  ): Promise<import('./browse').BrowseChunk>
  locateBrowsePhoto(
    query: import('./browse').BrowseQuery,
    photoId: string,
    expectedRevision?: number,
  ): Promise<import('./browse').BrowseLocation | null>
  getBrowseRange(
    query: import('./browse').BrowseQuery,
    fromId: string,
    toId: string,
  ): Promise<PhotoReference[]>
  getBrowseSection(query: import('./browse').BrowseQuery, key: string): Promise<PhotoReference[]>
  reportForegroundActivity(activity: ForegroundActivity): Promise<void>
  listStacks(): Promise<import('./stacks').StackOverview>
  getPhotoStack(photoId: string): Promise<import('./stacks').StackSummary | null>
  getStackMembers(stackId: string, offset?: number): Promise<import('./stacks').StackMembers>
  getStackSnapshot(
    stackId: string,
    expectedRevision: number,
  ): Promise<import('./stacks').StackSnapshot>
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
  listGallery(offset?: number, selectedIds?: string[]): Promise<import('./stacks').GalleryRead>
  locateGalleryPhoto(
    photoId: string,
    direction?: -1 | 0 | 1,
    revision?: import('./stacks').GalleryRevision,
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
  ): Promise<{ manifest: import('./merge').MergeBundleManifest; reproducible: boolean }>

  getPreviewDiagnostics(): Promise<import('./preview-diagnostics').PreviewDiagnostics>
  reportPreviewPresentation(
    value: import('./preview-diagnostics').PreviewPresentation,
  ): Promise<void>
  getDisplayState(): Promise<DisplayTarget>
  setPreviewPreference(preference: PreviewPreference): Promise<DisplayTarget>
  reportDisplayCapabilities(capabilities: DisplayCapabilities): Promise<DisplayTarget>
  onDisplayState(listener: (state: DisplayTarget) => void): () => void
  onDisplayRefresh(listener: () => void): () => void
  onFlushEdits(listener: (scope: EditFlushScope) => Promise<void>): () => void
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
  getCollectionPolicy(): Promise<import('./collections').CollectionPolicy>
  getWorkspaceState(): Promise<import('./workspace').WorkspaceSnapshot>
  saveWorkspaceState(change: import('./workspace').WorkspaceChange): Promise<number>
  onFlushWorkspace(listener: () => Promise<void>): () => void
  getGallerySummary(selectedIds?: string[]): Promise<import('./stacks').GallerySummary>
  getGalleryChunk(
    offset: number,
    revision: import('./stacks').GalleryRevision,
  ): Promise<import('./stacks').GalleryChunk>
  getReviewSummary(sessionId: string): Promise<ImportReviewSummary>
  getReviewChunk(
    sessionId: string,
    offset: number,
    orderingRevision: number,
  ): Promise<ImportReviewChunk>
  locateReviewCandidate(
    sessionId: string,
    candidateId: string,
    orderingRevision: number,
  ): Promise<ImportReviewLocation | null>
  getAppInfo(): Promise<AppInfo>
  listPhotos(offset?: number): Promise<PhotoPage>
  requestHdrPreview(
    photoId: string,
    requestId: string,
    regenerate?: boolean,
    mode?: 'sdr' | 'hdr',
    firstSurface?: import('./hdr-first-surface').HdrFirstSurfaceRequest,
    rendererReservation?: import('./resource-policy').ManagedImageBytes,
  ): Promise<HdrPreview | null>
  onHdrFirstSurface(
    listener: (offer: import('./hdr-first-surface').HdrFirstSurfaceOffer) => void,
  ): () => void
  releaseHdrFirstSurface(requestId: string, surfaceId: string): Promise<void>
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
  listImportDevices(): Promise<import('./import-devices').ImportDevice[]>
  chooseDevice(
    deviceId: string,
    searchEntireDevice: boolean,
    onlyMissing?: boolean,
    verificationMode?: ImportVerificationMode,
  ): Promise<string>
  requestReviewThumbnails(
    sessionId: string,
    request: string[] | ReviewThumbnailRequest,
  ): Promise<void>
  getReview(sessionId: string, offset?: number): Promise<ImportReview>
  selectCandidates(sessionId: string, ids: string[] | null, selected: boolean): Promise<void>
  setImportOnlyMissing(sessionId: string, enabled: boolean): Promise<void>
  setImportVerificationMode(sessionId: string, mode: ImportVerificationMode): Promise<void>
  importSelected(sessionId: string): Promise<void>
  cancelImport(sessionId: string): Promise<void>
  disposeImport(sessionId: string): Promise<void>
  onLibraryEvent(listener: (event: LibraryEvent) => void): () => void
}

export interface PhotoMetadata {
  captureDateOrigin?: import('./browse').CaptureDateOrigin
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
  firstSurfacePolicy?: import('./resource-policy').ResourcePolicySnapshot
  firstSurfaceLineage?: { parentWorkingKey: string; workingSha256: string }
  firstSurfaceDecline?: string
  format: 'hdr-working'
  linear: LinearAsset & { hdr: HdrWorkingAsset; url: string }
}
export type DisplayPreview = FullPreview | HdrPreview

export interface FullPreview {
  cpuSource?: import('./native-cpu-preview').CpuPreviewSourceRef
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

export interface BackgroundTask {
  exportWorkerProgress?: import('./export').ExportWorkerProgressSnapshot
  mergeMeasurements?: import('./merge').MergeMeasurements
  kind: 'import' | 'delete' | 'merge' | 'capture-grouping' | 'export'
  export?: {
    exported: number
    skipped: number
    failed: number
    cancelled: number
    destinationId: string
    destinationLabel: string
  }
  phase?: string
  resultPhotoId?: string
  id: string
  title: string
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  detail?: string
  progress?: { completed: number; total: number; unit: 'bytes' | 'items' }
  items?: { completed: number; total: number; label: string }
  errorCount: number
  outcomes?: { processed: number; imported: number; duplicates: number; failed: number }
  transfer?: {
    copied: number
    prepared: number
    bytes: number
    totalBytes: number
    bytesPerSecond: number
  }
  waitingReason?:
    'foreground' | 'library-operation' | 'export' | 'pipeline-capacity' | 'raw-fallback'
  skippedAfterDeletion?: number
  unprocessed?: number
  importMeasurements?: {
    copyActiveMs: number
    preparationMs: number
    firstPublicationMs?: number
    stagingPeakBytes: number
    inFlightPeak: number
  }
  finishedAt?: number
}

export interface TaskErrorPage {
  errors: { filename: string; message: string }[]
  total: number
}

export type CandidateStatus =
  'unchecked' | 'processing' | 'ready' | 'duplicate' | 'error' | 'imported' | 'skipped'
export interface ImportCandidate {
  id: string
  filename: string
  relativePath: string
  bytes: number
  status: CandidateStatus
  selected: boolean
  alreadyImported?: boolean
  thumbnailUrl?: string
  thumbnailState: 'idle' | 'loading' | 'ready' | 'error'
  thumbnailMessage?: string
  message?: string
}

export type ImportVerificationMode = 'camera-fast' | 'full'

export interface ImportReview {
  sessionId: string
  source: string
  sourceError?: string
  checkingPrevious?: string
  onlyMissing?: boolean
  verificationMode?: ImportVerificationMode
  verificationPending?: boolean
  alreadyImported: number
  alreadyImportedBytes: number
  phase: 'scanning' | 'review' | 'importing' | 'complete' | 'cancelled'
  candidates: ImportCandidate[]
  total: number
  selected: number
  selectedBytes: number
  totalBytes: number
  orderingRevision: number
  contentRevision: number
  selectionRevision: number
  ready: number
  unchecked: number
  duplicates: number
  errors: number
  imported: number
  skipped: number
  firstImportedId?: string
}

export type ImportReviewSummary = Omit<ImportReview, 'candidates'>
export interface ImportReviewChunk {
  sessionId: string
  offset: number
  orderingRevision: number
  contentRevision: number
  selectionRevision: number
  candidates: ImportCandidate[]
}
export interface ImportReviewLocation {
  orderingRevision: number
  index: number
  candidate: ImportCandidate
}
export interface ReviewThumbnailRequest {
  generation: number
  visible: string[]
  lookahead: string[]
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

export { COLLECTION_CHUNK_SIZE } from './collections'
import type { NativeCpuPreviewBridge } from './native-cpu-preview'

import type { NativeHdrMaskBridge } from './native-hdr-mask'
