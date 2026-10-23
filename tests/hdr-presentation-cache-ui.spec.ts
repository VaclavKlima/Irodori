import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { requireEditorPreviewFeature } from './hdr-test-policy.helpers'
import { importPhotos } from './import.helpers'
import { assertHdrMemory, readHdrMemory } from './hdr-memory-policy.helpers'
import {
  NAVIGATION_MEASUREMENT_VERSION,
  observePhotoActivation,
} from './editor-navigation-responsiveness.helpers'
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
    [
      'tests/fixtures/photos/alpine-lake.jpg',
      'tests/fixtures/sony-zv1.ARW',
      'tests/fixtures/research-sony/originals/DSC03243.ARW',
      'tests/fixtures/research-sony/originals/DSC03244.ARW',
    ],
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

/** Exercise a real upload miss while retaining A's independent exact presentation. */
async function evictRawSource(page: Page) {
  for (const name of ['DSC03243.ARW', 'DSC03244.ARW']) {
    if (name === 'DSC03244.ARW')
      await page
        .getByRole('button', { name: 'Expand stack for DSC03243.ARW, 2 photos', exact: true })
        .click()
    await page.getByRole('button', { name: `Select ${name}`, exact: true }).click()
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
        ),
      )
      .toBe(true)
  }
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-source-cache-entries', '2')
  await selectRaster(page)
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
        sourceCache: canvas.dataset.sourceCache,
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
  // Queue/map completion and DOM readiness precede the compositor's next paint.
  // Give every baseline and comparison capture the same real rendering boundary.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
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

async function assertExactConfirmedCapture(
  app: ElectronApplication,
  page: Page,
  info: TestInfo,
  expected: Awaited<ReturnType<typeof capture>>,
  actual: Awaited<ReturnType<typeof capture>>,
) {
  const compare = (value: typeof actual) => {
    const expectedBytes = Buffer.from(expected.pixels),
      actualBytes = Buffer.from(value.pixels),
      firstDifferences: { index: number; expected: number | null; actual: number | null }[] = []
    let differentBytes = 0
    for (let index = 0; index < Math.max(expectedBytes.length, actualBytes.length); index++) {
      if (expectedBytes[index] === actualBytes[index]) continue
      differentBytes++
      if (firstDifferences.length < 16)
        firstDifferences.push({
          index,
          expected: expectedBytes[index] ?? null,
          actual: actualBytes[index] ?? null,
        })
    }
    return {
      equal: expectedBytes.equals(actualBytes),
      expectedSize: expected.size,
      actualSize: value.size,
      expectedBytes: expectedBytes.length,
      actualBytes: actualBytes.length,
      expectedSha256: createHash('sha256').update(expectedBytes).digest('hex'),
      actualSha256: createHash('sha256').update(actualBytes).digest('hex'),
      differentBytes,
      firstDifferences,
    }
  }
  const comparison = compare(actual)
  if (!comparison.equal) {
    const state = () =>
      page.evaluate(async () => {
        const inspect = (id: string) => {
          const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid="${id}"]`)
          if (!canvas) return null
          const style = getComputedStyle(canvas),
            context = canvas.dataset.backend === 'webgpu-hdr' ? canvas.getContext('webgpu') : null,
            configuration = context?.getConfiguration()
          return {
            connected: canvas.isConnected,
            label: canvas.getAttribute('aria-label'),
            width: canvas.width,
            height: canvas.height,
            bounds: canvas.getBoundingClientRect().toJSON(),
            visibility: style.visibility,
            display: style.display,
            opacity: style.opacity,
            dataset: { ...canvas.dataset },
            configuration: configuration
              ? {
                  format: configuration.format,
                  colorSpace: configuration.colorSpace,
                  alphaMode: configuration.alphaMode,
                  toneMapping: configuration.toneMapping,
                  adapter: {
                    vendor: configuration.device.adapterInfo.vendor,
                    architecture: configuration.device.adapterInfo.architecture,
                    device: configuration.device.adapterInfo.device,
                    description: configuration.device.adapterInfo.description,
                  },
                }
              : null,
          }
        }
        return {
          at: performance.now(),
          documentVisibility: document.visibilityState,
          focused: document.hasFocus(),
          main: inspect('main-preview'),
          retained: inspect('retained-preview'),
          diagnostics: await window.luma.getPreviewDiagnostics(),
        }
      })
    let afterFailedCapture: Awaited<ReturnType<typeof state>> | undefined,
      postPaintSamples: Awaited<ReturnType<typeof observePaints>> | undefined,
      afterPaintState: Awaited<ReturnType<typeof state>> | undefined,
      afterPaintComparison: ReturnType<typeof compare> | undefined,
      diagnosticError: string | undefined
    try {
      afterFailedCapture = await state()
      // Diagnose eventual paint only. This later image never substitutes for the failed witness.
      postPaintSamples = await observePaints(page, 1)
      const afterPaint = await capture(app, page)
      afterPaintState = await state()
      afterPaintComparison = compare(afterPaint)
      await writeFile(
        info.outputPath('confirmed-after-paint.png'),
        Buffer.from(afterPaint.png, 'base64'),
      )
    } catch (error) {
      diagnosticError = String(error)
    }
    await Promise.all([
      writeFile(info.outputPath('confirmed-expected.png'), Buffer.from(expected.png, 'base64')),
      writeFile(info.outputPath('confirmed-actual.png'), Buffer.from(actual.png, 'base64')),
      writeFile(
        info.outputPath('confirmed-capture-mismatch.json'),
        JSON.stringify(
          {
            assertionWitness: comparison,
            afterFailedCapture,
            postPaintSamples,
            afterPaintState,
            afterPaintComparison,
            diagnosticError,
          },
          null,
          2,
        ),
      ),
    ])
  }
  expect(comparison.equal, `Exact confirmed compositor bytes: ${JSON.stringify(comparison)}`).toBe(
    true,
  )
}

test(
  'a warm exact edited HDR frame is visibly restored before native upload without enabling unfinished editing',
  foreground,
  async ({ luma }, info) => {
    await requireEditorPreviewFeature(luma.page, 'presentation-cache')
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw } = await setup(app, page)
    const before = await capture(app, page)
    const edits = await page.evaluate((id) => window.luma.getEdits(id), raw.id)
    const source = await page
      .getByTestId('main-preview')
      .getAttribute('data-requested-source-identity')
    await evictRawSource(page)
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
      assertHdrMemory(await canvas.evaluate(readHdrMemory))
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
    await requireEditorPreviewFeature(luma.page, 'presentation-cache')
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw } = await setup(app, page)
    await evictRawSource(page)
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
      assertHdrMemory(await canvas.evaluate(readHdrMemory))
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
    await requireEditorPreviewFeature(luma.page, 'presentation-cache')
    test.setTimeout(120000)
    const { app, page } = luma
    const { raw } = await setup(app, page)
    await evictRawSource(page)
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
      assertHdrMemory(await canvas.evaluate(readHdrMemory))
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
    `${resume ? 'same-photo Library resume' : 'a newly selected photo'} stays neutral when native source preparation finishes before edit confirmation`,
    foreground,
    async ({ luma }, info) => {
      await requireEditorPreviewFeature(luma.page, 'presentation-cache')
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
      } else await evictRawSource(page)
      const upload = await holdUploads(page),
        edits = await holdEdits(app, raw.id)
      try {
        if (resume) await workspaces.getByRole('button', { name: 'Editor', exact: true }).click()
        else await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
        await expect.poll(() => edits.evaluate((value) => value.calls)).toBeGreaterThan(0)
        const canvas = page.getByTestId('main-preview')
        if (resume) {
          // Suspension retains the verified source, so this path must complete without an upload.
          await expect(canvas).toHaveAttribute('data-source-cache', 'hit')
          expect(await upload.evaluate((value) => value.held)).toBe(0)
        } else {
          await expect.poll(() => upload.evaluate((value) => value.held)).toBe(1)
          await upload.evaluate((value) => value.release())
        }
        await expect(canvas).toHaveAttribute('data-source-uploads', resume ? '0' : '1', {
          timeout: 60000,
        })
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
          expect(sample.sourceUploads).toBe(resume ? 0 : 1)
          expect(sample.sourceCache).toBe(resume ? 'hit' : 'miss-retained')
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
        await assertExactConfirmedCapture(app, page, info, expected, confirmed)
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
    await requireEditorPreviewFeature(luma.page, 'presentation-cache')
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
    await requireEditorPreviewFeature(luma.page, 'presentation-cache')
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

/** Hold a genuinely completed normal offscreen fence without changing any canvas work. */
async function holdNormalOffscreenFence(page: Page) {
  return page.evaluateHandle(() => {
    const original = {
      current: GPUCanvasContext.prototype.getCurrentTexture,
      view: GPUTexture.prototype.createView,
      pass: GPUCommandEncoder.prototype.beginRenderPass,
      finish: GPUCommandEncoder.prototype.finish,
      submit: GPUQueue.prototype.submit,
      fence: GPUQueue.prototype.onSubmittedWorkDone,
    }
    const canvasTextures = new WeakSet<GPUTexture>(),
      views = new WeakMap<GPUTextureView, GPUTexture>(),
      encoders = new WeakSet<GPUCommandEncoder>(),
      commands = new WeakSet<GPUCommandBuffer>(),
      queues = new WeakSet<GPUQueue>(),
      pending = new Set<Promise<void>>()
    let armed = true,
      held = false,
      delivered = false,
      actualCompleted = false,
      offscreenSubmissions = 0,
      releaseHeld: (() => void) | undefined
    let sourceIdentity: string | undefined, serial: number | undefined
    const release = () => {
      const resolve = releaseHeld
      releaseHeld = undefined
      resolve?.()
    }
    const current: typeof original.current = function (this: GPUCanvasContext) {
      const texture = original.current.call(this)
      canvasTextures.add(texture)
      return texture
    }
    const view: typeof original.view = function (this: GPUTexture, ...args) {
      const result = original.view.apply(this, args)
      views.set(result, this)
      return result
    }
    const pass: typeof original.pass = function (this: GPUCommandEncoder, descriptor) {
      const result = original.pass.call(this, descriptor)
      for (const attachment of Array.from(descriptor.colorAttachments)) {
        const texture = attachment ? views.get(attachment.view as GPUTextureView) : undefined
        if (
          texture &&
          !canvasTextures.has(texture) &&
          texture.format === 'rgba16float' &&
          !!(texture.usage & GPUTextureUsage.COPY_SRC)
        )
          encoders.add(this)
      }
      return result
    }
    const finish: typeof original.finish = function (this: GPUCommandEncoder, ...args) {
      const command = original.finish.apply(this, args)
      if (encoders.has(this)) commands.add(command)
      return command
    }
    const submit: typeof original.submit = function (this: GPUQueue, commandsToSubmit) {
      const values = Array.from(commandsToSubmit)
      original.submit.call(this, values)
      if (values.some((command) => commands.has(command))) {
        offscreenSubmissions++
        queues.add(this)
      }
    }
    const fence: typeof original.fence = function (this: GPUQueue) {
      const actual = original.fence.call(this)
      if (!armed || !queues.has(this)) return actual
      armed = false
      const work = actual.then(async () => {
        actualCompleted = true
        held = true
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
        sourceIdentity = canvas.dataset.requestedSourceIdentity
        serial = Number(canvas.dataset.requestedSerial)
        await new Promise<void>((resolve) => {
          releaseHeld = resolve
        })
        held = false
        delivered = true
        return undefined
      })
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    GPUCanvasContext.prototype.getCurrentTexture = current
    GPUTexture.prototype.createView = view
    GPUCommandEncoder.prototype.beginRenderPass = pass
    GPUCommandEncoder.prototype.finish = finish
    GPUQueue.prototype.submit = submit
    GPUQueue.prototype.onSubmittedWorkDone = fence
    const state = () => ({
      held,
      delivered,
      actualCompleted,
      offscreenSubmissions,
      sourceIdentity,
      serial,
    })
    return {
      state,
      release,
      close: async () => {
        armed = false
        release()
        try {
          await Promise.allSettled([...pending])
        } finally {
          GPUCanvasContext.prototype.getCurrentTexture = original.current
          GPUTexture.prototype.createView = original.view
          GPUCommandEncoder.prototype.beginRenderPass = original.pass
          GPUCommandEncoder.prototype.finish = original.finish
          GPUQueue.prototype.submit = original.submit
          GPUQueue.prototype.onSubmittedWorkDone = original.fence
        }
        return state()
      },
    }
  })
}

test(
  'a resident-source normal draw preserves the real cached paint receipt until a target change',
  foreground,
  async ({ luma }, info) => {
    await requireEditorPreviewFeature(luma.page, 'presentation-cache')
    test.setTimeout(120000)
    const { app, page } = luma,
      { raw } = await setup(app, page)
    const before = await capture(app, page),
      source = await page
        .getByTestId('main-preview')
        .getAttribute('data-presented-source-identity'),
      edits = await page.evaluate((id) => window.luma.getEdits(id), raw.id)
    expect(source).toBeTruthy()
    await selectRaster(page)
    const gate = await holdNormalOffscreenFence(page)
    let painted, changed, drained
    try {
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await expect
        .poll(async () => (await gate.evaluate((control) => control.state())).held)
        .toBe(true)
      const canvas = page.getByTestId('main-preview'),
        fence = await gate.evaluate((control) => control.state())
      expect(fence).toMatchObject({ held: true, delivered: false, actualCompleted: true })
      expect(fence.sourceIdentity).toBe(source)
      expect(fence.serial).toBeGreaterThan(0)
      expect(fence.offscreenSubmissions).toBeGreaterThan(0)
      await expect(canvas).toHaveAttribute('data-source-cache', 'hit')
      await expect(canvas).toHaveAttribute('data-source-uploads', '0')
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'true')
      await expect(canvas).toHaveAttribute('data-presentation-cache', 'hit')
      await expect(canvas).toBeVisible()
      await expect(canvas).not.toHaveAttribute('data-editing', 'ready')
      await expect(canvas).toHaveAttribute('data-cached-source-identity', source!)
      await expect(canvas).toHaveAttribute('data-cached-settings-revision', String(edits.revision))
      await expect(page.getByLabel('Preview zoom')).toBeDisabled()
      painted = await canvas.evaluate((element) => ({
        fencedAt: Number(element.dataset.cachedFencedAt),
        paintedAt: Number(element.dataset.cachedPostPaintAt),
        source: element.dataset.cachedSourceIdentity,
        target: Number(element.dataset.cachedTargetGeneration),
        requestedSerial: Number(element.dataset.requestedSerial),
      }))
      expect(painted.fencedAt).toBeGreaterThan(0)
      expect(painted.paintedAt).toBeGreaterThanOrEqual(painted.fencedAt)
      expect(painted.requestedSerial).toBe(fence.serial)
      const restored = await capture(app, page)
      expect(restored.size).toEqual(before.size)
      expect(restored.pixels).toEqual(before.pixels)
      expect((await gate.evaluate((control) => control.state())).held).toBe(true)

      // A real target generation change retires the same receipt while the
      // unrelated completed normal render is still held before its canvas write.
      changed = await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
      expect(changed.generation).toBeGreaterThan(painted.target)
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'false')
      await expect(canvas).not.toBeVisible()
      for (const sample of await observePaints(page, 2)) {
        expect(sample.cachedReady).toBe('false')
        expect(sample.editing).not.toBe('ready')
      }
      expect((await gate.evaluate((control) => control.state())).held).toBe(true)
      await gate.evaluate((control) => control.release())
      await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-editing', 'ready')
      await expect(canvas).toHaveAttribute('data-target-generation', String(changed.generation))
      await expect(canvas).toHaveAttribute('data-presented-source-identity', source!)
      await expect(canvas).toHaveAttribute(
        'data-presented-settings-revision',
        String(edits.revision),
      )
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'false')
      assertHdrMemory(await canvas.evaluate(readHdrMemory))
    } finally {
      try {
        await gate.evaluate((control) => control.release())
        drained = await gate.evaluate((control) => control.close())
      } finally {
        await gate.dispose()
      }
      await writeFile(
        info.outputPath('resident-source-cached-paint-receipt.json'),
        JSON.stringify({ source, revision: edits.revision, painted, changed, drained }, null, 2),
      )
    }
  },
)

/** Bind actual normal readbacks and cached blits, holding only delivery of one completed map. */
async function holdCurrentNormalRecovery(page: Page) {
  return page.evaluateHandle(() => {
    const original = {
      current: GPUCanvasContext.prototype.getCurrentTexture,
      view: GPUTexture.prototype.createView,
      group: GPUDevice.prototype.createBindGroup,
      pass: GPUCommandEncoder.prototype.beginRenderPass,
      bind: GPURenderPassEncoder.prototype.setBindGroup,
      draw: GPURenderPassEncoder.prototype.draw,
      copy: GPUCommandEncoder.prototype.copyTextureToBuffer,
      finish: GPUCommandEncoder.prototype.finish,
      submit: GPUQueue.prototype.submit,
      fence: GPUQueue.prototype.onSubmittedWorkDone,
      map: GPUBuffer.prototype.mapAsync,
      range: GPUBuffer.prototype.getMappedRange,
    }
    type Copy = {
      texture: GPUTexture
      canvas: HTMLCanvasElement
      buffer: GPUBuffer
      width: number
      height: number
      rowBytes: number
      source: string
      serial: number
      submitted: boolean
      fenceLinked: boolean
      fenced: boolean
      canvasBlit: boolean
      sha256?: string
      byteLength?: number
    }
    type Commands = { blit?: GPUTexture; copies: Copy[] }
    const views = new WeakMap<GPUTextureView, GPUTexture>(),
      groups = new WeakMap<GPUBindGroup, GPUTexture>(),
      canvasTextures = new WeakSet<GPUTexture>(),
      passes = new WeakMap<
        GPURenderPassEncoder,
        { encoder: GPUCommandEncoder; canvas: boolean; source?: GPUTexture }
      >(),
      encoders = new WeakMap<GPUCommandEncoder, Commands>(),
      commands = new WeakMap<GPUCommandBuffer, Commands>(),
      buffers = new WeakMap<GPUBuffer, Copy>(),
      queues = new WeakMap<GPUQueue, Copy[]>(),
      records: Copy[] = [],
      pending = new Set<Promise<unknown>>(),
      errors: string[] = []
    let seed: Copy | undefined,
      held: Copy | undefined,
      armed = false,
      holding = false,
      mapped = false,
      released = false,
      writes = 0,
      cachedBlitMatchesSeed = false,
      releaseHeld: (() => void) | undefined
    const main = () => document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
      encoderRecord = (encoder: GPUCommandEncoder) => {
        let value = encoders.get(encoder)
        if (!value) {
          value = { copies: [] }
          encoders.set(encoder, value)
        }
        return value
      },
      track = (work: Promise<unknown>) => {
        pending.add(work)
        void work.finally(() => pending.delete(work)).catch(() => undefined)
      },
      release = () => {
        released = true
        releaseHeld?.()
        releaseHeld = undefined
      }
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      const texture = original.current.call(this)
      if (this.canvas === main()) {
        canvasTextures.add(texture)
        if (armed || held) writes++
      }
      return texture
    }
    GPUTexture.prototype.createView = function (...args) {
      const view = original.view.apply(this, args)
      views.set(view, this)
      return view
    }
    GPUDevice.prototype.createBindGroup = function (descriptor) {
      const group = original.group.call(this, descriptor)
      for (const entry of descriptor.entries)
        if (entry.binding === 0) {
          const texture = views.get(entry.resource as GPUTextureView)
          if (texture) groups.set(group, texture)
        }
      return group
    }
    GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
      const pass = original.pass.call(this, descriptor)
      passes.set(pass, {
        encoder: this,
        canvas: Array.from(descriptor.colorAttachments).some(
          (entry) => !!entry && canvasTextures.has(views.get(entry.view as GPUTextureView)!),
        ),
      })
      return pass
    }
    GPURenderPassEncoder.prototype.setBindGroup = function (...args: unknown[]) {
      const pass = passes.get(this)
      if (pass && args[0] === 0) pass.source = groups.get(args[1] as GPUBindGroup)
      return Reflect.apply(original.bind, this, args)
    }
    GPURenderPassEncoder.prototype.draw = function (...args) {
      const pass = passes.get(this)
      if (pass?.canvas && pass.source) encoderRecord(pass.encoder).blit = pass.source
      return original.draw.apply(this, args)
    }
    GPUCommandEncoder.prototype.copyTextureToBuffer = function (...args) {
      original.copy.apply(this, args)
      if (args[1].buffer.label !== 'luma-hdr-recovery-readback') return
      const canvas = main(),
        texture = args[0].texture
      if (records.length >= 16) throw new Error('Recovery half observation exceeded its bound.')
      const record: Copy = {
        texture,
        canvas,
        buffer: args[1].buffer,
        width: texture.width,
        height: texture.height,
        rowBytes: Number(args[1].bytesPerRow),
        source: canvas.dataset.requestedSourceIdentity!,
        serial: Number(canvas.dataset.requestedSerial),
        submitted: false,
        fenceLinked: false,
        fenced: false,
        canvasBlit: false,
      }
      records.push(record)
      buffers.set(record.buffer, record)
      encoderRecord(this).copies.push(record)
    }
    GPUCommandEncoder.prototype.finish = function (...args) {
      const command = original.finish.apply(this, args),
        record = encoders.get(this)
      if (record) commands.set(command, record)
      return command
    }
    GPUQueue.prototype.submit = function (input) {
      const values = Array.from(input)
      original.submit.call(this, values)
      const copies: Copy[] = []
      for (const command of values) {
        const record = commands.get(command)
        if (!record) continue
        if (seed && record.blit === seed.texture) cachedBlitMatchesSeed = true
        for (const copy of record.copies) {
          copy.submitted = true
          copy.canvasBlit = record.blit === copy.texture
          copies.push(copy)
        }
      }
      if (copies.length) queues.set(this, copies)
    }
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      const work = original.fence.call(this),
        copies = queues.get(this)
      queues.delete(this)
      if (copies) {
        for (const copy of copies) copy.fenceLinked = true
        track(
          work.then(() => {
            for (const copy of copies) copy.fenced = true
          }),
        )
      }
      return work
    }
    GPUBuffer.prototype.mapAsync = function (...args) {
      const actual = original.map.apply(this, args),
        record = buffers.get(this)
      if (!armed || !record) return actual
      armed = false
      held = record
      const work = actual.then(async (value) => {
        mapped = this.mapState === 'mapped'
        if (!released) {
          holding = true
          await new Promise<void>((resolve) => {
            releaseHeld = resolve
          })
          holding = false
        }
        return value
      })
      track(work)
      return work
    }
    GPUBuffer.prototype.getMappedRange = function (...args) {
      const range = original.range.apply(this, args),
        record = buffers.get(this)
      if (record) {
        if (
          !record.submitted ||
          !record.fenceLinked ||
          range.byteLength !== record.rowBytes * record.height
        )
          errors.push('Half plane did not bind its actual submitted copy/fence/extent.')
        const bytes = record.width * record.height * 8
        if (bytes < 1 || bytes > 64 * 1024 ** 2)
          throw new Error('Half plane observation is not bounded.')
        const body = new Uint8Array(bytes)
        for (let row = 0; row < record.height; row++)
          body.set(
            new Uint8Array(range, row * record.rowBytes, record.width * 8),
            row * record.width * 8,
          )
        record.byteLength = bytes
        track(
          crypto.subtle.digest('SHA-256', body).then((digest) => {
            record.sha256 = Array.from(new Uint8Array(digest), (n) =>
              n.toString(16).padStart(2, '0'),
            ).join('')
          }),
        )
      }
      return range
    }
    const plain = (copy: Copy | undefined) =>
      copy
        ? {
            source: copy.source,
            serial: copy.serial,
            width: copy.width,
            height: copy.height,
            submitted: copy.submitted,
            fenceLinked: copy.fenceLinked,
            fenced: copy.fenced,
            canvasBlit: copy.canvasBlit,
            sha256: copy.sha256,
            byteLength: copy.byteLength,
          }
        : null
    const state = () => ({
      holding,
      mapped,
      writes,
      cachedBlitMatchesSeed,
      seed: plain(seed),
      held: plain(held),
      records: records.map(plain),
      errors: [...errors],
    })
    return {
      seed: async () => {
        await Promise.allSettled([...pending])
        const canvas = main()
        const candidates = records.filter(
          (copy) =>
            copy.canvas === canvas &&
            copy.source === canvas.dataset.presentedSourceIdentity &&
            String(copy.serial) === canvas.dataset.completedEditSerial,
        )
        if (candidates.length !== 1)
          throw new Error('The current canvas seed readback is missing or ambiguous.')
        seed = candidates[0]
        if (!seed?.sha256 || !seed.canvasBlit)
          throw new Error('The real seed normal blit/readback was not captured.')
        return state()
      },
      arm: () => {
        armed = true
        released = false
        writes = 0
        cachedBlitMatchesSeed = false
      },
      state,
      release,
      close: async () => {
        armed = false
        release()
        try {
          while (pending.size) await Promise.allSettled([...pending])
        } finally {
          GPUCanvasContext.prototype.getCurrentTexture = original.current
          GPUTexture.prototype.createView = original.view
          GPUDevice.prototype.createBindGroup = original.group
          GPUCommandEncoder.prototype.beginRenderPass = original.pass
          GPURenderPassEncoder.prototype.setBindGroup = original.bind
          GPURenderPassEncoder.prototype.draw = original.draw
          GPUCommandEncoder.prototype.copyTextureToBuffer = original.copy
          GPUCommandEncoder.prototype.finish = original.finish
          GPUQueue.prototype.submit = original.submit
          GPUQueue.prototype.onSubmittedWorkDone = original.fence
          GPUBuffer.prototype.mapAsync = original.map
          GPUBuffer.prototype.getMappedRange = original.range
        }
        return state()
      },
    }
  })
}

test(
  'an exact restored canvas survives a held real normal recovery map and the next edit performs a new blit',
  foreground,
  async ({ luma }, info) => {
    await requireEditorPreviewFeature(luma.page, 'presentation-cache')
    test.setTimeout(120000)
    const { app, page } = luma
    let gate: Awaited<ReturnType<typeof holdCurrentNormalRecovery>> | undefined
    let observer: Awaited<ReturnType<typeof observePhotoActivation>> | undefined
    let seed, held, ready, edited, drained, navigation
    try {
      // Install before initial GPU views/bind groups exist: later normal draws
      // legitimately reuse them, so an observer installed after setup cannot bind their source.
      gate = await holdCurrentNormalRecovery(page)
      const { raw } = await setup(app, page)
      if (!gate) throw new Error('The actual normal recovery observer was not installed.')
      seed = await gate.evaluate((control) => control.seed())
      const canvas = page.getByTestId('main-preview'),
        before = await capture(app, page),
        edits = await page.evaluate((id) => window.luma.getEdits(id), raw.id),
        history = await page.evaluate((id) => window.luma.getEditHistory(id), raw.id)
      await selectRaster(page)
      observer = await observePhotoActivation(page)
      const { exposureEv, contrast, highlights, shadows, whites, blacks, whiteBalance } =
        edits.settings
      await observer.evaluate(
        (control, target) => control.arm(target, 'cached-native-readiness-coexistence'),
        {
          id: raw.id,
          filename: raw.filename,
          revision: edits.revision,
          sourceIdentity: seed.seed!.source,
          parameters: { exposureEv, contrast, highlights, shadows, whites, blacks, whiteBalance },
        },
      )
      await gate.evaluate((control) => control.arm())
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await expect
        .poll(async () => (await gate!.evaluate((control) => control.state())).holding)
        .toBe(true)
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'true')
      await expect(canvas).toHaveAttribute('data-presentation-cache', 'hit')
      await expect(canvas).toHaveAttribute('data-editing', 'loading')
      await expect(canvas).toHaveAttribute('data-cached-source-identity', seed.seed!.source)
      await expect(canvas).toHaveAttribute('data-cached-settings-revision', String(edits.revision))
      await expect(canvas).toBeVisible()
      await expect(page.getByLabel('Preview zoom')).toBeDisabled()
      held = await gate.evaluate((control) => control.state())
      expect(held).toMatchObject({
        holding: true,
        mapped: true,
        writes: 1,
        cachedBlitMatchesSeed: true,
        errors: [],
      })
      expect(held.held).toMatchObject({
        submitted: true,
        fenceLinked: true,
        fenced: true,
        canvasBlit: false,
        source: seed.seed!.source,
      })
      expect(await canvas.getAttribute('data-normal-canvas-submitted-at')).toBeNull()
      const restored = await capture(app, page)
      expect(restored.size).toEqual(before.size)
      expect(restored.pixels).toEqual(before.pixels)
      expect((await gate.evaluate((control) => control.state())).writes).toBe(1)
      expect(await page.evaluate((id) => window.luma.getEditHistory(id), raw.id)).toEqual(history)
      await expect
        .poll(() => observer!.evaluate((control) => control.status().current?.firstUsefulKind))
        .toBe('cached-exact')
      expect(
        await observer.evaluate((control) => control.status().current?.nativeReadyAt),
      ).toBeNull()
      await gate.evaluate((control) => control.release())
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-quality', 'normal')
      await expect(canvas).toHaveAttribute('data-presented-source-identity', seed.seed!.source)
      await expect(canvas).toHaveAttribute(
        'data-presented-settings-revision',
        String(edits.revision),
      )
      await expect
        .poll(async () => (await gate!.evaluate((control) => control.state())).held?.sha256)
        .toBe(seed.seed!.sha256)
      ready = await gate.evaluate((control) => control.state())
      expect(ready.writes).toBe(1)
      expect(ready.held?.byteLength).toBe(seed.seed!.byteLength)
      expect(ready.errors).toEqual([])
      await expect(canvas).toHaveAttribute('data-cached-display-ready', 'true')
      await expect
        .poll(() => observer!.evaluate((control) => control.status().current?.nativeReadyAt))
        .toBeGreaterThan(0)
      navigation = await observer.evaluate((control) => control.read())
      expect(NAVIGATION_MEASUREMENT_VERSION).toBe('photo-activation-painted-first-surface-v4')
      expect(navigation.activations).toHaveLength(1)
      const activation = navigation.activations[0]
      expect(activation.firstUsefulKind).toBe('cached-exact')
      expect(activation.firstUseful!.editing).toBe('loading')
      expect(activation.nativeReady).toMatchObject({
        cachedReady: true,
        editing: 'ready',
        quality: 'normal',
        nativeSource: seed.seed!.source,
        nativeRevision: edits.revision,
      })
      expect(activation.nativeReady!.normalCanvasSubmittedAt).toBeNaN()
      expect(activation.nativeReady!.completedSerial).toBe(activation.nativeReady!.requestedSerial)
      expect(activation.nativeReadyAt!).toBeGreaterThanOrEqual(activation.firstUsefulAt!)
      expect(activation.nativeReadyAt!).toBeGreaterThanOrEqual(
        activation.nativeReady!.nativeEditingReadyAt,
      )
      expect(activation.wrongVisiblePublications).toBe(0)
      await observer.evaluate((control) => control.close())
      await observer.dispose()
      observer = undefined
      expect(
        await canvas.evaluate(
          (element) => JSON.parse(element.dataset.frameTimings!).cachedCanvasReused,
        ),
      ).toBe(1)
      await expect
        .poll(() =>
          canvas.evaluate(
            (element) =>
              element.dataset.analysisSerial === element.dataset.completedEditSerial &&
              element.dataset.analysisSerial === element.dataset.requestedSerial,
          ),
        )
        .toBe(true)
      assertHdrMemory(await canvas.evaluate(readHdrMemory))
      const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
      await exposure.fill('2')
      await exposure.press('Enter')
      await expect(canvas).toHaveAttribute('data-exposure', '2')
      await expect(canvas).toHaveAttribute('data-editing', 'ready')
      await expect
        .poll(async () => (await gate!.evaluate((control) => control.state())).writes)
        .toBeGreaterThan(1)
      expect(
        await canvas.evaluate(
          (element) => JSON.parse(element.dataset.frameTimings!).cachedCanvasReused,
        ),
      ).toBe(0)
      edited = await gate.evaluate((control) => control.state())
    } finally {
      if (gate) await gate.evaluate((control) => control.release())
      try {
        if (observer) {
          try {
            await observer.evaluate((control) => control.close())
          } finally {
            await observer.dispose()
          }
        }
      } finally {
        if (gate) {
          try {
            drained = await gate.evaluate((control) => control.close())
          } finally {
            await gate.dispose()
          }
        }
      }
      await writeFile(
        info.outputPath('cached-canvas-held-normal-recovery.json'),
        JSON.stringify({ seed, held, ready, edited, drained, navigation }, null, 2),
      )
    }
  },
)
