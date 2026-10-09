import { test, expect } from './electron.fixture'
import { setupMergePreview as setup } from './merge-preview.helpers'
import { focusPreviewWindow, verifyLockedPan } from './preview-pan.helpers'
import { holdPreviewFrame, verifyPreviewWheel } from './preview-wheel.helpers'

test('scroll pans without zooming and mixed gesture bursts present once in merge review', async ({
  luma,
}) => {
  const { viewport, zoom } = await setup(luma.app, luma.page)
  await verifyPreviewWheel(luma.page, viewport, zoom)
})

test('mouse panning hides and locks the cursor without dismissing merge on Escape', async ({
  luma,
}) => {
  const { viewport, zoom } = await setup(luma.app, luma.page)
  await verifyLockedPan(luma.app, luma.page, viewport, zoom)
  await expect(luma.page.getByRole('dialog')).toBeVisible()
})

test('native pixel scale, pointer anchoring, bounded drag and scoped zoom shortcuts', async ({
  luma,
}) => {
  const { page, app } = luma,
    { viewport, zoom, view } = await setup(app, page)
  const box = (await viewport.boundingBox())!
  expect((await view()).scale).toBeCloseTo(Math.min(1, box.width / 1600, box.height / 1000), 5)
  await zoom.selectOption('1')
  const image = page.getByTestId('merge-preview')
  await expect(image).toHaveAttribute('data-scale', '1')
  await expect(image).toHaveAttribute('data-image-width', '1600')
  await expect(image).toHaveAttribute('data-image-height', '1000')
  expect((await image.boundingBox())!.width).toBeCloseTo(box.width, 3)
  expect((await image.boundingBox())!.height).toBeCloseTo(box.height, 3)
  const pointer = { x: box.x + box.width / 2 + 70, y: box.y + box.height / 2 + 45 },
    before = await view()
  await page.mouse.move(pointer.x, pointer.y)
  await viewport.evaluate((el) =>
    el.addEventListener(
      'wheel',
      (event) => {
        const wheel = event as WheelEvent,
          box = el.getBoundingClientRect()
        el.dataset.anchorX = String(wheel.clientX - box.left - box.width / 2)
        el.dataset.anchorY = String(wheel.clientY - box.top - box.height / 2)
      },
      { once: true },
    ),
  )
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -140)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await view()).scale).toBeGreaterThan(1)
  const after = await view()
  expect(after.scale).toBeCloseTo(Math.exp(1.4), 5)
  const anchor = await viewport.evaluate((el) => ({
    x: Number(el.dataset.anchorX),
    y: Number(el.dataset.anchorY),
  }))
  expect((anchor.x - before.x) / before.scale).toBeCloseTo((anchor.x - after.x) / after.scale, 5)
  expect((anchor.y - before.y) / before.scale).toBeCloseTo((anchor.y - after.y) / after.scale, 5)
  await zoom.selectOption('1')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(viewport).toHaveAttribute('data-dragging', 'true')
  await page.mouse.move(box.x + box.width + 500, box.y + box.height + 300)
  await page.mouse.up()
  await expect.poll(async () => (await view()).x).toBeCloseTo((1600 - box.width) / 2, 4)
  await expect.poll(async () => (await view()).y).toBeCloseTo((1000 - box.height) / 2, 4)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await viewport.focus()
  await viewport.press('0')
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await viewport.press('1')
  await viewport.press('ArrowRight')
  expect((await view()).x).toBe(-40)
  await viewport.press('Shift+ArrowDown')
  expect((await view()).y).toBe(-120)
  await viewport.press('+')
  await expect(viewport).toHaveAttribute('data-scale', '2')
  await viewport.press('-')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await viewport.dblclick()
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await viewport.dblclick()
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await zoom.selectOption('32')
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }),
  ).toBeDisabled()
  await viewport.dispatchEvent('wheel', { deltaY: -200, ctrlKey: true })
  await expect(viewport).toHaveAttribute('data-scale', '32')
  expect(
    await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getType() === 'window')
        .map((w) => w.getZoomFactor()),
    ),
  ).toEqual([1])
})

test('comparison, overlay and native revisions retain zoom and normalized framing', async ({
  luma,
}) => {
  const { page, app } = luma,
    { control, viewport, zoom, view } = await setup(app, page)
  await zoom.selectOption('1')
  await viewport.focus()
  await viewport.press('ArrowLeft')
  await viewport.press('ArrowUp')
  const before = await view()
  await page.getByRole('checkbox', { name: 'Show deghost overlay' }).check()
  const image = page.getByTestId('merge-preview')
  await expect(image).toHaveAttribute('data-overlay', 'true')
  await expect(image).toHaveAttribute('data-pan-x', String(before.x))
  await expect(image).toHaveAttribute('data-pan-y', String(before.y))
  await page.getByRole('button', { name: 'Show prepared reference' }).click()
  expect(await view()).toEqual(before)
  await expect(image).toHaveAttribute('data-overlay', 'false')
  await expect(image).toHaveAttribute('data-comparison', 'true')
  await page.getByRole('button', { name: 'Show merged result' }).click()
  expect(await view()).toEqual(before)
  await control.evaluate((c) => c.hold(1))
  await page.getByRole('checkbox', { name: 'Auto Crop', exact: true }).uncheck()
  await expect(viewport).toHaveAttribute('data-ready', 'false')
  await expect(image).toBeHidden()
  await expect(zoom).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  const consumed = await viewport.evaluate((el) => {
    const wheel = new WheelEvent('wheel', { cancelable: true, deltaY: -200, ctrlKey: true })
    el.dispatchEvent(wheel)
    return wheel.defaultPrevented
  })
  expect(consumed).toBe(false)
  expect(await view()).toEqual(before)
  await expect.poll(async () => (await control.evaluate((c) => c.state())).calls.length).toBe(2)
  await control.evaluate((c) => c.release(1))
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  const after = await view()
  expect(after.scale).toBe(before.scale)
  expect(after.x).toBe((before.x * 800) / 1600)
  expect(after.y).toBe((before.y * 600) / 1000)
  await expect(image).toHaveAttribute('data-image-width', '800')
  await page
    .getByRole('complementary', { name: 'Merge sources' })
    .getByRole('button')
    .first()
    .click()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).revision).toBe(2)
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  expect(await view()).toEqual(after)
  await page.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('noise')
  await expect.poll(async () => (await control.evaluate((c) => c.state())).revision).toBe(3)
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  expect(await view()).toEqual(after)
  await page.getByRole('button', { name: 'Fit merge preview' }).click()
  await page.getByRole('checkbox', { name: 'Auto Align', exact: true }).uncheck()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).revision).toBe(4)
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await viewport.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await control.evaluate((c) => c.state())).disposed).toBeGreaterThan(0)
})

test('stale native replies cannot enable Merge, and failed or invalid frames retry through a new revision', async ({
  luma,
}) => {
  const { page, app } = luma,
    { control, viewport, view, open } = await setup(app, page, 1600, 1000, true)
  await control.evaluate((c) => c.hold(1))
  await page.getByRole('checkbox', { name: 'Auto Crop', exact: true }).uncheck()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).calls.length).toBe(2)
  await control.evaluate((c) => c.release(0))
  await expect(viewport).toHaveAttribute('data-ready', 'false')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  await control.evaluate((c) => c.release(1))
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await viewport.focus()
  await viewport.press('1')
  const before = await view()
  await control.evaluate((c) => c.fail(2))
  await page.getByRole('checkbox', { name: 'Auto Align', exact: true }).uncheck()
  await expect(page.getByRole('alert')).toHaveText('Injected native render failure.')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  await control.evaluate((c) => c.mismatch(3))
  await page.getByRole('button', { name: 'Retry preview' }).click()
  await expect(page.getByRole('alert')).toContainText('dimensions do not match')
  await expect(page.getByTestId('merge-preview')).toBeHidden()
  await page.getByRole('button', { name: 'Retry preview' }).click()
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  expect(await view()).toEqual(before)
  const state = await control.evaluate((c) => c.state())
  expect(state.calls.map((c) => c.revision)).toEqual([0, 1, 2, 3, 4])
  expect(state.calls.every((c) => c.arguments === 2)).toBe(true)
  await viewport.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await open('Stack for noise reduction…')
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await expect(viewport).toHaveAttribute('data-fit', 'true')
})

test('pointer capture cleans up on cancellation, blur, loading and resize; fields and panels keep their controls', async ({
  luma,
}) => {
  const { page, app } = luma,
    { control, viewport, zoom, view, native } = await setup(app, page, 1600, 1000, false, 24)
  await focusPreviewWindow(app, page)
  await zoom.selectOption('1')
  async function begin() {
    const box = (await viewport.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await expect(viewport).toHaveAttribute('data-dragging', 'true')
    await expect
      .poll(() => viewport.evaluate((el) => document.pointerLockElement === el))
      .toBe(true)
  }
  async function released() {
    await expect(viewport).toHaveAttribute('data-dragging', 'false')
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true)
  }
  await begin()
  await viewport.dispatchEvent('pointercancel', { pointerId: 1 })
  await released()
  await page.mouse.up()
  await begin()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await released()
  await page.mouse.up()
  await begin()
  await native.evaluate((w) => w.setContentSize(1200, 760))
  await released()
  await page.mouse.up()
  await native.evaluate((w) => w.setContentSize(1100, 700))
  await control.evaluate((c) => c.hold(1))
  await begin()
  await page
    .getByRole('checkbox', { name: 'Auto Align', exact: true })
    .evaluate((el) => (el as HTMLInputElement).click())
  await released()
  expect(await viewport.evaluate((el) => el.hasPointerCapture(1))).toBe(false)
  await page.mouse.up()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).calls.length).toBe(2)
  await control.evaluate((c) => c.release(1))
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  const before = await view(),
    strength = page.getByRole('spinbutton', { name: 'Deghost strength value' })
  await strength.fill('72')
  await strength.press('ArrowLeft')
  await strength.press('Escape')
  await expect(strength).toHaveValue('50')
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await view()).toEqual(before)
  const panel = page.getByRole('complementary', { name: 'Merge sources' })
  await panel.hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await view()).toEqual(before)
  const bounds = (await page.getByRole('dialog').boundingBox())!
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1100)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700)
  await viewport.focus()
  await viewport.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const [width, height] of [
  [80, 48],
  [900, 1800],
]) {
  test(`Fit uses actual decoded ${width} × ${height} pixels without upscaling`, async ({
    luma,
  }) => {
    const { page, app } = luma,
      { viewport, view, native } = await setup(app, page, width, height)
    const box = (await viewport.boundingBox())!,
      fit = Math.min(1, box.width / width, box.height / height)
    expect((await view()).scale).toBeCloseTo(fit, 5)
    await expect(page.getByTestId('merge-preview')).toHaveAttribute(
      'data-image-width',
      String(width),
    )
    await expect(page.getByTestId('merge-preview')).toHaveAttribute(
      'data-scale',
      String((await view()).scale),
    )
    await native.evaluate((w) => w.setContentSize(1200, 760))
    const resized = (await viewport.boundingBox())!
    await expect
      .poll(async () => (await view()).scale)
      .toBeCloseTo(Math.min(1, resized.width / width, resized.height / height), 5)
  })
}

for (const fallback of [false, true]) {
  test(`native pixels, overlay alignment and 800% grid survive pan and resize (${fallback ? 'Canvas2D' : 'WebGL2'})`, async ({
    luma,
  }) => {
    const { app, page } = luma
    if (fallback)
      await page.evaluate(() => {
        const getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
          if (args[0] === 'webgl2') return null
          return Reflect.apply(getContext, this, args)
        } as typeof getContext
      })
    const { zoom, viewport, view, native } = await setup(
      app,
      page,
      1600,
      1000,
      false,
      2,
      false,
      true,
    )
    const canvas = page.getByTestId('merge-preview')
    await expect(canvas).toHaveAttribute('data-backend', fallback ? 'canvas2d' : 'webgl2')
    async function colors() {
      return canvas.evaluate((el) => {
        const canvas = el as HTMLCanvasElement
        const snapshot = document.createElement('canvas')
        snapshot.width = canvas.width
        snapshot.height = canvas.height
        const context = snapshot.getContext('2d')!
        context.drawImage(canvas, 0, 0)
        const sample = (x: number) => [
          ...context.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data,
        ]
        const patch = context.getImageData(32, 32, 40, 40).data
        const reds = Array.from({ length: patch.length / 4 }, (_, i) => patch[i * 4])
        return {
          left: sample(30),
          right: sample(canvas.width - 30),
          minimum: Math.min(...reds),
          maximum: Math.max(...reds),
        }
      })
    }
    await zoom.selectOption('1')
    await expect(canvas).toHaveAttribute('data-scale', '1')
    expect((await colors()).left).toEqual([100, 100, 100, 255])
    await page.getByRole('checkbox', { name: 'Show deghost overlay' }).check()
    await expect(canvas).toHaveAttribute('data-overlay', 'true')
    const tinted = await colors()
    expect(tinted.left[0]).toBeGreaterThan(115)
    expect(tinted.left[1]).toBeLessThan(80)
    expect(tinted.right).toEqual([100, 100, 100, 255])
    await page.getByRole('button', { name: 'Show prepared reference' }).click()
    await expect(canvas).toHaveAttribute('data-comparison', 'true')
    expect((await colors()).left).toEqual([65, 65, 65, 255])
    await page.getByRole('button', { name: 'Show merged result' }).click()
    await page.getByRole('checkbox', { name: 'Show deghost overlay' }).uncheck()
    for (const scale of [4, 8, 16]) {
      await zoom.selectOption(String(scale))
      await expect(canvas).toHaveAttribute('data-scale', String(scale))
      const pixels = await colors()
      expect(pixels.minimum).toBe(100)
      if (scale < 8) expect(pixels.maximum).toBe(100)
      else expect(pixels.maximum).toBeGreaterThan(100)
    }
    await viewport.focus()
    await viewport.press('ArrowLeft')
    await expect(canvas).toHaveAttribute('data-pan-x', String((await view()).x))
    expect((await colors()).maximum).toBeGreaterThan(100)
    await native.evaluate((w) => w.setContentSize(1200, 760))
    await expect
      .poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).width))
      .toBe(
        Math.round(
          (await viewport.boundingBox())!.width * (await page.evaluate(() => devicePixelRatio)),
        ),
      )
    expect((await colors()).maximum).toBeGreaterThan(100)
  })
}

test('a burst of anchored wheel events draws once and closing merge restores the main photo view', async ({
  luma,
}) => {
  const { app, page } = luma
  const { viewport, zoom } = await setup(app, page)
  const main = page.getByTestId('main-preview')
  await expect(main).toHaveAttribute('data-suspended', 'true')
  const suspended = await page.getByTestId('preview-viewport').evaluate((el) => {
    const before = { scale: el.dataset.scale, x: el.dataset.panX, y: el.dataset.panY }
    const wheel = new WheelEvent('wheel', { cancelable: true, ctrlKey: true, deltaY: -20 })
    el.dispatchEvent(wheel)
    return {
      before,
      after: { scale: el.dataset.scale, x: el.dataset.panX, y: el.dataset.panY },
      consumed: wheel.defaultPrevented,
    }
  })
  expect(suspended.consumed).toBe(false)
  expect(suspended.after).toEqual(suspended.before)
  await zoom.selectOption('1')
  const canvas = page.getByTestId('merge-preview')
  await expect(canvas).toHaveAttribute('data-scale', '1')
  const burst = await viewport.evaluate(async (el) => {
    const canvas = el.querySelector('canvas')!
    const box = el.getBoundingClientRect()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const frames = Number(canvas.dataset.frames)
    const before = Number(el.dataset.scale)
    let anchor = 0
    for (let i = 0; i < 20; i++) {
      const wheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -2,
        ctrlKey: true,
        clientX: box.left + box.width / 2 + 50,
        clientY: box.top + box.height / 2,
      })
      anchor = wheel.clientX - box.left - box.width / 2
      el.dispatchEvent(wheel)
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    return {
      draws: Number(canvas.dataset.frames) - frames,
      scale: Number(canvas.dataset.scale),
      x: Number(canvas.dataset.panX),
      before,
      anchor,
    }
  })
  expect(burst.draws).toBe(1)
  expect(burst.scale).toBeCloseTo(burst.before * Math.exp(0.4), 5)
  expect((burst.anchor - burst.x) / burst.scale).toBeCloseTo(burst.anchor / burst.before, 5)
  await viewport.press('Escape')
  await expect(main).toHaveAttribute('data-suspended', 'false')
  await expect(main).toBeVisible()
  const normal = page.getByRole('combobox', { name: 'Preview zoom', exact: true })
  await normal.selectOption('2')
  const pending = await holdPreviewFrame(page.getByTestId('preview-viewport'))
  try {
    expect(await pending.evaluate((state) => state.held)).toBe(true)
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Merge to HDR…', exact: true }).click()
    await expect(main).toHaveAttribute('data-suspended', 'true')
    await expect.poll(() => pending.evaluate((state) => state.cancelled)).toBe(true)
  } finally {
    await pending.evaluate((state) => state.restore())
    await pending.dispose()
  }
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await zoom.selectOption('1')
  const closing = await holdPreviewFrame(viewport)
  try {
    expect(await closing.evaluate((state) => state.held)).toBe(true)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => closing.evaluate((state) => state.cancelled)).toBe(true)
  } finally {
    await closing.evaluate((state) => state.restore())
    await closing.dispose()
  }
  await expect(main).toHaveAttribute('data-suspended', 'false')
  await expect(normal).toHaveValue('2')
})

test('context loss validates a replacement software surface without regenerating the master', async ({
  luma,
}) => {
  const { app, page } = luma
  const { control, viewport, zoom, view } = await setup(app, page)
  await zoom.selectOption('8')
  await viewport.focus()
  await viewport.press('ArrowLeft')
  const before = await view()
  const canvas = page.getByTestId('merge-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgl2')
  const decode = await page.evaluateHandle(() => {
    const original = HTMLImageElement.prototype.decode
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    HTMLImageElement.prototype.decode = function () {
      return wait.then(() => original.call(this))
    }
    return {
      release: () => {
        HTMLImageElement.prototype.decode = original
        release()
      },
    }
  })
  await canvas.evaluate((el) => {
    const gl = (el as HTMLCanvasElement).getContext('webgl2')!
    gl.getExtension('WEBGL_lose_context')!.loseContext()
  })
  await expect(viewport).toHaveAttribute('data-ready', 'false')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  await decode.evaluate((d) => d.release())
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await expect(canvas).toHaveAttribute('data-backend', 'canvas2d')
  await expect(canvas).toHaveAttribute('data-grid', 'true')
  expect(await view()).toEqual(before)
  expect((await control.evaluate((c) => c.state())).calls).toHaveLength(1)
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled()
})
