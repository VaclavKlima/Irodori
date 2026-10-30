import { expect, test } from '@playwright/test'
import { fitScale, normalizedSourcePoint, type View } from '../src/renderer/src/preview/geometry'
import { cropGeometry, fitCrop, identityCrop, sourcePointToCrop } from '../src/shared/crop'
import { whiteBalanceSampleArea } from '../src/shared/white-balance-picker'

test('cropped and straightened preview coordinates preserve the native picker area through Fit, 100%, zoom and pan', () => {
  const source = { width: 5496, height: 3672 },
    viewport = { width: 742, height: 431 },
    native = { x: (2271 + 0.37) / source.width, y: (2265 + 0.61) / source.height }
  let checked = 0
  for (const quarterTurns of [0, 1, 2, 3] as const)
    for (const angle of [-12.34, 0, 22.5]) {
      const settings = fitCrop(source, {
          ...identityCrop,
          quarterTurns,
          angle,
          width: 0.7,
          height: 0.8,
        }),
        crop = cropGeometry(source, settings),
        position = sourcePointToCrop(crop, native)!
      expect(position.x).toBeGreaterThan(0)
      expect(position.x).toBeLessThan(1)
      expect(position.y).toBeGreaterThan(0)
      expect(position.y).toBeLessThan(1)
      for (const scale of [fitScale(crop, viewport), 1, 4])
        for (const [x, y] of [
          [0, 0],
          [-111, 79],
          [200, -80],
        ]) {
          const view: View = { fit: scale < 1, scale, x, y },
            screen = {
              x: viewport.width / 2 + x + (position.x - 0.5) * crop.width * scale,
              y: viewport.height / 2 + y + (position.y - 0.5) * crop.height * scale,
            },
            actual = normalizedSourcePoint(screen, crop, viewport, view, crop)!
          expect(Math.abs(actual.x - native.x)).toBeLessThanOrEqual(2e-12)
          expect(Math.abs(actual.y - native.y)).toBeLessThanOrEqual(2e-12)
          for (const diameter of [7, 15, 31] as const)
            expect(
              whiteBalanceSampleArea({ ...actual, diameter }, source.width, source.height),
            ).toEqual(whiteBalanceSampleArea({ ...native, diameter }, source.width, source.height))
          checked++
        }
    }
  expect(checked).toBe(108)
})

test('cropped coordinate mapping rejects dimension mismatches, outside points and empty viewports', () => {
  const source = { width: 1200, height: 800 },
    crop = cropGeometry(source, { ...identityCrop, width: 0.5, height: 0.5 }),
    viewport = { width: 700, height: 400 },
    view = { fit: false, scale: 1, x: 0, y: 0 }
  expect(normalizedSourcePoint({ x: 350, y: 200 }, source, viewport, view, crop)).toBeNull()
  expect(normalizedSourcePoint({ x: 0, y: 0 }, crop, viewport, view, crop)).toBeNull()
  expect(
    normalizedSourcePoint({ x: 350, y: 200 }, crop, { width: 0, height: 400 }, view, crop),
  ).toBeNull()
  expect(normalizedSourcePoint({ x: 350, y: 200 }, crop, viewport, view, crop)).toEqual({
    x: 0.5,
    y: 0.5,
  })
})
