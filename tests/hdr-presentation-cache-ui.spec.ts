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

async function holdReply(
  app: ElectronApplication,
  channel: 'preview:hdr' | 'edits:undo',
  photoId: string,
) {
  return app.evaluateHandle(
    ({ ipcMain }, { channel, photoId }) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers
      const original = handlers.get(channel)!,
        cached = handlers.get('preview:cached')!
      let release!: () => void,
        held = 0,
        replies = 0,
        fallbackCalls = 0
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const result = await original(...args)
        if (args[1] === photoId) {
          if (channel === 'preview:hdr' && (result as { preview?: unknown }).preview !== null)
            throw new Error('The raster HDR handler did not return its real null result.')
          held++
          await pending
          replies++
        }
        return result
      })
      ipcMain.removeHandler('preview:cached')
      ipcMain.handle('preview:cached', (...args) => {
        if (args[1] === photoId) fallbackCalls++
        return cached(...args)
      })
      return {
        get held() {
          return held
        },
        get replies() {
          return replies
        },
        get fallbackCalls() {
          return fallbackCalls
        },
        release,
        close: () => {
          release()
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, original)
          ipcMain.removeHandler('preview:cached')
          ipcMain.handle('preview:cached', cached)
        },
      }
    },
    { channel, photoId },
  )
}

/** Sample after completed animation frames and a subsequent task, allowing IPC replies to arrive. */
async function observePaints(page: Page, count = 8) {
  return page.evaluate(async (count) => {
    const samples = []
    for (let index = 0; index < count; index++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
        style = getComputedStyle(canvas),
        diagnostics = await window.luma.getPreviewDiagnostics()
      samples.push({
        visible:
          canvas.getClientRects().length > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none',
        label: canvas.getAttribute('aria-label'),
        editing: canvas.dataset.editing,
        exposure: canvas.dataset.exposure,
        cache: canvas.dataset.presentationCache,
        cachedReady: canvas.dataset.cachedDisplayReady,
        sourceUploads: Number(canvas.dataset.sourceUploads ?? 0),
        uploadMs: Number(canvas.dataset.uploadMs ?? 0),
        inspectorExposure: document.querySelector<HTMLInputElement>('[aria-label="Exposure value"]')
          ?.value,
        diagnostics,
      })
    }
    return samples
  }, count)
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

for (const resume of [false, true])
  test(
    `${resume ? 'same-photo Library resume' : 'a newly selected photo'} stays neutral when real native upload finishes before edit confirmation`,
    foreground,
    async ({ luma }, info) => {
      test.skip(
        process.env.VITE_LUMA_HDR_PRESENTATION_CACHE !== '1',
        'Build with VITE_LUMA_HDR_PRESENTATION_CACHE=1 for this isolated candidate.',
      )
      test.setTimeout(120000)
      const { app, page } = luma
      const { raw } = await setup(app, page)
      const expected = await capture(app, page),
        expectedSource = await page
          .getByTestId('main-preview')
          .getAttribute('data-presented-source-identity'),
        workspaces = page.getByRole('navigation', { name: 'Workspaces' })
      expect(expectedSource).toBeTruthy()
      if (resume) {
        await workspaces.getByRole('button', { name: 'Library', exact: true }).click()
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'true')
      } else await selectRaster(page)
      const upload = await holdUploads(page),
        edits = await holdEdits(app, raw.id)
      try {
        if (resume) await workspaces.getByRole('button', { name: 'Editor', exact: true }).click()
        else await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
        await expect.poll(() => edits.evaluate((value) => value.calls)).toBeGreaterThan(0)
        await expect.poll(() => upload.evaluate((value) => value.held)).toBe(1)
        await upload.evaluate((value) => value.release())
        const canvas = page.getByTestId('main-preview')
        await expect(canvas).toHaveAttribute('data-source-uploads', '1', { timeout: 60000 })
        await expect
          .poll(async () => Number(await canvas.getAttribute('data-upload-ms')))
          .toBeGreaterThan(0)
        await expect(canvas).not.toBeVisible()
        await expect(page.getByTestId('retained-preview')).not.toBeVisible()
        await expect(page.getByText('Loading preview…', { exact: true })).toBeVisible()
        const unconfirmed = await observePaints(page)
        await writeFile(
          info.outputPath('upload-before-confirmation.json'),
          JSON.stringify(unconfirmed, null, 2),
        )
        for (const sample of unconfirmed) {
          expect(sample.visible).toBe(false)
          expect(sample.editing).not.toBe('ready')
          expect(sample.cache).not.toBe('hit')
          expect(sample.cachedReady).toBe('false')
          expect(sample.sourceUploads).toBe(1)
          expect(sample.uploadMs).toBeGreaterThan(0)
          expect(sample.diagnostics.presentation?.timings.firstUsefulMs).toBeUndefined()
          expect(sample.diagnostics.presentation?.timings.nativeEditingReadyMs).toBeUndefined()
        }
        const neutral = await capture(app, page)
        expect(neutral.pixels).not.toEqual(expected.pixels)
        const firstVisible = page
          .evaluate(async () => {
            for (let frame = 0; frame < 600; frame++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              const canvas = document.querySelector<HTMLCanvasElement>(
                  '[data-testid="main-preview"]',
                )!,
                style = getComputedStyle(canvas)
              if (canvas.getClientRects().length && style.visibility === 'visible')
                return {
                  exposure:
                    Number(canvas.dataset.cachedFencedAt) > 0
                      ? (JSON.parse(canvas.dataset.cachedParameters!).exposureEv as number)
                      : Number(canvas.dataset.exposure),
                  label: canvas.getAttribute('aria-label'),
                  source:
                    Number(canvas.dataset.cachedFencedAt) > 0
                      ? canvas.dataset.cachedSourceIdentity
                      : canvas.dataset.presentedSourceIdentity,
                }
            }
            throw new Error('No confirmed photo reached an animation-frame observation.')
          })
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error: String(error) }),
          )
        await edits.evaluate((value) => value.release())
        const first = await firstVisible
        await writeFile(info.outputPath('first-visible.json'), JSON.stringify(first, null, 2))
        expect(first).toEqual({
          value: { exposure: 1, label: 'sony-zv1.ARW', source: expectedSource },
        })
        await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
        await expect(canvas).toHaveAttribute('data-quality', 'normal')
        await expect(canvas).toHaveAttribute('data-exposure', '1')
        await expect(canvas).toBeVisible()
        const confirmed = await capture(app, page)
        expect(confirmed.size).toEqual(expected.size)
        expect(confirmed.pixels).toEqual(expected.pixels)
        await writeFile(
          info.outputPath('confirmed-native.png'),
          Buffer.from(confirmed.png, 'base64'),
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
  'a late real null HDR response cannot start legacy fallback after a different RAW is presented',
  foreground,
  async ({ luma }, info) => {
    test.skip(
      process.env.VITE_LUMA_HDR_PRESENTATION_CACHE !== '1',
      'Build with VITE_LUMA_HDR_PRESENTATION_CACHE=1 for this isolated candidate.',
    )
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw, raster } = await setup(app, page),
      gate = await holdReply(app, 'preview:hdr', raster.id)
    try {
      await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
      await expect.poll(() => gate.evaluate((value) => value.held)).toBe(1)
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-quality', 'normal')
      await expect(canvas).toHaveAttribute('data-exposure', '1')
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.luma.getPreviewDiagnostics())).presentation?.stage,
        )
        .toBe('presented')
      const before = await capture(app, page),
        diagnostics = await page.evaluate(() => window.luma.getPreviewDiagnostics())
      expect(diagnostics).toMatchObject({
        photoId: raw.id,
        loadingStage: 'prepared',
        presentation: { photoId: raw.id, stage: 'presented' },
      })
      expect(await gate.evaluate((value) => value.fallbackCalls)).toBe(0)
      await gate.evaluate((value) => value.release())
      await expect.poll(() => gate.evaluate((value) => value.replies)).toBe(1)
      const observations = await observePaints(page)
      for (const sample of observations) {
        expect(sample.visible).toBe(true)
        expect(sample.label).toBe('sony-zv1.ARW')
        expect(sample.editing).toBe('ready')
        expect(sample.exposure).toBe('1')
        expect(sample.diagnostics.photoId).toBe(diagnostics.photoId)
        expect(sample.diagnostics.renderingIdentity).toBe(diagnostics.renderingIdentity)
        expect(sample.diagnostics.revision).toBe(diagnostics.revision)
        expect(sample.diagnostics.loadingStage).toBe(diagnostics.loadingStage)
        expect(sample.diagnostics.presentation).toEqual(diagnostics.presentation)
      }
      expect(await gate.evaluate((value) => value.fallbackCalls)).toBe(0)
      expect((await capture(app, page)).pixels).toEqual(before.pixels)
      await writeFile(
        info.outputPath('stale-null-hdr-observations.json'),
        JSON.stringify(observations, null, 2),
      )
    } finally {
      await gate.evaluate((value) => value.close())
      await gate.dispose()
    }
  },
)

async function settledRaster(page: Page, photoId: string, wait = true) {
  if (wait) {
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-backend', 'webgl2', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await expect(canvas).toHaveAttribute('data-exposure', '2')
    await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue('2.00')
    const committed = await page.evaluate((id) => window.luma.getEdits(id), photoId)
    await expect
      .poll(() => page.evaluate(() => window.luma.getPreviewDiagnostics()))
      .toMatchObject({
        photoId,
        revision: committed.revision,
        renderingIdentity: expect.any(String),
        presentation: { photoId, revision: committed.revision, stage: 'presented' },
      })
    await observePaints(page, 2)
  }
  return page.evaluate(async (photoId) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
      viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!,
      bounds = canvas.getBoundingClientRect(),
      [diagnostics, edits] = await Promise.all([
        window.luma.getPreviewDiagnostics(),
        window.luma.getEdits(photoId),
      ])
    return {
      native: {
        label: canvas.getAttribute('aria-label'),
        backend: canvas.dataset.backend,
        editing: canvas.dataset.editing,
        exposure: canvas.dataset.exposure,
        source: canvas.dataset.src,
        renderingIdentity: diagnostics.renderingIdentity,
        revision: diagnostics.revision,
        width: canvas.width,
        height: canvas.height,
        imageWidth: Number(viewport.dataset.imageWidth),
        imageHeight: Number(viewport.dataset.imageHeight),
        mode: viewport.dataset.mode,
        scale: Number(viewport.dataset.scale),
        panX: Number(viewport.dataset.panX),
        panY: Number(viewport.dataset.panY),
        dpr: window.devicePixelRatio,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      },
      inspector: document.querySelector<HTMLInputElement>('[aria-label="Exposure value"]')?.value,
      diagnostics,
      edits,
    }
  }, photoId)
}

test(
  'a completed Undo reply for the previous photo cannot replace current Inspector or visible pixels',
  foreground,
  async ({ luma }, info) => {
    test.skip(
      process.env.VITE_LUMA_HDR_PRESENTATION_CACHE !== '1',
      'Build with VITE_LUMA_HDR_PRESENTATION_CACHE=1 for this isolated candidate.',
    )
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw, raster } = await setup(app, page)
    await selectRaster(page)
    const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
    await exposure.fill('2')
    await exposure.press('Enter')
    await expect
      .poll(() => page.evaluate((id) => window.luma.getEdits(id), raster.id))
      .toMatchObject({ settings: { exposureEv: 2 } })
    // Establish the complete Float32/WebGL raster path independently of the later Undo.
    const referenceState = await settledRaster(page, raster.id),
      reference = await capture(app, page)
    await writeFile(
      info.outputPath('undo-reference-native.png'),
      Buffer.from(reference.png, 'base64'),
    )
    await writeFile(
      info.outputPath('undo-reference-state.json'),
      JSON.stringify(referenceState, null, 2),
    )
    const observeRaster = async () => {
      const samples = []
      for (let index = 0; index < 8; index++) {
        const [paint] = await observePaints(page, 1)
        samples.push({ paint, state: await settledRaster(page, raster.id, false) })
      }
      return samples
    }
    const controlObservations = await observeRaster(),
      controlState = await settledRaster(page, raster.id, false),
      control = await capture(app, page)
    await writeFile(info.outputPath('undo-control-native.png'), Buffer.from(control.png, 'base64'))
    await writeFile(
      info.outputPath('undo-control-state.json'),
      JSON.stringify({ controlState, controlObservations }, null, 2),
    )
    expect(referenceState.native).toMatchObject({
      label: 'alpine-lake.jpg',
      backend: 'webgl2',
      editing: 'ready',
      exposure: '2',
      imageWidth: 1920,
      imageHeight: 1280,
      mode: 'fit',
      panX: 0,
      panY: 0,
    })
    expect(referenceState.native.source).toContain(`luma-photo://library/${raster.id}/full/`)
    expect(referenceState.native.width).toBeGreaterThan(0)
    expect(referenceState.native.height).toBeGreaterThan(0)
    expect(referenceState.native.scale).toBeGreaterThan(0)
    expect(referenceState.edits.settings.exposureEv).toBe(2)
    expect(controlState.native).toEqual(referenceState.native)
    expect(controlState.edits).toEqual(referenceState.edits)
    expect(control.size).toEqual(reference.size)
    expect(control.pixels).toEqual(reference.pixels)
    expect(control.png).toBe(reference.png)
    const assertCurrentRaster = (sample: (typeof controlObservations)[number]) => {
      expect(sample.paint.visible).toBe(true)
      expect(sample.paint.label).toBe('alpine-lake.jpg')
      expect(sample.paint.inspectorExposure).toBe('2.00')
      expect(sample.state.native).toEqual(referenceState.native)
      expect(sample.state.inspector).toBe('2.00')
      expect(sample.state.edits).toEqual(referenceState.edits)
      expect(sample.paint.diagnostics.presentation).toMatchObject({
        photoId: raster.id,
        revision: referenceState.edits.revision,
        stage: 'presented',
      })
      expect(sample.state.diagnostics.presentation).toMatchObject({
        photoId: raster.id,
        revision: referenceState.edits.revision,
        stage: 'presented',
      })
    }
    for (const sample of controlObservations) assertCurrentRaster(sample)
    await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
    await expect(exposure).toHaveValue('1.00')
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
      timeout: 60000,
    })
    const undo = await holdReply(app, 'edits:undo', raw.id)
    try {
      await page.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect.poll(() => undo.evaluate((value) => value.held)).toBe(1)
      await selectRaster(page)
      const beforeState = await settledRaster(page, raster.id),
        before = await capture(app, page)
      await writeFile(info.outputPath('undo-held-native.png'), Buffer.from(before.png, 'base64'))
      await writeFile(info.outputPath('undo-held-state.json'), JSON.stringify(beforeState, null, 2))
      expect(beforeState.native).toEqual(referenceState.native)
      expect(beforeState.edits).toEqual(referenceState.edits)
      expect(beforeState.inspector).toBe('2.00')
      expect(before.size).toEqual(reference.size)
      expect(before.pixels).toEqual(reference.pixels)
      expect(before.png).toBe(reference.png)
      await undo.evaluate((value) => value.release())
      await expect.poll(() => undo.evaluate((value) => value.replies)).toBe(1)
      const observations = await observeRaster(),
        afterState = await settledRaster(page, raster.id, false),
        after = await capture(app, page)
      await writeFile(info.outputPath('undo-released-native.png'), Buffer.from(after.png, 'base64'))
      await writeFile(
        info.outputPath('stale-undo-observations.json'),
        JSON.stringify({ afterState, observations }, null, 2),
      )
      for (const sample of observations) assertCurrentRaster(sample)
      expect(afterState.native).toEqual(referenceState.native)
      expect(afterState.edits).toEqual(referenceState.edits)
      expect(afterState.inspector).toBe('2.00')
      expect(after.size).toEqual(reference.size)
      expect(after.pixels).toEqual(reference.pixels)
      expect(after.png).toBe(reference.png)
      await expect(exposure).toHaveValue('2.00')
      await expect(exposure).toBeEnabled()
    } finally {
      await undo.evaluate((value) => value.close())
      await undo.dispose()
    }
  },
)
