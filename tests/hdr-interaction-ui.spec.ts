import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { HDR_CACHE_MAX_TILES } from '../src/renderer/src/preview/hdr-render-cache'

test.use({ hdrDisplay: true })
test('HDR interaction reuses rendered tiles, invalidates edits and targets, and preserves native detail', async ({
  luma,
}) => {
  test.setTimeout(120000)
  const { app, page } = luma
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview'),
    viewport = page.getByTestId('preview-viewport')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  const drawView = async (key: string) => {
    const before = Number(await canvas.getAttribute('data-requested-serial'))
    await canvas.press(key)
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-requested-serial')))
      .toBeGreaterThan(before)
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) =>
            element.dataset.quality === 'normal' &&
            element.dataset.completedEditSerial === element.dataset.requestedSerial,
        ),
      )
      .toBe(true)
  }
  await canvas.focus()
  await drawView('1')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  const completed = async () =>
    page.evaluate(async () => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      await c.getContext('webgpu')!.getConfiguration()!.device.queue.onSubmittedWorkDone()
      return {
        rendered: Number(c.dataset.renderedTiles),
        serial: Number(c.dataset.presentationSerial),
        cached: Number(c.dataset.cachedTiles),
      }
    })
  // Warm adjacent tiles, then return to the same view.
  await drawView('ArrowRight')
  await drawView('ArrowLeft')
  const before = await completed()
  for (const key of ['ArrowRight', 'ArrowLeft', '+', '-']) await drawView(key)
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-presentation-serial')))
    .toBeGreaterThan(before.serial)
  const after = await completed()
  expect(after.rendered).toBe(before.rendered)
  expect(after.cached).toBeLessThanOrEqual(HDR_CACHE_MAX_TILES)
  const burst = await viewport.evaluate(async (el) => {
    const canvas = el.querySelector('canvas')!
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await frame()
    const serial = Number(canvas.dataset.requestedSerial)
    const box = el.getBoundingClientRect()
    for (let i = 0; i < 4; i++)
      el.dispatchEvent(new WheelEvent('wheel', { cancelable: true, deltaX: 2, deltaY: 1 }))
    let anchor = { x: 0, y: 0 }
    for (let i = 0; i < 4; i++) {
      const event = new WheelEvent('wheel', {
        cancelable: true,
        ctrlKey: true,
        deltaY: -2,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      })
      anchor = {
        x: event.clientX - box.left - box.width / 2,
        y: event.clientY - box.top - box.height / 2,
      }
      el.dispatchEvent(event)
    }
    await frame()
    const firstFrameRequests = Number(canvas.dataset.requestedSerial) - serial
    await frame()
    return {
      firstFrameRequests,
      totalRequests: Number(canvas.dataset.requestedSerial) - serial,
      scale: Number(el.dataset.scale),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
      anchor,
    }
  })
  expect(burst.firstFrameRequests).toBe(1)
  expect(burst.totalRequests).toBe(1)
  expect(burst.scale).toBeCloseTo(Math.exp(0.08), 5)
  expect(burst.x).toBeCloseTo(burst.anchor.x - (burst.anchor.x + 8) * Math.exp(0.08), 5)
  expect(burst.y).toBeCloseTo(burst.anchor.y - (burst.anchor.y + 4) * Math.exp(0.08), 5)
  await expect
    .poll(() =>
      canvas.evaluate(
        (el) =>
          el.dataset.quality === 'normal' &&
          el.dataset.completedEditSerial === el.dataset.requestedSerial,
      ),
    )
    .toBe(true)
  const native = await app.browserWindow(page)
  await viewport.hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -4)
  await page.keyboard.up('Control')
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-scale')))
    .toBeGreaterThan(burst.scale)
  expect(await native.evaluate((window) => window.webContents.getZoomFactor())).toBe(1)
  await drawView('1')
  const source = (await page.evaluate(() => window.luma.getPreviewDiagnostics())).renderingIdentity
  await page.getByTestId('console-toggle').click()
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).fill('1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).press('Enter')
  await expect(canvas).toHaveAttribute('data-exposure', '1')
  expect((await completed()).rendered).toBeGreaterThan(after.rendered)
  expect((await page.evaluate(() => window.luma.getPreviewDiagnostics())).renderingIdentity).toBe(
    source,
  )
  await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('sdr')
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({ mode: 'sdr', peak: 1 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await page.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-comparison', 'before')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
})
