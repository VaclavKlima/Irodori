import { copyFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { choose, importPhotos } from './import.helpers'
import { testUiMode } from '../scripts/test-ui-mode.mjs'
import { activateButton } from './button.helpers'

// Slow only the real original-file stream after review. No production test switch or bridge.
async function slowCopies(app: ElectronApplication) {
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
    const { Readable } = process.getBuiltinModule('stream') as typeof import('node:stream')
    const { setTimeout: delay } = process.getBuiltinModule(
      'timers/promises',
    ) as typeof import('node:timers/promises')
    const original = fs.createReadStream
    const { basename } = process.getBuiltinModule('path') as typeof import('node:path')
    fs.createReadStream = (path, options) => {
      // Preview streams must retain foreground priority and finish normally.
      // Only the selected import source is delayed by this test adapter.
      if (basename(String(path)) !== 'forest-light.jpg') return original(path, options)
      const settings = typeof options === 'object' ? options : {}
      const source = original(path, { ...settings, highWaterMark: 4096 })
      return Readable.from(
        (async function* () {
          try {
            for await (const chunk of source) {
              await delay(150, undefined, { signal: settings?.signal ?? undefined })
              yield chunk
            }
          } finally {
            source.destroy()
          }
        })(),
      ) as import('node:fs').ReadStream
    }
    process.getBuiltinModule('module').syncBuiltinESMExports()
  })
}

async function startSlowImport(app: ElectronApplication, page: Page) {
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, ['tests/fixtures/photos/forest-light.jpg'])
  await expect(page.getByTestId('import-status')).toContainText('Ready to import')
  await slowCopies(app)
  await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('progressbar')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.luma.listTasks()).find(
            (task) => task.kind === 'import' && task.status === 'running',
          )?.transfer?.bytes ?? 0,
      ),
    )
    .toBeGreaterThan(0)
}

test('copies in the background with usable browsing, compact progress, reload recovery and cancellation', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page)
  await startSlowImport(app, page)
  await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText('mountain-ridge.jpg')
  await page.getByTestId('console-toggle').click()
  await expect(page.getByTestId('console-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('task-details')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close task details' })).toBeFocused()
  await expect(page.getByTestId('task-details')).toContainText('0 / 1 photos imported')
  await expect(page.getByTestId('task-details')).toContainText('forest-light.jpg')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('task-progress')).toBeFocused()
  await page.getByRole('button', { name: 'Add photos', exact: true }).click()
  await expect(page.getByTestId('task-details')).toBeVisible()
  const before = await page.evaluate(async () =>
    (await window.luma.listTasks()).find((task) => task.status === 'running')!,
  )
  expect(before.transfer!.bytes).toBeLessThan(before.transfer!.totalBytes)
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  for (const id of ['task-progress', 'task-details', 'console-toggle']) {
    const box = await page.getByTestId(id).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1100)
    expect(box!.y + box!.height).toBeLessThanOrEqual(700)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(
    await page.getByTestId('task-details').evaluate((element) => {
      const box = element.getBoundingClientRect()
      for (let x = box.left + 10; x < box.right - 10; x += 20) {
        for (let y = box.top + 10; y < box.bottom - 10; y += 20) {
          if (!element.contains(document.elementFromPoint(x, y))) return false
        }
      }
      return true
    }),
    'Task details must remain above the console and its scrollbar',
  ).toBe(true)
  expect(
    await page
      .getByTestId('task-progress')
      .locator('svg')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none')
  // Visual capture is an artifact only, requested through an explicit foreground invocation.
  if (testUiMode() === 'foreground') {
    const png = await nativeWindow.evaluate(async (window) =>
      (await window.capturePage()).toPNG().toString('base64'),
    )
    await writeFile(
      testInfo.outputPath('background-import-1100x700.png'),
      Buffer.from(png, 'base64'),
    )
  }
  await page.reload()
  await expect(page.getByRole('progressbar')).toBeVisible()
  const after = await page.evaluate(async () =>
    (await window.luma.listTasks()).find((task) => task.status === 'running')!,
  )
  expect(after.id).toBe(before.id)
  expect(after.progress!.total).toBe(before.progress!.total)
  expect(after.transfer!.bytes).toBeGreaterThanOrEqual(before.transfer!.bytes)
  await activateButton(page.getByTestId('task-progress'))
  await activateButton(page.getByRole('button', { name: 'Cancel task', exact: true }))
  await expect(page.getByTestId(`task-${before.id}`)).toHaveAttribute('data-status', 'cancelled')
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(2)
  expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
  await page.reload()
  await expect(page.getByTestId('task-progress')).toContainText('Import cancelled')
  await activateButton(page.getByTestId('task-progress'))
  await activateButton(
    page.getByTestId(`task-${before.id}`).getByRole('button', { name: 'Dismiss', exact: true }),
  )
  await expect(page.getByTestId('task-progress')).toHaveCount(0)
})

test('retains partial failures across a new review and automatically dismisses successful results', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await expect(page.getByTestId('task-progress')).toHaveCount(0, { timeout: 10_000 })
  const source = testInfo.outputPath('disconnected-card')
  await mkdir(source)
  const missing = join(source, 'missing.jpg')
  await copyFile('tests/fixtures/photos/forest-light.jpg', missing)
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, ['tests/fixtures/photos/mountain-ridge.jpg', missing])
  await expect(page.getByTestId('import-status')).toContainText('Ready to import')
  await rm(missing)
  await page.getByRole('button', { name: 'Import 2 photos', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('task-progress')).toContainText('Import finished with errors')
  await expect(page.getByTestId('preview-filename')).toHaveText('alpine-lake.jpg')
  await page.getByTestId('task-progress').click()
  await expect(page.getByTestId('task-details')).toContainText('1 / 2 photos imported')
  await page.getByRole('button', { name: 'Show 1 errors', exact: true }).click()
  await expect(page.getByTestId('task-details')).toContainText('missing.jpg')
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(2)
  expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await expect(page.getByTestId('import-status')).toContainText('Ready to import')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByTestId('task-progress').click()
  await expect(page.getByRole('button', { name: 'Hide 1 errors', exact: true })).toBeVisible()
  await expect(page.getByTestId('task-details')).toContainText('missing.jpg')
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(page.getByTestId('task-progress')).toHaveCount(0)
})

test('asks before closing or quitting during import and cleans unfinished copies before exit', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await startSlowImport(app, page)
  for (const trigger of ['close', 'quit'] as const) {
    const options = await app.evaluate(async ({ dialog, BrowserWindow, app }, trigger) => {
      let shown!: (options: Electron.MessageBoxOptions) => void
      const result = new Promise<Electron.MessageBoxOptions>((resolve) => {
        shown = resolve
      })
      dialog.showMessageBox = async (...args: unknown[]) => {
        shown(args.at(-1) as Electron.MessageBoxOptions)
        return { response: 0, checkboxChecked: false }
      }
      if (trigger === 'close') BrowserWindow.getAllWindows()[0].close()
      else app.quit()
      return result
    }, trigger)
    expect(options).toMatchObject({
      buttons: ['Keep working', 'Cancel task and quit'],
      defaultId: 0,
      cancelId: 0,
    })
    await expect(page.getByRole('progressbar')).toBeVisible()
    expect(
      await page.evaluate(async () =>
        (await window.luma.listTasks()).some((task) => task.status === 'running'),
      ),
    ).toBe(true)
  }
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await luma.expectQuit(async () => {
    await app.evaluate(({ BrowserWindow }) => {
      setImmediate(() => BrowserWindow.getAllWindows()[0].close())
    })
  })
  expect(await readdir(join(luma.userDataDir, 'library', 'staging'))).toEqual([])
  const restarted = await luma.restart()
  expect((await restarted.page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  expect(await restarted.page.evaluate(() => window.luma.listTasks())).toEqual([])
})
