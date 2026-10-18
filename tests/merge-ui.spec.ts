import { revealEditorPhoto, scrollCollection } from './collection-ui.helpers'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { BackgroundTask } from '../src/shared/contracts'
import type { ElectronApplication, Page } from '@playwright/test'
import { setupMergePreview } from './merge-preview.helpers'

async function acceptMergeHandoff(app: ElectronApplication, page: Page) {
  await setupMergePreview(app, page, 800, 600)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  const control = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    let task: import('../src/shared/contracts').BackgroundTask | undefined
    let holdId: string | undefined
    let release: (() => void) | undefined
    let located = false
    const completedLocates: string[] = []
    const previewRequests: string[] = []
    const notify = () =>
      BrowserWindow.getAllWindows()[0].webContents.send('library:event', { tasksChanged: true })
    for (const name of ['preview:hdr', 'preview:editing', 'preview:request', 'preview:cached']) {
      const original = handlers.get(name)!
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (...args: unknown[]) => {
        previewRequests.push(args[1] as string)
        return original(...args)
      })
    }
    const originalLocate = handlers.get('gallery:locate')!
    ipcMain.removeHandler('gallery:locate')
    ipcMain.handle('gallery:locate', async (...args: unknown[]) => {
      if (args[1] === holdId) {
        located = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      const result = await originalLocate(...args)
      completedLocates.push(args[1] as string)
      return result
    })
    ipcMain.removeHandler('tasks:list')
    ipcMain.handle('tasks:list', () => (task ? [task] : []))
    ipcMain.removeHandler('merge:start')
    ipcMain.handle('merge:start', () => {
      task = {
        id: 'accepted-merge-handoff',
        kind: 'merge',
        status: 'running',
        title: 'Publishing accepted merge',
        errorCount: 0,
      }
      notify()
      return { result: task.id }
    })
    return {
      holdResult(id: string) {
        holdId = id
      },
      release() {
        holdId = undefined
        release?.()
      },
      update(
        status: import('../src/shared/contracts').BackgroundTask['status'],
        resultPhotoId?: string,
      ) {
        task = { ...task!, status, resultPhotoId, title: `Accepted merge ${status}` }
        notify()
      },
      state: () => ({ located, completedLocates, previewRequests }),
    }
  })
  await page.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('task-progress')).toContainText('Publishing accepted merge')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'true')
  return { photos, control }
}

test('accepted merge keeps its source suspended through publication and asynchronous result selection', async ({
  luma,
}) => {
  const { page, app } = luma
  const { photos, control } = await acceptMergeHandoff(app, page)
  try {
    await control.evaluate((c, id) => c.holdResult(id), photos[0].id)
    await control.evaluate((c, id) => c.update('completed', id), photos[0].id)
    await expect.poll(() => control.evaluate((c) => c.state().located)).toBe(true)
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'true')
    expect(await control.evaluate((c) => c.state().previewRequests)).not.toContain(photos[1].id)
  } finally {
    await control.evaluate((c) => c.release())
  }
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'false')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  expect(await control.evaluate((c) => c.state().previewRequests)).not.toContain(photos[1].id)
})

test('editing while an automatic merge result lookup is pending preserves the edited source', async ({
  luma,
}) => {
  const { page, app } = luma
  const { photos, control } = await acceptMergeHandoff(app, page)
  try {
    await control.evaluate((c, id) => c.holdResult(id), photos[0].id)
    await control.evaluate((c, id) => c.update('completed', id), photos[0].id)
    await expect.poll(() => control.evaluate((c) => c.state().located)).toBe(true)
    await page.getByRole('button', { name: 'Light', exact: true }).click()
    await page.getByRole('button', { name: 'Light', exact: true }).click()
    const field = page.getByRole('spinbutton', { name: 'Exposure value' })
    await expect(field).toBeEnabled()
    await field.fill('0.50')
    await field.press('Enter')
    await expect
      .poll(() => page.evaluate((id) => window.luma.getEdits(id), photos[1].id))
      .toMatchObject({
        settings: { exposureEv: 0.5 },
      })
  } finally {
    await control.evaluate((c) => c.release())
  }
  await expect
    .poll(() => control.evaluate((c) => c.state().completedLocates))
    .toContain(photos[0].id)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'false')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue('0.50')
  expect(await control.evaluate((c) => c.state().previewRequests)).not.toContain(photos[0].id)
})

for (const status of ['failed', 'cancelled'] as const) {
  test(`accepted merge ${status} resumes its unchanged source`, async ({ luma }) => {
    const { page, app } = luma
    const { photos, control } = await acceptMergeHandoff(app, page)
    await control.evaluate((c, status) => c.update(status), status)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'false')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
    expect(await control.evaluate((c) => c.state().previewRequests)).toContain(photos[1].id)
  })
}

for (const intent of ['navigation', 'adjustment'] as const) {
  test(`explicit ${intent} resumes editing and supersedes an accepted merge's automatic result selection`, async ({
    luma,
  }) => {
    const { page, app } = luma
    const { photos, control } = await acceptMergeHandoff(app, page)
    if (intent === 'navigation') {
      await page.getByTestId(`photo-card-${photos[0].id}`).click()
      await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
    } else {
      await page.getByRole('button', { name: 'Light', exact: true }).click()
      await page.getByRole('button', { name: 'Light', exact: true }).click()
    }
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'false')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    const active = intent === 'navigation' ? photos[0] : photos[1]
    if (intent === 'adjustment') {
      const field = page.getByRole('spinbutton', { name: 'Exposure value' })
      await expect(field).toBeEnabled()
      await field.fill('0.50')
      await field.press('Enter')
      await expect
        .poll(() => page.evaluate((id) => window.luma.getEdits(id), active.id))
        .toMatchObject({
          settings: { exposureEv: 0.5 },
        })
    }
    const requestsBeforeCompletion = await control.evaluate((c) => c.state().previewRequests.length)
    await control.evaluate(
      (c, id) => c.update('completed', id),
      photos[intent === 'navigation' ? 1 : 0].id,
    )
    await expect(page.getByTestId('task-progress')).toContainText('Accepted merge completed')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(page.getByTestId('preview-filename')).toHaveText(active.filename)
    expect(await control.evaluate((c) => c.state().previewRequests)).toContain(active.id)
    expect(
      (await control.evaluate((c) => c.state().previewRequests)).slice(requestsBeforeCompletion),
    ).not.toContain(photos[intent === 'navigation' ? 1 : 0].id)
  })
}

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
    page.getByRole('menuitem', { name: 'Export this photo…', exact: true }),
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

test('completed merges select and reveal the result across unloaded gallery rows without replaying on refresh or reload', async ({
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
  await scrollCollection(page.getByTestId('editor-photo-scroll'), 60)
  expect(
    await page.getByTestId('editor-photo-scroll').evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0)
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
  await expect(page.getByRole('navigation', { name: /pages/ })).toHaveCount(0)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect(page.getByTestId('console-panel')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await revealEditorPhoto(page, photos[49].id)
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

  await expect
    .poll(async () => (await page.evaluate(() => window.luma.getWorkspaceState())).state?.activeId)
    .toBe(photos[49].id)
  await page.reload()
  await expect(page.getByTestId('task-progress')).toContainText(task.title)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[49].filename)
})
