import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

export async function openOutputProof(page: Page) {
  await activateButton(page.getByRole('button', { name: 'Export photo', exact: true }))
  await activateButton(page.getByRole('button', { name: /Custom…/ }))
  return page.getByRole('dialog', { name: 'Custom JPEG export' })
}

async function observeProofs(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>
      }
    )._invokeHandlers
    const original = handlers.get('export:proof')!,
      cancel = handlers.get('export:proof-cancel')!
    const proofs: unknown[] = [],
      cancelled: string[] = []
    let calls = 0,
      holding = false
    const pending: (() => void)[] = []
    ipcMain.removeHandler('export:proof')
    ipcMain.handle('export:proof', async (...args) => {
      calls++
      const result = await original(...args)
      proofs.push(result)
      if (holding) await new Promise<void>((resolve) => pending.push(resolve))
      return result
    })
    ipcMain.removeHandler('export:proof-cancel')
    ipcMain.handle('export:proof-cancel', async (...args) => {
      cancelled.push(String(args[1]))
      return cancel(...args)
    })
    return {
      read: () => ({ calls, proofs, cancelled, pending: pending.length }),
      hold: () => {
        holding = true
      },
      release: () => {
        holding = false
        for (const resolve of pending.splice(0)) resolve()
      },
      restore: () => {
        holding = false
        for (const resolve of pending.splice(0)) resolve()
        ipcMain.removeHandler('export:proof')
        ipcMain.handle('export:proof', original)
        ipcMain.removeHandler('export:proof-cancel')
        ipcMain.handle('export:proof-cancel', cancel)
      },
    }
  })
}

test('explicit decoded JPEG preview preserves source view and preferences, and updates only pixel settings at minimum size', async ({
  irodori,
}, info) => {
  test.setTimeout(120000)
  const { app, page } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
  await page.getByLabel('Preview zoom', { exact: true }).selectOption('2')
  // The viewport owns the view; renderer-route changes can replace its child canvas.
  const sourceViewport = await page.getByTestId('preview-viewport').elementHandle()
  const sourceView = await page
    .getByTestId('preview-viewport')
    .evaluate((e) => [e.dataset.mode, e.dataset.scale, e.dataset.panX, e.dataset.panY])
  const history = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
  const prefs = await page.evaluate(() => window.irodori.getExportPreferences())
  const native = await app.browserWindow(page)
  await native.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await activateButton(page.getByTestId('console-toggle'))
  const observer = await observeProofs(app)
  try {
    const dialog = await openOutputProof(page),
      viewport = page.getByTestId('output-proof-viewport')
    await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
    expect((await observer.evaluate((o) => o.read())).calls).toBe(0)
    await expect(viewport.locator('canvas')).toHaveCount(0)
    await activateButton(dialog.getByRole('button', { name: 'Preview output', exact: true }))
    try {
      await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
    } catch (error) {
      await info.attach('proof-viewport-state', {
        contentType: 'application/json',
        body: JSON.stringify(
          await viewport.evaluate((e) => {
            const canvas = e.querySelector('canvas'),
              r = e.getBoundingClientRect()
            return {
              viewport: { width: r.width, height: r.height, ...e.dataset },
              canvas: canvas
                ? { width: canvas.width, height: canvas.height, ...canvas.dataset }
                : null,
              alerts: Array.from(document.querySelectorAll('[role="alert"]'), (a) => a.textContent),
            }
          }),
        ),
      })
      throw error
    }
    await expect(viewport).toHaveAttribute('data-fit', 'true')
    expect(Number(await viewport.getAttribute('data-scale'))).toBeLessThanOrEqual(1)
    const first = await viewport.getAttribute('data-proof-id')
    await page.getByLabel('Output preview zoom', { exact: true }).selectOption('1')
    await expect(viewport).toHaveAttribute('data-scale', '1')
    await viewport.focus()
    await viewport.press('ArrowRight')
    const center = await viewport.evaluate((e) => Number(e.dataset.x))
    const quality = dialog.getByRole('spinbutton', { name: 'JPEG quality value' })
    await quality.fill('61')
    await quality.press('Enter')
    await expect(dialog.getByRole('status')).toHaveText('Preview out of date')
    expect(await viewport.getAttribute('data-proof-id')).toBe(first)
    expect((await observer.evaluate((o) => o.read())).calls).toBe(1)
    await activateButton(dialog.getByRole('button', { name: 'Update preview', exact: true }))
    await expect(viewport).not.toHaveAttribute('data-proof-id', first!)
    await expect(viewport).toHaveAttribute('data-ready', 'true')
    await expect(viewport).toHaveAttribute('data-scale', '1')
    expect(Number(await viewport.getAttribute('data-x'))).toBe(center)
    const updated = await viewport.getAttribute('data-proof-id')
    await dialog.getByRole('combobox', { name: 'Metadata', exact: true }).selectOption('none')
    await dialog.getByLabel('Optional suffix', { exact: true }).fill('-Review')
    await dialog.getByRole('combobox', { name: 'Existing files', exact: true }).selectOption('skip')
    await page.getByLabel('Output preview display', { exact: true }).selectOption('sdr')
    await expect(dialog.getByRole('status')).toHaveText('Decoded JPEG output')
    expect(await viewport.getAttribute('data-proof-id')).toBe(updated)
    expect((await observer.evaluate((o) => o.read())).calls).toBe(2)
    await expect(page.getByTestId('output-proof-filename')).toContainText('-Review.jpg')
    const rectangles = await dialog.evaluate((element) => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect()
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        }
      }
      return {
        dialog: box(element),
        output: box(element.querySelector('[data-testid="output-proof-viewport"]')!),
        footer: box(element.querySelector('footer')!),
        overflow: element.scrollWidth > element.clientWidth,
      }
    })
    expect(rectangles.dialog.right).toBeLessThanOrEqual(1100)
    expect(rectangles.dialog.bottom).toBeLessThanOrEqual(700)
    expect(rectangles.output.width).toBeGreaterThan(500)
    expect(rectangles.footer.bottom).toBeLessThan(700)
    expect(rectangles.overflow).toBe(false)
    await activateButton(dialog.getByRole('button', { name: 'Back', exact: true }))
    await expect(page.getByRole('button', { name: /Custom…/ })).toBeFocused()
    await activateButton(page.getByRole('button', { name: 'Cancel', exact: true }))
    expect(await sourceViewport!.evaluate((e) => e.isConnected)).toBe(true)
    expect(
      await page
        .getByTestId('preview-viewport')
        .evaluate((e) => [e.dataset.mode, e.dataset.scale, e.dataset.panX, e.dataset.panY]),
    ).toEqual(sourceView)
    expect(await page.evaluate(() => window.irodori.getExportPreferences())).toEqual(prefs)
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
      history,
    )
    await expect
      .poll(() => readdir(join(irodori.userDataDir, 'library', 'cache', 'output-proofs')))
      .toEqual([])
  } finally {
    await observer.evaluate((o) => o.restore())
    await observer.dispose()
  }
})

test('batch proof starts at the active frozen photograph and navigates without changing selection', async ({
  irodori,
}) => {
  const { app, page } = irodori
  await importPhotos(app, page, undefined, true, 'keyboard')
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[1].id}`).click({ modifiers: ['ControlOrMeta'] })
  const dialog = await openOutputProof(page)
  await expect(page.getByTestId('output-proof-filename')).toHaveText(
    photos[1].filename.replace(/\.[^.]+$/, '.jpg'),
  )
  await activateButton(dialog.getByRole('button', { name: 'Preview output', exact: true }))
  const viewport = page.getByTestId('output-proof-viewport')
  await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
  await page.getByLabel('Output preview zoom', { exact: true }).selectOption('2')
  const next = dialog.getByRole('button', { name: 'Next output photograph' }),
    previous = dialog.getByRole('button', { name: 'Previous output photograph' })
  const direction = (await next.isEnabled()) ? next : previous
  await activateButton(direction)
  await expect(viewport.locator('canvas')).toHaveCount(0)
  await activateButton(dialog.getByRole('button', { name: 'Preview output', exact: true }))
  await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
  for (const photo of photos)
    await expect(page.getByTestId(`photo-card-${photo.id}`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
})

test('obsolete completion is released, Escape remains available during loading, and export needs no proof', async ({
  irodori,
}) => {
  test.setTimeout(120000)
  const { app, page } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const observer = await observeProofs(app)
  try {
    await observer.evaluate((o) => o.hold())
    const dialog = await openOutputProof(page)
    await activateButton(dialog.getByRole('button', { name: 'Preview output', exact: true }))
    await expect.poll(() => observer.evaluate((o) => o.read().pending), { timeout: 60000 }).toBe(1)
    const quality = dialog.getByRole('spinbutton', { name: 'JPEG quality value' })
    await quality.fill('82')
    await quality.press('Enter')
    await expect.poll(() => observer.evaluate((o) => o.read().cancelled.length)).toBe(1)
    await observer.evaluate((o) => o.release())
    await expect(page.getByTestId('output-proof-viewport').locator('canvas')).toHaveCount(0)
    await expect
      .poll(() => readdir(join(irodori.userDataDir, 'library', 'cache', 'output-proofs')))
      .toEqual([])
    await observer.evaluate((o) => o.hold())
    await activateButton(dialog.getByRole('button', { name: 'Preview output', exact: true }))
    await expect.poll(() => observer.evaluate((o) => o.read().pending), { timeout: 60000 }).toBe(1)
    await dialog.press('Escape')
    await expect(dialog).toHaveCount(0)
    await observer.evaluate((o) => o.release())
    await expect
      .poll(() => readdir(join(irodori.userDataDir, 'library', 'cache', 'output-proofs')))
      .toEqual([])
    await openOutputProof(page)
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
    expect((await page.evaluate(() => window.irodori.getExportPreferences())).lastCustom).toBeNull()
    await activateButton(page.getByRole('button', { name: 'Cancel', exact: true }))
  } finally {
    await observer.evaluate((o) => o.restore())
    await observer.dispose()
  }
})

test('proof GPU loss keeps the encoded proof and retries presentation without re-encoding', async ({
  irodori,
}) => {
  const { app, page } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const observer = await observeProofs(app)
  try {
    const dialog = await openOutputProof(page),
      viewport = page.getByTestId('output-proof-viewport')
    await activateButton(dialog.getByRole('button', { name: 'Preview output', exact: true }))
    await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
    const id = await viewport.getAttribute('data-proof-id')
    await viewport
      .locator('canvas')
      .evaluate((e) =>
        (e as HTMLCanvasElement)
          .getContext('webgl2')!
          .getExtension('WEBGL_lose_context')!
          .loseContext(),
      )
    await expect(dialog.getByRole('button', { name: 'Retry GPU', exact: true })).toBeVisible()
    await activateButton(dialog.getByRole('button', { name: 'Retry GPU', exact: true }))
    await expect(viewport).toHaveAttribute('data-ready', 'true')
    expect(await viewport.getAttribute('data-proof-id')).toBe(id)
    expect((await observer.evaluate((o) => o.read())).calls).toBe(1)
    await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  } finally {
    await observer.evaluate((o) => o.restore())
    await observer.dispose()
  }
})

test('an external source revision invalidates the frozen preparation and retains its clearly stale proof', async ({
  irodori,
}) => {
  const { app, page } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
  const dialog = await openOutputProof(page),
    viewport = page.getByTestId('output-proof-viewport')
  await activateButton(dialog.getByRole('button', { name: 'Preview output', exact: true }))
  await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
  const id = await viewport.getAttribute('data-proof-id')
  await page.evaluate((id) => window.irodori.updateEdits(id, { exposureEv: 0.5 }, 0), photo.id)
  await expect(dialog.getByRole('status')).toHaveText('Preview out of date')
  await expect(dialog).toContainText('Open the export chooser again.')
  await expect(dialog.getByRole('button', { name: 'Update preview', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
  expect(await viewport.getAttribute('data-proof-id')).toBe(id)
  await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
})
