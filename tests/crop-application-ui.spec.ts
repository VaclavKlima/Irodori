import { mkdir } from 'node:fs/promises'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'

test('the hidden application applies a native crop and Cancel restores the committed view without another history entry', async ({
  irodori: { app, page },
}) => {
  const source = test.info().outputPath('source', 'crop.png')
  await mkdir(test.info().outputPath('source'))
  await sharp({
    create: {
      width: 100,
      height: 80,
      channels: 4,
      background: { r: 73, g: 110, b: 152, alpha: 1 },
    },
  })
    .png()
    .toFile(source)
  await importPhotos(app, page, [source])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    toolbar = page.getByRole('button', { name: 'Crop photo', exact: true }),
    viewport = page.getByTestId('preview-viewport')
  await expect(toolbar).toBeEnabled()
  await activateButton(toolbar)
  await expect(page.getByTestId('crop-overlay')).toBeVisible()
  const width = page.getByRole('spinbutton', { name: 'Crop width value', exact: true }),
    height = page.getByRole('spinbutton', { name: 'Crop height value', exact: true })
  await width.fill('60')
  await width.press('Enter')
  await height.fill('40')
  await height.press('Enter')
  expect(
    (await page.evaluate((id) => window.irodori.getEditHistory(id), id)).snapshots,
  ).toHaveLength(1)
  await activateButton(page.getByRole('button', { name: 'Apply crop', exact: true }))
  await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
  await expect(viewport).toHaveAttribute('data-image-width', '60')
  await expect(viewport).toHaveAttribute('data-image-height', '40')
  const saved = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
  expect(saved).toMatchObject({ revision: 1, settings: { crop: { width: 0.6, height: 0.5 } } })
  expect(saved.snapshots).toHaveLength(2)
  await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('8')
  await expect(viewport).toHaveAttribute('data-scale', '8')
  await expect(toolbar).toBeEnabled()
  await activateButton(toolbar)
  await expect(page.getByTestId('crop-overlay')).toBeVisible()
  await activateButton(page.getByRole('button', { name: 'Reset crop', exact: true }))
  await expect(width).toHaveValue('100.00')
  await expect(height).toHaveValue('80.00')
  await activateButton(page.getByRole('button', { name: 'Cancel crop', exact: true }))
  await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
  await expect(viewport).toHaveAttribute('data-image-width', '60')
  await expect(viewport).toHaveAttribute('data-image-height', '40')
  await expect(viewport).toHaveAttribute('data-scale', '8')
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(saved)
})
