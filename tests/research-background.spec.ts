import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { setup, scan, commit } from './library.helpers'
import { importPhotos } from './import.helpers'
import { ExportProcess } from '../src/main/export/process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { distribution, interaction } from '../scripts/research/pipeline/metrics'
import { provenance } from '../scripts/research/pipeline/provenance'
import { attachResearchEvidence } from './research.helpers'

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.afterEach(async ({}, info) => attachResearchEvidence(info))

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('real original-size exports record thirty single jobs and three heterogeneous batches through durable publication', async ({}, info) => {
  test.setTimeout(1800000)
  const fixture = await setup(
    undefined,
    undefined,
    new ExportProcess(resolve('out/main/export-worker.js'), resolve('out/main/preview-worker.js')),
  )
  const sources = [
    'tests/fixtures/sony-zv1.ARW',
    'tests/fixtures/photos/alpine-lake.jpg',
    'tests/fixtures/photos/mountain-ridge.jpg',
  ]
  const hash = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  const sourceHashes = await Promise.all(sources.map(hash)),
    observations: unknown[] = [],
    outputPath = info.outputPath('real-export-measurements.json')
  const evidence = await provenance(sources)
  try {
    await commit(
      fixture.service,
      await scan(
        fixture.service,
        sources.map((path) => resolve(path)),
      ),
    )
    const photos = fixture.service.list().photos,
      raw = photos.find((p) => p.format === 'ARW')!
    expect(raw).toBeTruthy()
    const destination = join(fixture.root, 'research-exports')
    await mkdir(destination)
    const grant = await fixture.service.exports.store.authorize(destination)
    for (const kind of ['individual', 'heterogeneous'] as const)
      for (let repetition = 0; repetition < (kind === 'individual' ? 30 : 3); repetition++) {
        const selected = kind === 'individual' ? [raw] : photos
        const prepared = await fixture.service.prepareExport(selected.map((p) => p.id)),
          at = performance.now()
        const id = await fixture.service.startExport({
          preparationId: prepared.id,
          destinationId: grant.id,
          action: 'maximum',
        })
        let task
        do {
          await new Promise((resolve) => setTimeout(resolve, 5))
          task = fixture.service.listTasks().find((task) => task.id === id)!
        } while (!task.finishedAt)
        expect(task.status, JSON.stringify(fixture.service.exports.results(id))).toBe('completed')
        const files = fixture.service.exports.store.files(id),
          elapsedMs = performance.now() - at
        const outputs = []
        for (const file of files) {
          const path = join(destination, file.outputName!),
            meta = await sharp(path).metadata()
          expect(meta.width).toBeGreaterThan(0)
          expect(meta.height).toBeGreaterThan(0)
          const target = selected.find((p) => p.id === file.photoId)!
          if (target.id === raw.id) expect([meta.width, meta.height]).toEqual([5422, 3622])
          outputs.push({
            photoId: file.photoId,
            bytes: (await readFile(path)).length,
            width: meta.width,
            height: meta.height,
            diagnostics: file.diagnostics,
          })
          await rm(path)
        }
        observations.push({
          kind,
          repetition,
          elapsedMs,
          targets: prepared.targets,
          outputs,
          logicalOutputBytes: outputs.reduce((sum, f) => sum + f.bytes, 0),
        })
        await writeFile(
          outputPath,
          JSON.stringify(
            {
              provenance: evidence,
              observations,
              quality: 100,
              size: 'original',
              condition: 'fresh isolated processing workers; OS/driver caches uncontrolled',
              completeJobDiskTrafficBytes: null,
              aggregatePeakMemoryBytes: null,
              limitation:
                'Existing production scheduler/encoder, not a candidate graph migration. Synthetic CPU transport batches are separate.',
            },
            null,
            2,
          ),
        )
        fixture.service.exports.dismiss(id)
      }
    expect(await Promise.all(sources.map(hash))).toEqual(sourceHashes)
  } finally {
    await fixture.close()
  }
})

test.use({ hdrDisplay: true })
test(
  'actual Exposure interaction measures foreground interference during original-size HDR export',
  foregroundTest(
    'Editing during export measures real foreground Electron presentations and requires a visible window.',
  ),
  async ({ luma }, info) => {
    test.setTimeout(600000)
    const { app, page } = luma
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
    await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await page.getByTestId('console-toggle').click()
    const destination = join(luma.userDataDir, 'research-exports')
    await mkdir(destination)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, destination)
    const grant = await page.evaluate(() => window.luma.chooseExportDestination())
    expect(grant).not.toBeNull()
    const result = await page.evaluate(async (destinationId) => {
      const photoId = (await window.luma.listPhotos()).photos[0].id
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
        device = canvas.getContext('webgpu')!.getConfiguration()!.device
      const slider =
        document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Exposure"]') ??
        (document.getElementById(
          Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Exposure')!
            .htmlFor,
        ) as HTMLInputElement)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
      const settled = async (exposure: number) => {
        const deadline = performance.now() + 60000
        while (
          Number(canvas.dataset.exposure) !== exposure ||
          canvas.dataset.quality !== 'normal'
        ) {
          if (performance.now() > deadline) throw new Error('Exposure refinement did not complete.')
          await frame()
        }
        await device.queue.onSubmittedWorkDone()
        await frame()
      }
      const cases = []
      for (let repetition = 0; repetition < 3; repetition++)
        for (const background of [false, true]) {
          const state = await window.luma.getEdits(photoId)
          if (state.settings.exposureEv !== 0)
            await window.luma.updateEdits(photoId, { exposureEv: 0 }, state.revision)
          await settled(0)
          const at = performance.now(),
            inputs: { serial: number; at: number }[] = [],
            presentations: { serial: number; at: number; quality: string }[] = [],
            times = new Map<number, { serial: number; at: number }>(),
            completions: Promise<void>[] = []
          let taskId: string | undefined,
            taskFinished = false,
            exportElapsedMs: number | undefined,
            inputsDuringExport = 0
          if (background) {
            const prepared = await window.luma.prepareExport([photoId])
            taskId = await window.luma.startExport({
              preparationId: prepared.id,
              destinationId,
              action: 'maximum',
            })
          }
          const poll = setInterval(() => {
            if (taskId && !taskFinished)
              void window.luma.listTasks().then((tasks) => {
                const task = tasks.find((t) => t.id === taskId)
                if (task?.finishedAt) {
                  taskFinished = true
                  exportElapsedMs = performance.now() - at
                }
              })
          }, 100)
          const observer = new MutationObserver(() => {
            const value = Number(canvas.dataset.exposure),
              input = times.get(value),
              quality = canvas.dataset.quality ?? 'unknown'
            if (!input) return
            times.delete(value)
            completions.push(
              (async () => {
                await device.queue.onSubmittedWorkDone()
                await frame()
                presentations.push({ serial: input.serial, at: performance.now(), quality })
              })(),
            )
          })
          observer.observe(canvas, {
            attributes: true,
            attributeFilter: ['data-completed-edit-serial'],
          })
          try {
            for (let i = 0; i < 240; i++) {
              await frame()
              const value = (i - 120) / 100,
                input = { serial: i, at: performance.now() }
              inputs.push(input)
              times.set(value, input)
              inputsDuringExport += Number(background && !taskFinished)
              setter.call(slider, String(value))
              slider.dispatchEvent(new Event('input', { bubbles: true }))
            }
            slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
            await settled(1.19)
            const deadline = performance.now() + 120000
            while (taskId && !taskFinished) {
              if (performance.now() > deadline)
                throw new Error('Background export did not complete.')
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
            const task = taskId
              ? (await window.luma.listTasks()).find((t) => t.id === taskId)
              : undefined
            if (taskId && task?.status !== 'completed') throw new Error('Background export failed.')
            observer.disconnect()
            await Promise.all(completions)
            cases.push({
              repetition,
              background,
              inputs,
              presentations,
              exportElapsedMs,
              inputsDuringExport,
              taskStatus: task?.status,
              results: taskId ? await window.luma.getExportResults(taskId) : undefined,
            })
            if (taskId) await window.luma.dismissTask(taskId)
          } finally {
            observer.disconnect()
            clearInterval(poll)
          }
        }
      return {
        cases,
        dpr: devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
        backend: canvas.dataset.backend,
      }
    }, grant!.id)
    const cases = result.cases.map((c) => ({
      ...c,
      ...interaction(c.inputs, c.presentations),
      completedQuality: c.presentations.reduce(
        (counts, frame) => {
          counts[frame.quality] = (counts[frame.quality] ?? 0) + 1
          return counts
        },
        {} as Record<string, number>,
      ),
    }))
    await writeFile(
      info.outputPath('editing-during-export.json'),
      JSON.stringify(
        {
          provenance: await provenance([
            'tests/fixtures/sony-zv1.ARW',
            'src/main/work-scheduler.ts',
            'src/renderer/src/preview/hdr-presenter.ts',
          ]),
          ...result,
          cases,
          exportDurationsMs: distribution(
            cases.filter((c) => c.background).map((c) => c.exportElapsedMs!),
          ),
          limitation:
            'Actual Exposure/React/history and production export; draft frames are counted explicitly. Includes histogram/presentation fences. No sharp-detail or other-slider acceptance from this workload.',
        },
        null,
        2,
      ),
    )
    expect(result.backend).toBe('webgpu-hdr')
    expect(cases.filter((c) => c.background).every((c) => c.inputsDuringExport > 0)).toBe(true)
  },
)
