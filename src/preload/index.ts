import { MergeError, type MergeFailure } from '../shared/merge'
import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, LibraryEvent, LumaApi } from '../shared/contracts'

async function mergeResult<T>(response: Promise<{ result: T; error?: MergeFailure }>): Promise<T> {
  const value = await response
  if (value.error) throw new MergeError(value.error)
  return value.result
}
const api: LumaApi = {
  listStacks: () => ipcRenderer.invoke('stacks:list'),
  getPhotoStack: (id) => ipcRenderer.invoke('stacks:photo', id),
  getStackMembers: (id, offset = 0) => ipcRenderer.invoke('stacks:members', id, offset),
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
  locateGalleryPhoto: (id, direction = 0) => ipcRenderer.invoke('gallery:locate', id, direction),
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
  upgradePhotoProcessing: (id, revision) =>
    ipcRenderer.invoke('edits:upgrade-processing', id, revision),
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
  locatePhoto: (id, direction = 0) => ipcRenderer.invoke('library:locate', id, direction),
  getPhotoRange: (from, to) => ipcRenderer.invoke('library:range', from, to),
  requestHdrPreview: async (id, token, regenerate = false) => {
    const result = await ipcRenderer.invoke('preview:hdr', id, token, regenerate)
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
  chooseSource: (kind, recursive) => ipcRenderer.invoke('library:choose', kind, recursive),
  getReview: (id, offset = 0) => ipcRenderer.invoke('library:review', id, offset),
  selectCandidates: (id, ids, selected) => ipcRenderer.invoke('library:select', id, ids, selected),
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
