import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('toolbar history restores mixed light and lens edits across restart', async ({ luma }) => {
  test.setTimeout(90000)
  let { page } = luma
  await importPhotos(luma.app, page, ['tests/fixtures/sony-zv1.ARW'])
  await page.getByRole('button', { name: 'Lens corrections', exact: true }).click()
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  const enter = async (value: string) => {
    const field = page.getByRole('spinbutton', { name: 'Exposure value' })
    await expect(field).toBeEnabled({ timeout: 30000 })
    await field.fill(value)
    await field.press('Enter')
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
  }
  const confirm = async (exposureEv: number, vignetting: boolean, contrast = 40) => {
    await expect
      .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
      .toMatchObject({ settings: { exposureEv, contrast, lens: { vignetting } } })
    await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue(
      exposureEv.toFixed(2),
    )
    await expect(page.getByRole('checkbox', { name: 'Vignetting', exact: true })).toBeChecked({
      checked: vignetting,
    })
  }
  await enter('0.5')
  const contrast = page.getByRole('spinbutton', { name: 'Contrast value' })
  await expect(contrast).toBeEnabled()
  await contrast.fill('40')
  await contrast.press('Enter')
  await expect
    .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
    .toMatchObject({ settings: { contrast: 40 } })
  await page.getByRole('checkbox', { name: 'Vignetting', exact: true }).uncheck()
  await confirm(0.5, false)
  await enter('-0.5')
  await confirm(-0.5, false)
  ;({ page } = await luma.restart())
  await page.getByRole('button', { name: 'Lens corrections', exact: true }).click()
  await confirm(-0.5, false)
  for (const [exposure, lens, contrast] of [
    [0.5, false, 40],
    [0.5, true, 40],
    [0.5, true, 0],
    [0, true, 0],
  ] as const) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await confirm(exposure, lens, contrast)
  }
  for (const [exposure, lens, contrast] of [
    [0.5, true, 0],
    [0.5, true, 40],
    [0.5, false, 40],
    [-0.5, false, 40],
  ] as const) {
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await confirm(exposure, lens, contrast)
  }
})
