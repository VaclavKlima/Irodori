import sharp from 'sharp'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('WebGL pixel inspection agrees with CPU exposure and falls back after context loss', async ({
  luma,
}, info) => {
  const source = info.outputPath('pixels.png')
  await sharp(
    Buffer.from([128, 64, 32, 255, 255, 180, 100, 255, 20, 70, 140, 255, 255, 255, 255, 255]),
    { raw: { width: 2, height: 2, channels: 4 } },
  )
    .png()
    .toFile(source)
  const { page } = luma
  await importPhotos(luma.app, page, [source])
  const preview = page.getByTestId('main-preview')
  await expect(preview).toHaveAttribute('data-editing', 'ready')
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  await page.evaluate((id) => window.luma.updateEdits(id, { exposureEv: -1 }, 0), id)
  await expect(preview).toHaveAttribute('data-exposure', '-1')
  for (const scale of [1, 8, 16, 32]) {
    await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption(String(scale))
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-scale', String(scale))
    // React updates the geometry before the next animation frame presents it.
    await expect
      .poll(async () => {
        const sample = await preview.evaluate((element, scale) => {
          const canvas = element as HTMLCanvasElement
          const gl = canvas.getContext('webgl2')!
          const result = new Uint8Array(4)
          gl.readPixels(
            Math.floor(canvas.width / 2 - (scale * devicePixelRatio) / 2),
            Math.floor(canvas.height / 2 + (scale * devicePixelRatio) / 2),
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            result,
          )
          return [...result]
        }, scale)
        if (sample[3] !== 255) return Infinity
        return Math.max(...[92, 44, 20].map((value, index) => Math.abs(sample[index] - value)))
      })
      .toBeLessThanOrEqual(1)
  }
  await preview.evaluate((element) =>
    (element as HTMLCanvasElement)
      .getContext('webgl2')!
      .getExtension('WEBGL_lose_context')!
      .loseContext(),
  )
  await expect(preview).toHaveAttribute('data-backend', 'canvas2d')
  await expect(preview).toHaveAttribute('data-editing', 'ready')
  await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('16')
  await expect
    .poll(() =>
      preview.evaluate((element) => {
        const canvas = element as HTMLCanvasElement
        return [
          ...canvas
            .getContext('2d')!
            .getImageData(
              Math.floor(canvas.width / 2 - 8 * devicePixelRatio),
              Math.floor(canvas.height / 2 - 8 * devicePixelRatio),
              1,
              1,
            ).data,
        ]
      }),
    )
    .toEqual([92, 44, 20, 255])
  await page.getByRole('spinbutton', { name: 'Exposure value' }).fill('1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).press('Enter')
  await expect
    .poll(() =>
      preview.evaluate((element) => {
        const canvas = element as HTMLCanvasElement
        return canvas
          .getContext('2d')!
          .getImageData(
            Math.floor(canvas.width / 2 - 8 * devicePixelRatio),
            Math.floor(canvas.height / 2 - 8 * devicePixelRatio),
            1,
            1,
          ).data[0]
      }),
    )
    .toBe(176)
})

test('pixel grid follows fractional pan at multiple display scale factors', async ({
  luma,
}, info) => {
  const source = info.outputPath('grid.png')
  await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ffffff' } })
    .png()
    .toFile(source)
  const { page, app } = luma
  await importPhotos(app, page, [source])
  const preview = page.getByTestId('main-preview')
  await expect(preview).toHaveAttribute('data-editing', 'ready')
  const nativeDpr = await page.evaluate(() => devicePixelRatio)
  for (const factor of [1, 1.5, 2]) {
    await app.evaluate(
      ({ BrowserWindow }, factor) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor),
      factor,
    )
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(nativeDpr * factor)
    await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('16')
    const box = (await page.getByTestId('preview-viewport').boundingBox())!
    await page.mouse.move(box.x + box.width / 2 + 13, box.y + box.height / 2 + 7)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -35)
    await page.keyboard.up('Control')
    await expect
      .poll(() => page.getByTestId('preview-viewport').getAttribute('data-scale'))
      .not.toBe('16')
    await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('32')
    await expect(preview).toHaveAttribute('data-exposure', '0')
    const sampled = await preview.evaluate(async (element) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      const canvas = element as HTMLCanvasElement
      const viewport = canvas.parentElement!
      const scale = Number(viewport.dataset.scale),
        panX = Number(viewport.dataset.panX),
        panY = Number(viewport.dataset.panY)
      const box = viewport.getBoundingClientRect()
      const left = (box.width - 80 * scale) / 2 + panX,
        top = (box.height - 80 * scale) / 2 + panY
      const edge = left + Math.round((box.width / 2 - left) / scale) * scale
      const centerY = top + (Math.floor((box.height / 2 - top) / scale) + 0.5) * scale
      const gl = canvas.getContext('webgl2')!
      const pixel = (x: number) => {
        const data = new Uint8Array(4)
        gl.readPixels(
          Math.floor(x * devicePixelRatio),
          canvas.height - 1 - Math.floor(centerY * devicePixelRatio),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          data,
        )
        return data[0]
      }
      return {
        edge: pixel(edge),
        inside: pixel(edge + 3),
        panX,
        width: canvas.width,
        expectedWidth: Math.round(box.width * devicePixelRatio),
      }
    })
    expect(sampled.width).toBe(sampled.expectedWidth)
    expect(sampled.inside).toBe(255)
    expect(sampled.edge).toBeLessThan(252)
    expect(sampled.edge).toBeGreaterThan(220)
    expect(sampled.panX).not.toBe(Math.round(sampled.panX))
  }
})
