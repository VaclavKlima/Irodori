import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { holdNormalOffscreenFence } from './hdr-presentation-gate.helpers'
import { maskCanonicalPoint } from '../src/shared/mask-geometry'
import { maskDetailTab } from './mask-panel.helpers'
import type { Page } from '@playwright/test'

async function alignment(page: Page) {
  return page.evaluate(() => {
    const photo = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
      viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!,
      overlay = document.querySelector<HTMLCanvasElement>('[data-testid="mask-coverage-overlay"]')!,
      gl = overlay.getContext('webgl2')!,
      program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
    const vector = (name: string) =>
      program
        ? Array.from(gl.getUniform(program, gl.getUniformLocation(program, name)!) as Float32Array)
        : null
    return {
      presented: JSON.parse(photo.dataset.presentedView ?? 'null') as {
        fit: boolean
        scale: number
        x: number
        y: number
      } | null,
      requested: JSON.parse(photo.dataset.requestedView ?? 'null') as {
        fit: boolean
        scale: number
        x: number
        y: number
      } | null,
      presentation: Number(photo.dataset.presentationSerial),
      overlayScale: program
        ? (gl.getUniform(program, gl.getUniformLocation(program, 'scale')!) as number)
        : null,
      overlayPan: vector('pan'),
      overlayImage: vector('imageSize'),
      overlayViewport: vector('viewport'),
      image: [Number(viewport.dataset.imageWidth), Number(viewport.dataset.imageHeight)],
      viewport: [viewport.clientWidth, viewport.clientHeight],
      overlayVisible: getComputedStyle(overlay).visibility === 'visible',
    }
  })
}
function assertAligned(value: Awaited<ReturnType<typeof alignment>>) {
  expect(value.presented).not.toBeNull()
  expect(value.overlayVisible).toBe(true)
  expect(value.overlayScale).toBe(Math.fround(value.presented!.scale))
  expect(value.overlayPan).toEqual([
    Math.fround(value.presented!.x),
    Math.fround(value.presented!.y),
  ])
  expect(value.overlayImage).toEqual(value.image.map(Math.fround))
  expect(value.overlayViewport).toEqual(value.viewport.map(Math.fround))
}

async function frames(page: Page, count = 2) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }, count)
}

test('mask coverage and brush coordinates follow completed photo presentation while zoom and pan are delayed', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
  const photo = page.getByTestId('main-preview'),
    viewport = page.getByTestId('preview-viewport'),
    overlay = page.getByTestId('mask-coverage-overlay'),
    photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    maskId = crypto.randomUUID(),
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const settled = async () => {
    await expect(photo).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
    await expect(photo).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
    await expect(photo).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await expect
      .poll(
        () =>
          photo.evaluate(
            (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        { timeout: 60000 },
      )
      .toBe(true)
  }
  await settled()
  await page.evaluate(
    ({ photoId, maskId }) =>
      window.irodori.mutateMasks(photoId, 0, {
        operations: [{ kind: 'create', id: maskId, name: 'Coverage alignment' }],
      }),
    { photoId, maskId },
  )
  await expect(photo).toHaveAttribute('data-frame-geometry-revision', '1')
  await settled()
  await navigateInspector(page, 'Masks')
  await page.getByRole('checkbox', { name: 'Show overlay', exact: true }).check()
  await maskDetailTab(page, 'Coverage')
  await activateButton(page.getByRole('button', { name: 'Paint', exact: true }))
  const size = page.getByRole('spinbutton', { name: 'Brush size value', exact: true })
  await size.fill('0.5')
  await size.press('Enter')
  await activateButton(page.getByRole('button', { name: 'Paint', exact: true }))
  await photo.focus()
  await photo.press('1')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await settled()
  await frames(page)
  await expect(overlay).toBeVisible()
  const initial = await alignment(page),
    saved = await history(),
    context = await page.evaluate((id) => window.irodori.getMaskContext(id, 1), photoId)
  assertAligned(initial)
  const gate = await holdNormalOffscreenFence(page)
  try {
    await photo.press('+')
    await expect
      .poll(async () => (await gate.evaluate((control) => control.state())).held)
      .toBe(true)
    await frames(page)
    const first = await alignment(page)
    expect(first.requested!.scale).toBeGreaterThan(initial.presented!.scale)
    expect(first.presented).toEqual(initial.presented)
    expect(first.presentation).toBe(initial.presentation)
    assertAligned(first)
    await photo.press('+')
    await photo.press('ArrowRight')
    await frames(page)
    const queued = await alignment(page)
    expect(queued.requested!.scale).toBeGreaterThan(first.requested!.scale)
    expect(queued.requested!.x).not.toBe(initial.presented!.x)
    expect(queued.presented).toEqual(initial.presented)
    assertAligned(queued)

    // A short draft at an off-center screen point must cover the photograph point the user sees.
    const box = (await viewport.boundingBox())!,
      point = { x: box.width / 2 - 100, y: box.height / 2 + 50 }
    const coverage = await page.evaluateHandle((point) => {
      const original = WebGL2RenderingContext.prototype.drawArrays
      const observed: number[] = []
      WebGL2RenderingContext.prototype.drawArrays = function (
        this: WebGL2RenderingContext,
        ...args
      ) {
        original.apply(this, args)
        if (
          !(this.canvas instanceof HTMLCanvasElement) ||
          this.canvas.dataset.testid !== 'mask-coverage-overlay'
        )
          return
        const dpr = devicePixelRatio || 1,
          pixel = new Uint8Array(4)
        this.readPixels(
          Math.floor(point.x * dpr),
          this.canvas.height - 1 - Math.floor(point.y * dpr),
          1,
          1,
          this.RGBA,
          this.UNSIGNED_BYTE,
          pixel,
        )
        observed.push(pixel[3])
        if (observed.length > 128) throw new Error('Coverage observation exceeded its bound.')
      }
      return {
        read: () => observed.at(-1) ?? 0,
        close: () => {
          WebGL2RenderingContext.prototype.drawArrays = original
        },
      }
    }, point)
    try {
      await activateButton(page.getByRole('button', { name: 'Paint', exact: true }))
      await page.mouse.move(box.x + point.x, box.y + point.y)
      await page.mouse.down()
      await expect(photo).toHaveAttribute('data-gesturing', 'true')
      await expect.poll(() => coverage.evaluate((control) => control.read())).toBeGreaterThan(80)
      const cursor = viewport.locator('[class*="brushCursor"]')
      await expect(cursor).toBeVisible()
      const cursorBox = (await cursor.boundingBox())!,
        diameter =
          0.005 *
          Math.min(context.geometry.canonicalWidth, context.geometry.canonicalHeight) *
          initial.presented!.scale
      expect(cursorBox.x + cursorBox.width / 2).toBeCloseTo(box.x + point.x, 0)
      expect(cursorBox.y + cursorBox.height / 2).toBeCloseTo(box.y + point.y, 0)
      expect(cursorBox.width).toBeCloseTo(diameter, 0)
      expect(cursorBox.height).toBeCloseTo(diameter, 0)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect(photo).toHaveAttribute('data-gesturing', 'false')
      expect(await history()).toEqual(saved)
    } finally {
      await page.mouse.up()
      await coverage.evaluate((control) => control.close())
      await coverage.dispose()
    }
    await gate.evaluate((control) => control.release())
    for (let i = 0; i < 8; i++) {
      await frames(page, 1)
      assertAligned(await alignment(page))
    }
    await settled()
    await frames(page)
    const completed = await alignment(page)
    expect(completed.presented).toEqual(completed.requested)
    assertAligned(completed)
    expect(await history()).toEqual(saved)
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.evaluate((control) => control.close())
    await gate.dispose()
  }
})

test('equal-sized RAW source replacement never overlays new coverage geometry on the old photograph', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
  const photo = page.getByTestId('main-preview'),
    photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    maskId = crypto.randomUUID()
  const settled = async () => {
    await expect(photo).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
    await expect(photo).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
    await expect(photo).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await expect
      .poll(
        () =>
          photo.evaluate(
            (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        { timeout: 60000 },
      )
      .toBe(true)
  }
  await settled()
  const context = await page.evaluate((id) => window.irodori.getMaskContext(id, 0), photoId),
    center = maskCanonicalPoint(
      { x: context.width * 0.3, y: context.height * 0.4 },
      context.geometry,
    )
  await page.evaluate(
    ({ photoId, maskId, center }) =>
      window.irodori.mutateMasks(photoId, 0, {
        operations: [
          { kind: 'create', id: maskId, name: 'Rotating coverage' },
          {
            kind: 'stroke',
            id: maskId,
            stroke: { mode: 'add', radius: 0.02, feather: 0.4, points: [center] },
          },
        ],
      }),
    { photoId, maskId, center },
  )
  await expect(photo).toHaveAttribute('data-frame-geometry-revision', '1')
  await settled()
  await navigateInspector(page, 'Masks')
  const initial = await photo.evaluate((element) => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
      return {
        presented: JSON.parse(element.dataset.presentedView!) as {
          scale: number
          x: number
          y: number
        },
        image: [Number(viewport.dataset.imageWidth), Number(viewport.dataset.imageHeight)],
        viewport: [viewport.clientWidth, viewport.clientHeight],
      }
    }),
    sourceIdentity = await photo.getAttribute('data-presented-source-identity'),
    saved = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId),
    savedContent = await page.evaluate(
      async (id) => (await window.irodori.getEdits(id)).maskContent,
      photoId,
    ),
    // Full-frame 180-degree rotation preserves dimensions and mirrors these output points.
    points = [
      { x: 0.3, y: 0.4 },
      { x: 0.7, y: 0.6 },
    ].map((point) => ({
      x:
        initial.viewport[0] / 2 +
        initial.presented!.x +
        (point.x - 0.5) * initial.image[0] * initial.presented!.scale,
      y:
        initial.viewport[1] / 2 +
        initial.presented!.y +
        (point.y - 0.5) * initial.image[1] * initial.presented!.scale,
    }))
  expect(sourceIdentity).toBeTruthy()
  expect(savedContent?.length).toBeGreaterThan(0)
  const coverage = await page.evaluateHandle((points) => {
    const original = WebGL2RenderingContext.prototype.drawArrays
    let latest: number[] = [],
      draws = 0
    WebGL2RenderingContext.prototype.drawArrays = function (this: WebGL2RenderingContext, ...args) {
      original.apply(this, args)
      if (
        !(this.canvas instanceof HTMLCanvasElement) ||
        this.canvas.dataset.testid !== 'mask-coverage-overlay'
      )
        return
      const canvas = this.canvas
      latest = points.map((point) => {
        const pixel = new Uint8Array(4)
        this.readPixels(
          Math.floor(point.x * devicePixelRatio),
          canvas.height - 1 - Math.floor(point.y * devicePixelRatio),
          1,
          1,
          this.RGBA,
          this.UNSIGNED_BYTE,
          pixel,
        )
        return pixel[3]
      })
      if (++draws > 128) throw new Error('Coverage observation exceeded its bound.')
    }
    return {
      read: () => latest,
      close: () => {
        WebGL2RenderingContext.prototype.drawArrays = original
      },
    }
  }, points)
  try {
    await page.getByRole('checkbox', { name: 'Show overlay', exact: true }).check()
    await expect.poll(() => coverage.evaluate((control) => control.read()[0])).toBeGreaterThan(80)
    expect((await coverage.evaluate((control) => control.read()))[1]).toBe(0)
    assertAligned(await alignment(page))
    const gate = await holdNormalOffscreenFence(page)
    try {
      await page.evaluate(({ photoId, crop }) => window.irodori.updateEdits(photoId, { crop }, 1), {
        photoId,
        crop: { ...saved.settings.crop, quarterTurns: 2 as const },
      })
      await expect
        .poll(async () => (await gate.evaluate((control) => control.state())).held, {
          timeout: 60000,
        })
        .toBe(true)
      await frames(page)
      const pending = await alignment(page)
      if (pending.overlayVisible) {
        await expect(photo).toHaveAttribute('data-presented-source-identity', sourceIdentity!)
        expect(pending.presented).toEqual(initial.presented)
        assertAligned(pending)
        const alpha = await coverage.evaluate((control) => control.read())
        expect(alpha[0]).toBeGreaterThan(80)
        expect(alpha[1]).toBe(0)
      }
      await gate.evaluate((control) => control.release())
      await expect(photo).toHaveAttribute('data-frame-geometry-revision', '2')
      await settled()
      await expect.poll(() => coverage.evaluate((control) => control.read()[1])).toBeGreaterThan(80)
      expect((await coverage.evaluate((control) => control.read()))[0]).toBe(0)
      const completed = await alignment(page)
      assertAligned(completed)
      expect(completed.image).toEqual(initial.image)
      expect(await photo.getAttribute('data-presented-source-identity')).not.toBe(sourceIdentity)
      const final = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
      expect(final.revision).toBe(2)
      expect(final.snapshots).toHaveLength(saved.snapshots.length + 1)
      expect(final.settings.crop.quarterTurns).toBe(2)
      expect(final.settings.maskStack).toEqual(saved.settings.maskStack)
      expect(
        await page.evaluate(async (id) => (await window.irodori.getEdits(id)).maskContent, photoId),
      ).toEqual(savedContent)
      await page.screenshot({ path: test.info().outputPath('rotated-mask-coverage.png') })
    } finally {
      await gate.evaluate((control) => control.release())
      await gate.evaluate((control) => control.close())
      await gate.dispose()
    }
  } finally {
    await coverage.evaluate((control) => control.close())
    await coverage.dispose()
  }
})
