import sharp from 'sharp'
import { maskCanonicalPoint } from '../src/shared/mask-geometry'
import { defaultColorMaskRange } from '../src/shared/mask-ranges'
import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'
import { identityCrop } from '../src/shared/crop'
import { captureWindow } from './window-capture.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { foregroundTest } from './foreground'
import { maskDetailTab } from './mask-panel.helpers'

async function createRange(page: Page, kind: 'Color' | 'Luminance') {
  await activateButton(page.getByRole('button', { name: 'Create mask', exact: true }))
  await activateButton(
    page
      .getByRole('menu', { name: 'Create mask', exact: true })
      .getByRole('menuitem', { name: `${kind} range…`, exact: true }),
  )
  const panel = page.getByRole('region', { name: `${kind} range controls`, exact: true })
  await expect(panel).toBeVisible()
  return panel
}

async function ready(page: Page, revision: number) {
  const preview = page.getByTestId('main-preview')
  await expect(preview).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(preview).toHaveAttribute('data-frame-geometry-revision', String(revision), {
    timeout: 60000,
  })
}

test('range previews cancel without history and luminance bounds, soft transitions and restart share ordinary Undo', async ({
  irodori,
}) => {
  test.setTimeout(120000)
  let { page } = irodori
  await importPhotos(
    irodori.app,
    page,
    ['tests/fixtures/photos/forest-light.jpg'],
    true,
    'keyboard',
  )
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await ready(page, 0)
  await navigateInspector(page, 'Masks')
  let panel = await createRange(page, 'Color')
  await panel.getByText('Enter color', { exact: true }).press('Enter')
  await panel.getByRole('textbox', { name: 'Sample color value', exact: true }).fill('#449944')
  await activateButton(panel.getByRole('button', { name: 'Use color', exact: true }))
  await expect(panel.getByRole('button', { name: 'Create mask', exact: true })).toBeEnabled({
    timeout: 60000,
  })
  expect((await history()).settings.maskStack).toEqual([])
  await activateButton(panel.getByRole('button', { name: 'Cancel range', exact: true }))
  expect((await history()).revision).toBe(0)
  expect((await history()).settings.maskStack).toEqual([])
  panel = await createRange(page, 'Luminance')
  const lower = panel.getByRole('spinbutton', { name: 'Lower value', exact: true })
  const upper = panel.getByRole('spinbutton', { name: 'Upper value', exact: true })
  await upper.fill('250')
  await upper.press('Enter')
  await lower.fill('125')
  await lower.press('Enter')
  await panel.getByRole('checkbox', { name: 'All brighter values', exact: true }).check()
  await expect(upper).toBeDisabled()
  expect((await history()).revision).toBe(0)
  await expect(panel.getByRole('button', { name: 'Create mask', exact: true })).toBeEnabled({
    timeout: 60000,
  })
  await activateButton(panel.getByRole('button', { name: 'Create mask', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 1 })
  expect((await history()).settings.maskStack[0].range).toEqual({
    version: 1,
    kind: 'luminance',
    lower: 125,
    upper: null,
    softness: 25,
  })
  await ready(page, 1)
  panel = page.getByRole('region', { name: 'Luminance range controls', exact: true })
  const existingLower = panel.getByRole('spinbutton', { name: 'Lower value', exact: true })
  await existingLower.fill('-1')
  await existingLower.press('Escape')
  await expect(existingLower).toHaveValue('125.0')
  expect((await history()).revision).toBe(1)
  const softness = panel.getByRole('spinbutton', { name: 'Softness value', exact: true })
  await softness.fill('50')
  expect((await history()).revision).toBe(1)
  await softness.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 2 })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 3 })
  expect((await history()).settings.maskStack[0].range).toMatchObject({ softness: 25 })
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 4 })
  const saved = (await history()).settings
  ;({ page } = await irodori.restart())
  await expect.poll(async () => (await history()).settings).toEqual(saved)
  await navigateInspector(page, 'Masks')
  await expect(
    page.getByRole('region', { name: 'Luminance range controls', exact: true }),
  ).toBeVisible()
})

test(
  'native range picking respects rotated crop geometry, five samples and minimum Console-open scrolling',
  foregroundTest(
    'Native pointer source sampling and 1100×700 Console-open capture need actual compositor presentation.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(120000)
    await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
    await activateButton(page.getByTestId('console-toggle'))
    await focusPreviewWindow(app, page)
    const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    await ready(page, 0)
    await page.evaluate(({ id, crop }) => window.irodori.updateEdits(id, { crop }, 0), {
      id: photoId,
      crop: { ...identityCrop, quarterTurns: 1 as const, width: 0.7, height: 0.6, angle: 7 },
    })
    await ready(page, 1)
    const expected = await page.evaluate(async (id) => {
      const context = await window.irodori.getMaskContext(id, 1)
      return window.irodori.sampleMaskRange({
        photoId: id,
        expectedRevision: 1,
        renderingIdentity: context.renderingIdentity,
        point: { x: 0.5, y: 0.5 },
      })
    }, photoId)
    expect(expected.color).not.toBeNull()
    await navigateInspector(page, 'Masks')
    const panel = await createRange(page, 'Color')
    const preview = page.getByTestId('preview-viewport')
    await expect(preview).toHaveAttribute('data-range-picking', 'true')
    const box = (await preview.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(panel.getByRole('button', { name: 'Color sample 1', exact: true })).toBeVisible({
      timeout: 60000,
    })
    await panel.getByText('Sample position', { exact: true }).press('Enter')
    for (let count = 1; count < 5; count++) {
      await activateButton(panel.getByRole('button', { name: 'Add color sample', exact: true }))
      await activateButton(panel.getByRole('button', { name: 'Sample this position', exact: true }))
      await expect(
        panel.getByRole('button', { name: `Color sample ${count + 1}`, exact: true }),
      ).toBeVisible({ timeout: 60000 })
    }
    await expect(
      panel.getByRole('button', { name: 'Add color sample', exact: true }),
    ).toBeDisabled()
    const confirm = panel.getByRole('button', { name: 'Create mask', exact: true })
    await expect(confirm).toBeEnabled({ timeout: 60000 })
    const before = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
    expect(before.revision).toBe(1)
    expect(before.settings.maskStack).toEqual([])
    await activateButton(confirm)
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)).revision,
      )
      .toBe(2)
    const state = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
    const range = state.settings.maskStack[0].range
    expect(range?.kind).toBe('color')
    if (range?.kind !== 'color') throw new Error('Expected a saved color range.')
    expect(range.samples).toHaveLength(5)
    expect(range.samples[0].a).toBeCloseTo(expected.color!.a, 8)
    expect(range.samples[0].b).toBeCloseTo(expected.color!.b, 8)
    await ready(page, 2)
    await page
      .getByRole('region', { name: 'Color range controls', exact: true })
      .getByRole('button', { name: 'Sample color', exact: true })
      .scrollIntoViewIfNeeded()
    await captureWindow(app, page, info.outputPath('range-mask-minimum-console.png'))
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(size).toEqual({ width: 1100, height: 700 })
    expect(
      await page
        .getByTestId('mask-details-scroll')
        .evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true)
  },
)

async function combineRange(
  page: Page,
  operator: 'Add' | 'Intersect',
  method: 'Color' | 'Luminance',
) {
  await activateButton(page.getByRole('button', { name: 'Combine…', exact: true }))
  await activateButton(
    page
      .getByRole('menu', { name: 'Combine coverage', exact: true })
      .getByRole('menuitem', { name: operator, exact: true }),
  )
  await activateButton(
    page
      .getByRole('menu', { name: 'New coverage part', exact: true })
      .getByRole('menuitem', { name: `${method} range…`, exact: true }),
  )
  return page.getByRole('region', { name: `${method} range controls`, exact: true })
}

test('compound range previews cancel or commit once while source replacement retains corrections and adjustments', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(120000)
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  await ready(page, 0)
  const rootId = crypto.randomUUID()
  await page.evaluate(
    ({ photoId, rootId }) =>
      window.irodori.mutateMasks(photoId, 0, {
        operations: [
          {
            kind: 'create',
            id: rootId,
            name: 'Retained source',
            gradient: {
              kind: 'radial',
              center: { x: 0.5, y: 0.5 },
              radiusX: 0.3,
              radiusY: 0.3,
              rotation: 0,
              feather: 20,
            },
          },
          {
            kind: 'stroke',
            id: rootId,
            strokeTarget: 'primary',
            stroke: { mode: 'add', radius: 0.04, feather: 0.2, points: [{ x: 0.7, y: 0.6 }] },
          },
          {
            kind: 'stroke',
            id: rootId,
            strokeTarget: 'result',
            stroke: { mode: 'subtract', radius: 0.02, feather: 0.4, points: [{ x: 0.5, y: 0.5 }] },
          },
          {
            kind: 'update',
            id: rootId,
            light: { exposureEv: 0.35 },
            color: { saturation: 12 },
            edge: { featherPx: 1.5, shiftPx: 1 },
          },
        ],
      }),
    { photoId, rootId },
  )
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const original = (await history()).settings.maskStack[0]
  await ready(page, 1)
  await navigateInspector(page, 'Masks')
  await maskDetailTab(page, 'Coverage')
  let panel = await combineRange(page, 'Add', 'Luminance')
  await expect(panel.getByRole('button', { name: 'Add part', exact: true })).toBeEnabled({
    timeout: 60000,
  })
  expect((await history()).revision).toBe(1)
  await activateButton(panel.getByRole('button', { name: 'Cancel range', exact: true }))
  expect((await history()).settings.maskStack[0]).toEqual(original)
  panel = await combineRange(page, 'Intersect', 'Color')
  await panel.getByText('Enter color', { exact: true }).press('Enter')
  await panel.getByRole('textbox', { name: 'Sample color value', exact: true }).fill('#449944')
  await activateButton(panel.getByRole('button', { name: 'Use color', exact: true }))
  await expect(panel.getByRole('button', { name: 'Add part', exact: true })).toBeEnabled({
    timeout: 60000,
  })
  expect((await history()).revision).toBe(1)
  await activateButton(panel.getByRole('button', { name: 'Add part', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 2 })
  const combined = (await history()).settings.maskStack[0]
  expect(combined.operands).toHaveLength(1)
  expect(combined.operands![0]).toMatchObject({ operator: 'intersect', range: { kind: 'color' } })
  for (const key of ['head', 'resultHead', 'gradient', 'light', 'color', 'edge'] as const)
    expect(combined[key]).toEqual(original[key])
  await ready(page, 2)
  await activateButton(
    page.getByRole('button', { name: 'Part actions for Starting coverage', exact: true }),
  )
  await activateButton(
    page
      .getByRole('menu', { name: 'Coverage part actions', exact: true })
      .getByRole('menuitem', { name: 'Replace starting coverage…', exact: true }),
  )
  await activateButton(
    page
      .getByRole('menu', { name: 'Replace starting coverage', exact: true })
      .getByRole('menuitem', { name: 'Luminance range…', exact: true }),
  )
  panel = page.getByRole('region', { name: 'Luminance range controls', exact: true })
  await expect(panel.getByRole('button', { name: 'Replace coverage', exact: true })).toBeEnabled({
    timeout: 60000,
  })
  expect((await history()).revision).toBe(2)
  await activateButton(panel.getByRole('button', { name: 'Replace coverage', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 3 })
  const replaced = (await history()).settings.maskStack[0]
  expect(replaced.gradient).toBeUndefined()
  expect(replaced.range?.kind).toBe('luminance')
  for (const key of ['head', 'resultHead', 'light', 'color', 'edge', 'operands'] as const)
    expect(replaced[key]).toEqual(combined[key])
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 4 })
  expect((await history()).settings.maskStack[0]).toEqual(combined)
})

test(
  'actual Sony range pixels survive Before, Undo, cropped rotation and restart at native detail',
  foregroundTest(
    'Native WebGPU photo pixels, 100% comparison and window capture need foreground compositor presentation.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(180000)
    let { app, page } = irodori
    await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
    await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
    await activateButton(page.getByTestId('console-toggle'))
    await focusPreviewWindow(app, page)
    const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    const preview = () => page.getByTestId('main-preview')
    const viewport = () => page.getByTestId('preview-viewport')
    const settled = async () => {
      await expect(page.getByRole('status').filter({ hasText: /^Updating mask…$/ })).toHaveCount(
        0,
        { timeout: 60000 },
      )
      await expect(preview()).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
      await expect(preview()).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      await expect(preview()).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
      await expect
        .poll(
          () =>
            preview().evaluate(
              (el) => el.dataset.completedEditSerial === el.dataset.requestedSerial,
            ),
          { timeout: 60000 },
        )
        .toBe(true)
      await expect(page.getByTestId('preview-gpu-error')).toHaveCount(0)
    }
    await settled()
    await preview().focus()
    await preview().press('1')
    await expect(viewport()).toHaveAttribute('data-scale', '1')
    await settled()
    const capture = async () => {
      const rect = (await preview().boundingBox())!
      const png = await (
        await app.browserWindow(page)
      ).evaluate(async (window, rect) => {
        const image = await window.capturePage(
          {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          { stayHidden: true },
        )
        return image
          .resize({ width: Math.round(rect.width), height: Math.round(rect.height) })
          .toPNG()
          .toString('base64')
      }, rect)
      return sharp(Buffer.from(png, 'base64'))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    }
    const baseline = await capture()
    let picked: { x: number; y: number } | undefined
    for (
      let y = Math.floor(baseline.info.height * 0.35);
      y < baseline.info.height * 0.65 && !picked;
      y += 13
    )
      for (
        let x = Math.floor(baseline.info.width * 0.35);
        x < baseline.info.width * 0.65;
        x += 13
      ) {
        const at = (y * baseline.info.width + x) * 4
        const level = (baseline.data[at] + baseline.data[at + 1] + baseline.data[at + 2]) / 3
        if (level > 30 && level < 180) {
          picked = { x, y }
          break
        }
      }
    expect(picked).toBeDefined()
    const context = await page.evaluate((id) => window.irodori.getMaskContext(id, 0), id)
    const view = await viewport().evaluate((el) => ({
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    }))
    const outputPoint = {
      x: (context.width / 2 + picked!.x + 0.5 - baseline.info.width / 2 - view.x) / context.width,
      y:
        (context.height / 2 + picked!.y + 0.5 - baseline.info.height / 2 - view.y) / context.height,
    }
    const sample = await page.evaluate(
      ({ id, renderingIdentity, point }) =>
        window.irodori.sampleMaskRange({
          photoId: id,
          expectedRevision: 0,
          renderingIdentity,
          point,
        }),
      { id, renderingIdentity: context.renderingIdentity, point: outputPoint },
    )
    expect(sample.color).not.toBeNull()
    const rootId = crypto.randomUUID()
    const range = defaultColorMaskRange(sample.color!)
    await page.evaluate(
      ({ id, rootId, range, point, aspect }) =>
        window.irodori.mutateMasks(id, 0, {
          operations: [
            { kind: 'create', id: rootId, name: 'Native source color', range },
            {
              kind: 'component-add',
              id: rootId,
              componentId: crypto.randomUUID(),
              name: 'Native spatial intersection',
              operator: 'intersect',
              gradient: {
                kind: 'radial',
                center: point,
                radiusX: 0.012 * aspect,
                radiusY: 0.012,
                rotation: 0,
                feather: 20,
              },
            },
            {
              kind: 'update',
              id: rootId,
              light: { exposureEv: 0.8 },
              edge: { featherPx: 2.5, shiftPx: 1 },
            },
          ],
        }),
      {
        id,
        rootId,
        range,
        point: sample.canonicalPoint,
        aspect: context.geometry.canonicalHeight / context.geometry.canonicalWidth,
      },
    )
    await ready(page, 1)
    await settled()
    const changed = await capture()
    const patch = (a: typeof baseline, b: typeof baseline, point: { x: number; y: number }) => {
      expect(a.info.width).toBe(b.info.width)
      expect(a.info.height).toBe(b.info.height)
      let maximum = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (let c = 0; c < 3; c++) {
            const at = ((point.y + dy) * a.info.width + point.x + dx) * 4 + c
            maximum = Math.max(maximum, Math.abs(a.data[at] - b.data[at]))
          }
      return maximum
    }
    const outside = {
      x: picked!.x < baseline.info.width / 2 ? baseline.info.width - 40 : 40,
      y: picked!.y,
    }
    expect(patch(changed, baseline, picked!)).toBeGreaterThan(4)
    expect(patch(changed, baseline, outside)).toBeLessThanOrEqual(1)
    await preview().focus()
    await preview().press('\\')
    await expect(preview()).toHaveAttribute('data-comparison', 'before')
    await settled()
    expect(patch(await capture(), baseline, picked!)).toBeLessThanOrEqual(1)
    await preview().press('\\')
    await settled()
    expect(patch(await capture(), changed, picked!)).toBeLessThanOrEqual(1)
    await page.evaluate((id) => window.irodori.undoEdit(id, 1), id)
    await ready(page, 2)
    await settled()
    expect(patch(await capture(), baseline, picked!)).toBeLessThanOrEqual(1)
    await page.evaluate((id) => window.irodori.redoEdit(id, 2), id)
    await ready(page, 3)
    await settled()
    expect(patch(await capture(), changed, picked!)).toBeLessThanOrEqual(1)
    await page.evaluate(({ id, crop }) => window.irodori.updateEdits(id, { crop }, 3), {
      id,
      crop: { ...identityCrop, quarterTurns: 1 as const, angle: 7, width: 0.25, height: 0.25 },
    })
    await ready(page, 4)
    await settled()
    const croppedAfter = await capture()
    const croppedContext = await page.evaluate((id) => window.irodori.getMaskContext(id, 4), id)
    const croppedView = await viewport().evaluate((el) => ({
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    }))
    let nearest = { x: 0, y: 0, distance: Infinity }
    for (let y = 20; y < croppedAfter.info.height - 20; y += 4)
      for (let x = 20; x < croppedAfter.info.width - 20; x += 4) {
        const canonical = maskCanonicalPoint(
          {
            x: croppedContext.width / 2 + x + 0.5 - croppedAfter.info.width / 2 - croppedView.x,
            y: croppedContext.height / 2 + y + 0.5 - croppedAfter.info.height / 2 - croppedView.y,
          },
          croppedContext.geometry,
        )
        const distance = Math.hypot(
          (canonical.x - sample.canonicalPoint.x) * croppedContext.geometry.canonicalWidth,
          (canonical.y - sample.canonicalPoint.y) * croppedContext.geometry.canonicalHeight,
        )
        if (distance < nearest.distance) nearest = { x, y, distance }
      }
    expect(nearest.distance).toBeLessThan(4)
    await preview().focus()
    await preview().press('\\')
    await settled()
    const croppedBefore = await capture()
    expect(patch(croppedAfter, croppedBefore, nearest)).toBeGreaterThan(4)
    await preview().press('\\')
    await settled()
    const saved = (await page.evaluate((id) => window.irodori.getEditHistory(id), id)).settings
    expect(saved.maskStack[0].range).toEqual(range)
    await captureWindow(app, page, info.outputPath('sony-range-cropped-native.png'))
    const analysis = await page.evaluateHandle(() => {
      const original = Worker.prototype.postMessage
      const requests: { masks: boolean; generation: number }[] = []
      const wrapped = function (this: Worker, ...args: unknown[]) {
        const value = args[0] as {
          request?: {
            masks?: boolean
            sampleStatistics?: boolean
            nativeMask?: unknown
            generation: number
          }
        } | null
        if (
          typeof value?.request?.masks === 'boolean' &&
          typeof value.request.sampleStatistics === 'boolean'
        ) {
          if (requests.length >= 64)
            throw new Error('Range clipping observation exceeded its bounded request count.')
          requests.push({ masks: value.request.masks, generation: value.request.generation })
        }
        return Reflect.apply(original, this, args)
      } as typeof original
      Worker.prototype.postMessage = wrapped
      return {
        latest: () => requests.at(-1),
        close: () => {
          if (Worker.prototype.postMessage === wrapped) Worker.prototype.postMessage = original
        },
      }
    })
    try {
      await activateButton(
        page.getByRole('button', { name: 'Canvas channel clipping', exact: true }),
      )
      await expect
        .poll(() => analysis.evaluate((observer) => observer.latest()?.masks), { timeout: 60000 })
        .toBe(true)
      await navigateInspector(page, 'Masks')
      await maskDetailTab(page, 'Coverage')
      const rangePreview = await combineRange(page, 'Add', 'Luminance')
      await expect(preview()).toHaveAttribute('data-gesturing', 'true')
      await expect(rangePreview.getByRole('button', { name: 'Add part', exact: true })).toBeEnabled(
        { timeout: 60000 },
      )
      await expect
        .poll(() => analysis.evaluate((observer) => observer.latest()?.masks), { timeout: 60000 })
        .toBe(false)
      expect((await page.evaluate((id) => window.irodori.getEditHistory(id), id)).settings).toEqual(
        saved,
      )
      await activateButton(rangePreview.getByRole('button', { name: 'Cancel range', exact: true }))
      await expect(preview()).toHaveAttribute('data-gesturing', 'false')
      await settled()
      await expect
        .poll(() => analysis.evaluate((observer) => observer.latest()?.masks), { timeout: 60000 })
        .toBe(true)
      expect((await page.evaluate((id) => window.irodori.getEditHistory(id), id)).settings).toEqual(
        saved,
      )
    } finally {
      await analysis.evaluate((observer) => observer.close())
      await analysis.dispose()
    }
    ;({ app, page } = await irodori.restart())
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
    await focusPreviewWindow(app, page)
    await ready(page, 4)
    const consoleToggle = page.getByTestId('console-toggle')
    if ((await consoleToggle.getAttribute('aria-expanded')) !== 'true')
      await activateButton(consoleToggle)
    // Match the original undecorated photograph and viewport after the harness's larger restart window.
    await navigateInspector(page, 'Light')
    const clipping = page.getByRole('button', { name: 'Canvas channel clipping', exact: true })
    if ((await clipping.getAttribute('aria-pressed')) === 'true') await activateButton(clipping)
    await preview().focus()
    await preview().press('1')
    await expect(viewport()).toHaveAttribute('data-scale', '1')
    await settled()
    expect((await page.evaluate((id) => window.irodori.getEditHistory(id), id)).settings).toEqual(
      saved,
    )
    expect(patch(await capture(), croppedAfter, nearest)).toBeLessThanOrEqual(1)
  },
)

test('uncommitted range gestures advance preview ownership and keep confirmed workspace selection on Cancel', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  await ready(page, 0)
  const prior = crypto.randomUUID(),
    other = crypto.randomUUID()
  await page.evaluate(
    ({ photoId, prior, other }) =>
      window.irodori.mutateMasks(photoId, 0, {
        operations: [
          { kind: 'create', id: prior, name: 'Prior selection' },
          { kind: 'create', id: other, name: 'Other selection' },
        ],
      }),
    { photoId, prior, other },
  )
  await ready(page, 1)
  await navigateInspector(page, 'Masks')
  await activateButton(page.locator('[data-mask-select][title="Prior selection"]'))
  await maskDetailTab(page, 'Coverage')
  const selectedWorkspaceId = () =>
    page.evaluate(async () => (await window.irodori.getWorkspaceState()).state?.masks.selectedId)
  await expect.poll(selectedWorkspaceId).toBe(prior)
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const confirmed = (await history()).settings
  const preview = page.getByTestId('main-preview')
  const epochBefore = Number(await preview.getAttribute('data-editing-epoch'))
  const panel = await createRange(page, 'Color')
  await expect(preview).toHaveAttribute('data-gesturing', 'true')
  await expect(
    page.getByRole('combobox', { name: 'Coverage inspection', exact: true }),
  ).toBeDisabled()
  await panel.getByText('Enter color', { exact: true }).press('Enter')
  await panel.getByRole('textbox', { name: 'Sample color value', exact: true }).fill('#449944')
  await activateButton(panel.getByRole('button', { name: 'Use color', exact: true }))
  await expect(panel.getByRole('button', { name: 'Create mask', exact: true })).toBeEnabled({
    timeout: 60000,
  })
  const epochWithColor = Number(await preview.getAttribute('data-editing-epoch'))
  expect(epochWithColor).toBeGreaterThan(epochBefore)
  await activateButton(panel.getByRole('button', { name: 'Add color sample', exact: true }))
  await panel.getByText('Sample position', { exact: true }).press('Enter')
  await activateButton(panel.getByRole('button', { name: 'Sample this position', exact: true }))
  await expect(panel.getByRole('button', { name: 'Color sample 2', exact: true })).toBeVisible({
    timeout: 60000,
  })
  expect(Number(await preview.getAttribute('data-editing-epoch'))).toBeGreaterThan(epochWithColor)
  await expect(preview).toHaveAttribute('data-gesturing', 'true')
  await expect.poll(selectedWorkspaceId).toBe(prior)
  expect((await history()).settings).toEqual(confirmed)
  await activateButton(panel.getByRole('button', { name: 'Cancel range', exact: true }))
  await expect(preview).toHaveAttribute('data-gesturing', 'false')
  await expect(page.locator('[data-mask-select][title="Prior selection"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(
    page.getByRole('combobox', { name: 'Coverage inspection', exact: true }),
  ).toBeEnabled()
  await expect.poll(selectedWorkspaceId).toBe(prior)
  expect((await history()).revision).toBe(1)
  expect((await history()).settings).toEqual(confirmed)
})
