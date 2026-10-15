import { expect, test } from '@playwright/test'
import type { BrowserWindowConstructorOptions } from 'electron'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createContext, Script } from 'node:vm'
import ts from 'typescript'
import { closeServices } from '../src/main/shutdown'

const bootstrapSource = readFileSync(
  new URL('../scripts/electron-test-bootstrap.cjs', import.meta.url),
  'utf8',
)
const presentationSource = ts.transpileModule(
  readFileSync(new URL('../src/main/window-presentation.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

interface Policy {
  profile: string
  evidenceFile: string
  mode: string
}

interface Bootstrap {
  install(policy: Policy): void
  start(policy: Policy & { entry: string }): Promise<void>
}

interface Evidence {
  mode: string
  pid: number
  profile: string
  windows: { id: number; showEvents: number; focusEvents: number; closed: boolean }[]
  violations: string[]
}

function bootstrapHarness(
  options: {
    processType?: string
    platform?: string
    unsupportedFocusApi?: boolean
    wrongProfile?: boolean
    missingProfile?: boolean
  } = {},
) {
  const policy = {
    profile: '/requested-profile',
    evidenceFile: '/test-evidence.json',
    mode: 'background',
  }
  const files = new Map<string, string>()
  const calls: string[] = []
  const entries: string[] = []
  const exits: number[] = []
  const activation: string[] = []
  const captures: { rect: unknown; options: Record<string, unknown> | undefined }[] = []
  const timers: { callback: () => void; unrefed: boolean; cleared: boolean; unref(): void }[] = []
  const capturedImage = { pixels: 'retained capture' }
  const app = Object.assign(new EventEmitter(), {
    getPath: () => '/actual-profile',
    setActivationPolicy: (value: string) => activation.push(value),
    focus: () => calls.push('app.focus'),
    exit: (code: number) => exits.push(code),
  })
  const windows: WindowStub[] = []
  class WindowStub extends EventEmitter {
    id = windows.length + 1
    visible = false
    focused = false
    focusable = true
    backgroundThrottling = true
    webContents = {
      setBackgroundThrottling: (value: boolean) => {
        this.backgroundThrottling = value
      },
    }
    constructor() {
      super()
      windows.push(this)
      app.emit('browser-window-created', {}, this)
    }
    static getAllWindows() {
      return windows
    }
    setFocusable(value: boolean) {
      if (options.unsupportedFocusApi) throw new Error('setFocusable is unavailable on this host')
      this.focusable = value
    }
    isVisible() {
      return this.visible
    }
    isFocused() {
      return this.focused
    }
    show() {
      calls.push('window.show')
      this.visible = true
      this.emit('show')
    }
    focus() {
      calls.push('window.focus')
      this.focused = true
      this.emit('focus')
    }
    showInactive() {
      calls.push('window.showInactive')
    }
    restore() {
      calls.push('window.restore')
    }
    moveTop() {
      calls.push('window.moveTop')
    }
    maximize() {
      calls.push('window.maximize')
    }
    setFullScreen() {
      calls.push('window.setFullScreen')
    }
    capturePage(rect?: unknown, options?: Record<string, unknown>) {
      captures.push({ rect, options })
      return Promise.resolve(capturedImage)
    }
  }
  const dialog = Object.fromEntries(
    [
      'showOpenDialog',
      'showOpenDialogSync',
      'showSaveDialog',
      'showSaveDialogSync',
      'showMessageBox',
      'showMessageBoxSync',
      'showErrorBox',
    ].map((method) => [method, () => calls.push(`dialog.${method}`)]),
  ) as Record<string, (...args: unknown[]) => unknown>
  const bootstrap = {} as Bootstrap
  const context = createContext({
    exports: bootstrap,
    process: {
      type: options.processType ?? 'browser',
      platform: options.platform ?? 'darwin',
      pid: 1234,
    },
    require: (name: string) => {
      if (name === 'electron') return { app, BrowserWindow: WindowStub, dialog }
      if (name === 'node:fs')
        return {
          realpathSync: (path: string) => {
            if (path === policy.profile && options.missingProfile)
              throw new Error('ENOENT: isolated profile does not exist')
            return path === '/actual-profile' && options.wrongProfile
              ? '/a-user-library'
              : '/canonical-isolated-profile'
          },
          writeFileSync: (path: string, contents: string) => files.set(path, contents),
          renameSync: (from: string, to: string) => {
            files.set(to, files.get(from)!)
            files.delete(from)
          },
        }
      if (name === 'node:url')
        return {
          pathToFileURL: (entry: string) => {
            entries.push(entry)
            return pathToFileURL(entry)
          },
        }
      throw new Error(`Unexpected bootstrap dependency: ${name}`)
    },
    setInterval: (callback: () => void) => {
      const timer = {
        callback,
        unrefed: false,
        cleared: false,
        unref() {
          this.unrefed = true
        },
      }
      timers.push(timer)
      return timer
    },
    clearInterval: (timer: (typeof timers)[number]) => {
      timer.cleared = true
    },
  })
  new Script(bootstrapSource, { filename: 'electron-test-bootstrap.cjs' }).runInContext(context)
  return {
    policy,
    bootstrap,
    context,
    app,
    WindowStub,
    dialog,
    files,
    calls,
    entries,
    exits,
    activation,
    captures,
    timers,
    capturedImage,
    evidence: () => JSON.parse(files.get(policy.evidenceFile)!) as Evidence,
  }
}

for (const invalid of [
  {
    name: 'an invalid mode',
    harness: {},
    mode: 'hidden',
    error: 'Invalid isolated Electron test entry',
  },
  {
    name: 'a renderer process',
    harness: { processType: 'renderer' },
    error: 'Invalid isolated Electron test entry',
  },
  {
    name: 'a different user profile',
    harness: { wrongProfile: true },
    error: 'profile isolation failed',
  },
  { name: 'a missing isolated profile', harness: { missingProfile: true }, error: 'ENOENT' },
]) {
  test(`bootstrap rejects ${invalid.name} before importing the application or installing guards`, async () => {
    const h = bootstrapHarness(invalid.harness)
    const originalShow = h.WindowStub.prototype.show
    await expect(
      Promise.resolve(
        h.bootstrap.start({
          ...h.policy,
          mode: invalid.mode ?? 'background',
          entry: '/application.js',
        }),
      ),
    ).rejects.toThrow(invalid.error)
    expect(h.entries).toEqual([])
    expect(h.WindowStub.prototype.show).toBe(originalShow)
    expect(h.context.__lumaTestUiMode).toBeUndefined()
    expect([...h.files]).toEqual([])
    expect(h.app.listenerCount('browser-window-created')).toBe(0)
    expect(h.activation).toEqual([])
    expect(h.timers).toEqual([])
  })
}

test('background startup guards window activation and unmocked dialogs before native calls escape', () => {
  const h = bootstrapHarness()
  h.bootstrap.install(h.policy)
  const window = new h.WindowStub()
  const blocked = []
  for (const method of [
    'show',
    'showInactive',
    'focus',
    'restore',
    'moveTop',
    'maximize',
    'setFullScreen',
  ] as const) {
    blocked.push(`BrowserWindow.${method}`)
    expect(() => window[method]()).toThrow(`blocked BrowserWindow.${method}`)
  }
  expect(() => h.app.focus()).toThrow('blocked app.focus')
  blocked.push('app.focus')
  for (const method of Object.keys(h.dialog)) {
    blocked.push(`unmocked dialog.${method}`)
    expect(() => h.dialog[method]()).toThrow(`blocked unmocked dialog.${method}`)
  }
  expect(h.calls).toEqual([])
  expect(h.evidence()).toMatchObject({
    mode: 'background',
    pid: 1234,
    profile: h.policy.profile,
    violations: blocked,
    windows: [{ id: window.id, showEvents: 0, focusEvents: 0, closed: false }],
  })
  expect([...h.files.keys()]).toEqual([h.policy.evidenceFile])
  expect(window.focusable).toBe(false)
  expect(window.backgroundThrottling).toBe(false)
  expect(h.activation).toEqual(['accessory'])
})

test('background capture retains its result and caller options while forcing stayHidden', async () => {
  const h = bootstrapHarness({ platform: 'linux' })
  h.bootstrap.install(h.policy)
  const window = new h.WindowStub()
  const rect = { x: 10, y: 20, width: 100, height: 80 }
  const options = { stayHidden: false, stayAwake: true }
  expect(await window.capturePage(rect, options)).toBe(h.capturedImage)
  expect(await window.capturePage()).toBe(h.capturedImage)
  expect(h.captures).toEqual([
    { rect, options: { stayHidden: true, stayAwake: true } },
    { rect: undefined, options: { stayHidden: true } },
  ])
  expect(options).toEqual({ stayHidden: false, stayAwake: true })
  expect(h.activation).toEqual([])
  expect(h.calls).toEqual([])
  expect(h.evidence().violations).toEqual([])
})

test('Linux background startup avoids unavailable native focusability APIs and keeps rendering active', () => {
  const h = bootstrapHarness({ platform: 'linux', unsupportedFocusApi: true })
  h.bootstrap.install(h.policy)
  const window = new h.WindowStub()
  expect(window.backgroundThrottling).toBe(false)
  expect(h.activation).toEqual([])
  expect(h.exits).toEqual([])
  expect(h.evidence()).toMatchObject({
    violations: [],
    windows: [{ id: window.id, showEvents: 0, focusEvents: 0, closed: false }],
  })
})

test('unexpected native show and focus events leave durable evidence and force failure', () => {
  const h = bootstrapHarness()
  h.bootstrap.install(h.policy)
  const window = new h.WindowStub()
  for (const event of ['show', 'focus']) window.emit(event)
  expect(h.exits).toEqual([86, 86])
  expect(h.evidence()).toMatchObject({
    violations: ['native show', 'native focus'],
    windows: [{ id: window.id, showEvents: 1, focusEvents: 1, closed: false }],
  })
  window.emit('closed')
  h.app.emit('will-quit')
  expect(h.evidence().windows[0].closed).toBe(true)
  expect(h.timers).toHaveLength(1)
  expect(h.timers[0]).toMatchObject({ unrefed: true, cleared: true })
})

test('the background guard detects visible or focused secondary windows without native events', () => {
  for (const state of ['visible', 'focused'] as const) {
    const h = bootstrapHarness()
    h.bootstrap.install(h.policy)
    new h.WindowStub()
    const secondary = new h.WindowStub()
    h.timers[0].callback()
    expect(h.exits).toEqual([])
    secondary[state] = true
    h.timers[0].callback()
    expect(h.exits).toEqual([86])
    expect(h.evidence().windows).toHaveLength(2)
    expect(h.evidence().violations).toEqual(['native window visible or focused'])
  }
})

test('explicit fixture dialog responses remain usable without allowing a native dialog', async () => {
  const h = bootstrapHarness()
  h.bootstrap.install(h.policy)
  const response = { response: 1, checkboxChecked: false }
  h.dialog.showMessageBox = async () => response
  expect(await h.dialog.showMessageBox()).toBe(response)
  expect(h.calls).toEqual([])
  expect(h.evidence().violations).toEqual([])
})

test('explicit foreground startup retains native functions and records real window events without blocking', async () => {
  const h = bootstrapHarness()
  const originals = {
    show: h.WindowStub.prototype.show,
    focus: h.WindowStub.prototype.focus,
    capture: h.WindowStub.prototype.capturePage,
    appFocus: h.app.focus,
    dialog: h.dialog.showOpenDialog,
  }
  h.bootstrap.install({ ...h.policy, mode: 'foreground' })
  expect(h.WindowStub.prototype.show).toBe(originals.show)
  expect(h.WindowStub.prototype.focus).toBe(originals.focus)
  expect(h.WindowStub.prototype.capturePage).toBe(originals.capture)
  expect(h.app.focus).toBe(originals.appFocus)
  expect(h.dialog.showOpenDialog).toBe(originals.dialog)
  const window = new h.WindowStub()
  window.show()
  window.focus()
  h.app.focus()
  h.dialog.showOpenDialog()
  await window.capturePage(undefined, { stayHidden: false })
  expect(h.calls).toEqual(['window.show', 'window.focus', 'app.focus', 'dialog.showOpenDialog'])
  expect(h.captures[0].options).toEqual({ stayHidden: false })
  expect(window.focusable).toBe(true)
  expect(window.backgroundThrottling).toBe(true)
  expect(h.activation).toEqual([])
  expect(h.timers).toEqual([])
  expect(h.exits).toEqual([])
  expect(h.evidence()).toMatchObject({
    mode: 'foreground',
    violations: [],
    windows: [{ id: window.id, showEvents: 1, focusEvents: 1, closed: false }],
  })
})

function presentationHarness(marker?: string) {
  class WindowStub {
    shown = 0
    constructor(readonly options: BrowserWindowConstructorOptions) {}
    show() {
      this.shown++
    }
  }
  const exported = {} as {
    createAppWindow(options: BrowserWindowConstructorOptions): WindowStub
    showAppWindow(window: WindowStub): void
  }
  new Script(presentationSource).runInNewContext({
    exports: exported,
    process: { env: { LUMA_TEST_UI_MODE: 'background' } },
    __lumaTestUiMode: marker,
    require: (name: string) => {
      if (name === 'electron') return { BrowserWindow: WindowStub }
      throw new Error(`Unexpected window dependency: ${name}`)
    },
  })
  return exported
}

test('the isolated background marker enforces hidden paintable windows while retaining security options', () => {
  const policy = presentationHarness('background')
  const options: BrowserWindowConstructorOptions = {
    width: 1100,
    height: 700,
    show: true,
    focusable: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: '/preload.cjs',
      backgroundThrottling: true,
    },
  }
  const window = policy.createAppWindow(options)
  policy.showAppWindow(window)
  expect(window.shown).toBe(0)
  expect(window.options).toEqual({
    ...options,
    show: false,
    focusable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { ...options.webPreferences, backgroundThrottling: false },
  })
  expect(options.show).toBe(true)
  expect(options.webPreferences!.backgroundThrottling).toBe(true)
})

for (const marker of [undefined, 'foreground']) {
  test(`${marker ?? 'normal'} application windows retain their presentation despite a background environment variable`, () => {
    const policy = presentationHarness(marker)
    const options = { width: 1280, height: 800, show: false, webPreferences: { sandbox: true } }
    const window = policy.createAppWindow(options)
    policy.showAppWindow(window)
    expect(window.options).toBe(options)
    expect(window.shown).toBe(1)
  })
}

test('shutdown waits for each service to finish before admitting the next cleanup', async () => {
  const events: string[] = []
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const closing = closeServices([
    async () => {
      events.push('endpoint started')
      await pending
      events.push('endpoint closed')
    },
    () => {
      events.push('library closed')
    },
  ])
  expect(events).toEqual(['endpoint started'])
  release()
  await closing
  expect(events).toEqual(['endpoint started', 'endpoint closed', 'library closed'])
})

test('an endpoint shutdown failure still waits for library cleanup before rejecting', async () => {
  const failure = new Error('Could not remove the endpoint connection file')
  const events: string[] = []
  let release!: () => void
  let entered!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const libraryEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  let settled = false
  const closing = closeServices([
    () => {
      events.push('endpoint failed')
      throw failure
    },
    async () => {
      events.push('library started')
      entered()
      await pending
      events.push('library closed')
    },
  ]).then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  await libraryEntered
  expect(settled).toBe(false)
  expect(events).toEqual(['endpoint failed', 'library started'])
  release()
  const result = await closing
  expect(result).toBeInstanceOf(AggregateError)
  expect((result as AggregateError).errors).toEqual([failure])
  expect(events).toEqual(['endpoint failed', 'library started', 'library closed'])
})

test('shutdown retains synchronous and asynchronous failures and attempts later services', async () => {
  const first = new Error('Endpoint cleanup failed')
  const second = new Error('Library cleanup failed')
  const events: string[] = []
  const result = await closeServices([
    () => {
      events.push('endpoint')
      throw first
    },
    async () => {
      events.push('library')
      throw second
    },
    () => {
      events.push('final cleanup')
    },
  ]).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(AggregateError)
  expect((result as AggregateError).errors).toEqual([first, second])
  expect((result as AggregateError).errors[0]).toBe(first)
  expect((result as AggregateError).errors[1]).toBe(second)
  expect(events).toEqual(['endpoint', 'library', 'final cleanup'])
})
