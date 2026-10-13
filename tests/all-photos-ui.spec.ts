import type { ElectronApplication, Page } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { browseSources, holdBrowseSelections, seedLargeBrowser } from './all-photos.helpers'
import { DEFAULT_BROWSE_QUERY } from '../src/shared/browse'
import type { BackgroundTask } from '../src/shared/contracts'

const browserCard = (page: Page, id: string) => page.getByTestId(`browse-photo-${id}`)
const browseCount = (page: Page) => page.getByTestId('browse-selection-count')
const grid = (page: Page) => page.getByTestId('browse-grid')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search photos' })
const grouping = (page: Page) => page.getByRole('combobox', { name: 'Group photos by' })
const workspace = (page: Page, name: 'Editor' | 'Library') =>
  page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name, exact: true })

async function browse(page: Page, count: number) {
  await workspace(page, 'Library').click()
  await expect(page.getByTestId('all-photos')).toBeVisible()
  await expect(browseCount(page)).toContainText(`${count} matching`)
  await expect(grid(page).getByRole('button').first()).toBeVisible()
}

async function minimumConsole(app: ElectronApplication, page: Page) {
  const window = await app.browserWindow(page)
  await window.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await page.getByTestId('console-toggle').click()
  await expect(page.getByTestId('console-panel')).toBeVisible()
}

async function targetNames(page: Page) {
  return page
    .getByRole('dialog')
    .getByRole('list', { name: 'Photos to move to Trash', exact: true })
    .getByRole('listitem')
    .allTextContents()
}

test('groups camera calendar dates, searches metadata, and treats collapsed stack members individually', async ({
  luma,
}) => {
  const { app, page } = luma
  const paths = await browseSources(luma.userDataDir, [
    '2026:10:04 00:15:00',
    '2026:10:04 23:45:00',
    '2026:09:30 12:00:00',
    null,
  ])
  await importPhotos(app, page, paths)
  const ordered = (
    await page.evaluate((query) => window.luma.getBrowseChunk(query), DEFAULT_BROWSE_QUERY)
  ).photos
  const stack = await page.evaluate(
    async (ids) => {
      return window.luma.groupPhotos(ids, ids[0], (await window.luma.listStacks()).revision)
    },
    ordered.slice(0, 2).map((p) => p.id),
  )
  await page.getByTestId(`photo-card-${stack.coverId}`).click()
  const editorFilename = await page.getByTestId('preview-filename').textContent()
  await expect(page.getByTestId(`photo-card-${ordered[1].id}`)).toHaveCount(0)
  await browse(page, 4)
  await expect(grouping(page)).toHaveValue('date')
  await expect(page.getByTestId('browse-section-2026-10-04')).toContainText('2 photos')
  await expect(page.getByTestId('browse-section-2026-09-30')).toContainText('1 photo')
  await expect(page.getByTestId('browse-section-unknown')).toContainText('Unknown date')
  for (const photo of ordered.slice(0, 2)) await expect(browserCard(page, photo.id)).toBeVisible()
  await browserCard(page, ordered[0].id).click()
  await browserCard(page, ordered[0].id).click({ modifiers: ['Shift'] })
  await expect(browseCount(page)).toContainText('1 selected')
  await browserCard(page, ordered[1].id).click({ modifiers: ['Shift'] })
  await expect(browseCount(page)).toContainText('2 selected')
  await expect(page.getByTestId('preview-filename')).toHaveText(editorFilename!)
  expect((await page.evaluate(() => window.luma.listStacks())).stacks[0].expanded).toBe(false)
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Set this photo as group cover' }),
  ).toHaveAttribute('aria-disabled', 'false')
  await page.getByRole('menuitem', { name: 'Set this photo as group cover' }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.luma.listStacks())).stacks[0].coverId)
    .toBe(ordered[1].id)
  await browserCard(page, ordered[0].id).click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Set this photo as group cover' }),
  ).toHaveAttribute('aria-disabled', 'false')
  await page.keyboard.press('Escape')
  await expect(grid(page)).toBeFocused()

  await grouping(page).selectOption('month')
  await expect(page.getByTestId('browse-section-2026-10')).toContainText('October 2026')
  await grouping(page).selectOption('year')
  await expect(page.getByTestId('browse-section-2026')).toContainText('3 photos')
  await search(page).fill('BROWSE CAMERA lens JPG 2026-10')
  await expect(browseCount(page)).toHaveText('2 matching · 2 selected')
  await search(page).fill('browse-photo-002')
  await expect(browseCount(page)).toHaveText('1 matching · 2 selected · 2 outside current results')
  await expect(browserCard(page, ordered[2].id)).toBeVisible()
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(browseCount(page)).toHaveText('1 matching · 0 selected')
  await search(page).fill('camera:Browse')
  await expect(browseCount(page)).toHaveText('0 matching · 0 selected')
  await expect(page.getByText('No photos match your search.', { exact: true })).toBeVisible()
})

test('selects a complete unloaded section and keeps rendering, thumbnail loading and photo caching bounded', async ({
  luma,
}) => {
  test.setTimeout(90_000)
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 365)
  const { app, page } = await luma.restart()
  await minimumConsole(app, page)
  await browse(page, 365)
  const checkbox = page.getByRole('checkbox', { name: 'Select 4 October 2026', exact: true })
  const photos = (
    await page.evaluate((query) => window.luma.getBrowseChunk(query), DEFAULT_BROWSE_QUERY)
  ).photos
  await browserCard(page, photos[0].id).click()
  await expect(checkbox).not.toBeChecked()
  await expect
    .poll(() => checkbox.evaluate((el) => (el as HTMLInputElement).indeterminate))
    .toBe(true)
  await checkbox.click()
  await expect(browseCount(page)).toHaveText('365 matching · 365 selected')
  await expect(checkbox).toBeChecked()
  await checkbox.click()
  await expect(browseCount(page)).toHaveText('365 matching · 0 selected')
  await expect
    .poll(() => checkbox.evaluate((el) => (el as HTMLInputElement).indeterminate))
    .toBe(false)

  const dimensions = await grid(page).evaluate((el) => ({
    height: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }))
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height * 10)
  for (let fraction = 0; fraction <= 1; fraction += 0.125) {
    await grid(page).evaluate((el, fraction) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction
    }, fraction)
    await grid(page).evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(
      grid(page).getByRole('gridcell', { name: 'Loading photo', exact: true }),
    ).toHaveCount(0)
    const mounted = await grid(page).locator('[data-testid^="browse-photo-"]').count()
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThanOrEqual(45)
    expect(await grid(page).locator('img').count()).toBe(mounted)
    const cached = Number(await grid(page).getAttribute('data-cache-photos'))
    expect(cached).toBeGreaterThanOrEqual(mounted)
    expect(cached).toBeLessThanOrEqual(300)
    expect(Number(await grid(page).getAttribute('data-cache-chunks'))).toBeLessThanOrEqual(5)
  }
  await grid(page).focus()
  await page.keyboard.press('End')
  const last = (
    await page.evaluate((query) => window.luma.getBrowseChunk(query, 360), DEFAULT_BROWSE_QUERY)
  ).photos.at(-1)!
  await expect(browserCard(page, last.id)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('Space')
  await expect(browseCount(page)).toHaveText('365 matching · 1 selected')
  await expect(browserCard(page, last.id)).toHaveAttribute('aria-pressed', 'true')
  await search(page).fill(photos[0].filename)
  await expect(browseCount(page)).toHaveText('1 matching · 1 selected · 1 outside current results')
  await expect.poll(() => grid(page).evaluate((el) => el.scrollTop)).toBe(0)
  await search(page).fill('')
  await expect(browseCount(page)).toHaveText('365 matching · 1 selected')
  await expect(checkbox).not.toBeChecked()
  await expect
    .poll(() => checkbox.evaluate((el) => (el as HTMLInputElement).indeterminate))
    .toBe(true)
})

test('keyboard focus, Enter and double-click preserve shared selection and restore browser preferences and scrolling', async ({
  luma,
}) => {
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 75)
  const { page } = await luma.restart()
  await browse(page, 75)
  await search(page).fill('browse-photo')
  await expect(grid(page)).toHaveAttribute('data-search', 'browse-photo')
  await expect(browseCount(page)).toContainText('75 matching')
  await grouping(page).selectOption('month')
  await expect(page.getByTestId('browse-section-2026-10')).toBeVisible()
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(browseCount(page)).toHaveText('75 matching · 0 selected')
  const ordered = await page.evaluate(() =>
    window.luma.getBrowseSection({ search: 'browse-photo', grouping: 'month' }, '2026-10'),
  )
  await grid(page).focus()
  await page.keyboard.press('Home')
  await expect(browserCard(page, ordered[0].id)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowRight')
  await expect(browserCard(page, ordered[1].id)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('Space')
  await expect(browseCount(page)).toHaveText('75 matching · 2 selected')
  await page.keyboard.press('End')
  const focusedId = ordered.at(-1)!.id
  await expect(browserCard(page, focusedId)).toHaveAttribute('data-focused', 'true')
  const focusedPhoto = await page.evaluate(
    ({ query, id }) => window.luma.locateBrowsePhoto(query, id),
    { query: { search: 'browse-photo', grouping: 'month' as const }, id: focusedId },
  )
  const scroll = await grid(page).evaluate((el) => el.scrollTop)
  expect(scroll).toBeGreaterThan(0)
  await expect(grid(page)).toHaveAttribute('aria-activedescendant', `browse-photo-${focusedId}`)
  await page.keyboard.press('Enter')
  await expect(workspace(page, 'Editor')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('preview-filename')).toHaveText(focusedPhoto!.photo.filename)
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await browse(page, 75)
  await expect(search(page)).toHaveValue('browse-photo')
  await expect(grouping(page)).toHaveValue('month')
  await expect(grid(page)).toBeFocused()
  await expect(grid(page)).toHaveAttribute('aria-activedescendant', `browse-photo-${focusedId}`)
  await expect.poll(() => grid(page).evaluate((el) => el.scrollTop)).toBe(scroll)
  await browserCard(page, focusedId).dblclick()
  await expect(workspace(page, 'Editor')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await browse(page, 75)
  await expect(browseCount(page)).toHaveText('75 matching · 2 selected')
  await search(page).focus()
  await workspace(page, 'Editor').click()
  await browse(page, 75)
  await expect(search(page)).toBeFocused()
})

test('queued range and section gestures retain their query and deletion waits before freezing every filename', async ({
  luma,
}) => {
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 75)
  const { app, page } = await luma.restart()
  const trash = await isolateTrash(app)
  await browse(page, 75)
  const references = await page.evaluate(
    (query) => window.luma.getBrowseSection(query, '2026-10-04'),
    DEFAULT_BROWSE_QUERY,
  )
  await browserCard(page, references[0].id).click()
  const hold = await holdBrowseSelections(app)
  try {
    await browserCard(page, references[2].id).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page.getByRole('checkbox', { name: 'Select 4 October 2026', exact: true }).click()
    await search(page).fill(references.at(-1)!.filename)
    await expect(browseCount(page)).toContainText('1 matching')
    await grid(page).focus()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[0].release())
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    expect(
      await hold.evaluate((h) =>
        h.calls.map((call) => ({ channel: call.channel, query: call.query })),
      ),
    ).toEqual([
      { channel: 'browse:range', query: DEFAULT_BROWSE_QUERY },
      { channel: 'browse:section', query: DEFAULT_BROWSE_QUERY },
    ])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[1].release())
    await expect(page.getByRole('dialog')).toContainText('Delete 75 photos?')
    await expect.poll(() => targetNames(page)).toEqual(references.map((p) => p.filename))
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await expect(browseCount(page)).toHaveText(
      '1 matching · 75 selected · 74 outside current results',
    )
    await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total)
      .toBe(0)
    await expect(browseCount(page)).toHaveText('0 matching · 0 selected')
    expect((await readdir(trash)).map((name) => name.slice(0, 64)).sort()).toEqual(
      references.map((p) => p.id).sort(),
    )
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('a real background import refreshes browsing without replacing selection or the editor view at minimum console size', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await minimumConsole(app, page)
  const preview = page.getByTestId('preview-viewport')
  await expect(preview).toHaveAttribute('data-resolution', 'full')
  await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('2')
  await preview.dispatchEvent('wheel', { deltaX: 37, deltaY: 23 })
  await expect.poll(() => preview.evaluate((el) => Number(el.dataset.panX))).not.toBe(0)
  const editorView = await preview.evaluate((el) => ({
    scale: el.dataset.scale,
    x: el.dataset.panX,
    y: el.dataset.panY,
  }))
  const editorCanvas = await page.getByTestId('main-preview').elementHandle()
  const original = (
    await page.evaluate((query) => window.luma.getBrowseChunk(query), DEFAULT_BROWSE_QUERY)
  ).photos[0]
  await browse(page, 1)
  await browserCard(page, original.id).click()
  await expect(browseCount(page)).toHaveText('1 matching · 1 selected')
  const incoming = await browseSources(luma.userDataDir, ['2026:10:04 12:30:00'], 'incoming')
  const sourceBytes = await readFile(incoming[0])
  await importPhotos(app, page, incoming, false)
  await expect(workspace(page, 'Library')).toHaveAttribute('aria-current', 'page')
  await expect(browseCount(page)).toHaveText('2 matching · 1 selected')
  await expect(browserCard(page, original.id)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('console-panel')).toBeVisible()
  await page.screenshot({ path: info.outputPath('all-photos-minimum-console.png') })
  await workspace(page, 'Editor').click()
  await expect(page.getByTestId('preview-filename')).toHaveText('alpine-lake.jpg')
  await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('2')
  await expect(preview).toHaveAttribute('data-resolution', 'full')
  await expect
    .poll(() =>
      preview.evaluate((el) => ({
        scale: el.dataset.scale,
        x: el.dataset.panX,
        y: el.dataset.panY,
      })),
    )
    .toEqual(editorView)
  expect(
    await editorCanvas!.evaluate(
      (el) => el === document.querySelector('[data-testid="main-preview"]'),
    ),
  ).toBe(true)
  await editorCanvas!.dispose()
  expect(await readFile(incoming[0])).toEqual(sourceBytes)
  const bounds = await preview.boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700)
  expect(
    await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
    })),
  ).toEqual({ horizontal: false, vertical: false })
})

test('a completed background merge keeps browsing and shared selection until Open result explicitly opens Library', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, [
    'tests/fixtures/photos/alpine-lake.jpg',
    'tests/fixtures/photos/forest-light.jpg',
    'tests/fixtures/photos/mountain-ridge.jpg',
  ])
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await browse(page, 3)
  await browserCard(page, photos[1].id).click()
  await browserCard(page, photos[2].id).click({ modifiers: ['ControlOrMeta'] })
  await expect(browseCount(page)).toHaveText('3 matching · 2 selected')
  await expect(browserCard(page, photos[2].id)).toHaveAttribute('data-focused', 'true')
  const fixture = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('tasks:list')!
    let tasks: import('../src/shared/contracts').BackgroundTask[] = []
    ipcMain.removeHandler('tasks:list')
    ipcMain.handle('tasks:list', () => tasks)
    return {
      update(next: typeof tasks) {
        tasks = next
        BrowserWindow.getAllWindows()[0].webContents.send('library:event', {
          tasksChanged: true,
          libraryChanged: true,
        })
      },
      restore() {
        ipcMain.removeHandler('tasks:list')
        ipcMain.handle('tasks:list', original)
      },
    }
  })
  try {
    const task: BackgroundTask = {
      id: 'browser-background-merge',
      kind: 'merge',
      status: 'running',
      title: 'Merging photographs',
      errorCount: 0,
    }
    await fixture.evaluate((control, task) => control.update([task]), task)
    await expect(page.getByTestId('task-progress')).toContainText(task.title)
    task.status = 'completed'
    task.title = 'Merged photo ready'
    task.resultPhotoId = photos[2].id
    await fixture.evaluate((control, task) => control.update([task]), task)
    await expect(page.getByTestId('task-progress')).toContainText(task.title)
    await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
    await expect(workspace(page, 'Library')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
    await expect(browseCount(page)).toHaveText('3 matching · 2 selected')
    for (const photo of photos.slice(1))
      await expect(browserCard(page, photo.id)).toHaveAttribute('aria-pressed', 'true')
    await expect(browserCard(page, photos[2].id)).toHaveAttribute('data-focused', 'true')

    await page.getByTestId('task-progress').click()
    await page.getByRole('button', { name: 'Open result', exact: true }).click()
    await expect(workspace(page, 'Editor')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('all-photos')).toBeHidden()
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[2].filename)
    await expect(page.getByTestId('task-details')).toHaveCount(0)
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  } finally {
    await fixture.evaluate((control) => control.restore())
    await fixture.dispose()
  }
})

test('delayed summaries preserve newer scrolling and stale chunks cannot replace a newer search', async ({
  luma,
}) => {
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 75)
  const { app, page } = await luma.restart()
  await browse(page, 75)
  const references = await page.evaluate(
    (query) => window.luma.getBrowseSection(query, '2026-10-04'),
    DEFAULT_BROWSE_QUERY,
  )
  const last = references.at(-1)!
  const held = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const originalSummary = handlers.get('browse:summary')!
    const originalChunk = handlers.get('browse:chunk')!
    const summaries: { release: () => void }[] = []
    const chunks: { release: () => void }[] = []
    let holdSummary = false
    let holdChunk = false
    ipcMain.removeHandler('browse:summary')
    ipcMain.handle('browse:summary', async (...args) => {
      const result = await originalSummary(...args)
      if (!holdSummary) return result
      holdSummary = false
      return new Promise((resolve) => summaries.push({ release: () => resolve(result) }))
    })
    ipcMain.removeHandler('browse:chunk')
    ipcMain.handle('browse:chunk', async (...args) => {
      const result = await originalChunk(...args)
      if (!holdChunk || (args[1] as { search: string }).search !== 'browse-photo') return result
      holdChunk = false
      // Keep the trusted handler's result envelope intact while delaying its delivery.
      return new Promise((resolve) => chunks.push({ release: () => resolve(result) }))
    })
    return {
      summaries,
      chunks,
      delaySummary() {
        holdSummary = true
        BrowserWindow.getAllWindows()[0].webContents.send('library:event', {
          libraryChanged: true,
          tasksChanged: false,
        })
      },
      delayChunk() {
        holdChunk = true
      },
      restore() {
        for (const call of [...summaries, ...chunks]) call.release()
        ipcMain.removeHandler('browse:summary')
        ipcMain.handle('browse:summary', originalSummary)
        ipcMain.removeHandler('browse:chunk')
        ipcMain.handle('browse:chunk', originalChunk)
      },
    }
  })
  try {
    await held.evaluate((control) => control.delaySummary())
    await expect.poll(() => held.evaluate((control) => control.summaries.length)).toBe(1)
    await grid(page).focus()
    await page.keyboard.press('End')
    await expect(browserCard(page, last.id)).toHaveAttribute('data-focused', 'true')
    const newerScroll = await grid(page).evaluate((el) => el.scrollTop)
    expect(newerScroll).toBeGreaterThan(0)
    await held.evaluate((control) => control.summaries[0].release())
    await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
    await expect.poll(() => grid(page).evaluate((el) => el.scrollTop)).toBe(newerScroll)
    await expect(grid(page)).toHaveAttribute('aria-activedescendant', `browse-photo-${last.id}`)

    await held.evaluate((control) => control.delayChunk())
    await search(page).fill('browse-photo')
    await expect.poll(() => held.evaluate((control) => control.chunks.length)).toBe(1)
    await search(page).fill(last.filename)
    await expect(browseCount(page)).toContainText('1 matching')
    await expect(browserCard(page, last.id)).toBeVisible()
    await expect(grid(page).locator('[data-testid^="browse-photo-"]')).toHaveCount(1)
    await held.evaluate((control) => control.chunks[0].release())
    await page.evaluate(async (filename) => {
      await window.luma.getBrowseSummary({ search: filename, grouping: 'date' })
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    }, last.filename)
    await expect(browseCount(page)).toContainText('1 matching')
    await expect(grid(page).locator('[data-testid^="browse-photo-"]')).toHaveCount(1)
    await expect(browserCard(page, last.id)).toBeVisible()
    await expect(grid(page)).toHaveAttribute('data-cache-chunks', '1')
    await expect.poll(() => grid(page).evaluate((el) => el.scrollTop)).toBe(0)
  } finally {
    await held.evaluate((control) => control.restore())
    await held.dispose()
  }
})

test('group folding preserves hidden selection, skips folded photos with the keyboard and retains independent grouping preferences', async ({
  luma,
}) => {
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 75)
  const { app, page } = await luma.restart()
  const neighbors = await browseSources(
    luma.userDataDir,
    ['2026:09:30 12:00:00', '2025:12:31 12:00:00', null],
    'fold-neighbor',
  )
  await importPhotos(app, page, neighbors)
  await browse(page, 78)
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(browseCount(page)).toHaveText('78 matching · 0 selected')
  const sections = await page.evaluate(async (query) => {
    const summary = await window.luma.getBrowseSummary(query)
    return Promise.all(
      summary.sections.map(async (section) => ({
        ...section,
        photos: await window.luma.getBrowseSection(query, section.key),
      })),
    )
  }, DEFAULT_BROWSE_QUERY)
  const october = sections.find((section) => section.key === '2026-10-04')!
  const september = sections.find((section) => section.key === '2026-09-30')!
  const december = sections.find((section) => section.key === '2025-12-31')!
  const unknown = sections.find((section) => section.key === 'unknown')!
  const section = (key: string) => page.getByTestId(`browse-section-${key}`)
  const disclosure = (key: string) => section(key).getByRole('button')
  const cards = grid(page).locator('[data-testid^="browse-photo-"]')
  await expect(disclosure(october.key)).toHaveAccessibleName('Collapse 4 October 2026')
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'true')

  await disclosure(october.key).click()
  await expect(disclosure(october.key)).toHaveAccessibleName('Expand 4 October 2026')
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'false')
  await expect(cards).toHaveCount(3)
  await disclosure(october.key).press('Enter')
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'true')
  await expect(browserCard(page, october.photos[0].id)).toBeVisible()
  await disclosure(october.key).press('Space')
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'false')
  await expect(cards).toHaveCount(3)

  await browserCard(page, september.photos[0].id).click()
  const octoberSelection = section(october.key).getByRole('checkbox', {
    name: 'Select 4 October 2026',
    exact: true,
  })
  await octoberSelection.click()
  await expect(browseCount(page)).toHaveText('78 matching · 76 selected')
  await expect(octoberSelection).toBeChecked()
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'false')
  await expect(browserCard(page, september.photos[0].id)).toHaveAttribute('aria-pressed', 'true')
  await expect(cards).toHaveCount(3)
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(browseCount(page)).toHaveText('78 matching · 0 selected')
  await expect(octoberSelection).not.toBeChecked()
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'false')

  await grid(page).focus()
  await page.keyboard.press('Home')
  await expect(browserCard(page, september.photos[0].id)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(browserCard(page, december.photos[0].id)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(browserCard(page, unknown.photos[0].id)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(browserCard(page, december.photos[0].id)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('End')
  await expect(browserCard(page, unknown.photos[0].id)).toHaveAttribute('data-focused', 'true')
  await expect(browseCount(page)).toHaveText('78 matching · 0 selected')

  await search(page).fill('2026-10')
  await expect(browseCount(page)).toHaveText('75 matching · 0 selected')
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'false')
  await expect(cards).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Expand all groups', exact: true })).toBeVisible()
  await search(page).fill('')
  await expect(browseCount(page)).toHaveText('78 matching · 0 selected')
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'false')
  await expect(disclosure(september.key)).toHaveAttribute('aria-expanded', 'true')

  await grouping(page).selectOption('month')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
  await grid(page).evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(disclosure('2026-10')).toHaveAttribute('aria-expanded', 'true')
  await grid(page).focus()
  await page.keyboard.press('End')
  await expect(browserCard(page, unknown.photos[0].id)).toHaveAttribute('data-focused', 'true')
  await disclosure('2026-09').press('Enter')
  await expect(disclosure('2026-09')).toHaveAttribute('aria-expanded', 'false')
  await grouping(page).selectOption('date')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
  await expect(disclosure(october.key)).toHaveAttribute('aria-expanded', 'false')
  await expect(disclosure(september.key)).toHaveAttribute('aria-expanded', 'true')
  await grouping(page).selectOption('month')
  await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
  await grid(page).focus()
  await page.keyboard.press('End')
  await expect(browserCard(page, unknown.photos[0].id)).toHaveAttribute('data-focused', 'true')
  await expect(disclosure('2026-09')).toHaveAttribute('aria-expanded', 'false')
  await workspace(page, 'Editor').click()
  await browse(page, 78)
  await expect(grouping(page)).toHaveValue('month')
  await expect(disclosure('2026-09')).toHaveAttribute('aria-expanded', 'false')
  await grid(page).evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(disclosure('2026-10')).toHaveAttribute('aria-expanded', 'true')

  await page.getByRole('button', { name: 'Collapse all groups', exact: true }).click()
  await expect(cards).toHaveCount(0)
  for (const key of ['2026-10', '2026-09', '2025-12', 'unknown'])
    await expect(disclosure(key)).toHaveAttribute('aria-expanded', 'false')
  await section('unknown')
    .getByRole('checkbox', { name: 'Select Unknown date', exact: true })
    .click()
  await expect(browseCount(page)).toHaveText('78 matching · 1 selected')
  await expect(disclosure('unknown')).toHaveAttribute('aria-expanded', 'false')
  await expect(cards).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(browseCount(page)).toHaveText('78 matching · 0 selected')
  await expect(disclosure('unknown')).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: 'Expand all groups', exact: true }).press('Enter')
  await expect(disclosure('2026-10')).toHaveAttribute('aria-expanded', 'true')
  await expect(browserCard(page, october.photos[0].id)).toBeVisible()
  await grid(page).focus()
  await page.keyboard.press('End')
  await expect(browserCard(page, unknown.photos[0].id)).toHaveAttribute('data-focused', 'true')
  for (const key of ['2026-09', '2025-12', 'unknown'])
    await expect(disclosure(key)).toHaveAttribute('aria-expanded', 'true')
})

test('nearby expanded groups resolve across six source windows with a bounded cache and collapsing cancels pending End focus', async ({
  luma,
}) => {
  const { app, page } = luma
  const paths = await browseSources(luma.userDataDir, Array<string>(6).fill('2026:10:04 12:30:00'))
  await importPhotos(app, page, paths)
  const genuine = (
    await page.evaluate((query) => window.luma.getBrowseChunk(query), DEFAULT_BROWSE_QUERY)
  ).photos
  const native = await app.browserWindow(page)
  await native.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 1000)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 1000])
  const fixture = await app.evaluateHandle(({ ipcMain }, genuine) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const originalSummary = handlers.get('browse:summary')!
    const originalChunk = handlers.get('browse:chunk')!
    const total = 372
    const sections: import('../src/shared/browse').BrowseSection[] = []
    const visible = new Map<number, (typeof genuine)[number]>()
    for (let index = 0; index < 6; index++) {
      for (const small of [false, true]) {
        const day = 24 - index * 2 - Number(small)
        const offset = index * 62 + (small ? 61 : 0)
        sections.push({
          key: `2026-10-${day}`,
          label: `${day} October 2026`,
          offset,
          count: small ? 1 : 61,
          selected: 0,
        })
        if (small)
          visible.set(offset, {
            ...genuine[index],
            captureDate: `2026-10-${day}T12:30:00.000000000000000000`,
            dateOrigin: { kind: 'camera' },
          })
      }
    }
    const requests: number[] = []
    const summaryQueries: string[] = []
    const pending: { release: () => void }[] = []
    let delayLast = false
    ipcMain.removeHandler('browse:summary')
    ipcMain.handle('browse:summary', async (...args) => {
      const summary = (await originalSummary(
        ...args,
      )) as import('../src/shared/browse').BrowseSummary
      summaryQueries.push((args[1] as { search: string }).search)
      const selected = new Set(args[2] as string[])
      return {
        ...summary,
        total,
        selected: genuine.filter((photo) => selected.has(photo.id)).length,
        outsideSelected: 0,
        sections: sections.map((section) => ({
          ...section,
          selected:
            visible.has(section.offset) && selected.has(visible.get(section.offset)!.id) ? 1 : 0,
        })),
      }
    })
    ipcMain.removeHandler('browse:chunk')
    ipcMain.handle('browse:chunk', async (...args) => {
      const envelope = (await originalChunk(...args)) as {
        result: import('../src/shared/browse').BrowseChunk
        stale?: boolean
      }
      if (envelope.stale) return envelope
      const offset = args[2] as number
      requests.push(offset)
      // Only read presentation responses are synthetic. Visible cards and thumbnail URLs
      // refer to the six genuine managed fixtures; filler records remain in folded groups.
      const result = {
        ...envelope,
        result: {
          revision: envelope.result.revision,
          offset,
          photos: Array.from({ length: Math.min(60, total - offset) }, (_, index) => {
            const position = offset + index
            return (
              visible.get(position) ?? {
                ...genuine[0],
                id: position.toString(16).padStart(64, '0'),
                filename: `Folded fixture ${position}.jpg`,
              }
            )
          }),
        },
      }
      if (delayLast && offset === 360 && (args[1] as { search: string }).search === 'pending-end')
        return new Promise((resolve) => pending.push({ release: () => resolve(result) }))
      return result
    })
    return {
      requests,
      summaryQueries,
      pending,
      delayLast() {
        delayLast = true
      },
      restore() {
        for (const call of pending) call.release()
        ipcMain.removeHandler('browse:summary')
        ipcMain.handle('browse:summary', originalSummary)
        ipcMain.removeHandler('browse:chunk')
        ipcMain.handle('browse:chunk', originalChunk)
      },
    }
  }, genuine)
  try {
    await browse(page, 372)
    await page.getByRole('button', { name: 'Collapse all groups', exact: true }).click()
    await expect(grid(page).locator('[data-testid^="browse-photo-"]')).toHaveCount(0)
    for (const day of [13, 15, 17, 19, 21, 23])
      await page.getByRole('button', { name: `Expand ${day} October 2026`, exact: true }).click()
    await grid(page).evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
    })
    await expect(
      grid(page).getByRole('gridcell', { name: 'Loading photo', exact: true }),
    ).toHaveCount(0)
    await expect(grid(page).locator('[data-testid^="browse-photo-"]')).toHaveCount(6)
    for (const photo of genuine) await expect(browserCard(page, photo.id)).toHaveCount(1)
    const requested = await fixture.evaluate((control) => control.requests)
    for (const offset of [60, 120, 180, 240, 300, 360]) expect(requested).toContain(offset)
    expect(Number(await grid(page).getAttribute('data-cache-photos'))).toBeLessThanOrEqual(300)
    expect(Number(await grid(page).getAttribute('data-cache-chunks'))).toBeLessThanOrEqual(5)

    await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await expect(browseCount(page)).toHaveText('372 matching · 0 selected')
    await fixture.evaluate((control) => control.delayLast())
    await search(page).fill('pending-end')
    await expect
      .poll(() => fixture.evaluate((control) => control.summaryQueries.includes('pending-end')))
      .toBe(true)
    await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
    await expect.poll(() => grid(page).evaluate((el) => el.scrollTop)).toBe(0)
    await grid(page).focus()
    await page.keyboard.press('End')
    await expect
      .poll(() => fixture.evaluate((control) => control.pending.length))
      .toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Collapse all groups', exact: true }).click()
    await fixture.evaluate((control) => {
      for (const call of control.pending) call.release()
    })
    await page.evaluate(async () => {
      await window.luma.getBrowseSummary({ search: 'pending-end', grouping: 'date' })
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
    await expect(grid(page).locator('[data-testid^="browse-photo-"]')).toHaveCount(0)
    await expect(grid(page)).not.toHaveAttribute('aria-activedescendant')
    await grid(page).focus()
    await page.keyboard.press('Space')
    await expect(browseCount(page)).toHaveText('372 matching · 0 selected')
  } finally {
    await fixture.evaluate((control) => control.restore())
    await fixture.dispose()
  }
})
