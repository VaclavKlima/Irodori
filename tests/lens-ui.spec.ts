import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('raster photos explain unavailable corrections without enabling editing', async ({ luma }) => {
  await importPhotos(luma.app, luma.page)
  const disclosure = luma.page.getByRole('button', { name: 'Lens corrections', exact: true })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await expect(luma.page.getByTestId('lens-corrections')).toBeHidden()
  await disclosure.press('Enter')
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(luma.page.getByRole('checkbox', { name: 'Distortion', exact: true })).toBeDisabled()
  await expect(luma.page.getByTestId('lens-corrections')).toContainText(
    'No verified distortion data.',
  )
})
