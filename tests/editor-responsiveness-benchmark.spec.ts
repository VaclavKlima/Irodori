import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import { type WorkabilitySlider } from './mac-workability.helpers'
import { editorInputPacingSummary } from './editor-input-pacing.helpers'
import {
  confirmEditorDisplay,
  editorCaseSelection,
  editorConfigurationMatches,
  editorDisplayPreference,
  editorDisplayProfile,
  editorExpectedDpr,
  editorPhysicalDisplay,
  editorRequestedTileBatch,
  matchedEditorInput,
} from './editor-responsiveness-profile.helpers'
import { assertHdrMemory } from './hdr-memory-policy.helpers'
import { hdrTestPolicy } from './hdr-test-policy.helpers'
import { provenance } from '../scripts/research/pipeline/provenance'
import { maximizeEditorOnMonitor } from './editor-native-window.helpers'

const reason =
  'Editor responsiveness measures native display cadence and completed visible updates.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })
const allSliders: WorkabilitySlider[] = [
  'Exposure',
  'Contrast',
  'Highlights',
  'Shadows',
  'Whites',
  'Blacks',
  'Temperature',
  'Tint',
]
const selected = process.env.LUMA_RESPONSIVENESS_SLIDERS?.split(',').map((value) => value.trim())
if (
  selected &&
  (!selected.length ||
    selected.some((value) => !allSliders.includes(value as WorkabilitySlider)) ||
    new Set(selected).size !== selected.length)
)
  throw new Error('LUMA_RESPONSIVENESS_SLIDERS must contain distinct, known slider labels.')
const sliders = (selected ?? allSliders) as WorkabilitySlider[]
const requestedPrecision = hdrTestPolicy.precision
const expectedPolicy = hdrTestPolicy.interactivePolicy
const layouts = [
  { name: '1100x700-console', width: 1100, height: 700, consoleOpen: true, maximized: false },
  { name: '1440x900', width: 1440, height: 900, consoleOpen: false, maximized: false },
  { name: 'native-maximized', width: 1440, height: 900, consoleOpen: false, maximized: true },
] as const
const selectedLayouts = process.env.LUMA_RESPONSIVENESS_LAYOUTS?.split(',')
const selectedFrequencies = process.env.LUMA_RESPONSIVENESS_FREQUENCIES?.split(',').map(Number)
if (
  selectedLayouts &&
  (selectedLayouts.some((name) => !layouts.some((layout) => layout.name === name)) ||
    new Set(selectedLayouts).size !== selectedLayouts.length)
)
  throw new Error('LUMA_RESPONSIVENESS_LAYOUTS must contain distinct known layout names.')
if (
  selectedFrequencies &&
  (selectedFrequencies.some((frequency) => ![60, 120].includes(frequency)) ||
    new Set(selectedFrequencies).size !== selectedFrequencies.length)
)
  throw new Error('LUMA_RESPONSIVENESS_FREQUENCIES must contain distinct values from 60,120.')
const cases = layouts
  .filter((layout) => !selectedLayouts || selectedLayouts.includes(layout.name))
  .flatMap((layout) =>
    ([60, 120] as const)
      .filter((frequency) => !selectedFrequencies || selectedFrequencies.includes(frequency))
      .map((frequency) => ({
        layout,
        frequency,
        title: `editor responsiveness ${layout.name} ${frequency}Hz: three trials at Fit and 100%`,
      })),
  )

async function observeNativeWindow(app: ElectronApplication, windowId: number) {
  return app.evaluateHandle(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    if (!window) throw new Error('The measured native window is unavailable.')
    const state = () => {
      const destroyed = window.isDestroyed()
      return {
        epochMs: Date.now(),
        destroyed,
        focused: destroyed ? null : window.isFocused(),
        visible: destroyed ? null : window.isVisible(),
        minimized: destroyed ? null : window.isMinimized(),
        fullscreen: destroyed ? null : window.isFullScreen(),
      }
    }
    const start = state()
    let end: ReturnType<typeof state> | null = null
    const events: (ReturnType<typeof state> & { type: string })[] = []
    let droppedEvents = 0
    const listener = (type: string) => () => {
      if (events.length === 512) {
        events.shift()
        droppedEvents++
      }
      events.push({ type, ...state() })
    }
    const handlers = {
      focus: listener('focus'),
      blur: listener('blur'),
      show: listener('show'),
      hide: listener('hide'),
      minimize: listener('minimize'),
      restore: listener('restore'),
    }
    window.on('focus', handlers.focus)
    window.on('blur', handlers.blur)
    window.on('show', handlers.show)
    window.on('hide', handlers.hide)
    window.on('minimize', handlers.minimize)
    window.on('restore', handlers.restore)
    const snapshot = () => ({
      clock: 'Main process Date.now epoch milliseconds; comparable with each trial epochMs',
      start,
      end,
      current: state(),
      events: events.slice(),
      eventLimit: 512,
      retention: 'most recent events',
      droppedEvents,
      observedEvents: events.length + droppedEvents,
    })
    return {
      snapshot,
      stop() {
        if (!end) {
          window.removeListener('focus', handlers.focus)
          window.removeListener('blur', handlers.blur)
          window.removeListener('show', handlers.show)
          window.removeListener('hide', handlers.hide)
          window.removeListener('minimize', handlers.minimize)
          window.removeListener('restore', handlers.restore)
          end = state()
        }
        return snapshot()
      },
    }
  }, windowId)
}

for (const { layout, frequency, title } of cases)
  test(title, foregroundTest(reason), async ({ luma }, info) => {
    test.setTimeout(900000)
    const { app, page } = luma
    const nativeWindow = await app.browserWindow(page)
    const canvas = page.getByTestId('main-preview')
    const selection = editorCaseSelection(
      info,
      cases.map((entry) => entry.title),
      6,
    )
    const matrixPartial = selection.matrixPartial || sliders.length !== allSliders.length
    const scope = {
      ...selection,
      fullMatrixTrialCount: 6 * allSliders.length * 2 * 3,
      selectedTrialCount: selection.titleSelectedExecutionCount * sliders.length * 2 * 3,
      currentCaseExpectedTrialCount: sliders.length * 2 * 3,
      matrixPartial,
    }
    const trials: (Awaited<ReturnType<typeof matchedEditorInput>> & {
      repetition: number
      allocatedBytes: number
      visibleUpdateShortfall: number
      canvas: {
        width: number
        height: number
        cssWidth: number
        cssHeight: number
        dpr: number
      }
    })[] = []
    const path = info.outputPath('editor-responsiveness.json')
    const compiled = (await readdir('out', { recursive: true }))
      .filter((file) => /\.(?:js|cjs|css|html)$/.test(file))
      .map((file) => join('out', file))
      .sort()
    const source = {
      ...(await provenance([
        'tests/fixtures/sony-zv1.ARW',
        'tests/editor-responsiveness-benchmark.spec.ts',
        'tests/mac-workability.helpers.ts',
        'tests/editor-input-pacing.helpers.ts',
        'tests/editor-input-pacing.spec.ts',
        'tests/editor-responsiveness-profile.helpers.ts',
        'src/renderer/src/preview/hdr-presenter.ts',
        'src/renderer/src/preview/hdr-shader.ts',
        'src/renderer/src/preview/hdr-render-cache.ts',
        'src/renderer/src/preview/hdr-memory.ts',
        'src/shared/aces-preview-wgsl.ts',
        'src/shared/aces-wgsl.ts',
        'src/shared/aces-precision-wgsl.ts',
        ...compiled,
      ])),
      build:
        'Compiled production Electron application; actual React controls/history and completed GPU presentation.',
    }
    let environment: Record<string, unknown> = {}
    let nativeObservation: Awaited<ReturnType<typeof observeNativeWindow>> | undefined
    try {
      nativeObservation = await observeNativeWindow(
        app,
        await nativeWindow.evaluate((window) => window.id),
      )
      await nativeWindow.evaluate((window, { width, height }) => {
        window.unmaximize()
        window.setContentSize(width, height)
      }, layout)
      await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
      await confirmEditorDisplay(page, true)
      await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
      const toggle = page.getByTestId('console-toggle')
      if (((await toggle.getAttribute('aria-expanded')) === 'true') !== layout.consoleOpen)
        await toggle.click()
      const maximizedConfiguration = layout.maximized
        ? await maximizeEditorOnMonitor(app, page, {
            monitorLabel: process.env.LUMA_RESPONSIVENESS_MONITOR,
          })
        : null
      const windowState = await nativeWindow.evaluate((window) => ({
        fullscreen: window.isFullScreen(),
        maximized: window.isMaximized(),
        contentBounds: window.getContentBounds(),
        bounds: window.getBounds(),
      }))
      const display = await app.evaluate(({ screen }) =>
        screen.getAllDisplays().map((entry) => ({
          id: entry.id,
          bounds: entry.bounds,
          scaleFactor: entry.scaleFactor,
          displayFrequency: entry.displayFrequency,
          colorSpace: entry.colorSpace,
          internal: entry.internal,
        })),
      )
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }))
      environment = {
        displayPreference: editorDisplayPreference,
        displayProfile: editorDisplayProfile,
        expectedDpr: editorExpectedDpr,
        scope,
        windowState,
        maximizedConfiguration,
        display,
        physicalDisplay: await editorPhysicalDisplay(app, page),
        viewport,
        canvas: await canvas.evaluate((element: HTMLCanvasElement) => ({
          width: element.width,
          height: element.height,
          cssBounds: element.getBoundingClientRect().toJSON(),
        })),
        ...(await confirmEditorDisplay(page)),
        actualPolicy: await canvas.getAttribute('data-interactive-policy'),
        profileIsolation: 'electron.fixture temporary profile',
      }
      expect(windowState.fullscreen).toBe(false)
      expect(windowState.maximized).toBe(layout.maximized)
      if (!layout.maximized)
        expect(viewport).toMatchObject({ width: layout.width, height: layout.height })
      else {
        const bounds = await canvas.evaluate((element) => element.getBoundingClientRect().toJSON())
        await writeFile(
          info.outputPath('native-geometry.json'),
          JSON.stringify(
            {
              windowWidth: viewport.width,
              windowHeight: viewport.height,
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              dpr: viewport.dpr,
            },
            null,
            2,
          ),
        )
      }
      expect(await canvas.getAttribute('data-interactive-policy')).toBe(expectedPolicy)
      for (const zoom of ['fit', '100%'] as const)
        for (const label of sliders)
          for (let repetition = 0; repetition < 3; repetition++) {
            const trial = await matchedEditorInput(page, {
              label,
              zoom,
              frequency,
              pacing: frequency === 120 ? 'timer-deadline-v1' : 'native-raf',
            })
            trials.push({
              ...trial,
              repetition,
              allocatedBytes: Number(await canvas.getAttribute('data-allocated-bytes')),
              visibleUpdateShortfall: Math.max(0, 55 - trial.visibleUpdatesPerSecond),
              canvas: await canvas.evaluate((element: HTMLCanvasElement) => {
                const bounds = element.getBoundingClientRect()
                return {
                  width: element.width,
                  height: element.height,
                  cssWidth: bounds.width,
                  cssHeight: bounds.height,
                  dpr: devicePixelRatio,
                }
              }),
            })
            environment.nativeWindowActivity = await nativeObservation.evaluate((observer) =>
              observer.snapshot(),
            )
            await writeFile(
              path,
              JSON.stringify(
                {
                  provenance: source,
                  layout,
                  frequency,
                  matrixPartial,
                  sliders,
                  requestedPrecision,
                  expectedPolicy,
                  ...environment,
                  trials,
                },
                null,
                2,
              ),
            )
          }
    } catch (error) {
      environment.failure = String(error)
      throw error
    } finally {
      try {
        if (nativeObservation)
          environment.nativeWindowActivity = await nativeObservation
            .evaluate((observer) => observer.stop())
            .catch((error: unknown) => ({
              incomplete: true,
              error: String(error),
              epochMs: Date.now(),
            }))
        await writeFile(
          path,
          JSON.stringify(
            {
              provenance: source,
              layout,
              frequency,
              matrixPartial,
              sliders,
              requestedPrecision,
              expectedPolicy,
              ...environment,
              trials,
            },
            null,
            2,
          ),
        )
        await recordBenchmark(info, {
          family: 'hdr',
          measurements: {
            layout,
            frequency,
            matrixPartial,
            sliders,
            requestedPrecision,
            expectedPolicy,
            ...environment,
            clock:
              'renderer performance; completed GPU blit followed by a native animation frame; physical scanout unmeasured',
            histogramPolicy:
              'Independent nonblocking analysis; historical 33 ms latency gate recorded separately, final convergence required. First-visible gates include first-only final feedback; historical interaction-intent quantiles and duplicate exact refinement remain separate. All observations are retained in raw evidence.',
            trials: trials.map(
              ({
                inputs,
                requests,
                presentations,
                histograms,
                gpuObservations,
                publicationIdentities,
                pacing,
                ...trial
              }) => ({
                ...trial,
                pacing: editorInputPacingSummary(pacing),
                publicationIdentityCount: publicationIdentities.length,
                inputCount: inputs.length,
                presentationCount: presentations.length,
                observedRequestCount: requests.length,
                histogramCount: histograms.length,
                gpuSampleCount: gpuObservations.length,
                histogramHistorical33MsGatePassed:
                  trial.histogramP95Ms !== null && trial.histogramP95Ms <= 33,
              }),
            ),
          },
          gates: trials.flatMap((trial) =>
            [
              ['firstVisibleLatencyP95Ms', 33],
              ['firstVisibleLatencyP99Ms', 50],
              ['firstVisibleLatencyMaximumMs', 100],
              ['longestPresentationGapMs', 100],
              ['visibleUpdateShortfall', 0],
              ['refinementMs', 200],
              ['allocatedRamBytes', trial.ramBudgetBytes],
              ['allocatedGpuBytes', trial.vramBudgetBytes],
            ].map(([metric, limit]) => ({
              metric: `${trial.zoom}.${trial.label}.${trial.repetition}.${metric}`,
              operator: '<=' as const,
              limit: Number(limit),
            })),
          ),
          evidence: [path],
        })
        if (await nativeWindow.evaluate((window) => window.isFullScreen()))
          await nativeWindow.evaluate(
            (window) =>
              new Promise<void>((resolve) => {
                window.once('leave-full-screen', () => resolve())
                window.setFullScreen(false)
              }),
          )
      } finally {
        if (nativeObservation) {
          try {
            await nativeObservation.evaluate((observer) => observer.stop()).catch(() => undefined)
          } finally {
            await nativeObservation.dispose().catch(() => undefined)
          }
        }
      }
    }
    expect(trials).toHaveLength(sliders.length * 2 * 3)
    for (const trial of trials) {
      const context = `${layout.name} ${frequency}Hz ${trial.zoom} ${trial.label} #${trial.repetition}`
      expect.soft(trial.error, context).toBeUndefined()
      expect.soft(trial.backend, context).toBe('webgpu-hdr')
      expect.soft(trial.inputs.length, context).toBe(240)
      expect.soft(trial.draft, context).toBe(0)
      expect.soft(trial.sharp + trial.interactive, context).toBe(trial.completed)
      expect
        .soft(
          trial.presentations.every((frame) => frame.previewPolicy === expectedPolicy),
          context,
        )
        .toBe(true)
      if (requestedPrecision === 'f32') expect.soft(trial.interactive, context).toBeGreaterThan(0)
      else expect.soft(trial.interactive, context).toBe(0)
      expect
        .soft(
          trial.presentations.every(
            (frame) =>
              frame.presentedPolicy ===
              (frame.quality === 'interactive' ? expectedPolicy : 'reference'),
          ),
          context,
        )
        .toBe(true)
      expect.soft(trial.regressed, context).toBe(false)
      expect.soft(trial.attributionFailures, context).toBe(0)
      expect.soft(trial.baselineSourceMatched, context).toBe(true)
      expect.soft(trial.tileBatch, context).toBe(editorRequestedTileBatch)
      expect.soft(trial.presentedTargetMatches, context).toBe(true)
      expect.soft(trial.display.targets, context).toHaveLength(1)
      expect
        .soft(trial.pacingMode, context)
        .toBe(frequency === 120 ? 'timer-deadline-v1' : 'native-raf')
      expect.soft(trial.pacing?.omittedNativeRafSamples, context).toBe(0)
      expect.soft(trial.finalMatched, context).toBe(true)
      expect.soft(trial.histogramMatched, context).toBe(true)
      expect.soft(trial.sourceUploads, context).toBe(1)
      expect.soft(trial.loaders, context).toBe(0)
      expect.soft(trial.hidden, context).toBe(0)
      expect.soft(trial.sidebarMovement, context).toBeLessThan(0.1)
      expect.soft(trial.historyEntriesAdded, context).toBe(1)
      assertHdrMemory(trial, context, true)
      expect
        .soft(trial.canvas.width, context)
        .toBe(Math.round(trial.canvas.cssWidth * trial.canvas.dpr))
      expect
        .soft(trial.canvas.height, context)
        .toBe(Math.round(trial.canvas.cssHeight * trial.canvas.dpr))
    }
    test.skip(
      !editorConfigurationMatches(
        environment.viewport as { dpr: number },
        environment.physicalDisplay as Awaited<ReturnType<typeof editorPhysicalDisplay>>,
        trials,
      ) || trials.some((trial) => trial.achievedHz < frequency * 0.99),
      `Actual ${editorDisplayProfile} display configuration or 99% requested input cadence was not achieved; native refresh, pacing and every sample are retained. Configuration acceptance is incomplete.`,
    )
    for (const trial of trials) {
      const context = `${layout.name} ${frequency}Hz ${trial.zoom} ${trial.label} #${trial.repetition}`
      expect.soft(trial.firstVisibleLatencyP95Ms, context).not.toBeNull()
      expect.soft(trial.firstVisibleLatencyP95Ms!, context).toBeLessThanOrEqual(33)
      expect.soft(trial.firstVisibleLatencyP99Ms, context).not.toBeNull()
      expect.soft(trial.firstVisibleLatencyP99Ms!, context).toBeLessThanOrEqual(50)
      expect.soft(trial.firstVisibleLatencyMaximumMs, context).not.toBeNull()
      expect.soft(trial.firstVisibleLatencyMaximumMs!, context).toBeLessThanOrEqual(100)
      expect.soft(trial.longestPresentationGapMs, context).toBeLessThanOrEqual(100)
      expect
        .soft(trial.visibleUpdatesPerSecond, `${context}; not a 120 fps claim`)
        .toBeGreaterThanOrEqual(55)
      expect.soft(trial.refinementMs, context).toBeLessThanOrEqual(200)
    }
  })
