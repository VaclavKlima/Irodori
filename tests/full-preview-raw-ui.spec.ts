import { expect, test } from './electron.fixture'
import { holdFullPreview } from './full-preview.helpers'
import { choose, expectImportComplete } from './import.helpers'

test('shows a neutral loader on first RAW opening and then native full-resolution pixels', async ({
  luma,
}, info) => {
  const { app, page } = luma
  const gate = await holdFullPreview(app, ['preview:hdr', 'preview:request'])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await choose(app, page, ['tests/fixtures/sony-zv1.ARW'])
    await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('import-status')).toContainText('1 awaiting checks')
    await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const viewport = page.getByTestId('preview-viewport')
    const zoom = page.getByRole('combobox', { name: 'Preview zoom' })
    await expect(page.getByTestId('preview-resolution')).toContainText('Loading full resolution…')
    await expect(viewport).toHaveAttribute('data-resolution', 'loading')
    await expect(zoom).toBeDisabled()
    await expect(viewport.locator('img')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('raw-loading.png') })
    await gate.evaluate((control) => control.release())
    await expectImportComplete(page)
    await expect(viewport).toHaveAttribute('data-resolution', 'full', { timeout: 20000 })
    await zoom.selectOption('1')
    await expect(viewport).toHaveAttribute('data-image-width', '5422')
    await expect(viewport).toHaveAttribute('data-image-height', '3622')
    const dimensions = await page.getByTestId('main-preview').evaluate((element) => ({
      width: (element as HTMLCanvasElement).width,
      css: element.getBoundingClientRect().width,
      dpr: devicePixelRatio,
    }))
    expect(dimensions.width).toBe(Math.round(dimensions.css * dimensions.dpr))
    await page.screenshot({ path: info.outputPath('raw-full-100.png') })
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})
