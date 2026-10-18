import type { ElectronApplication, Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { HDR_PRESENTATION_BUDGET } from '../src/renderer/src/preview/hdr-memory'
import { HDR_PRESENTATION_CACHE_BUDGET } from '../src/renderer/src/preview/hdr-presentation-cache'

test.use({ hdrDisplay: true })
const foreground = foregroundTest(
  'Exact HDR snapshot restoration requires a native compositor capture and post-paint observation.',
)

async function setup(app: ElectronApplication, page: Page) {
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await importPhotos(
    app,
    page,
    ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/sony-zv1.ARW'],
    false,
  )
  await page.getByLabel('Preview display mode').selectOption('sdr')
  await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
  const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
  await exposure.fill('1')
  await exposure.press('Enter')
  await expect(canvas).toHaveAttribute('data-exposure', '1')
  await expect(canvas).toHaveAttribute('data-gesturing', 'false')
  await expect(canvas).toHaveAttribute('data-presentation-cache-eligible', 'true')
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
      ),
    )
    .toBe(true)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  return {
    nativeWindow,
    raw: photos.find((photo) => photo.filename === 'sony-zv1.ARW')!,
    raster: photos.find((photo) => photo.filename === 'alpine-lake.jpg')!,
  }
}

async function selectRaster(page: Page) {
  await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
  await expect(page.getByTestId('main-preview')).toHaveAttribute('aria-label', 'alpine-lake.jpg')
  await expect(page.getByTestId('main-preview')).toBeVisible()
}

/** Hold the production upload-worker message, preserving its real validation and stream after release. */
async function holdUploads(page: Page) {
  return page.evaluateHandle(() => {
    const original = Worker.prototype.postMessage as (
      this: Worker,
      message: unknown,
      options?: StructuredSerializeOptions | Transferable[],
    ) => void
    const pending: {
      worker: Worker
      message: unknown
      options?: StructuredSerializeOptions | Transferable[]
    }[] = []
    let holding = true,
      held = 0
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: StructuredSerializeOptions | Transferable[],
    ) {
      const value = message as { asset?: { kind?: string } } | null
      if (holding && value?.asset?.kind === 'hdr-working-v1' && Object.keys(value).length === 1) {
        held++
        pending.push({ worker: this, message, options })
      } else original.call(this, message, options)
    }
    const release = () => {
      holding = false
      for (const item of pending.splice(0)) original.call(item.worker, item.message, item.options)
    }
    return {
      get held() {
        return held
      },
      release,
      close: () => {
        release()
        Worker.prototype.postMessage = original
      },
    }
  })
}

async function holdEdits(app: ElectronApplication, photoId: string) {
  return app.evaluateHandle(({ ipcMain }, photoId) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('edits:get')!
    let release!: () => void,
      calls = 0
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('edits:get')
    ipcMain.handle('edits:get', async (...args) => {
      if (args[1] === photoId) {
        calls++
        await pending
      }
      return original(...args)
    })
    return {
      get calls() {
        return calls
      },
      release,
      close: () => {
        release()
        ipcMain.removeHandler('edits:get')
        ipcMain.handle('edits:get', original)
      },
    }
  }, photoId)
}

async function capture(app: ElectronApplication, page: Page) {
  const bounds = await page.getByTestId('main-preview').boundingBox()
  if (!bounds) throw new Error('The photo canvas has no compositor bounds.')
  const nativeWindow = await app.browserWindow(page)
  return nativeWindow.evaluate(async (window, bounds) => {
    const image = await window.capturePage(
      {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      { stayHidden: true },
    )
    return {
      size: image.getSize(),
      png: image.toPNG().toString('base64'),
      pixels: Array.from(image.resize({ width: 96, height: 64 }).toBitmap()) as number[],
    }
  }, bounds)
}

test(
  'a warm exact edited HDR frame is visibly restored before native upload without enabling unfinished editing',
  foreground,
  async ({ luma }, info) => {
    test.skip(
      process.env.VITE_LUMA_HDR_PRESENTATION_CACHE !== '1',
      'Build with VITE_LUMA_HDR_PRESENTATION_CACHE=1 for this isolated candidate.',
    )
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw } = await setup(app, page)
    const before = await capture(app, page)
    const edits = await page.evaluate((id) => window.luma.getEdits(id), raw.id)
    const source = await page
      .getByTestId('main-preview')
      .getAttribute('data-requested-source-identity')
    await selectRaster(page)
    const gate = await holdUploads(page)
    try {
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('data-presentation-cache', 'hit', { timeout: 10000 })
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'true')
      await expect(canvas).toBeVisible()
      await expect(page.getByText('Loading preview…', { exact: true })).toHaveCount(0)
      await expect(page.getByTestId('preview-viewport')).toHaveAttribute(
        'data-resolution',
        'cached-exact',
      )
      await expect(page.getByLabel('Preview zoom')).toBeDisabled()
      await expect(canvas).not.toHaveAttribute('data-editing', 'ready')
      await expect.poll(() => gate.evaluate((value) => value.held)).toBe(1)
      expect(await canvas.getAttribute('data-cached-source-identity')).toBe(source)
      expect(await canvas.getAttribute('data-cached-settings-revision')).toBe(
        String(edits.revision),
      )
      expect(JSON.parse((await canvas.getAttribute('data-cached-parameters'))!).exposureEv).toBe(1)
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.luma.getPreviewDiagnostics())).presentation?.timings
              .firstUsefulMs,
        )
        .toBeGreaterThan(0)
      const diagnostics = await page.evaluate(() => window.luma.getPreviewDiagnostics())
      expect(diagnostics.presentation).toMatchObject({ photoId: raw.id, stage: 'loading' })
      expect(diagnostics.presentation!.timings.firstUsefulMs).toBeGreaterThan(0)
      expect(diagnostics.presentation!.timings.nativeEditingReadyMs).toBeUndefined()
      const restored = await capture(app, page)
      expect(restored.size).toEqual(before.size)
      expect(restored.pixels).toEqual(before.pixels)
      expect(restored.pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true)
      expect(
        Number(await canvas.getAttribute('data-retained-presentation-bytes')),
      ).toBeLessThanOrEqual(HDR_PRESENTATION_CACHE_BUDGET)
      await writeFile(info.outputPath('native-edited.png'), Buffer.from(before.png, 'base64'))
      await writeFile(info.outputPath('restored-edited.png'), Buffer.from(restored.png, 'base64'))
      await writeFile(
        info.outputPath('exact-restoration.json'),
        JSON.stringify(
          { source, revision: edits.revision, diagnostics, compositorPixelsEqual: true },
          null,
          2,
        ),
      )
      await gate.evaluate((value) => value.release())
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-quality', 'normal')
      await expect(canvas).toHaveAttribute('data-exposure', '1')
      await expect(page.getByLabel('Preview zoom')).toBeEnabled()
      expect(Number(await canvas.getAttribute('data-allocated-bytes'))).toBeLessThanOrEqual(
        HDR_PRESENTATION_BUDGET,
      )
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.luma.getPreviewDiagnostics())).presentation?.timings
              .nativeEditingReadyMs,
        )
        .toBeGreaterThan(0)
    } finally {
      await gate.evaluate((value) => value.close())
      await gate.dispose()
    }
  },
)

test(
  'an unconfirmed edit revision cannot flash a cached or neutral frame, and committed or target changes miss exact reuse',
  foreground,
  async ({ luma }) => {
    test.skip(
      process.env.VITE_LUMA_HDR_PRESENTATION_CACHE !== '1',
      'Build with VITE_LUMA_HDR_PRESENTATION_CACHE=1 for this isolated candidate.',
    )
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw } = await setup(app, page)
    await selectRaster(page)
    const upload = await holdUploads(page),
      edits = await holdEdits(app, raw.id)
    try {
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await expect.poll(() => edits.evaluate((value) => value.calls)).toBeGreaterThan(0)
      await expect.poll(() => upload.evaluate((value) => value.held)).toBe(1)
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).not.toBeVisible()
      await expect(canvas).not.toHaveAttribute('data-presentation-cache', 'hit')
      await expect(page.getByText('Loading preview…', { exact: true })).toBeVisible()
      await edits.evaluate((value) => value.release())
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'true', { timeout: 10000 })
      await expect(canvas).toBeVisible()
      expect(JSON.parse((await canvas.getAttribute('data-cached-parameters'))!).exposureEv).toBe(1)
      await upload.evaluate((value) => value.release())
      await expect(canvas).toHaveAttribute('data-presentation-cache-eligible', 'true', {
        timeout: 60000,
      })
      await selectRaster(page)
      const previous = await page.evaluate((id) => window.luma.getEdits(id), raw.id)
      await page.evaluate(
        ({ id, revision }) => window.luma.updateEdits(id, { exposureEv: 2 }, revision),
        { id: raw.id, revision: previous.revision },
      )
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await expect(canvas).toHaveAttribute('data-presentation-cache', 'miss')
      await expect(canvas).toHaveAttribute('data-exposure', '2', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-presentation-cache-eligible', 'true')
      await selectRaster(page)
      await page.getByLabel('Preview display mode').selectOption('auto')
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await expect(canvas).toHaveAttribute('data-presentation-cache', 'miss')
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      expect(await canvas.getAttribute('data-cached-display-ready')).toBe('false')
      expect(Number(await canvas.getAttribute('data-allocated-bytes'))).toBeLessThanOrEqual(
        HDR_PRESENTATION_BUDGET,
      )
    } finally {
      await edits.evaluate((value) => value.close())
      await edits.dispose()
      await upload.evaluate((value) => value.close())
      await upload.dispose()
    }
  },
)

test(
  'suspension requires a fresh edit confirmation after external changes and device loss retires previous-device surfaces',
  foreground,
  async ({ luma }) => {
    test.skip(
      process.env.VITE_LUMA_HDR_PRESENTATION_CACHE !== '1',
      'Build with VITE_LUMA_HDR_PRESENTATION_CACHE=1 for this isolated candidate.',
    )
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw } = await setup(app, page)
    await selectRaster(page)
    const gate = await holdUploads(page)
    let resumedUpload: Awaited<ReturnType<typeof holdUploads>> | undefined,
      resumedEdits: Awaited<ReturnType<typeof holdEdits>> | undefined
    try {
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'true', { timeout: 10000 })
      await expect.poll(() => gate.evaluate((value) => value.held)).toBe(1)
      const workspaces = page.getByRole('navigation', { name: 'Workspaces' })
      await workspaces.getByRole('button', { name: 'Library', exact: true }).click()
      await expect(canvas).toHaveAttribute('data-suspended', 'true')
      await expect(canvas).not.toBeVisible()
      await gate.evaluate((value) => value.close())
      const suspendedEdits = await page.evaluate((id) => window.luma.getEdits(id), raw.id)
      await page.evaluate(
        ({ id, revision }) => window.luma.updateEdits(id, { exposureEv: 2 }, revision),
        { id: raw.id, revision: suspendedEdits.revision },
      )
      resumedUpload = await holdUploads(page)
      resumedEdits = await holdEdits(app, raw.id)
      await workspaces.getByRole('button', { name: 'Editor', exact: true }).click()
      await expect.poll(() => resumedEdits!.evaluate((value) => value.calls)).toBeGreaterThan(0)
      await expect.poll(() => resumedUpload!.evaluate((value) => value.held)).toBe(1)
      await expect(canvas).not.toBeVisible()
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'false')
      await expect(canvas).not.toHaveAttribute('data-presentation-cache', 'hit')
      await expect(page.getByText('Loading preview…', { exact: true })).toBeVisible()
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.luma.getPreviewDiagnostics())).presentation?.stage,
        )
        .toBe('loading')
      expect(
        (await page.evaluate(() => window.luma.getPreviewDiagnostics())).presentation?.timings
          .firstUsefulMs,
      ).toBeUndefined()
      await resumedEdits.evaluate((value) => value.release())
      await expect(canvas).toHaveAttribute('data-presentation-cache', 'miss')
      await expect(canvas).not.toBeVisible()
      await resumedUpload.evaluate((value) => value.release())
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-quality', 'normal')
      await expect(canvas).toHaveAttribute('data-exposure', '2')
      const device = await canvas.evaluateHandle(
        (element: HTMLCanvasElement) => element.getContext('webgpu')!.getConfiguration()!.device,
      )
      await selectRaster(page)
      await device.evaluate((value) => value.destroy())
      await device.dispose()
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await expect(canvas).toHaveAttribute('data-presentation-cache', 'miss', { timeout: 10000 })
      await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      expect(await canvas.getAttribute('data-cached-display-ready')).toBe('false')
      expect(Number(await canvas.getAttribute('data-retained-presentation-bytes'))).toBe(0)
      expect(Number(await canvas.getAttribute('data-allocated-bytes'))).toBeLessThanOrEqual(
        HDR_PRESENTATION_BUDGET,
      )
    } finally {
      await resumedEdits?.evaluate((value) => value.close())
      await resumedEdits?.dispose()
      await resumedUpload?.evaluate((value) => value.close())
      await resumedUpload?.dispose()
      await gate.evaluate((value) => value.close())
      await gate.dispose()
    }
  },
)
