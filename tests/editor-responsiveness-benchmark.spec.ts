import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import { sustainedEditorInput, type WorkabilitySlider } from './mac-workability.helpers'
import { editorInputPacingSummary } from './editor-input-pacing.helpers'
import { HDR_PRESENTATION_BUDGET } from '../src/renderer/src/preview/hdr-memory'
import { ACES_INTERACTIVE_PREVIEW_VERSION } from '../src/shared/aces-preview-wgsl'
import { provenance } from '../scripts/research/pipeline/provenance'

const reason = 'Editor responsiveness measures native Retina cadence and completed visible updates.'
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
const matrixPartial = sliders.length !== allSliders.length
const requestedPrecision = process.env.VITE_LUMA_HDR_INTERACTIVE_PRECISION ?? 'reference'
if (!['reference', 'f32'].includes(requestedPrecision))
  throw new Error('VITE_LUMA_HDR_INTERACTIVE_PRECISION must be unset or f32.')
const expectedPolicy = requestedPrecision === 'f32' ? ACES_INTERACTIVE_PREVIEW_VERSION : 'reference'
const displayPreference = process.env.LUMA_RESPONSIVENESS_DISPLAY ?? 'auto'
if (displayPreference !== 'auto' && displayPreference !== 'sdr')
  throw new Error('LUMA_RESPONSIVENESS_DISPLAY must be auto or sdr.')

for (const layout of [
  { name: '1100x700-console', width: 1100, height: 700, consoleOpen: true, fullscreen: false },
  { name: '1440x900', width: 1440, height: 900, consoleOpen: false, fullscreen: false },
  { name: 'native-fullscreen', width: 1440, height: 900, consoleOpen: false, fullscreen: true },
] as const)
  for (const frequency of [60, 120] as const)
    test(
      `editor responsiveness ${layout.name} ${frequency}Hz: three trials at Fit and 100%`,
      foregroundTest(reason),
      async ({ luma }, info) => {
        test.setTimeout(900000)
        const { app, page } = luma
        const nativeWindow = await app.browserWindow(page)
        const canvas = page.getByTestId('main-preview')
        const trials: (Awaited<ReturnType<typeof sustainedEditorInput>> & {
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
        try {
          await nativeWindow.evaluate((window, { width, height }) => {
            window.unmaximize()
            window.setContentSize(width, height)
          }, layout)
          await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
          if (displayPreference === 'sdr')
            await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
          await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
          const toggle = page.getByTestId('console-toggle')
          if (((await toggle.getAttribute('aria-expanded')) === 'true') !== layout.consoleOpen)
            await toggle.click()
          if (layout.fullscreen)
            await nativeWindow.evaluate(
              (window) =>
                new Promise<void>((resolve) => {
                  window.once('enter-full-screen', () => resolve())
                  window.setFullScreen(true)
                }),
            )
          const windowState = await nativeWindow.evaluate((window) => ({
            fullscreen: window.isFullScreen(),
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
            displayPreference,
            windowState,
            display,
            viewport,
            canvas: await canvas.evaluate((element: HTMLCanvasElement) => ({
              width: element.width,
              height: element.height,
              cssBounds: element.getBoundingClientRect().toJSON(),
            })),
            target: await page.evaluate(() => window.luma.getDisplayState()),
            actualPolicy: await canvas.getAttribute('data-interactive-policy'),
            profileIsolation: 'electron.fixture temporary profile',
          }
          expect(windowState.fullscreen).toBe(layout.fullscreen)
          if (!layout.fullscreen)
            expect(viewport).toMatchObject({ width: layout.width, height: layout.height })
          expect(await canvas.getAttribute('data-interactive-policy')).toBe(expectedPolicy)
          for (const zoom of ['fit', '100%'] as const)
            for (const label of sliders)
              for (let repetition = 0; repetition < 3; repetition++) {
                const trial = await sustainedEditorInput(page, {
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
                ['allocatedBytes', HDR_PRESENTATION_BUDGET],
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
          if (requestedPrecision === 'f32')
            expect.soft(trial.interactive, context).toBeGreaterThan(0)
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
          expect.soft(trial.allocatedBytes, context).toBeGreaterThan(0)
          expect.soft(trial.allocatedBytes, context).toBeLessThanOrEqual(HDR_PRESENTATION_BUDGET)
          expect
            .soft(trial.canvas.width, context)
            .toBe(Math.round(trial.canvas.cssWidth * trial.canvas.dpr))
          expect
            .soft(trial.canvas.height, context)
            .toBe(Math.round(trial.canvas.cssHeight * trial.canvas.dpr))
        }
        test.skip(
          (environment.viewport as { dpr: number }).dpr !== 2 ||
            trials.some((trial) => trial.achievedHz < frequency * 0.99),
          'Actual DPR 2 or 99% requested input cadence was not achieved; pacing mode, native rAF samples and dispatch lateness are retained separately. Configuration acceptance is incomplete.',
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
      },
    )
