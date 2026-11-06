import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { foregroundTest } from './foreground'

test(
  'presets remain readable and keyboard accessible at native 1100 × 700 with Console open',
  foregroundTest(
    'Native minimum-size layout, focus and compositor screenshots require foreground presentation.',
  ),
  async ({ irodori: { app, page } }, info) => {
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
    const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    await page.evaluate(async (id) => {
      await window.irodori.createPreset({
        name: 'Soft woodland',
        appearance: { icon: 'soft-look', color: 'green' },
        source: { mode: 'photo', photoId: id, groups: ['light', 'curves', 'color'] },
      })
      await window.irodori.createPreset({
        name: 'Warm evening',
        appearance: { icon: 'sunset', color: 'amber' },
        source: { mode: 'photo', photoId: id, groups: ['light', 'color'] },
      })
      await window.irodori.createPreset({
        name: 'Z — High noise in a very long named night photograph preset',
        appearance: { icon: 'high-noise', color: 'blue' },
        source: { mode: 'photo', photoId: id, groups: ['noise', 'sharpening'] },
      })
    }, id)
    const native = await app.browserWindow(page)
    await native.evaluate((window) => {
      window.unmaximize()
      const [, outer] = window.getSize(),
        [, content] = window.getContentSize()
      window.setMinimumSize(1100, 700 + outer - content)
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await activateButton(page.getByTestId('console-toggle'))
    await activateButton(page.getByRole('tab', { name: 'Geometry', exact: true }))
    await page.getByRole('tab', { name: 'Geometry', exact: true }).press('ArrowDown')
    await expect(page.getByRole('tab', { name: 'Presets', exact: true })).toBeFocused()
    await expect(page.getByRole('tab', { name: 'Presets', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const list = page.getByRole('listbox', { name: 'Saved presets' })
    await expect(page.getByRole('option', { name: /Soft woodland/ })).toBeVisible()
    await expect(list).toHaveAttribute('aria-busy', 'false')
    await list.focus()
    await list.press('Home')
    await expect(page.getByRole('option', { name: /Soft woodland/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const inspector = page.getByTestId('adjustments-panel')
    await expect(inspector).toHaveCSS('width', '344px')
    await expect(page.getByTestId('console-panel')).toBeVisible()
    const bounds = (await inspector.boundingBox())!
    for (const name of [
      '+ New…',
      'Apply to current photo',
      'Apply to selection · 1 photo',
      'Edit details…',
      'Update…',
      'Delete…',
    ]) {
      const button = page.getByRole('button', { name, exact: true })
      await expect(button).toBeVisible()
      const box = (await button.boundingBox())!
      expect(box.y).toBeGreaterThan(bounds.y)
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height)
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
    }
    expect(await list.evaluate((e) => e.clientHeight)).toBeGreaterThanOrEqual(44)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    const screenshot = info.outputPath('presets-minimum-console.png')
    await page.screenshot({ path: screenshot, scale: 'css' })
    await info.attach('Presets at minimum size with Console', {
      path: screenshot,
      contentType: 'image/png',
    })
    const disclosure = page.locator('#panel-presets summary')
    await disclosure.focus()
    await disclosure.press('Enter')
    await expect(page.locator('#panel-presets details')).toHaveAttribute('open', '')
    expect(await list.evaluate((e) => e.clientHeight)).toBeGreaterThanOrEqual(44)
    const deleteBounds = (await page
      .getByRole('button', { name: 'Delete…', exact: true })
      .boundingBox())!
    expect(deleteBounds.y + deleteBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height)
    await page.screenshot({ path: info.outputPath('presets-minimum-expanded.png'), scale: 'css' })
    await activateButton(page.getByRole('button', { name: 'Delete…', exact: true }))
    await expect(
      page
        .getByRole('dialog', { name: 'Delete preset' })
        .getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    async function checkDialogButtons() {
      const dialog = page.getByRole('dialog'),
        box = (await dialog.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(700)
      for (const name of ['Cancel', 'Save preset']) {
        const button = dialog.getByRole('button', { name, exact: true }),
          buttonBox = (await button.boundingBox())!
        await expect(button).toBeVisible()
        expect(buttonBox.y).toBeGreaterThan(box.y)
        expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(box.y + box.height)
      }
    }
    await activateButton(page.getByRole('button', { name: '+ New…', exact: true }))
    const creation = page.getByRole('dialog', { name: 'New preset', exact: true })
    await creation
      .getByRole('textbox', { name: 'Preset name' })
      .fill('High noise — evening photographs in difficult light')
    await expect(creation.locator('details')).not.toHaveAttribute('open', '')
    await creation.locator('summary').focus()
    await creation.locator('summary').press('Enter')
    await creation.getByRole('radio', { name: 'High noise', exact: true }).focus()
    await page.keyboard.press('Space')
    await creation.getByRole('radio', { name: 'Blue', exact: true }).focus()
    await page.keyboard.press('Space')
    await checkDialogButtons()
    await expect(creation.locator('svg[data-preset-icon="high-noise"][width="24"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath('presets-new-picker-minimum.png'), scale: 'css' })
    await activateButton(creation.getByRole('button', { name: 'Cancel', exact: true }))
    await activateButton(page.getByRole('button', { name: 'Edit details…', exact: true }))
    const details = page.getByRole('dialog', { name: 'Edit preset details', exact: true })
    await expect(
      details.getByRole('group', { name: 'Preset appearance', exact: true }),
    ).toContainText('Soft look / blur · Green')
    await details.locator('summary').focus()
    await details.locator('summary').press('Enter')
    await details.getByRole('radio', { name: 'Soft look / blur', exact: true }).focus()
    await checkDialogButtons()
    await page.screenshot({
      path: info.outputPath('presets-details-picker-minimum.png'),
      scale: 'css',
    })
    await page.keyboard.press('Escape')
    await expect(details).toBeVisible()
    await expect(details.locator('summary')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
  },
)
