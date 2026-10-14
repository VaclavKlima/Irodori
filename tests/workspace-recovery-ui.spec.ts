import { test, expect } from './electron.fixture'
import { seedLargeBrowser } from './all-photos.helpers'
import { importPhotos } from './import.helpers'
import { revealEditorPhoto } from './collection-ui.helpers'

test('normal restart restores independent workspace state, empty selection, Console, scroll anchors and active-photo zoom', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  const chosen = photos[1]
  await page.getByTestId(`photo-card-${chosen.id}`).click()
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('2')
  await page.getByTestId('console-toggle').click()
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search photos' }).fill('.jpg')
  await page.getByRole('combobox', { name: 'Group photos by' }).selectOption('month')
  const grid = page.getByTestId('browse-grid')
  await grid.focus()
  await page.keyboard.press('End')
  const focused = (await page.evaluate(() => window.luma.getWorkspaceState())).state?.libraryFocusId
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse all groups', exact: true }).click()
  await page.getByRole('button', { name: 'Expand all groups', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.luma.getWorkspaceState())).state)
    .toMatchObject({
      mode: 'library',
      activeId: chosen.id,
      consoleOpen: true,
      query: { search: '.jpg', grouping: 'month' },
      preview: { photoId: chosen.id, fit: false, scale: 2 },
    })
  const restarted = await luma.restart()
  await expect(restarted.page.getByTestId('all-photos')).toBeVisible()
  await expect(restarted.page.getByRole('searchbox', { name: 'Search photos' })).toHaveValue('.jpg')
  await expect(restarted.page.getByRole('combobox', { name: 'Group photos by' })).toHaveValue(
    'month',
  )
  await expect(restarted.page.getByTestId('browse-selection-count')).toContainText('0 selected')
  await expect(restarted.page.getByTestId('console-panel')).toBeVisible()
  await restarted.page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(restarted.page.getByTestId('preview-filename')).toHaveText(chosen.filename)
  await expect(restarted.page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('2')
  await restarted.page.getByTestId(`photo-card-${photos[0].id}`).click()
  await expect(restarted.page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('fit')
  await restarted.page.getByTestId(`photo-card-${chosen.id}`).click()
  await expect(restarted.page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('fit')
  void focused
})
test('abrupt exit recovers the last completed checkpoint and preserves a deep ID scroll anchor', async ({
  luma,
}) => {
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 185)
  let { page } = await luma.restart()
  const summary = await page.evaluate(() => window.luma.getGallerySummary())
  const target = (
    await page.evaluate((revision) => window.luma.getGalleryChunk(120, revision), summary)
  ).entries[10].photo
  await revealEditorPhoto(page, target.id)
  await page.getByTestId(`photo-card-${target.id}`).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.luma.getWorkspaceState())).state?.editorAnchor?.index,
    )
    .toBeGreaterThan(100)
  const before = await page.getByTestId('editor-photo-scroll').evaluate((el) => el.scrollTop)
  const saved = await page.evaluate(() => window.luma.getWorkspaceState())
  ;({ page } = await luma.crashAndRestart())
  await expect(page.getByTestId('preview-filename')).toHaveText(target.filename)
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await expect(page.getByTestId(`photo-card-${target.id}`)).toBeVisible()
  await expect
    .poll(() => page.getByTestId('editor-photo-scroll').evaluate((el) => el.scrollTop))
    .toBeCloseTo(before, 0)
  expect(
    (await page.evaluate(() => window.luma.getWorkspaceState())).checkpoint,
  ).toBeGreaterThanOrEqual(saved.checkpoint)
})

test('workspace save failures leave editing usable and a visible Retry commits accumulated state', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  const control = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('workspace:save')!
    const originalError = console.error
    let fail = true
    const failures: string[] = []
    console.error = (...args) => {
      if (
        args[0] === "Error occurred in handler for 'workspace:save':" &&
        args[1] instanceof Error &&
        args[1].message === 'Fixture checkpoint unavailable'
      ) {
        failures.push(args[1].message)
        return
      }
      originalError(...args)
    }
    ipcMain.removeHandler('workspace:save')
    ipcMain.handle('workspace:save', (...args) => {
      if (fail) throw new Error('Fixture checkpoint unavailable')
      return original(...args)
    })
    return {
      failures,
      allow: () => {
        fail = false
      },
      restore: () => {
        console.error = originalError
        ipcMain.removeHandler('workspace:save')
        ipcMain.handle('workspace:save', original)
      },
    }
  })
  try {
    await page.getByTestId('console-toggle').click()
    await expect(
      page.getByText('Workspace recovery could not be saved.', { exact: false }),
    ).toBeVisible()
    await page.getByTestId(`photo-card-${photos[1].id}`).click()
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
    await control.evaluate((s) => s.allow())
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      page.getByText('Workspace recovery could not be saved.', { exact: false }),
    ).toHaveCount(0)
    await expect
      .poll(async () => (await page.evaluate(() => window.luma.getWorkspaceState())).state)
      .toMatchObject({ activeId: photos[1].id, consoleOpen: true })
    expect(await control.evaluate((s) => s.failures.length)).toBeGreaterThan(0)
  } finally {
    await control.evaluate((s) => s.restore())
  }
})
