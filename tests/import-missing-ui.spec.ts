import { revealImportCandidate } from './collection-ui.helpers'
import { expect, test } from './electron.fixture'
import { expectMissingOptionErrors, mockImportReview } from './import-review-ui.helpers'

test('shows known photographs before transfer and accepts exactly the selected missing candidates', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 3, [0])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Import only missing photos' })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    const option = page.getByRole('checkbox', { name: 'Import only missing photos', exact: true })
    await expect(option).toBeChecked()
    await expect(option).toHaveAccessibleDescription(
      'Skip copying photos already in your library. New or unchecked files still receive duplicate checks during import.',
    )
    const known = page.getByRole('checkbox', { name: 'Import 00.jpg', exact: true })
    await expect(known).not.toBeChecked()
    await expect(known).toBeDisabled()
    await expect(known).toHaveAccessibleDescription('Already in library')
    await expect(page.getByRole('checkbox', { name: 'Import 01.jpg', exact: true })).toBeChecked()
    await expect(page.getByTestId('import-status')).toContainText(
      '3 found · 1 already in library · 2 new or unchecked',
    )
    await expect(page.getByRole('dialog')).toContainText('2 selected · 2 KB')
    await expect(page.getByRole('button', { name: 'Import 2 photos', exact: true })).toBeDisabled()
    await control.evaluate((state) => state.checkingPrevious('00.jpg'))
    await expect(page.getByTestId('import-status')).toContainText(
      'Checking previous import: 00.jpg',
    )
    await control.evaluate((state) => state.checkingPrevious())
    await expect(page.getByTestId('import-status')).toContainText('Finding photographs…')
    await control.evaluate((state) => state.finish())
    await page.getByRole('button', { name: 'Import 2 photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const state = await control.evaluate((state) => state.state())
    expect(state.deviceModes).toEqual([true])
    expect(state.accepted).toEqual([['candidate-1', 'candidate-2']])
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('bulk selection spans loaded and unloaded records and future discoveries while excluding known originals', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 61, [0, 60, 64, 65])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('59 selected · 59 KB')
    await control.evaluate((state) => state.holdSelections())
    await page.getByRole('button', { name: 'Deselect all', exact: true }).click()
    await control.evaluate((state) => state.append(5))
    await expect(page.getByTestId('import-status')).toContainText(
      '66 found · 4 already in library · 62 new or unchecked',
    )
    await expect(page.getByRole('dialog')).toContainText('0 selected · 0 KB')
    await revealImportCandidate(page, 60, '61.jpg')
    await expect(
      page.getByRole('checkbox', { name: 'Import 61.jpg', exact: true }),
    ).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Import 64.jpg', exact: true })).toBeDisabled()
    await control.evaluate((state) => state.releaseSelections())
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).selectedIds.length)
      .toBe(0)
    await control.evaluate((state) => state.append(1))
    await expect(
      page.getByRole('checkbox', { name: 'Import 66.jpg', exact: true }),
    ).not.toBeChecked()
    await control.evaluate((state) => state.holdSelections())
    await page.getByRole('button', { name: 'Select all', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('63 selected · 63 KB')
    await expect(
      page.getByRole('checkbox', { name: 'Import 64.jpg', exact: true }),
    ).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Import 66.jpg', exact: true })).toBeChecked()
    await control.evaluate((state) => state.finish())
    await page.getByRole('button', { name: 'Import 63 photos', exact: true }).click()
    expect((await control.evaluate((state) => state.state())).accepted).toEqual([])
    await control.evaluate((state) => state.releaseSelections())
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const accepted = (await control.evaluate((state) => state.state())).accepted[0]
    expect(accepted).toHaveLength(63)
    for (const index of [0, 60, 64, 65]) expect(accepted).not.toContain(`candidate-${index}`)
    expect(accepted).toContain('candidate-66')
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('toggling the option restores prior choices and preserves optimistic selection after mode revisions', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 4, [0, 2])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    const option = page.getByRole('checkbox', { name: 'Import only missing photos', exact: true })
    await page.getByRole('checkbox', { name: 'Import 01.jpg', exact: true }).uncheck()
    await option.focus()
    await page.keyboard.press('Space')
    await expect(option).not.toBeChecked()
    await expect(option).toBeFocused()
    await page.keyboard.press('Space')
    await expect(option).toBeChecked()
    await expect(option).toBeFocused()
    await page.keyboard.press('Space')
    await expect(option).not.toBeChecked()
    await expect(page.getByRole('dialog')).toContainText('3 selected · 3 KB')
    const known = page.getByRole('checkbox', { name: 'Import 00.jpg', exact: true })
    await expect(known).toBeEnabled()
    await expect(known).toBeChecked()
    await expect(known).toHaveAccessibleDescription('Already in library')
    await known.uncheck()
    await option.click()
    await expect(option).toBeChecked()
    await expect(page.getByRole('dialog')).toContainText('1 selected · 1 KB')
    await option.click()
    await expect(option).not.toBeChecked()
    await expect(known).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Import 02.jpg', exact: true })).toBeChecked()
    await expect(
      page.getByRole('checkbox', { name: 'Import 01.jpg', exact: true }),
    ).not.toBeChecked()
    await option.click()
    await expect(option).toBeChecked()
    await control.evaluate((state) => state.holdSelections())
    await page.getByRole('checkbox', { name: 'Import 03.jpg', exact: true }).uncheck()
    // The setter advances the service revision. The next local choice still updates immediately.
    await expect(page.getByRole('dialog')).toContainText('0 selected · 0 KB')
    await control.evaluate((state) => state.releaseSelections())
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).selectedIds)
      .toEqual([])
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('waits for selection and mode responses and rejects duplicate activation before accepting', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 3, [0])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await control.evaluate((state) => {
      state.finish()
      state.holdSelections()
      state.holdModes()
    })
    await page.getByRole('checkbox', { name: 'Import 01.jpg', exact: true }).uncheck()
    const option = page.getByRole('checkbox', { name: 'Import only missing photos', exact: true })
    await option.click()
    await expect(option).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Import 1 photos', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Close import', exact: true })).toBeDisabled()
    expect((await control.evaluate((state) => state.state())).modes).toEqual([])
    // A second activation during the request does not start another mode operation.
    await option.evaluate((element) => (element as HTMLInputElement).click())
    await control.evaluate((state) => state.releaseSelections())
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).pendingModes)
      .toBe(1)
    await control.evaluate((state) => state.holdSnapshots())
    await control.evaluate((state) => state.releaseModes())
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).pendingSnapshots)
      .toBeGreaterThan(0)
    await expect(option).toBeDisabled()
    await control.evaluate((state) => state.releaseSnapshots())
    await expect(option).not.toBeChecked()
    await expect(option).toBeEnabled()
    await page.getByRole('button', { name: 'Import 2 photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const state = await control.evaluate((state) => state.state())
    expect(state.modes).toEqual([{ sessionId: state.sessionId, enabled: false }])
    expect(state.accepted).toEqual([['candidate-0', 'candidate-2']])
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('retains the device preference through restart and broader search while file imports stay independent', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 3, [0])
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    const option = page.getByRole('checkbox', { name: 'Import only missing photos', exact: true })
    await option.click()
    await expect(option).not.toBeChecked()
    await page.getByRole('button', { name: 'Restart review', exact: true }).click()
    await expect(option).not.toBeChecked()
    await page.getByRole('checkbox', { name: 'Search entire device', exact: true }).check()
    await expect(option).not.toBeChecked()
    await page.getByRole('button', { name: 'Change device', exact: true }).click()
    await expect(option).toHaveCount(0)
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await expect(option).not.toBeChecked()
    expect((await control.evaluate((state) => state.state())).deviceModes).toEqual([
      true,
      false,
      false,
      false,
    ])
    await page.getByRole('tab', { name: 'Files and folders' }).click()
    await expect(option).toHaveCount(0)
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Import 00.jpg', exact: true })).toBeEnabled()
    await expect(page.getByRole('dialog')).toContainText('3 selected · 3 KB')
    expect((await control.evaluate((state) => state.state())).onlyMissing).toBeUndefined()
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('reports a failed option change, keeps prior targets, and recovers on retry and disconnection', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 3, [0])
  const errors = await expectMissingOptionErrors(app)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    const option = page.getByRole('checkbox', { name: 'Import only missing photos', exact: true })
    await control.evaluate((state) => state.failModes(true))
    await option.click()
    await expect(page.getByRole('alert')).toContainText('Fixture import option unavailable')
    expect(await errors.evaluate((state) => state.expectedErrors)).toEqual([
      'Fixture import option unavailable',
    ])
    await expect(option).toBeChecked()
    await expect(option).toBeEnabled()
    await expect(page.getByRole('dialog')).toContainText('2 selected · 2 KB')
    await control.evaluate((state) => state.failModes(false))
    await option.click()
    await expect(option).not.toBeChecked()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toContainText('3 selected · 3 KB')
    await control.evaluate((state) => state.disconnect())
    await expect(option).toBeDisabled()
    await expect(page.getByRole('checkbox', { name: 'Import 00.jpg', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Import 3 photos', exact: true })).toBeDisabled()
    await control.evaluate((state) => state.reconnect())
    await expect(option).toBeDisabled()
    await page.getByRole('button', { name: 'Restart review', exact: true }).click()
    await expect(option).toBeEnabled()
    await expect(option).not.toBeChecked()
  } finally {
    await control.evaluate((state) => state.releaseAll())
    await errors.evaluate((state) => state.restore())
  }
})

test('keeps all-known review usable at 1100 × 700 with the console and keyboard focus restoration', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  const control = await mockImportReview(
    app,
    65,
    Array.from({ length: 65 }, (_, index) => index),
  )
  try {
    await (
      await app.browserWindow(page)
    ).evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await page.getByTestId('console-toggle').click()
    await expect(page.getByTestId('console-panel')).toBeVisible()
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('tab', { name: 'Import from device' }).click()
    await page.getByRole('button', { name: 'Import from Camera card', exact: true }).click()
    await control.evaluate((state) => state.finish())
    await expect(page.getByTestId('import-status')).toContainText(
      '65 found · 65 already in library · 0 new or unchecked',
    )
    await expect(page.getByRole('button', { name: 'Import 0 photos', exact: true })).toBeDisabled()
    const option = page.getByRole('checkbox', { name: 'Import only missing photos', exact: true })
    for (const locator of [
      page.getByRole('dialog'),
      option,
      page.getByRole('checkbox', { name: 'Search entire device', exact: true }),
      page.getByRole('button', { name: 'Import 0 photos', exact: true }),
    ]) {
      const bounds = await locator.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1101)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(701)
    }
    const grid = page.getByRole('dialog').locator('[aria-label="Import candidates"]')
    expect(await grid.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('missing-review-1100-console.png') })
    await option.focus()
    await page.keyboard.press('Space')
    await expect(option).not.toBeChecked()
    await expect(option).toBeFocused()
    await expect(page.getByRole('button', { name: 'Import 65 photos', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeFocused()
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})
