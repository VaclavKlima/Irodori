import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
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
  // Let the 80 ms curve retarget settle; use two stable observations rather than a delay.
  const stablePaths = async () => {
    let previous = await getPaths()
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
      const next = await getPaths()
      if (JSON.stringify(next) === JSON.stringify(previous)) return next
      previous = next
    }
    return previous
  }
  const paths = await stablePaths()
  for (const mode of ['sdr', 'hdr'] as const) {
    await page.getByLabel('Preview display mode').selectOption(mode)
    await expect(canvas).toHaveAttribute('data-quality', 'normal')
    await expect.poll(getPaths).toEqual(paths)
    await expect(canvas).toHaveAttribute('data-source-uploads', '1')
  }
  await canvas.focus()
  await canvas.press('1')
  await canvas.press('ArrowRight')
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
