import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { expectAdjustmentBounds, minimumAdjustmentWindow } from './adjustment-input.helpers'
test('Sony Temperature and Tint share one As Shot reset, undo, redo and restart with a compact inspector', async ({
  irodori,
}) => {
  test.setTimeout(90000)
  let { page } = irodori
  await importPhotos(irodori.app, page, ['tests/fixtures/sony-zv1.ARW'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const temperature = page.getByRole('spinbutton', { name: 'Temperature value' }),
    tint = page.getByRole('spinbutton', { name: 'Tint value' })
  await expect(temperature).toBeEditable({ timeout: 40000 })
  const original = await page.evaluate((id) => window.irodori.getEdits(id), id)
  expect(original.whiteBalanceProfile?.provider).toBe('sony-zv1-white-balance')
  await temperature.fill('8000')
  await temperature.press('Enter')
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 1, settings: { whiteBalance: { mode: 'custom', kelvin: 8000 } } })
  await tint.fill('25')
  await tint.press('Enter')
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({
      revision: 2,
      settings: { whiteBalance: { mode: 'custom', kelvin: 8000, tint: 25 } },
    })
  await activateButton(page.getByRole('button', { name: 'As Shot', exact: true }))
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 3, settings: { whiteBalance: { mode: 'as-shot' } } })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect(temperature).toHaveValue('8000')
  await expect(tint).toHaveValue('25')
  await minimumAdjustmentWindow(irodori.app, page)
  await expectAdjustmentBounds(page, tint)
  const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
  ;({ page } = await irodori.restart())
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(history)
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ settings: { whiteBalance: { mode: 'as-shot' } } })
})
