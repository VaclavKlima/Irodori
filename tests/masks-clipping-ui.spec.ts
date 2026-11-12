import type { ElectronApplication, Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { observeAnalysisMessages, settledHealthyPreview } from './hdr-analysis-cancel.helpers'
import { importPhotos } from './import.helpers'
import { captureWindow } from './window-capture.helpers'
import { identityCrop } from '../src/shared/crop'
import { foregroundTest } from './foreground'

async function overlayState(page: Page) {
  return page.getByTestId('clipping-overlay').evaluate(async (node) => {
    const canvas = node as HTMLCanvasElement,
      data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      occupancy = new Uint8Array(canvas.width * canvas.height),
      colours = new Uint8Array(occupancy.length * 3)
    const hash = async (bytes: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('')
    let visible = 0
    for (let pixel = 0; pixel < occupancy.length; pixel++) {
      occupancy[pixel] = Number(data[pixel * 4 + 3] !== 0)
      visible += occupancy[pixel]
      colours.set(data.subarray(pixel * 4, pixel * 4 + 3), pixel * 3)
    }
    return {
      width: canvas.width,
      height: canvas.height,
      visible,
      sha256: await hash(data),
      occupancySha256: await hash(occupancy),
      colourSha256: await hash(colours),
    }
  })
}

// Native classification bits, occupied canvas pixels and RGB are exact gates.
// Canvas2D can rasterize the outer image edge with a different alpha while
// preserving all three. Retain RGBA/alpha diagnostics rather than changing
// clipping predicates to satisfy a canvas-compositing checksum.
async function expectOverlay(
  page: Page,
  expected: Pick<Awaited<ReturnType<typeof overlayState>>, 'occupancySha256' | 'colourSha256'>,
) {
  await expect
    .poll(
      async () => {
        const value = await overlayState(page)
        return [value.occupancySha256, value.colourSha256]
      },
      { timeout: 60000 },
    )
    .toEqual([expected.occupancySha256, expected.colourSha256])
}

async function displayPixelState(page: Page) {
  return page.evaluate(async () => {
    const state = await window.irodori.getDisplayState()
    return {
      generation: state.generation,
      requested: state.requested,
      mode: state.mode,
      colorSpace: state.colorSpace,
      peak: state.peak,
      headroom: state.headroom,
      outputVersion: state.outputVersion,
    }
  })
}

async function observeNativeReplies(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const channel = 'preview:hdr-mask-render',
      handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers,
      original = handlers.get(channel)
    if (!original) throw new Error('Missing real native clipping handler.')
    const replies: Record<string, unknown>[] = []
    let omitted = 0
    const wrapped: Handler = async (...args) => {
      const outcome = await original(...args)
      const result = outcome as Record<string, unknown>
      if (replies.length < 64)
        replies.push({
          kind: result.kind,
          sha256: result.sha256,
          comparison: result.comparison,
          generation: result.generation,
          settingsRevision: result.settingsRevision,
          source: result.source,
          target: result.target,
          domain: result.domain,
          width: result.width,
          height: result.height,
        })
      else omitted++
      return outcome
    }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, wrapped)
    return {
      state: () => ({ replies, omitted }),
      close: () => {
        if (handlers.get(channel) === wrapped) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, original)
        }
      },
    }
  })
}

async function observeOverlayPixels(page: Page) {
  return page.evaluateHandle(() => {
    const read = () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="clipping-overlay"]')!,
        viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!,
        preview = document.querySelector<HTMLElement>('[data-testid="main-preview"]')!
      return {
        width: canvas.width,
        height: canvas.height,
        rgba: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
        geometry: {
          viewport: { ...viewport.dataset },
          presentedView: preview.dataset.presentedView,
          frameGeometryRevision: preview.dataset.frameGeometryRevision,
          source: preview.dataset.presentedSourceIdentity,
        },
      }
    }
    const baseline = read()
    const hash = async (bytes: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('')
    const summary = async (value: ReturnType<typeof read>) => {
      const occupancy = new Uint8Array(value.width * value.height)
      const colours = new Uint8Array(occupancy.length * 3)
      let visible = 0
      for (let pixel = 0; pixel < occupancy.length; pixel++) {
        occupancy[pixel] = Number(value.rgba[pixel * 4 + 3] !== 0)
        visible += occupancy[pixel]
        colours.set(value.rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3)
      }
      return {
        width: value.width,
        height: value.height,
        visible,
        sha256: await hash(value.rgba),
        occupancySha256: await hash(occupancy),
        colourSha256: await hash(colours),
        geometry: value.geometry,
      }
    }
    return {
      snapshot: () => summary(baseline),
      compare: async () => {
        const current = read(),
          channelDifferences = [0, 0, 0, 0],
          maximumDelta = [0, 0, 0, 0],
          examples: { x: number; y: number; baseline: number[]; current: number[] }[] = []
        let changedPixels = 0,
          occupancyDifferences = 0
        if (current.width === baseline.width && current.height === baseline.height)
          for (let pixel = 0; pixel < current.width * current.height; pixel++) {
            let changed = false
            for (let channel = 0; channel < 4; channel++) {
              const at = pixel * 4 + channel,
                delta = Math.abs(current.rgba[at] - baseline.rgba[at])
              if (delta) {
                channelDifferences[channel]++
                changed = true
              }
              maximumDelta[channel] = Math.max(maximumDelta[channel], delta)
            }
            occupancyDifferences += Number(
              (current.rgba[pixel * 4 + 3] !== 0) !== (baseline.rgba[pixel * 4 + 3] !== 0),
            )
            if (changed) {
              changedPixels++
              if (examples.length < 12)
                examples.push({
                  x: pixel % current.width,
                  y: Math.floor(pixel / current.width),
                  baseline: Array.from(baseline.rgba.subarray(pixel * 4, pixel * 4 + 4)),
                  current: Array.from(current.rgba.subarray(pixel * 4, pixel * 4 + 4)),
                })
            }
          }
        return {
          baseline: await summary(baseline),
          current: await summary(current),
          channelDifferences,
          maximumDelta,
          changedPixels,
          occupancyDifferences,
          examples,
        }
      },
    }
  })
}

async function settledHdrHistogram(page: Page) {
  await settledHealthyPreview(page)
  await expect
    .poll(
      () =>
        page
          .getByTestId('main-preview')
          .evaluate(
            (element) =>
              element.dataset.analysisPending === 'false' &&
              Boolean(element.dataset.analysisKey) &&
              element.dataset.analysisKey === element.dataset.displayedAnalysisKey,
          ),
      { timeout: 30000 },
    )
    .toBe(true)
  await expect(
    page.getByRole('slider', { name: 'Histogram tonal value' }).locator('path[d]'),
  ).toHaveCount(3, { timeout: 30000 })
}

test(
  'actual RAW clipping follows local Light edits, Before and photo-wide history at Fit and 100%',
  foregroundTest(
    'Native 1100 × 700 Console-open geometry, Fit/100% overlay presentation and window capture require foreground Wayland compositor frames.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(180000)
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate((window) => window.setContentSize(1100, 700))
    await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
    await activateButton(page.getByTestId('console-toggle'))
    const messages = await observeAnalysisMessages(page)
    const nativeReplies = await observeNativeReplies(app)
    let progress = 'import RAW'
    let failed = false
    let neutralSnapshot: Awaited<ReturnType<typeof overlayState>> | undefined
    let editedSnapshot: Awaited<ReturnType<typeof overlayState>> | undefined
    let neutralDisplay: Awaited<ReturnType<typeof displayPixelState>> | undefined
    let beforeDisplay: Awaited<ReturnType<typeof displayPixelState>> | undefined
    let overlayWitness: Awaited<ReturnType<typeof observeOverlayPixels>> | undefined
    try {
      await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
      await settledHdrHistogram(page)
      const canvas = page.getByTestId('main-preview'),
        viewport = page.getByTestId('preview-viewport'),
        overlay = page.getByTestId('clipping-overlay'),
        clipping = page.getByRole('button', { name: 'Canvas channel clipping', exact: true }),
        clippingStatus = page.getByRole('status', { name: 'Clipping overlay status' }),
        id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
      progress = 'publish initial native clipping'
      await activateButton(clipping)
      await expect(clipping).toHaveAttribute('aria-pressed', 'true')
      await expect
        .poll(
          async () =>
            (await messages.evaluate((control) => control.state())).replies.some(
              (reply) => reply.mask,
            ),
          { timeout: 60000 },
        )
        .toBe(true)
      await expect(overlay).toBeVisible()
      // The committed scene has clipped SDR sky/foliage. A worker reply alone
      // precedes React's overlay draw and cannot establish this baseline.
      await expect
        .poll(async () => (await overlayState(page)).visible, { timeout: 60000 })
        .toBeGreaterThan(0)
      let lastHash = '',
        stable = 0
      await expect
        .poll(async () => {
          const value = await overlayState(page)
          stable = value.sha256 === lastHash ? stable + 1 : 0
          lastHash = value.sha256
          return stable
        })
        .toBeGreaterThanOrEqual(2)
      overlayWitness = await observeOverlayPixels(page)
      const neutral = await overlayWitness.evaluate((control) => control.snapshot()),
        context = await page.evaluate((id) => window.irodori.getMaskContext(id, 0), id),
        maskId = crypto.randomUUID()
      const nativeHash = (revision: number, comparison: 'before' | 'after') =>
        nativeReplies.evaluate(
          (control, selection) => {
            const value = control
              .state()
              .replies.slice()
              .reverse()
              .find(
                (reply) =>
                  reply.kind === 'mask' &&
                  reply.settingsRevision === selection.revision &&
                  reply.comparison === selection.comparison,
              )?.sha256
            return typeof value === 'string' ? value : undefined
          },
          { revision, comparison },
        )
      const neutralNativeSha = await nativeHash(0, 'after')
      expect(neutralNativeSha).toMatch(/^[a-f0-9]{64}$/)
      neutralSnapshot = neutral
      neutralDisplay = await displayPixelState(page)
      // This witness only establishes the initial unmasked publication. Later
      // source/Before transitions may legitimately replace analysis workers.
      await messages.evaluate((control) => control.close())
      const outsidePatch = () =>
        page.evaluate(({ width, height }) => {
          const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!,
            canvas = document.querySelector<HTMLCanvasElement>('[data-testid="clipping-overlay"]')!,
            scale = Number(viewport.dataset.scale),
            x = Math.round(canvas.width / 2 - width * 0.4 * scale + Number(viewport.dataset.panX)),
            y = Math.round(canvas.height / 2 - height * 0.4 * scale + Number(viewport.dataset.panY))
          return Array.from(canvas.getContext('2d')!.getImageData(x - 2, y - 2, 5, 5).data)
        }, context)
      const unchangedOutside = await outsidePatch()
      progress = 'publish active brush and feathered edge clipping'
      await page.evaluate(
        ({ id, maskId }) =>
          window.irodori.mutateMasks(id, 0, {
            operations: [
              { kind: 'create', id: maskId, name: 'Clipping test' },
              {
                kind: 'stroke',
                id: maskId,
                stroke: { mode: 'add', radius: 0.3, feather: 0.2, points: [{ x: 0.5, y: 0.5 }] },
              },
              {
                kind: 'update',
                id: maskId,
                light: { exposureEv: 5 },
                edge: { featherPx: 2, shiftPx: 0 },
              },
            ],
          }),
        { id, maskId },
      )
      await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1')
      await settledHdrHistogram(page)
      // Regression: the masked histogram remains healthy, while clipping used to
      // report a separate unconditional refusal before any scan could start.
      await expect(clippingStatus).toHaveCount(0)
      await expect(
        page.getByRole('slider', { name: 'Histogram tonal value' }).locator('path[d]'),
      ).toHaveCount(3)
      await expect
        .poll(
          async () => {
            const value = await overlayState(page)
            return value.visible > 0 && value.occupancySha256 !== neutral.occupancySha256
          },
          { timeout: 60000 },
        )
        .toBe(true)
      const edited = await overlayState(page)
      const editedNativeSha = await nativeHash(1, 'after')
      expect(editedNativeSha).toMatch(/^[a-f0-9]{64}$/)
      expect(editedNativeSha).not.toBe(neutralNativeSha)
      editedSnapshot = edited
      expect(edited.visible).toBeGreaterThan(0)
      expect(await outsidePatch()).toEqual(unchangedOutside)
      progress = 'restore Before clipping'
      await canvas.focus()
      await canvas.press('\\')
      await expect(canvas).toHaveAttribute('data-comparison', 'before')
      beforeDisplay = await displayPixelState(page)
      await expect.poll(() => nativeHash(1, 'before'), { timeout: 60000 }).toBe(neutralNativeSha)
      await expectOverlay(page, neutral)
      progress = 'restore After clipping'
      await canvas.press('\\')
      await expect(canvas).toHaveAttribute('data-comparison', 'after')
      await expect.poll(() => nativeHash(1, 'after'), { timeout: 60000 }).toBe(editedNativeSha)
      await expectOverlay(page, edited)
      progress = 'restore Undo clipping'
      await page.evaluate((id) => window.irodori.undoEdit(id, 1), id)
      await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '2')
      await expect.poll(() => nativeHash(2, 'after'), { timeout: 60000 }).toBe(neutralNativeSha)
      await expectOverlay(page, neutral)
      progress = 'restore Redo clipping'
      await page.evaluate((id) => window.irodori.redoEdit(id, 2), id)
      await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '3')
      await expect.poll(() => nativeHash(3, 'after'), { timeout: 60000 }).toBe(editedNativeSha)
      await expectOverlay(page, edited)
      progress = 'inspect clipping at native resolution and return to Fit'
      await canvas.focus()
      await canvas.press('1')
      await expect(viewport).toHaveAttribute('data-scale', '1')
      await expect
        .poll(async () => (await overlayState(page)).visible, { timeout: 60000 })
        .toBeGreaterThan(0)
      await canvas.press('0')
      await expectOverlay(page, edited)
      await captureWindow(app, page, info.outputPath('masked-clipping-fit-console.png'))
      progress = 'toggle channel clipping and scoped J shortcut'
      await activateButton(clipping)
      await expect(clipping).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(async () => (await overlayState(page)).visible).toBe(0)
      await canvas.focus()
      await canvas.press('j')
      await expect(clipping).toHaveAttribute('aria-pressed', 'true')
      await expectOverlay(page, edited)
      await canvas.press('j')
      await expect(clipping).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(async () => (await overlayState(page)).visible).toBe(0)
      progress = 'preserve active curve refusal and histogram'
      await page.evaluate(
        (id) =>
          window.irodori.updateEdits(
            id,
            {
              curves: {
                master: [
                  { input: 0, output: 0 },
                  { input: 0.5, output: 0.7 },
                  { input: 1, output: 1 },
                ],
              },
            },
            3,
          ),
        id,
      )
      await settledHdrHistogram(page)
      await activateButton(clipping)
      await expect(clippingStatus).toHaveText('Clipping overlay unavailable.')
      await expect(clippingStatus).toHaveAttribute('title', /active curves/)
      await expect(
        page.getByRole('slider', { name: 'Histogram tonal value' }).locator('path[d]'),
      ).toHaveCount(3)
      await info.attach('masked-clipping-overlay', {
        body: JSON.stringify({ neutral, edited }),
        contentType: 'application/json',
      })
      progress = 'complete'
    } catch (error) {
      failed = true
      throw error
    } finally {
      const diagnostic = await page
        .evaluate(() => ({
          canvas: {
            ...document.querySelector<HTMLElement>('[data-testid="main-preview"]')?.dataset,
          },
          histogram: { ...document.querySelector<HTMLElement>('#histogram')?.dataset },
          plot: {
            ...document.querySelector<SVGElement>(
              '[role="slider"][aria-label="Histogram tonal value"]',
            )?.dataset,
          },
          paths: Array.from(
            document.querySelectorAll('[role="slider"][aria-label="Histogram tonal value"] path'),
            (path) => path.getAttribute('d')?.length ?? 0,
          ),
          clipping: document
            .querySelector('[aria-label="Clipping overlay status"]')
            ?.getAttribute('title'),
        }))
        .catch(() => undefined)
      const diagnosticsPath = info.outputPath('masked-clipping-diagnostics.json')
      await writeFile(
        diagnosticsPath,
        JSON.stringify(
          {
            progress,
            diagnostic,
            neutral: neutralSnapshot,
            edited: editedSnapshot,
            current: await overlayState(page).catch(() => undefined),
            neutralDisplay,
            beforeDisplay,
            currentDisplay: await displayPixelState(page).catch(() => undefined),
            nativeReplies: await nativeReplies
              .evaluate((control) => control.state())
              .catch(() => undefined),
            overlayComparison: await overlayWitness
              ?.evaluate((control) => control.compare())
              .catch(() => undefined),
          },
          null,
          2,
        ),
        { flag: 'wx' },
      )
      await info.attach('masked-clipping-progress', {
        path: diagnosticsPath,
        contentType: 'application/json',
      })
      const cleanup: unknown[] = []
      try {
        await messages.evaluate((control) => control.close())
      } catch (error) {
        cleanup.push(error)
      }
      try {
        await messages.dispose()
      } catch (error) {
        cleanup.push(error)
      }
      try {
        await nativeReplies.evaluate((control) => control.close())
      } catch (error) {
        cleanup.push(error)
      }
      try {
        await nativeReplies.dispose()
      } catch (error) {
        cleanup.push(error)
      }
      try {
        await overlayWitness?.dispose()
      } catch (error) {
        cleanup.push(error)
      }
      if (!failed) expect(cleanup, 'Clipping observer cleanup').toEqual([])
    }
  },
)

test(
  'actual raster clipping scans masked native pixels and survives crop, history and restart',
  foregroundTest(
    'Native Fit/100% cropped overlay presentation and window capture after restart require foreground Wayland compositor frames.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(120000)
    let { app, page } = irodori
    let progress = 'import raster'
    let initial: Record<string, unknown> | undefined
    try {
      await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
      const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
        maskId = crypto.randomUUID(),
        canvas = () => page.getByTestId('main-preview'),
        highlights = () => page.getByRole('button', { name: 'Highlight clipping', exact: true }),
        ready = async (revision: number) => {
          await expect(canvas()).toHaveAttribute('data-backend', 'webgl2', { timeout: 60000 })
          await expect(canvas()).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
          await expect(canvas()).toHaveAttribute('data-frame-geometry-revision', String(revision), {
            timeout: 60000,
          })
        }
      await ready(0)
      progress = 'publish masked raster clipping'
      await page.evaluate(
        ({ id, maskId }) =>
          window.irodori.mutateMasks(id, 0, {
            operations: [
              { kind: 'create', id: maskId, name: 'Raster clipping' },
              {
                kind: 'stroke',
                id: maskId,
                stroke: { mode: 'add', radius: 0.3, feather: 0.2, points: [{ x: 0.5, y: 0.5 }] },
              },
              { kind: 'update', id: maskId, light: { exposureEv: 5 } },
            ],
          }),
        { id, maskId },
      )
      await ready(1)
      const context = await page.evaluate((id) => window.irodori.getMaskContext(id, 1), id),
        nativePixels = context.width * context.height
      await activateButton(highlights())
      await expect(canvas()).toHaveAttribute('data-clipping-pending', 'false', { timeout: 60000 })
      await expect(canvas()).toHaveAttribute('data-clipping-pixels', String(nativePixels))
      await expect
        .poll(async () => (await overlayState(page)).visible, { timeout: 60000 })
        .toBeGreaterThan(0)
      const edited = await overlayState(page)
      initial = {
        overlay: edited,
        canvas: await canvas().evaluate((node) => ({ ...node.dataset })),
        viewport: await page
          .getByTestId('preview-viewport')
          .evaluate((node) => ({ ...node.dataset })),
      }
      progress = 'refresh masked raster clipping after history'
      await page.evaluate((id) => window.irodori.undoEdit(id, 1), id)
      await ready(2)
      await expect
        .poll(async () => (await overlayState(page)).occupancySha256, { timeout: 60000 })
        .not.toBe(edited.occupancySha256)
      await page.evaluate((id) => window.irodori.redoEdit(id, 2), id)
      await ready(3)
      await expectOverlay(page, edited)
      progress = 'register raster clipping through rotated and straightened crop'
      await page.evaluate(({ id, crop }) => window.irodori.updateEdits(id, { crop }, 3), {
        id,
        crop: { ...identityCrop, width: 0.7, height: 0.6, angle: 7, quarterTurns: 1 as const },
      })
      await ready(4)
      await expect(canvas()).toHaveAttribute('data-clipping-pending', 'false', { timeout: 60000 })
      await expect
        .poll(async () => Number(await canvas().getAttribute('data-clipping-pixels')))
        .toBeLessThan(nativePixels)
      await expect.poll(async () => (await overlayState(page)).visible).toBeGreaterThan(0)
      await canvas().focus()
      await canvas().press('1')
      await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-scale', '1')
      await expect.poll(async () => (await overlayState(page)).visible).toBeGreaterThan(0)
      await canvas().press('0')
      progress = 'restart saved raster mask and crop'
      const saved = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
      ;({ app, page } = await irodori.restart())
      await ready(4)
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(saved)
      if ((await highlights().getAttribute('aria-pressed')) !== 'true')
        await activateButton(highlights())
      await expect(canvas()).toHaveAttribute('data-clipping-pending', 'false', { timeout: 60000 })
      await expect.poll(async () => (await overlayState(page)).visible).toBeGreaterThan(0)
      await captureWindow(app, page, info.outputPath('masked-raster-clipping-crop.png'))
      await activateButton(highlights())
      await canvas().focus()
      await expect.poll(async () => (await overlayState(page)).visible).toBe(0)
      progress = 'complete'
    } finally {
      const diagnostic = {
        progress,
        initial,
        current: await overlayState(page).catch(() => undefined),
        canvas: await page
          .getByTestId('main-preview')
          .evaluate((node) => ({ ...node.dataset }))
          .catch(() => undefined),
        viewport: await page
          .getByTestId('preview-viewport')
          .evaluate((node) => ({ ...node.dataset }))
          .catch(() => undefined),
      }
      const path = info.outputPath('masked-raster-clipping-diagnostics.json')
      await writeFile(path, JSON.stringify(diagnostic), { flag: 'wx' })
      await info.attach('masked-raster-clipping-progress', {
        path,
        contentType: 'application/json',
      })
    }
  },
)
