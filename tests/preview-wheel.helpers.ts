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
    let overlayClears = 0
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
        before,
        anchor,
      }
    } finally {
      if (context && clear) context.clearRect = clear
    }
  })
  expect(burst.firstFrameDraws).toBe(1)
  expect(burst.totalDraws).toBe(1)
  if (burst.overlayClears !== null) expect(burst.overlayClears).toBe(1)
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
}
