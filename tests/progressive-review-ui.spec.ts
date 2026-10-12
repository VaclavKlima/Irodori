import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { mockImportReview } from './import-review-ui.helpers'

test('keeps discovery selectable and serializes rapid choices against late review snapshots', async ({
  luma,
}) => {
  const { app, page } = luma
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
  luma,
}) => {
  const { app, page } = luma
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

test('requests genuinely visible thumbnails first and pages before thumbnail completion', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  const control = await mockImportReview(app)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).thumbnails.length)
      .toBeGreaterThan(0)
    const first = (await control.evaluate((state) => state.state())).thumbnails[0]
    expect(first.ids.length).toBeGreaterThan(0)
    expect(first.ids.length).toBeLessThan(60)
    expect(first.ids).not.toContain('candidate-60')
    const visitedAt = Date.now()
    await page
      .getByRole('navigation', { name: 'Import pages' })
      .getByRole('button', { name: 'Next', exact: true })
      .click()
    const last = page.getByRole('checkbox', { name: 'Import 60.jpg', exact: true })
    await expect(last).toBeEnabled()
    const selectableMs = Date.now() - visitedAt
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).thumbnails.at(-1)?.ids)
      .toEqual(['candidate-60'])
    await last.uncheck()
    await control.evaluate((state) => state.finish())
    await expect(page.getByRole('button', { name: 'Import 60 photos', exact: true })).toBeEnabled()
    await expect(page.getByRole('dialog').locator('img')).toHaveCount(0)
    const releasedAt = Date.now()
    await control.evaluate((state) => state.releaseThumbnails())
    await expect(page.getByRole('dialog').locator('img')).toBeVisible()
    await writeFile(
      testInfo.outputPath('review-page-ui-timings.json'),
      JSON.stringify(
        {
          measurement: 'Electron UI with fixture thumbnails held behind an IPC gate',
          newlyVisitedPageSelectableMs: selectableMs,
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

test('recovers checkbox focus when newest discoveries displace its row without changing choices or stealing other focus', async ({
  luma,
}) => {
  const { app, page } = luma
  const control = await mockImportReview(app, 60)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    const displaced = page.getByRole('checkbox', { name: 'Import 59.jpg', exact: true })
    await displaced.uncheck()
    await displaced.focus()
    await expect(displaced).toBeFocused()
    await expect
      .poll(async () => (await control.evaluate((state) => state.state())).selectedIds.length)
      .toBe(59)
    await control.evaluate((state) => state.prepend(1))
    await expect(displaced).toHaveCount(0)
    const nearest = page.getByRole('checkbox', { name: 'Import 58.jpg', exact: true })
    await expect(nearest).toBeFocused()
    await expect(nearest).toBeChecked()
    const selected = (await control.evaluate((state) => state.state())).selectedIds
    expect(selected).toHaveLength(60)
    expect(selected).not.toContain('candidate-59')
    // Space still adjusts the focused photograph; Tab then reaches paging naturally.
    await page.keyboard.press('Space')
    await expect(nearest).not.toBeChecked()
    await page.keyboard.press('Tab')
    const pages = page.getByRole('navigation', { name: 'Import pages' })
    await expect(pages.getByRole('button', { name: 'Next', exact: true })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(displaced).not.toBeChecked()
    await pages.getByRole('button', { name: 'Previous', exact: true }).click()
    await expect(nearest).not.toBeChecked()
    const otherControl = page.getByRole('button', { name: 'Select all', exact: true })
    await otherControl.focus()
    await control.evaluate((state) => state.prepend(1))
    await expect(page.getByRole('checkbox', { name: 'Import 61.jpg', exact: true })).toBeChecked()
    await expect(otherControl).toBeFocused()
    const finalSelection = (await control.evaluate((state) => state.state())).selectedIds
    expect(finalSelection).toHaveLength(60)
    expect(finalSelection).not.toContain('candidate-59')
    expect(finalSelection).not.toContain('candidate-58')
  } finally {
    await control.evaluate((state) => state.releaseAll())
  }
})
