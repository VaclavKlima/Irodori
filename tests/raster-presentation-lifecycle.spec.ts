import { readFile } from 'node:fs/promises'
import { minimumAdjustmentWindow } from './adjustment-input.helpers'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { observeNativeCpuReplies } from './retired-presentation.helpers'

const source = 'tests/fixtures/photos/alpine-lake.jpg'

test(
  'raster GPU loss flushes one draft, drains before retry and preserves source, view, Undo/Redo and restart',
  foregroundTest(
    'Live GPU publication after the native minimum-size resize requires foreground animation frames on Wayland.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(60000)
    const original = await readFile(source)
    let { page } = irodori
    await minimumAdjustmentWindow(irodori.app, page)
    await importPhotos(irodori.app, page, [source], true, 'keyboard')
    const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
      before = await page.evaluate((id) => window.irodori.getEdits(id), id),
      observer = await observeNativeCpuReplies(irodori.app)
    try {
      const slider = page.getByRole('slider', { name: 'Exposure', exact: true }),
        canvas = page.getByTestId('main-preview')
      await expect(slider).toBeEnabled()
      await expect(canvas).toHaveAttribute('data-backend', 'webgl2')
      await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
      const view = await canvas.evaluate((el) => ({
        scale: el.parentElement!.dataset.scale,
        x: el.parentElement!.dataset.panX,
        y: el.parentElement!.dataset.panY,
      }))
      await slider.focus()
      await page.keyboard.down('ArrowRight')
      await expect
        .poll(async () => Number(await slider.inputValue()))
        .toBeGreaterThan(before.settings.exposureEv)
      const amount = Number(await slider.inputValue())
      await expect(canvas).toHaveAttribute('data-exposure', String(amount))
      const supported = await canvas.evaluate((el) => {
        const gl = (el as HTMLCanvasElement).getContext('webgl2')!,
          extension = gl.getExtension('WEBGL_lose_context')
        extension?.loseContext()
        return !!extension
      })
      expect(supported, 'The real context-loss extension is required for this proof.').toBe(true)
      const error = page.getByTestId('preview-gpu-error')
      await expect(error).toHaveAttribute('role', 'alert')
      await expect(error).toContainText('WebGL')
      await expect(error.getByRole('button', { name: 'Retry GPU', exact: true })).toBeVisible()
      await expect(canvas).toBeHidden()
      await expect(slider).toBeDisabled()
      await page.keyboard.up('ArrowRight')
      await expect
        .poll(async () => await page.evaluate((id) => window.irodori.getEdits(id), id))
        .toMatchObject({
          revision: before.revision + 1,
          settings: { exposureEv: amount },
          canUndo: true,
        })
      await page.screenshot({ path: info.outputPath('raster-gpu-error-1100.png'), scale: 'css' })
      await error.getByRole('button', { name: 'Retry GPU', exact: true }).click()
      await expect(error).toHaveCount(0)
      await expect(slider).toBeEnabled()
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgl2')
      await expect(page.getByTestId('main-preview')).toHaveAttribute(
        'data-exposure',
        String(amount),
      )
      expect(
        await page.getByTestId('main-preview').evaluate((el) => ({
          scale: el.parentElement!.dataset.scale,
          x: el.parentElement!.dataset.panX,
          y: el.parentElement!.dataset.panY,
        })),
      ).toEqual(view)
      expect(
        page.workers().some((worker) => /\/(?:hdr-)?presentation-worker-/.test(worker.url())),
      ).toBe(false)
      await page.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.irodori.getEdits(id), id)).settings.exposureEv,
        )
        .toBe(before.settings.exposureEv)
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: 'Redo', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.irodori.getEdits(id), id)).settings.exposureEv,
        )
        .toBe(amount)
      await observer.evaluate((control) => control.close())
      await observer.dispose()
      ;({ page } = await irodori.restart())
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgl2')
      await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeEnabled()
      expect(
        (await page.evaluate((id) => window.irodori.getEdits(id), id)).settings.exposureEv,
      ).toBe(amount)
      expect(await readFile(source)).toEqual(original)
    } finally {
      await page.keyboard.up('ArrowRight').catch(() => undefined)
    }
  },
)
