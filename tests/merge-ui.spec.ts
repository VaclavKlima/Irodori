import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BackgroundTask } from '../src/shared/contracts'

test('shared Actions menu hides inapplicable merges and preserves pending right-click selection', async ({
  luma,
}) => {
  const { app, page } = luma
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await expect(page.getByRole('menu')).toContainText('No photo actions available.')
  await page.keyboard.press('Escape')
  await importPhotos(app, page, [
    'tests/fixtures/photos/alpine-lake.jpg',
    'tests/fixtures/photos/forest-light.jpg',
  ])
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  const hold = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers,
      original = handlers.get('gallery:range')!
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('gallery:range')
    ipcMain.handle('gallery:range', async (...args) => {
      await wait
      return original(...args)
    })
    return { release }
  })
  await page.getByTestId(`photo-card-${photos[1].id}`).click({ modifiers: ['Shift'] })
  await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
  await hold.evaluate((h) => h.release())
  await expect(
    page.getByRole('menuitem', { name: 'Move 2 selected photos to Trash…' }),
  ).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Merge selected photos to HDR…' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await page.getByTestId('console-toggle').click()
  const browserWindow = await app.browserWindow(page)
  await browserWindow.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Home')
  await expect(
    page.getByRole('menuitem', { name: 'Group selected photos', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('End')
  await expect(
    page.getByRole('menuitem', { name: 'Move 2 selected photos to Trash…' }),
  ).toBeFocused()
  const bounds = await page.getByRole('menu').boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1092)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(692)
  await page.keyboard.press('Escape')
})

test('completed merges select and reveal the result across gallery pages without replaying on refresh or reload', async ({
  luma,
}) => {
  const { app, page } = luma
  const directory = join(luma.userDataDir, 'sources')
  await mkdir(directory)
  const paths: string[] = []
  for (let i = 0; i < 63; i++) {
    const path = join(directory, `photo-${String(i).padStart(2, '0')}.png`)
    await writeFile(
      path,
      await sharp({
        create: { width: 16, height: 12, channels: 3, background: { r: i * 3, g: 20, b: 50 } },
      })
        .png()
        .toBuffer(),
    )
    paths.push(path)
  }
  await importPhotos(app, page, paths)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[1].id}`).click({ modifiers: ['Shift'] })
  await page.getByTestId('console-toggle').click()
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await page
    .getByRole('navigation', { name: 'Library pages' })
    .getByRole('button', { name: 'Next', exact: true })
    .click()
  await expect(page.getByRole('navigation', { name: 'Library pages' })).toContainText('2 / 2')
  const fixture = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
    let tasks: import('../src/shared/contracts').BackgroundTask[] = []
    ipcMain.removeHandler('tasks:list')
    ipcMain.handle('tasks:list', () => tasks)
    return {
      update(next: typeof tasks, libraryChanged = false) {
        tasks = next
        BrowserWindow.getAllWindows()[0].webContents.send('library:event', {
          tasksChanged: true,
          libraryChanged,
        })
      },
    }
  })
  const task: BackgroundTask = {
    id: 'merge-result-navigation',
    kind: 'merge',
    status: 'running',
    title: 'Merging photographs',
    errorCount: 0,
  }
  await fixture.evaluate((f, task) => f.update([task]), task)
  await expect(page.getByTestId('task-progress')).toContainText(task.title)
  for (const status of ['failed', 'cancelled'] as const) {
    task.status = status
    task.title = `Merge ${status}`
    await fixture.evaluate((f, task) => f.update([task], true), task)
    await expect(page.getByTestId('task-progress')).toContainText(task.title)
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
    await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  }
  task.status = 'completed'
  task.title = 'Merged photo ready'
  task.resultPhotoId = photos[50].id
  await fixture.evaluate((f, task) => f.update([task], true), task)
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[50].filename)
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  const result = page.getByTestId(`photo-card-${photos[50].id}`)
  await expect(result).toHaveAttribute('aria-current', 'true')
  await expect(result).toHaveAttribute('aria-pressed', 'true')
  await expect(result).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('navigation', { name: 'Library pages' })).toContainText('1 / 2')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect(page.getByTestId('console-panel')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.getByTestId(`photo-card-${photos[49].id}`).click()
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="photo-library"]')!
    const scroll = Array.from(panel.querySelectorAll<HTMLElement>('*')).find(
      (e) => getComputedStyle(e).overflowY === 'auto',
    )!
    scroll.scrollTop = 0
  })
  task.title = 'Completed merge refreshed'
  await fixture.evaluate((f, task) => f.update([task], true), task)
  await expect(page.getByTestId('task-progress')).toContainText(task.title)
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[49].filename)
  await expect(result).not.toBeInViewport()

  await page.reload()
  await expect(page.getByTestId('task-progress')).toContainText(task.title)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
})
