import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

for (const [label, key, value] of [
  ['Exposure', 'exposureEv', 1.25],
  ['Contrast', 'contrast', 35],
  ['Highlights', 'highlights', -60],
  ['Shadows', 'shadows', 65],
  ['Whites', 'whites', -35],
  ['Blacks', 'blacks', 20],
  ['Saturation', 'saturation', -40],
  ['Vibrance', 'vibrance', 55],
] as const) {
  test(`${label} wires numeric edits, preview and history`, async ({ irodori }) => {
    const { page, app } = irodori
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
    const field = page.getByRole('spinbutton', { name: `${label} value` })
    await expect(field).toBeEnabled({ timeout: 20000 })
    const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    const state = () => page.evaluate((id) => window.irodori.getEdits(id), id)
    await field.fill(String(value))
    await field.press('Enter')
    await expect.poll(state).toMatchObject({ revision: 1, settings: { [key]: value } })
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      `data-${label.toLowerCase()}`,
      String(value),
    )
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(state).toMatchObject({ revision: 2, settings: { [key]: 0 } })
  })
}
