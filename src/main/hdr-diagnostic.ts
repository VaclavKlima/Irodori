import { app, powerMonitor } from 'electron'
import { createAppWindow } from './window-presentation'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Separate entry point: no catalog, photo processing, editor endpoint, or user settings.
if (!app.commandLine.hasSwitch('user-data-dir'))
  throw new Error('Launch the HDR diagnostic with its temporary-profile harness.')
app.setName('Luma HDR diagnostic')
app.enableSandbox()
// Playwright's Electron loader forces sRGB and replaces --enable-features.
// Neither override is valid evidence for an HDR display diagnostic.
app.commandLine.removeSwitch('force-color-profile')
app.commandLine.removeSwitch('enable-features')
const requestedFeatures = process.argv.find((argument) => argument.startsWith('--enable-features='))
if (requestedFeatures)
  app.commandLine.appendSwitch(
    'enable-features',
    requestedFeatures.slice('--enable-features='.length),
  )
app.commandLine.appendSwitch('enable-blink-features', 'ScreenDetailedHdrHeadroom')

void app
  .whenReady()
  .then(async () => {
    const page = join(import.meta.dirname, '../renderer/hdr-diagnostic.html')
    const trustedUrl = pathToFileURL(page).href
    const window = createAppWindow({
      title: 'Luma HDR diagnostic — unverified output',
      width: 1100,
      height: 700,
      minWidth: 1100,
      minHeight: 700,
      useContentSize: true,
      backgroundColor: '#171717',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/hdr-diagnostic.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const allowed = (
      contents: Electron.WebContents | null,
      permission: string,
      details: { isMainFrame: boolean; requestingUrl?: string },
    ): boolean =>
      contents === window.webContents &&
      permission === 'window-management' &&
      details.isMainFrame &&
      details.requestingUrl === trustedUrl &&
      contents.getURL() === trustedUrl
    window.webContents.session.setPermissionRequestHandler(
      (contents, permission, callback, details) => callback(allowed(contents, permission, details)),
    )
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
      allowed(contents, permission, details),
    )
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    powerMonitor.on('resume', () => {
      if (!window.isDestroyed()) window.webContents.send('hdr-diagnostic:resume')
    })
    await window.loadFile(page)
    app.on('window-all-closed', () => app.quit())
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
