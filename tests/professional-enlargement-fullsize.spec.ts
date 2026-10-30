import { chmod, copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import {
  acceptanceHash,
  acceptedExport,
  completedTask,
  inspectAcceptedJpeg,
  managedOriginalHashes,
} from './professional-editing-acceptance.helpers'
import { identityCrop } from '../src/shared/crop'
import type { EditPatch } from '../src/shared/edits'
import {
  defaultExportOptions,
  EXPORT_MAX_PIXELS,
  EXPORT_RESIZE_VERSION,
} from '../src/shared/export'
import { noLensSettings } from '../src/shared/lens'

const json = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n')

/** Whole native geometry and actual ExportJobs publication; no large synthetic descriptor enters the app. */
test('full uncropped real Sony RAW refuses 2x above its fixed pixel cap and publishes a frozen 1.25x SDR enlargement through restart', async ({
  irodori,
}, info) => {
  test.setTimeout(900000)
  const root = info.outputPath('fullsize-enlargement'),
    destination = join(root, 'published-jpegs'),
    inputDirectory = join(root, 'input'),
    original = resolve('tests/fixtures/sony-zv1.ARW'),
    input = join(inputDirectory, 'sony-zv1.ARW'),
    originalSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
    codePaths = [
      'package-lock.json',
      'tests/professional-enlargement-fullsize.spec.ts',
      'src/main/export/jobs.ts',
      'src/main/export/render.ts',
      'src/main/export/renditions.ts',
      'src/main/export/resize.ts',
      'src/shared/export.ts',
      'src/shared/export-resources.ts',
      'out/main/index.js',
      'out/main/preview-worker.js',
      'out/main/export-worker.js',
    ],
    codeHashes = () =>
      Promise.all(
        codePaths.map(async (path) => ({ path, sha256: await acceptanceHash(resolve(path)) })),
      ),
    codeBefore = await codeHashes()
  await mkdir(destination, { recursive: true })
  await mkdir(inputDirectory)
  await json(join(root, 'implementation-before.json'), codeBefore)
  const { app } = irodori
  let { page } = irodori
  try {
    expect(await acceptanceHash(original)).toBe(originalSha256)
    await copyFile(original, input)
    await chmod(input, 0o444)
    await importPhotos(app, page, [input], false, 'keyboard')
    // Keep renderer buffers out of the deliberate background export workload.
    await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
    const source = (await page.evaluate(() => window.irodori.listPhotos())).photos.find(
      (photo) => photo.id === originalSha256,
    )!
    expect(source).toMatchObject({ filename: 'sony-zv1.ARW', format: 'ARW' })
    const originals = await managedOriginalHashes(irodori.userDataDir, [source])
    expect(originals[0].sha256).toBe(originalSha256)
    const initial = await page.evaluate((id) => window.irodori.getEditHistory(id), source.id)
    expect(initial.settings.processing).toBe('hdr-v1')
    const patch: EditPatch = {
        exposureEv: 0.35,
        contrast: 14,
        highlights: -20,
        shadows: 15,
        whites: -8,
        blacks: 4,
        saturation: 12,
        vibrance: 18,
        colorMixer: { ranges: { blue: { hue: 8, saturation: 6, luminance: -6 } } },
        colorGrading: {
          tones: {
            shadows: { hue: 220, saturation: 8, luminance: -3 },
            midtones: { hue: 35, saturation: 6, luminance: 2 },
            highlights: { hue: 45, saturation: 5, luminance: 3 },
          },
          blending: 55,
          balance: 5,
        },
        noiseReduction: { luminance: 20, chroma: 25 },
        detailSharpening: { amount: 25, radius: 1.2, threshold: 50 },
        lens: noLensSettings,
        crop: identityCrop,
      },
      frozenSettings = await page.evaluate(
        ({ id, patch, revision }) => window.irodori.updateEdits(id, patch, revision),
        { id: source.id, patch, revision: initial.revision },
      )
    expect(frozenSettings.revision).toBe(initial.revision + 1)
    expect(frozenSettings.settings).toMatchObject({ ...patch })
    const context = await page.evaluate(
      ({ id, revision }) => window.irodori.getCropContext(id, revision),
      { id: source.id, revision: frozenSettings.revision },
    )
    expect(context.source).toEqual({ width: 5496, height: 3672 })
    expect(context.settings).toEqual(identityCrop)
    expect(context.geometry).toMatchObject({ width: 5496, height: 3672, identity: true })
    expect(context.renderingIdentity).toBeTruthy()

    // Public preferences control the real job's admission; fixed output/device/codec caps stay intact.
    const resources = await page.evaluate(() =>
        window.irodori.setResourceSettings({ version: 1, ramMiB: 2048, vramMiB: 2048 }),
      ),
      resourcePolicy = await page.evaluate(() => window.irodori.getResourcePolicy(null)),
      capabilities = await page.evaluate(() => window.irodori.getExportCapabilities())
    expect(resources.settings).toEqual({ version: 1, ramMiB: 2048, vramMiB: 2048 })
    expect(resourcePolicy.ram.effectiveBytes).toBe(2 * 1024 ** 3)
    expect(resourcePolicy.vram.effectiveBytes).toBe(2 * 1024 ** 3)
    expect(EXPORT_MAX_PIXELS).toBe(33_554_432)
    expect(capabilities.resize.maxPixels).toBe(EXPORT_MAX_PIXELS)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, destination)
    const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
    expect(grant?.available).toBe(true)

    async function startExport(width: number, height: number, prefix: string) {
      const prepared = await page.evaluate((id) => window.irodori.prepareExport([id]), source.id)
      expect(prepared.targets).toMatchObject([
        { photoId: source.id, revision: frozenSettings.revision, hdr: true },
      ])
      return page.evaluate((request) => window.irodori.startExport(request), {
        preparationId: prepared.id,
        destinationId: grant!.id,
        action: 'custom' as const,
        options: {
          ...defaultExportOptions,
          output: 'sdr' as const,
          quality: 100,
          metadata: 'none' as const,
          size: {
            mode: 'fit' as const,
            width,
            height,
            allowEnlargement: true,
            method: 'lanczos3' as const,
          },
          names: { mode: 'sequence' as const, prefix },
        },
      })
    }

    const requested2x = { width: context.source.width * 2, height: context.source.height * 2 },
      rejectedId = await startExport(requested2x.width, requested2x.height, 'over-cap-2x-'),
      rejectedTask = await completedTask(page, rejectedId),
      rejected = acceptedExport(irodori.userDataDir, rejectedId)
    expect(requested2x.width * requested2x.height).toBe(80_725_248)
    expect(requested2x.width * requested2x.height).toBeGreaterThan(EXPORT_MAX_PIXELS)
    expect(rejectedTask).toMatchObject({
      status: 'failed',
      errorCount: 1,
      export: { failed: 1, exported: 0 },
    })
    expect(rejected.files).toHaveLength(1)
    expect(rejected.files[0]).toMatchObject({
      status: 'failed',
      message: 'Export exceeds the floating-point image limit. Choose smaller dimensions.',
    })
    expect(rejected.files[0].sha256).toBeUndefined()
    expect(await readdir(destination)).toEqual([])
    expect((await page.evaluate((id) => window.irodori.getEdits(id), source.id)).settings).toEqual(
      frozenSettings.settings,
    )
    await json(join(root, 'two-times-capability.json'), {
      source: context,
      requested: { ...requested2x, pixels: requested2x.width * requested2x.height, scale: 2 },
      fixedMaxPixels: EXPORT_MAX_PIXELS,
      publicCapabilities: capabilities,
      acceptedFailedJob: rejected,
      task: rejectedTask,
      publishedFiles: [],
      boundary:
        'The real task is accepted, then fails in authoritative worker geometry validation. This is not a preflight refusal or successful 2x export.',
    })

    const actual = { width: 6870, height: 4590 },
      historyBeforeExport = await page.evaluate(
        (id) => window.irodori.getEditHistory(id),
        source.id,
      ),
      exportId = await startExport(actual.width, actual.height, 'full-native-1p25x-'),
      accepted = acceptedExport(irodori.userDataDir, exportId)
    expect(actual.width / context.source.width).toBe(1.25)
    expect(actual.height / context.source.height).toBe(1.25)
    expect(actual.width * actual.height).toBe(31_533_300)
    expect(accepted.manifest.options).toMatchObject({
      output: 'sdr',
      quality: 100,
      size: { ...actual, mode: 'fit', method: 'lanczos3', allowEnlargement: true },
    })
    expect(accepted.manifest.pipeline.resize?.filter).toBe(EXPORT_RESIZE_VERSION)
    expect(accepted.manifest.sources).toHaveLength(1)
    expect(accepted.manifest.sources[0].processing).toMatchObject({
      revision: frozenSettings.revision,
      crop: identityCrop,
      settings: noLensSettings,
      noiseReduction: frozenSettings.settings.noiseReduction,
      detailSharpening: frozenSettings.settings.detailSharpening,
      adjustments: {
        exposureEv: 0.35,
        saturation: 12,
        vibrance: 18,
        colorMixer: frozenSettings.settings.colorMixer,
        colorGrading: frozenSettings.settings.colorGrading,
      },
    })
    const later = await page.evaluate(
        async ({ id, revision }) => {
          const state = await window.irodori.updateEdits(
            id,
            { exposureEv: -1.25, saturation: -12 },
            revision,
          )
          return { state, acceptedAtEpochMs: Date.now() }
        },
        { id: source.id, revision: frozenSettings.revision },
      ),
      task = await completedTask(page, exportId),
      completed = acceptedExport(irodori.userDataDir, exportId)
    expect(later.state.revision).toBe(frozenSettings.revision + 1)
    expect(task).toMatchObject({
      status: 'completed',
      errorCount: 0,
      export: { exported: 1, failed: 0 },
    })
    expect(completed.manifest).toEqual(accepted.manifest)
    expect(completed.files).toHaveLength(1)
    const file = completed.files[0],
      jpeg = join(destination, file.outputName!),
      evidence = await inspectAcceptedJpeg(jpeg, false, actual.width, actual.height),
      metadata = await sharp(jpeg).metadata(),
      bytes = (await stat(jpeg)).size,
      render = file.diagnostics?.memory?.render,
      encoder = file.diagnostics?.memory?.sdr
    expect(file.status).toBe('exported')
    expect(file.sha256).toBe(evidence.sha256)
    expect(metadata).toMatchObject({
      width: actual.width,
      height: actual.height,
      chromaSubsampling: '4:4:4',
      isProgressive: false,
    })
    expect(file.diagnostics).toMatchObject({
      renderer: 'gpu',
      encoder: 'sdr',
      resize: {
        input: context.source,
        output: actual,
        enlarged: true,
        policy: { filter: EXPORT_RESIZE_VERSION },
      },
    })
    expect(file.diagnostics?.rendererFallback).toBeUndefined()
    expect(file.diagnostics?.detail?.working).toBeDefined()
    expect(file.diagnostics?.detail?.working?.key).toMatch(/^[a-f0-9]{64}$/)
    expect(file.diagnostics?.detail?.working?.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(file.diagnostics?.crop).toBeUndefined()
    expect(render?.cpu.accepted).toBe(true)
    expect(render?.gpu.accepted).toBe(true)
    expect(render?.gpuAccepted).toBe(true)
    expect(render?.outputs).toBe(actual.width * actual.height * 3)
    expect(render?.resizeBytes).toBeGreaterThan(0)
    expect(encoder?.accepted).toBe(true)
    if (!render || !encoder)
      throw new Error('The actual export did not retain admitted resource plans.')
    for (const allocation of [render.cpu, render.gpu, encoder]) {
      expect(allocation.total.ramBytes).toBeLessThanOrEqual(resourcePolicy.ram.effectiveBytes)
      expect(allocation.total.vramBytes).toBeLessThanOrEqual(resourcePolicy.vram.effectiveBytes)
    }
    expect(bytes).toBeLessThanOrEqual(encoder.outputLimitBytes)
    const progress = task.exportWorkerProgress?.events ?? []
    expect(progress.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        'rendition-rendered',
        'sdr-jpeg-obtained',
        'output-validated-written',
      ]),
    )
    expect(
      progress.every(
        (event) =>
          event.photoId === source.id &&
          event.exportId === exportId &&
          event.settingsRevision === frozenSettings.revision,
      ),
    ).toBe(true)
    expect(
      progress.find((event) => event.phase === 'output-validated-written')!.producedAtEpochMs,
    ).toBeGreaterThan(later.acceptedAtEpochMs)
    await sharp(jpeg)
      .resize({ width: 1200, withoutEnlargement: true })
      .png()
      .toFile(join(root, 'full-native-enlargement-review.png'))
    const historyAfter = await page.evaluate((id) => window.irodori.getEditHistory(id), source.id)
    expect(historyAfter.snapshots).toHaveLength(historyBeforeExport.snapshots.length + 1)
    expect(historyAfter.settings).toEqual(later.state.settings)
    expect(historyAfter.settings.exposureEv).toBe(-1.25)
    expect(await managedOriginalHashes(irodori.userDataDir, [source])).toEqual(originals)
    expect(await readdir(destination)).toEqual([file.outputName!])
    await json(join(root, 'fullsize-enlargement.json'), {
      source: { photo: source, originalSha256, nativeContext: context },
      resourceSettings: resources,
      publicResourcePolicy: resourcePolicy,
      actualScale: 1.25,
      actualPixels: actual.width * actual.height,
      output: { path: jpeg, bytes, ...evidence },
      acceptedJob: completed,
      completedTask: task,
      laterEdit: later,
      historyAfter,
      limitations: [
        '2x from this full 20 MP source exceeds the unchanged 33,554,432-pixel cap and is a retained failed job.',
        'Success covers one full-native uncropped 1.25x SDR JPEG, not full-native 2x or HDR enlargement.',
        'Lanczos3 may improve resampling but does not recover new captured detail.',
        'Resource plans are frozen managed accounting, not measured process RSS or physical VRAM peaks.',
        'No throughput or photographic-quality acceptance is inferred; independent small Decimal80 resize references remain the numerical oracle.',
      ],
    })
    ;({ page } = await irodori.restart())
    await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), source.id)).toEqual(
      historyAfter,
    )
    expect(acceptedExport(irodori.userDataDir, exportId)).toEqual(completed)
    expect(acceptedExport(irodori.userDataDir, rejectedId)).toEqual(rejected)
    expect((await page.evaluate(() => window.irodori.getResourceSettings())).settings).toEqual(
      resources.settings,
    )
    expect(await managedOriginalHashes(irodori.userDataDir, [source])).toEqual(originals)
    expect(await acceptanceHash(jpeg)).toBe(evidence.sha256)
    await json(join(root, 'restart.json'), {
      succeeded: true,
      exportId,
      rejectedId,
      outputSha256: await acceptanceHash(jpeg),
      retainedHistoryRevision: historyAfter.revision,
    })
  } catch (error) {
    await json(join(root, 'failure.json'), {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  } finally {
    const codeAfter = await codeHashes()
    await json(join(root, 'implementation-after.json'), codeAfter)
    expect(codeAfter).toEqual(codeBefore)
    expect(await acceptanceHash(original)).toBe(originalSha256)
    expect(await acceptanceHash(input)).toBe(originalSha256)
  }
})
