import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { applyColorIntensity, workingToCieLab } from '../src/shared/color-intensity'
import { workingToXyz, type ColorPrimaries, type ColorTriple } from '../src/shared/color-model'

test('CIE Lab/D65 intensity agrees with independent primary-derived Decimal80 vectors', async () => {
  const fixture = JSON.parse(
    await readFile('tests/fixtures/color-intensity-reference.json', 'utf8'),
  ) as {
    sources: Record<string, string>
    precision: number
    vectors: {
      primaries: ColorPrimaries
      input: ColorTriple
      output: ColorTriple
      lab: ColorTriple
      saturation: number
      vibrance: number
    }[]
  }
  expect(fixture.precision).toBe(80)
  expect(fixture.vectors).toHaveLength(924)
  for (const [file, sha] of Object.entries(fixture.sources))
    expect(
      createHash('sha256')
        .update(await readFile(`scripts/research/${file}`))
        .digest('hex'),
    ).toBe(sha)
  for (const vector of fixture.vectors) {
    const lab = workingToCieLab(vector.input, vector.primaries)
    const output = applyColorIntensity(vector.input, vector, vector.primaries)
    for (let channel = 0; channel < 3; channel++) {
      expect(
        Math.abs(output[channel] - vector.output[channel]),
        JSON.stringify(vector),
      ).toBeLessThanOrEqual(2e-12 + 2e-11 * Math.abs(vector.output[channel]))
      expect(Math.abs(lab[channel] - vector.lab[channel])).toBeLessThanOrEqual(
        2e-11 + 2e-12 * Math.abs(vector.lab[channel]),
      )
    }
  }
})

test('neutral bypass and complete desaturation preserve source values and linear luminance', () => {
  for (const primaries of ['srgb', 'rec2020'] as const)
    for (const scale of [-16, -1e-12, 0, 1e-12, 0.0001, 0.18, 1, 16]) {
      const gray: ColorTriple = [scale, scale, scale]
      expect(applyColorIntensity(gray, { saturation: 100, vibrance: 100 }, primaries)).toBe(gray)
      const rgb: ColorTriple = [0.7 * scale, 0.45 * scale, 0.3 * scale]
      expect(applyColorIntensity(rgb, { saturation: 0, vibrance: 0 }, primaries)).toBe(rgb)
      const output = applyColorIntensity(rgb, { saturation: -100, vibrance: 100 }, primaries)
      expect(output[0]).toBe(output[1])
      expect(output[1]).toBe(output[2])
      expect(Math.abs(output[0] - workingToXyz(rgb, primaries)[1])).toBeLessThanOrEqual(1e-14)
    }
})

test('full strength retains linear Y and CIE Lab hue across signed, saturated and HDR inputs', () => {
  let count = 0,
    nonfinite = 0,
    maximumYRatio = 0,
    maximumHueError = 0,
    minimumPositiveY = Infinity
  let worst: unknown
  for (const primaries of ['srgb', 'rec2020'] as const)
    for (const r of [-0.1, 0, 0.01, 0.5, 1, 16])
      for (const g of [-0.1, 0, 0.01, 0.5, 1, 16])
        for (const b of [-0.1, 0, 0.01, 0.5, 1, 16]) {
          const rgb: ColorTriple = [r, g, b]
          const inputY = workingToXyz(rgb, primaries)[1]
          const sourceLab = workingToCieLab(rgb, primaries)
          for (const saturation of [-100, -50, 0, 50, 100])
            for (const vibrance of [-100, 0, 100]) {
              const output = applyColorIntensity(rgb, { saturation, vibrance }, primaries)
              count++
              if (!output.every(Number.isFinite)) nonfinite++
              const outputY = workingToXyz(output, primaries)[1]
              const ratio = Math.abs(outputY - inputY) / (2e-12 + 2e-11 * Math.abs(inputY))
              if (ratio > maximumYRatio) {
                maximumYRatio = ratio
                worst = { rgb, primaries, saturation, vibrance, outputY, inputY }
              }
              if (inputY > 0) minimumPositiveY = Math.min(minimumPositiveY, outputY)
              if (saturation === -100 || Math.hypot(sourceLab[1], sourceLab[2]) < 1e-5) continue
              const lab = workingToCieLab(output, primaries)
              const difference = Math.atan2(lab[2], lab[1]) - Math.atan2(sourceLab[2], sourceLab[1])
              maximumHueError = Math.max(
                maximumHueError,
                Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference))),
              )
            }
        }
  // Reduce the universal checks once; all 6,480 inputs retain the same per-sample bounds.
  expect(count).toBe(6480)
  expect(nonfinite).toBe(0)
  expect(maximumYRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
  expect(minimumPositiveY).toBeGreaterThanOrEqual(-2e-12)
  expect(maximumHueError).toBeLessThan(1e-8)
})
