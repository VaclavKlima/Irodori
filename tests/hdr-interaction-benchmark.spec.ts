import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { recordBenchmark } from './benchmark.helpers'

test.use({ hdrDisplay: true })
test('benchmarks warmed HDR pan and zoom through GPU completion', async ({ luma }, info) => {
  test.skip(process.env.LUMA_PREVIEW_BENCHMARK !== '1', 'Select target hdr-interaction-benchmark.')
  test.setTimeout(180000)
  const { app, page } = luma
  const native = await app.browserWindow(page)
  await native.evaluate((window) => window.setContentSize(1440, 900))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await canvas.focus()
  const initialSerial = Number(await canvas.getAttribute('data-requested-serial'))
  await canvas.press('1')
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-requested-serial')))
    .toBeGreaterThan(initialSerial)
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          element.dataset.quality === 'normal' &&
          element.dataset.completedEditSerial === element.dataset.requestedSerial,
      ),
    )
    .toBe(true)
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const device = canvas.getContext('webgpu')!.getConfiguration()!.device
    const samples: Record<string, number[]> = { pan: [], zoom: [] }
    const states: unknown[] = []
    for (const kind of ['pan', 'zoom'] as const) {
      for (let i = 0; i < 45; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const serial = canvas.dataset.presentationSerial
        const started = performance.now()
        if (kind === 'pan')
          canvas.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: i % 2 ? 'ArrowLeft' : 'ArrowRight',
              bubbles: true,
            }),
          )
        else
          canvas.parentElement!.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: i % 2 ? -4 : 4,
              ctrlKey: true,
              clientX: canvas.getBoundingClientRect().x + 200,
              clientY: canvas.getBoundingClientRect().y + 200,
              bubbles: true,
              cancelable: true,
            }),
          )
        await new Promise<void>((resolve) => {
          const check = () => {
            if (canvas.dataset.presentationSerial !== serial) resolve()
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        })
        await device.queue.onSubmittedWorkDone()
        if (i >= 5) samples[kind].push(performance.now() - started)
      }
      states.push({
        kind,
        renderedTiles: canvas.dataset.renderedTiles,
        cachedTiles: canvas.dataset.cachedTiles,
      })
    }
    const p95 = Object.fromEntries(
      Object.entries(samples).map(([kind, values]) => [
        kind,
        [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1],
      ]),
    )
    return {
      samples,
      p95,
      states,
      backend: canvas.dataset.backend,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    }
  })
  await writeFile(info.outputPath('interaction.json'), JSON.stringify(result, null, 2))
  await recordBenchmark(info, {
    family: 'hdr',
    measurements: {
      panP95Ms: result.p95.pan,
      zoomP95Ms: result.p95.zoom,
      warmupGestures: 5,
      samplesPerGesture: 40,
      backend: result.backend,
      viewport: result.viewport,
    },
    gates: [
      { metric: 'panP95Ms', operator: '<=', limit: 33 },
      { metric: 'zoomP95Ms', operator: '<=', limit: 33 },
    ],
    evidence: [info.outputPath('interaction.json')],
  })
  expect(result.backend).toBe('webgpu-hdr')
  expect(result.p95.pan).toBeLessThanOrEqual(33)
  expect(result.p95.zoom).toBeLessThanOrEqual(33)
})

test('benchmarks HDR mouse dragging with burst input through GPU completion', async ({
  luma,
}, info) => {
  test.skip(process.env.LUMA_PREVIEW_BENCHMARK !== '1', 'Select target hdr-interaction-benchmark.')
  test.setTimeout(120000)
  const { app, page } = luma
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1440, 900))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview'),
    viewport = page.getByTestId('preview-viewport')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await canvas.focus()
  const initialSerial = Number(await canvas.getAttribute('data-requested-serial'))
  await canvas.press('1')
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-requested-serial')))
    .toBeGreaterThan(initialSerial)
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          element.dataset.quality === 'normal' &&
          element.dataset.completedEditSerial === element.dataset.requestedSerial,
      ),
    )
    .toBe(true)
  await expect(viewport).toHaveAttribute('data-scale', '1')
  const box = (await viewport.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(viewport).toHaveAttribute('data-dragging', 'true')
  const result = await viewport
    .evaluate(async (el) => {
      const canvas = el.querySelector<HTMLCanvasElement>('canvas')!
      const device = canvas.getContext('webgpu')!.getConfiguration()!.device
      const bounds = el.getBoundingClientRect()
      const latencies: number[] = []
      let lastOffset = 0,
        before = 0
      const move = (offset: number) => {
        if (document.pointerLockElement === el)
          el.dispatchEvent(
            new MouseEvent('mousemove', {
              bubbles: true,
              buttons: 1,
              movementX: offset - lastOffset,
              movementY: (offset - lastOffset) / 2,
            }),
          )
        else
          el.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              pointerId: 1,
              isPrimary: true,
              pointerType: 'mouse',
              buttons: 1,
              clientX: bounds.x + bounds.width / 2 + offset,
              clientY: bounds.y + bounds.height / 2 + offset / 2,
            }),
          )
        lastOffset = offset
      }
      // Smaller tiles require the diagonal path's intermediate corners, not just its extrema.
      // Prepare every measured position before the unchanged five warmups and 40 samples.
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const serial = canvas.dataset.presentationSerial
        for (let event = 0; event < 4; event++) move(((i * 4 + event) % 40) * 4 - 80)
        await new Promise<void>((resolve) => {
          const check = () =>
            canvas.dataset.presentationSerial !== serial ? resolve() : requestAnimationFrame(check)
          requestAnimationFrame(check)
        })
        await device.queue.onSubmittedWorkDone()
      }
      for (let i = 0; i < 45; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const serial = canvas.dataset.presentationSerial,
          start = performance.now()
        for (let event = 0; event < 4; event++) {
          // MouseEvent movement is integral. Every measured burst must produce motion.
          const offset = i < 5 ? (i % 2 ? -80 : 80) : ((i * 4 + event) % 40) * 4 - 80
          move(offset)
        }
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            if (canvas.dataset.presentationSerial !== serial) resolve()
            else if (performance.now() - start > 1000)
              reject(
                new Error(
                  `Drag did not draw: ${JSON.stringify({
                    dragging: el.dataset.dragging,
                    locked: document.pointerLockElement === el,
                    x: el.dataset.panX,
                    y: el.dataset.panY,
                  })}`,
                ),
              )
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        })
        await device.queue.onSubmittedWorkDone()
        if (i === 4) before = Number(canvas.dataset.renderedTiles)
        if (i >= 5) latencies.push(performance.now() - start)
      }
      return {
        latencies,
        p95Ms: [...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1],
        renderedTilesBefore: before,
        renderedTilesAfter: Number(canvas.dataset.renderedTiles),
        backend: canvas.dataset.backend,
        pointerLocked: document.pointerLockElement === el,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      }
    })
    .finally(() => page.mouse.up())
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true)
  await writeFile(info.outputPath('drag.json'), JSON.stringify(result, null, 2))
  await recordBenchmark(info, {
    family: 'hdr',
    measurements: {
      p95Ms: result.p95Ms,
      backend: result.backend,
      pointerLocked: result.pointerLocked,
      viewport: result.viewport,
      samples: 40,
      warmupGestures: 5,
      eventsPerFrame: 4,
    },
    gates: [{ metric: 'p95Ms', operator: '<=', limit: 33 }],
    evidence: [info.outputPath('drag.json')],
  })
  expect(result.backend).toBe('webgpu-hdr')
  expect(result.renderedTilesAfter).toBe(result.renderedTilesBefore)
  expect(result.p95Ms).toBeLessThanOrEqual(33)
})
