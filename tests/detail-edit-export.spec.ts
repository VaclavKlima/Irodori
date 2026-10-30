import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { ExportProcess } from '../src/main/export/process'
import type { ExportRenderJob } from '../src/main/export/types'
import { exportDetailPolicy } from '../src/main/export/detail-policy'
import { neutralNoiseReduction, neutralDetailSharpening } from '../src/shared/spatial-detail'
import { exportFixture } from './export.helpers'
import { cropAdmission } from './crop-frame.helpers'

const previous = process.env.IRODORI_EXPORT_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_EXPORT_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = previous
})

test('the production library freezes persisted spatial edits into a real JPEG export while later editing continues', async () => {
  const t = await exportFixture(1),
    id = t.photos[0].id,
    source = join(t.root, 'library', 'originals', id, 'original.png'),
    original = await readFile(source),
    renderer = Reflect.get(t.library.exports, 'renderer') as Pick<ExportProcess, 'render'>,
    worker = new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    ),
    render = worker.render.bind(worker)
  let resume!: () => void,
    captured: ExportRenderJob | undefined,
    completed: Awaited<ReturnType<ExportProcess['render']>> | undefined
  const attempts: ExportRenderJob[] = []
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  renderer.render = async (job, signal, progress) => {
    captured = structuredClone(job)
    attempts.push(captured)
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => {
        signal.removeEventListener('abort', cancelled)
        reject(signal.reason)
      }
      signal.addEventListener('abort', cancelled, { once: true })
      void held.then(() => {
        signal.removeEventListener('abort', cancelled)
        resolve()
      })
      if (signal.aborted) cancelled()
    })
    signal.throwIfAborted()
    completed = await render(job, signal, progress)
    return completed
  }
  t.library.cropAdmission = async () => cropAdmission()
  try {
    const edited = await t.library.updateEdits(
        id,
        {
          noiseReduction: { luminance: 35, chroma: 50 },
          detailSharpening: { amount: 40, radius: 1.7, threshold: 30 },
        },
        0,
      ),
      preparation = await t.library.prepareExport([id]),
      grant = await t.library.exports.store.authorize(t.destination),
      jobId = await t.library.startExport({
        preparationId: preparation.id,
        destinationId: grant.id,
        action: 'high',
      })
    await expect.poll(() => captured).toBeDefined()
    expect(captured!.source.processing).toMatchObject({
      revision: edited.revision,
      noiseReduction: edited.settings.noiseReduction,
      detailSharpening: edited.settings.detailSharpening,
    })
    expect(captured!.detailPolicy).toEqual(exportDetailPolicy)
    await t.library.updateEdits(
      id,
      { noiseReduction: neutralNoiseReduction, detailSharpening: neutralDetailSharpening },
      edited.revision,
    )
    resume()
    await expect
      .poll(() => t.library.listTasks().find((task) => task.id === jobId)?.finishedAt)
      .toBeTruthy()
    expect(
      t.library.listTasks().find((task) => task.id === jobId)?.export,
      JSON.stringify(t.library.exports.results(jobId)),
    ).toMatchObject({ exported: 1, failed: 0 })
    expect(completed!.diagnostics!.detail!.primary!.preparation).toBe('filtered')
    expect(captured!.source.processing.noiseReduction).toEqual(edited.settings.noiseReduction)
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    for (const attempt of attempts)
      expect(attempt.source.processing).toMatchObject({
        noiseReduction: edited.settings.noiseReduction,
        detailSharpening: edited.settings.detailSharpening,
        revision: edited.revision,
      })
    const info = await sharp(join(t.destination, 'Photo-0.jpg')).metadata()
    expect([info.width, info.height, info.format]).toEqual([17, 11, 'jpeg'])
    expect((await t.library.getEdits(id)).settings.noiseReduction).toEqual(neutralNoiseReduction)
    expect(await readFile(source)).toEqual(original)
  } finally {
    resume()
    await t.close()
  }
})
