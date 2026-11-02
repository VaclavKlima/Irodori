import { openPreviewOptions } from './preview-options.helpers'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { readGainJpeg } from './export-reference'
import { activateButton } from './button.helpers'
import { managedOriginalHashes } from './professional-editing-acceptance.helpers'
import { destroyMainPreviewDevice } from './hdr-device-loss.helpers'

test.use({ hdrDisplay: true })
const hdrMonitor = {
  tag: '@foreground',
  annotation: {
    type: 'requires-foreground',
    description:
      'Authored HDR source selection requires an entered monitor with native HDR headroom; hidden Wayland windows select the authored SDR primary.',
  },
}
test(
  'HDR JPEG import presents HDR, preserves its SDR primary and survives restart and export',
  hdrMonitor,
  async ({ irodori }, info) => {
    const directory = info.outputPath('chart')
    await mkdir(directory)
    const image = await hdrJpegFixture(directory)
    const app = irodori.app
    let page = irodori.page
    await importPhotos(app, page, [image.path], false)
    const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal')
    const pixel = await page.evaluate(
      async (id) => window.irodori.getPhotoPixel(id, 0, 224, 32, { domain: 'content-hdr' }),
      id,
    )
    expect(pixel.rgb[0]).toBeCloseTo(4, 1)
    await expect(
      page.evaluate(
        async (id) =>
          window.irodori.getPhotoPixel(id, 0, 224, 32, { domain: 'output', target: 'sdr' }),
        id,
      ),
    ).rejects.toThrow('SDR output analysis')
    await openPreviewOptions(page)
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
    await openPreviewOptions(page)
    await page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('hdr')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
    const destination = join(irodori.userDataDir, 'exports')
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
    page = (await irodori.restart()).page
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
    expect(
      (await page.evaluate((id) => window.irodori.getEditHistory(id), id)).snapshots,
    ).toHaveLength(1)
  },
)

test('an invalid ISO gain map imports its preserved SDR primary with a counted fallback explanation', async ({
  irodori,
}, info) => {
  const directory = info.outputPath('invalid')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory)
  const path = join(directory, 'broken-hdr.jpg')
  await writeFile(path, readGainJpeg(image.bytes).primary)
  await importPhotos(irodori.app, irodori.page, [path])
  await openPreviewOptions(irodori.page)
  await irodori.page.getByRole('combobox', { name: 'Preview display mode' }).selectOption('hdr')
  const details = irodori.page.getByLabel('Display details', { exact: true })
  await expect(details).toContainText('SDR fallback')
  await openPreviewOptions(irodori.page)
  await expect(irodori.page.getByText(/HDR gain map unavailable; displaying SDR:/)).toBeVisible()
})

test(
  'an unavailable HDR renderer reports its GPU failure and retries without changing source, history or view',
  hdrMonitor,
  async ({ irodori }, info) => {
    const directory = info.outputPath('gpu-failure')
    await mkdir(directory)
    const image = await hdrJpegFixture(directory),
      { page, app } = irodori
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
    await importPhotos(app, page, [image.path], false, 'keyboard')
    const canvas = page.getByTestId('main-preview'),
      error = page.getByTestId('preview-gpu-error'),
      retry = page.getByRole('button', { name: 'Retry GPU', exact: true }),
      zoom = page.getByRole('combobox', { name: 'Preview zoom', exact: true }),
      display = page.getByRole('combobox', { name: 'Preview display mode', exact: true })
    await openPreviewOptions(page)
    await expect(page.getByText('GPU preview unavailable', { exact: true })).toBeVisible()
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(error).toContainText('HDR canvas unavailable')
    await expect(retry).toBeVisible()
    await expect(canvas).toBeHidden()
    await expect(canvas).not.toHaveAttribute('data-backend', /canvas2d/)
    await expect(canvas).not.toHaveAttribute('data-editing', 'ready')
    await expect(zoom).toBeDisabled()
    const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos,
      photo = photos[0],
      history = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id),
      originals = await managedOriginalHashes(irodori.userDataDir, [photo]),
      sourceUrl = await canvas.getAttribute('data-src'),
      requestId = await canvas.getAttribute('data-preview-request-id'),
      displayMode = await display.inputValue(),
      view = await page.getByTestId('preview-viewport').evaluate((element) => ({
        mode: element.dataset.mode,
        scale: element.dataset.scale,
        x: element.dataset.panX,
        y: element.dataset.panY,
      }))
    expect(sourceUrl).toBeTruthy()
    expect(requestId).toBeTruthy()
    await page.evaluate(() => {
      Reflect.set(window, 'blockHdrJpegContext', false)
    })
    await activateButton(retry)
    await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
    await expect(canvas).toHaveAttribute('data-quality', 'normal')
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await expect(canvas).toBeVisible()
    await expect(canvas).toBeFocused()
    await expect(error).toHaveCount(0)
    await expect(retry).toHaveCount(0)
    await expect(zoom).toBeEnabled()
    await expect(display).toHaveValue(displayMode)
    expect(await canvas.getAttribute('data-src')).toBe(sourceUrl)
    expect(await canvas.getAttribute('data-preview-request-id')).toBe(requestId)
    expect(
      await page.getByTestId('preview-viewport').evaluate((element) => ({
        mode: element.dataset.mode,
        scale: element.dataset.scale,
        x: element.dataset.panX,
        y: element.dataset.panY,
      })),
    ).toEqual(view)
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
      history,
    )
    expect(await managedOriginalHashes(irodori.userDataDir, [photo])).toEqual(originals)
    expect(await readFile(image.path)).toEqual(image.bytes)
  },
)

test(
  'native HDR JPEG device loss preserves its HDR source while the display is unavailable and Retry GPU reprobes the monitor',
  hdrMonitor,
  async ({ irodori }, info) => {
    test.setTimeout(120000)
    const directory = info.outputPath('native-hdr-device-loss')
    await mkdir(directory)
    const image = await hdrJpegFixture(directory),
      { app, page } = irodori,
      canvas = page.getByTestId('main-preview'),
      viewport = page.getByTestId('preview-viewport'),
      display = page.getByRole('combobox', { name: 'Preview display mode', exact: true }),
      zoom = page.getByRole('combobox', { name: 'Preview zoom', exact: true }),
      error = page.getByTestId('preview-gpu-error'),
      viewState = () =>
        viewport.evaluate((element) => ({
          mode: element.dataset.mode,
          scale: element.dataset.scale,
          x: element.dataset.panX,
          y: element.dataset.panY,
        }))
    let fault: Awaited<ReturnType<typeof destroyMainPreviewDevice>> | undefined
    try {
      await importPhotos(app, page, [image.path], false, 'keyboard')
      await openPreviewOptions(page)
      await display.selectOption('hdr')
      await expect
        .poll(() => page.evaluate(() => window.irodori.getDisplayState()))
        .toMatchObject({ mode: 'hdr', capabilities: { hardware: true, extended: true } })
      await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
      await expect(canvas).toHaveAttribute('data-editing', 'ready')
      const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0],
        initial = await page.evaluate((id) => window.irodori.getEdits(id), photo.id),
        edited = await page.evaluate(
          ({ id, revision }) => window.irodori.updateEdits(id, { exposureEv: 0.25 }, revision),
          { id: photo.id, revision: initial.revision },
        )
      await zoom.selectOption('1')
      await expect(canvas).toHaveAttribute('data-quality', 'normal')
      await expect(canvas).toHaveAttribute('data-exposure', '0.25')
      await expect(canvas).toHaveAttribute(
        'data-presented-settings-revision',
        String(edited.revision),
      )
      const before = await page.evaluate(() => window.irodori.getDisplayState()),
        history = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id),
        originals = await managedOriginalHashes(irodori.userDataDir, [photo]),
        view = await viewState(),
        sourceUrl = await canvas.getAttribute('data-src'),
        requestId = await canvas.getAttribute('data-preview-request-id'),
        sourceIdentity = await canvas.getAttribute('data-presented-source-identity')
      expect(before.mode).toBe('hdr')
      expect(before.headroom).toBeGreaterThan(1)
      expect(before.capabilities?.headroomStops).toBeGreaterThan(0)
      expect(sourceUrl).toBeTruthy()
      expect(requestId).toBeTruthy()
      expect(sourceIdentity).toBeTruthy()
      expect(history.settings.exposureEv).toBe(0.25)
      fault = await destroyMainPreviewDevice(page)
      expect(await fault.evaluate((control) => control.destroyed)).toBe(true)
      await expect
        .poll(() => page.evaluate(() => window.irodori.getDisplayState()))
        .toMatchObject({ requested: 'hdr', mode: 'sdr', capabilities: { hardware: false } })
      const lost = await page.evaluate(() => window.irodori.getDisplayState())
      expect(lost.generation).toBeGreaterThan(before.generation)
      expect(lost.capabilities?.headroomStops).toBeGreaterThan(0)
      for (let frame = 0; frame < 3; frame++) {
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        )
        await expect(error).toHaveAttribute('role', 'alert')
        await expect(error).toContainText('GPU preview unavailable')
        await expect(canvas).toBeHidden()
        await expect(page.getByTestId('retained-preview')).toBeHidden()
        await expect(page.getByTestId('clipping-overlay')).toBeHidden()
        await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
        await expect(canvas).not.toHaveAttribute('data-editing', 'ready')
        expect(await canvas.getAttribute('data-src')).toBe(sourceUrl)
        expect(await canvas.getAttribute('data-preview-request-id')).toBe(requestId)
      }
      await expect(zoom).toBeDisabled()
      await expect(display).toHaveValue('hdr')
      expect(await viewState()).toEqual(view)
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
        history,
      )
      expect(await managedOriginalHashes(irodori.userDataDir, [photo])).toEqual(originals)

      await fault.evaluate((control) => control.restore())
      expect(await page.evaluate(() => window.irodori.getDisplayState())).toMatchObject({
        mode: 'sdr',
        capabilities: { hardware: false },
      })
      await activateButton(page.getByRole('button', { name: 'Retry GPU', exact: true }))
      await expect
        .poll(() => page.evaluate(() => window.irodori.getDisplayState()))
        .toMatchObject({
          requested: 'hdr',
          mode: 'hdr',
          capabilities: { hardware: true, extended: true },
        })
      const recovered = await page.evaluate(() => window.irodori.getDisplayState())
      expect(recovered.generation).toBeGreaterThan(lost.generation)
      await expect(canvas).toBeVisible()
      await expect(canvas).toBeFocused()
      await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
      await expect(canvas).toHaveAttribute('data-quality', 'normal')
      await expect(canvas).toHaveAttribute('data-editing', 'ready')
      await expect(canvas).toHaveAttribute('data-exposure', '0.25')
      await expect(canvas).toHaveAttribute('data-target-generation', String(recovered.generation))
      await expect(canvas).toHaveAttribute(
        'data-presented-settings-revision',
        String(edited.revision),
      )
      await expect(canvas).toHaveAttribute('data-presented-source-identity', sourceIdentity!)
      await expect(error).toHaveCount(0)
      await expect(zoom).toBeEnabled()
      await expect(display).toHaveValue('hdr')
      expect(await canvas.getAttribute('data-src')).toBe(sourceUrl)
      expect(await canvas.getAttribute('data-preview-request-id')).toBe(requestId)
      expect(await viewState()).toEqual(view)
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
        history,
      )
      expect(await managedOriginalHashes(irodori.userDataDir, [photo])).toEqual(originals)
      expect(await readFile(image.path)).toEqual(image.bytes)
    } finally {
      await fault?.evaluate((control) => control.restore()).catch(() => undefined)
      await fault?.dispose()
    }
  },
)
