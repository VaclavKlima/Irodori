import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('histogram, clipping and comparison preserve edits and view, with accessible split and Canvas2D fallback', async ({
  luma,
}, info) => {
  test.setTimeout(90000)
  const { page } = luma
  await importPhotos(luma.app, page, [
    'tests/fixtures/photos/alpine-lake.jpg',
    'tests/fixtures/photos/forest-light.jpg',
  ])
  const canvas = page.getByTestId('main-preview'),
    viewport = page.getByTestId('preview-viewport')
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 30000 })
  const histogram = page.getByRole('slider', { name: 'Histogram tonal value' })
  await expect(histogram).toHaveAttribute('aria-valuetext', /Value 128/)
  const readout = await histogram.getAttribute('aria-valuetext')
  await expect(page.getByText(readout!, { exact: true })).toHaveCount(0)
  await expect(page.locator('#histogram details')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('1')
  await expect(histogram).toHaveAttribute('aria-valuetext', readout!)
  await histogram.focus()
  await histogram.press('ArrowRight')
  await expect(histogram).toHaveAttribute('aria-valuenow', '129')
  await expect(page.getByRole('spinbutton', { name: 'Temperature value' })).toBeDisabled()
  const filename = await page.getByTestId('preview-filename').textContent()
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
    (photo) => photo.filename === filename,
  )!.id
  const initial = await page.evaluate((id) => window.luma.getEdits(id), id)
  await canvas.focus()
  await canvas.press('y')
  await expect(canvas).toHaveAttribute('data-comparison', 'split')
  const divider = page.getByRole('slider', { name: 'Before and After divider' })
  const pan = await viewport.getAttribute('data-pan-x')
  await divider.focus()
  await divider.press('ArrowRight')
  await expect(divider).toHaveAttribute('aria-valuenow', '51')
  const box = await divider.boundingBox(),
    area = await viewport.boundingBox()
  await page.mouse.move(box!.x + 4, box!.y + 30)
  await page.mouse.down()
  await page.mouse.move(area!.x + area!.width * 0.7, box!.y + 30)
  await page.mouse.up()
  await expect(divider).toHaveAttribute('aria-valuenow', '70')
  await expect(viewport).toHaveAttribute('data-pan-x', pan!)
  await canvas.focus()
  await canvas.press('j')
  await expect(page.getByRole('button', { name: 'Shadow clipping', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await canvas.press('\\')
  await expect(canvas).toHaveAttribute('data-comparison', 'before')
  expect((await page.evaluate((id) => window.luma.getEdits(id), id)).revision).toBe(
    initial.revision,
  )
  const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
  await exposure.fill('1')
  await exposure.press('Enter')
  await expect(canvas).toHaveAttribute('data-comparison', 'after')
  const state = await page.evaluate((id) => window.luma.getEdits(id), id)
  await expect
    .poll(async () => {
      try {
        return (
          await page.evaluate(({ id, revision }) => window.luma.getPhotoStatistics(id, revision), {
            id,
            revision: state.revision,
          })
        ).visiblePixels
      } catch {
        return 0
      }
    })
    .toBeGreaterThan(0)
  await expect(
    page.evaluate(({ id, revision }) => window.luma.getPhotoStatistics(id, revision), {
      id,
      revision: state.revision - 1,
    }),
  ).rejects.toThrow(/conflict/)
  await canvas.evaluate((element) =>
    (element as HTMLCanvasElement)
      .getContext('webgl2')!
      .getExtension('WEBGL_lose_context')!
      .loseContext(),
  )
  await expect(canvas).toHaveAttribute('data-backend', 'canvas2d')
  await canvas.focus()
  await canvas.press('y')
  await expect(canvas).toHaveAttribute('data-comparison', 'split')
  await luma.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await page.getByTestId('console-toggle').click()
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await page.screenshot({ path: info.outputPath('comparison.png') })
  await page.getByRole('button', { name: 'Previous photo', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-comparison', 'after')
  await expect(page.getByRole('button', { name: 'Shadow clipping', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
})
