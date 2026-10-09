import type { Page } from '@playwright/test'
import sharp from 'sharp'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { focusPreviewWindow, verifyLockedPan } from './preview-pan.helpers'
import { holdPreviewFrame, verifyPreviewWheel } from './preview-wheel.helpers'

async function geometry(page: Page) {
  return page.getByTestId('preview-viewport').evaluate((element) => {
    const viewport = element.getBoundingClientRect()
    const bounds = {
      width:
        Number(element.getAttribute('data-image-width')) *
        Number(element.getAttribute('data-scale')),
      height:
        Number(element.getAttribute('data-image-height')) *
        Number(element.getAttribute('data-scale')),
    }
    return {
      scale: Number(element.getAttribute('data-scale')),
      x: Number(element.getAttribute('data-pan-x')),
      y: Number(element.getAttribute('data-pan-y')),
      width: viewport.width,
      height: viewport.height,
      left: viewport.left,
      top: viewport.top,
      imageWidth: bounds.width,
      imageHeight: bounds.height,
      naturalWidth: Number(element.getAttribute('data-image-width')),
      naturalHeight: Number(element.getAttribute('data-image-height')),
    }
  })
}

test('scroll pans without zooming and mixed gesture bursts present once with matching overlays', async ({
  luma,
}) => {
  await importPhotos(luma.app, luma.page)
  await luma.page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
  await expect(luma.page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await verifyPreviewWheel(
    luma.page,
    luma.page.getByTestId('preview-viewport'),
    luma.page.getByRole('combobox', { name: 'Preview zoom', exact: true }),
  )
  const pending = await holdPreviewFrame(luma.page.getByTestId('preview-viewport'))
  try {
    expect(await pending.evaluate((state) => state.held)).toBe(true)
    await luma.page.getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true }).click()
    await expect(luma.page.getByTestId('preview-filename')).toHaveText('mountain-ridge.jpg')
    await expect(luma.page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('fit')
    await expect.poll(() => pending.evaluate((state) => state.cancelled)).toBe(true)
  } finally {
    await pending.evaluate((state) => state.restore())
    await pending.dispose()
  }
})

test('mouse panning hides and locks the cursor until release or interruption', async ({ luma }) => {
  await importPhotos(luma.app, luma.page)
  await verifyLockedPan(
    luma.app,
    luma.page,
    luma.page.getByTestId('preview-viewport'),
    luma.page.getByRole('combobox', { name: 'Preview zoom', exact: true }),
  )
})

test('zooms at the pointer, pans with capture, and retains keyboard and context-menu controls', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page)
  await focusPreviewWindow(app, page)
  const viewport = page.getByTestId('preview-viewport')
  const zoom = page.getByRole('combobox', { name: 'Preview zoom' })
  await expect(zoom).toHaveValue('fit')
  await zoom.selectOption('1')
  let before = await geometry(page)
  expect(before.imageWidth).toBeCloseTo(before.naturalWidth, 1)
  const point = { x: before.left + before.width / 2 + 65, y: before.top + before.height / 2 + 35 }
  await page.mouse.move(point.x, point.y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await geometry(page)).scale).toBeGreaterThan(1)
  const after = await geometry(page)
  expect(after.scale).toBeCloseTo(Math.exp(1), 5)
  expect((65 - after.x) / after.scale).toBeCloseTo((65 - before.x) / before.scale, 3)
  expect((35 - after.y) / after.scale).toBeCloseTo((35 - before.y) / before.scale, 3)
  await page.mouse.down()
  await page.mouse.move(point.x - 60, point.y - 35, { steps: 5 })
  await page.mouse.up()
  const dragged = await geometry(page)
  expect(dragged.x).toBeCloseTo(after.x - 60, 1)
  expect(dragged.y).toBeCloseTo(after.y - 35, 1)
  await page.mouse.down()
  await page.mouse.move(5, 5, { steps: 8 })
  await page.mouse.up()
  await expect(viewport).not.toHaveCSS('cursor', 'none')
  const released = await geometry(page)
  await page.mouse.move(point.x, point.y)
  expect((await geometry(page)).x).toBe(released.x)
  // Cancellation and loss of capture must not leave subsequent moves attached to the photo.
  for (const event of ['pointercancel', 'lostpointercapture']) {
    await page.mouse.down()
    await expect
      .poll(() =>
        viewport.evaluate((el) => el.hasPointerCapture(1) || document.pointerLockElement === el),
      )
      .toBe(true)
    if (event === 'lostpointercapture') {
      await expect
        .poll(() => viewport.evaluate((el) => document.pointerLockElement === el))
        .toBe(true)
      await page.evaluate(() => document.exitPointerLock())
    } else await viewport.dispatchEvent(event)
    await expect(viewport).toHaveAttribute('data-dragging', 'false')
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true)
    await expect(viewport).not.toHaveCSS('cursor', 'none')
    const cancelled = await geometry(page)
    await page.mouse.move(point.x + 20, point.y + 20)
    expect((await geometry(page)).x).toBe(cancelled.x)
    await page.mouse.up()
    await page.mouse.move(point.x, point.y)
  }
  await zoom.selectOption('1')
  await page.mouse.move(point.x, point.y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await geometry(page)).scale).toBeGreaterThan(1)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
  ).toBe(1)
  const wheelScale = (await geometry(page)).scale
  await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).hover()
  await page.mouse.wheel(0, 100)
  expect((await geometry(page)).scale).toBe(wheelScale)
  await page.getByTestId('main-preview').focus()
  await page.keyboard.press('0')
  await expect(zoom).toHaveValue('fit')
  await page.keyboard.press('1')
  await expect(zoom).toHaveValue('1')
  before = await geometry(page)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  expect((await geometry(page)).x).toBe(before.x - 40)
  expect((await geometry(page)).y).toBe(before.y - 120)
  await page.keyboard.press('+')
  await expect(zoom).toHaveValue('2')
  await page.keyboard.press('-')
  await expect(zoom).toHaveValue('1')
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: 'Delete photo…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Delete photo?')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Fit preview', exact: true }).click()
  await viewport.dblclick()
  await expect(zoom).toHaveValue('1')
  await viewport.dblclick()
  await expect(zoom).toHaveValue('fit')
  await zoom.selectOption('32')
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled()
  await zoom.selectOption('0.1')
  await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Fit preview', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('preview-controls.png') })
})

test('resizes Fit and manual views, preserves same-photo zoom across imports, and resets new photos', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const zoom = page.getByRole('combobox', { name: 'Preview zoom' })
  const fit = await geometry(page)
  await page.getByTestId('console-toggle').click()
  await expect.poll(async () => (await geometry(page)).scale).toBeLessThan(fit.scale)
  await zoom.selectOption('1')
  await page.getByTestId('main-preview').focus()
  await page.keyboard.press('ArrowRight')
  const manual = await geometry(page)
  await page.getByTestId('console-toggle').click()
  await expect.poll(async () => (await geometry(page)).height).toBe(fit.height)
  expect((await geometry(page)).scale).toBe(1)
  expect((await geometry(page)).x).toBe(manual.x)
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'])
  await expect(zoom).toHaveValue('1')
  expect((await geometry(page)).x).toBe(manual.x)
  await page.getByRole('button', { name: 'Select forest-light.jpg', exact: true }).click()
  await expect(zoom).toHaveValue('fit')
  await expect(page.getByTestId('main-preview')).toBeVisible()
  await zoom.selectOption('2')
  await page
    .getByRole('button', { name: 'Select forest-light.jpg', exact: true })
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(zoom).toHaveValue('2')
  await page.getByRole('button', { name: 'Next photo', exact: true }).click()
  await expect(zoom).toHaveValue('fit')
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await page.getByTestId('console-toggle').click()
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  for (const id of ['preview-viewport', 'zoom-controls', 'console-panel']) {
    const box = await page.getByTestId(id).boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1100)
    expect(box!.y + box!.height).toBeLessThanOrEqual(700)
  }
  const initialScale = (await geometry(page)).scale
  const consoleInput = page.getByRole('textbox', {
    name: 'Agent console output, disconnected and read only',
  })
  await consoleInput.focus()
  await page.keyboard.press('1')
  await page.keyboard.press('+')
  expect((await geometry(page)).scale).toBe(initialScale)
  await page.screenshot({ path: testInfo.outputPath('preview-1100x700.png') })
})

test('keeps small images at native size and fits a portrait using decoded preview dimensions', async ({
  luma,
}, testInfo) => {
  const small = testInfo.outputPath('small.png')
  const portrait = testInfo.outputPath('portrait.png')
  await sharp({ create: { width: 80, height: 40, channels: 3, background: '#456789' } })
    .png()
    .toFile(small)
  await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#987654' } })
    .png()
    .toFile(portrait)
  await importPhotos(luma.app, luma.page, [small, portrait])
  await luma.page.getByRole('button', { name: 'Select small.png', exact: true }).click()
  await expect(luma.page.getByTestId('main-preview')).toBeVisible()
  expect((await geometry(luma.page)).imageWidth).toBe(80)
  expect((await geometry(luma.page)).imageHeight).toBe(40)
  await luma.page.getByRole('button', { name: 'Select portrait.png', exact: true }).click()
  await expect(luma.page.getByTestId('main-preview')).toBeVisible()
  const actual = await geometry(luma.page)
  expect(actual.imageHeight).toBeCloseTo(actual.height, 1)
  expect(actual.imageWidth).toBeCloseTo(actual.imageHeight / 2, 1)
})

test('keeps controls disabled after invalid frame metadata and recovers through Retry', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const first = (await page.evaluate(() => window.luma.listPhotos())).photos[0]
  await page.getByTestId(`photo-card-${first.id}`).click()
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  const gate = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const cached = handlers.get('preview:cached')!
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('preview:cached')
    ipcMain.handle('preview:cached', async (...args) => {
      const result = (await cached(...args)) as { preview: Record<string, unknown> }
      await pending
      return { preview: { ...result.preview, width: Number.MAX_SAFE_INTEGER } }
    })
    return { release }
  })
  try {
    await page.reload()
    await expect(page.getByText('Loading preview…', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toBeDisabled()
    expect(
      await page.getByTestId('preview-viewport').evaluate((el) => {
        const wheel = new WheelEvent('wheel', { cancelable: true, ctrlKey: true, deltaY: -20 })
        el.dispatchEvent(wheel)
        return wheel.defaultPrevented
      }),
    ).toBe(false)
    await gate.evaluate((control) => control.release())
    await expect(page.getByRole('alert')).toContainText('Could not load this preview.')
    await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled()
    expect(
      await page.getByTestId('preview-viewport').evaluate((el) => {
        const wheel = new WheelEvent('wheel', { cancelable: true, deltaX: 20, deltaY: 30 })
        el.dispatchEvent(wheel)
        return wheel.defaultPrevented
      }),
    ).toBe(false)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByTestId('main-preview')).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('fit')
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})
