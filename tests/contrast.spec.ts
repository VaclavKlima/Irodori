import { expect, test } from '@playwright/test'
import {
  contrastModule,
  displayValue,
  renderAdjustments,
  srgbTransform,
} from '../src/shared/adjustments'
import { validatePatch } from '../src/shared/edits'

test('contrast is monotonic with fixed pivot and endpoints, finite extremes and exact neutral bypass', () => {
  for (const contrast of [-100, -50, 0, 50, 100]) {
    expect(contrastModule.cpu(0, contrast)).toBe(0)
    expect(contrastModule.cpu(0.18, contrast)).toBe(0.18)
    expect(contrastModule.cpu(1, contrast)).toBe(1)
    expect(contrastModule.cpu(2, contrast)).toBe(2)
    const ramp = Array.from({ length: 10001 }, (_, i) => contrastModule.cpu(i / 10000, contrast))
    const failure = ramp.findIndex(
      (value, i) => !Number.isFinite(value) || (i > 0 && value <= ramp[i - 1]),
    )
    expect(failure, `First failing Contrast sample at amount ${contrast}: ${failure / 10000}`).toBe(
      -1,
    )
  }
  expect(contrastModule.cpu(0.09, 100)).toBeCloseTo(0.045, 12)
  expect(contrastModule.cpu(0.59, 100)).toBeCloseTo(0.795, 12)
  expect(contrastModule.cpu(0.09, -100)).toBeCloseTo(0.18 / Math.sqrt(2), 12)
  const input = new Float32Array([-0.25, 0.123, 2, 0.5, 0, 0, 0, 0, 0.18, 0.18, 0.18, 1])
  for (const transform of [srgbTransform, { ...srgbTransform, quantize: true, white: 0.7 }]) {
    for (const exposureEv of [-5, -1.25, 0, 1.5, 5]) {
      const neutral = renderAdjustments(
        input,
        {
          saturation: 0,
          vibrance: 0,
          shadows: 0,
          whites: 0,
          blacks: 0,
          exposureEv,
          contrast: 0,
          highlights: 0,
        },
        transform,
      )
      for (let i = 0; i < input.length; i++)
        expect(neutral[i]).toBe(
          i % 4 === 3 ? Math.round(input[i] * 255) : displayValue(input[i], exposureEv, transform),
        )
      for (const contrast of [-100, 100]) {
        const result = renderAdjustments(
          input,
          {
            saturation: 0,
            vibrance: 0,
            shadows: 0,
            whites: 0,
            blacks: 0,
            exposureEv,
            contrast,
            highlights: 0,
          },
          transform,
        )
        expect(result[3]).toBe(128)
        expect(result[7]).toBe(0)
        expect([...result.slice(4, 7)]).toEqual([0, 0, 0])
        expect(result[0]).toBe(0)
      }
    }
  }
})

test('contrast scales exposed linear luminance together, normalized by display white', () => {
  const input = new Float32Array([0.02, 0.1, 0.3, 0.25])
  const transform = { ...srgbTransform, white: 0.8 }
  const exposed = [...input.slice(0, 3)].map((value) => value * 2)
  const y = (exposed[0] * 0.2126 + exposed[1] * 0.7152 + exposed[2] * 0.0722) / transform.white
  const curved = y <= 0.18 ? 0.18 * (y / 0.18) ** 2 : 1 - 0.82 * ((1 - y) / 0.82) ** 2
  const expected = exposed.map((value) => displayValue((value * curved) / y, 0, transform))
  expect([
    ...renderAdjustments(
      input,
      {
        saturation: 0,
        vibrance: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        exposureEv: 1,
        contrast: 100,
        highlights: 0,
      },
      transform,
    ),
  ]).toEqual([...expected, 64])
})

test('rejects invalid contrast patches while supporting combined edits', () => {
  for (const contrast of [NaN, Infinity, -101, 101, 0.5, '10', null, undefined])
    expect(() => validatePatch({ contrast })).toThrow('Contrast')
  for (const contrast of [-100, 0, 100])
    expect(() =>
      validatePatch({ contrast, exposureEv: 1.25, lens: { distortion: false } }),
    ).not.toThrow()
})
