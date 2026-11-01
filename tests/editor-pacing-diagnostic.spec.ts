import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, JSHandle, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { foregroundTest, requiresForeground } from './foreground'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { maximizeEditorOnMonitor } from './editor-native-window.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { editorInputPacingSummary } from './editor-input-pacing.helpers'
import {
  confirmEditorDisplay,
  editorConfigurationMatches,
  editorDisplayPreference,
  editorDisplayProfile,
  editorPhysicalDisplay,
  matchedEditorInput,
  type EditorInputPreparation,
} from './editor-responsiveness-profile.helpers'
import { hdrTestPolicy } from './hdr-test-policy.helpers'
import { assertHdrMemory } from './hdr-memory-policy.helpers'
import { assessEditorPacingTrace, type SavedEditorTraceMark } from './editor-pacing-trace.helpers'

const reason = 'A bounded pacing trace needs the isolated native HDR window on Microstep.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })
const fixturePath = process.env.IRODORI_RESPONSIVENESS_SOURCE
const fixtureSha256 = process.env.IRODORI_RESPONSIVENESS_SOURCE_SHA256
const frozenSourcesPath = process.env.IRODORI_EDITOR_PACING_FROZEN_SOURCES
test.skip(
  !fixturePath || !fixtureSha256 || !frozenSourcesPath,
  'Select the committed source, its SHA-256 and the retained 51-source freeze explicitly.',
)
test.skip(
  process.platform !== 'linux' ||
    (!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'wayland') ||
    editorDisplayProfile !== 'linux-native-dpr1' ||
    editorDisplayPreference !== 'auto' ||
    hdrTestPolicy.precision !== 'f32',
  'This diagnostic requires the ordinary Linux Wayland DPR1 hardware HDR/f32 policy.',
)

const categories = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack',
  'blink.user_timing',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
]
const traceLimitMs = 30_000
const traceBufferKiB = 16_384
const layout = { width: 1440, height: 900, maximized: true }
const minimumInputHz = 120 * 0.99
interface NativeState {
  epochMs: number
  focused: boolean
  contentsFocused: boolean
  visible: boolean
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
}
interface NativeObservation {
  initial: NativeState
  events: (NativeState & { type: string })[]
  final: NativeState
  droppedEvents: number
  rendererPid: number
}
const shaFile = async (path: string) => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function frozenSources() {
  const requestedPath = resolve(frozenSourcesPath!)
  const file = await lstat(requestedPath)
  expect(file.isFile() && !file.isSymbolicLink() && file.size <= 256 * 1024).toBe(true)
  const path = await realpath(requestedPath)
  expect(path.startsWith((await realpath('artifacts')) + sep)).toBe(true)
  const bytes = await readFile(path)
  const parsed = JSON.parse(bytes.toString()) as { sources: Record<string, string> }
  expect(Object.keys(parsed.sources)).toHaveLength(51)
  expect(parsed.sources[fixturePath!]).toBe(fixtureSha256)
  return {
    path,
    requestedPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...parsed,
  }
}

async function checkSources(sources: Record<string, string>) {
  const checkout = await realpath('.')
  for (const [path, digest] of Object.entries(sources)) {
    expect(path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')).toBe(
      false,
    )
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    const file = await lstat(path)
    expect(file.isFile() && !file.isSymbolicLink(), path).toBe(true)
    expect((await realpath(path)).startsWith(checkout + sep), path).toBe(true)
    expect(await shaFile(path), path).toBe(digest)
  }
}

async function marker(page: Page, name: string) {
  return page.evaluate((name) => {
    const mark = performance.mark(name)
    return {
      name,
      startTime: mark.startTime,
      timeOrigin: performance.timeOrigin,
      observedAt: performance.now(),
      epochMs: Date.now(),
      clock: 'Renderer performance milliseconds; match this named blink.user_timing trace mark.',
    }
  }, name)
}

async function startTrace(app: ElectronApplication, path: string) {
  return app.evaluateHandle(
    async ({ contentTracing }, options) => {
      const available = await contentTracing.getCategories()
      const startedAt = performance.now()
      let stopReason: 'explicit' | 'duration-limit' | null = null
      let stoppedAt: number | null = null
      let stopError: string | null = null
      let bufferUsage: { value: number; percentage: number } | null = null
      let bufferUsageError: string | null = null
      let stopping: Promise<string> | undefined
      await contentTracing.startRecording({
        included_categories: options.categories,
        recording_mode: 'record-until-full',
        trace_buffer_size_in_kb: options.bufferKiB,
      })
      const stop = (reason: 'explicit' | 'duration-limit') => {
        if (!stopping) {
          stopReason = reason
          clearTimeout(timer)
          stopping = (async () => {
            let usage = Promise.resolve()
            try {
              usage = contentTracing.getTraceBufferUsage().then(
                (value) => {
                  bufferUsage = value
                },
                (error: unknown) => {
                  bufferUsageError = String(error)
                },
              )
            } catch (error) {
              bufferUsageError = String(error)
            }
            // Stop is requested immediately; an unavailable usage response
            // must not prolong recording or prevent the finally cleanup.
            const result = await contentTracing.stopRecording(options.path)
            let usageTimer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                usage,
                new Promise<void>((resolve) => {
                  usageTimer = setTimeout(() => {
                    bufferUsageError = 'Trace buffer usage did not respond within 500ms after stop.'
                    resolve()
                  }, 500)
                }),
              ])
            } finally {
              clearTimeout(usageTimer)
            }
            return result
          })().then(
            (result) => {
              stoppedAt = performance.now()
              return result
            },
            (error: unknown) => {
              stoppedAt = performance.now()
              stopError = String(error)
              throw error
            },
          )
        }
        return stopping
      }
      const timer = setTimeout(
        () => void stop('duration-limit').catch(() => undefined),
        options.limitMs,
      )
      return {
        async stop() {
          const result = await stop('explicit')
          return {
            result,
            startedAt,
            stoppedAt,
            stopReason,
            stopError,
            bufferUsage,
            bufferUsageError,
            bufferOverflowStatus:
              !bufferUsage || !Number.isFinite(bufferUsage.percentage)
                ? 'unavailable'
                : bufferUsage.percentage >= 1
                  ? 'full-or-overflow-possible'
                  : 'not-full-at-stop',
            mainTimeOrigin: performance.timeOrigin,
            mainPid: process.pid,
            requestedCategories: options.categories,
            availableRequestedCategories: options.categories.filter((name) =>
              available.includes(name),
            ),
          }
        },
      }
    },
    { path, categories, limitMs: traceLimitMs, bufferKiB: traceBufferKiB },
  )
}

test(
  'diagnostic only: Exposure Fit 120Hz renderer pacing under a bounded Chromium trace',
  foregroundTest(reason),
  async ({ irodori }, info) => {
    test.setTimeout(180_000)
    expect(fixturePath).toMatch(/^assets\/tests\/images\//)
    expect(fixtureSha256).toMatch(/^[a-f0-9]{64}$/)
    const freeze = await frozenSources()
    await checkSources(freeze.sources)
    const execute = promisify(execFile)
    await execute('git', ['ls-files', '--error-unmatch', '--', fixturePath!])
    await execute('git', ['diff', '--quiet', 'HEAD', '--', fixturePath!])
    const output = resolve(info.outputDir)
    expect(output.startsWith(resolve('artifacts') + sep)).toBe(true)
    await mkdir(output, { recursive: true })
    const directory = await mkdtemp(join(output, 'pacing-'))
    const tracePath = join(directory, 'chromium-trace.trace')
    const reportPath = join(directory, 'diagnostic.json')
    const id = randomUUID()
    const { app, page } = irodori
    const nativeWindow = await app.browserWindow(page)
    const preparations: EditorInputPreparation[] = []
    const markers: SavedEditorTraceMark[] = []
    const report: Record<string, unknown> = {
      version: 'editor-pacing-diagnostic-v2',
      diagnosticOnly: true,
      timingAcceptance: false,
      canonical18ControlClosure: false,
      matrixPartial: true,
      route:
        'Unchanged matchedEditorInput renderer value setter and untrusted DOM input events; native foreground window and native rAF observations.',
      selection: { label: 'Exposure', zoom: 'fit', frequency: 120, trials: 1, inputs: 240 },
      minimumInputHz,
      frozenSources: freeze,
      diagnosticSourceSha256: await shaFile('tests/editor-pacing-diagnostic.spec.ts'),
      traceCompletenessSourceSha256: await shaFile('tests/editor-pacing-trace.helpers.ts'),
      tracing: {
        tracePath,
        categories,
        traceLimitMs,
        traceBufferKiB,
        overhead: 'Instrumented scheduling evidence; no uninstrumented timing acceptance.',
      },
      preparations,
      markers,
    }
    let trace: Awaited<ReturnType<typeof startTrace>> | undefined
    let nativeObserver: JSHandle<{ stop(): NativeObservation }> | undefined
    let trial: Awaited<ReturnType<typeof matchedEditorInput>> | undefined
    let incompleteTrace = true
    let failure: unknown
    let cleanupFailure: Error | undefined
    try {
      await importPhotos(app, page, [fixturePath!], false)
      await confirmEditorDisplay(page, true)
      const toggle = page.getByTestId('console-toggle')
      if ((await toggle.getAttribute('aria-expanded')) === 'true') await activateButton(toggle)
      await focusPreviewWindow(app, page)
      report.monitorPlacement = await maximizeEditorOnMonitor(app, page, {
        monitorLabel: 'Microstep',
      })
      await confirmEditorDisplay(page)
      await expect(page.getByTestId('main-preview')).toHaveAttribute(
        'data-interactive-policy',
        hdrTestPolicy.interactivePolicy,
      )
      const physical = await editorPhysicalDisplay(app, page)
      const target = await page.evaluate(() => window.irodori.getDisplayState())
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }))
      report.preconditions = { physical, target, viewport, policy: hdrTestPolicy }
      test.skip(
        !physical.confirmedRendererMonitor.reliable ||
          !physical.confirmedRendererMonitor.monitor?.label?.includes('Microstep') ||
          physical.confirmedRendererMonitor.monitor?.scale !== 1 ||
          target.generation !== physical.confirmedRendererMonitor.generation ||
          viewport.dpr !== 1 ||
          target.mode !== 'hdr' ||
          !(target.headroom && target.headroom > 1) ||
          target.peak <= 1 ||
          target.capabilities?.hardware !== true ||
          target.capabilities.extended !== true,
        'The confirmed Microstep DPR1 hardware HDR display is unavailable; no substitute configuration is used.',
      )
      nativeObserver = await nativeWindow.evaluateHandle((window) => {
        const state = () => ({
          epochMs: Date.now(),
          focused: window.isFocused(),
          contentsFocused: window.webContents.isFocused(),
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          maximized: window.isMaximized(),
          fullscreen: window.isFullScreen(),
        })
        const initial = state()
        const events: (ReturnType<typeof state> & { type: string })[] = []
        let droppedEvents = 0
        const handlers = Object.fromEntries(
          ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'].map((type) => [
            type,
            () => {
              if (events.length === 512) {
                events.shift()
                droppedEvents++
              }
              events.push({ type, ...state() })
            },
          ]),
        )
        for (const [type, handler] of Object.entries(handlers)) window.on(type as 'focus', handler)
        return {
          stop() {
            for (const [type, handler] of Object.entries(handlers))
              window.removeListener(type as 'focus', handler)
            return {
              initial,
              events,
              final: state(),
              droppedEvents,
              rendererPid: window.webContents.getOSProcessId(),
            }
          },
        }
      })
      trace = await startTrace(app, tracePath)
      markers.push(await marker(page, `irodori.pacing.${id}.before-shared-call`))
      trial = await matchedEditorInput(
        page,
        {
          label: 'Exposure',
          zoom: 'fit',
          frequency: 120,
          pacing: 'timer-deadline-v1',
          photoId: fixtureSha256!,
        },
        { app, layout, recordPreparation: (evidence) => preparations.push(evidence) },
      )
      report.trial = trial
      report.pacingSummary = editorInputPacingSummary(trial.pacing)
      markers.push(await marker(page, `irodori.pacing.${id}.after-shared-call`))
      report.clockAlignment = {
        rendererTimeOrigin: trial.epochMs,
        inputStartedAt: trial.inputStartedAt,
        inputReleasedAt: trial.inputReleasedAt,
        pacerStartedAt: trial.pacing?.startedAt,
        pacerStoppedAt: trial.pacing?.stoppedAt,
        instruction:
          'Match the two named User Timing marks to trace timestamps. Subtract each saved mark.startTime from its trace timestamp (convert trace microseconds to milliseconds) to align every input/pacer/request timestamp. The trace includes unchanged shared preparation and final refinement around the actual retained input interval.',
      }
      report.configurationMatched = editorConfigurationMatches(viewport, physical, [trial])
      report.inputCadenceMatched = trial.achievedHz >= minimumInputHz
      const attention = trial.display.rendererAttention
      report.rendererAttentionMatched =
        !!attention.end &&
        [attention.start, ...attention.events, attention.end].every(
          (state) => state.hasFocus && state.visibilityState === 'visible',
        )
    } catch (error) {
      failure = error
      report.error = String(error)
      throw error
    } finally {
      const cleanupErrors: string[] = []
      const incompleteReasons: string[] = []
      let parsedTrace: unknown
      let rendererPid: number | undefined
      let bufferUsagePercentage: number | null = null
      try {
        if (trace) {
          const stopped = await trace.evaluate((trace) => trace.stop())
          report.traceStop = stopped
          bufferUsagePercentage = stopped.bufferUsage?.percentage ?? null
          if (stopped.stopReason !== 'explicit')
            incompleteReasons.push(`Trace stop reason: ${stopped.stopReason ?? 'unavailable'}.`)
          if (stopped.stopError) incompleteReasons.push(`Trace stop failed: ${stopped.stopError}`)
          expect(resolve(stopped.result)).toBe(tracePath)
          const file = await lstat(stopped.result)
          expect(file.isFile() && !file.isSymbolicLink() && file.size > 0).toBe(true)
          report.traceFile = {
            path: stopped.result,
            bytes: file.size,
            sha256: await shaFile(stopped.result),
          }
          parsedTrace = JSON.parse(await readFile(stopped.result, 'utf8'))
        } else incompleteReasons.push('Trace capture was not started.')
      } catch (error) {
        report.traceCleanupError = String(error)
        incompleteReasons.push('Trace stop/read/parse failed: ' + String(error))
        cleanupErrors.push(String(error))
      }
      try {
        if (nativeObserver) {
          const activity = await nativeObserver.evaluate((observer) => observer.stop())
          report.nativeWindowActivity = activity
          rendererPid = activity.rendererPid
          report.nativeFocusMatched =
            activity.droppedEvents === 0 &&
            [activity.initial, ...activity.events, activity.final].every(
              (state) =>
                state.focused &&
                state.contentsFocused &&
                state.visible &&
                !state.minimized &&
                state.maximized &&
                !state.fullscreen,
            )
        }
      } catch (error) {
        cleanupErrors.push(String(error))
      }
      // Inspect the saved recording only after capture and input have stopped.
      // Buffer usage remains an observation; it cannot prove retained coverage.
      if (parsedTrace !== undefined && trial && markers.length === 2 && rendererPid !== undefined) {
        const completeness = assessEditorPacingTrace(parsedTrace, {
          rendererPid,
          markers: [markers[0], markers[1]],
          trial: {
            inputStartedAt: trial.inputStartedAt,
            inputReleasedAt: trial.inputReleasedAt,
            inputCount: trial.inputs.length,
          },
          bufferUsagePercentage,
        })
        report.traceCompleteness = completeness
        incompleteTrace = !completeness.complete
        incompleteReasons.push(
          ...completeness.reasons.map(({ code, detail }) => `${code}: ${detail}`),
        )
      } else {
        report.traceCompleteness = null
        incompleteReasons.push(
          'Trace, both saved marks, complete trial or recorded renderer PID is unavailable.',
        )
      }
      if (failure) incompleteReasons.push('Diagnostic execution failed: ' + String(failure))
      if (trial?.error) incompleteReasons.push('Input trial failed: ' + trial.error)
      const disposed = await Promise.allSettled([
        trace?.dispose(),
        nativeObserver?.dispose(),
        nativeWindow.dispose(),
      ])
      for (const result of disposed)
        if (result.status === 'rejected') cleanupErrors.push(String(result.reason))
      try {
        await checkSources(freeze.sources)
        report.frozenSourcesUnchanged = true
      } catch (error) {
        cleanupErrors.push(String(error))
      }
      incompleteReasons.push(...cleanupErrors.map((error) => 'Diagnostic cleanup failed: ' + error))
      incompleteTrace ||= incompleteReasons.length > 0
      report.traceIncomplete = incompleteTrace
      report.traceIncompleteReasons = incompleteReasons
      report.cleanupErrors = cleanupErrors
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' })
      await info.attach('Editor pacing diagnostic', {
        path: reportPath,
        contentType: 'application/json',
      })
      if (cleanupErrors.length && !failure)
        cleanupFailure = new Error('Diagnostic cleanup failed: ' + cleanupErrors.join('; '))
    }
    if (cleanupFailure) throw cleanupFailure
    expect(trial).toBeDefined()
    if (!trial) return
    expect(trial.error).toBeUndefined()
    expect(trial.inputs).toHaveLength(240)
    expect(trial.backend).toBe('webgpu-hdr')
    expect(trial.pacingMode).toBe('timer-deadline-v1')
    expect(trial.pacing?.dispatches).toHaveLength(240)
    expect(trial.baselineSourceMatched).toBe(true)
    expect(trial.presentedTargetMatches).toBe(true)
    expect(trial.attributionFailures).toBe(0)
    expect(trial.arithmeticPolicyMismatches).toBe(0)
    expect(trial.interactive).toBeGreaterThan(0)
    expect(trial.display.targets).toHaveLength(1)
    expect(trial.display.initialTarget.mode).toBe('hdr')
    expect(trial.display.initialTarget.capabilities?.monitor?.label).toContain('Microstep')
    expect(
      trial.presentations.every((frame) => frame.previewPolicy === hdrTestPolicy.interactivePolicy),
    ).toBe(true)
    expect(trial.finalMatched).toBe(true)
    expect(trial.histogramMatched).toBe(true)
    expect(trial.historyEntriesAdded).toBe(1)
    expect(trial.loaders).toBe(0)
    expect(trial.hidden).toBe(0)
    assertHdrMemory(trial, 'Instrumented Exposure/Fit diagnostic', true)
    test.skip(
      incompleteTrace ||
        report.nativeFocusMatched !== true ||
        report.rendererAttentionMatched !== true ||
        report.configurationMatched !== true ||
        trial.achievedHz < minimumInputHz,
      'The diagnostic trace/configuration or unchanged 99% requested input cadence is incomplete. All samples and trace remain retained; this is not timing acceptance.',
    )
  },
)
