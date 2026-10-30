import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  workingToOklab,
  oklabToWorking,
  type ColorPrimaries,
  type ColorTriple,
} from '../src/shared/color-model'
import { colorIntensity } from '../scripts/research/color-intensity-candidate'

test('D65 conversions agree with independent Decimal80 primary-derived vectors across signed SDR/HDR', async () => {
  const fixture = JSON.parse(
    await readFile('tests/fixtures/color-model-reference.json', 'utf8'),
  ) as {
    generatorSha256: string
    precision: number
    vectors: { primaries: ColorPrimaries; rgb: ColorTriple; lab: ColorTriple }[]
  }
  const generator = await readFile('scripts/research/color-reference.py')
  expect(createHash('sha256').update(generator).digest('hex')).toBe(fixture.generatorSha256)
  expect(fixture.precision).toBe(80)
  expect(fixture.vectors).toHaveLength(110)
  for (const vector of fixture.vectors) {
    const lab = workingToOklab(vector.rgb, vector.primaries)
    const rgb = oklabToWorking(vector.lab, vector.primaries)
    for (let channel = 0; channel < 3; channel++) {
      expect(
        Math.abs(lab[channel] - vector.lab[channel]),
        JSON.stringify(vector),
      ).toBeLessThanOrEqual(2e-14 + 2e-13 * Math.abs(vector.lab[channel]))
      expect(
        Math.abs(rgb[channel] - vector.rgb[channel]),
        JSON.stringify(vector),
      ).toBeLessThanOrEqual(2e-13 + 2e-12 * Math.abs(vector.rgb[channel]))
    }
  }
})

test('candidate Saturation/Vibrance agrees with independent Decimal80 operator vectors', async () => {
  const fixture = JSON.parse(
    await readFile('tests/fixtures/color-model-reference.json', 'utf8'),
  ) as {
    vectors: { primaries: ColorPrimaries; rgb: ColorTriple }[]
    intensity: { source: number; saturation: number; vibrance: number; rgb: ColorTriple }[]
  }
  expect(fixture.intensity).toHaveLength(770)
  for (const vector of fixture.intensity) {
    const source = fixture.vectors[vector.source]
    const result = colorIntensity(source.rgb, source.primaries, vector)
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(result[channel] - vector.rgb[channel]),
        JSON.stringify(vector),
      ).toBeLessThanOrEqual(2e-12 + 2e-11 * Math.abs(vector.rgb[channel]))
  }
})

test('candidate intensity preserves exact bypass and neutrals, desaturates fully, retains hue/lightness and scales with exposure', () => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    for (const rgb of [
      [-0.1, 0.2, 0.8],
      [0.9, 0.3, 0.2],
      [0.1, 0.8, 0.3],
    ] as const) {
      expect(colorIntensity(rgb, primaries, { saturation: 0, vibrance: 0 })).toBe(rgb)
      const sourceLab = workingToOklab(rgb, primaries)
      const neutral = colorIntensity(rgb, primaries, { saturation: -100, vibrance: 100 })
      expect(neutral[0]).toBe(neutral[1])
      expect(neutral[1]).toBe(neutral[2])
      expect(workingToOklab(neutral, primaries)[0]).toBeCloseTo(sourceLab[0], 12)
      for (const saturation of [-50, 0, 100])
        for (const vibrance of [-100, 0, 100]) {
          const settings = { saturation, vibrance }
          const output = colorIntensity(rgb, primaries, settings)
          const lab = workingToOklab(output, primaries)
          expect(lab[0]).toBeCloseTo(sourceLab[0], 12)
          expect(Math.atan2(lab[2], lab[1])).toBeCloseTo(Math.atan2(sourceLab[2], sourceLab[1]), 11)
          for (const scale of [1e-12, 0.0001, 0.18, 4, 16]) {
            const scaled = colorIntensity(
              rgb.map((value) => value * scale) as unknown as ColorTriple,
              primaries,
              settings,
            )
            for (let channel = 0; channel < 3; channel++)
              expect(Math.abs(scaled[channel] - output[channel] * scale)).toBeLessThanOrEqual(
                2e-12 * scale + 2e-11 * Math.abs(output[channel] * scale),
              )
          }
        }
    }
    for (const level of [-16, -1e-12, 0, 1e-12, 0.18, 1, 16]) {
      const rgb: ColorTriple = [level, level, level]
      expect(colorIntensity(rgb, primaries, { saturation: 100, vibrance: 100 })).toBe(rgb)
    }
  }
})

test('candidate vibrance boosts and reduces low relative chroma more without hue boundaries or a brightness threshold', () => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    for (const vibrance of [-100, 100]) {
      let previous = vibrance > 0 ? Infinity : -Infinity
      for (const chroma of [0.001, 0.01, 0.05, 0.2, 0.5]) {
        const source = oklabToWorking([0.8, chroma, 0], primaries)
        const result = colorIntensity(source, primaries, { saturation: 0, vibrance })
        const lab = workingToOklab(result, primaries)
        const gain = Math.hypot(lab[1], lab[2]) / chroma
        if (vibrance > 0) {
          expect(gain).toBeLessThan(previous)
          expect(gain).toBeGreaterThan(1)
        } else {
          expect(gain).toBeGreaterThan(previous)
          expect(gain).toBeLessThan(1)
        }
        previous = gain
      }
    }
    let previous: ColorTriple | undefined
    let first: ColorTriple | undefined
    for (let degree = 0; degree <= 360; degree++) {
      const angle = (degree * Math.PI) / 180
      const source = oklabToWorking([1.5, 0.2 * Math.cos(angle), 0.2 * Math.sin(angle)], primaries)
      const output = colorIntensity(source, primaries, { saturation: 100, vibrance: 100 })
      expect(output.every(Number.isFinite)).toBe(true)
      const lab = workingToOklab(output, primaries)
      first ??= lab
      const chroma = Math.hypot(first[1], first[2])
      // A uniform hue sweep is a circle in the chosen perceptual coordinates.
      // Linear RGB step lengths vary with hue and working primaries.
      expect(Math.hypot(lab[1], lab[2])).toBeCloseTo(chroma, 12)
      if (previous)
        expect(Math.hypot(lab[1] - previous[1], lab[2] - previous[2])).toBeCloseTo(
          2 * chroma * Math.sin(Math.PI / 360),
          12,
        )
      if (degree === 360)
        expect(Math.hypot(lab[1] - first[1], lab[2] - first[2])).toBeLessThan(2e-12)
      previous = lab
    }
  }
})

test('conversion retains native HDR scale, signed values and continuous neutral/hue neighborhoods', () => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    expect(workingToOklab([0, 0, 0], primaries)).toEqual([0, 0, 0])
    for (const scale of [1e-12, 0.0001, 0.18, 1, 4, 16]) {
      const neutral = workingToOklab([scale, scale, scale], primaries)
      expect(neutral[0]).toBeCloseTo(Math.cbrt(scale), 12)
      expect(Math.abs(neutral[1])).toBeLessThan(1e-13)
      expect(Math.abs(neutral[2])).toBeLessThan(1e-13)
      const reflected = workingToOklab([-scale, -scale, -scale], primaries)
      for (let channel = 0; channel < 3; channel++)
        expect(reflected[channel]).toBeCloseTo(-neutral[channel], 13)
    }
    for (let degree = 0; degree <= 360; degree++) {
      const angle = (degree * Math.PI) / 180
      const lab: ColorTriple = [1.5, 0.2 * Math.cos(angle), 0.2 * Math.sin(angle)]
      const output = oklabToWorking(lab, primaries)
      expect(output.every(Number.isFinite)).toBe(true)
      const recovered = workingToOklab(output, primaries)
      for (let channel = 0; channel < 3; channel++)
        expect(recovered[channel]).toBeCloseTo(lab[channel], 12)
    }
  }
})
