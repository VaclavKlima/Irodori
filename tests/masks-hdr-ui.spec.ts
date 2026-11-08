import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { maskCanonicalPoint } from '../src/shared/mask-geometry'

test('actual RAW SDR presentation applies local masks, preserves outside pixels and restores Before and history', async ({
  irodori,
}) => {
  test.setTimeout(120000)
  const { app, page } = irodori,
    nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => window.setContentSize(1100, 700))
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
  const canvas = page.getByTestId('main-preview'),
    viewport = page.getByTestId('preview-viewport'),
    id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const settled = async () => {
    await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        { timeout: 60000 },
      )
      .toBe(true)
    await expect(page.getByTestId('preview-gpu-error')).toHaveCount(0)
    // View-only navigation can reuse a histogram's older publication serial.
    // Matching nonempty pixel keys still reject statistics from earlier mask edits.
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (element) =>
              element.dataset.analysisPending === 'false' &&
              Boolean(element.dataset.analysisKey) &&
              element.dataset.analysisKey === element.dataset.displayedAnalysisKey,
          ),
        { timeout: 30000 },
      )
      .toBe(true)
    await expect(page.getByRole('status').filter({ hasText: 'Histogram unavailable' })).toHaveCount(
      0,
    )
    await expect(
      page.getByRole('slider', { name: 'Histogram tonal value' }).locator('path[d]'),
    ).toHaveCount(3)
  }
  await settled()
  await canvas.focus()
  await canvas.press('1')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await settled()
  expect(await page.evaluate(() => window.irodori.getDisplayState())).toMatchObject({ mode: 'sdr' })
  const box = (await canvas.boundingBox())!,
    width = Math.round(box.width),
    height = Math.round(box.height),
    context = await page.evaluate((id) => window.irodori.getMaskContext(id, 0), id),
    view = await viewport.evaluate((element) => ({
      x: Number(element.dataset.panX),
      y: Number(element.dataset.panY),
    }))
  const capture = async () => {
    const png = await nativeWindow.evaluate(async (window, rect) => {
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
    }, box)
    const { data, info } = await sharp(Buffer.from(png, 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(width)
    expect(info.height).toBe(height)
    return data
  }
  const baseline = await capture(),
    canonical = (point: { x: number; y: number }) =>
      maskCanonicalPoint(
        {
          x: context.width / 2 + point.x + 0.5 - width / 2 - view.x,
          y: context.height / 2 + point.y + 0.5 - height / 2 - view.y,
        },
        context.geometry,
      )
  let inside: { x: number; y: number } | undefined
  // Select a real midtone in the visible native grid; no fabricated photographic pixels.
  for (let y = Math.floor(height * 0.35); y < height * 0.65 && !inside; y += 13)
    for (let x = Math.floor(width * 0.35); x < width * 0.65; x += 13) {
      const at = (y * width + x) * 4,
        level = (baseline[at] + baseline[at + 1] + baseline[at + 2]) / 3
      if (level > 30 && level < 180) {
        inside = { x, y }
        break
      }
    }
  expect(inside, 'The committed RAW fixture must provide a visible native midtone.').toBeDefined()
  const selected = inside!,
    center = canonical(selected),
    outside = { x: selected.x < width / 2 ? width - 40 : 40, y: selected.y },
    outsideCanonical = canonical(outside),
    short = Math.min(context.geometry.canonicalWidth, context.geometry.canonicalHeight),
    separation = Math.hypot(
      ((center.x - outsideCanonical.x) * context.geometry.canonicalWidth) / short,
      ((center.y - outsideCanonical.y) * context.geometry.canonicalHeight) / short,
    ),
    radius = 0.012,
    maskId = crypto.randomUUID()
  expect(separation).toBeGreaterThan(radius * 3)
  const changed = await page.evaluate(
    ({ id, maskId, center, radius }) =>
      window.irodori.mutateMasks(id, 0, {
        operations: [
          { kind: 'create', id: maskId, name: 'Native midtone' },
          {
            kind: 'stroke',
            id: maskId,
            stroke: { mode: 'add', radius, feather: 0.6, points: [center] },
          },
          {
            kind: 'update',
            id: maskId,
            light: {
              exposureEv: 0.8,
              contrast: 15,
              highlights: -10,
              shadows: 12,
              whites: 8,
              blacks: 5,
            },
          },
        ],
      }),
    { id, maskId, center, radius },
  )
  expect(changed.revision).toBe(1)
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1')
  await settled()
  const edited = await capture(),
    difference = (a: Buffer, b: Buffer, point: { x: number; y: number }) => {
      let maximum = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (let c = 0; c < 3; c++) {
            const at = ((point.y + dy) * width + point.x + dx) * 4 + c
            maximum = Math.max(maximum, Math.abs(a[at] - b[at]))
          }
      return maximum
    }
  expect(difference(edited, baseline, selected)).toBeGreaterThan(4)
  expect(difference(edited, baseline, outside)).toBeLessThanOrEqual(1)
  await canvas.focus()
  await canvas.press('\\')
  await expect(canvas).toHaveAttribute('data-comparison', 'before')
  await settled()
  const before = await capture()
  expect(difference(before, baseline, selected)).toBeLessThanOrEqual(1)
  expect(difference(before, baseline, outside)).toBeLessThanOrEqual(1)
  await canvas.press('\\')
  await expect(canvas).toHaveAttribute('data-comparison', 'after')
  await settled()
  expect(difference(await capture(), edited, selected)).toBeLessThanOrEqual(1)
  await page.evaluate((id) => window.irodori.undoEdit(id, 1), id)
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '2')
  await settled()
  const undone = await capture()
  expect(difference(undone, baseline, selected)).toBeLessThanOrEqual(1)
  expect(difference(undone, baseline, outside)).toBeLessThanOrEqual(1)
  await page.evaluate((id) => window.irodori.redoEdit(id, 2), id)
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '3')
  await settled()
  const restored = await capture()
  expect(difference(restored, edited, selected)).toBeLessThanOrEqual(1)
  expect(difference(restored, baseline, outside)).toBeLessThanOrEqual(1)
  expect(
    (await page.evaluate((id) => window.irodori.getEditHistory(id), id)).settings.maskStack,
  ).toEqual(changed.settings.maskStack)
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
})

test('neutral mask metadata preserves the loaded HDR histogram', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(120000)
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
  const canvas = page.getByTestId('main-preview'),
    id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    histogram = page.getByRole('region', { name: 'Histogram · After', exact: true }),
    plot = histogram.getByRole('slider', { name: 'Histogram tonal value' }),
    status = histogram.getByRole('status')
  const settled = async (revision: number) => {
    await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-frame-geometry-revision', String(revision), {
      timeout: 60000,
    })
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        { timeout: 60000 },
      )
      .toBe(true)
    await expect(page.getByTestId('preview-gpu-error')).toHaveCount(0)
  }
  const loadedHistogram = async () => {
    await expect(plot.locator('path[d]')).toHaveCount(3)
    await expect(status).toHaveText('After / Rec.2020 · HDR content')
    await expect(histogram.locator('[data-pending]')).toHaveAttribute('data-pending', 'false')
  }
  await settled(0)
  await loadedHistogram()
  const first = crypto.randomUUID(),
    second = crypto.randomUUID()
  const operations: import('../src/shared/masks').MaskOperation[][] = [
    [{ kind: 'create', id: first, name: 'Empty neutral mask' }],
    [{ kind: 'update', id: first, name: 'Renamed neutral mask' }],
    [{ kind: 'create', id: second, name: 'Second neutral mask' }],
    [{ kind: 'reorder', ids: [first, second] }],
    [{ kind: 'update', id: first, inverted: true }],
  ]
  for (const [index, batch] of operations.entries()) {
    const revision = index + 1
    await page.evaluate(
      ({ id, revision, operations }) =>
        window.irodori.mutateMasks(id, revision - 1, { operations }),
      { id, revision, operations: batch },
    )
    await settled(revision)
    await loadedHistogram()
  }
})
