import { mergeFailure } from '../shared/merge'
import { DisplayState } from './display-state'
import { installWaylandDisplayRefresh } from './wayland-display'
import { pathToFileURL } from 'node:url'
import { powerMonitor } from 'electron'
import { startEditorEndpoint } from './editor-endpoint'
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
    quitting = true
    await editorEndpoint?.close()
    await library?.close()
    app.quit()
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
  const window = new BrowserWindow({
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
  window.once('ready-to-show', () => window.show())
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

    ipcMain.handle('app:get-info', (event): AppInfo => {
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
    ipcMain.handle('preview:diagnostics', (event) => {
      trusted(event)
      return {
        ...library!.fullPreviews.getDiagnostics(),
        presentation: displayState.get().presentation,
      }
    })
    ipcMain.handle('preview:presentation', (event, value) => {
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
    ipcMain.handle('display:get', (event) => {
      trusted(event)
      return displayState.get()
    })
    ipcMain.handle('display:preference', (event, preference) => {
      trusted(event)
      return displayState.set(preference)
    })
    ipcMain.handle('display:capabilities', (event, capabilities) => {
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
    ipcMain.handle('merge:active', (event) => {
      trusted(event)
      return mergeReply(() => library!.getActiveMergeReview())
    })
    ipcMain.handle('merge:diagnostics', (event, id, revision) => {
      trusted(event)
      return mergeReply(() => library!.getMergeDiagnostics(id, revision))
    })
    ipcMain.handle('merge:create', (event, ids, mode) => {
      trusted(event)
      return mergeReply(() => library!.createMergeReview(ids, mode))
    })
    ipcMain.handle('merge:update', (event, id, revision, settings) => {
      trusted(event)
      return mergeReply(() => library!.updateMergeReview(id, revision, settings))
    })
    ipcMain.handle('merge:preview', (event, id, revision) => {
      trusted(event)
      return mergeReply(() => library!.requestMergePreview(id, revision))
    })
    ipcMain.handle('merge:start', (event, id, revision) => {
      trusted(event)
      return mergeReply(() => library!.startMerge(id, revision))
    })
    ipcMain.handle('merge:dispose', (event, id) => {
      trusted(event)
      return mergeReply(() => library!.disposeMergeReview(id))
    })
    ipcMain.handle('merge:provenance', (event, id) => {
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
    ipcMain.handle('statistics:get', (event, id: string, revision: number, request) => {
      trusted(event)
      return library!.getPhotoStatistics(id, revision, request).then(
        (statistics) => ({ statistics }),
        (error) => ({ error: String(error) }),
      )
    })
    ipcMain.handle('foreground:activity', (event, value) => {
      trusted(event)
      library!.reportForegroundActivity(value)
    })
    ipcMain.handle('edits:get', (event, id) => {
      trusted(event)
      return library!.getEdits(id)
    })
    ipcMain.handle('pixel:get', (event, id, revision, x, y, request) => {
      trusted(event)
      return library!.getPhotoPixel(id, revision, x, y, request).then(
        (pixel) => ({ pixel }),
        (error) => ({ error: String(error) }),
      )
    })
    ipcMain.handle('edits:update', (event, id, patch, revision) => {
      trusted(event)
      return library!.updateEdits(id, patch, revision)
    })
    ipcMain.handle('edits:history', (event, id) => {
      trusted(event)
      return library!.getEditHistory(id)
    })
    ipcMain.handle('edits:undo', (event, id, revision) => {
      trusted(event)
      return library!.undoEdit(id, revision)
    })
    ipcMain.handle('edits:redo', (event, id, revision) => {
      trusted(event)
      return library!.redoEdit(id, revision)
    })
    ipcMain.handle('lens:get', (event, id) => {
      trusted(event)
      return library!.getLensSettings(id)
    })
    ipcMain.handle('lens:update', (event, id, kind, enabled) => {
      trusted(event)
      return library!.updateLensSettings(id, kind, enabled)
    })
    ipcMain.handle('library:list', (event, offset: number) => {
      trusted(event)
      return library!.list(offset)
    })
    ipcMain.handle('preview:request', (event, id: string, token: string, regenerate = false) => {
      trusted(event)
      // Preview failures are expected UI states, not uncaught IPC exceptions.
      return library!.fullPreviews.request(id, token, regenerate).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    ipcMain.handle('preview:hdr', (event, id, token, regenerate = false) => {
      trusted(event)
      return library!.fullPreviews.requestHdr(id, token, regenerate).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: String(error) }),
      )
    })
    ipcMain.handle('preview:editing', (event, id, token) => {
      trusted(event)
      return library!.fullPreviews.requestEditing(id, token).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: String(error) }),
      )
    })
    ipcMain.handle('preview:cached', (event, id: string, token: string) => {
      trusted(event)
      return library!.fullPreviews.requestCached(id, token).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    ipcMain.handle('preview:release', (event, token: string) => {
      trusted(event)
      if (typeof token !== 'string') throw new Error('Invalid preview request token.')
      return library!.fullPreviews.release(token)
    })
    ipcMain.handle('library:locate', (event, id: string, direction: -1 | 0 | 1) => {
      trusted(event)
      return library!.locate(id, direction)
    })
    ipcMain.handle('stacks:list', (event) => {
      trusted(event)
      return library!.listStacks()
    })
    ipcMain.handle('stacks:photo', (event, id: string) => {
      trusted(event)
      return library!.getPhotoStack(id)
    })
    ipcMain.handle('stacks:members', (event, id: string, offset: number) => {
      trusted(event)
      return library!.getStackMembers(id, offset)
    })
    ipcMain.handle('stacks:snapshot', (event, id: string, revision: number) => {
      trusted(event)
      return library!.getStackSnapshot(id, revision)
    })
    ipcMain.handle('stacks:group', (event, ids: string[], coverId: string, revision: number) => {
      trusted(event)
      return library!.groupPhotos(ids, coverId, revision)
    })
    ipcMain.handle('stacks:ungroup', (event, id: string, revision: number) => {
      trusted(event)
      return library!.ungroupStack(id, revision)
    })
    ipcMain.handle('stacks:remove', (event, id: string, revision: number) => {
      trusted(event)
      return library!.removeFromStack(id, revision)
    })
    ipcMain.handle('stacks:cover', (event, id: string, photoId: string, revision: number) => {
      trusted(event)
      return library!.setStackCover(id, photoId, revision)
    })
    ipcMain.handle('stacks:expand', (event, id: string, expanded: boolean, revision: number) => {
      trusted(event)
      return library!.setStackExpanded(id, expanded, revision)
    })
    ipcMain.handle('stacks:capture-scan', (event) => {
      trusted(event)
      if (picking) throw new Error('Close the file picker first.')
      return library!.groupCaptureSequences()
    })
    ipcMain.handle('gallery:list', (event, offset: number, selectedIds: string[]) => {
      trusted(event)
      return library!.listGallery(offset, selectedIds)
    })
    ipcMain.handle('gallery:locate', (event, id: string, direction: -1 | 0 | 1) => {
      trusted(event)
      return library!.locateGalleryPhoto(id, direction)
    })
    ipcMain.handle('gallery:range', (event, from: string, to: string) => {
      trusted(event)
      return library!.getGalleryRange(from, to)
    })
    ipcMain.handle('library:range', (event, from: string, to: string) => {
      trusted(event)
      return library!.range(from, to)
    })
    ipcMain.handle('library:delete', (event, ids: string[]) => {
      trusted(event)
      if (picking) throw new Error('Close the file picker first.')
      return library!.deletePhotos(ids)
    })
    ipcMain.handle('tasks:list', (event) => {
      trusted(event)
      return library!.listTasks()
    })
    ipcMain.handle('tasks:cancel', (event, id: string) => {
      trusted(event)
      return library!.cancelTask(id)
    })
    ipcMain.handle('tasks:dismiss', (event, id: string) => {
      trusted(event)
      library!.dismissTask(id)
    })
    ipcMain.handle('tasks:errors', (event, id: string, offset: number) => {
      trusted(event)
      return library!.taskErrors(id, offset)
    })
    ipcMain.handle('library:choose', async (event, kind: unknown, recursive: unknown) => {
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
    ipcMain.handle('library:devices', async (event) => {
      trusted(event)
      try {
        const devices = await importDevices.list(false)
        await library!.validateDeviceReview((source) => importDevices.validate(source, false))
        return { devices }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
    ipcMain.handle(
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
    ipcMain.handle('library:thumbnails', (event, id: string, ids: string[]) => {
      trusted(event)
      library!.requestReviewThumbnails(id, ids)
    })
    ipcMain.handle('library:review', (event, id: string, offset: number) => {
      trusted(event)
      return library!.review(id, offset)
    })
    ipcMain.handle(
      'library:select',
      (event, id: string, ids: string[] | null, selected: boolean) => {
        trusted(event)
        library!.select(id, ids, selected)
      },
    )
    ipcMain.handle('library:import', (event, id: string) => {
      trusted(event)
      return library!.importSelected(id)
    })
    ipcMain.handle('library:only-missing', (event, id: string, enabled: boolean) => {
      trusted(event)
      library!.setImportOnlyMissing(id, enabled)
    })
    ipcMain.handle(
      'library:verification-mode',
      (event, id: string, mode: import('../shared/contracts').ImportVerificationMode) => {
        trusted(event)
        library!.setImportVerificationMode(id, mode)
      },
    )
    ipcMain.handle('library:cancel', (event, id: string) => {
      trusted(event)
      return library!.cancel(id)
    })
    ipcMain.handle('library:dispose', (event, id: string) => {
      trusted(event)
      return library!.dispose(id)
    })

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error: unknown) => {
    console.error('Could not start Luma:', error)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || !library) return
  event.preventDefault()
  void requestQuit()
})
