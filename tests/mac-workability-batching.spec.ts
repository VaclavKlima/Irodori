import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import {
  policyEditorInput as sustainedEditorInput,
  expectHdrTrialPolicy,
  expectReferenceHdrPreview,
  hdrTestPolicy,
} from './hdr-test-policy.helpers'
import { HDR_PRESENTATION_BUDGET } from '../src/renderer/src/preview/hdr-memory'
import { provenance } from '../scripts/research/pipeline/provenance'

const reason =
  'Application tile batching compares completed sharp editor frames and cancellation on the native desktop.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })
const candidate = process.env.VITE_LUMA_HDR_TILE_BATCH === '8' ? 8 : 32

for (const [width, height, consoleOpen] of [
  [1100, 700, true],
  [1440, 900, false],
] as const)
  test(
    `application ${candidate}-tile batches at ${width}x${height}: three 240-input Exposure trials`,
    foregroundTest(reason),
    async ({ luma }, info) => {
      test.setTimeout(180000)
      const { app, page } = luma
      await (
        await app.browserWindow(page)
      ).evaluate((window, [width, height]) => window.setContentSize(width, height), [width, height])
      await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-tile-batch', String(candidate))
      if (consoleOpen) await page.getByTestId('console-toggle').click()
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }))
      const trials = []
      const path = info.outputPath('application-batching.json')
      const source = {
        ...(await provenance([
          'tests/fixtures/sony-zv1.ARW',
          'tests/mac-workability.helpers.ts',
          'tests/hdr-test-policy.helpers.ts',
          'src/renderer/src/preview/hdr-presenter.ts',
          'src/renderer/src/preview/hdr-shader.ts',
          'src/renderer/src/preview/hdr-gpu-timings.ts',
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
        for (let repetition = 0; repetition < 3; repetition++) {
          const trial = await sustainedEditorInput(page, { label: 'Exposure', zoom, frequency: 60 })
          const allocatedBytes = Number(await canvas.getAttribute('data-allocated-bytes'))
          trials.push({
            repetition,
            allocatedBytes,
            ...trial,
            progressShortfall: Math.max(0, 160 - trial.completedDuringInput),
            histogramShortfall: Math.max(0, 160 - trial.histogramsDuringInput),
          })
          await writeFile(
            path,
            JSON.stringify(
              { provenance: source, candidate, viewport, consoleOpen, trials },
              null,
              2,
            ),
          )
        }
      await recordBenchmark(info, {
        family: 'hdr',
        measurements: {
          candidate,
          viewport,
          consoleOpen,
          trials: trials.map(
            ({ inputs, requests, presentations, histograms, gpuObservations, ...trial }) => ({
              ...trial,
              inputCount: inputs.length,
              observedRequestCount: requests.length,
              presentationCount: presentations.length,
              histogramCount: histograms.length,
              observedGpuSampleCount: gpuObservations.length,
            }),
          ),
        },
        gates: trials.flatMap((trial) => [
          {
            metric: `${trial.zoom}.${trial.repetition}.latencyP95Ms`,
            operator: '<=' as const,
            limit: 33,
          },
          {
            metric: `${trial.zoom}.${trial.repetition}.histogramP95Ms`,
            operator: '<=' as const,
            limit: 33,
          },
          {
            metric: `${trial.zoom}.${trial.repetition}.progressShortfall`,
            operator: '<=' as const,
            limit: 0,
          },
          {
            metric: `${trial.zoom}.${trial.repetition}.histogramShortfall`,
            operator: '<=' as const,
            limit: 0,
          },
          {
            metric: `${trial.zoom}.${trial.repetition}.refinementMs`,
            operator: '<=' as const,
            limit: 500,
          },
        ]),
        evidence: [path],
      })
      for (const trial of trials) {
        const context = `${candidate} tiles ${trial.zoom} repetition ${trial.repetition}`
        expect.soft(trial.error, context).toBeUndefined()
        expect.soft(trial.inputs.length, context).toBe(240)
        expect.soft(trial.draft, context).toBe(0)
        expectHdrTrialPolicy(trial, context)
        expect.soft(trial.regressed, context).toBe(false)
        expect.soft(trial.attributionFailures, context).toBe(0)
        expect.soft(trial.finalMatched, context).toBe(true)
        expect.soft(trial.histogramMatched, context).toBe(true)
        expect.soft(trial.sourceUploads, context).toBe(1)
        expect.soft(trial.allocatedBytes, context).toBeLessThanOrEqual(HDR_PRESENTATION_BUDGET)
        expect.soft(trial.sidebarMovement, context).toBeLessThan(0.1)
        expect.soft(trial.historyEntriesAdded, context).toBe(1)
      }
      test.skip(
        trials.some((trial) => trial.achievedHz < 59.4),
        'Native input did not sustain 99% of 60 Hz; candidate comparison is incomplete and all evidence is retained.',
      )
      for (const trial of trials) {
        expect.soft(trial.completedDuringInput).toBeGreaterThanOrEqual(160)
        expect.soft(trial.histogramsDuringInput).toBeGreaterThanOrEqual(160)
        expect.soft(trial.latencyP95Ms).not.toBeNull()
        expect.soft(trial.latencyP95Ms!).toBeLessThanOrEqual(33)
        expect.soft(trial.histogramP95Ms).not.toBeNull()
        expect.soft(trial.histogramP95Ms!).toBeLessThanOrEqual(33)
        expect.soft(trial.refinementMs).toBeLessThanOrEqual(500)
      }
    },
  )

test(
  `application ${candidate}-tile batches reject cold work after history, comparison, display and source invalidation`,
  foregroundTest(reason),
  async ({ luma }, info) => {
    test.setTimeout(180000)
    const { app, page } = luma
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1440, 900))
    await importPhotos(
      app,
      page,
      ['tests/fixtures/sony-zv1.ARW', 'tests/fixtures/research-sony/originals/DSC03246.ARW'],
      false,
    )
    await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-tile-batch', String(candidate))
    await canvas.focus()
    await canvas.press('1')
    const measurements = []
    for (const invalidation of ['history', 'comparison', 'display', 'source'] as const) {
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      const before = page.getByRole('button', { name: 'Before', exact: true })
      if ((await before.getAttribute('aria-pressed')) === 'true') await before.click()
      await page.getByLabel('Preview display mode').selectOption('hdr')
      await expect
        .poll(() =>
          canvas.evaluate(
            (element) =>
              element.dataset.analysisPending === 'false' &&
              element.dataset.analysisKey === element.dataset.displayedAnalysisKey,
          ),
        )
        .toBe(true)
      await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
        const device = canvas.getContext('webgpu')!.getConfiguration()!.device
        await device.queue.onSubmittedWorkDone()
        const native = GPUQueue.prototype.onSubmittedWorkDone
        let release!: () => void
        const pending = new Promise<void>((resolve) => {
          release = resolve
        })
        const state = {
          blocked: false,
          observed: [] as {
            exposure: string | undefined
            comparison: string | undefined
            generation: string | undefined
          }[],
        }
        GPUQueue.prototype.onSubmittedWorkDone = async function () {
          await native.call(this)
          if (this === device.queue && !state.blocked) {
            state.blocked = true
            await pending
          }
        }
        const observer = new MutationObserver(() =>
          state.observed.push({
            exposure: canvas.dataset.exposure,
            comparison: canvas.dataset.comparison,
            generation: canvas.dataset.targetGeneration,
          }),
        )
        observer.observe(canvas, {
          attributes: true,
          attributeFilter: ['data-completed-edit-serial'],
        })
        Object.assign(window, {
          batchCancellation: {
            state,
            release: () => {
              GPUQueue.prototype.onSubmittedWorkDone = native
              release()
            },
            stop: () => observer.disconnect(),
          },
        })
      })
      const changedExposure = await page.evaluate(async () => {
        const photo = (await window.luma.listPhotos()).photos.find(
          (photo) => photo.filename === 'sony-zv1.ARW',
        )!
        const edits = await window.luma.getEdits(photo.id)
        const value = edits.settings.exposureEv === 0.75 ? 0.5 : 0.75
        await window.luma.updateEdits(photo.id, { exposureEv: value }, edits.revision)
        return value
      })
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { batchCancellation: { state: { blocked: boolean } } })
                .batchCancellation.state.blocked,
          ),
        )
        .toBe(true)
      const started = Date.now()
      try {
        if (invalidation === 'history')
          await page.evaluate(async () => {
            const photo = (await window.luma.listPhotos()).photos.find(
              (photo) => photo.filename === 'sony-zv1.ARW',
            )!
            await window.luma.undoEdit(photo.id, (await window.luma.getEdits(photo.id)).revision)
          })
        else if (invalidation === 'comparison')
          await page.getByRole('button', { name: 'Before', exact: true }).click()
        else if (invalidation === 'display')
          await page.getByLabel('Preview display mode').selectOption('sdr')
        else await page.getByRole('button', { name: 'Select DSC03246.ARW', exact: true }).click()
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        )
      } finally {
        await page.evaluate(() =>
          (
            window as unknown as { batchCancellation: { release: () => void } }
          ).batchCancellation.release(),
        )
      }
      if (invalidation === 'source')
        await expect(canvas).toHaveAttribute('aria-label', 'DSC03246.ARW')
      if (invalidation === 'comparison')
        await expect(canvas).toHaveAttribute('data-comparison', 'before')
      if (invalidation === 'display')
        await expect
          .poll(() => page.evaluate(() => window.luma.getDisplayState()))
          .toMatchObject({ mode: 'sdr' })
      await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
      await expect
        .poll(() =>
          canvas.evaluate(
            (element) =>
              element.dataset.presentedPolicy === 'reference' &&
              element.dataset.gesturing === 'false' &&
              element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        )
        .toBe(true)
      const result = await page.evaluate(() => {
        const state = (
          window as unknown as {
            batchCancellation: {
              state: { observed: { exposure?: string; comparison?: string; generation?: string }[] }
              stop: () => void
            }
          }
        ).batchCancellation
        state.stop()
        const canvas = document.querySelector<HTMLElement>('[data-testid="main-preview"]')!
        return {
          ...state.state,
          allocatedBytes: Number(canvas.dataset.allocatedBytes),
          generation: canvas.dataset.targetGeneration,
          exposure: canvas.dataset.exposure,
          backend: canvas.dataset.backend,
          quality: canvas.dataset.quality,
          presentedPolicy: canvas.dataset.presentedPolicy,
          previewPolicy: canvas.dataset.interactivePolicy,
        }
      })
      const latencyMs = Date.now() - started
      measurements.push({
        candidate,
        policy: hdrTestPolicy,
        invalidation,
        latencyMs,
        changedExposure,
        ...result,
      })
      await writeFile(
        info.outputPath('batch-cancellation.json'),
        JSON.stringify(measurements, null, 2),
      )
      await recordBenchmark(info, {
        family: 'hdr',
        measurements: { candidate, invalidation, latencyMs, changedExposure, ...result },
        gates: [
          { metric: 'allocatedBytes', operator: '<=' as const, limit: HDR_PRESENTATION_BUDGET },
          ...(invalidation === 'source'
            ? []
            : [{ metric: 'latencyMs', operator: '<=' as const, limit: 500 }]),
        ],
        evidence: [info.outputPath('batch-cancellation.json')],
      })
      expect(result.backend).toBe('webgpu-hdr')
      await expectReferenceHdrPreview(page)
      expect(result.allocatedBytes).toBeLessThanOrEqual(HDR_PRESENTATION_BUDGET)
      if (invalidation === 'history')
        expect(result.observed.every((frame) => frame.exposure !== String(changedExposure))).toBe(
          true,
        )
      if (invalidation === 'comparison')
        expect(result.observed.every((frame) => frame.comparison === 'before')).toBe(true)
      if (invalidation === 'display')
        expect(result.observed.every((frame) => frame.generation === result.generation)).toBe(true)
      if (invalidation === 'source') expect(result.observed).toEqual([])
      if (invalidation !== 'source') expect(latencyMs).toBeLessThanOrEqual(500)
    }
  },
)
