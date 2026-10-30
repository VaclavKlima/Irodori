import { expect, test } from '@playwright/test'
import {
  shadowsModule,
  whitesModule,
  blacksModule,
  contrastModule,
  highlightsModule,
  neutralAdjustments,
  sameAdjustments,
  renderAdjustments,
  displayValue,
  srgbTransform,
} from '../src/shared/adjustments'
import { validatePatch } from '../src/shared/edits'

for (const module of [shadowsModule, whitesModule, blacksModule]) {
  test(`${module.id} is monotonic, neutral and smooth at tonal boundaries`, () => {
    for (const amount of [-100, -65, 0, 35, 100]) {
      let previous = -Infinity
      let failure: { y: number; value: number; previous: number } | undefined
      for (let i = 0; i <= 20000; i++) {
        const y = i / 10000
        const value = module.cpu(y, amount)
        const unchanged = amount === 0 || (module.id === 'whites' ? y <= 0.18 : y >= 0.18)
        if (
          !Number.isFinite(value) ||
          value < previous ||
          (unchanged && value !== y) ||
          (amount < 0 && value > y) ||
          (amount > 0 && value < y)
        ) {
          failure = { y, value, previous }
          break
        }
        previous = value
      }
      expect(failure, `First failing ${module.id} sample at ${amount}`).toBeUndefined()
      const epsilon = 1e-7
      for (const y of module.id === 'whites' ? [0.18, 1] : [0.18]) {
        const left = (module.cpu(y, amount) - module.cpu(y - epsilon, amount)) / epsilon
        const right = (module.cpu(y + epsilon, amount) - module.cpu(y, amount)) / epsilon
        expect(left).toBeCloseTo(right, 5)
      }
    }
  })
  test(`${module.id} rejects invalid patches and participates in stale-result comparisons`, () => {
    for (const value of [NaN, Infinity, -Infinity, -101, 101, 0.5, '10', null, undefined])
      expect(() => validatePatch({ [module.id]: value })).toThrow(/integer/)
    for (const value of [-100, 0, 100])
      expect(() => validatePatch({ [module.id]: value })).not.toThrow()
    expect(sameAdjustments(neutralAdjustments, { ...neutralAdjustments, [module.id]: 1 })).toBe(
      false,
    )
  })
}

test('shadows preserve black, whites retain bright detail, and blacks lift neutrally or clip safely', () => {
  expect(shadowsModule.cpu(0, 100)).toBe(0)
  expect(shadowsModule.cpu(0.09, 100)).toBeCloseTo(0.09 * Math.SQRT2, 12)
  expect(whitesModule.cpu(1, -100)).toBe(0.5)
  expect(whitesModule.cpu(2, -100)).toBe(1)
  expect(whitesModule.cpu(4, -100)).toBe(2)
  expect(blacksModule.cpu(0, 100)).toBe(0.04)
  expect(blacksModule.cpu(0.01, -100)).toBe(0)
  const input = new Float32Array([0, 0, 0, 0.25, 0.01, 0.02, 0.03, 0.5, 0.18, 0.18, 0.18, 1])
  const transform = { ...srgbTransform, white: 0.7 }
  const lifted = renderAdjustments(input, { ...neutralAdjustments, blacks: 100 }, transform)
  expect([...lifted.slice(0, 4)]).toEqual([56, 56, 56, 64])
  const clipped = renderAdjustments(input, { ...neutralAdjustments, blacks: -100 }, transform)
  expect([...clipped.slice(0, 4)]).toEqual([0, 0, 0, 64])
  expect([lifted[7], clipped[7], lifted[11], clipped[11]]).toEqual([128, 128, 255, 255])
  // Positive Blacks adds the same linear amount per channel, instead of scaling color.
  const y = (input[4] * 0.2126 + input[5] * 0.7152 + input[6] * 0.0722) / transform.white
  const pedestal = 0.04 * (1 - y / 0.18) ** 3 * transform.white
  expect([...lifted.slice(4, 7)]).toEqual(
    [...input.slice(4, 7)].map((v) => displayValue(v + pedestal, 0, transform)),
  )
})

test('neutral new controls preserve previous exposure/contrast/highlights bytes including RAW quantization', () => {
  const input = new Float32Array(4096)
  for (let i = 0; i < input.length; i++)
    input[i] = i % 4 === 3 ? (i % 256) / 255 : (i % 257) / 100 - 0.1
  for (const transform of [
    srgbTransform,
    { white: 0.7, threshold: 0.00304, offset: 0.055, quantize: true },
  ])
    for (const exposureEv of [-5, 0, 1.25, 5])
      for (const contrast of [-100, 0, 35, 100])
        for (const highlights of [-100, 0, 65, 100]) {
          const expected = new Uint8ClampedArray(input.length)
          for (let i = 0; i < input.length; i += 4) {
            if (contrast === 0 && highlights === 0) {
              for (let c = 0; c < 3; c++)
                expected[i + c] = displayValue(input[i + c], exposureEv, transform)
            } else {
              const rgb = [...input.slice(i, i + 3)].map((v) => Math.max(0, v * 2 ** exposureEv))
              const y = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / transform.white
              let scale = y > 0 && y < 1 ? contrastModule.cpu(y, contrast) / y : 1
              const contrasted = y * scale
              if (highlights !== 0 && contrasted > 0.18)
                scale *= highlightsModule.cpu(contrasted, highlights) / contrasted
              for (let c = 0; c < 3; c++)
                expected[i + c] = displayValue(rgb[c] * scale, 0, transform)
            }
            expected[i + 3] = Math.round(input[i + 3] * 255)
          }
          expect(
            renderAdjustments(
              input,
              { ...neutralAdjustments, exposureEv, contrast, highlights },
              transform,
            ),
          ).toEqual(expected)
        }
})

test('combined curve order uses normalized luminance and preserves alpha', () => {
  const input = new Float32Array([0.005, 0.03, 0.08, 0.25, 0.2, 0.6, 1.3, 0.5])
  const transform = { ...srgbTransform, white: 0.7 }
  for (const blacks of [-100, 100]) {
    const expected: number[] = []
    for (let i = 0; i < input.length; i += 4) {
      let rgb = [...input.slice(i, i + 3)].map((v) => v * 2 ** 0.5)
      for (const [module, amount] of [
        [contrastModule, 35],
        [highlightsModule, -65],
        [shadowsModule, 80],
        [whitesModule, -40],
      ] as const) {
        const y = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / transform.white
        rgb = rgb.map((v) => (v * module.cpu(y, amount)) / y)
      }
      const y = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / transform.white
      const d = ((0.04 * blacks) / 100) * Math.max(1 - y / 0.18, 0) ** 3
      rgb = rgb.map((v) => (blacks > 0 ? v + d * transform.white : (v * Math.max(0, y + d)) / y))
      expected.push(
        ...rgb.map((v) => displayValue(v, 0, transform)),
        Math.round(input[i + 3] * 255),
      )
    }
    expect([
      ...renderAdjustments(
        input,
        {
          saturation: 0,
          vibrance: 0,
          exposureEv: 0.5,
          contrast: 35,
          highlights: -65,
          shadows: 80,
          whites: -40,
          blacks,
        },
        transform,
      ),
    ]).toEqual(expected)
  }
})
