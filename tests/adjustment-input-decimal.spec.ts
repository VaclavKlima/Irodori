import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import {
  attemptBusyInput,
  expectAdjustmentBounds,
  holdAdjustmentCommit,
  minimumAdjustmentWindow,
} from './adjustment-input.helpers'

test('pending numeric saves retain focus, allow Tab and reject busy input without queuing history', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const field = page.getByRole('spinbutton', { name: 'Exposure value', exact: true }),
    slider = page.getByRole('slider', { name: 'Exposure', exact: true }),
    next = page.getByRole('spinbutton', { name: 'Contrast value', exact: true })
  await expect(field).toBeEditable({ timeout: 20000 })
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
    original = await history(),
    retained = await field.elementHandle(),
    gate = await holdAdjustmentCommit(app)
  try {
    await field.fill('1.25')
    await field.press('Enter')
    await expect.poll(() => gate.evaluate((gate) => gate.read())).toEqual({ calls: 1, held: true })
    await expect(field).toHaveJSProperty('readOnly', true)
    await expect(field).toHaveJSProperty('disabled', false)
    await expect(field).toBeFocused()
    await expect(slider).toHaveAttribute('aria-disabled', 'true')
    await expect(slider).toHaveJSProperty('disabled', false)
    await field.pressSequentially('9')
    await field.press('ControlOrMeta+a')
    await field.press('ArrowLeft')
    await field.press('Escape')
    await field.press('Enter')
    await attemptBusyInput(field, '4.75')
    await expect(field).toHaveValue('1.25')
    await attemptBusyInput(slider, '4')
    await expect(slider).toHaveValue('1.25')
    expect(await history()).toEqual(original)
    await field.press('Tab')
    await expect(slider).toBeFocused()
    await slider.press('ArrowRight')
    await expect(slider).toHaveValue('1.25')
    await slider.press('Tab')
    await expect(next).toBeFocused()
    await expect(next).toHaveJSProperty('readOnly', true)
    await next.press('Shift+Tab')
    await expect(slider).toBeFocused()
    await slider.press('Shift+Tab')
    await expect(field).toBeFocused()
    expect(await gate.evaluate((gate) => gate.read())).toEqual({ calls: 1, held: true })
    await gate.evaluate((gate) => gate.release())
    await expect.poll(async () => (await history()).revision).toBe(1)
    await expect(field).toHaveJSProperty('readOnly', false)
    await expect(field).toBeFocused()
    expect(await retained!.evaluate((element) => element.isConnected)).toBe(true)
    const saved = await history()
    expect(saved.settings.exposureEv).toBe(1.25)
    expect(saved.snapshots).toHaveLength(2)
    await page.getByTestId('main-preview').focus()
    expect(await history()).toEqual(saved)
    expect(await gate.evaluate((gate) => gate.read())).toEqual({ calls: 1, held: false })
    // Unsupported RAW white balance remains genuinely disabled for a raster source.
    await expect(
      page.getByRole('spinbutton', { name: 'Temperature value', exact: true }),
    ).toBeDisabled()
  } finally {
    await gate.evaluate((gate) => gate.close())
    await gate.dispose()
    await retained?.dispose()
  }
})

test('numeric adjustment entry preserves partial text, cancels invalid drafts and follows confirmed edits', async ({
  irodori,
}) => {
  const { page, app } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const field = page.getByRole('spinbutton', { name: 'Exposure value' })
  await expect(field).toBeEnabled({ timeout: 20000 })
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const state = () => page.evaluate((id) => window.irodori.getEdits(id), id)
  await expect(field).toHaveValue('0.00')
  await expect(page.getByRole('button', { name: 'Reset exposure' })).toHaveCount(0)
  await expect(
    page.getByTestId('adjustments-panel').getByRole('button', { name: /Undo|Redo/ }),
  ).toHaveCount(0)
  await field.fill('')
  await field.pressSequentially('-1.25')
  await expect(field).toHaveValue('-1.25')
  expect((await state()).revision).toBe(0)
  await field.press('Enter')
  await expect.poll(state).toMatchObject({ revision: 1, settings: { exposureEv: -1.25 } })
  await field.fill('2')
  await field.press('Escape')
  await expect(field).toHaveValue('-1.25')
  await field.fill('1')
  await field.pressSequentially('0')
  await expect(field).toHaveValue('10')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await field.press('Tab')
  await expect(field).toHaveValue('-1.25')
  expect((await state()).revision).toBe(1)
  await field.fill('0.001')
  await field.press('Enter')
  await expect(field).toHaveValue('-1.25')
  expect((await state()).revision).toBe(1)
  await field.fill('1.5')
  await field.press('Tab')
  await expect(field).toHaveValue('1.50')
  await expect.poll(state).toMatchObject({ revision: 2, settings: { exposureEv: 1.5 } })
  await field.fill('2')
  await page.evaluate((id) => window.irodori.updateEdits(id, { exposureEv: -0.5 }, 2), id)
  await expect(field).toHaveValue('-0.50')
  await field.press('Enter')
  expect((await state()).revision).toBe(3)
})

test('groups exposure gestures, cancels drafts, resolves external conflicts and keeps the pixel view', async ({
  irodori,
}) => {
  const { page, app } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const preview = page.getByTestId('main-preview')
  await expect(preview).toHaveAttribute('data-editing', 'ready', { timeout: 20000 })
  await expect(preview).toHaveAttribute('data-backend', 'webgl2')
  const zoom = page.getByRole('combobox', { name: 'Preview zoom' })
  await zoom.selectOption('16')
  const slider = page.getByRole('slider', { name: 'Exposure', exact: true })
  await slider.focus()
  for (let i = 0; i < 20; i++) await page.keyboard.down('ArrowRight')
  await expect(slider).toHaveValue('0.2')
  expect((await page.evaluate((id) => window.irodori.getEdits(id), id)).revision).toBe(0)
  await expect(preview).toHaveAttribute('data-exposure', '0.2')
  await page.keyboard.up('ArrowRight')
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 1, settings: { exposureEv: 0.2 } })
  await expect(zoom).toHaveValue('16')
  await expect(slider).toBeEnabled()
  for (let i = 0; i < 5; i++) await page.keyboard.down('ArrowRight')
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowRight')
  await expect(slider).toHaveValue('0.2')
  expect(
    (await page.evaluate((id) => window.irodori.getEditHistory(id), id)).snapshots,
  ).toHaveLength(2)
  await page.keyboard.down('ArrowRight')
  await page.evaluate((id) => window.irodori.updateEdits(id, { exposureEv: -1 }, 1), id)
  await expect(slider).toHaveValue('-1')
  await page.keyboard.up('ArrowRight')
  expect((await page.evaluate((id) => window.irodori.getEdits(id), id)).revision).toBe(2)
  await preview.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(slider).toHaveValue('0.2')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(slider).toHaveValue('-1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).fill('0')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).press('Enter')
  await expect(slider).toHaveValue('0')
  await minimumAdjustmentWindow(app, page)
  await expectAdjustmentBounds(page, slider)
  await expect(slider).toBeEnabled()
  await slider.focus()
  await page.keyboard.down('ArrowRight')
  // A normal application close must flush even an unfinished keyboard gesture.
  const restarted = await irodori.restart()
  await expect(restarted.page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue(
    '0.01',
  )
})
