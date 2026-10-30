import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import type { WorkabilitySlider } from './mac-workability.helpers'
import {
  policyEditorInput as sustainedEditorInput,
  expectHdrTrialPolicy,
} from './hdr-test-policy.helpers'
import { provenance } from '../scripts/research/pipeline/provenance'

const reason =
  'Sustained editor acceptance measures native cadence and completed sharp presentation.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })

for (const [width, height, consoleOpen] of [
  [1100, 700, true],
  [1440, 900, false],
] as const)
  for (const frequency of [60, 120] as const)
    test(
      `sharp editor ${width}x${height} ${frequency}Hz: three 240-input trials for eight sliders at Fit and 100%`,
      foregroundTest(reason),
      async ({ irodori }, info) => {
        test.setTimeout(900000)
        const { app, page } = irodori
        await (
          await app.browserWindow(page)
        ).evaluate(
          (window, [width, height]) => {
            window.unmaximize()
            window.setContentSize(width, height)
          },
          [width, height],
        )
        await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal', {
          timeout: 60000,
        })
        if (consoleOpen) await page.getByTestId('console-toggle').click()
        const display = await app.evaluate(({ screen }) =>
          screen.getAllDisplays().map((display) => ({
            bounds: display.bounds,
            scaleFactor: display.scaleFactor,
            displayFrequency: display.displayFrequency,
            colorSpace: display.colorSpace,
            internal: display.internal,
          })),
        )
        const viewport = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        }))
        const trials = []
        const path = info.outputPath('sharp-interaction.json')
        const source = {
          ...(await provenance([
            'tests/fixtures/sony-zv1.ARW',
            'tests/mac-workability.helpers.ts',
            'tests/hdr-test-policy.helpers.ts',
            'src/renderer/src/preview/hdr-presenter.ts',
            'src/renderer/src/preview/hdr-shader.ts',
            'src/renderer/src/preview/hdr-gpu-timings.ts',
            'src/renderer/src/preview/hdr-render-cache.ts',
            'src/shared/aces-wgsl.ts',
            'src/shared/aces-preview-wgsl.ts',
            'src/shared/display-rendering-wgsl.ts',
            'src/shared/aces-precision-wgsl.ts',
            'src/shared/aces-data.ts',
          ])),
          build:
            'Production Electron application; actual React controls, history and GPU presentation.',
        }
        for (const zoom of ['fit', '100%'] as const)
          for (const label of [
            'Exposure',
            'Contrast',
            'Highlights',
            'Shadows',
            'Whites',
            'Blacks',
            'Temperature',
            'Tint',
          ] as WorkabilitySlider[])
            for (let repetition = 0; repetition < 3; repetition++) {
              const trial = await sustainedEditorInput(page, { label, zoom, frequency })
              trials.push({ repetition, ...trial })
              await writeFile(
                path,
                JSON.stringify(
                  { provenance: source, viewport, consoleOpen, display, trials },
                  null,
                  2,
                ),
              )
            }
        const metrics = trials.map(
          ({ inputs, requests, presentations, histograms, gpuObservations, ...trial }) => ({
            ...trial,
            inputCount: inputs.length,
            observedRequestCount: requests.length,
            presentationCount: presentations.length,
            histogramCount: histograms.length,
            observedGpuSampleCount: gpuObservations.length,
          }),
        )
        await recordBenchmark(info, {
          family: 'hdr',
          measurements: { viewport, consoleOpen, display, trials: metrics },
          gates: metrics.flatMap((trial) => [
            {
              metric: `${trial.zoom}.${trial.label}.${trial.repetition}.latencyP95Ms`,
              operator: '<=' as const,
              limit: 33,
            },
            {
              metric: `${trial.zoom}.${trial.label}.${trial.repetition}.histogramP95Ms`,
              operator: '<=' as const,
              limit: 33,
            },
            {
              metric: `${trial.zoom}.${trial.label}.${trial.repetition}.refinementMs`,
              operator: '<=' as const,
              limit: 500,
            },
          ]),
          evidence: [path],
        })
        expect(viewport).toMatchObject({ width, height })
        for (const [index, trial] of metrics.entries()) {
          const context = `${trial.zoom} ${trial.label} repetition ${trial.repetition}`
          expect.soft(trial.error, context).toBeUndefined()
          expect.soft(trial.backend, context).toBe('webgpu-hdr')
          expect.soft(trial.inputCount, context).toBe(240)
          expect.soft(trial.draft, context).toBe(0)
          expectHdrTrialPolicy(trials[index], context)
          expect.soft(trial.regressed, context).toBe(false)
          expect.soft(trial.attributionFailures, context).toBe(0)
          expect.soft(trial.finalMatched, context).toBe(true)
          expect.soft(trial.histogramMatched, context).toBe(true)
          expect.soft(trial.loaders, context).toBe(0)
          expect.soft(trial.hidden, context).toBe(0)
          expect.soft(trial.sidebarMovement, context).toBeLessThan(0.1)
          expect.soft(trial.historyEntriesAdded, context).toBe(1)
        }
        test.skip(
          viewport.dpr <= 1 || trials.some((trial) => trial.achievedHz < frequency * 0.99),
          `Retina DPR or ${frequency} Hz actual input did not meet the required configuration; all trial evidence is retained.`,
        )
        for (const trial of metrics) {
          const context = `${trial.zoom} ${trial.label} repetition ${trial.repetition}`
          expect.soft(trial.completedDuringInput, `${context} progress`).toBeGreaterThanOrEqual(160)
          expect
            .soft(trial.histogramsDuringInput, `${context} histogram progress`)
            .toBeGreaterThanOrEqual(160)
          expect.soft(trial.latencyP95Ms, context).not.toBeNull()
          expect.soft(trial.latencyP95Ms!, context).toBeLessThanOrEqual(33)
          expect.soft(trial.histogramP95Ms, `${context} histogram`).not.toBeNull()
          expect.soft(trial.histogramP95Ms!, `${context} histogram`).toBeLessThanOrEqual(33)
          expect.soft(trial.refinementMs, `${context} refinement`).toBeLessThanOrEqual(500)
        }
      },
    )
