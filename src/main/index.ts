import {
  app,
  BrowserWindow,
  dialog,
  clipboard,
  ipcMain,
  Menu,
  powerMonitor,
  protocol,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { APP_TITLE } from '../shared/app-identity'
import { BrowseCatalogChangedError } from '../shared/browse'
import { CollectionChangedError } from '../shared/collections'
import type { AppInfo } from '../shared/contracts'
import { SDR_TARGET } from '../shared/hdr'
import { mergeFailure } from '../shared/merge'
import {
  NATIVE_HDR_MASK_VERSION,
  type NativeHdrMaskOutcome,
  type NativeHdrMaskRequest,
} from '../shared/native-hdr-mask'
import { configureAppIdentity } from './app-identity'
import { configureDesktopIdentity, desktopIcon } from './desktop-identity'
import { DisplayState } from './display-state'
import { connectDevelopmentSupervisor } from './development-lifecycle'
import { startEditorEndpoint } from './editor-endpoint'
import { AgentSessions } from './agent/sessions'
import { AgentRequestGate } from './agent/request-gate'
import type { EditorContextSnapshot } from '../shared/agent'
import { queryImageResources } from './image-resource-query'
import { ImportDevices } from './import-devices'
import { PhotoLibrary } from './library'
import {
  hdrMaskBackend,
  nativeCpuExecutable,
  nativeCpuMaskCapability,
} from './native-cpu-executable'
import { NativeMaskCancelled, NativeMaskController } from './native-mask-controller'
import {
  createPreviewAssetStream,
  PREVIEW_STREAM_CHUNK_BYTES,
  type PreviewAssetStreamLease,
} from './preview-asset-stream'
import { PreviewProcess } from './preview-process'
import { photoExtensions } from './processing/formats'
import { ResourceService } from './resource-service'
import { closeServices, editorAvailable, flushRenderer, ShutdownCoordinator } from './shutdown'
import { installWaylandDisplayRefresh } from './wayland-display'
import { createAppWindow, showAppWindow } from './window-presentation'

const importDevices = new ImportDevices()

configureAppIdentity(app)
configureDesktopIdentity()
app.enableSandbox()
app.commandLine.appendSwitch('enable-blink-features', 'ScreenDetailedHdrHeadroom')
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'wayland')
  const features = app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean)
  app.commandLine.appendSwitch('enable-features', [...new Set([...features, 'Vulkan'])].join(','))
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
}
if (process.env.IRODORI_HDR_TEST === '1') app.commandLine.removeSwitch('force-color-profile')
let displayState: DisplayState

let mainWindow: BrowserWindow | null = null
let library: PhotoLibrary | undefined
let resourceService: ResourceService | undefined
let nativeCpu: NativeMaskController | undefined
let agentSessions: AgentSessions | undefined
let editorEndpoint: Awaited<ReturnType<typeof startEditorEndpoint>> | undefined
let quitting = false
let picking = false
let quitPending = false
let developmentSupervisor: ReturnType<typeof connectDevelopmentSupervisor>
let startupComplete!: () => void
const startupReady = new Promise<void>((resolve) => {
  startupComplete = resolve
})
let closingRenderer: Electron.WebContents | undefined

async function cropAdmission(
  signal: AbortSignal,
): Promise<import('../shared/crop-resources').CropAdmission> {
  signal.throwIfAborted()
  const contents = mainWindow?.webContents
  if (!contents || contents.isDestroyed())
    throw new Error('The editor resource inventory is unavailable.')
  const lifetime = new AbortController(),
    active = AbortSignal.any([signal, lifetime.signal])
  try {
    const [policy, reservation] = await Promise.all([
      resourceService!.getPolicy(null),
      queryImageResources(
        {
          send: (token) => contents.send('resources:image-query', token),
          subscribe: (reply) => {
            const handler = (
              event: Electron.IpcMainEvent,
              token: string,
              bytes: unknown,
              error?: string,
            ) => {
              if (
                event.sender !== contents ||
                contents.isDestroyed() ||
                event.senderFrame !== contents.mainFrame
              )
                return
              reply(token, bytes, error)
            }
            const gone = () => lifetime.abort(new Error('The editor resource owner closed.'))
            ipcMain.on('resources:image-reply', handler)
            contents.once('destroyed', gone)
            contents.once('render-process-gone', gone)
            return () => {
              ipcMain.removeListener('resources:image-reply', handler)
              contents.removeListener('destroyed', gone)
              contents.removeListener('render-process-gone', gone)
            }
          },
        },
        active,
      ),
    ])
    active.throwIfAborted()
    return {
      policy,
      reservation: {
        ...reservation,
        ramBytes:
          reservation.ramBytes +
          (library?.agentPreviews?.bytes ?? 0) +
          (library?.outputProofs?.bytes ?? 0),
      },
    }
  } finally {
    lifetime.abort()
  }
}

async function flushEditorEdits(scope: import('../shared/edits').EditFlushScope) {
  const result = await flushRenderer(mainWindow?.webContents, ipcMain, 'edits', scope)
  if (result.status !== 'saved') throw new Error(result.reason)
}

async function captureAgentContext(): Promise<EditorContextSnapshot> {
  if (quitPending)
    throw new Error('Finish closing the application before submitting another request.')
  const contents = mainWindow?.webContents
  if (!contents || contents.isDestroyed()) throw new Error('The editor context is unavailable.')
  const snapshot = await new Promise<EditorContextSnapshot>((resolve, reject) => {
    const token = randomUUID()
    const clean = () => {
      clearTimeout(timer)
      ipcMain.removeListener('agent:context-reply', reply)
    }
    const reply = (
      event: Electron.IpcMainEvent,
      returned: string,
      value: EditorContextSnapshot,
      error?: string,
    ) => {
      if (
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        returned !== token
      )
        return
      clean()
      if (error) reject(new Error(error))
      else if (
        !value ||
        !['editor', 'library'].includes(value.workspace) ||
        (value.activePhotoId !== null && !/^[a-f0-9]{64}$/.test(value.activePhotoId)) ||
        !Array.isArray(value.selectedIds) ||
        value.selectedIds.length > 100000 ||
        value.selectedIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
        typeof value.transient?.crop !== 'boolean'
      )
        reject(new Error('Invalid editor context.'))
      else resolve(value)
    }
    const timer = setTimeout(() => {
      clean()
      reject(new Error('The editor context did not respond. Submit again.'))
    }, 10000)
    ipcMain.on('agent:context-reply', reply)
    contents.send('agent:context-query', token)
  })
  if (snapshot.transient.crop)
    throw new Error('Apply or cancel the crop, then submit the request again.')
  await flushEditorEdits({ kind: 'all' })
  if (snapshot.inspection) {
    const pending = snapshot.inspection
    if (pending.region?.units !== 'pixels' || pending.region.gridIdentity !== pending.gridIdentity)
      throw new Error('Invalid inspection region context. Select the region again.')
    if (snapshot.workspace !== 'editor' || pending.photoId !== snapshot.activePhotoId)
      throw new Error(
        'The inspection region no longer belongs to the active photograph. Select it again.',
      )
    const revision = (await library!.getEdits(pending.photoId)).revision
    const context = await library!.agentPreviews.context(pending.photoId, revision)
    const { resolveInspectionRegion } = await import('../shared/inspection')
    resolveInspectionRegion(pending.region, context)
    if (pending.gridIdentity !== context.gridIdentity)
      throw new Error('The inspection region is stale. Select it again before submitting.')
  }
  return {
    ...snapshot,
    selectedIds: [...new Set(snapshot.selectedIds)],
    transient: { ...snapshot.transient, saving: false },
  }
}

function handleLibraryRequest(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  ipcMain.handle(channel, (event, ...args) => {
    // A destroyed renderer can still have invokes in Electron's queue. Shutdown
    // admission is already sealed; do not enter closed application services.
    if (event.sender === closingRenderer) return
    return listener(event, ...args)
  })
}

const shutdown = new ShutdownCoordinator({
  pauseAdmission(paused) {
    quitPending = paused
    library?.pauseTaskAdmission(paused)
  },
  async confirmTasks() {
    if (!library?.hasActiveTask()) return true
    const result = await showShutdownDialog({
      type: 'question',
      title: 'A library task is still running',
      message: 'Keep working on your photos?',
      detail:
        'Cancellation stops remaining work after the current operation finishes. Completed imports, exported files and moves to Trash are kept.',
      buttons: ['Keep open', 'Cancel task and quit'],
      defaultId: 0,
      cancelId: 0,
    })
    return result.response === 1
  },
  flushEdits: () => flushRenderer(mainWindow?.webContents, ipcMain, 'edits', { kind: 'all' }),
  async recover(result, reason) {
    const retry = editorAvailable(mainWindow?.webContents)
    const buttons = retry
      ? ['Keep open', 'Retry saving', 'Quit anyway']
      : ['Keep open', 'Quit anyway']
    const response = await showShutdownDialog({
      type: 'warning',
      title:
        result.status === 'saved'
          ? 'Development has ended'
          : result.status === 'error'
            ? 'Could not finish saving'
            : 'Saving could not be confirmed',
      message:
        result.status === 'saved'
          ? 'Keep this window open?'
          : result.status === 'error'
            ? 'The editor reported a save error.'
            : 'The latest changes may not have been saved.',
      detail: `${result.status === 'saved' ? 'The latest edits were saved.' : result.reason + '\n\nQuit anyway may lose unconfirmed recent changes.'} Committed library history and originals are preserved.${reason === 'development-lost' ? '\n\nDevelopment has ended. Keep open retains this window, but reloading may be unavailable.' : ''}`,
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    const choice = buttons[response.response]
    return choice === 'Quit anyway' ? 'quit' : choice === 'Retry saving' ? 'retry' : 'keep'
  },
  sealAdmission() {
    library?.stopAdmission()
  },
  async flushWorkspace() {
    // This is a best-effort checkpoint; a missing document retains its last durable state.
    const result = await flushRenderer(mainWindow?.webContents, ipcMain, 'workspace')
    if (result.status !== 'saved') console.warn('Workspace checkpoint retained:', result.reason)
  },
  async cleanup() {
    await closeServices([
      () => agentSessions?.close(),
      () => editorEndpoint?.close(),
      () => library?.drainAcceptedWork(),
      () => {
        if (mainWindow) {
          closingRenderer = mainWindow.webContents
          mainWindow.destroy()
        }
      },
      () => library?.close(),
      () => resourceService?.drain(),
    ])
  },
  report: (error) => console.error('Could not finish shutting down Irodori:', error),
  exit(code) {
    developmentSupervisor?.closing(code)
    quitting = true
    if (code) app.exit(code)
    else app.quit()
  },
})

function showShutdownDialog(options: Electron.MessageBoxOptions) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options)
}

function requestQuit(reason: import('./shutdown').ShutdownReason = 'quit') {
  const request = () => shutdown.request(reason)
  if (reason === 'development-lost') return (developmentRecovery ??= startupReady.then(request))
  return startupReady.then(request)
}
let developmentRecovery: Promise<import('./shutdown').ShutdownOutcome> | undefined

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'irodori-photo',
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
    icon: desktopIcon,
    title: APP_TITLE,
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 1100,
    minHeight: 700,
    useContentSize: true,
    show: false,
    backgroundColor: '#161616',
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
    void library?.outputProofs?.disposeOwner('dialog').catch(() => undefined)
    void nativeCpu?.reset().catch((error: unknown) => console.warn('CPU preview cleanup:', error))
    library?.releaseForegroundActivities()
    void library?.fullPreviews.release().catch(() => undefined)
  }
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) releasePreview()
  })
  window.webContents.on('render-process-gone', releasePreview)
  window.webContents.on('destroyed', releasePreview)
  window.on('blur', () => {
    library?.releaseForegroundActivities()
    if (!window.webContents.isDestroyed()) window.webContents.send('window:blur')
  })

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
      void requestQuit('close')
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
    console.error('Could not load the Irodori interface:', error)
    if (!app.isPackaged && devUrl) void requestQuit('development-lost')
    else app.exit(1)
  })
}

app
  .whenReady()
  .then(async () => {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
      developmentSupervisor = connectDevelopmentSupervisor(requestQuit)
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { role: 'windowMenu' },
          ])
        : null,
    )

    resourceService = new ResourceService(app.getPath('userData'))
    await resourceService.open()

    handleLibraryRequest('resources:get-settings', (event) => {
      trusted(event)
      return resourceService!.getSettings()
    })
    handleLibraryRequest('resources:set-settings', (event, value: unknown) => {
      trusted(event)
      return resourceService!.saveSettings(value)
    })
    handleLibraryRequest('resources:get-policy', (event, adapter: unknown) => {
      trusted(event)
      return resourceService!.getPolicy(adapter)
    })

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
    handleLibraryRequest('export:capabilities', (event) => {
      trusted(event)
      return library!.getExportCapabilities()
    })
    handleLibraryRequest('export:preferences', (event) => {
      trusted(event)
      return library!.getExportPreferences()
    })
    handleLibraryRequest('export:prepare', (event, ids: string[]) => {
      trusted(event)
      return library!.prepareExport(ids)
    })
    handleLibraryRequest('export:dispose', (event, id: string) => {
      trusted(event)
      library!.exports.dispose(id)
    })
    handleLibraryRequest('export:proof', (event, request) => {
      trusted(event)
      return library!.requestOutputProof(request)
    })
    handleLibraryRequest('export:proof-cancel', (event, token: string) => {
      trusted(event)
      library!.outputProofs.cancel('dialog', token)
    })
    handleLibraryRequest('export:proof-release', (event, id: string) => {
      trusted(event)
      return library!.outputProofs.release('dialog', id)
    })
    handleLibraryRequest(
      'export:start',
      (event, request: import('../shared/export').ExportStart) => {
        trusted(event)
        return library!.startExport(request)
      },
    )
    handleLibraryRequest('export:results', (event, id: string, offset: number) => {
      trusted(event)
      return library!.exports.results(id, offset)
    })
    handleLibraryRequest('export:show-folder', async (event, id: string) => {
      trusted(event)
      const error = await shell.openPath(await library!.exports.destination(id))
      if (error) throw new Error(error)
    })
    handleLibraryRequest('export:choose-destination', async (event) => {
      trusted(event)
      if (picking) throw new Error('A folder picker is already open.')
      picking = true
      try {
        const result = await dialog.showOpenDialog(mainWindow!, {
          title: 'Choose export folder',
          properties: ['openDirectory', 'createDirectory'],
        })
        if (result.canceled || !result.filePaths[0]) return null
        return library!.exports.store.authorize(result.filePaths[0])
      } finally {
        picking = false
      }
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
    handleLibraryRequest('display:refresh-probe', (event) => {
      trusted(event)
      return displayState.retry()
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
    library.fullPreviews.installFirstSurface({
      policy: () => resourceService!.getPolicy(null),
      publish: (offer) => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed())
          throw new Error('The first HDR surface renderer is unavailable.')
        mainWindow.webContents.send('preview:first-surface', offer)
      },
    })
    library.fullPreviews.installCropAdmission(cropAdmission)
    library.fullPreviews.installDetailAdmission(cropAdmission)
    library.cropAdmission = cropAdmission
    library.displayTarget = () => displayState.get()
    library.flushEditorEdits = flushEditorEdits
    await library.open()
    if (process.platform === 'linux' && process.arch === 'x64')
      void library.fullPreviews.prewarmHdr('linear64')
    const maskCapability =
      hdrMaskBackend() === 'native' ? await nativeCpuMaskCapability() : undefined
    nativeCpu = new NativeMaskController({
      root: join(app.getPath('userData'), 'library/cache/cpu-presentations'),
      executable: () => nativeCpuExecutable(),
      foreground: (work, signal) => library!.fullPreviews.runCpuForeground(work, signal),
      mask: maskCapability
        ? {
            arithmeticSha256: maskCapability.arithmeticSha256,
            acquireSource: (request, signal) =>
              library!.fullPreviews.acquireCpuMaskWorkingSource(request, signal),
            checkTarget: (request) => {
              const current = displayState.get()
              const expected = request.domain === 'working-hdr' ? SDR_TARGET : current
              for (const key of [
                'generation',
                'requested',
                'mode',
                'colorSpace',
                'peak',
                'headroom',
                'outputVersion',
              ] as const)
                if (request.target[key] !== expected[key])
                  throw new Error('Native mask display target changed.')
            },
          }
        : undefined,
    })
    await nativeCpu.open()
    library.fullPreviews.installCpuController(nativeCpu)
    handleLibraryRequest('preview:hdr-mask-backend', (event) => {
      trusted(event)
      return hdrMaskBackend()
    })
    handleLibraryRequest(
      'preview:hdr-mask-render',
      async (event, request: NativeHdrMaskRequest): Promise<NativeHdrMaskOutcome> => {
        trusted(event)
        try {
          return await nativeCpu!.renderMask(request)
        } catch (error) {
          if (!(error instanceof NativeMaskCancelled)) throw error
          return {
            kind: 'cancelled',
            version: NATIVE_HDR_MASK_VERSION,
            requestId: request.requestId,
            sessionId: request.sessionId,
            generation: request.generation,
          }
        }
      },
    )
    handleLibraryRequest('preview:hdr-mask-cancel', (event, sessionId, requestId) => {
      trusted(event)
      return nativeCpu!.cancelMask(sessionId, requestId)
    })
    handleLibraryRequest('preview:hdr-mask-release', (event, sessionId, maskId) => {
      trusted(event)
      return nativeCpu!.releaseMask(sessionId, maskId)
    })
    const development = !!process.env.ELECTRON_RENDERER_URL
    editorEndpoint = await startEditorEndpoint(app.getPath('userData'), library, displayState, {
      capture: captureAgentContext,
      development,
      agentGate: (token) => agentSessions?.authenticate(token),
    })
    agentSessions = new AgentSessions({
      profile: app.getPath('userData'),
      development,
      runtimeDirectory: import.meta.dirname,
      connection: (token) => editorEndpoint!.agentConnection(token),
      gate: (onConversation) =>
        new AgentRequestGate(
          captureAgentContext,
          async (id) => (await library!.getEdits(id)).revision,
          development,
          onConversation,
        ),
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('agent:state-changed', state)
      },
      onOutput: (output) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('agent:output', output)
      },
    })
    await agentSessions.open()
    handleLibraryRequest('agent:state', (event) => {
      trusted(event)
      return agentSessions!.get()
    })
    handleLibraryRequest('agent:connect', (event, choice) => {
      trusted(event)
      if (quitPending) throw new Error('Finish closing the application before connecting Codex.')
      return agentSessions!.connect(choice)
    })
    handleLibraryRequest('agent:input', (event, id, data) => {
      trusted(event)
      if (quitPending)
        throw new Error('Finish closing the application before submitting another request.')
      agentSessions!.input(id, data)
    })
    handleLibraryRequest('agent:paste', async (event, id, bracketed) => {
      trusted(event)
      if (quitPending)
        throw new Error('Finish closing the application before submitting another request.')
      agentSessions!.paste(id, await clipboard.readText(), bracketed)
    })
    handleLibraryRequest('agent:copy-selection', async (event, id, text) => {
      trusted(event)
      try {
        await clipboard.writeText(agentSessions!.selectionText(id, text))
        return {}
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('agent:sign-in-link', async (event, id, url) => {
      trusted(event)
      await shell.openExternal(agentSessions!.signInLink(id, url))
    })
    handleLibraryRequest('agent:open-sign-in', async (event, id) => {
      trusted(event)
      await shell.openExternal(agentSessions!.signInLink(id))
    })
    handleLibraryRequest('agent:copy-sign-in', async (event, id) => {
      trusted(event)
      await clipboard.writeText(agentSessions!.signInLink(id))
    })
    handleLibraryRequest('agent:resize', (event, id, columns, rows) => {
      trusted(event)
      agentSessions!.resize(id, columns, rows)
    })
    handleLibraryRequest('agent:interrupt', (event, id) => {
      trusted(event)
      agentSessions!.interrupt(id)
    })
    handleLibraryRequest('agent:ack', (event, id, sequence) => {
      trusted(event)
      agentSessions!.acknowledge(id, sequence)
    })
    handleLibraryRequest('agent:choose-executable', async (event) => {
      trusted(event)
      if (picking) throw new Error('A file picker is already open.')
      picking = true
      try {
        const result = await dialog.showOpenDialog(mainWindow!, {
          title: 'Choose Codex executable',
          properties: ['openFile'],
        })
        if (result.canceled || !result.filePaths[0]) return false
        await agentSessions!.selectExecutable(result.filePaths[0])
        return true
      } finally {
        picking = false
      }
    })
    protocol.handle('irodori-photo', async (request) => {
      if (request.method !== 'GET') return new Response(null, { status: 404 })
      const asset: PreviewAssetStreamLease | undefined =
        library?.outputProofs?.acquire(new URL(request.url)) ??
        nativeCpu?.acquireMask(new URL(request.url)) ??
        library?.fullPreviews.acquire(new URL(request.url))
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
        const highWaterMark = PREVIEW_STREAM_CHUNK_BYTES
        const stream = createPreviewAssetStream(asset, start, end, request.signal)
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
    handleLibraryRequest('edits:clipboard', (event) => {
      trusted(event)
      return library!.getEditClipboard()
    })
    handleLibraryRequest('presets:list', async (event, query) => {
      trusted(event)
      try {
        return { result: library!.listPresets(query) }
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('presets:get', async (event, id) => {
      trusted(event)
      try {
        return { result: library!.getPreset(id) }
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('presets:create', async (event, request) => {
      trusted(event)
      try {
        return { result: await library!.createPreset(request) }
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('presets:update', async (event, request) => {
      trusted(event)
      try {
        return { result: await library!.updatePreset(request) }
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('presets:delete', async (event, request) => {
      trusted(event)
      try {
        return { result: await library!.deletePreset(request) }
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('presets:prepare', async (event, request) => {
      trusted(event)
      try {
        return { result: await library!.preparePresetApplication(request) }
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('presets:start', async (event, id) => {
      trusted(event)
      try {
        return { result: await library!.startPresetApplication(id) }
      } catch (error) {
        return { error: String(error) }
      }
    })
    handleLibraryRequest('presets:dispose', (event, id) => {
      trusted(event)
      library!.editTransfers.dispose(id)
    })
    handleLibraryRequest('edits:copy', (event, id) => {
      trusted(event)
      return library!.copyEdits(id).then(
        (result) => ({ result }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('edits:paste-prepare', (event, request) => {
      trusted(event)
      return library!.preparePasteEdits(request).then(
        (result) => ({ result }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('edits:paste-dispose', (event, id) => {
      trusted(event)
      return library!.editTransfers.dispose(id)
    })
    handleLibraryRequest('edits:paste-start', (event, id) => {
      trusted(event)
      return library!.startPasteEdits(id).then(
        (result) => ({ result }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('edits:paste-results', (event, id, offset) => {
      trusted(event)
      return library!.editTransfers.store.results(id, offset)
    })
    handleLibraryRequest('edits:get', (event, id) => {
      trusted(event)
      return library!.getEdits(id)
    })
    handleLibraryRequest('edits:capabilities', (event) => {
      trusted(event)
      return library!.getEditCapabilities()
    })
    handleLibraryRequest('agent:guidance', (event, request) => {
      trusted(event)
      return library!.getEditingGuidance(request)
    })
    handleLibraryRequest('agent:presentation', (event, request) => {
      trusted(event)
      return library!.getPhotoPresentationContext(request).then(
        (result) => ({ result }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('masks:preview', (event, request) => {
      trusted(event)
      return library!.getMaskPreview(request).then(
        (result) => ({ result }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('white-balance:propose', (event, id, revision, sample) => {
      trusted(event)
      return library!.proposeWhiteBalance(id, revision, sample).then(
        (proposal) => ({ proposal }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('curves:sample', (event, id, revision, sample) => {
      trusted(event)
      return library!.sampleCurveTone(id, revision, sample).then(
        (sample) => ({ sample }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('pixel:get', (event, id, revision, x, y, request) => {
      trusted(event)
      return library!.getPhotoPixel(id, revision, x, y, request).then(
        (pixel) => ({ pixel }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('selection:context', (event, id, revision) => {
      trusted(event)
      return library!.getObjectSelectionContext(id, revision)
    })
    handleLibraryRequest('selection:create', (event, request) => {
      trusted(event)
      return library!.createObjectSelection(request)
    })
    handleLibraryRequest('selection:accept', (event, request) => {
      trusted(event)
      return library!.acceptObjectSelection(request)
    })
    handleLibraryRequest('selection:cancel', (event, id) => {
      trusted(event)
      return library!.cancelObjectSelection(id)
    })
    handleLibraryRequest('masks:context', (event, id, revision) => {
      trusted(event)
      return library!.getMaskContext(id, revision)
    })
    handleLibraryRequest('masks:range-sample', (event, request) => {
      trusted(event)
      return library!.sampleMaskRange(request).then(
        (result) => ({ result }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('masks:coverage', (event, request) => {
      trusted(event)
      return library!.prepareMaskCoverage(request).then(
        (result) => ({ result }),
        (error) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('masks:coverage-cancel', (event, id, requestId) => {
      trusted(event)
      return library!.cancelMaskCoverage(id, requestId)
    })
    handleLibraryRequest('masks:mutate', (event, id, revision, mutation) => {
      trusted(event)
      return library!.mutateMasks(id, revision, mutation)
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
    handleLibraryRequest(
      'preview:hdr',
      (event, id, token, regenerate = false, mode = 'hdr', firstSurface, rendererReservation) => {
        trusted(event)
        return library!.fullPreviews
          .requestHdr(id, token, regenerate, mode, firstSurface, rendererReservation)
          .then(
            (preview) => ({ preview }),
            (error: unknown) => ({ error: String(error) }),
          )
      },
    )
    handleLibraryRequest('preview:first-surface-release', (event, requestId, surfaceId) => {
      trusted(event)
      return library!.fullPreviews.releaseFirstSurface(requestId, surfaceId)
    })
    handleLibraryRequest('preview:context', (event, id, revision) => {
      trusted(event)
      return library!.agentPreviews.context(id, revision).then(
        (context) => ({ context }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    handleLibraryRequest('crop:context', (event, id, revision) => {
      trusted(event)
      return library!.getCropContext(id, revision).then(
        (context) => ({ context }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    handleLibraryRequest('preview:editing', (event, id, token, parentRequestId) => {
      trusted(event)
      if (
        typeof parentRequestId !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(parentRequestId)
      )
        throw new Error('Invalid editing preview parent request token.')
      return library!.fullPreviews.requestEditing(id, token, parentRequestId).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: String(error) }),
      )
    })
    handleLibraryRequest('preview:comparison', (event, after, token, revision) => {
      trusted(event)
      return library!.fullPreviews.requestComparison(after, token, revision).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      )
    })
    handleLibraryRequest('preview:crop-source', (event, id, token, revision) => {
      trusted(event)
      return library!.fullPreviews.requestCropSource(id, token, revision).then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
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
      return library!.dismissTask(id)
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
      if (library!.hasActiveTask(false))
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
    startupComplete()
    app.on('activate', () => {
      if (!quitPending && BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error: unknown) => {
    console.error('Could not start Irodori:', error)
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
