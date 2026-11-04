import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { openInspectorTool } from './inspector.helpers'

test(
  'holding the scroll-wheel button pans the photograph through targeting and crop without editing it',
  foregroundTest(
    'Middle-button pointer lock and native capture cleanup require a foreground window.',
  ),
  async ({ irodori: { app, page } }) => {
    await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
    const canvas = page.getByTestId('main-preview'),
      viewport = page.getByTestId('preview-viewport'),
      zoom = page.getByRole('combobox', { name: 'Preview zoom', exact: true }),
      id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
      history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
      original = await history()
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await activateButton(page.getByTestId('console-toggle'))
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate((window) => {
      window.unmaximize()
      const [, outer] = window.getSize(),
        [, content] = window.getContentSize()
      window.setMinimumSize(1100, 700 + outer - content)
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const view = () =>
      viewport.evaluate((node) => ({
        x: Number(node.dataset.panX),
        y: Number(node.dataset.panY),
        scale: Number(node.dataset.scale),
      }))
    const locked = () => viewport.evaluate((node) => document.pointerLockElement === node)
    await focusPreviewWindow(app, page)
    const fit = await view(),
      fitBox = (await viewport.boundingBox())!
    await page.mouse.move(fitBox.x + fitBox.width / 2, fitBox.y + fitBox.height / 2)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(fitBox.x + fitBox.width / 2 + 20, fitBox.y + fitBox.height / 2 + 10)
    await page.mouse.up({ button: 'middle' })
    expect(await locked()).toBe(false)
    expect(await view()).toEqual(fit)
    await zoom.selectOption('2')

    async function drag(escape = false) {
      await focusPreviewWindow(app, page)
      const box = (await viewport.boundingBox())!,
        before = await view(),
        x = Math.round(box.x + box.width / 2),
        y = Math.round(box.y + box.height / 2)
      await page.mouse.move(x, y)
      await page.mouse.down({ button: 'middle' })
      try {
        await expect.poll(locked).toBe(true)
        await expect(viewport).toHaveCSS('cursor', 'none')
        await page.mouse.move(x + 36, y + 24, { steps: 4 })
        await expect.poll(async () => (await view()).x).not.toBe(before.x)
        await expect.poll(async () => (await view()).y).not.toBe(before.y)
        if (escape) await page.keyboard.press('Escape')
      } finally {
        await page.mouse.up({ button: 'middle' })
      }
      await expect.poll(locked).toBe(false)
      await expect(viewport).toHaveAttribute('data-dragging', 'false')
      await expect(viewport).not.toHaveCSS('cursor', 'none')
      expect(await viewport.evaluate((node) => node.hasPointerCapture(1))).toBe(false)
      const released = await view()
      expect(released.scale).toBe(before.scale)
      await page.mouse.move(x - 20, y - 20)
      expect(await view()).toEqual(released)
      expect(await history()).toEqual(original)
    }

    await drag()
    const target = page.getByRole('button', { name: 'Target tones on photo', exact: true })
    await activateButton(target)
    await drag()
    await expect(target).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('curve-graph')).toHaveAttribute('data-point-count', '2')
    await activateButton(target)
    await openInspectorTool(page, 'Crop')
    await activateButton(page.getByRole('button', { name: 'Crop and straighten', exact: true }))
    await expect(page.getByTestId('crop-overlay')).toBeVisible()
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await zoom.selectOption('2')
    await drag(true)
    await expect(page.getByTestId('crop-overlay')).toBeVisible()
    await expect(page.getByTestId('console-panel')).toBeVisible()
    await activateButton(page.getByRole('button', { name: 'Cancel crop', exact: true }))
    expect(await history()).toEqual(original)
  },
)
