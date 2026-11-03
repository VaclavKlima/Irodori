import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { prepareSource } from '../src/main/merge/prepare'
import { PreviewEngine } from '../src/main/preview-engine'
import { defaultExportOptions } from '../src/shared/export'
import type { MergeSource } from '../src/shared/merge'
import { activateButton } from './button.helpers'
import { expect, test } from './electron.fixture'
import { settledHealthyPreview } from './hdr-analysis-cancel.helpers'
import { importPhotos } from './import.helpers'
import {
  acceptanceHash,
  acceptedExport,
  completedTask,
  managedOriginalHashes,
} from './professional-editing-acceptance.helpers'

test.use({ hdrDisplay: true })
test('records cold RAW opening, merge source preparation and complete frozen export publication', async ({
  irodori,
}, info) => {
  test.setTimeout(180000)
  const original = resolve('tests/fixtures/sony-zv1.ARW'),
    inputHash = await acceptanceHash(original),
    { app, page } = irodori,
    started = performance.now()
  await importPhotos(app, page, [original], false, 'keyboard')
  const coldFrame = await settledHealthyPreview(page),
    coldImportAndOpenMs = performance.now() - started
  const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
  expect(photo.id).toBe(inputHash)
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }), 'keyboard')
  const revisitStarted = performance.now()
  await activateButton(page.getByRole('button', { name: 'Editor', exact: true }), 'keyboard')
  const revisit = await settledHealthyPreview(page),
    cachedRevisitMs = performance.now() - revisitStarted
  expect(revisit.source).toBe(coldFrame.source)
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }), 'keyboard')
  const destination = info.outputPath('published-exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
  expect(grant?.available).toBe(true)
  const exports: { elapsedMs: number; diagnostics: ReturnType<typeof acceptedExport> }[] = []
  for (const prefix of ['first-', 'repeat-']) {
    const began = performance.now()
    const preparation = await page.evaluate((id) => window.irodori.prepareExport([id]), photo.id)
    const id = await page.evaluate((request) => window.irodori.startExport(request), {
      preparationId: preparation.id,
      destinationId: grant!.id,
      action: 'custom' as const,
      options: {
        ...defaultExportOptions,
        output: 'hdr' as const,
        size: { mode: 'longest' as const, edge: 1200 },
        metadata: 'none' as const,
        names: { mode: 'sequence' as const, prefix },
      },
    })
    let task: Awaited<ReturnType<typeof completedTask>>
    try {
      task = await completedTask(page, id)
    } catch (error) {
      await writeFile(
        info.outputPath('workflow-failure.json'),
        JSON.stringify(
          {
            prefix,
            error: String(error),
            tasks: await page.evaluate(() => window.irodori.listTasks()),
            accepted: acceptedExport(irodori.userDataDir, id),
          },
          null,
          2,
        ),
      )
      await page.evaluate((id) => window.irodori.cancelTask(id), id)
      throw error
    }
    expect(task).toMatchObject({
      status: 'completed',
      export: { exported: 1, failed: 0 },
    })
    const elapsedMs = performance.now() - began,
      diagnostics = acceptedExport(irodori.userDataDir, id)
    expect(diagnostics.files[0].diagnostics?.renderer).toBe('gpu')
    expect(diagnostics.files[0].status).toBe('exported')
    expect(
      (await readFile(join(destination, diagnostics.files[0].outputName!))).byteLength,
    ).toBeGreaterThan(0)
    exports.push({ elapsedMs, diagnostics })
  }
  const engine = new PreviewEngine(),
    gpu = new RawGpuRenderer(),
    directory = info.outputPath('merge-source')
  await mkdir(directory)
  let merge: Awaited<ReturnType<typeof prepareSource>> | undefined
  try {
    const metadata = await engine.inspect(original)
    const source: MergeSource = { photo, metadata, capture: metadata.capture!, relativeEv: 0 }
    merge = await prepareSource(original, directory, 0, source, source, gpu)
    expect(merge.measurement?.backend).toBe('gpu')
  } finally {
    gpu.close()
    await engine.close()
  }
  expect((await managedOriginalHashes(irodori.userDataDir, [photo]))[0].sha256).toBe(inputHash)
  const delta = (before: number, after: number) => ((after - before) / before) * 100
  await writeFile(
    info.outputPath('workflow-profile.json'),
    JSON.stringify(
      {
        scope:
          'One bounded observation, not a throughput or regression benchmark. Hidden Electron presentation completion excludes physical scanout. Cold includes import/review/metadata and first opening; revisit uses the managed cache. OS file caches are uncontrolled. Export durations end after actual ExportJobs publication; merge timing is source preparation only, excluding alignment/fusion/publication.',
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        ramBytes: totalmem(),
        input: { path: original, sha256: inputHash },
        coldImportAndOpenMs,
        cachedRevisitMs,
        cachedRevisitChangePercent: delta(coldImportAndOpenMs, cachedRevisitMs),
        exports,
        repeatedExportChangePercent: delta(exports[0].elapsedMs, exports[1].elapsedMs),
        mergePreparation: merge?.measurement,
        adapter: exports[0].diagnostics.files[0].diagnostics?.adapter,
        memory: {
          testProcessRssSampleBytes: process.memoryUsage().rss,
          limits:
            'Renderer logical admission, native process RSS and WASM heap capacity are distinct; no combined process-family peak claim.',
        },
      },
      null,
      2,
    ),
  )
})
