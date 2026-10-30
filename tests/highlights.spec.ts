import { expect, test } from '@playwright/test'
import {
  contrastModule,
  displayValue,
  highlightsModule,
  renderAdjustments,
  srgbTransform,
} from '../src/shared/adjustments'
import { validatePatch } from '../src/shared/edits'

test('highlight shoulder is monotonic, smooth at middle grey and preserves retained above-white detail', () => {
  for (const highlights of [-100, -50, 0, 50, 100]) {
    let previous = -Infinity
    let failure: { sample: number; curved: number; previous: number } | undefined
    for (let i = 0; i <= 2000; i++) {
      const y = i / 100
      const curved = highlightsModule.cpu(y, highlights)
      const direction =
        y <= 0.18 || highlights === 0 ? curved === y : highlights < 0 ? curved < y : curved > y
      if (!Number.isFinite(curved) || curved <= previous || !direction) {
        failure = { sample: y, curved, previous }
        break
      }
      previous = curved
    }
    expect(failure, `First failing Highlights sample at amount ${highlights}`).toBeUndefined()
    const epsilon = 1e-7
    expect((highlightsModule.cpu(0.18 + epsilon, highlights) - 0.18) / epsilon).toBeCloseTo(1, 5)
  }
  expect(highlightsModule.cpu(1, -100)).toBeCloseTo(0.59, 12)
  const pixels = new Float32Array([1, 1, 1, 0.25, 2, 2, 2, 0.5, 4, 4, 4, 1])
  const result = renderAdjustments(
    pixels,
    {
      saturation: 0,
      vibrance: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      exposureEv: 0,
      contrast: 0,
      highlights: -100,
    },
    srgbTransform,
  )
  expect(result[0]).toBeLessThan(result[4])
  expect(result[4]).toBeLessThan(result[8])
  expect(result[8]).toBeLessThan(255)
  expect([result[3], result[7], result[11]]).toEqual([64, 128, 255])
})

test('zero Highlights is byte-identical to prior exposure/contrast including RAW quantization', () => {
  const input = new Float32Array(4096)
  for (let i = 0; i < input.length; i++)
    input[i] = i % 4 === 3 ? (i % 256) / 255 : (i % 257) / 100 - 0.1
  for (const transform of [
    srgbTransform,
    { white: 0.7, threshold: 0.00304, offset: 0.055, quantize: true },
  ])
    for (const exposureEv of [-5, -1.25, 0, 1.5, 5])
      for (const contrast of [-100, 0, 35, 100]) {
        const expected = new Uint8ClampedArray(input.length)
        for (let i = 0; i < input.length; i += 4) {
          if (contrast === 0) {
            for (let c = 0; c < 3; c++)
              expected[i + c] = displayValue(input[i + c], exposureEv, transform)
          } else {
            const rgb = [...input.slice(i, i + 3)].map((value) =>
              Math.max(0, value * 2 ** exposureEv),
            )
            const y = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / transform.white
            const scale = y > 0 && y < 1 ? contrastModule.cpu(y, contrast) / y : 1
            for (let c = 0; c < 3; c++) expected[i + c] = displayValue(rgb[c] * scale, 0, transform)
          }
          expected[i + 3] = Math.round(input[i + 3] * 255)
        }
        expect(
          renderAdjustments(
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
          ),
        ).toEqual(expected)
      }
})

test('Highlights follows contrast and scales RGB by luminance normalized to display white', () => {
  const input = new Float32Array([0.2, 0.3, 0.5, 0.25])
  const transform = { ...srgbTransform, white: 0.8 }
  const rgb = [...input.slice(0, 3)].map((value) => value * 2)
  const y = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / transform.white
  const contrasted = 1 - 0.82 * ((1 - y) / 0.82) ** 2
  const shoulder = 0.18 + (0.82 * (contrasted - 0.18)) / (0.82 + contrasted - 0.18)
  const expected = rgb.map((value) => displayValue((value * shoulder) / y, 0, transform))
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
        highlights: -100,
      },
      transform,
    ),
  ]).toEqual([...expected, 64])
})

test('rejects invalid Highlights patches and accepts combined adjustments', () => {
  for (const highlights of [NaN, Infinity, -Infinity, -101, 101, 0.5, '10', null, undefined])
    expect(() => validatePatch({ highlights })).toThrow('Highlights')
  for (const highlights of [-100, 0, 100])
    expect(() =>
      validatePatch({
        saturation: 0,
        vibrance: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        highlights,
        exposureEv: 1.25,
        contrast: 35,
        lens: { distortion: false },
      }),
    ).not.toThrow()
})
