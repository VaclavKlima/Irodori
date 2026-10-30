import { expect, test } from '@playwright/test'
import {
  displayValue,
  exposureModule,
  renderAdjustments,
  srgbTransform,
} from '../src/shared/adjustments'

test('exposure multiplies linear light before clipping and preserves alpha', () => {
  expect(exposureModule.cpu(0.25, 2)).toBe(1)
  const pixels = new Float32Array([2, 0.25, -0.1, 0.5])
  expect([
    ...renderAdjustments(
      pixels,
      {
        saturation: 0,
        vibrance: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        exposureEv: -2,
        contrast: 0,
        highlights: 0,
      },
      srgbTransform,
    ),
  ]).toEqual([188, 71, 0, 128])
  expect([
    ...renderAdjustments(
      pixels,
      {
        saturation: 0,
        vibrance: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
      },
      srgbTransform,
    ),
  ]).toEqual([255, 137, 0, 128])
  expect(displayValue(0.5, -1, srgbTransform)).toBe(displayValue(0.25, 0, srgbTransform))
})
