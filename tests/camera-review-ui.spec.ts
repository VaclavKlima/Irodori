import { expect } from '@playwright/test'
import { test } from './electron.fixture'
import { mockImportReview } from './import-review-ui.helpers'

test('defaults to Fast, retains policy across device changes and restarts, and resets in a new dialog', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 3, [0])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    const mode = page.getByRole('combobox', { name: 'Repeat-import checks:' })
    await expect(mode).toHaveValue('camera-fast')
    await mode.selectOption('full')
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await control.evaluate((state) => state.finish())
    await expect(mode).toHaveValue('full')
    await page.getByRole('button', { name: 'Restart review', exact: true }).click()
    await expect(mode).toHaveValue('full')
    await page.getByRole('checkbox', { name: 'Search entire device', exact: true }).check()
    await expect(mode).toHaveValue('full')
    await page.getByRole('button', { name: 'Change device', exact: true }).click()
    await expect(mode).toHaveValue('full')
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    expect((await control.evaluate((state) => state.state())).verificationChoices).toEqual([
      'full',
      'full',
      'full',
      'full',
    ])
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await expect(mode).toHaveValue('camera-fast')
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('awaits queued selections, preserves page, scroll and focus, disables acceptance during Full checking', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 125, [0, 61])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await control.evaluate((state) => state.finish())
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Import pages' })).toContainText('2 / 3')
    const choice = page.getByRole('checkbox', { name: 'Import 62.jpg', exact: true })
    await control.evaluate((state) => state.holdSelections())
    await choice.uncheck()
    const grid = page.getByLabel('Import candidates', { exact: true })
    await grid.evaluate((element) => {
      element.scrollTop = 70
    })
    const position = await grid.evaluate((element) => element.scrollTop)
    const mode = page.getByRole('combobox', { name: 'Repeat-import checks:' })
    await mode.focus()
    await mode.selectOption('full')
    expect((await control.evaluate((state) => state.state())).verifications).toEqual([])
    await control.evaluate((state) => state.releaseSelections())
    await expect(mode).toHaveValue('full')
    await expect(mode).toBeEnabled()
    await expect(mode).toBeFocused()
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    await expect(
      page.getByRole('button', { name: /Import \d+ photos/, exact: true }),
    ).toBeDisabled()
    await expect(page.getByTestId('import-status')).toContainText('Checking previous import')
    await expect(choice).not.toBeChecked()
    await expect(page.getByRole('navigation', { name: 'Import pages' })).toContainText('2 / 3')
    expect(await grid.evaluate((element) => element.scrollTop)).toBe(position)
    await mode.selectOption('camera-fast')
    await expect(page.getByRole('checkbox', { name: 'Import 61.jpg', exact: true })).toBeDisabled()
    await expect(choice).not.toBeChecked()
    await expect(page.getByRole('button', { name: 'Import 122 photos', exact: true })).toBeEnabled()
    await mode.selectOption('full')
    await control.evaluate((state) => state.finishVerification())
    await expect(page.getByRole('button', { name: 'Import 122 photos', exact: true })).toBeEnabled()
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('late snapshots cannot restore a superseded verification policy and Cancel stays usable', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 3, [0])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await control.evaluate((state) => state.finish())
    await expect(page.getByTestId('import-status')).toContainText('Ready to import')
    await control.evaluate((state) => {
      state.holdSnapshots()
      state.refresh()
    })
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).pendingSnapshots)
      .toBeGreaterThan(0)
    const mode = page.getByRole('combobox', { name: 'Repeat-import checks:' })
    await mode.selectOption('full')
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).verifications.length)
      .toBe(1)
    await control.evaluate((state) => state.releaseSnapshots())
    await expect(mode).toHaveValue('full')
    await expect(page.getByTestId('import-status')).toContainText('Checking previous import')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeFocused()
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('verification controls and footer fit 1100 × 700 with the console open', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 65, [0])
  try {
    await (
      await app.browserWindow(page)
    ).evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await page.getByTestId('console-toggle').click()
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await control.evaluate((state) => state.finish())
    for (const locator of [
      page.getByRole('combobox', { name: 'Repeat-import checks:' }),
      page.getByRole('checkbox', { name: 'Import only missing photos' }),
      page.getByRole('button', { name: 'Cancel', exact: true }),
      page.getByRole('button', { name: 'Import 64 photos', exact: true }),
    ]) {
      const bounds = await locator.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(701)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1101)
    }
    const grid = page.getByLabel('Import candidates', { exact: true })
    expect(
      await grid.evaluate(
        (element) => element.clientHeight > 50 && element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('camera-verification-1100-console.png') })
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})
