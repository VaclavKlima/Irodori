import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { focusPreviewWindow } from './preview-pan.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { editorInputPacingSummary } from './editor-input-pacing.helpers'
import { sampleEditorMemory } from './editor-memory.helpers'
import {
  warmSpatialPath,
  sustainedSpatialInput,
  startSpatialDiagnostics,
  type SpatialDiagnostics,
  type SpatialGesture,
} from './editor-spatial-responsiveness.helpers'
import { assertHdrMemory } from './hdr-memory-policy.helpers'
import { hdrTestPolicy } from './hdr-test-policy.helpers'
import { provenance } from '../scripts/research/pipeline/provenance'
import { maximizeEditorOnMonitor } from './editor-native-window.helpers'
import {
  editorDisplayPreference,
  editorDisplayProfile,
  editorExpectedDpr,
  confirmEditorDisplay,
  editorPhysicalDisplay,
} from './editor-responsiveness-profile.helpers'

async function confirmSpatialDisplay(app: ElectronApplication, page: Page) {
  let physical: Awaited<ReturnType<typeof editorPhysicalDisplay>> | undefined
  try {
    await expect
      .poll(
        async () => {
          physical = await editorPhysicalDisplay(app, page)
          return physical.confirmedRendererMonitor.reliable
        },
        { timeout: 60000, message: 'Spatial warmup requires the confirmed current screen.' },
      )
      .toBe(true)
  } catch (error) {
    throw new Error(`Spatial display confirmation failed: ${JSON.stringify(physical)}`, {
      cause: error,
    })
  }
  const completed = await confirmEditorDisplay(page)
  expect(completed.target.generation, 'Display confirmation must retain the current target.').toBe(
    physical!.confirmedRendererMonitor.generation,
  )
  return { completed, physical: physical! }
}

const reason =
  'Spatial editor acceptance requires native focus, pointer capture and Retina presentation cadence.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })
const allGestures: SpatialGesture[] = ['pan', 'zoom', 'zoom-fit-native', 'drag']
// A filtered diagnostic retains its samples but cannot establish full spatial acceptance.
const selected = process.env.LUMA_RESPONSIVENESS_GESTURES?.split(',').map((value) => value.trim())
if (
  selected &&
  (selected.some((value) => !allGestures.includes(value as SpatialGesture)) ||
    new Set(selected).size !== selected.length)
)
  throw new Error(
    'LUMA_RESPONSIVENESS_GESTURES must contain distinct pan, zoom, zoom-fit-native or drag labels.',
  )
const gestures = (selected ?? allGestures) as SpatialGesture[]
const matrixPartial = gestures.length !== allGestures.length

for (const layout of [
  { name: '1100x700-console', width: 1100, height: 700, consoleOpen: true, maximized: false },
  { name: '1440x900', width: 1440, height: 900, consoleOpen: false, maximized: false },
  { name: 'native-maximized', width: 1440, height: 900, consoleOpen: false, maximized: true },
] as const)
  for (const frequency of [60, 120] as const)
    test(
      `spatial responsiveness ${layout.name} ${frequency}Hz: warm pan, zoom and native drag`,
      foregroundTest(reason),
      async ({ luma }, info) => {
        test.setTimeout(300000)
        const { app, page } = luma
        const native = await app.browserWindow(page)
        const canvas = page.getByTestId('main-preview')
        const viewport = page.getByTestId('preview-viewport')
        const trials: (Awaited<ReturnType<typeof sustainedSpatialInput>> & {
          repetition: number
          warmup: Awaited<ReturnType<typeof warmSpatialPath>>
          displayBeforeWarmup: Awaited<ReturnType<typeof confirmSpatialDisplay>>
          diagnostics?: SpatialDiagnostics
          visibleUpdateShortfall: number
        })[] = []
        const path = info.outputPath('editor-spatial-responsiveness.json')
        const compiled = (await readdir('out', { recursive: true }))
          .filter((file) => /\.(?:js|cjs|css|html)$/.test(file))
          .map((file) => join('out', file))
          .sort()
        const source = {
          ...(await provenance([
            'tests/editor-spatial-responsiveness-benchmark.spec.ts',
            'tests/editor-spatial-responsiveness.helpers.ts',
            'tests/editor-memory.helpers.ts',
            'tests/editor-input-pacing.helpers.ts',
            'tests/editor-input-pacing.spec.ts',
            'tests/preview-pan.helpers.ts',
            'tests/editor-responsiveness-profile.helpers.ts',
            'src/main/wayland-display.ts',
            'src/renderer/src/hooks/useDisplayState.ts',
            'tests/fixtures/sony-zv1.ARW',
            'src/renderer/src/preview/hdr-presenter.ts',
            'src/renderer/src/preview/hdr-shader.ts',
            'src/renderer/src/preview/hdr-render-cache.ts',
            'src/renderer/src/preview/pan-drag.ts',
            'src/renderer/src/preview/geometry.ts',
            ...compiled,
          ])),
          build:
            'Compiled production Electron application; real native-focused input handlers and completed normal-quality GPU presentation.',
        }
        const memoryTelemetry: {
          beforeTrials: Awaited<ReturnType<typeof sampleEditorMemory>> | null
          afterTrials: Awaited<ReturnType<typeof sampleEditorMemory>> | null
          expectedTrials: number
          completedTrials: number
        } = {
          beforeTrials: null,
          afterTrials: null,
          expectedTrials: gestures.length * 3,
          completedTrials: 0,
        }
        let environment: Record<string, unknown> = { memoryTelemetry }
        try {
          await native.evaluate((window, { width, height }) => {
            window.unmaximize()
            window.setContentSize(width, height)
          }, layout)
          await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
          await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
          await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
          const toggle = page.getByTestId('console-toggle')
          if (((await toggle.getAttribute('aria-expanded')) === 'true') !== layout.consoleOpen)
            await toggle.click()
          const maximizedConfiguration = layout.maximized
            ? await maximizeEditorOnMonitor(app, page, {
                monitorLabel: process.env.LUMA_RESPONSIVENESS_MONITOR,
              })
            : null
          if (editorDisplayPreference === 'sdr')
            await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
          await focusPreviewWindow(app, page)
          const displayConfirmation = await confirmSpatialDisplay(app, page)
          environment = {
            memoryTelemetry,
            displayConfirmation,
            maximizedConfiguration,
            displayProfile: editorDisplayProfile,
            expectedDpr: editorExpectedDpr,
            window: await native.evaluate((window) => ({
              fullscreen: window.isFullScreen(),
              maximized: window.isMaximized(),
              contentBounds: window.getContentBounds(),
              bounds: window.getBounds(),
            })),
            display: await app.evaluate(({ screen }) =>
              screen.getAllDisplays().map((display) => ({
                id: display.id,
                bounds: display.bounds,
                scaleFactor: display.scaleFactor,
                displayFrequency: display.displayFrequency,
                colorSpace: display.colorSpace,
                internal: display.internal,
              })),
            ),
            target: await page.evaluate(() => window.luma.getDisplayState()),
            profileIsolation: 'electron.fixture temporary profile',
            startingView:
              'Pan/drag at 100%; zoom 100–122%; zoom-fit-native repeatedly crosses Fit→100% around an off-center pointer anchor.',
            requestedInteractivePrecision: hdrTestPolicy.precision,
          }
          await expect
            .poll(
              () =>
                canvas.evaluate(
                  (element) =>
                    element.dataset.quality === 'normal' &&
                    element.dataset.completedEditSerial === element.dataset.requestedSerial &&
                    element.dataset.analysisPending === 'false' &&
                    !!element.dataset.analysisKey &&
                    element.dataset.analysisKey === element.dataset.displayedAnalysisKey,
                ),
              { timeout: 60000 },
            )
            .toBe(true)
          // Explicit snapshots never run during the calibrated input clock.
          memoryTelemetry.beforeTrials = await sampleEditorMemory(app, 'before-trials')
          for (const gesture of gestures)
            for (let repetition = 0; repetition < 3; repetition++) {
              await page
                .getByRole('combobox', { name: 'Preview zoom', exact: true })
                .selectOption('fit')
              if (gesture !== 'zoom-fit-native')
                await page
                  .getByRole('combobox', { name: 'Preview zoom', exact: true })
                  .selectOption('1')
              await focusPreviewWindow(app, page)
              const displayBeforeWarmup = await confirmSpatialDisplay(app, page)
              await expect
                .poll(() =>
                  canvas.evaluate(
                    (element) =>
                      element.dataset.quality === 'normal' &&
                      element.dataset.completedEditSerial === element.dataset.requestedSerial &&
                      element.dataset.analysisPending === 'false' &&
                      !!element.dataset.analysisKey &&
                      element.dataset.analysisKey === element.dataset.displayedAnalysisKey,
                  ),
                )
                .toBe(true)
              const warmup = await warmSpatialPath(
                page,
                gesture,
                displayBeforeWarmup.completed.target.generation,
              )
              const box = (await viewport.boundingBox())!
              const cursor = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
              const diagnostics = await startSpatialDiagnostics(app, page)
              let completedTrial: (typeof trials)[number] | undefined
              try {
                if (gesture === 'drag') await focusPreviewWindow(app, page)
                await page.mouse.move(cursor.x, cursor.y)
                if (gesture === 'drag') {
                  await page.mouse.down()
                  await expect
                    .poll(() =>
                      viewport.evaluate((element) => document.pointerLockElement === element),
                    )
                    .toBe(true)
                  await expect(viewport).toHaveCSS('cursor', 'none')
                }
                const trial = await sustainedSpatialInput(page, {
                  gesture,
                  frequency,
                  cursor,
                  targetGeneration: Number(warmup.targetGeneration),
                  pacing: frequency === 120 ? 'timer-deadline-v1' : 'native-raf',
                })
                completedTrial = {
                  ...trial,
                  repetition,
                  warmup,
                  displayBeforeWarmup,
                  visibleUpdateShortfall: Math.max(0, 55 - trial.visibleUpdatesPerSecond),
                }
                trials.push(completedTrial)
              } finally {
                try {
                  if (gesture === 'drag') await page.mouse.up()
                  await expect
                    .poll(() => page.evaluate(() => document.pointerLockElement === null))
                    .toBe(true)
                } finally {
                  const trace = await diagnostics.finish()
                  if (completedTrial) completedTrial.diagnostics = trace
                  else
                    environment.failedSpatialSetup = {
                      gesture,
                      repetition,
                      displayBeforeWarmup,
                      warmup,
                      diagnostics: trace,
                    }
                  await writeFile(
                    path,
                    JSON.stringify(
                      {
                        provenance: source,
                        layout,
                        frequency,
                        gestures,
                        matrixPartial,
                        ...environment,
                        trials,
                      },
                      null,
                      2,
                    ),
                  )
                }
              }
            }
        } catch (error) {
          environment.failure = String(error)
          throw error
        } finally {
          try {
            memoryTelemetry.completedTrials = trials.length
            memoryTelemetry.afterTrials = await sampleEditorMemory(
              app,
              trials.length === memoryTelemetry.expectedTrials
                ? 'after-all-trials'
                : 'after-partial-trials',
            )
            await writeFile(
              path,
              JSON.stringify(
                {
                  provenance: source,
                  layout,
                  frequency,
                  gestures,
                  matrixPartial,
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
                gestures,
                matrixPartial,
                ...environment,
                clock:
                  'Renderer performance timestamp before event dispatch through image-final-blit completion plus a following native rAF; physical input/scanout unmeasured.',
                observation:
                  'Only fenced publications surviving the following rAF are visible updates; observed request coalescing and unpublished inputs remain explicit. Release glide is included in refinement.',
                trials: trials.map(
                  ({
                    inputs,
                    requests,
                    publications,
                    presentations,
                    changedPresentations,
                    duplicatePresentations,
                    analysisObservations,
                    displayTargets,
                    displayBeforeWarmup,
                    diagnostics,
                    warmup,
                    pacing,
                    ...trial
                  }) => ({
                    ...trial,
                    pacing: editorInputPacingSummary(pacing),
                    inputCount: inputs.length,
                    requestCount: requests.length,
                    publicationCount: publications.length,
                    visiblePresentationCount: changedPresentations.length,
                    observedVisibleRecordCount: presentations.length,
                    observedDuplicateVisibleRecords: duplicatePresentations.length,
                    analysisObservationCount: analysisObservations.length,
                    displayTargetUpdateCount: displayTargets.length,
                    displayGenerationBeforeWarmup: displayBeforeWarmup.completed.target.generation,
                    nativeTransitionCount: diagnostics?.native.events.length,
                    rendererTransitionCount: diagnostics?.renderer.events.length,
                    warmupInputs: warmup.inputs.length,
                  }),
                ),
              },
              gates: trials.flatMap((trial) =>
                [
                  ['latencyP95Ms', 33],
                  ['latencyP99Ms', 50],
                  ['latencyMaximumMs', 100],
                  ['longestPresentationGapMs', 100],
                  ['visibleUpdateShortfall', 0],
                  ['refinementMs', 200],
                  ['allocatedRamBytes', trial.ramBudgetBytes],
                  ['allocatedGpuBytes', trial.vramBudgetBytes],
                ].map(([metric, limit]) => ({
                  metric: `${trial.gesture}.${trial.repetition}.${metric}`,
                  operator: '<=' as const,
                  limit: Number(limit),
                })),
              ),
              evidence: [path],
            })
          } finally {
            await page.mouse.up()
            await native.evaluate((window) => window.unmaximize())
          }
        }
        expect(trials).toHaveLength(gestures.length * 3)
        for (const trial of trials) {
          const context = `${layout.name} ${frequency}Hz ${trial.gesture} #${trial.repetition}`
          expect.soft(trial.error, context).toBeUndefined()
          expect.soft(trial.backend, context).toBe('webgpu-hdr')
          expect.soft(trial.inputs.length, context).toBe(120)
          expect.soft(trial.regressed, context).toBe(false)
          expect.soft(trial.attributionFailures, context).toBe(0)
          expect
            .soft(trial.pacingMode, context)
            .toBe(frequency === 120 ? 'timer-deadline-v1' : 'native-raf')
          expect.soft(trial.pacing?.omittedNativeRafSamples, context).toBe(0)
          expect
            .soft(
              trial.publications.every(
                (frame) => frame.quality === 'normal' && frame.presentedPolicy === 'reference',
              ),
              context,
            )
            .toBe(true)
          expect.soft(trial.policy, context).toBe(hdrTestPolicy.interactivePolicy)
          expect.soft(trial.histogramUpdates, context).toBe(0)
          expect.soft(trial.histogramUnchanged, context).toBe(true)
          expect.soft(trial.histogramCurveUnchanged, context).toBe(true)
          expect.soft(trial.finalAnalysisSettled, context).toBe(true)
          expect.soft(trial.omittedAnalysisObservations, context).toBe(0)
          expect.soft(trial.omittedDisplayTargets, context).toBe(0)
          expect(trial.targetChangedDuringInput, context).toBe(false)
          expect(trial.initialTargetGeneration, context).toBe(trial.expectedTargetGeneration)
          expect
            .soft(trial.expectedTargetGeneration, context)
            .toBe(trial.displayBeforeWarmup.completed.target.generation)
          expect.soft(trial.diagnostics?.native.omitted, context).toBe(0)
          expect.soft(trial.diagnostics?.renderer.omitted, context).toBe(0)
          if (trial.gesture === 'drag') expect(trial.nativePointerLock, context).toBe(true)
          expect.soft(trial.historyUnchanged, context).toBe(true)
          expect.soft(trial.editsUnchanged, context).toBe(true)
          expect.soft(trial.uploadsBefore, context).toBe(1)
          expect.soft(trial.uploadsAfter, context).toBe(trial.uploadsBefore)
          expect
            .soft(trial.renderedAfter, `${context} warmed tile reuse`)
            .toBe(trial.renderedBefore)
          expect.soft(trial.finalNormal, context).toBe(true)
          expect.soft(trial.captureReleased, context).toBe(true)
          expect.soft(trial.loaders, context).toBe(0)
          expect.soft(trial.hidden, context).toBe(0)
          assertHdrMemory(trial, context, true)
          if (!layout.maximized)
            expect
              .soft(trial.viewport, context)
              .toMatchObject({ width: layout.width, height: layout.height })
        }
        test.skip(
          trials.some(
            (trial) =>
              trial.viewport.dpr !== editorExpectedDpr || trial.achievedHz < frequency * 0.99,
          ),
          `DPR ${editorExpectedDpr} or 99% requested input cadence was not achieved; pacing mode, native rAF samples and dispatch lateness are retained separately. Configuration acceptance is incomplete.`,
        )
        for (const trial of trials) {
          const context = `${layout.name} ${frequency}Hz ${trial.gesture} #${trial.repetition}`
          expect.soft(trial.latencyP95Ms, context).not.toBeNull()
          expect.soft(trial.latencyP95Ms!, context).toBeLessThanOrEqual(33)
          expect.soft(trial.latencyP99Ms, context).not.toBeNull()
          expect.soft(trial.latencyP99Ms!, context).toBeLessThanOrEqual(50)
          expect.soft(trial.latencyMaximumMs, context).not.toBeNull()
          expect.soft(trial.latencyMaximumMs!, context).toBeLessThanOrEqual(100)
          expect.soft(trial.longestPresentationGapMs, context).toBeLessThanOrEqual(100)
          expect
            .soft(trial.visibleUpdatesPerSecond, `${context}; 120 fps is not assumed`)
            .toBeGreaterThanOrEqual(55)
          expect.soft(trial.refinementMs, context).toBeLessThanOrEqual(200)
        }
      },
    )
