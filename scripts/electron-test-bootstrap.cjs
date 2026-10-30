/* eslint-disable @typescript-eslint/no-require-imports -- Electron loads this explicit startup guard as CommonJS. */
const { app, BrowserWindow, dialog } = require('electron')
const { writeFileSync, renameSync, realpathSync } = require('node:fs')
const { pathToFileURL } = require('node:url')

// Loaded explicitly by the generated test package, before either application entry.
// NODE_OPTIONS hooks are not reliable in Electron and can leave startup unguarded.
exports.install = ({ profile, evidenceFile, mode }) => {
  if (process.type !== 'browser' || !['background', 'foreground'].includes(mode))
    throw new Error('Invalid isolated Electron test entry.')
  if (realpathSync(app.getPath('userData')) !== realpathSync(profile))
    throw new Error('Electron test profile isolation failed before application startup.')
  Object.defineProperty(globalThis, '__irodoriTestUiMode', { value: mode })
  const evidence = { mode, pid: process.pid, profile, windows: [], violations: [] }
  const save = () => {
    writeFileSync(`${evidenceFile}.tmp`, JSON.stringify(evidence, null, 2) + '\n')
    renameSync(`${evidenceFile}.tmp`, evidenceFile)
  }
  const reject = (action) => {
    evidence.violations.push(action)
    save()
    throw new Error(`Background Electron test blocked ${action}. Use an explicit foreground test.`)
  }
  if (mode === 'background') {
    if (process.platform === 'darwin') app.setActivationPolicy('accessory')
    for (const method of [
      'show',
      'showInactive',
      'focus',
      'restore',
      'moveTop',
      'maximize',
      'setFullScreen',
    ])
      BrowserWindow.prototype[method] = function () {
        return reject(`BrowserWindow.${method}`)
      }
    const capture = BrowserWindow.prototype.capturePage
    BrowserWindow.prototype.capturePage = function (rect, options = {}) {
      return capture.call(this, rect, { ...options, stayHidden: true })
    }
    app.focus = () => reject('app.focus')
    for (const method of [
      'showOpenDialog',
      'showOpenDialogSync',
      'showSaveDialog',
      'showSaveDialogSync',
      'showMessageBox',
      'showMessageBoxSync',
      'showErrorBox',
    ])
      dialog[method] = () => reject(`unmocked dialog.${method}`)
  }
  app.on('browser-window-created', (_event, window) => {
    const row = { id: window.id, showEvents: 0, focusEvents: 0, closed: false }
    evidence.windows.push(row)
    const check = (action) => {
      if (mode !== 'background') return
      evidence.violations.push(action)
      save()
      // A native event is a guard failure even if application code catches an error.
      app.exit(86)
    }
    if (mode === 'background') {
      if (process.platform === 'darwin' || process.platform === 'win32') window.setFocusable(false)
      window.webContents.setBackgroundThrottling(false)
    }
    window.on('show', () => {
      row.showEvents++
      check('native show')
      save()
    })
    window.on('focus', () => {
      row.focusEvents++
      check('native focus')
      save()
    })
    window.on('closed', () => {
      row.closed = true
      save()
    })
    save()
  })
  const timer =
    mode === 'background' &&
    setInterval(() => {
      if (
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused())
      ) {
        evidence.violations.push('native window visible or focused')
        save()
        app.exit(86)
      }
    }, 100)
  if (timer) timer.unref()
  app.on('will-quit', () => {
    if (timer) clearInterval(timer)
    save()
  })
  save()
}

exports.start = async ({ entry, ...policy }) => {
  exports.install(policy)
  await import(pathToFileURL(entry).href)
}
