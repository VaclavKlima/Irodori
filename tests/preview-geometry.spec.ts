import { expect, test } from '@playwright/test'
import {
  constrain,
  fitScale,
  INITIAL_VIEW,
  minimumScale,
  stepScale,
  wheelScale,
  wheelView,
  zoomAt,
} from '../src/renderer/src/preview/geometry'

const image = { width: 2000, height: 1000 }
const viewport = { width: 800, height: 600 }
const pointer = { x: 80, y: 30 }
const scroll = { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false }

test('fits both orientations, never enlarges small images, and supports very small viewports', () => {
  expect(fitScale(image, viewport)).toBe(0.4)
  expect(fitScale({ width: 1000, height: 2000 }, viewport)).toBe(0.3)
  expect(fitScale({ width: 80, height: 40 }, viewport)).toBe(1)
  expect(minimumScale(image, { width: 100, height: 40 })).toBe(0.04)
  expect(constrain(INITIAL_VIEW, image, viewport)).toEqual({ fit: true, scale: 0.4, x: 0, y: 0 })
})

test('keeps the image point under the pointer unchanged during zoom and clamps at edges', () => {
  const before = { fit: false, scale: 1, x: -100, y: 30 }
  const pointer = { x: 120, y: -80 }
  const after = zoomAt(before, 2, pointer, image, viewport)
  expect((pointer.x - after.x) / after.scale).toBe((pointer.x - before.x) / before.scale)
  expect((pointer.y - after.y) / after.scale).toBe((pointer.y - before.y) / before.scale)
  expect(constrain({ fit: false, scale: 1, x: 9000, y: -9000 }, image, viewport)).toEqual({
    fit: false,
    scale: 1,
    x: 600,
    y: -200,
  })
  expect(zoomAt(after, 0.1, pointer, image, viewport)).toEqual({
    fit: false,
    scale: 0.1,
    x: 0,
    y: 0,
  })
  expect(zoomAt(after, 64, pointer, image, viewport).scale).toBe(32)
})

test('preserves manual center coordinates on resize and normalizes wheel and preset steps', () => {
  const manual = { fit: false, scale: 2, x: 150, y: -80 }
  expect(constrain(manual, image, { width: 1200, height: 800 })).toEqual(manual)
  expect(constrain(manual, image, { width: 6000, height: 3000 })).toEqual({ ...manual, x: 0, y: 0 })
  expect(wheelScale(1, 1, 1, 600)).toBe(wheelScale(1, 16, 0, 600))
  expect(wheelScale(1, 1, 2, 100)).toBe(wheelScale(1, 100, 0, 600))
  expect(stepScale(0.4, 1, 0.1)).toBe(0.5)
  expect(stepScale(0.4, -1, 0.1)).toBe(0.25)
  expect(stepScale(0.1, -1, 0.04)).toBe(0.04)
  expect(stepScale(32, 1, 0.1)).toBe(32)
})

test('scroll pans both axes in CSS pixels, normalizes line and page deltas, and respects bounds', () => {
  const before = { fit: false, scale: 1, x: 0, y: 0 }
  const pan = (deltaX: number, deltaY: number, deltaMode = 0) =>
    wheelView(before, { ...scroll, deltaX, deltaY, deltaMode }, pointer, image, viewport)
  expect(pan(45, 0)).toEqual({ ...before, x: -45 })
  expect(pan(0, -60)).toEqual({ ...before, y: 60 })
  expect(pan(2, -3, 1)).toEqual(pan(32, -48))
  expect(pan(0.25, -0.25, 2)).toEqual(pan(200, -150))
  expect(pan(9000, -9000)).toEqual({ ...before, x: -600, y: 200 })
  const fit = constrain(INITIAL_VIEW, image, viewport)
  expect(wheelView(fit, { ...scroll, deltaX: 50, deltaY: 80 }, pointer, image, viewport)).toBe(fit)
  expect(wheelView(before, scroll, pointer, image, viewport)).toBe(before)
  expect(wheelView(before, { ...scroll, ctrlKey: true }, pointer, image, viewport)).toBe(before)
  expect(
    wheelView(before, { ...scroll, deltaX: 80, ctrlKey: true }, pointer, image, viewport),
  ).toBe(before)
})

test('pinch reconstructs native scale directly, anchors the pointer and retains zoom limits', () => {
  const before = { fit: false, scale: 1, x: -100, y: 30 }
  for (const factor of [0.75, 1, 2, 8]) {
    const deltaY = -100 * Math.log(factor)
    expect(wheelScale(1, deltaY, 0, viewport.height)).toBeCloseTo(factor, 12)
    const after = wheelView(before, { ...scroll, ctrlKey: true, deltaY }, pointer, image, viewport)
    expect(after.scale).toBeCloseTo(factor, 12)
    expect((pointer.x - after.x) / after.scale).toBeCloseTo(pointer.x - before.x, 12)
    expect((pointer.y - after.y) / after.scale).toBeCloseTo(pointer.y - before.y, 12)
  }
  expect(wheelScale(1, -250, 0, viewport.height)).toBe(Math.exp(2.5))
  expect(
    wheelView(before, { ...scroll, ctrlKey: true, deltaY: -10000 }, pointer, image, viewport).scale,
  ).toBe(32)
  expect(
    wheelView(before, { ...scroll, ctrlKey: true, deltaY: 10000 }, pointer, image, viewport).scale,
  ).toBe(0.1)
})

test('every event in mixed scroll and pinch bursts uses the latest bounded view', () => {
  let view = { fit: false, scale: 1, x: 0, y: 0 }
  for (let i = 0; i < 20; i++)
    view = wheelView(view, { ...scroll, deltaX: 2, deltaY: -1 }, pointer, image, viewport)
  expect(view).toEqual({ fit: false, scale: 1, x: -40, y: 20 })
  for (let i = 0; i < 20; i++)
    view = wheelView(view, { ...scroll, deltaY: -2, ctrlKey: true }, pointer, image, viewport)
  expect(view.scale).toBeCloseTo(Math.exp(0.4), 12)
  expect((pointer.x - view.x) / view.scale).toBeCloseTo(pointer.x + 40, 12)
  expect((pointer.y - view.y) / view.scale).toBeCloseTo(pointer.y - 20, 12)
  view = wheelView(view, { ...scroll, deltaX: -10, deltaY: 5 }, pointer, image, viewport)
  expect(view.x).toBeCloseTo(pointer.x - (pointer.x + 40) * Math.exp(0.4) + 10, 12)
  expect(view.y).toBeCloseTo(pointer.y - (pointer.y - 20) * Math.exp(0.4) - 5, 12)
})
