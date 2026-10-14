import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { PREVIEW_VERSION } from '../src/main/full-previews'
import { expect, test } from './electron.fixture'
import { choose, expectImportComplete, importPhotos } from './import.helpers'

async function openMinimumConsole(app: ElectronApplication, page: Page) {
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  if ((await page.getByTestId('console-toggle').getAttribute('aria-expanded')) !== 'true')
    await page.getByTestId('console-toggle').click()
}

async function expectCompactFooter(page: Page) {
  await expect(async () => {
    const [footer, metadata, controls, status] = await Promise.all(
      ['preview-footer', 'preview-metadata', 'preview-view-controls', 'preview-resolution'].map(
        (id) => page.getByTestId(id).boundingBox(),
      ),
    )
    if (!footer || !metadata || !controls || !status)
      throw new Error('The photo footer and all three columns must have layout bounds.')
    expect(footer.height).toBe(48)
    expect(footer.x).toBeGreaterThanOrEqual(0)
    expect(footer.x + footer.width).toBeLessThanOrEqual(1100)
    expect(footer.y + footer.height).toBeLessThanOrEqual(700)
    expect(metadata.x + metadata.width).toBeLessThanOrEqual(controls.x - 4)
    expect(controls.x + controls.width).toBeLessThanOrEqual(status.x - 4)
    for (const bounds of [metadata, controls, status]) {
      expect(bounds.y).toBeGreaterThanOrEqual(footer.y)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y + footer.height)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(footer.x + footer.width)
    }
    expect(
      await page.getByTestId('preview-footer').evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true)
  }).toPass()
}

async function tabToRetry(page: Page, retry: Locator) {
  await page.getByRole('combobox', { name: 'Preview display mode' }).focus()
  for (let step = 0; step < 24; step++) {
    await page.keyboard.press('Tab')
    if (await retry.evaluate((element) => element === document.activeElement)) break
  }
  await expect(retry).toBeFocused()
}

test('opens cached photos with only a matching blurred placeholder, including after reload', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const viewport = page.getByTestId('preview-viewport')
  // Both photos must have validated warm frames before rejecting further bitmap fetches.
  await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
  await expect(viewport).toHaveAttribute('data-resolution', 'full')
  await page.getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true }).click()
  await expect(viewport).toHaveAttribute('data-resolution', 'full')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('preview:request')
    ipcMain.handle('preview:request', () => ({ error: 'Unexpected full-preview generation' }))
  })
  await page.evaluate(() => {
    const original = window.fetch
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/full/')) throw new Error('Unexpected reload of a warm bitmap')
      return original(...args)
    }
  })
  await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
  await expect(viewport).toHaveAttribute('data-resolution', 'full')
  await expect(page.getByTestId('main-preview')).toBeVisible()
  await expect(page.getByTestId('preview-placeholder')).toHaveCount(0)
  // Reload drops the bounded bitmap cache while preserving the leased disk cache.
  await page.addInitScript(() => {
    const original = window.fetch
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(window as unknown as { releaseFrame: () => void }).releaseFrame = release
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/full/')) await pending
      return original(...args)
    }
  })
  await page.reload()
  try {
    await expect(viewport).toHaveAttribute('data-resolution', 'placeholder')
    const placeholder = page.getByTestId('preview-placeholder')
    await expect(placeholder).toBeVisible()
    const placeholderUrl = (await placeholder.getAttribute('src'))!
    expect(placeholderUrl).toContain(`/placeholder/${PREVIEW_VERSION}/`)
    await expect(page.getByTestId('main-preview')).not.toBeVisible()
    await expect(viewport.locator('img[src*="/preview"]')).toHaveCount(0)
    await page.evaluate(() => (window as unknown as { releaseFrame: () => void }).releaseFrame())
    await expect(viewport).toHaveAttribute('data-resolution', 'full')
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-src',
      placeholderUrl.replace('/placeholder/', '/full/'),
    )
    await expect(placeholder).toHaveCount(0)
  } finally {
    await page.evaluate(() => (window as unknown as { releaseFrame: () => void }).releaseFrame())
  }
})

// Delay the trusted handler, keeping actual cache, worker and protocol behavior behind the gate.
import { holdFullPreview } from './full-preview.helpers'

test('shows an error without camera JPEG fallback, retries, and repairs corrupt RGBA frames', async ({
  luma,
}) => {
  const { app, page } = luma
  const gate = await holdFullPreview(app)
  const liveError = 'Working preview generation failed while preparing live adjustments. '.repeat(8)
  const liveGate = await app.evaluateHandle(({ ipcMain }, liveError) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const editing = handlers.get('preview:editing')!
    let fail = true
    ipcMain.removeHandler('preview:editing')
    ipcMain.handle('preview:editing', (...args) => (fail ? { error: liveError } : editing(...args)))
    return {
      succeed: () => {
        fail = false
      },
    }
  }, liveError)
  try {
    await gate.evaluate((control) => control.fail())
    // Inject failure without holding import completion behind a foreground preview lease.
    await gate.evaluate((control) => control.release())
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], false)
    await expect(page.getByTestId('preview-resolution')).toContainText(
      'Full resolution unavailable',
    )
    await expect(page.getByTestId('main-preview')).not.toBeVisible()
    await expect(page.getByTestId('preview-viewport').locator('img')).toHaveCount(0)
    await gate.evaluate((control) => control.succeed())
    await page
      .getByTestId('preview-resolution')
      .getByRole('button', { name: 'Retry', exact: true })
      .click()
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('fit')
    await openMinimumConsole(app, page)
    const status = page.getByTestId('preview-resolution')
    await expect(status).toContainText('Live preview unavailable')
    const retryLive = status.getByRole('button', { name: 'Retry live preview', exact: true })
    await expect(retryLive).toHaveAccessibleDescription('Live adjustments could not be prepared.')
    await expect(status).toHaveAttribute('title', 'Live adjustments could not be prepared.')
    await expectCompactFooter(page)
    await liveGate.evaluate((control) => control.succeed())
    await tabToRetry(page, retryLive)
    await page.keyboard.press('Enter')
    await expect(status).toHaveText('Full resolution')
    const url = new URL((await page.getByTestId('main-preview').getAttribute('data-src'))!)
    const [id, , version, revision] = url.pathname.slice(1).split('/')
    const cacheFile = join(
      luma.userDataDir,
      'library',
      'cache',
      'previews',
      version,
      `${id}-${revision}`,
      'full.rgba',
    )
    // Same length bypasses the inexpensive file-size check and exercises the frame integrity check.
    const bytes = await readFile(cacheFile)
    await writeFile(cacheFile, Buffer.alloc(bytes.length))
    await app.evaluate(async ({ session }) => session.defaultSession.clearCache())
    await page.reload()
    await expect(page.getByTestId('preview-resolution')).toContainText(
      'Full resolution unavailable',
    )
    await expect(page.getByTestId('main-preview')).not.toBeVisible()
    await page
      .getByTestId('preview-resolution')
      .getByRole('button', { name: 'Retry', exact: true })
      .click()
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    expect(await page.getByTestId('main-preview').getAttribute('data-src')).not.toBe(url.toString())
    // A broken quick preview must not prevent a valid full-resolution image from loading.
    await writeFile(
      join(luma.userDataDir, 'library', 'originals', id, 'preview.jpg'),
      'Invalid JPEG',
    )
    await app.evaluate(async ({ session }) => session.defaultSession.clearCache())
    await page.reload()
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    await expect(page.getByTestId('main-preview')).toBeVisible()
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
    await liveGate.dispose()
  }
})

test('accepts only the current photo after rapid navigation and permits imports while detail is pending', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await importPhotos(app, page)
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  const gate = await holdFullPreview(app)
  const cached = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('preview:cached')!
    ipcMain.removeHandler('preview:cached')
    ipcMain.handle('preview:cached', () => ({ preview: null }))
    return {
      restore: () => {
        ipcMain.removeHandler('preview:cached')
        ipcMain.handle('preview:cached', original)
      },
    }
  })
  try {
    for (const filename of ['mountain-ridge.jpg', 'alpine-lake.jpg', 'mountain-ridge.jpg'])
      await page.getByRole('button', { name: `Select ${filename}`, exact: true }).click()
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await choose(app, page, ['tests/fixtures/photos/forest-light.jpg'])
    await expect(page.getByTestId('import-status')).toContainText('Ready to import')
    await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('task-progress')).toContainText('Importing')
    await expect(page.getByTestId('preview-filename')).toHaveText('mountain-ridge.jpg')
    await gate.evaluate((control) => control.release())
    await expectImportComplete(page)
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    const { photos } = await page.evaluate(() => window.luma.listPhotos())
    expect(photos).toHaveLength(3)
    const selected = photos.find((photo) => photo.filename === 'mountain-ridge.jpg')!
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-src',
      new RegExp(`/${selected.id}/full/`),
    )
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1100, 700)
    })
    await page.getByTestId('console-toggle').click()
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    const status = await page.getByTestId('preview-resolution').boundingBox()
    expect(status!.x + status!.width).toBeLessThan(1100)
    expect(status!.y + status!.height).toBeLessThan(700)
    await page.screenshot({ path: info.outputPath('full-preview-1100x700.png') })
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
    await cached.evaluate((control) => control.restore())
    await cached.dispose()
  }
})
