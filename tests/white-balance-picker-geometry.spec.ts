import { expect, test } from '@playwright/test'
import { normalizedSourcePoint, type Size, type View } from '../src/renderer/src/preview/geometry'
import { whiteBalanceSampleArea } from '../src/shared/white-balance-picker'

test('picker identifies the same native area in Fit, 100%, enlarged and panned views', () => {
  const image: Size = { width: 5496, height: 3672 },
    viewport = { width: 742, height: 431 }
  const expected = { x: 0.47, y: 0.53 }
  const baseline = whiteBalanceSampleArea({ ...expected, diameter: 15 }, image.width, image.height)
  for (const scale of [0.05, 1, 4])
    for (const [x, y] of [
      [0, 0],
      [-111, 79],
      [200, -80],
    ]) {
      const view: View = { fit: scale < 1, scale, x, y }
      const point = {
        x: viewport.width / 2 + x + (expected.x * image.width - image.width / 2) * scale,
        y: viewport.height / 2 + y + (expected.y * image.height - image.height / 2) * scale,
      }
      const actual = normalizedSourcePoint(point, image, viewport, view)!
      expect(actual.x).toBeCloseTo(expected.x, 14)
      expect(actual.y).toBeCloseTo(expected.y, 14)
      expect(
        whiteBalanceSampleArea({ ...actual, diameter: 15 }, image.width, image.height),
      ).toEqual(baseline)
    }
  expect(
    normalizedSourcePoint({ x: 0, y: 0 }, { width: 1, height: 1 }, viewport, {
      fit: true,
      scale: 1,
      x: 0,
      y: 0,
    }),
  ).toBeNull()
  expect(
    normalizedSourcePoint({ x: NaN, y: 0 }, image, viewport, { fit: true, scale: 1, x: 0, y: 0 }),
  ).toBeNull()
})
