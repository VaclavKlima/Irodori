import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import type { EditSettings } from '../src/shared/edits'

test('toolbar history restores every light and color adjustment across restart', async ({
  irodori,
}) => {
  let { page } = irodori
  await importPhotos(irodori.app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const controls = [
    ['Exposure', 'exposureEv', 0.5],
    ['Contrast', 'contrast', 40],
    ['Highlights', 'highlights', -45],
    ['Shadows', 'shadows', 65],
    ['Whites', 'whites', -35],
    ['Blacks', 'blacks', 20],
    ['Saturation', 'saturation', 40],
    ['Vibrance', 'vibrance', -35],
  ] as const
  const snapshots = [(await page.evaluate((id) => window.irodori.getEdits(id), id)).settings]
  const confirm = async (settings: EditSettings) => {
    await expect
      .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
      .toMatchObject({ settings })
    for (const [label, key] of controls)
      await expect(page.getByRole('spinbutton', { name: `${label} value` })).toHaveValue(
        key === 'exposureEv' ? settings[key].toFixed(2) : String(settings[key]),
      )
  }
  for (const [label, key, value] of controls) {
    const field = page.getByRole('spinbutton', { name: `${label} value` })
    await expect(field).toBeEnabled()
    await field.fill(String(value))
    await field.press('Enter')
    await expect
      .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
      .toMatchObject({ settings: { [key]: value } })
    snapshots.push((await page.evaluate((id) => window.irodori.getEdits(id), id)).settings)
  }
  ;({ page } = await irodori.restart())
  await confirm(snapshots.at(-1)!)
  for (const settings of snapshots.slice(0, -1).reverse()) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await confirm(settings)
  }
  for (const settings of snapshots.slice(1)) {
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await confirm(settings)
  }
})
