import { revealImportCandidate } from './collection-ui.helpers'
import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { mockImportReview } from './import-review-ui.helpers'

test('keeps discovery selectable and serializes rapid choices against late review snapshots', async ({
  irodori,
}) => {
  const { app, page } = irodori
  const control = await mockImportReview(app)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect(page.getByTestId('import-status')).toContainText('Finding photographs')
    const checkbox = page.getByRole('checkbox', { name: 'Import 00.jpg', exact: true })
    await expect(checkbox).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Import 61 photos', exact: true })).toBeDisabled()
    await control.evaluate((state) => state.holdSelections())
    await checkbox.uncheck()
    await checkbox.check()
    await checkbox.uncheck()
    await expect(checkbox).not.toBeChecked()
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).selections.length)
      .toBe(1)
    await control.evaluate((state) => {
      state.holdSnapshots()
      state.refresh()
    })
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).pendingSnapshots)
      .toBe(1)
    await control.evaluate((state) => state.releaseSelections())
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).selections.length)
      .toBe(3)
    await control.evaluate((state) => state.releaseSnapshots())
    await expect(checkbox).not.toBeChecked()
    expect((await control.evaluate((state) => state.state())).selectionMaximum).toBe(1)
    await control.evaluate((state) => state.failThumbnail('candidate-0'))
    await expect(page.getByText('Thumbnail unavailable', { exact: true })).toBeVisible()
    await expect(checkbox).toBeEnabled()
    await checkbox.check()
    await control.evaluate((state) => state.finish())
    await expect(page.getByRole('button', { name: 'Import 61 photos', exact: true })).toBeEnabled()
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('applies bulk choices to future discovery rows and flushes queued choices before accepting', async ({
  irodori,
}) => {
  const { app, page } = irodori
  const control = await mockImportReview(app, 1)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Import 00.jpg' })).toBeEnabled()
    await control.evaluate((state) => state.holdSelections())
    await page.getByRole('button', { name: 'Deselect all', exact: true }).click()
    await control.evaluate((state) => state.append(1))
    await expect(page.getByRole('checkbox', { name: 'Import 01.jpg' })).not.toBeChecked()
    await control.evaluate((state) => state.releaseSelections())
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).selections.length)
      .toBe(1)
    await control.evaluate((state) => state.append(1))
    await expect(page.getByRole('checkbox', { name: 'Import 02.jpg' })).not.toBeChecked()
    await page.getByRole('button', { name: 'Select all', exact: true }).click()
    await control.evaluate((state) => state.append(1))
    await expect(page.getByRole('checkbox', { name: 'Import 03.jpg' })).toBeChecked()
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).selections.length)
      .toBe(2)
    await control.evaluate((state) => {
      state.finish()
      state.holdSelections()
    })
    await expect(page.getByTestId('import-status')).toContainText('Ready to import')
    await page.getByRole('checkbox', { name: 'Import 00.jpg' }).uncheck()
    await page.getByRole('button', { name: 'Import 3 photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    expect((await control.evaluate((state) => state.state())).accepted).toEqual([])
    await control.evaluate((state) => state.releaseSelections())
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await control.evaluate((state) => state.state())).accepted).toEqual([
      ['candidate-1', 'candidate-2', 'candidate-3'],
    ])
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('requests visible thumbnails before lookahead and scrolls before thumbnail completion', async ({
  irodori,
}, testInfo) => {
  const { app, page } = irodori
  const control = await mockImportReview(app)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).thumbnails.length)
      .toBeGreaterThan(0)
    await expect
      .poll(async () =>
        (await control.evaluate((state) => state.state())).thumbnails.some(
          (request) => request.ids.length > 0,
        ),
      )
      .toBe(true)
    const first = (await control.evaluate((state) => state.state())).thumbnails.find(
      (request) => request.ids.length > 0,
    )!
    expect(first.ids.length).toBeGreaterThan(0)
    expect(first.ids.length).toBeLessThan(60)
    expect(first.ids[0]).toBe('candidate-0')
    const visitedAt = Date.now()
    await revealImportCandidate(page, 60, '60.jpg')
    const last = page.getByRole('checkbox', { name: 'Import 60.jpg', exact: true })
    await expect(last).toBeEnabled()
    const selectableMs = Date.now() - visitedAt
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).thumbnails.at(-1)?.ids)
      .toContain('candidate-60')
    await last.uncheck()
    await control.evaluate((state) => state.finish())
    await expect(page.getByRole('button', { name: 'Import 60 photos', exact: true })).toBeEnabled()
    await expect(page.getByRole('dialog').locator('img')).toHaveCount(0)
    const releasedAt = Date.now()
    await control.evaluate((state) => state.releaseThumbnails())
    await expect(page.getByRole('dialog').locator('img').first()).toBeVisible()
    await writeFile(
      testInfo.outputPath('review-scroll-ui-timings.json'),
      JSON.stringify(
        {
          measurement: 'Electron UI with fixture thumbnails held behind an IPC gate',
          newlyVisitedWindowSelectableMs: selectableMs,
          firstThumbnailAfterGateReleaseMs: Date.now() - releasedAt,
        },
        null,
        2,
      ),
    )
    await expect(last).not.toBeChecked()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeFocused()
    const state = await control.evaluate((state) => state.state())
    expect(state.cancelled).toContain(state.sessionId)
    expect(state.disposed).toContain(state.sessionId)
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})

test('preserves checkbox focus and choices when discovery prepends; other controls retain focus', async ({
  irodori,
}) => {
  const { app, page } = irodori,
    control = await mockImportReview(app, 60)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await revealImportCandidate(page, 59, '59.jpg')
    const chosen = page.getByRole('checkbox', { name: 'Import 59.jpg', exact: true })
    await chosen.uncheck()
    await chosen.focus()
    await control.evaluate((s) => s.prepend(1))
    // Candidate 59 moves into the second chunk; wait for the new order to mount
    // before testing recovered focus rather than the pre-prepend input node.
    await expect(page.getByTestId('import-status')).toContainText('61 found')
    await expect(page.getByTestId('import-scroll')).toHaveAttribute('data-cache-photos', '61')
    await expect(page.getByTestId('import-scroll')).toHaveAttribute('aria-busy', 'false')
    await expect(chosen).not.toBeChecked()
    await expect(chosen).toBeFocused()
    await page.keyboard.press('Space')
    await expect(chosen).toBeChecked()
    const other = page.getByRole('button', { name: 'Select all', exact: true })
    await other.focus()
    await control.evaluate((s) => s.prepend(1))
    await expect(page.getByTestId('import-status')).toContainText('62 found')
    await expect(page.getByTestId('import-scroll')).toHaveAttribute('data-cache-photos', '62')
    await expect(page.getByTestId('import-scroll')).toHaveAttribute('aria-busy', 'false')
    await expect(other).toBeFocused()
  } finally {
    await control.evaluate((s) => s.releaseAll())
  }
})
