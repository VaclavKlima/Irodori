import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import { provenance } from '../scripts/research/pipeline/provenance'
import { verifyMaster } from '../src/main/merge/store'
import { GPU_CAMERA_PREPARATION, GPU_REFERENCE_PREPARATION } from '../src/shared/merge'

const reason =
  'Comparable HDR workflow timing requires visible native review and editor presentation.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })

async function identity(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size }
}

async function bracket() {
  const root = resolve('tests/fixtures/research-sony'),
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      sequences: { id: string; complete: boolean; files: string[] }[]
      files: { name: string; path: string; sha256: string; bytes: number }[]
    },
    sequence = manifest.sequences.find((sequence) => sequence.id === 'hdr-brk')!
  expect(sequence.complete).toBe(true)
  expect(sequence.files).toHaveLength(3)
  const sources = []
  for (const name of sequence.files) {
    const entry = manifest.files.find((entry) => entry.name === name)!,
      path = resolve(root, entry.path)
    expect(path.startsWith(`${root}${sep}`)).toBe(true)
    expect(await identity(path)).toEqual({ sha256: entry.sha256, bytes: entry.bytes })
    sources.push({ ...entry, path })
  }
  return sources
}

async function selectSources(page: Page, ids: string[]) {
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  for (const stack of (await page.evaluate(() => window.irodori.listStacks())).stacks) {
    if (stack.expanded) continue
    const cover = photos.find((photo) => photo.id === stack.coverId)!
    await page
      .getByRole('button', {
        name: `Expand stack for ${cover.filename}, ${stack.count} photos`,
        exact: true,
      })
      .click()
  }
  await page.getByTestId(`photo-card-${ids[0]}`).click()
  for (const id of ids.slice(1))
    await page.getByTestId(`photo-card-${id}`).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 60000,
  })
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
}

async function workflow(page: Page) {
  return page
    .getByRole('menuitem', { name: 'Merge selected photos to HDR…' })
    .evaluate(async (command) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        afterPaint = () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
        wait = async (predicate: () => boolean, description: string) => {
          const deadline = performance.now() + 180000
          while (!predicate()) {
            const error = document.querySelector('[role="alert"]')?.textContent
            if (error) throw new Error(error)
            if (performance.now() > deadline) throw new Error(description)
            await frame()
          }
        },
        known = new Set((await window.irodori.listTasks()).map((task) => task.id)),
        started = performance.now()
      ;(command as HTMLElement).click()
      await wait(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="merge-preview"]')
        return (
          document.querySelector<HTMLElement>('[data-testid="merge-viewport"]')?.dataset.ready ===
            'true' &&
          Number(canvas?.dataset.frames) > 0 &&
          Math.max(Number(canvas?.dataset.imageWidth), Number(canvas?.dataset.imageHeight)) >
            5000 &&
          Array.from(document.querySelectorAll('button')).some(
            (button) => button.textContent === 'Merge' && !button.disabled,
          )
        )
      }, 'Native review did not decode and draw.')
      const reviewDrawObserved = performance.now(),
        reviewCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="merge-preview"]')!,
        review = {
          width: Number(reviewCanvas.dataset.imageWidth),
          height: Number(reviewCanvas.dataset.imageHeight),
          frames: Number(reviewCanvas.dataset.frames),
          backend: reviewCanvas.dataset.backend,
        }
      if (review.backend === 'webgl2') {
        const gl = reviewCanvas.getContext('webgl2')!,
          fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!
        gl.flush()
        try {
          const deadline = performance.now() + 5000
          while (true) {
            const status = gl.clientWaitSync(fence, 0, 0)
            if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break
            if (status === gl.WAIT_FAILED || performance.now() > deadline)
              throw new Error('Review draw fence failed.')
            await frame()
          }
        } finally {
          gl.deleteSync(fence)
        }
      }
      await afterPaint()
      const reviewPresented = performance.now(),
        accept = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent === 'Merge' && !button.disabled,
        )!,
        accepted = performance.now()
      accept.click()
      let task: Awaited<ReturnType<typeof window.irodori.listTasks>>[number] | undefined
      const deadline = performance.now() + 180000
      while (!task?.finishedAt) {
        task = (await window.irodori.listTasks()).find(
          (task) => task.kind === 'merge' && !known.has(task.id),
        )
        if (performance.now() > deadline) throw new Error('Publication and cleanup did not finish.')
        if (!task?.finishedAt) await frame()
      }
      const publicationAndCleanupObserved = performance.now()
      if (task.status !== 'completed')
        throw new Error(`Merge ${task.status}: ${JSON.stringify(task)}`)
      await wait(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
        return (
          !!canvas?.dataset.src?.includes(task!.resultPhotoId!) &&
          canvas.dataset.editing === 'ready' &&
          canvas.dataset.quality === 'normal' &&
          Number(canvas.dataset.presentationSerial) > 0 &&
          getComputedStyle(canvas).visibility === 'visible' &&
          !document.querySelector('dialog[open]')
        )
      }, 'Published master did not finish editor presentation.')
      const editorDrawObserved = performance.now()
      await afterPaint()
      const finished = performance.now(),
        canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      return {
        clock:
          'renderer performance.now; uninterrupted command click through final editor post-paint task',
        timeOrigin: performance.timeOrigin,
        started,
        reviewDrawObserved,
        reviewPresented,
        accepted,
        publicationAndCleanupObserved,
        editorDrawObserved,
        finished,
        completeOperationMs: finished - started,
        nativeReviewMs: reviewPresented - started,
        reviewDrawToPostPaintMs: reviewPresented - reviewDrawObserved,
        reviewToAcceptanceMs: accepted - reviewPresented,
        publicationAndCleanupMs: publicationAndCleanupObserved - accepted,
        finalEditorPresentationMs: finished - publicationAndCleanupObserved,
        review,
        editor: {
          backend: canvas.dataset.backend,
          quality: canvas.dataset.quality,
          presentationSerial: Number(canvas.dataset.presentationSerial),
          frameTimings: canvas.dataset.frameTimings,
        },
        task,
      }
    })
}

for (const restartControl of [false, true])
  test(
    restartControl
      ? 'three-RAW HDR visible workflow after application restart'
      : 'five fresh-preparation three-RAW HDR visible workflows',
    foregroundTest(reason),
    async ({ irodori }, info) => {
      test.setTimeout(900000)
      const sources = await bracket(),
        ids = sources.map((source) => source.sha256),
        requested = process.env.IRODORI_MERGE_WORKFLOW_RUNS,
        runs = restartControl ? 1 : requested ? Number(requested) : 5,
        samples = [],
        evidence = info.outputPath('merge-workflow.json'),
        source = {
          ...(await provenance([
            'tests/merge-workflow-benchmark.spec.ts',
            'out/main/index.js',
            'out/main/merge-worker.js',
          ])),
          build: 'Production Electron application and bundled processing workers.',
        }
      expect([3, 5]).toContain(restartControl ? 5 : runs)
      await importPhotos(
        irodori.app,
        irodori.page,
        sources.map((source) => source.path),
        false,
      )
      let { app, page } = irodori
      if (restartControl) ({ app, page } = await irodori.restart(true))
      await (
        await app.browserWindow(page)
      ).evaluate((window) => {
        window.unmaximize()
        window.setContentSize(1440, 900)
      })
      const display = await app.evaluate(({ screen }) =>
        screen.getAllDisplays().map((display) => ({
          bounds: display.bounds,
          scaleFactor: display.scaleFactor,
          displayFrequency: display.displayFrequency,
          colorSpace: display.colorSpace,
          internal: display.internal,
        })),
      )
      try {
        for (let iteration = 0; iteration < runs; iteration++) {
          await selectSources(page, ids)
          const sample = await workflow(page)
          samples.push({ iteration, ...sample })
          // Diagnostics and integrity reads never interrupt the workflow clock.
          const { manifest, reproducible } = await page.evaluate(
            (id) => window.irodori.getMergeProvenance(id),
            sample.task.resultPhotoId!,
          )
          Object.assign(samples.at(-1)!, { manifest })
          expect(reproducible).toBe(true)
          expect(manifest.recipe.resolution).toBe('native')
          expect(manifest.recipe.settings).toMatchObject({
            mode: 'hdr',
            autoAlign: true,
            autoCrop: true,
            deghost: true,
          })
          expect(manifest.recipe.sources.map((source) => source.id).sort()).toEqual([...ids].sort())
          expect(manifest.recipe.measurements!.preparation.every((source) => !source.reused)).toBe(
            true,
          )
          expect(manifest.recipe.measurements!.referenceFallback?.reused).toBe(false)
          if (process.env.IRODORI_MERGE_CAMERA_PREPARATION === 'gpu') {
            expect(manifest.recipe.cameraPreparation).toBe(GPU_CAMERA_PREPARATION)
            for (const source of manifest.recipe.measurements!.preparation) {
              expect(source.work?.cameraPreparation?.backend).toBe('gpu')
              expect(source.work?.cameraPreparation?.fallback).toBeUndefined()
            }
          }
          if (process.env.IRODORI_MERGE_REFERENCE_PREPARATION === 'gpu') {
            expect(manifest.recipe.referenceFallbackPreparation).toBe(GPU_REFERENCE_PREPARATION)
            const fallback = manifest.recipe.measurements!.referenceFallback
            expect(fallback?.backend).toBe('gpu')
            expect(fallback?.work?.referencePreparation?.backend).toBe('gpu')
            expect(fallback?.work?.referencePreparation?.fallback).toBeUndefined()
          }
          expect(sample.review).toMatchObject({
            width: manifest.asset.width,
            height: manifest.asset.height,
          })
          expect(['webgl2', 'canvas2d']).toContain(sample.review.backend)
          expect(sample.editor.quality).toBe('normal')
          expect(sample.task.mergeMeasurements!.peak.gpuBytes).toBeLessThanOrEqual(1024 ** 3)
          expect(sample.task.mergeMeasurements!.peak.wasmBytes).toBeLessThanOrEqual(512 * 1024 ** 2)
          expect(manifest.asset.byteLength).toBe(manifest.asset.width * manifest.asset.height * 16)
          await verifyMaster(
            join(irodori.userDataDir, 'library/originals', sample.task.resultPhotoId!),
            manifest,
          )
          expect(await readdir(join(irodori.userDataDir, 'library/merge-reviews'))).toEqual([])
          expect(await readdir(join(irodori.userDataDir, 'library/merge-publications'))).toEqual([])
        }
      } finally {
        const sorted = samples.map((sample) => sample.completeOperationMs).sort((a, b) => a - b),
          measurements = {
            restartControl,
            requestedRuns: runs,
            acceptanceSampleCount: restartControl || runs === 5,
            sources,
            samples,
            medianCompleteOperationMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
            maximumCompleteOperationMs: sorted.length ? sorted.at(-1)! : null,
            intermediateCheckpointMs: 15000,
            intermediateCheckpointMet: sorted.length === runs && sorted.every((ms) => ms <= 15000),
            uninterruptedClock: true,
            excludesImportStartupAndHumanReview: true,
            freshPreparationPerOperation: true,
            requestedMergeBackends: {
              camera: process.env.IRODORI_MERGE_CAMERA_PREPARATION ?? 'cpu',
              reference: process.env.IRODORI_MERGE_REFERENCE_PREPARATION ?? 'cpu',
            },
            isolatedLibrary: true,
            filesystemAndDriverCaches: 'uncontrolled',
            display,
            provenance: source,
          }
        await writeFile(evidence, JSON.stringify(measurements, null, 2))
        await recordBenchmark(info, {
          family: 'merge',
          measurements,
          gates: [
            ...(restartControl
              ? []
              : [{ metric: 'medianCompleteOperationMs', operator: '<=' as const, limit: 10000 }]),
            { metric: 'maximumCompleteOperationMs', operator: '<=', limit: 12000 },
          ],
          evidence: [evidence],
        })
        for (const original of sources) {
          expect(await identity(original.path)).toEqual({
            sha256: original.sha256,
            bytes: original.bytes,
          })
          expect(
            await identity(
              join(irodori.userDataDir, 'library/originals', original.sha256, 'original.arw'),
            ),
          ).toEqual({ sha256: original.sha256, bytes: original.bytes })
        }
      }
      expect(samples).toHaveLength(runs)
      const times = samples.map((sample) => sample.completeOperationMs).sort((a, b) => a - b)
      if (!restartControl)
        expect
          .soft(times[Math.floor(times.length / 2)], 'Competitive median')
          .toBeLessThanOrEqual(10000)
      expect(
        Math.max(...times),
        'Competitive maximum including restart control',
      ).toBeLessThanOrEqual(12000)
    },
  )
