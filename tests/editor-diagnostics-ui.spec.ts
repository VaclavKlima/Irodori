import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { minimumAdjustmentWindow } from './adjustment-input.helpers'
import { captureWindow } from './window-capture.helpers'

test(
  'Editor scopes the exact histogram and transparent clipping to a committed region or saved mask',
  foregroundTest(
    'Console-open native geometry and a submitted photograph are required for overlay alignment.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(120000)
    const width = 80,
      height = 60
    const pixels = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width / 2; x++) pixels[(y * width + x) * 3] = 255
    const path = info.outputPath('regional-color-grid.png')
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(path)
    await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
    await importPhotos(app, page, [path], false, 'keyboard')
    await minimumAdjustmentWindow(app, page)
    const scope = page.getByRole('combobox', { name: 'Histogram scope' })
    const histogram = page.locator('#histogram')
    const overlay = page.getByTestId('diagnostics-clipping-overlay')
    const { id } = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
    await expect(scope).toBeEnabled({ timeout: 30000 })
    const context = await app.evaluateHandle(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => unknown
      const channel = 'preview:context'
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers
      const original = handlers.get(channel)!
      let held = false,
        release!: () => void,
        finished!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const drained = new Promise<void>((resolve) => {
        finished = resolve
      })
      const wrapper: Handler = async (...args) => {
        if (held) return original(...args)
        held = true
        try {
          await gate
          return await original(...args)
        } finally {
          finished()
        }
      }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, wrapper)
      return {
        held: () => held,
        async release() {
          release()
          await drained
        },
        close() {
          release()
          if (handlers.get(channel) === wrapper) {
            ipcMain.removeHandler(channel)
            ipcMain.handle(channel, original)
          }
        },
      }
    })
    try {
      await scope.selectOption('region')
      await expect.poll(() => context.evaluate((gate) => gate.held())).toBe(true)
      await scope.selectOption('whole-photo')
      await context.evaluate((gate) => gate.release())
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          }),
      )
      await expect(page.getByTestId('inspection-region-controls')).toHaveCount(0)
    } finally {
      await context.evaluate((gate) => gate.close())
      await context.dispose()
    }
    await scope.selectOption('region')
    for (const [label, value] of [
      ['Width', '20'],
      ['Height', '10'],
    ]) {
      const field = page.getByRole('textbox', { name: `Inspection ${label}`, exact: true })
      await expect(field).toBeEnabled()
      await field.fill(value)
      await field.press('Enter')
    }
    await expect(histogram).toHaveAttribute('data-diagnostics-selection', 'region')
    await expect(histogram).toHaveAttribute('data-samples', '200', { timeout: 30000 })
    await activateButton(page.getByRole('button', { name: 'Show diagnostic clipping' }))
    await expect(overlay).toBeVisible()
    const bounds = await overlay.boundingBox()
    const rectangle = await page.getByTestId('inspection-region-frame').boundingBox()
    expect(bounds).toEqual(rectangle)
    const regionMap = await overlay.getAttribute('src')
    const regionPixels = await sharp(Buffer.from(regionMap!.split(',')[1], 'base64'))
      .raw()
      .toBuffer()
    expect([...regionPixels.subarray(0, 4)]).toEqual([255, 0, 0, 180])
    await captureWindow(app, page, info.outputPath('editor-diagnostics-region.png'))

    const maskId = crypto.randomUUID()
    const gradient = {
      kind: 'radial' as const,
      center: { x: 0.75, y: 0.5 },
      radiusX: 0.2,
      radiusY: 0.25,
      rotation: 0,
      feather: 0,
    }
    await page.evaluate(
      ({ id, maskId, gradient }) =>
        window.irodori.mutateMasks(id, 0, {
          operations: [{ kind: 'create', id: maskId, name: 'Right ellipse', gradient }],
        }),
      { id, maskId, gradient },
    )
    await expect(scope.getByRole('option', { name: 'Right ellipse' })).toBeEnabled({
      timeout: 30000,
    })
    const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
    await scope.selectOption(`mask:${maskId}`)
    let inside = 0
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const dx = ((x + 0.5) / width - gradient.center.x) / gradient.radiusX
        const dy = ((y + 0.5) / height - gradient.center.y) / gradient.radiusY
        if (dx * dx + dy * dy <= 1) inside++
      }
    await expect(histogram).toHaveAttribute('data-diagnostics-selection', `mask:${maskId}`)
    await expect(histogram).toHaveAttribute('data-diagnostics-revision', '1', { timeout: 30000 })
    await expect(histogram).toHaveAttribute('data-samples', String(inside))
    const clipping = page.getByRole('button', { name: 'Show diagnostic clipping' })
    await expect(clipping).toBeEnabled()
    if ((await clipping.getAttribute('aria-pressed')) !== 'true') await activateButton(clipping)
    await expect(overlay).toBeVisible()
    const maskMap = await overlay.getAttribute('src')
    const maskPixels = await sharp(Buffer.from(maskMap!.split(',')[1], 'base64'))
      .raw()
      .toBuffer()
    const center = (30 * width + 60) * 4
    expect([...maskPixels.subarray(center, center + 4)]).toEqual([0, 0, 255, 180])
    expect(maskPixels[(30 * width + 20) * 4 + 3]).toBe(0)
    await captureWindow(app, page, info.outputPath('editor-diagnostics-mask.png'))

    await scope.selectOption('whole-photo')
    await expect(overlay).toHaveCount(0)
    await expect(histogram).not.toHaveAttribute('data-diagnostics-selection', `mask:${maskId}`)
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(history)
  },
)
