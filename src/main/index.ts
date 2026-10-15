import { CollectionChangedError } from '../shared/collections'
import { mergeFailure } from '../shared/merge'
import { DisplayState } from './display-state'
import { installWaylandDisplayRefresh } from './wayland-display'
import { pathToFileURL } from 'node:url'
import { powerMonitor } from 'electron'
import { startEditorEndpoint } from './editor-endpoint'
import { BrowseCatalogChangedError } from '../shared/browse'
import { randomUUID } from 'node:crypto'
import { photoExtensions } from './processing/formats'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { AppInfo } from '../shared/contracts'
import { PhotoLibrary } from './library'
import { PreviewProcess } from './preview-process'
import { ImportDevices } from './import-devices'
import { createAppWindow, showAppWindow } from './window-presentation'
import { closeServices } from './shutdown'

const importDevices = new ImportDevices()

app.setName('Luma')
app.enableSandbox()
app.commandLine.appendSwitch('enable-blink-features', 'ScreenDetailedHdrHeadroom')
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'wayland')
  const features = app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean)
  app.commandLine.appendSwitch('enable-features', [...new Set([...features, 'Vulkan'])].join(','))
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
}
if (process.env.LUMA_HDR_TEST === '1') app.commandLine.removeSwitch('force-color-profile')
let displayState: DisplayState

let mainWindow: BrowserWindow | null = null
let library: PhotoLibrary | undefined
let editorEndpoint: Awaited<ReturnType<typeof startEditorEndpoint>> | undefined
let quitting = false
let picking = false
let quitPending = false
let closingRenderer: Electron.WebContents | undefined

function handleLibraryRequest(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  ipcMain.handle(channel, (event, ...args) => {
    // The destroyed renderer can still have invokes in Electron's queue. Its
    // final saves were acknowledged before shutdown; do not enter closed services.
    if (event.sender === closingRenderer) return
    return listener(event, ...args)
  })
}

async function requestQuit(): Promise<void> {
  if (quitting || quitPending) return
  quitPending = true
  try {
    if (library?.hasActiveTask()) {
      const options = {
        type: 'question' as const,
        title: 'A library task is still running',
        message: 'Keep working on your photos?',
        detail:
          'Cancellation stops remaining work after the current operation finishes. Completed imports and moves to Trash are kept.',
        buttons: ['Keep working', 'Cancel task and quit'],
        defaultId: 0,
        cancelId: 0,
      }
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      if (result.response !== 1) return
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const window = mainWindow
      await new Promise<void>((resolve, reject) => {
        const token = randomUUID()
        const timer = setTimeout(() => {
          ipcMain.removeListener('edits:flushed', handler)
          reject(new Error('The editor did not finish saving. Try closing again.'))
        }, 10000)
        const handler = (event: Electron.IpcMainEvent, returned: string, error?: string) => {
          if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            returned !== token
          )
            return
          clearTimeout(timer)
          ipcMain.removeListener('edits:flushed', handler)
          if (error) reject(new Error(error))
          else resolve()
        }
        ipcMain.on('edits:flushed', handler)
        window.webContents.send('edits:flush', token)
      })
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const window = mainWindow
      await new Promise<void>((resolve) => {
        const token = randomUUID()
        const finish = () => {
          clearTimeout(timer)
          ipcMain.removeListener('workspace:flushed', handler)
          resolve()
        }
        const handler = (event: Electron.IpcMainEvent, returned: string) => {
          if (
            event.sender === window.webContents &&
            event.senderFrame === window.webContents.mainFrame &&
            returned === token
          )
            finish()
        }
        const timer = setTimeout(finish, 10000)
        ipcMain.on('workspace:flushed', handler)
        window.webContents.send('workspace:flush', token)
      })
    }
    // Saving is complete. Stop renderer requests before closing their catalog and
    // workers; otherwise queued thumbnail loads race the library's closed state.
    if (mainWindow) {
      closingRenderer = mainWindow.webContents
      mainWindow.destroy()
    }
    try {
      await closeServices([() => editorEndpoint?.close(), () => library?.close()])
      quitting = true
      app.quit()
    } catch (error) {
      // The saved renderer has already gone; finish all cleanup and terminate
      // instead of reopening a workspace against partially closed services.
      console.error('Could not finish shutting down Luma:', error)
      app.exit(1)
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'Could not finish saving',
      detail: String(error),
    })
  } finally {
    quitPending = false
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'luma-photo',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  mainWindow?.restore()
  mainWindow?.focus()
})

function trusted(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  )
    throw new Error('Untrusted library request.')
}

function createWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const window = createAppWindow({
    title: 'Luma',
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 1100,
    minHeight: 700,
    useContentSize: true,
    show: false,
    backgroundColor: '#17191a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  mainWindow = window
  installWaylandDisplayRefresh(window)
  const releasePreview = () => {
    library?.releaseForegroundActivities()
    void library?.fullPreviews.release().catch(() => undefined)
  }
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) releasePreview()
  })
  window.webContents.on('render-process-gone', releasePreview)
  window.webContents.on('destroyed', releasePreview)
  window.on('blur', () => library?.releaseForegroundActivities())

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const trustedUrl =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).href
      : pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
  const allowed = (
    contents: Electron.WebContents | null,
    permission: string,
    details: { isMainFrame: boolean; requestingUrl?: string },
  ) =>
    contents === window.webContents &&
    (permission === 'window-management' || permission === 'pointerLock') &&
    details.isMainFrame &&
    details.requestingUrl === trustedUrl &&
    contents.getURL() === trustedUrl
  window.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => callback(allowed(contents, permission, details)),
  )
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowed(contents, permission, details),
  )
  window.on('move', () => window.webContents.send('display:refresh'))
  window.once('ready-to-show', () => showAppWindow(window))
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      void requestQuit()
    }
  })
  window.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  const loading =
    !app.isPackaged && devUrl
      ? window.loadURL(devUrl)
      : window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  loading.catch((error: unknown) => {
    console.error('Could not load the Luma interface:', error)
    app.exit(1)
  })
}

app
  .whenReady()
  .then(async () => {
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { role: 'windowMenu' },
          ])
        : null,
    )

    handleLibraryRequest('app:get-info', (event): AppInfo => {
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame
      ) {
        throw new Error('Untrusted application information request')
      }
      return { version: app.getVersion(), platform: process.platform as AppInfo['platform'] }
    })

    displayState = new DisplayState(
      app.getPath('userData'),
      (state) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('display:state', state)
      },
      () => mainWindow?.webContents.send('display:refresh'),
    )
    await displayState.open()
    powerMonitor.on('suspend', () => library?.releaseForegroundActivities())
    powerMonitor.on('resume', () => {
      displayState.invalidate('Rechecking display after resume.')
      mainWindow?.webContents.send('display:refresh')
    })
    handleLibraryRequest('preview:diagnostics', (event) => {
      trusted(event)
      return {
        ...library!.fullPreviews.getDiagnostics(),
        presentation: displayState.get().presentation,
      }
    })
    handleLibraryRequest('preview:presentation', (event, value) => {
      trusted(event)
      if (
        !value ||
        typeof value.photoId !== 'string' ||
        !Number.isSafeInteger(value.revision) ||
        !Number.isSafeInteger(value.targetGeneration) ||
        !['webgpu-hdr', 'canvas2d-hdr-sdr', 'legacy'].includes(value.backend) ||
        !['hdr', 'sdr'].includes(value.mode) ||
        !['loading', 'presented', 'failed'].includes(value.stage) ||
        typeof value.reason !== 'string' ||
        value.reason.length > 512 ||
        !value.timings ||
        Object.values(value.timings).some(
          (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0,
        )
      )
        throw new Error('Invalid preview presentation report.')
      const active = library!.fullPreviews.getDiagnostics()
      if (
        active.photoId !== value.photoId ||
        (active.revision !== undefined && active.revision !== value.revision)
      )
        return
      displayState.reportPresentation(value)
    })
    handleLibraryRequest('display:get', (event) => {
      trusted(event)
      return displayState.get()
    })
    handleLibraryRequest('display:preference', (event, preference) => {
      trusted(event)
      return displayState.set(preference)
    })
    handleLibraryRequest('display:capabilities', (event, capabilities) => {
      trusted(event)
      return displayState.report(capabilities)
    })
    async function mergeReply<T>(operation: () => T | Promise<T>) {
      try {
        return { result: await operation() }
      } catch (error) {
        return { error: mergeFailure(error) }
      }
    }
    handleLibraryRequest('merge:active', (event) => {
      trusted(event)
      return mergeReply(() => library!.getActiveMergeReview())
    })
    handleLibraryRequest('merge:diagnostics', (event, id, revision) => {
      trusted(event)
      return mergeReply(() => library!.getMergeDiagnostics(id, revision))
    })
    handleLibraryRequest('merge:create', (event, ids, mode) => {
      trusted(event)
      return mergeReply(() => library!.createMergeReview(ids, mode))
    })
    handleLibraryRequest('merge:update', (event, id, revision, settings) => {
      trusted(event)
      return mergeReply(() => library!.updateMergeReview(id, revision, settings))
    })
    handleLibraryRequest('merge:preview', (event, id, revision) => {
      trusted(event)
      return mergeReply(() => library!.requestMergePreview(id, revision))
    })
    handleLibraryRequest('merge:start', (event, id, revision) => {
      trusted(event)
      return mergeReply(() => library!.startMerge(id, revision))
    })
    handleLibraryRequest('merge:dispose', (event, id) => {
      trusted(event)
      return mergeReply(() => library!.disposeMergeReview(id))
    })
    handleLibraryRequest('merge:provenance', (event, id) => {
      trusted(event)
      return mergeReply(() => library!.getMergeProvenance(id))
    })
    library = new PhotoLibrary(
      join(app.getPath('userData'), 'library'),
      new PreviewProcess(),
      (event) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('library:event', event)
      },
      undefined,
      (path) => shell.trashItem(path),
      undefined,
    )
    library.displayTarget = () => displayState.get()
    await library.open()
    editorEndpoint = await startEditorEndpoint(app.getPath('userData'), library, displayState)
    protocol.handle('luma-photo', async (request) => {
      if (request.method !== 'GET') return new Response(null, { status: 404 })
      const asset = library?.fullPreviews.acquire(new URL(request.url))
      if (asset) {
        const range = request.headers.get('range')
        const match = range?.match(/^bytes=(\d+)-(\d+)$/)
        const start = match ? Number(match[1]) : 0
        const end = match ? Number(match[2]) : asset.byteLength - 1
        if (
          range &&
          (!match ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            end >= asset.byteLength ||
            end - start + 1 > 16 * 1024 ** 2)
        ) {
          asset.release()
          return new Response(null, { status: 416 })
        }
        // Keep protocol chunks large enough to avoid thousands of cross-process transfers.
        const highWaterMark = 1024 * 1024
        const stream = createReadStream(asset.path, { start, end, highWaterMark })
        const abort = () => stream.destroy()
        request.signal.addEventListener('abort', abort, { once: true })
        stream.once('close', () => {
          request.signal.removeEventListener('abort', abort)
          asset.release()
        })
        if (request.signal.aborted) stream.destroy()
        return new Response(
          Readable.toWeb(stream, {
            strategy: { highWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
          }) as ReadableStream<Uint8Array>,
          {
            status: range ? 206 : 200,
            headers: {
              'Content-Type': asset.contentType,
              'Content-Length': String(end - start + 1),
              ...(range ? { 'Content-Range': `bytes ${start}-${end}/${asset.byteLength}` } : {}),
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store',
            },
          },
        )
      }
      const path = library?.imagePath(request.url)
      if (!path || request.method !== 'GET') return new Response(null, { status: 404 })
      try {
        return new Response(await readFile(path), {
          headers: {
            'Content-Type': path.endsWith('.png') ? 'image/png' : 'image/jpeg',
            'Cache-Control': 'no-store',
          },
        })
      } catch {
        return new Response(null, { status: 404 })
      }
    })
    handleLibraryRequest('statistics:get', (event, id: string, revision: number, request) => {
      trusted(event)
      return library!.getPhotoStatistics(id, revision, request).then(
        (statistics) => ({ statistics }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('foreground:activity', (event, value) => {
      trusted(event)
      library!.reportForegroundActivity(value)
    })
    handleLibraryRequest('edits:get', (event, id) => {
      trusted(event)
      return library!.getEdits(id)
    })
    handleLibraryRequest('pixel:get', (event, id, revision, x, y, request) => {
      trusted(event)
      return library!.getPhotoPixel(id, revision, x, y, request).then(
        (pixel) => ({ pixel }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('edits:update', (event, id, patch, revision) => {
      trusted(event)
      return library!.updateEdits(id, patch, revision)
    })
    handleLibraryRequest('edits:history', (event, id) => {
      trusted(event)
      return library!.getEditHistory(id)
    })
    handleLibraryRequest('edits:undo', (event, id, revision) => {
      trusted(event)
      return library!.undoEdit(id, revision)
    })
    handleLibraryRequest('edits:redo', (event, id, revision) => {
      trusted(event)
      return library!.redoEdit(id, revision)
    })
    handleLibraryRequest('lens:get', (event, id) => {
      trusted(event)
      return library!.getLensSettings(id)
    })
    handleLibraryRequest('lens:update', (event, id, kind, enabled) => {
      trusted(event)
      return library!.updateLensSettings(id, kind, enabled)
    })
    handleLibraryRequest('library:list', (event, offset: number) => {
      trusted(event)
      return library!.list(offset)
    })
    handleLibraryRequest(
      'preview:request',
      (event, id: string, token: string, regenerate = false) => {
        trusted(event)
        // Preview failures are expected UI states, not uncaught IPC exceptions.
        return library!.fullPreviews.request(id, token, regenerate).then(
          (preview) => ({ preview }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        )
      },
    )
    handleLibraryRequest('preview:hdr', (event, id, token, regenerate = false) => {
      trusted(event)
      return library!.fullPreviews.requestHdr(id, token, regenerate).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('preview:editing', (event, id, token) => {
      trusted(event)
      return library!.fullPreviews.requestEditing(id, token).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('preview:cached', (event, id: string, token: string) => {
      trusted(event)
      return library!.fullPreviews.requestCached(id, token).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    handleLibraryRequest('preview:release', (event, token: string) => {
      trusted(event)
      if (typeof token !== 'string') throw new Error('Invalid preview request token.')
      return library!.fullPreviews.release(token)
    })
    handleLibraryRequest(
      'photo-actions:context',
      (event, id: string | null, selectedIds: string[]) => {
        trusted(event)
        return library!.getPhotoActionsContext(id, selectedIds)
      },
    )
    handleLibraryRequest('stacks:list', (event) => {
      trusted(event)
      return library!.listStacks()
    })
    handleLibraryRequest('stacks:photo', (event, id: string) => {
      trusted(event)
      return library!.getPhotoStack(id)
    })
    handleLibraryRequest('stacks:members', (event, id: string, offset: number) => {
      trusted(event)
      return library!.getStackMembers(id, offset)
    })
    handleLibraryRequest('stacks:snapshot', (event, id: string, revision: number) => {
      trusted(event)
      return library!.getStackSnapshot(id, revision)
    })
    handleLibraryRequest(
      'stacks:group',
      (event, ids: string[], coverId: string, revision: number) => {
        trusted(event)
        return library!.groupPhotos(ids, coverId, revision)
      },
    )
    handleLibraryRequest('stacks:ungroup', (event, id: string, revision: number) => {
      trusted(event)
      return library!.ungroupStack(id, revision)
    })
    handleLibraryRequest('stacks:remove', (event, id: string, revision: number) => {
      trusted(event)
      return library!.removeFromStack(id, revision)
    })
    handleLibraryRequest('stacks:cover', (event, id: string, photoId: string, revision: number) => {
      trusted(event)
      return library!.setStackCover(id, photoId, revision)
    })
    handleLibraryRequest(
      'stacks:expand',
      (event, id: string, expanded: boolean, revision: number) => {
        trusted(event)
        return library!.setStackExpanded(id, expanded, revision)
      },
    )
    handleLibraryRequest('stacks:capture-scan', (event) => {
      trusted(event)
      if (picking) throw new Error('Close the file picker first.')
      return library!.groupCaptureSequences()
    })
    const collectionReply = <T>(read: () => T) => {
      try {
        return { result: read() }
      } catch (error) {
        if (error instanceof CollectionChangedError) return { stale: true }
        throw error
      }
    }
    handleLibraryRequest('collections:policy', (event) => {
      trusted(event)
      return library!.getCollectionPolicy()
    })
    handleLibraryRequest('workspace:get', (event) => {
      trusted(event)
      return library!.getWorkspaceState()
    })
    handleLibraryRequest(
      'workspace:save',
      (event, change: import('../shared/workspace').WorkspaceChange) => {
        trusted(event)
        return library!.saveWorkspaceState(change)
      },
    )
    handleLibraryRequest('gallery:summary', (event, ids: string[]) => {
      trusted(event)
      return library!.getGallerySummary(ids)
    })
    handleLibraryRequest(
      'gallery:chunk',
      (event, offset: number, revision: import('../shared/stacks').GalleryRevision) => {
        trusted(event)
        return collectionReply(() => library!.getGalleryChunk(offset, revision))
      },
    )
    handleLibraryRequest('review:summary', (event, id: string) => {
      trusted(event)
      return library!.reviewSummary(id)
    })
    handleLibraryRequest('review:chunk', (event, id: string, offset: number, revision: number) => {
      trusted(event)
      return collectionReply(() => library!.reviewChunk(id, offset, revision))
    })
    handleLibraryRequest(
      'review:locate',
      (event, id: string, candidate: string, revision: number) => {
        trusted(event)
        return collectionReply(() => library!.locateReviewCandidate(id, candidate, revision))
      },
    )
    handleLibraryRequest('gallery:list', (event, offset: number, selectedIds: string[]) => {
      trusted(event)
      return library!.listGallery(offset, selectedIds)
    })
    handleLibraryRequest(
      'browse:summary',
      (event, query: import('../shared/browse').BrowseQuery, selectedIds: string[]) => {
        trusted(event)
        return library!.getBrowseSummary(query, selectedIds)
      },
    )
    handleLibraryRequest(
      'browse:chunk',
      (event, query: import('../shared/browse').BrowseQuery, offset: number, revision?: number) => {
        trusted(event)
        try {
          return { result: library!.getBrowseChunk(query, offset, revision) }
        } catch (error) {
          if (error instanceof BrowseCatalogChangedError) return { stale: true }
          throw error
        }
      },
    )
    handleLibraryRequest(
      'browse:locate',
      (event, query: import('../shared/browse').BrowseQuery, id: string, revision?: number) => {
        trusted(event)
        try {
          return { result: library!.locateBrowsePhoto(query, id, revision) }
        } catch (error) {
          if (error instanceof BrowseCatalogChangedError) return { stale: true }
          throw error
        }
      },
    )
    handleLibraryRequest(
      'browse:range',
      (event, query: import('../shared/browse').BrowseQuery, from: string, to: string) => {
        trusted(event)
        return library!.getBrowseRange(query, from, to)
      },
    )
    handleLibraryRequest(
      'browse:section',
      (event, query: import('../shared/browse').BrowseQuery, key: string) => {
        trusted(event)
        return library!.getBrowseSection(query, key)
      },
    )
    handleLibraryRequest(
      'gallery:locate',
      (
        event,
        id: string,
        direction: -1 | 0 | 1,
        revision?: import('../shared/stacks').GalleryRevision,
      ) => {
        trusted(event)
        return collectionReply(() => library!.locateGalleryPhoto(id, direction, revision))
      },
    )
    handleLibraryRequest('gallery:range', (event, from: string, to: string) => {
      trusted(event)
      return library!.getGalleryRange(from, to)
    })
    handleLibraryRequest('library:delete', (event, ids: string[]) => {
      trusted(event)
      if (picking) throw new Error('Close the file picker first.')
      return library!.deletePhotos(ids)
    })
    handleLibraryRequest('tasks:list', (event) => {
      trusted(event)
      return library!.listTasks()
    })
    handleLibraryRequest('tasks:cancel', (event, id: string) => {
      trusted(event)
      return library!.cancelTask(id)
    })
    handleLibraryRequest('tasks:dismiss', (event, id: string) => {
      trusted(event)
      library!.dismissTask(id)
    })
    handleLibraryRequest('tasks:errors', (event, id: string, offset: number) => {
      trusted(event)
      return library!.taskErrors(id, offset)
    })
    handleLibraryRequest('library:choose', async (event, kind: unknown, recursive: unknown) => {
      trusted(event)
      if ((kind !== 'files' && kind !== 'folder') || typeof recursive !== 'boolean')
        throw new Error('Invalid import source.')
      if (picking) throw new Error('A file picker is already open.')
      if (library!.hasActiveTask())
        throw new Error('Finish or cancel the current library operation first.')
      picking = true
      try {
        const result = await dialog.showOpenDialog(mainWindow!, {
          title: kind === 'folder' ? 'Choose a photo folder' : 'Choose photos',
          properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
          ...(kind === 'files'
            ? {
                filters: [{ name: 'Photographs', extensions: photoExtensions }],
              }
            : {}),
        })
        if (result.canceled || !result.filePaths.length) return null
        return await library!.scan(result.filePaths, recursive)
      } finally {
        picking = false
      }
    })
    handleLibraryRequest('library:devices', async (event) => {
      trusted(event)
      try {
        const devices = await importDevices.list(false)
        await library!.validateDeviceReview((source) => importDevices.validate(source, false))
        return { devices }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
    handleLibraryRequest(
      'library:device',
      async (
        event,
        id: string,
        searchEntireDevice: boolean,
        onlyMissing = true,
        verificationMode = 'camera-fast',
      ) => {
        trusted(event)
        if (
          typeof id !== 'string' ||
          typeof searchEntireDevice !== 'boolean' ||
          typeof onlyMissing !== 'boolean' ||
          !['camera-fast', 'full'].includes(verificationMode)
        )
          throw new Error('Invalid device selection.')
        if (picking) throw new Error('Close the file picker first.')
        const source = await importDevices.resolve(id)
        const paths = await importDevices.photoRoots(source, searchEntireDevice)
        return library!.scan(
          paths,
          true,
          { source, validate: (force = false) => importDevices.validate(source, true, force) },
          onlyMissing,
          verificationMode as import('../shared/contracts').ImportVerificationMode,
        )
      },
    )
    handleLibraryRequest(
      'library:thumbnails',
      (event, id: string, ids: string[] | import('../shared/contracts').ReviewThumbnailRequest) => {
        trusted(event)
        library!.requestReviewThumbnails(id, ids)
      },
    )
    handleLibraryRequest('library:review', (event, id: string, offset: number) => {
      trusted(event)
      return library!.review(id, offset)
    })
    handleLibraryRequest(
      'library:select',
      (event, id: string, ids: string[] | null, selected: boolean) => {
        trusted(event)
        library!.select(id, ids, selected)
      },
    )
    handleLibraryRequest('library:import', (event, id: string) => {
      trusted(event)
      return library!.importSelected(id)
    })
    handleLibraryRequest('library:only-missing', (event, id: string, enabled: boolean) => {
      trusted(event)
      library!.setImportOnlyMissing(id, enabled)
    })
    handleLibraryRequest(
      'library:verification-mode',
      (event, id: string, mode: import('../shared/contracts').ImportVerificationMode) => {
        trusted(event)
        library!.setImportVerificationMode(id, mode)
      },
    )
    handleLibraryRequest('library:cancel', (event, id: string) => {
      trusted(event)
      return library!.cancel(id)
    })
    handleLibraryRequest('library:dispose', (event, id: string) => {
      trusted(event)
      return library!.dispose(id)
    })

    createWindow()
    app.on('activate', () => {
      if (!quitPending && BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error: unknown) => {
    console.error('Could not start Luma:', error)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  if (!quitPending && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || !library) return
  event.preventDefault()
  void requestQuit()
})
