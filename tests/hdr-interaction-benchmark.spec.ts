import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { benchmarkImport, finishBenchmarkImport } from './import-foreground.helpers'

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
  const importTask = await benchmarkImport(app, page, info)
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
  await finishBenchmarkImport(page, importTask)
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
  const importTask = await benchmarkImport(app, page, info)
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
  await finishBenchmarkImport(page, importTask)
})

test('benchmarks uninterrupted HDR navigation on warm and cold tiles through GPU completion', async ({
  luma,
}, info) => {
  test.skip(process.env.LUMA_PREVIEW_BENCHMARK !== '1', 'Select target hdr-interaction-benchmark.')
  test.setTimeout(180000)
  const { app, page } = luma
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1440, 900))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview'),
    viewport = page.getByTestId('preview-viewport')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  await focusPreviewWindow(app, page)
  const importTask = await benchmarkImport(app, page, info)
  const measurements = []
  for (const cold of [false, true]) {
    for (const gesture of ['horizontal', 'vertical', 'drag'] as const) {
      await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('fit')
      await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('1')
      await expect
        .poll(() =>
          canvas.evaluate(
            (el) =>
              el.dataset.quality === 'normal' &&
              el.dataset.completedEditSerial === el.dataset.requestedSerial,
          ),
        )
        .toBe(true)
      const box = (await viewport.boundingBox())!
      const cursor = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) }
      await page.mouse.move(cursor.x, cursor.y)
      if (!cold)
        await viewport.evaluate(async (el, gesture) => {
          const canvas = el.querySelector<HTMLCanvasElement>('canvas')!
          const positions = Array.from({ length: 45 }, (_, i) => ({
            x: gesture === 'vertical' ? 0 : Math.round(Math.sin(i / 8) * 60),
            y: gesture === 'horizontal' ? 0 : Math.round(Math.cos(i / 8) * 40),
          }))
          // Prepare the complete path before acquiring the measured drag's native lock.
          // Release can travel another 24 CSS pixels; include its bounding corners.
          if (gesture === 'drag')
            for (const x of [-84, 84]) for (const y of [-64, 64]) positions.push({ x, y })
          positions.push({ x: 0, y: 0 })
          let previous = { x: 0, y: 0 }
          for (const position of positions) {
            el.dispatchEvent(
              new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaX: previous.x - position.x,
                deltaY: previous.y - position.y,
              }),
            )
            previous = position
            const start = performance.now()
            do {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              if (performance.now() - start > 2000)
                throw new Error('Warm navigation did not settle.')
            } while (
              canvas.dataset.quality !== 'normal' ||
              canvas.dataset.completedEditSerial !== canvas.dataset.requestedSerial
            )
          }
        }, gesture)
      if (gesture === 'drag') {
        await page.mouse.down()
        await expect
          .poll(() =>
            viewport.evaluate(
              (el) => document.pointerLockElement === el || el.hasPointerCapture(1),
            ),
          )
          .toBe(true)
      }
      const result = await viewport
        .evaluate(
          async (el, { gesture, cold, cursor }) => {
            const canvas = el.querySelector<HTMLCanvasElement>('canvas')!,
              device = canvas.getContext('webgpu')!.getConfiguration()!.device,
              histogram = document.getElementById('histogram')!
            const frame = () =>
              new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            const wait = async (condition: () => boolean) => {
              const start = performance.now()
              while (!condition()) {
                if (performance.now() - start > 2000) throw new Error('Navigation did not settle.')
                await frame()
              }
            }
            let lastX = 0,
              lastY = 0
            const position = (i: number) => {
              const x = cold ? Math.round(-1400 + i * 64) : Math.round(Math.sin(i / 8) * 60),
                y = cold ? Math.round(-1000 + i * 45) : Math.round(Math.cos(i / 8) * 40)
              return { x: gesture === 'vertical' ? 0 : x, y: gesture === 'horizontal' ? 0 : y }
            }
            const move = (x: number, y: number) => {
              const dx = x - lastX,
                dy = y - lastY
              // Four events share one requested view, with input continuing every frame.
              for (let n = 0; n < 4; n++) {
                const nextX = Math.round(lastX + (dx * (n + 1)) / 4),
                  nextY = Math.round(lastY + (dy * (n + 1)) / 4),
                  previousX = Math.round(lastX + (dx * n) / 4),
                  previousY = Math.round(lastY + (dy * n) / 4)
                if (gesture === 'drag') {
                  if (document.pointerLockElement === el)
                    el.dispatchEvent(
                      new MouseEvent('mousemove', {
                        bubbles: true,
                        buttons: 1,
                        movementX: nextX - previousX,
                        movementY: nextY - previousY,
                      }),
                    )
                  else
                    el.dispatchEvent(
                      new PointerEvent('pointermove', {
                        bubbles: true,
                        buttons: 1,
                        isPrimary: true,
                        pointerType: 'mouse',
                        pointerId: 1,
                        clientX: cursor.x + nextX,
                        clientY: cursor.y + nextY,
                      }),
                    )
                } else
                  el.dispatchEvent(
                    new WheelEvent('wheel', {
                      bubbles: true,
                      cancelable: true,
                      deltaX: previousX - nextX,
                      deltaY: previousY - nextY,
                    }),
                  )
              }
              lastX = x
              lastY = y
            }
            const renderedBefore = Number(canvas.dataset.renderedTiles),
              uploadsBefore = Number(canvas.dataset.sourceUploads),
              histogramSerial = histogram.dataset.editSerial
            const inputTimes = new Map<number, number>(),
              latencies: number[] = [],
              completions: Promise<void>[] = [],
              presentations: { at: number; serial: number; quality: string }[] = []
            let inputFinished = false,
              regressed = false,
              histogramUpdates = 0,
              previous = Number(canvas.dataset.completedEditSerial)
            const histogramObserver = new MutationObserver(() => {
              histogramUpdates++
            })
            histogramObserver.observe(histogram, {
              attributes: true,
              attributeFilter: ['data-edit-serial'],
            })
            const observer = new MutationObserver(() => {
              const serial = Number(canvas.dataset.completedEditSerial)
              regressed ||= serial < previous
              if (serial === previous) return
              previous = serial
              if (!inputFinished)
                presentations.push({
                  at: performance.now(),
                  serial,
                  quality: canvas.dataset.quality!,
                })
              const input = inputTimes.get(serial)
              if (input === undefined) return
              inputTimes.delete(serial)
              completions.push(
                (async () => {
                  await device.queue.onSubmittedWorkDone()
                  latencies.push(performance.now() - input)
                })(),
              )
            })
            observer.observe(canvas, {
              attributes: true,
              attributeFilter: ['data-completed-edit-serial'],
            })
            const started = performance.now()
            for (let i = 0; i < 45; i++) {
              await frame()
              if (i >= 5)
                inputTimes.set(Number(canvas.dataset.requestedSerial) + 1, performance.now())
              const { x, y } = position(i)
              move(x, y)
            }
            inputFinished = true
            const ended = performance.now()
            if (gesture === 'drag') {
              el.dispatchEvent(
                new PointerEvent('pointerup', {
                  bubbles: true,
                  button: 0,
                  pointerId: 1,
                  pointerType: 'mouse',
                }),
              )
              document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
              await wait(() => el.dataset.gliding === 'false')
            }
            const settled = performance.now()
            await wait(
              () =>
                canvas.dataset.quality === 'normal' &&
                canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial,
            )
            await device.queue.onSubmittedWorkDone()
            const refinementMs = performance.now() - settled
            await Promise.all(completions)
            observer.disconnect()
            histogramObserver.disconnect()
            return {
              cold,
              gesture,
              latencies,
              p95Ms: [...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1],
              presentations,
              startedAt: started,
              durationMs: ended - started,
              refinementMs,
              regressed,
              histogramUpdates,
              histogramUnchanged: histogramSerial === histogram.dataset.editSerial,
              renderedBefore,
              renderedAfter: Number(canvas.dataset.renderedTiles),
              uploadsBefore,
              uploadsAfter: Number(canvas.dataset.sourceUploads),
              backend: canvas.dataset.backend,
              viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            }
          },
          { gesture, cold, cursor },
        )
        .finally(async () => {
          if (gesture === 'drag') await page.mouse.up()
        })
      measurements.push(result)
    }
  }
  const path = info.outputPath('continuous-navigation.json')
  await writeFile(path, JSON.stringify(measurements, null, 2))
  for (const result of measurements) {
    await recordBenchmark(info, {
      family: 'hdr',
      measurements: {
        gesture: result.gesture,
        cold: result.cold,
        p95Ms: result.p95Ms,
        presentations: result.presentations.length,
        presentationShortfall: Math.max(0, (result.cold ? 10 : 30) - result.presentations.length),
        refinementMs: result.refinementMs,
        backend: result.backend,
        viewport: result.viewport,
      },
      gates: [
        ...(!result.cold ? [{ metric: 'p95Ms', operator: '<=' as const, limit: 33 }] : []),
        { metric: 'presentationShortfall', operator: '<=' as const, limit: 0 },
        { metric: 'refinementMs', operator: '<=' as const, limit: 500 },
      ],
      evidence: [path],
    })
    expect(result.backend).toBe('webgpu-hdr')
    expect(result.regressed).toBe(false)
    expect(result.histogramUpdates).toBe(0)
    expect(result.histogramUnchanged).toBe(true)
    expect(result.uploadsAfter).toBe(result.uploadsBefore)
    expect(result.presentations.length).toBeGreaterThanOrEqual(result.cold ? 10 : 30)
    expect(result.presentations[0].at - result.startedAt).toBeLessThan(result.durationMs / 3)
    expect(result.presentations.at(-1)!.at - result.presentations[0].at).toBeGreaterThan(
      result.durationMs / 2,
    )
    expect(result.refinementMs).toBeLessThanOrEqual(500)
    if (!result.cold) {
      expect(result.renderedAfter).toBe(result.renderedBefore)
      expect(result.p95Ms).toBeLessThanOrEqual(33)
      expect(result.presentations.every((frame) => frame.quality === 'normal')).toBe(true)
    } else expect(result.presentations.some((frame) => frame.quality === 'draft')).toBe(true)
  }
  await finishBenchmarkImport(page, importTask)
})
