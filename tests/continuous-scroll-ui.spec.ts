import { test, expect } from './electron.fixture'
import { seedLargeBrowser } from './all-photos.helpers'
import { revealEditorPhoto, scrollCollection } from './collection-ui.helpers'
import { mockImportReview } from './import-review-ui.helpers'

test('Editor scrolls across unloaded rows, keeps selection and preview, and keyboard focus stays independent', async ({
  luma,
}) => {
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 185)
  const { page } = await luma.restart()
  const scroll = page.getByTestId('editor-photo-scroll')
  const summary = await page.evaluate(() => window.luma.getGallerySummary())
  const first = (
    await page.evaluate((revision) => window.luma.getGalleryChunk(0, revision), summary)
  ).entries[0].photo
  const last = (
    await page.evaluate((revision) => window.luma.getGalleryChunk(180, revision), summary)
  ).entries.at(-1)!.photo
  await revealEditorPhoto(page, first.id)
  await page.getByTestId(`photo-card-${first.id}`).click()
  const original = await page.getByTestId('preview-filename').textContent()
  await revealEditorPhoto(page, last.id)
  await expect(page.getByTestId('preview-filename')).toHaveText(original!)
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await scroll.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await expect(page.getByTestId(`photo-card-${last.id}`)).toHaveAttribute('data-focused', 'true')
  await expect(page.getByTestId('preview-filename')).toHaveText(original!)
  await page.keyboard.press('Space')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await expect(page.getByTestId('preview-filename')).toHaveText(original!)
  await page.keyboard.press('Home')
  await expect(page.getByTestId('preview-filename')).toHaveText(first.filename)
  await page.keyboard.press('Shift+End')
  await expect(page.getByTestId('selection-count')).toHaveText('185 selected')
  await expect(page.getByTestId('preview-filename')).toHaveText(last.filename)
  const policy = await page.evaluate(() => window.luma.getCollectionPolicy())
  expect(Number(await scroll.getAttribute('data-cache-photos'))).toBeLessThanOrEqual(policy.records)
  await expect(page.getByRole('navigation', { name: /pages/ })).toHaveCount(0)
})
test('import review has a full native scrollbar and preserves ID choices and an inset through discovery prepends', async ({
  luma,
}) => {
  const { app, page } = luma,
    control = await mockImportReview(app, 185)
  try {
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await page.getByRole('button', { name: 'Choose photos', exact: true }).click()
    await expect(page.getByTestId('import-status')).toContainText('185 found')
    const scroll = page.getByTestId('import-scroll')
    await scrollCollection(scroll, 100)
    const chosen = page.getByRole('checkbox', { name: 'Import 100.jpg', exact: true })
    await chosen.uncheck()
    await chosen.focus()
    const anchor = await scroll.evaluate((el) => {
      const bounds = el.getBoundingClientRect()
      const first = Array.from(el.querySelectorAll<HTMLElement>('[data-candidate-id]')).find(
        (row) => row.getBoundingClientRect().bottom > bounds.top,
      )
      return {
        id: first?.dataset.candidateId,
        inset: first ? first.getBoundingClientRect().top - bounds.top : 0,
        top: el.scrollTop,
      }
    })
    await control.evaluate((s) => s.prepend(3))
    await expect(page.getByTestId('import-status')).toContainText('188 found')
    await expect(chosen).not.toBeChecked()
    await expect(chosen).toBeFocused()
    expect(
      await scroll.evaluate((el, id) => {
        const row = el.querySelector<HTMLElement>(`[data-candidate-id="${id}"]`)
        return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null
      }, anchor.id),
    ).toBeCloseTo(anchor.inset, 0)
    await scroll.focus()
    await page.keyboard.press('End')
    await expect(page.getByRole('checkbox', { name: 'Import 184.jpg', exact: true })).toBeFocused()
    await expect(page.getByRole('navigation', { name: /pages/ })).toHaveCount(0)
    await control.evaluate((s) => {
      s.finish()
      s.releaseThumbnails()
    })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally {
    await control.evaluate((s) => s.releaseAll())
  }
})
test('more than 60 fully readable task errors scroll independently and retain position when reopened', async ({
  luma,
}) => {
  const { app, page } = luma
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const task = {
      id: 'errors-fixture',
      kind: 'import',
      title: 'Import finished with errors',
      status: 'failed',
      errorCount: 125,
    }
    ipcMain.removeHandler('tasks:list')
    ipcMain.handle('tasks:list', () => [task])
    ipcMain.removeHandler('tasks:errors')
    ipcMain.handle('tasks:errors', (_event, _id: string, offset: number) => ({
      total: 125,
      errors: Array.from({ length: Math.min(60, 125 - offset) }, (_, i) => ({
        filename: `error-${offset + i}.jpg`,
        message:
          `Full message ${offset + i}: ` +
          'A readable failure description. '.repeat(((offset + i) % 5) + 1),
      })),
    }))
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('library:event', { tasksChanged: true }),
    )
  })
  await page.getByTestId('task-progress').click()
  await page.getByRole('button', { name: 'Show 125 errors', exact: true }).click()
  const errors = page.getByTestId('task-errors-errors-fixture')
  await expect(errors).toContainText('error-0.jpg')
  await errors.focus()
  await page.keyboard.press('End')
  await expect(errors).toContainText('error-124.jpg')
  expect(await errors.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(240)
  await errors.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const top = await errors.evaluate((el) => el.scrollTop)
  await page.getByRole('button', { name: 'Close task details', exact: true }).click()
  await page.getByTestId('task-progress').click()
  await expect(errors).toBeVisible()
  expect(await errors.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0)
  await page.getByRole('button', { name: 'Hide 125 errors', exact: true }).click()
  await page.getByRole('button', { name: 'Show 125 errors', exact: true }).click()
  expect(await errors.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0)
})
