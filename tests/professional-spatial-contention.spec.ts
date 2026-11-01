import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Photo } from '../src/shared/contracts'
import type { EditSettings } from '../src/shared/edits'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import {
  defaultExportOptions,
  EXPORT_RENDERING_VERSION,
  EXPORT_RESIZE_VERSION,
} from '../src/shared/export'
import type { ExportWorkerProgress } from '../src/shared/export'
import { PREVIEW_ASSET_VERSION } from '../src/shared/preview-frame'
import type { DetailPreviewIdentity } from '../src/main/processing/detail-preview'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { sampleEditorMemory } from './editor-memory.helpers'
import { expectActiveHdrPreview, expectReferenceHdrPreview } from './hdr-test-policy.helpers'
import {
  nativeOriginalHash,
  nativeSensorSource,
  readyNativeEditor,
} from './professional-editor-native.helpers'
import {
  acceptedExport,
  completedTask,
  inspectAcceptedJpeg,
  managedOriginalHashes,
} from './professional-editing-acceptance.helpers'

const run = promisify(execFile)
const fixture = {
  path: 'assets/tests/images/raw/sony-zv-1a/fog-dogs/originals/DSC03280.ARW',
  sha256: 'dead1a70a02909faf8458119fcc8f7067733b756978fd26921710e3008364605',
} as const
const forestRoot = 'assets/tests/images/raw/sony-zv-1a/forest-bracket'
const noiseReduction = { version: 1, luminance: 0, chroma: 0 } as const
const detailSharpening = { version: 1, amount: 50, radius: 1, threshold: 50 } as const
const crop = { ...identityCrop, centerX: 0.51, centerY: 0.49, width: 0.6, height: 0.6, angle: 1.25 }

test('a cold fractional crop and sharpening variant retains matching pixels and frozen exports while real import and export work advance between warm point edits', async ({
  irodori,
}, info) => {
  // These bounds protect the test harness, not a cold-processing latency promise.
  test.setTimeout(900000)
  const { app, page, userDataDir } = irodori,
    evidence: Record<string, unknown> = {
      version: 'professional-spatial-contention-v1',
      fixture,
      recipe: { noiseReduction, detailSharpening, crop },
      scope:
        'One hidden functional case, SDR target, real native RAW working sources. Cold spatial preparation finishes before background work starts, respecting the foreground scheduler. Two sequential warm point-edit phases observe real import counters and validated export producer-stage receipts. Progress proves advancement between edits, not continuous simultaneous GPU computation or progress during every edit. The bounded input sequence has no cadence gate. Cold/edit durations and owned memory snapshots are diagnostic, not performance acceptance or physical memory peaks. No denoising quality, physical HDR, native-input or sustained responsiveness claim.',
    },
    memory: Awaited<ReturnType<typeof sampleEditorMemory>>[] = [],
    pointEdits: {
      value: number
      revision: number
      inputAtEpochMs: number
      presentedAtEpochMs: number
    }[] = [],
    taskIds: string[] = []
  const forestManifestPath = `${forestRoot}/manifest.json`,
    forestManifest = JSON.parse(await readFile(forestManifestPath, 'utf8')) as {
      files: { name: string; path: string; sha256: string; bytes: number }[]
    },
    forest = forestManifest.files.map((file) => ({ ...file, path: `${forestRoot}/${file.path}` })),
    inputs = [fixture, ...forest],
    tracked = [
      fixture.path,
      forestManifestPath,
      `${forestRoot}/README.md`,
      ...forest.map((file) => file.path),
    ]
  expect(forest.map((file) => file.name)).toEqual(['DSC03277.ARW', 'DSC03278.ARW', 'DSC03279.ARW'])
  expect(new Set(inputs.map((file) => file.sha256)).size).toBe(4)
  await run('git', ['ls-files', '--error-unmatch', '--', ...tracked])
  await run('git', ['diff', '--quiet', 'HEAD', '--', ...tracked])
  const originalHashes = await Promise.all(inputs.map((file) => nativeOriginalHash(file.path)))
  expect(originalHashes).toEqual(inputs.map((file) => file.sha256))
  evidence.inputProvenance = {
    inputs,
    forestManifestSha256: await nativeOriginalHash(forestManifestPath),
    originalHashes,
  }
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, [resolve(fixture.path)], false, 'keyboard')
  const id = fixture.sha256,
    state = () => page.evaluate((id) => window.irodori.getEdits(id), id),
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
    epoch = () => page.evaluate(() => performance.timeOrigin + performance.now()),
    view = () =>
      page.getByTestId('preview-viewport').evaluate((element) => ({
        mode: element.getAttribute('data-mode'),
        scale: element.getAttribute('data-scale'),
        panX: element.getAttribute('data-pan-x'),
        panY: element.getAttribute('data-pan-y'),
        width: element.getAttribute('data-image-width'),
        height: element.getAttribute('data-image-height'),
      }))
  async function frame(revision: number) {
    const displayed = await readyNativeEditor(page, id, revision)
    await expectReferenceHdrPreview(page)
    const sensor = await nativeSensorSource(userDataDir, id, displayed.sourceUrl!),
      variant = new URL(displayed.sourceUrl!).pathname.split('/').filter(Boolean)[3],
      directory = join(
        userDataDir,
        'library',
        'cache',
        'previews',
        PREVIEW_ASSET_VERSION,
        `${id}-${variant}`,
      ),
      metadata = JSON.parse(await readFile(join(directory, 'entry.json'), 'utf8')) as {
        sourceKey: string
        detail?: DetailPreviewIdentity
        cropSettings?: typeof crop
        diagnostics?: { backend?: string; fallback?: string }
      }
    return { displayed, sensor, metadata, directory }
  }
  async function taskSample(taskId: string) {
    return page.evaluate(async (taskId) => {
      const requestedAtEpochMs = performance.timeOrigin + performance.now(),
        task = (await window.irodori.listTasks()).find((task) => task.id === taskId),
        respondedAtEpochMs = performance.timeOrigin + performance.now()
      return { requestedAtEpochMs, respondedAtEpochMs, task }
    }, taskId)
  }
  type TaskSample = Awaited<ReturnType<typeof taskSample>>
  function importAdvance(before: TaskSample, after: TaskSample) {
    if (
      !before.task ||
      !after.task ||
      before.task.id !== after.task.id ||
      before.respondedAtEpochMs > after.requestedAtEpochMs
    )
      return []
    const keys = ['bytes', 'copied', 'prepared'] as const
    if (
      !before.task.transfer ||
      !after.task.transfer ||
      keys.some((key) => after.task!.transfer![key] < before.task!.transfer![key])
    )
      return []
    return keys.filter((key) => after.task!.transfer![key] > before.task!.transfer![key])
  }
  const initialHistory = await history(),
    upstream = await frame(0),
    upstreamFile = join(upstream.directory, 'linear.f32'),
    upstreamHash = await nativeOriginalHash(upstreamFile),
    expectedSettings: EditSettings[] = [initialHistory.settings]
  let revision = 0,
    failure: string | undefined
  try {
    expect((await page.evaluate(() => window.irodori.listPhotos())).total).toBe(1)
    expect(initialHistory.snapshots).toHaveLength(1)
    expect(upstream.sensor.detailSource).toBeUndefined()
    expect(upstreamHash).toBe(upstream.sensor.asset.sha256)
    const context = await page.evaluate((id) => window.irodori.getCropContext(id, 0), id),
      geometry = cropGeometry(context.source, crop)
    expect(geometry.pixelAligned).toBe(false)
    memory.push(await sampleEditorMemory(app, 'warm RAW before cold crop and sharpening variant'))
    const coldStartedAt = await epoch(),
      spatial = await page.evaluate(
        ({ id, crop, noiseReduction, detailSharpening }) =>
          window.irodori.updateEdits(id, { crop, noiseReduction, detailSharpening }, 0),
        { id, crop, noiseReduction, detailSharpening },
      )
    revision = spatial.revision
    expectedSettings.push(spatial.settings)
    const prepared = await frame(revision),
      coldPresentedAt = await epoch(),
      stableView = await view()
    evidence.cold = {
      startedAtEpochMs: coldStartedAt,
      presentedAtEpochMs: coldPresentedAt,
      spatial,
      prepared,
      geometry,
      diagnostics: await page.evaluate(() => window.irodori.getPreviewDiagnostics()),
    }
    expect(revision).toBe(1)
    expect(spatial.settings).toEqual({
      ...initialHistory.settings,
      crop,
      noiseReduction,
      detailSharpening,
    })
    expect(prepared.sensor.dimensions).toEqual({ width: geometry.width, height: geometry.height })
    expect(prepared.displayed.sourceUrl).not.toBe(upstream.displayed.sourceUrl)
    expect(prepared.metadata.cropSettings).toEqual(crop)
    expect(prepared.metadata.diagnostics).toMatchObject({ backend: 'gpu' })
    expect(prepared.metadata.diagnostics?.fallback).toBeUndefined()
    expect(prepared.metadata.detail).toMatchObject({
      backend: 'gpu',
      cpuTiles: 0,
      precisionRecoveryTiles: 0,
      sourceSha256: upstream.sensor.asset.sha256,
      noiseReduction,
      detailSharpening,
    })
    expect(prepared.metadata.detail!.gpuTiles).toBeGreaterThan(0)
    memory.push(
      await sampleEditorMemory(app, 'cold spatial variant completed before background work'),
    )
    const owner = await page.evaluateHandle(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
        device = canvas.getContext('webgpu')!.getConfiguration()?.device,
        uploads = canvas.dataset.sourceUploads
      return {
        read() {
          const current = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
          return {
            sameCanvas: current === canvas,
            sameDevice:
              !!device && current.getContext('webgpu')!.getConfiguration()?.device === device,
            sameUploads: current.dataset.sourceUploads === uploads,
          }
        },
      }
    })
    try {
      const light = page.getByRole('button', { name: 'Light', exact: true })
      if ((await light.getAttribute('aria-expanded')) !== 'true') await activateButton(light)
      const exposure = page.getByRole('spinbutton', { name: 'Exposure value', exact: true })
      async function point(value: number, afterFirstInput?: () => Promise<void>) {
        const inputAtEpochMs = await epoch()
        await expect(exposure).toBeEnabled()
        await exposure.fill(String(value))
        await afterFirstInput?.()
        await exposure.press('Enter')
        await expect
          .poll(async () => (await state()).revision, { timeout: 120000 })
          .toBe(revision + 1)
        revision++
        const current = await state(),
          currentFrame = await frame(revision),
          presentedAtEpochMs = await epoch()
        pointEdits.push({ value, revision, inputAtEpochMs, presentedAtEpochMs })
        expectedSettings.push(current.settings)
        expect(current.settings).toEqual({ ...spatial.settings, exposureEv: value })
        expect(currentFrame.displayed.parameters.exposureEv).toBe(value)
        expect(currentFrame.displayed.sourceUrl).toBe(prepared.displayed.sourceUrl)
        expect(currentFrame.sensor.asset.sha256).toBe(prepared.sensor.asset.sha256)
        expect(currentFrame.metadata.sourceKey).toBe(prepared.metadata.sourceKey)
        expect(await view()).toEqual(stableView)
        expect(await owner.evaluate((control) => control.read())).toEqual({
          sameCanvas: true,
          sameDevice: true,
          sameUploads: true,
        })
        return pointEdits.at(-1)!
      }

      // Fresh originals enter the real chooser/review path without replacing the active photo.
      await app.evaluate(
        ({ dialog }, paths) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
        },
        forest.map((file) => resolve(file.path)),
      )
      const importId = await page.evaluate(() => window.irodori.chooseSource('files', false))
      if (!importId) throw new Error('The real forest import review was not created.')
      taskIds.push(importId)
      await expect
        .poll(
          () =>
            page.evaluate(async (id) => {
              const review = await window.irodori.getReviewSummary(id)
              return {
                phase: review.phase,
                pending: Boolean(review.verificationPending),
                selected: review.selected,
                errors: review.errors,
              }
            }, importId),
          { timeout: 60000 },
        )
        .toEqual({ phase: 'review', pending: false, selected: 3, errors: 0 })
      const importSamples: TaskSample[] = [],
        importPointsStart = pointEdits.length
      await point(0.1, async () => {
        await page.evaluate((id) => window.irodori.importSelected(id), importId)
        importSamples.push(await taskSample(importId))
      })
      let importWitness: { before: TaskSample; after: TaskSample; increased: string[] } | undefined
      for (let index = 0; index < 12; index++) {
        const after = await taskSample(importId),
          before = importSamples.at(-1)!,
          increased = importAdvance(before, after)
        importSamples.push(after)
        if (increased.length) {
          importWitness = { before, after, increased }
          break
        }
        if (after.task?.finishedAt !== undefined) break
        await point((index + 2) / 10)
      }
      const importLast = await point(0.35),
        importTask = await completedTask(page, importId)
      evidence.import = {
        samples: importSamples,
        witness: importWitness,
        firstInputAtEpochMs: pointEdits[importPointsStart].inputAtEpochMs,
        lastInputAtEpochMs: importLast.inputAtEpochMs,
        finalPresentedAtEpochMs: importLast.presentedAtEpochMs,
        task: importTask,
      }
      expect(importTask).toMatchObject({
        status: 'completed',
        errorCount: 0,
        outcomes: { imported: 3, failed: 0 },
      })
      await page.evaluate((id) => window.irodori.disposeImport(id), importId)

      const destination = info.outputPath('exports')
      await mkdir(destination)
      await app.evaluate(({ dialog }, destination) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
      }, destination)
      const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
      if (!grant?.available) throw new Error('The isolated export destination was not granted.')
      const options = {
        ...defaultExportOptions,
        output: 'sdr' as const,
        quality: 100,
        metadata: 'none' as const,
        size: {
          mode: 'longest' as const,
          edge: 512,
          allowEnlargement: false,
          method: 'lanczos3' as const,
        },
        names: { mode: 'sequence' as const, prefix: 'contended-' },
      }
      async function startExport(prefix: string) {
        const preparation = await page.evaluate((id) => window.irodori.prepareExport([id]), id)
        const exportId = await page.evaluate((request) => window.irodori.startExport(request), {
          preparationId: preparation.id,
          destinationId: grant!.id,
          action: 'custom' as const,
          options: { ...options, names: { mode: 'sequence' as const, prefix } },
        })
        taskIds.push(exportId)
        return exportId
      }
      const frozenState = await state(),
        exportId = await startExport('contended-'),
        frozen = acceptedExport(userDataDir, exportId),
        exportSamples: TaskSample[] = [await taskSample(exportId)],
        beforeGestureHistory = await history(),
        slider = page.getByRole('slider', { name: 'Exposure', exact: true })
      evidence.export = { frozen, samples: exportSamples, beforeGestureHistory }
      let admitted: TaskSample | undefined
      await expect
        .poll(
          async () => {
            const sample = await taskSample(exportId)
            exportSamples.push(sample)
            if (sample.task?.exportWorkerProgress?.active && sample.task.finishedAt === undefined)
              admitted = sample
            return Boolean(admitted)
          },
          { timeout: 120000 },
        )
        .toBe(true)
      const admittedAttempt = admitted!.task!.exportWorkerProgress!.active!
      Object.assign(evidence.export as Record<string, unknown>, { admitted })
      async function draft(value: number) {
        const inputAtEpochMs = await epoch()
        await expect(slider).toBeEnabled()
        // Reuse export-ui's uncommitted slider-input route; no native cadence is claimed.
        await slider.evaluate((element, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            element,
            String(value),
          )
          element.dispatchEvent(new Event('input', { bubbles: true }))
        }, value)
        await expect(exposure).toHaveValue(value.toFixed(2))
        await expectActiveHdrPreview(page)
        const presented = await page.getByTestId('main-preview').evaluate((element) => ({
            sourceUrl: element.getAttribute('data-src'),
            sourceIdentity: element.getAttribute('data-presented-source-identity'),
            parameters: JSON.parse(
              element.getAttribute('data-requested-parameters') ?? '{}',
            ) as Record<string, unknown>,
            serial: element.getAttribute('data-completed-edit-serial'),
          })),
          presentedAtEpochMs = await epoch()
        expect(presented.parameters.exposureEv).toBe(value)
        expect(presented.sourceUrl).toBe(prepared.displayed.sourceUrl)
        expect(presented.sourceIdentity).toBe(prepared.displayed.sourceIdentity)
        expect(await state()).toEqual(frozenState)
        expect(await history()).toEqual(beforeGestureHistory)
        expect(await view()).toEqual(stableView)
        expect(await owner.evaluate((control) => control.read())).toEqual({
          sameCanvas: true,
          sameDevice: true,
          sameUploads: true,
        })
        return { value, inputAtEpochMs, presentedAtEpochMs, presented }
      }
      const firstDraft = await draft(0.45)
      Object.assign(evidence.export as Record<string, unknown>, { firstDraft })
      let exportWitness: ExportWorkerProgress | undefined
      await expect
        .poll(
          async () => {
            const sample = await taskSample(exportId)
            exportSamples.push(sample)
            exportWitness = sample.task?.exportWorkerProgress?.events.find(
              (event) =>
                event.attemptId === admittedAttempt.attemptId &&
                event.producedAtEpochMs >= firstDraft.inputAtEpochMs,
            )
            return Boolean(exportWitness)
          },
          { timeout: 120000 },
        )
        .toBe(true)
      const lastDraft = await draft(0.37)
      let rendered: TaskSample | undefined
      await expect
        .poll(
          async () => {
            const sample = await taskSample(exportId)
            exportSamples.push(sample)
            const progress = sample.task?.exportWorkerProgress
            if (progress?.counter === 3 && !progress.active) rendered = sample
            return Boolean(rendered)
          },
          { timeout: 120000 },
        )
        .toBe(true)
      expect(await state()).toEqual(frozenState)
      expect(await history()).toEqual(beforeGestureHistory)
      // Finish after worker retirement; final publication waits for editing to settle.
      const committedAtEpochMs = await epoch()
      await slider.evaluate((element) =>
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })),
      )
      await expect
        .poll(async () => (await state()).revision, { timeout: 120000 })
        .toBe(revision + 1)
      revision++
      const gestureState = await state(),
        gestureFrame = await frame(revision),
        exportLast = {
          value: 0.37,
          revision,
          inputAtEpochMs: firstDraft.inputAtEpochMs,
          presentedAtEpochMs: await epoch(),
        }
      pointEdits.push(exportLast)
      expectedSettings.push(gestureState.settings)
      expect(gestureState.settings).toEqual({ ...spatial.settings, exposureEv: 0.37 })
      expect(gestureFrame.displayed.parameters.exposureEv).toBe(0.37)
      expect(gestureFrame.displayed.sourceUrl).toBe(prepared.displayed.sourceUrl)
      expect(gestureFrame.sensor.asset.sha256).toBe(prepared.sensor.asset.sha256)
      expect(await view()).toEqual(stableView)
      expect(await owner.evaluate((control) => control.read())).toEqual({
        sameCanvas: true,
        sameDevice: true,
        sameUploads: true,
      })
      const exportTask = await completedTask(page, exportId),
        exported = acceptedExport(userDataDir, exportId)
      evidence.export = {
        frozen,
        exported,
        samples: exportSamples,
        witness: exportWitness,
        admitted,
        rendered,
        gesture: {
          firstDraft,
          lastDraft,
          committedAtEpochMs,
          beforeGestureHistory,
          gestureState,
          gestureFrame,
          scope:
            'One uncommitted Exposure gesture with two actual local parameter/frame updates, separated by passive observation of a real worker stage. No continuous input or cadence claim; the sole history commit follows worker retirement and precedes final publication.',
        },
        firstInputAtEpochMs: firstDraft.inputAtEpochMs,
        lastPresentedAtEpochMs: exportLast.presentedAtEpochMs,
        task: exportTask,
      }
      expect(exportTask).toMatchObject({
        status: 'completed',
        errorCount: 0,
        export: { exported: 1, failed: 0 },
      })
      expect(exported.manifest).toEqual(frozen.manifest)
      expect(frozen.manifest.sources).toHaveLength(1)
      expect(frozen.manifest.sources[0].processing).toMatchObject({
        revision: frozenState.revision,
        crop,
        noiseReduction,
        detailSharpening,
        adjustments: { exposureEv: 0.35 },
      })
      expect(frozen.manifest.rendering).toBe(EXPORT_RENDERING_VERSION)
      expect(frozen.manifest.pipeline.resize?.filter).toBe(EXPORT_RESIZE_VERSION)
      expect(exported.files[0]).toMatchObject({
        status: 'exported',
        diagnostics: { renderer: 'gpu', resize: { renderer: 'gpu' } },
      })
      expect(exported.files[0].diagnostics?.rendererFallback).toBeUndefined()
      expect(exportTask.exportWorkerProgress?.dropped).toBe(0)
      expect(exportTask.exportWorkerProgress?.events.map((event) => event.phase)).toEqual([
        'rendition-rendered',
        'sdr-jpeg-obtained',
        'output-validated-written',
      ])
      expect((await state()).settings.exposureEv).toBe(0.37)

      // A second small output verifies frozen pixels only after the contended job has ended.
      await point(0.35)
      const referenceId = await startExport('matched-reference-'),
        referenceTask = await completedTask(page, referenceId),
        reference = acceptedExport(userDataDir, referenceId),
        outputPath = join(destination, exported.files[0].outputName!),
        referencePath = join(destination, reference.files[0].outputName!),
        scale = 512 / Math.max(geometry.width, geometry.height)
      evidence.reference = {
        reference,
        task: referenceTask,
        restoredSettings: await state(),
        outputSha256: await nativeOriginalHash(outputPath),
        referenceSha256: await nativeOriginalHash(referencePath),
      }
      expect(referenceTask).toMatchObject({
        status: 'completed',
        export: { exported: 1, failed: 0 },
      })
      expect(exported.files[0].sha256).toBe(await nativeOriginalHash(outputPath))
      expect(reference.files[0].sha256).toBe(await nativeOriginalHash(referencePath))
      expect(await readFile(outputPath)).toEqual(await readFile(referencePath))
      evidence.output = await inspectAcceptedJpeg(
        outputPath,
        false,
        Math.round(geometry.width * scale),
        Math.round(geometry.height * scale),
      )

      const finalHistory = await history(),
        finalFrame = await frame(revision),
        photos = (await page.evaluate(() => window.irodori.listPhotos())).photos,
        managed = await managedOriginalHashes(
          userDataDir,
          inputs.map((input) => photos.find((photo) => photo.id === input.sha256)!) as Photo[],
        ),
        finalHashes = await Promise.all(inputs.map((input) => nativeOriginalHash(input.path))),
        finalUpstreamHash = await nativeOriginalHash(upstreamFile)
      evidence.final = {
        history: finalHistory,
        frame: finalFrame,
        managed,
        finalHashes,
        upstreamHash,
        finalUpstreamHash,
        view: await view(),
        ownership: await owner.evaluate((control) => control.read()),
      }
      memory.push(
        await sampleEditorMemory(app, 'both real workload phases and matching reference completed'),
      )
      expect(finalHistory.revision).toBe(revision)
      expect(finalHistory.cursor).toBe(revision)
      expect(finalHistory.snapshots.map((snapshot) => snapshot.settings)).toEqual(expectedSettings)
      expect(finalHistory.snapshots[0]).toEqual(initialHistory.snapshots[0])
      expect(finalHistory.settings).toEqual(frozenState.settings)
      expect(finalFrame.displayed.sourceUrl).toBe(prepared.displayed.sourceUrl)
      expect(finalHashes).toEqual(originalHashes)
      expect(finalUpstreamHash).toBe(upstreamHash)
      expect(managed.map((input) => input.sha256)).toEqual(originalHashes)
      await run('git', ['diff', '--quiet', 'HEAD', '--', ...tracked])
      expect(
        importWitness,
        'Real copying/preparation counter advancement must be observed, not queued status.',
      ).toBeDefined()
      expect(importWitness!.before.requestedAtEpochMs).toBeGreaterThanOrEqual(
        pointEdits[importPointsStart].inputAtEpochMs,
      )
      expect(importWitness!.after.respondedAtEpochMs).toBeLessThanOrEqual(importLast.inputAtEpochMs)
      expect(exportSamples[0].task?.finishedAt).toBeUndefined()
      expect(
        exportWitness,
        'An actual validated producer stage must complete during warm editing.',
      ).toBeDefined()
      expect(exportWitness).toMatchObject({
        exportId,
        photoId: id,
        settingsRevision: frozenState.revision,
      })
      expect(exportWitness!.producedAtEpochMs).toBeLessThanOrEqual(lastDraft.inputAtEpochMs)
      expect(exported.manifest).toEqual(acceptedExport(userDataDir, exportId).manifest)
    } finally {
      await owner.dispose()
    }
  } catch (error) {
    failure = String(error)
    throw error
  } finally {
    evidence.failure = failure
    evidence.pointEdits = pointEdits
    evidence.memorySnapshots = memory
    evidence.endingHistory = await history().catch((error: unknown) => ({
      unavailable: String(error),
    }))
    evidence.endingTasks = await page
      .evaluate(() => window.irodori.listTasks())
      .catch((error: unknown) => ({ unavailable: String(error) }))
    evidence.endingDiagnostics = await page
      .evaluate(() => window.irodori.getPreviewDiagnostics())
      .catch((error: unknown) => ({ unavailable: String(error) }))
    for (const taskId of taskIds)
      await page
        .evaluate(async (id) => {
          const task = (await window.irodori.listTasks()).find((task) => task.id === id)
          if (task?.status === 'running' || task?.status === 'cancelling')
            await window.irodori.cancelTask(id)
        }, taskId)
        .catch((error: unknown) => {
          evidence.cleanupErrors ??= [] as unknown[]
          ;(evidence.cleanupErrors as unknown[]).push(String(error))
        })
    const path = info.outputPath('spatial-contention.json')
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n')
    await info.attach('spatial-contention', { path, contentType: 'application/json' })
  }
})
