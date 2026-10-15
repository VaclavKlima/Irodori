import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { readGainJpeg } from './export-reference'

test.use({ hdrDisplay: true })
test('HDR JPEG import presents HDR, preserves its SDR primary and survives restart and export', async ({
  luma,
}, info) => {
  const directory = info.outputPath('chart')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory)
  const app = luma.app
  let page = luma.page
  await importPhotos(app, page, [image.path], false)
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal')
  const pixel = await page.evaluate(
    async (id) => window.luma.getPhotoPixel(id, 0, 224, 32, { domain: 'content-hdr' }),
    id,
  )
  expect(pixel.rgb[0]).toBeCloseTo(4, 1)
  await expect(
    page.evaluate(
      async (id) => window.luma.getPhotoPixel(id, 0, 224, 32, { domain: 'output', target: 'sdr' }),
      id,
    ),
  ).rejects.toThrow('SDR output analysis')
  await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('sdr')
  await expect(page.getByTestId('main-preview')).toHaveAttribute(
    'data-backend',
    /^(webgpu|canvas2d)$/,
  )
  const box = await page.getByTestId('main-preview').boundingBox()
  const nativeWindow = await app.browserWindow(page)
  await expect
    .poll(async () =>
      nativeWindow.evaluate(async (window, rect) => {
        const image = await window.capturePage(
          {
            x: Math.round(rect!.x + rect!.width / 2),
            y: Math.round(rect!.y + rect!.height / 2),
            width: 1,
            height: 1,
          },
          { stayHidden: true },
        )
        return Math.abs(image.toBitmap()[0] - 170)
      }, box),
    )
    .toBeLessThanOrEqual(4)
  await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('hdr')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  const chooser = page.getByRole('dialog', { name: 'Export JPEG', exact: true })
  await expect(chooser).toContainText('1 photo · 1 HDR · 0 SDR')
  await chooser.getByRole('button', { name: /Maximum quality/ }).click()
  await expect(page.getByTestId('task-details')).toContainText(
    '1 exported · 0 skipped · 0 failed',
    { timeout: 30000 },
  )
  expect((await readFile(join(destination, 'authored-hdr.jpg'))).length).toBeGreaterThan(1000)
  page = (await luma.restart()).page
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
  expect((await page.evaluate((id) => window.luma.getEditHistory(id), id)).snapshots).toHaveLength(
    1,
  )
})

test('an invalid ISO gain map imports its preserved SDR primary with a counted fallback explanation', async ({
  luma,
}, info) => {
  const directory = info.outputPath('invalid')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory)
  const path = join(directory, 'broken-hdr.jpg')
  await writeFile(path, readGainJpeg(image.bytes).primary)
  await importPhotos(luma.app, luma.page, [path])
  await luma.page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('hdr')
  const details = luma.page.getByLabel('Display details', { exact: true })
  await expect(details).toContainText('SDR fallback')
  await details.click()
  await expect(luma.page.getByText(/HDR gain map unavailable; displaying SDR:/)).toBeVisible()
})

test('an unavailable HDR renderer uses the authored SDR primary and a fresh capability probe recovers HDR', async ({
  luma,
}, info) => {
  const directory = info.outputPath('fallback')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory),
    { page, app } = luma
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext
    Object.assign(window, { blockHdrJpegContext: true })
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (
        type === 'webgpu' &&
        this.dataset.testid === 'main-preview' &&
        Reflect.get(window, 'blockHdrJpegContext')
      )
        return null
      return Reflect.apply(original, this, [type, ...args])
    } as typeof original
  })
  await importPhotos(app, page, [image.path], false)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'canvas2d')
  const box = await canvas.boundingBox(),
    nativeWindow = await app.browserWindow(page)
  await expect
    .poll(async () =>
      nativeWindow.evaluate(async (window, rect) => {
        const image = await window.capturePage(
          {
            x: Math.round(rect!.x + rect!.width / 2),
            y: Math.round(rect!.y + rect!.height / 2),
            width: 1,
            height: 1,
          },
          { stayHidden: true },
        )
        return Math.abs(image.toBitmap()[0] - 170)
      }, box),
    )
    .toBeLessThanOrEqual(4)
  await page.evaluate(() => {
    Reflect.set(window, 'blockHdrJpegContext', false)
  })
  await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('hdr')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
})
