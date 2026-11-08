import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { holdNormalOffscreenFence } from './hdr-presentation-gate.helpers'

test('region drawing stays on committed HDR geometry while requested zoom and pan wait', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
  const photo = page.getByTestId('main-preview')
  const viewport = page.getByTestId('preview-viewport')
  await expect(photo).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(photo).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await activateButton(page.getByRole('button', { name: 'Inspect region', exact: true }))
  await expect(page.getByRole('textbox', { name: 'Inspection X', exact: true })).toBeEnabled()
  await photo.focus()
  await photo.press('1')
  await expect
    .poll(() =>
      photo.evaluate((element) => element.dataset.presentedView === element.dataset.requestedView),
    )
    .toBe(true)
  const initial = await photo.evaluate(
    (element) =>
      JSON.parse(element.dataset.presentedView!) as { scale: number; x: number; y: number },
  )
  const gate = await holdNormalOffscreenFence(page)
  try {
    await photo.press('+')
    await expect
      .poll(async () => (await gate.evaluate((control) => control.state())).held)
      .toBe(true)
    await photo.press('ArrowRight')
    expect(await photo.evaluate((element) => JSON.parse(element.dataset.presentedView!))).toEqual(
      initial,
    )
    const requested = await photo.evaluate(
      (element) =>
        JSON.parse(element.dataset.requestedView!) as { scale: number; x: number; y: number },
    )
    expect(requested.scale).toBeGreaterThan(initial.scale)
    expect(requested.x).not.toBe(initial.x)
    const box = (await viewport.boundingBox())!
    const point = { x: box.width / 2 - 50, y: box.height / 2 + 30 }
    const image = {
      width: Number(await viewport.getAttribute('data-image-width')),
      height: Number(await viewport.getAttribute('data-image-height')),
    }
    await page.mouse.move(box.x + point.x, box.y + point.y)
    await page.mouse.down()
    await page.mouse.move(box.x + point.x + 80, box.y + point.y + 40)
    await page.mouse.up()
    await expect(page.getByRole('textbox', { name: 'Inspection X', exact: true })).toHaveValue(
      String(Math.floor((point.x - box.width / 2 - initial.x) / initial.scale + image.width / 2)),
    )
    await expect(page.getByRole('textbox', { name: 'Inspection Width', exact: true })).toHaveValue(
      '80',
    )
    const old = (await page.getByTestId('inspection-region-frame').boundingBox())!
    await gate.evaluate((control) => control.release())
    await expect
      .poll(() =>
        photo.evaluate(
          (element) => element.dataset.presentedView === element.dataset.requestedView,
        ),
      )
      .toBe(true)
    await expect
      .poll(async () => (await page.getByTestId('inspection-region-frame').boundingBox())!.width)
      .toBeGreaterThan(old.width)
    await expect(page.getByRole('textbox', { name: 'Inspection Width', exact: true })).toHaveValue(
      '80',
    )
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})
