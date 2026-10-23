import { expect, type Locator, type Page } from '@playwright/test'

export function holdPreviewFrame(viewport: Locator) {
  return viewport.evaluateHandle(async (el) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const request = window.requestAnimationFrame
    const cancel = window.cancelAnimationFrame
    const heldId = 2147483647
    const state = { held: false, cancelled: false, restore: () => {} }
    window.requestAnimationFrame = (callback) => {
      if (state.held) return request(callback)
      state.held = true
      return heldId
    }
    window.cancelAnimationFrame = (id) => {
      if (id === heldId) state.cancelled = true
      else cancel(id)
    }
    state.restore = () => {
      window.requestAnimationFrame = request
      window.cancelAnimationFrame = cancel
    }
    el.dispatchEvent(new WheelEvent('wheel', { cancelable: true, deltaX: 2, deltaY: 1 }))
    window.requestAnimationFrame = request
    return state
  })
}

export async function verifyPreviewWheel(page: Page, viewport: Locator, zoom: Locator) {
  const view = () =>
    viewport.evaluate((el) => ({
      scale: Number(el.dataset.scale),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    }))
  await zoom.selectOption('fit')
  const fit = await view()
  await viewport.hover()
  await page.mouse.wheel(45, 30)
  expect(await view()).toEqual(fit)
  const consumed = await viewport.evaluate((el) => {
    const wheel = new WheelEvent('wheel', { cancelable: true, ctrlKey: true, deltaX: 20 })
    el.dispatchEvent(wheel)
    return wheel.defaultPrevented
  })
  expect(consumed).toBe(true)
  expect(await view()).toEqual(fit)
  await expect(zoom).toHaveValue('fit')

  await zoom.selectOption('1')
  await viewport.hover()
  await page.mouse.wheel(45, 30)
  await expect.poll(view).toEqual({ scale: 1, x: -45, y: -30 })
  const burst = await viewport.evaluate(async (el) => {
    const canvas = el.querySelector('canvas')!
    const box = el.getBoundingClientRect()
    const overlay = el.querySelector<HTMLCanvasElement>('[data-testid="clipping-overlay"]')
    const context = overlay?.getContext('2d')
    const clear = context?.clearRect
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!
    const height = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')!
    let overlayClears = 0
    let overlayResizes = 0
    if (overlay) {
      for (const [name, property] of [
        ['width', width],
        ['height', height],
      ] as const)
        Object.defineProperty(overlay, name, {
          configurable: true,
          get: () => property.get!.call(overlay),
          set: (value: number) => {
            overlayResizes++
            property.set!.call(overlay, value)
          },
        })
    }
    if (context && clear)
      context.clearRect = (...args) => {
        overlayClears++
        clear.apply(context, args)
      }
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const draws = () =>
      canvas.dataset.frames !== undefined
        ? Number(canvas.dataset.frames)
        : performance.getEntriesByName('luma.preview.presentation').length
    try {
      await frame()
      const beforeDraws = draws()
      overlayClears = 0
      overlayResizes = 0
      const before = { x: Number(el.dataset.panX), y: Number(el.dataset.panY) }
      for (let i = 0; i < 20; i++)
        el.dispatchEvent(new WheelEvent('wheel', { cancelable: true, deltaX: 2, deltaY: 1 }))
      let anchor = { x: 0, y: 0 }
      for (let i = 0; i < 20; i++) {
        const event = new WheelEvent('wheel', {
          cancelable: true,
          ctrlKey: true,
          deltaY: -2,
          clientX: box.left + box.width / 2 + 50,
          clientY: box.top + box.height / 2 + 25,
        })
        anchor = {
          x: event.clientX - box.left - box.width / 2,
          y: event.clientY - box.top - box.height / 2,
        }
        el.dispatchEvent(event)
      }
      await frame()
      const firstFrameDraws = draws() - beforeDraws
      await frame()
      return {
        firstFrameDraws,
        totalDraws: draws() - beforeDraws,
        overlayClears: context ? overlayClears : null,
        overlayResizes,
        before,
        anchor,
      }
    } finally {
      if (context && clear) context.clearRect = clear
      if (overlay) {
        Reflect.deleteProperty(overlay, 'width')
        Reflect.deleteProperty(overlay, 'height')
      }
    }
  })
  expect(burst.firstFrameDraws).toBe(1)
  expect(burst.totalDraws).toBe(1)
  if (burst.overlayClears !== null) expect(burst.overlayClears).toBe(1)
  expect(burst.overlayResizes).toBe(0)
  const after = await view()
  expect(after.scale).toBeCloseTo(Math.exp(0.4), 5)
  expect((burst.anchor.x - after.x) / after.scale).toBeCloseTo(
    burst.anchor.x - burst.before.x + 40,
    5,
  )
  expect((burst.anchor.y - after.y) / after.scale).toBeCloseTo(
    burst.anchor.y - burst.before.y + 20,
    5,
  )

  await zoom.selectOption('fit')
  await zoom.selectOption('1')
  await viewport.hover()
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 30)
  await page.keyboard.up('Shift')
  await expect.poll(view).toEqual({ scale: 1, x: -30, y: 0 })
  await viewport.evaluate((el) =>
    el.dispatchEvent(
      new WheelEvent('wheel', { cancelable: true, shiftKey: true, deltaX: 10, deltaY: 20 }),
    ),
  )
  await expect.poll(view).toEqual({ scale: 1, x: -40, y: -20 })

  await zoom.selectOption('fit')
  await zoom.selectOption('1')
  await viewport.hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await view()).scale).toBeCloseTo(1.1, 5)

  await zoom.selectOption('1')
  const mouseSteps = await viewport.evaluate(async (el) => {
    const box = el.getBoundingClientRect()
    const scales: number[] = []
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'Control' }))
    try {
      for (const deltaY of [-100, -120, -240, 100, 120, 240]) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            cancelable: true,
            ctrlKey: true,
            deltaY,
            clientX: box.left + box.width / 2 + 50,
            clientY: box.top + box.height / 2 + 25,
          }),
        )
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        scales.push(Number(el.dataset.scale))
      }
    } finally {
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    }
    return scales
  })
  for (const [i, steps] of [1, 2, 3, 2, 1, 0].entries())
    expect(mouseSteps[i]).toBeCloseTo(1.1 ** steps, 5)

  await zoom.selectOption('1')

  const modifierScales = await viewport.evaluate(async (el) => {
    const scales: number[] = []
    const box = el.getBoundingClientRect()
    const pinch = async () => {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          cancelable: true,
          ctrlKey: true,
          deltaY: -20,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
        }),
      )
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      scales.push(Number(el.dataset.scale))
    }
    // Key release keeps native pinch sensitivity; pointer modifiers establish physical Control.
    await pinch()
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, ctrlKey: true }))
    await pinch()
    window.dispatchEvent(new Event('blur'))
    await pinch()
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'Control' }))
    document.dispatchEvent(new Event('visibilitychange'))
    await pinch()
    return scales
  })
  let expected = 1
  for (const [i, physicalControl] of [false, true, false, false].entries()) {
    expected *= physicalControl ? 1.1 ** 0.2 : Math.exp(0.2)
    expect(modifierScales[i]).toBeCloseTo(expected, 5)
  }
}
