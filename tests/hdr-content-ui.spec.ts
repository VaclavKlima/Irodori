import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { expectActiveHdrPreview, expectReferenceHdrPreview } from './hdr-test-policy.helpers'
import { HDR_CACHE_MAX_TILES } from '../src/renderer/src/preview/hdr-render-cache'

test.use({ hdrDisplay: true })
test('HDR edits retain the photograph, histogram geometry and source upload through commits, history and monitor changes', async ({
  luma,
}, info) => {
  test.setTimeout(120000)
  const { app, page } = luma
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => window.setContentSize(1100, 700))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview'),
    histogram = page.locator('#histogram')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
  await page.getByTestId('console-toggle').click()
  await expect(histogram.locator('details')).toHaveCount(0)
  await expect(page.getByRole('slider', { name: 'Histogram tonal value' })).toHaveAttribute(
    'aria-valuemax',
    '511',
  )
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const state = {
      canvas,
      loaders: 0,
      hidden: 0,
      histogramHeights: [] as number[],
    }
    const check = () => {
      state.loaders += Number(document.body.textContent?.includes('Loading preview…'))
      state.hidden += Number(
        getComputedStyle(canvas).visibility === 'hidden' || !canvas.isConnected,
      )
      state.histogramHeights.push(
        document.getElementById('histogram')!.getBoundingClientRect().height,
      )
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    Object.assign(window, { hdrContentTest: { state, observer } })
  })
  const rect = await canvas.boundingBox()
  expect(rect).not.toBeNull()
  const frames: number[] = []
  let capturing = true,
    captureError = ''
  // Read the composited photograph. A WebGPU canvas's transient drawing buffer
  // can be discarded even while its last completed image remains on screen.
  const capture = (async () => {
    while (capturing) {
      const variance = await nativeWindow.evaluate(async (window, box) => {
        const image = await window.capturePage(
          {
            x: Math.round(box!.x),
            y: Math.round(box!.y),
            width: Math.round(box!.width),
            height: Math.round(box!.height),
          },
          { stayHidden: true },
        )
        const rgba = image.resize({ width: 32, height: 24 }).toBitmap()
        let sum = 0,
          squares = 0
        for (let i = 0; i < rgba.length; i += 4) {
          const value = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3
          sum += value
          squares += value * value
        }
        const count = rgba.length / 4
        return squares / count - (sum / count) ** 2
      }, rect)
      frames.push(variance)
    }
  })().catch((error) => {
    captureError = String(error)
  })
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  const before = await page.evaluate((id) => window.luma.getEditHistory(id), id)
  const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
  await exposure.fill('1')
  await exposure.press('Enter')
  await expect(canvas).toHaveAttribute('data-exposure', '1')
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  await expect(canvas).toHaveAttribute('data-source-uploads', '1')
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.luma.getEditHistory(id), id)).snapshots.length,
    )
    .toBe(before.snapshots.length + 1)
  const temperature = page.getByRole('spinbutton', { name: 'Temperature value' })
  await temperature.fill('6300')
  await temperature.press('Enter')
  await expect(canvas).toHaveAttribute('data-gesturing', 'false')
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  const savedWhiteBalance = await page.evaluate((id) => window.luma.getEditHistory(id), id)
  await temperature.fill('6500')
  await temperature.fill('6300')
  await temperature.press('Enter')
  await expect(canvas).toHaveAttribute('data-gesturing', 'false')
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  expect(await page.evaluate((id) => window.luma.getEditHistory(id), id)).toEqual(savedWhiteBalance)
  const getPaths = () =>
    page
      .getByRole('slider', { name: 'Histogram tonal value' })
      .locator('path')
      .evaluateAll((paths) => paths.map((p) => p.getAttribute('d')))
  await expect(histogram).toHaveAttribute('data-samples', '65536')
  const settledHistogram = async () => {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLElement>('[data-testid="main-preview"]')!
          const histogram = document.getElementById('histogram')!
          const plot = histogram.querySelector<SVGSVGElement>('svg[role="slider"]')!
          return (
            canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial &&
            canvas.dataset.analysisPending === 'false' &&
            !!canvas.dataset.analysisKey &&
            canvas.dataset.analysisKey === canvas.dataset.displayedAnalysisKey &&
            histogram.dataset.editSerial === canvas.dataset.analysisSerial &&
            plot.dataset.curveEditSerial === canvas.dataset.analysisSerial &&
            plot.dataset.animating === 'false'
          )
        }),
      )
      .toBe(true)
  }
  await settledHistogram()
  const paths = await getPaths()
  for (const mode of ['sdr', 'hdr'] as const) {
    await page.getByLabel('Preview display mode').selectOption(mode)
    await expect
      .poll(async () => {
        const target = await page.evaluate(() => window.luma.getDisplayState())
        return (
          target.mode === mode &&
          (await canvas.getAttribute('data-target-generation')) === String(target.generation)
        )
      })
      .toBe(true)
    await expect(canvas).toHaveAttribute('data-quality', 'normal')
    await settledHistogram()
    await expect.poll(getPaths).toEqual(paths)
    await expect(canvas).toHaveAttribute('data-source-uploads', '1')
  }
  await canvas.focus()
  await canvas.press('1')
  await canvas.press('ArrowRight')
  await settledHistogram()
  await expect.poll(getPaths).toEqual(paths)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-exposure', '0')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-exposure', '1')
  await expect(canvas).toHaveAttribute('data-source-uploads', '1')
  expect(Number(await canvas.getAttribute('data-cached-tiles'))).toBeLessThanOrEqual(
    HDR_CACHE_MAX_TILES,
  )
  const observed = await page.evaluate(() => {
    const { state, observer } = (
      window as unknown as {
        hdrContentTest: {
          state: { loaders: number; hidden: number; histogramHeights: number[] }
          observer: MutationObserver
        }
      }
    ).hdrContentTest
    observer.disconnect()
    return state
  })
  capturing = false
  await capture
  await writeFile(
    info.outputPath('frame-observations.json'),
    JSON.stringify({ ...observed, frames, captureError }, null, 2),
  )
  expect(observed.loaders).toBe(0)
  expect(observed.hidden).toBe(0)
  expect(captureError).toBe('')
  expect(frames.length).toBeGreaterThan(10)
  // The licensed photograph has detail in each view; cleared frames have none.
  expect(frames.filter((variance) => variance < 0.001)).toEqual([])
  expect(
    Math.max(...observed.histogramHeights) - Math.min(...observed.histogramHeights),
  ).toBeLessThan(0.1)
  await page.screenshot({ path: info.outputPath('minimum-console-hdr.png') })
})

test('sharp edits advance while one histogram readback is held and converge to the latest pending edit', async ({
  luma,
}) => {
  test.setTimeout(90000)
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview')
  const histogram = page.locator('#histogram')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(histogram).toHaveAttribute('data-samples', '65536', { timeout: 60000 })
  await expect(histogram).toHaveAttribute('data-pending', 'false')
  const before = await histogram.boundingBox()
  const initialSerial = await histogram.getAttribute('data-edit-serial')
  await page.evaluate(() => {
    const native = GPUBuffer.prototype.mapAsync
    const state = { calls: 0, release: () => undefined as void }
    GPUBuffer.prototype.mapAsync = async function (...args) {
      const mapped = native.apply(this, args)
      if (this.size !== 1801 * 4) return mapped
      state.calls++
      await mapped
      await new Promise<void>((resolve) => {
        state.release = resolve
      })
    }
    Object.assign(window, {
      heldHdrHistogram: {
        state,
        release: () => {
          GPUBuffer.prototype.mapAsync = native
          state.release()
        },
      },
    })
  })
  const input = async (value: number) => {
    await page.evaluate((value) => {
      const label = Array.from(document.querySelectorAll('label')).find(
        (label) => label.textContent === 'Exposure',
      )!
      const slider = document.getElementById(label.htmlFor) as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        slider,
        String(value),
      )
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
    await expect(canvas).toHaveAttribute('data-exposure', String(value))
    await expectActiveHdrPreview(page)
  }
  try {
    await input(0.5)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { heldHdrHistogram: { state: { calls: number } } })
              .heldHdrHistogram.state.calls,
        ),
      )
      .toBe(1)
    await input(1)
    await input(1.5)
    await expect(canvas).toHaveAttribute('data-source-uploads', '1')
    await expect(histogram).toHaveAttribute('data-edit-serial', initialSerial!)
    await expect(histogram).toHaveAttribute('data-pending', 'true')
    await expect(histogram.getByRole('status')).toHaveText('Updating histogram…')
    const after = await histogram.boundingBox()
    expect(after!.height).toBeCloseTo(before!.height, 4)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { heldHdrHistogram: { state: { calls: number } } }).heldHdrHistogram
            .state.calls,
      ),
    ).toBe(1)
  } finally {
    await page.evaluate(() =>
      (
        window as unknown as { heldHdrHistogram: { release: () => void } }
      ).heldHdrHistogram.release(),
    )
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLElement>('[data-testid="main-preview"]')!
        const histogram = document.getElementById('histogram')!
        return (
          histogram.dataset.editSerial === canvas.dataset.completedEditSerial &&
          histogram.dataset.pending === 'false'
        )
      }),
    )
    .toBe(true)
  await page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('label')).find(
      (label) => label.textContent === 'Exposure',
    )!
    document
      .getElementById(label.htmlFor)!
      .dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await expectReferenceHdrPreview(page)
  await expect(histogram).toHaveAttribute('data-samples', '65536')
  await expect(histogram).toHaveAttribute('data-pending', 'false')
})
