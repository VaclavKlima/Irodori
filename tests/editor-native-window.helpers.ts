import { spawn, execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test, type ElectronApplication, type Page } from '@playwright/test'
import { testUiMode } from '../scripts/test-ui-mode.mjs'

const execute = promisify(execFile)
const arrows = { Left: 105, Right: 106, Up: 103, Down: 108 } as const
const modifiers: Record<string, number> = {
  Super: 125,
  Meta: 125,
  Shift: 42,
  Control: 29,
  Ctrl: 29,
  Primary: 29,
  Alt: 56,
}

interface NativeScreen {
  label: string | null
  left: number | null
  top: number | null
  width: number
  height: number
  availLeft: number | null
  availTop: number | null
  availWidth: number
  availHeight: number
  dpr: number | null
}

export interface EditorNativeWindowOptions {
  monitorLabel?: string
  /** Only the isolated, catalog-free HDR diagnostic may omit the application display bridge. */
  diagnosticOnly?: boolean
}

async function until(check: () => Promise<boolean>, timeoutMs: number, message: string) {
  const deadline = performance.now() + timeoutMs
  do {
    if (await check()) return
    await delay(50)
  } while (performance.now() < deadline)
  throw new Error(message)
}

function sameScreen(a: NativeScreen, b: NativeScreen) {
  return (
    a.label === b.label &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.dpr === b.dpr
  )
}

function workAreaObservation(
  target: NativeScreen,
  native: {
    bounds: { width: number; height: number }
    contentBounds: { width: number; height: number }
  },
) {
  return {
    source: 'Compositor maximized state and stable measured native outer/client dimensions',
    reported: {
      left: target.availLeft,
      top: target.availTop,
      width: target.availWidth,
      height: target.availHeight,
    },
    reportedReliability:
      'Wayland available dimensions can omit desktop reservations; not authoritative for maximized height',
    measuredOuter: { width: native.bounds.width, height: native.bounds.height },
    measuredClient: { width: native.contentBounds.width, height: native.contentBounds.height },
    desktopReserved: {
      width: target.width - native.bounds.width,
      height: target.height - native.bounds.height,
    },
    windowDecorations: {
      width: native.bounds.width - native.contentBounds.width,
      height: native.bounds.height - native.contentBounds.height,
    },
    marginPolicy:
      'All reservations are measured differences; no fixed desktop-bar or decoration margins',
  }
}

async function rendererGeometry(page: Page, diagnosticOnly: boolean) {
  return page.evaluate(async (diagnosticOnly) => {
    if (diagnosticOnly && (!('hdrDiagnostic' in window) || 'irodori' in window))
      throw new Error(
        'Diagnostic monitor placement requires the isolated HDR diagnostic without an application bridge.',
      )
    const permission = await navigator.permissions.query({
      name: 'window-management' as PermissionName,
    })
    if (permission.state !== 'granted' || !window.getScreenDetails)
      throw new Error('Monitor placement requires already-granted window-management permission.')
    const details = await Promise.race([
      window.getScreenDetails(),
      new Promise<never>((_resolve, reject) =>
        window.setTimeout(
          () => reject(new Error('Screen details did not respond within two seconds.')),
          2000,
        ),
      ),
    ])
    const describe = (screen: HdrScreen) => {
      const detailed = screen as HdrScreen & { availLeft?: number; availTop?: number }
      return {
        label: screen.label ?? null,
        left: screen.left ?? null,
        top: screen.top ?? null,
        width: screen.width,
        height: screen.height,
        availLeft: detailed.availLeft ?? null,
        availTop: detailed.availTop ?? null,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        dpr: screen.devicePixelRatio ?? null,
      }
    }
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
    const bounds = canvas?.getBoundingClientRect()
    return {
      currentScreen: describe(details.currentScreen),
      screens: details.screens.map(describe),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      outerWindow: { width: outerWidth, height: outerHeight },
      documentClient: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      canvas:
        canvas && bounds
          ? {
              width: canvas.width,
              height: canvas.height,
              cssWidth: bounds.width,
              cssHeight: bounds.height,
              left: bounds.left,
              top: bounds.top,
            }
          : null,
      documentFocused: document.hasFocus(),
      visibility: document.visibilityState,
      documentFullscreen: document.fullscreenElement !== null,
      display: diagnosticOnly ? null : await window.irodori.getDisplayState(),
      displaySource: diagnosticOnly
        ? 'unavailable-in-isolated-hdr-diagnostic'
        : 'application-bridge',
    }
  }, diagnosticOnly)
}

function movement(current: NativeScreen, requested: NativeScreen): keyof typeof arrows {
  if (
    current.left === null ||
    current.top === null ||
    requested.left === null ||
    requested.top === null
  )
    throw new Error('Actual screen coordinates are unavailable; refusing guessed monitor movement.')
  const dx = requested.left + requested.width / 2 - current.left - current.width / 2
  const dy = requested.top + requested.height / 2 - current.top - current.height / 2
  if (!dx && !dy) throw new Error('Requested and current screens overlap ambiguously.')
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'Right' : 'Left') : dy > 0 ? 'Down' : 'Up'
}

async function configuredShortcut(direction: keyof typeof arrows) {
  const key = `move-to-monitor-${direction.toLowerCase()}`
  const { stdout, stderr } = await execute(
    'gsettings',
    ['get', 'org.gnome.desktop.wm.keybindings', key],
    { timeout: 3000, maxBuffer: 8192 },
  )
  const configured = [...stdout.matchAll(/'([^']*)'/g)].map((match) => match[1])
  for (const accelerator of configured) {
    const keyName = accelerator.replace(/<[^>]+>/g, '')
    const names = [...accelerator.matchAll(/<([^>]+)>/g)].map((match) => match[1])
    if (
      keyName !== direction ||
      !names.length ||
      names.some((name) => modifiers[name] === undefined)
    )
      continue
    const codes = [...new Set(names.map((name) => modifiers[name])), arrows[direction]]
    return {
      schema: 'org.gnome.desktop.wm.keybindings',
      key,
      accelerator,
      configured,
      codes,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  }
  throw new Error(`No supported configured GNOME ${key} accelerator: ${stdout.trim()}`)
}

/** Moves only the focused isolated test window, then measures native maximization. */
export async function maximizeEditorOnMonitor(
  app: ElectronApplication,
  page: Page,
  options: EditorNativeWindowOptions = {},
) {
  if (testUiMode() !== 'foreground')
    throw new Error('Native monitor placement requires foreground mode.')
  if (
    process.platform !== 'linux' ||
    (!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'wayland')
  )
    throw new Error('This monitor-placement helper requires the native Linux Wayland session.')
  const timeoutMs = 15000
  const label = options.monitorLabel ?? process.env.IRODORI_RESPONSIVENESS_MONITOR ?? null
  const requested = { label, selection: label ? 'matching label' : 'largest actual screen area' }
  const nativeWindow = await app.browserWindow(page)
  const isolation = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    uiMode: process.env.IRODORI_TEST_UI_MODE,
    argv: process.argv.filter((argument) => argument.startsWith('--user-data-dir=')),
  }))
  const profile = await realpath(isolation.userData)
  if (
    isolation.uiMode !== 'foreground' ||
    !basename(profile).startsWith('irodori-e2e-') ||
    !isolation.argv.some((argument) => argument === `--user-data-dir=${profile}`)
  )
    throw new Error(
      'Monitor placement is limited to the shared launcher’s isolated foreground profile.',
    )
  const nativeState = () =>
    nativeWindow.evaluate((measuredWindow) => ({
      id: measuredWindow.id,
      focused: measuredWindow.isFocused(),
      webContentsFocused: measuredWindow.webContents.isFocused(),
      visible: measuredWindow.isVisible(),
      minimized: measuredWindow.isMinimized(),
      maximized: measuredWindow.isMaximized(),
      fullscreen: measuredWindow.isFullScreen(),
      bounds: measuredWindow.getBounds(),
      contentBounds: measuredWindow.getContentBounds(),
    }))
  let phase = 'initial state'
  type ShortcutMarker = {
    hop: number
    accelerator: string
    codes: number[]
    command: 'not-started' | 'started' | 'completed'
  }
  let shortcutMarker: ShortcutMarker | null = null
  let rejectedFocus:
    | {
        phase: string
        location: string
        nativeObservedAtMs: number
        rendererObservedAtMs: number
        native: Awaited<ReturnType<typeof nativeState>>
        renderer: { focused: boolean; visible: DocumentVisibilityState }
        shortcut: ShortcutMarker | null
      }
    | undefined
  const assertFocused = async (location: string) => {
    const native = await nativeState()
    const nativeObservedAtMs = performance.now()
    const renderer = await page.evaluate(() => ({
      focused: document.hasFocus(),
      visible: document.visibilityState,
    }))
    if (
      !native.focused ||
      !native.webContentsFocused ||
      !native.visible ||
      native.minimized ||
      !renderer.focused ||
      renderer.visible !== 'visible'
    ) {
      // Preserve the actual rejected samples. Later geometry observations can be older,
      // and daemon cleanup must never replace this evidence with a recovered focus state.
      rejectedFocus = {
        phase,
        location,
        nativeObservedAtMs,
        rendererObservedAtMs: performance.now(),
        native,
        renderer,
        shortcut: shortcutMarker ? { ...shortcutMarker, codes: [...shortcutMarker.codes] } : null,
      }
      throw new Error(
        `The isolated measured window lost native/renderer focus; no further monitor shortcut will be sent. Rejected focus sample: ${JSON.stringify(rejectedFocus)}`,
      )
    }
    return native
  }
  const initialNative = await assertFocused('initial')
  const initialRenderer = await rendererGeometry(page, options.diagnosticOnly === true)
  if (initialNative.fullscreen || initialRenderer.documentFullscreen)
    throw new Error(
      'Expected an ordinary window; native or DOM fullscreen must be exited before this helper.',
    )
  const largestArea = Math.max(
    ...initialRenderer.screens.map((screen) => screen.width * screen.height),
  )
  const candidates = initialRenderer.screens.filter((screen) =>
    label ? screen.label?.includes(label) : screen.width * screen.height === largestArea,
  )
  if (candidates.length !== 1)
    throw new Error(`Requested monitor is missing or ambiguous: ${JSON.stringify(requested)}`)
  const target = candidates[0]
  if (target.dpr === null || target.availWidth <= 0 || target.availHeight <= 0)
    throw new Error('Requested monitor lacks actual DPR/work-area evidence.')
  const moves: {
    shortcut: Awaited<ReturnType<typeof configuredShortcut>>
    before: NativeScreen
    after: NativeScreen
  }[] = []
  const daemonEvidence = {
    started: false,
    pid: null as number | null,
    socket: null as string | null,
    directory: null as string | null,
    cleanupComplete: false,
    output: '',
  }
  let daemon: ReturnType<typeof spawn> | undefined
  let daemonClosed: Promise<void> | undefined
  let spawnFailure: Error | undefined
  let heldCodes: number[] = []
  let lastNative = initialNative,
    lastRenderer = initialRenderer
  let lastChecks: Record<string, boolean> = {}
  const killOwnedDaemon = () => {
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null)
      daemon.kill('SIGTERM')
  }
  const closeEvents = () => killOwnedDaemon()
  let failure: unknown, result: unknown
  try {
    let current = initialRenderer.currentScreen
    if (!sameScreen(current, target)) {
      phase = 'owned input daemon startup'
      await access('/dev/uinput', constants.W_OK)
      const directory = await mkdtemp(join(tmpdir(), 'irodori-wm-'))
      daemonEvidence.directory = directory
      const socket = join(directory, 's')
      if (Buffer.byteLength(socket) >= 104)
        throw new Error('Use a shorter absolute TMPDIR for the owned input socket.')
      daemonEvidence.socket = socket
      daemon = spawn(
        'ydotoold',
        ['--socket-path', socket, '--socket-perm', '0600', '--mouse-off'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      daemonEvidence.started = true
      daemonEvidence.pid = daemon.pid ?? null
      daemonClosed = new Promise<void>((resolve) => daemon!.once('close', () => resolve()))
      daemon.on('error', (error) => {
        spawnFailure = error
      })
      const output = (chunk: Buffer) => {
        daemonEvidence.output = (daemonEvidence.output + chunk.toString()).slice(-4096)
      }
      daemon.stdout?.on('data', output)
      daemon.stderr?.on('data', output)
      process.once('exit', closeEvents)
      app.once('close', closeEvents)
      page.once('close', closeEvents)
      await until(
        async () => {
          if (spawnFailure) throw spawnFailure
          if (daemon!.exitCode !== null || daemon!.signalCode !== null)
            throw new Error(`Owned ydotoold exited: ${daemonEvidence.output}`)
          const info = await lstat(socket).catch(() => null)
          return (
            !!info?.isSocket() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600
          )
        },
        timeoutMs,
        `Owned ydotoold socket was not ready: ${socket}`,
      )
      // libinput needs to discover the newly created keyboard before the first chord.
      await delay(1000)
      for (
        let hop = 0;
        !sameScreen(current, target) && hop <= initialRenderer.screens.length;
        hop++
      ) {
        phase = 'configured GNOME monitor movement'
        const shortcut = await configuredShortcut(movement(current, target))
        shortcutMarker = {
          hop,
          accelerator: shortcut.accelerator,
          codes: [...shortcut.codes],
          command: 'not-started',
        }
        await assertFocused('before-shortcut')
        heldCodes = shortcut.codes
        shortcutMarker.command = 'started'
        await execute(
          'ydotool',
          [
            'key',
            '--key-delay',
            '12',
            ...shortcut.codes.map((code) => `${code}:1`),
            ...[...shortcut.codes].reverse().map((code) => `${code}:0`),
          ],
          { env: { ...process.env, YDOTOOL_SOCKET: socket }, timeout: 3000, maxBuffer: 8192 },
        )
        shortcutMarker.command = 'completed'
        heldCodes = []
        await assertFocused('after-shortcut')
        let after = current
        await until(
          async () => {
            lastNative = await nativeState()
            lastRenderer = await rendererGeometry(page, options.diagnosticOnly === true)
            after = lastRenderer.currentScreen
            return !sameScreen(current, after)
          },
          timeoutMs,
          'The configured GNOME monitor shortcut did not change the measured window’s actual screen.',
        )
        moves.push({ shortcut, before: current, after })
        current = after
      }
      if (!sameScreen(current, target))
        throw new Error('Monitor movement did not reach the unique requested screen.')
    }
    await assertFocused('before-maximize')
    phase = 'maximization convergence'
    await nativeWindow.evaluate((measuredWindow) => measuredWindow.maximize())
    let finalNative = initialNative,
      finalRenderer = initialRenderer
    let stableSamples = 0,
      previousGeometry = ''
    await until(
      async () => {
        finalNative = await nativeState()
        finalRenderer = await rendererGeometry(page, options.diagnosticOnly === true)
        lastNative = finalNative
        lastRenderer = finalRenderer
        const viewport = finalRenderer.viewport
        lastChecks = {
          requestedScreen: sameScreen(finalRenderer.currentScreen, target),
          nativeMaximized: finalNative.maximized,
          nativeNotFullscreen: !finalNative.fullscreen,
          documentNotFullscreen: !finalRenderer.documentFullscreen,
          actualDpr: viewport.dpr === target.dpr,
          nativeOuterWidthMatchesWorkArea: finalNative.bounds.width === target.availWidth,
          // Non-Aura Wayland output metrics may have no work-area insets:
          // chromium/src ui/ozone/platform/wayland/host/{wayland_output,wayland_screen}.cc.
          // The saved GNOME diagnostic reports 1440 available but configures 1408 maximized.
          nativeOuterHeightFitsReportedArea:
            finalNative.bounds.height > 0 &&
            finalNative.bounds.height <= target.availHeight &&
            finalNative.bounds.height <= target.height,
          desktopReservationRemainsVisible: finalNative.bounds.height < target.height,
          nativeOuterMatchesRendererOuter:
            finalNative.bounds.width === finalRenderer.outerWindow.width &&
            finalNative.bounds.height === finalRenderer.outerWindow.height,
          viewportWidthMatchesWorkArea: viewport.width === target.availWidth,
          viewportWidthMatchesNativeClient: viewport.width === finalNative.contentBounds.width,
          viewportHeightMatchesNativeClient: viewport.height === finalNative.contentBounds.height,
          positiveViewportHeight: viewport.height > 0,
          viewportHeightFitsWorkArea: viewport.height <= target.availHeight,
        }
        const geometry = JSON.stringify({
          screen: finalRenderer.currentScreen,
          outer: finalRenderer.outerWindow,
          client: finalNative.contentBounds,
          viewport,
          canvas: finalRenderer.canvas,
        })
        stableSamples = Object.values(lastChecks).every(Boolean)
          ? geometry === previousGeometry
            ? stableSamples + 1
            : 1
          : 0
        previousGeometry = geometry
        lastChecks.geometryStableForThreeSamples = stableSamples >= 3
        return Object.values(lastChecks).every(Boolean)
      },
      timeoutMs,
      'Maximized native state and actual target/work-area/client/viewport geometry did not converge.',
    )
    await assertFocused('final')
    result = {
      method: moves.length
        ? 'GNOME configured monitor shortcut through owned ydotoold; BrowserWindow.maximize'
        : 'already on requested screen; BrowserWindow.maximize',
      requested,
      target,
      isolation: { profile, nativeWindowId: initialNative.id },
      before: { native: initialNative, renderer: initialRenderer },
      after: { native: finalNative, renderer: finalRenderer },
      moves,
      daemon: daemonEvidence,
      workArea: workAreaObservation(target, finalNative),
      provenance: {
        sessionType: process.env.XDG_SESSION_TYPE ?? null,
        waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
        positionAuthority:
          'window.getScreenDetails().currentScreen; Electron global coordinates are not authoritative on Wayland',
        workAreaAuthority:
          'Compositor maximized state, three stable native/renderer outer/client samples and actual target; ScreenDetailed availHeight may omit the desktop bar on Wayland',
        settingsMutation: false,
        nativeFullscreen: false,
      },
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      if (
        heldCodes.length &&
        daemonEvidence.socket &&
        daemon?.pid &&
        daemon.exitCode === null &&
        daemon.signalCode === null
      )
        await execute(
          'ydotool',
          ['key', '--key-delay', '0', ...[...heldCodes].reverse().map((code) => `${code}:0`)],
          {
            env: { ...process.env, YDOTOOL_SOCKET: daemonEvidence.socket },
            timeout: 1000,
            maxBuffer: 8192,
          },
        )
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Monitor placement and key-release cleanup failed.')
        : error
    } finally {
      killOwnedDaemon()
      if (daemonClosed) {
        const closed = await Promise.race([
          daemonClosed.then(() => true),
          delay(2000).then(() => false),
        ])
        if (!closed && daemon?.pid) {
          daemon.kill('SIGKILL')
          await daemonClosed
        }
      }
      process.removeListener('exit', closeEvents)
      app.removeListener('close', closeEvents)
      page.removeListener('close', closeEvents)
      if (daemonEvidence.directory)
        await rm(daemonEvidence.directory, { recursive: true, force: true })
      daemonEvidence.cleanupComplete = true
    }
  }
  if (failure) {
    const diagnostics = {
      status: 'failed',
      phase,
      requested,
      target,
      before: { native: initialNative, renderer: initialRenderer },
      last: { native: lastNative, renderer: lastRenderer },
      lastObservationPolicy:
        'Last completed geometry samples; rejectedFocus preserves the actual native/renderer samples that failed the guard.',
      rejectedFocus,
      shortcutMarker,
      checks: lastChecks,
      failedChecks: Object.entries(lastChecks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key),
      moves,
      daemon: daemonEvidence,
      workArea: workAreaObservation(target, lastNative),
      geometryPolicy:
        'Exact requested screen/DPR, compositor maximized/non-fullscreen, stable measured outer/client geometry within reported screen bounds and positive desktop reservation; Wayland availHeight equality is not an actual work-area proof.',
    }
    const info = test.info()
    const path = info.outputPath('editor-native-window-failure.json')
    await writeFile(path, JSON.stringify(diagnostics, null, 2))
    await info.attach('Native window placement failure', { path, contentType: 'application/json' })
    const message = failure instanceof Error ? failure.message : String(failure)
    throw new Error(
      `${message}\nNative window placement diagnostics: ${JSON.stringify({
        phase,
        target,
        last: diagnostics.last,
        lastObservationPolicy: diagnostics.lastObservationPolicy,
        rejectedFocus,
        shortcutMarker,
        checks: lastChecks,
        moves,
        diagnosticPath: path,
      })}`,
      { cause: failure },
    )
  }
  return result as {
    method: string
    requested: typeof requested
    target: NativeScreen
    isolation: { profile: string; nativeWindowId: number }
    before: { native: typeof initialNative; renderer: typeof initialRenderer }
    after: { native: typeof initialNative; renderer: typeof initialRenderer }
    moves: typeof moves
    daemon: typeof daemonEvidence
    workArea: ReturnType<typeof workAreaObservation>
    provenance: {
      sessionType: string | null
      waylandDisplay: string | null
      positionAuthority: string
      workAreaAuthority: string
      settingsMutation: boolean
      nativeFullscreen: boolean
    }
  }
}
