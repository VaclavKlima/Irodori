import { CollectionChangedError } from '../shared/collections'
import { MergeError, type MergeFailure } from '../shared/merge'
import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, LibraryEvent, LumaApi } from '../shared/contracts'
import { BrowseCatalogChangedError } from '../shared/browse'

async function browseResult<T>(response: Promise<{ result: T; stale?: boolean }>): Promise<T> {
  const value = await response
  if (value.stale) throw new BrowseCatalogChangedError()
  return value.result
}

async function collectionResult<T>(response: Promise<{ result: T; stale?: boolean }>): Promise<T> {
  const value = await response
  if (value.stale) throw new CollectionChangedError()
  return value.result
}
async function mergeResult<T>(response: Promise<{ result: T; error?: MergeFailure }>): Promise<T> {
  const value = await response
  if (value.error) throw new MergeError(value.error)
  return value.result
}
const api: LumaApi = {
  getExportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  getExportPreferences: () => ipcRenderer.invoke('export:preferences'),
  chooseExportDestination: () => ipcRenderer.invoke('export:choose-destination'),
  prepareExport: (ids) => ipcRenderer.invoke('export:prepare', ids),
  disposeExportPreparation: (id) => ipcRenderer.invoke('export:dispose', id),
  startExport: (request) => ipcRenderer.invoke('export:start', request),
  getExportResults: (id, offset = 0) => ipcRenderer.invoke('export:results', id, offset),
  showExportFolder: (id) => ipcRenderer.invoke('export:show-folder', id),
  getCollectionPolicy: () => ipcRenderer.invoke('collections:policy'),
  getWorkspaceState: () => ipcRenderer.invoke('workspace:get'),
  saveWorkspaceState: (change) => ipcRenderer.invoke('workspace:save', change),
  onFlushWorkspace: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, token: string) => {
      void listener()
        .finally(() => ipcRenderer.send('workspace:flushed', token))
        .catch(() => {})
    }
    ipcRenderer.on('workspace:flush', handler)
    return () => ipcRenderer.removeListener('workspace:flush', handler)
  },
  getGallerySummary: (ids = []) => ipcRenderer.invoke('gallery:summary', ids),
  getGalleryChunk: (offset, revision) =>
    collectionResult(ipcRenderer.invoke('gallery:chunk', offset, revision)),
  getReviewSummary: (id) => ipcRenderer.invoke('review:summary', id),
  getReviewChunk: (id, offset, revision) =>
    collectionResult(ipcRenderer.invoke('review:chunk', id, offset, revision)),
  locateReviewCandidate: (id, candidate, revision) =>
    collectionResult(ipcRenderer.invoke('review:locate', id, candidate, revision)),
  getBrowseSummary: (query, selectedIds = []) =>
    ipcRenderer.invoke('browse:summary', query, selectedIds),
  getBrowseChunk: (query, offset = 0, revision) =>
    browseResult(ipcRenderer.invoke('browse:chunk', query, offset, revision)),
  locateBrowsePhoto: (query, id, revision) =>
    browseResult(ipcRenderer.invoke('browse:locate', query, id, revision)),
  getBrowseRange: (query, from, to) => ipcRenderer.invoke('browse:range', query, from, to),
  getBrowseSection: (query, key) => ipcRenderer.invoke('browse:section', query, key),
  reportForegroundActivity: (activity) => ipcRenderer.invoke('foreground:activity', activity),
  getPhotoActionsContext: (id, selectedIds) =>
    ipcRenderer.invoke('photo-actions:context', id, selectedIds),
  listStacks: () => ipcRenderer.invoke('stacks:list'),
  getPhotoStack: (id) => ipcRenderer.invoke('stacks:photo', id),
  getStackMembers: (id, offset = 0) => ipcRenderer.invoke('stacks:members', id, offset),
  getStackSnapshot: (id, revision) => ipcRenderer.invoke('stacks:snapshot', id, revision),
  groupPhotos: (ids, coverId, revision) =>
    ipcRenderer.invoke('stacks:group', ids, coverId, revision),
  ungroupStack: (id, revision) => ipcRenderer.invoke('stacks:ungroup', id, revision),
  removeFromStack: (id, revision) => ipcRenderer.invoke('stacks:remove', id, revision),
  setStackCover: (id, photoId, revision) =>
    ipcRenderer.invoke('stacks:cover', id, photoId, revision),
  setStackExpanded: (id, expanded, revision) =>
    ipcRenderer.invoke('stacks:expand', id, expanded, revision),
  listGallery: (offset = 0, selectedIds = []) =>
    ipcRenderer.invoke('gallery:list', offset, selectedIds),
  locateGalleryPhoto: (id, direction = 0, revision) =>
    collectionResult(ipcRenderer.invoke('gallery:locate', id, direction, revision)),
  getGalleryRange: (from, to) => ipcRenderer.invoke('gallery:range', from, to),
  groupCaptureSequences: () => ipcRenderer.invoke('stacks:capture-scan'),
  getActiveMergeReview: () => mergeResult(ipcRenderer.invoke('merge:active')),
  getMergeDiagnostics: (id, revision) =>
    mergeResult(ipcRenderer.invoke('merge:diagnostics', id, revision)),
  createMergeReview: (ids, mode) => mergeResult(ipcRenderer.invoke('merge:create', ids, mode)),
  updateMergeReview: (id, revision, settings) =>
    mergeResult(ipcRenderer.invoke('merge:update', id, revision, settings)),
  requestMergePreview: (id, revision) =>
    mergeResult(ipcRenderer.invoke('merge:preview', id, revision)),
  startMerge: (id, revision) => mergeResult(ipcRenderer.invoke('merge:start', id, revision)),
  disposeMergeReview: (id) => mergeResult(ipcRenderer.invoke('merge:dispose', id)),
  getMergeProvenance: (id) => mergeResult(ipcRenderer.invoke('merge:provenance', id)),
  getPreviewDiagnostics: () => ipcRenderer.invoke('preview:diagnostics'),
  reportPreviewPresentation: (value) => ipcRenderer.invoke('preview:presentation', value),
  getDisplayState: () => ipcRenderer.invoke('display:get'),
  setPreviewPreference: (preference) => ipcRenderer.invoke('display:preference', preference),
  reportDisplayCapabilities: (capabilities) =>
    ipcRenderer.invoke('display:capabilities', capabilities),
  onDisplayState: (listener) => {
    const handler = (_: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
      listener(state)
    ipcRenderer.on('display:state', handler)
    return () => {
      ipcRenderer.removeListener('display:state', handler)
    }
  },
  onDisplayRefresh: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('display:refresh', handler)
    return () => {
      ipcRenderer.removeListener('display:refresh', handler)
    }
  },
  onFlushEdits: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, token: string) => {
      void listener().then(
        () => ipcRenderer.send('edits:flushed', token),
        (error) => ipcRenderer.send('edits:flushed', token, String(error)),
      )
    }
    ipcRenderer.on('edits:flush', handler)
    return () => {
      ipcRenderer.removeListener('edits:flush', handler)
    }
  },
  getPhotoStatistics: async (
    id: string,
    revision: number,
    request?: import('../shared/hdr-statistics').HdrAnalysisRequest,
  ) => {
    const result = await ipcRenderer.invoke('statistics:get', id, revision, request)
    if (result.error) throw new Error(result.error)
    return result.statistics
  },
  getEdits: (id) => ipcRenderer.invoke('edits:get', id),
  getPhotoPixel: async (id, revision, x, y, request) => {
    const result = await ipcRenderer.invoke('pixel:get', id, revision, x, y, request)
    if (result.error) throw new Error(result.error)
    return result.pixel
  },
  updateEdits: (id, patch, revision) => ipcRenderer.invoke('edits:update', id, patch, revision),
  getEditHistory: (id) => ipcRenderer.invoke('edits:history', id),
  undoEdit: (id, revision) => ipcRenderer.invoke('edits:undo', id, revision),
  redoEdit: (id, revision) => ipcRenderer.invoke('edits:redo', id, revision),
  getLensSettings: (id) => ipcRenderer.invoke('lens:get', id),
  updateLensSettings: (id, kind, enabled) => ipcRenderer.invoke('lens:update', id, kind, enabled),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:get-info'),
  listPhotos: (offset = 0) => ipcRenderer.invoke('library:list', offset),
  requestHdrPreview: async (id, token, regenerate = false, mode = 'hdr') => {
    const result = await ipcRenderer.invoke('preview:hdr', id, token, regenerate, mode)
    if (result.error) throw new Error(result.error)
    return result.preview
  },
  requestEditingPreview: async (id, token) => {
    const result = await ipcRenderer.invoke('preview:editing', id, token)
    if (result.error) throw new Error(result.error)
    return result.preview
  },
  requestFullPreview: async (id, token, regenerate = false) => {
    const result = await ipcRenderer.invoke('preview:request', id, token, regenerate)
    if (result.error) throw new Error(result.error)
    return result.preview
  },
  releaseFullPreview: (token) => ipcRenderer.invoke('preview:release', token),
  requestCachedFullPreview: async (id, token) => {
    const result = await ipcRenderer.invoke('preview:cached', id, token)
    if (result.error) throw new Error(result.error)
    return result.preview
  },
  deletePhotos: (ids) => ipcRenderer.invoke('library:delete', ids),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  cancelTask: (id) => ipcRenderer.invoke('tasks:cancel', id),
  dismissTask: (id) => ipcRenderer.invoke('tasks:dismiss', id),
  getTaskErrors: (id, offset = 0) => ipcRenderer.invoke('tasks:errors', id, offset),
  listImportDevices: async () => {
    const result = await ipcRenderer.invoke('library:devices')
    if (result.error) throw new Error(result.error)
    return result.devices
  },
  chooseDevice: (id, searchEntireDevice, onlyMissing = true, verificationMode = 'camera-fast') =>
    ipcRenderer.invoke('library:device', id, searchEntireDevice, onlyMissing, verificationMode),
  requestReviewThumbnails: (id, ids) => ipcRenderer.invoke('library:thumbnails', id, ids),
  chooseSource: (kind, recursive) => ipcRenderer.invoke('library:choose', kind, recursive),
  getReview: (id, offset = 0) => ipcRenderer.invoke('library:review', id, offset),
  selectCandidates: (id, ids, selected) => ipcRenderer.invoke('library:select', id, ids, selected),
  setImportOnlyMissing: (id, enabled) => ipcRenderer.invoke('library:only-missing', id, enabled),
  setImportVerificationMode: (id, mode) =>
    ipcRenderer.invoke('library:verification-mode', id, mode),
  importSelected: (id) => ipcRenderer.invoke('library:import', id),
  cancelImport: (id) => ipcRenderer.invoke('library:cancel', id),
  disposeImport: (id) => ipcRenderer.invoke('library:dispose', id),
  onLibraryEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: LibraryEvent) => listener(event)
    ipcRenderer.on('library:event', handler)
    return () => {
      ipcRenderer.removeListener('library:event', handler)
    }
  },
}

contextBridge.exposeInMainWorld('luma', Object.freeze(api))
