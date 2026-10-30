import { expect, test } from './electron.fixture'
import { mockImportReview } from './import-review-ui.helpers'

test('lists genuine device summaries, retains entries on failure, and polls without overlapping requests', async ({
  irodori,
}) => {
  const { app, page } = irodori
  const control = await mockImportReview(app, 1)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Files and folders' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect((await control.evaluate((state) => state.state())).deviceCalls).toBe(0)
    await page.getByRole('tab', { name: 'Import from device' }).click()
    const card = page.getByRole('button', { name: 'Import from Camera card', exact: true })
    await expect(card).toBeEnabled()
    await expect(card).toContainText('64.0 GB')
    await expect(page.getByRole('button', { name: 'Import from External photos' })).toBeDisabled()
    await control.evaluate((state) => state.failDevices(true))
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Could not refresh devices')
    await expect(card).toBeEnabled()
    await control.evaluate((state) => state.failDevices(false))
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await control.evaluate((state) => state.holdDevices())
    await page.clock.install()
    const before = (await control.evaluate((state) => state.state())).deviceCalls
    await page.clock.runFor(6500)
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).deviceCalls)
      .toBe(before + 1)
    expect((await control.evaluate((state) => state.state())).deviceMaximum).toBe(1)
    await control.evaluate((state) => state.releaseDevices())
    await page.getByRole('tab', { name: 'Files and folders' }).click()
    const stopped = (await control.evaluate((state) => state.state())).deviceCalls
    await page.clock.runFor(6500)
    expect((await control.evaluate((state) => state.state())).deviceCalls).toBe(stopped)
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('restarts explicitly after disconnection and disposes review on device, mode, or tab changes', async ({
  irodori,
}) => {
  const { app, page } = irodori
  const control = await mockImportReview(app, 1)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Search entire device' })).not.toBeChecked()
    await control.evaluate((state) => state.finish())
    await expect(page.getByRole('button', { name: 'Import 1 photos', exact: true })).toBeEnabled()
    await control.evaluate((state) => state.disconnect())
    await expect(page.getByTestId('import-status')).toContainText('Source unavailable')
    await expect(page.getByRole('button', { name: 'Import 1 photos', exact: true })).toBeDisabled()
    await expect(page.getByRole('checkbox', { name: 'Import 00.jpg' })).toBeDisabled()
    await control.evaluate((state) => state.reconnect())
    await expect(page.getByRole('button', { name: 'Import 1 photos', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Restart review', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Import 1 photos', exact: true })).toBeEnabled()
    await page.getByRole('checkbox', { name: 'Search entire device' }).check()
    await expect(page.getByRole('checkbox', { name: 'Search entire device' })).toBeChecked()
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).deviceChoices.length)
      .toBe(3)
    expect((await control.evaluate((state) => state.state())).deviceChoices).toEqual([
      { id: 'card-1', entire: false },
      { id: 'card-1', entire: false },
      { id: 'card-1', entire: true },
    ])
    await page.getByRole('button', { name: 'Change device', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Import from Camera card' })).toBeEnabled()
    await page.getByRole('button', { name: 'Import from Camera card' }).click()
    const active = (await control.evaluate((state) => state.state())).sessionId
    await page.getByRole('tab', { name: 'Files and folders' }).click()
    await expect(page.getByRole('button', { name: 'Choose photos' })).toBeEnabled()
    const state = await control.evaluate((state) => state.state())
    expect(state.cancelled).toContain(active)
    expect(state.disposed).toContain(active)
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('keeps device controls within 1100 × 700 with console open and supports tab keys', async ({
  irodori,
}, testInfo) => {
  const { app, page } = irodori
  const control = await mockImportReview(app, 1)
  try {
    const browserWindow = await app.browserWindow(page)
    await browserWindow.evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await page.getByTestId('console-toggle').click()
    await expect(page.getByTestId('console-panel')).toBeVisible()
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Files and folders' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Import from device' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.getByRole('button', { name: 'Import from Camera card' }).click()
    await control.evaluate((state) => state.finish())
    for (const locator of [
      page.getByRole('dialog'),
      page.getByRole('checkbox', { name: 'Search entire device' }),
      page.getByRole('button', { name: 'Import 1 photos', exact: true }),
    ]) {
      const bounds = await locator.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1101)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(701)
    }
    await page.screenshot({ path: testInfo.outputPath('device-review-1100-console.png') })
    await page.getByRole('tab', { name: 'Import from device' }).focus()
    await page.keyboard.press('Home')
    await expect(page.getByRole('tab', { name: 'Files and folders' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeFocused()
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('restores tab focus after held review disposal for keyboard and pointer navigation', async ({
  irodori,
}) => {
  const { app, page } = irodori
  const control = await mockImportReview(app, 1)
  const files = page.getByRole('tab', { name: 'Files and folders' })
  const device = page.getByRole('tab', { name: 'Import from device' })
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Import 00.jpg' })).toBeEnabled()
    await control.evaluate((state) => state.holdDisposals())
    await files.focus()
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).pendingDisposals)
      .toBe(1)
    await expect(device).toBeDisabled()
    await control.evaluate((state) => state.releaseDisposals())
    await expect(device).toHaveAttribute('aria-selected', 'true')
    await expect(device).toBeFocused()
    // Further navigation works without explicitly focusing the tab again.
    await page.keyboard.press('Home')
    await expect(files).toHaveAttribute('aria-selected', 'true')
    await expect(files).toBeFocused()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Import 00.jpg' })).toBeEnabled()
    await control.evaluate((state) => state.holdDisposals())
    await device.click()
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).pendingDisposals)
      .toBe(1)
    await control.evaluate((state) => state.releaseDisposals())
    await expect(device).toHaveAttribute('aria-selected', 'true')
    await expect(device).toBeEnabled()
    await expect(device).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(files).toHaveAttribute('aria-selected', 'true')
    await expect(files).toBeFocused()
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})
