import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { applyCreativeColor, compileCreativeColor } from '../src/shared/creative-color'
import {
  applyColorMixer,
  compileColorMixer,
  colorMixerSelection,
  colorRangeDefinitions,
  colorRangeIds,
  neutralColorMixer,
  validateColorMixer,
  type ColorMixerSettings,
} from '../src/shared/color-mixer'
import {
  applyColorGrading,
  compileColorGrading,
  colorGradingWeights,
  gradingToneIds,
  neutralColorGrading,
  validateColorGrading,
  type ColorGradingSettings,
} from '../src/shared/color-grading'
import { applyColorIntensity } from '../src/shared/color-intensity'
import { creativeLab, labLightness } from '../src/shared/creative-color-lab'
import { D65_XYZ } from '../src/shared/color-intensity'
import {
  workingToXyz,
  xyzToWorking,
  type ColorPrimaries,
  type ColorTriple,
} from '../src/shared/color-model'

interface Configuration {
  mixer: ColorMixerSettings
  grading: ColorGradingSettings
  intensity: { saturation: number; vibrance: number }
}
interface Vector {
  primaries: ColorPrimaries
  input: [number, number, number]
  configuration: number
  mixed: ColorTriple
  colored: ColorTriple
  output: ColorTriple
  gradeY: number
  gradeWeights: ColorTriple
  selection: ReturnType<typeof colorMixerSelection>
}
interface Reference {
  sources: Record<string, string>
  ranges: { id: string; nominalHue: number; labHue: number; direction: [number, number] }[]
  configurations: Configuration[]
  vectors: Vector[]
  gpuVectors: Vector[]
}
const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as Reference
const compiled = reference.configurations.map((value) => ({
  mixer: compileColorMixer(value.mixer),
  grading: compileColorGrading(value.grading),
  intensity: value.intensity,
}))
const fused = reference.configurations.map((value) =>
  compileCreativeColor(value.mixer, value.intensity, value.grading),
)
const near = (actual: number, expected: number, bound: number, message: string) => {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= bound,
    `${message}: ${actual} vs ${expected}, bound ${bound}`,
  )
}
function rgbClose(actual: ColorTriple, expected: ColorTriple, message: string) {
  for (let c = 0; c < 3; c++)
    near(actual[c], expected[c], 2e-12 + 2e-11 * Math.abs(expected[c]), `${message} channel ${c}`)
}
const weights = (value: ReturnType<typeof colorMixerSelection>) =>
  colorRangeIds.map((_, index) =>
    index === value.first ? 1 - value.blend : index === value.second ? value.blend : 0,
  )
function labColor(angle: number): ColorTriple {
  const f = 76 / 116,
    a = 30 * Math.cos(angle),
    b = 30 * Math.sin(angle)
  return xyzToWorking(
    [D65_XYZ[0] * (f + a / 500) ** 3, f ** 3, D65_XYZ[2] * (f - b / 200) ** 3],
    'srgb',
  )
}
const mix = (
  patch: Partial<
    Record<
      (typeof colorRangeIds)[number],
      { hue?: number; saturation?: number; luminance?: number }
    >
  >,
) => ({
  version: 1 as const,
  ranges: Object.fromEntries(
    colorRangeIds.map((id) => [id, { ...neutralColorMixer.ranges[id], ...patch[id] }]),
  ) as ColorMixerSettings['ranges'],
})

test('mixer and three-way grading agree with 5040 independent Decimal80 stage references', () => {
  expect(reference.vectors).toHaveLength(2520)
  expect(reference.gpuVectors).toHaveLength(2520)
  for (const [name, expected] of Object.entries(reference.sources))
    expect(
      createHash('sha256')
        .update(readFileSync(new URL(`../scripts/research/${name}`, import.meta.url)))
        .digest('hex'),
    ).toBe(expected)
  for (let i = 0; i < reference.ranges.length; i++) {
    const actual = colorRangeDefinitions[i],
      expected = reference.ranges[i]
    assert.equal(actual.id, expected.id)
    assert.equal(actual.nominalHue, expected.nominalHue)
    near(actual.labHue, expected.labHue, 2e-12, 'range hue')
    for (let c = 0; c < 2; c++)
      near(actual.direction[c], expected.direction[c], 2e-14, 'range direction')
  }
  const vectors = [...reference.vectors, ...reference.gpuVectors]
  for (let i = 0; i < vectors.length; i++) {
    const value = vectors[i],
      config = compiled[value.configuration],
      selected = colorMixerSelection(value.input, value.primaries),
      expectedWeights = weights(value.selection),
      actualWeights = weights(selected)
    for (let index = 0; index < 8; index++)
      near(actualWeights[index], expectedWeights[index], 2e-12, `selection ${i}/${index}`)
    near(selected.protection, value.selection.protection, 2e-12, `protection ${i}`)
    const mixed = applyColorMixer(value.input, config.mixer, value.primaries),
      colored = applyColorIntensity(mixed, config.intensity, value.primaries),
      graded = applyColorGrading(colored, config.grading, value.primaries)
    rgbClose(mixed, value.mixed, `mixer vector ${i}`)
    rgbClose(colored, value.colored, `intensity vector ${i}`)
    rgbClose(graded, value.output, `grading vector ${i}`)
    rgbClose(
      applyCreativeColor(value.input, fused[value.configuration], value.primaries),
      value.output,
      `fused vector ${i}`,
    )
    const toneWeights = colorGradingWeights(value.gradeY, config.grading)
    for (let c = 0; c < 3; c++)
      near(toneWeights[c], value.gradeWeights[c], 2e-14, `tone weights ${i}/${c}`)
  }
})

test('neutral, unused hue and near-neutral protection bypass exactly and compiled controls freeze caller values', () => {
  const input: ColorTriple = [-0, 0.2, 16],
    neutral = compileColorMixer(neutralColorMixer),
    powerless = compileColorGrading({
      ...neutralColorGrading,
      blending: 100,
      balance: -100,
      tones: {
        shadows: { hue: 359.9, saturation: 0, luminance: 0 },
        midtones: { hue: 120, saturation: 0, luminance: 0 },
        highlights: { hue: 240, saturation: 0, luminance: 0 },
      },
    })
  expect(applyColorMixer(input, neutral, 'rec2020')).toBe(input)
  expect(applyColorGrading(input, powerless, 'rec2020')).toBe(input)
  const settings = structuredClone(reference.configurations[3].mixer),
    active = compileColorMixer(settings),
    before = applyColorMixer(input, active, 'rec2020')
  Object.assign(settings.ranges.red, { hue: -100, saturation: -100, luminance: -100 })
  rgbClose(applyColorMixer(input, active, 'rec2020'), before, 'frozen mixer')
  for (const rgb of [
    [0, 0, 0],
    [-16, -16, -16],
    [0.18, 0.18000001, 0.18],
    [16, 16, 16],
  ] as ColorTriple[]) {
    expect(applyColorMixer(rgb, active, 'srgb')).toBe(rgb)
    assert.equal(colorMixerSelection(rgb, 'srgb').protection, 0)
  }
})

test('fused controls retain the old intensity result exactly when new operators have no influence', () => {
  const pixels: ColorTriple[] = [
    [-0, 0.2, 16],
    [-1, -1, -1],
    [0, 0, 0],
    [0.18, 0.18, 0.18],
    [1e-12, 8e-12, -2e-12],
  ]
  for (const primaries of ['srgb', 'rec2020'] as const)
    for (const saturation of [-100, -35, 0, 60, 100])
      for (const vibrance of [-100, 0, 100]) {
        const intensity = { saturation, vibrance },
          controls = compileCreativeColor(neutralColorMixer, intensity, neutralColorGrading)
        for (const rgb of pixels)
          assert.deepEqual(
            applyCreativeColor(rgb, controls, primaries),
            applyColorIntensity(rgb, intensity, primaries),
          )
        const red = compileCreativeColor(
          mix({ red: { hue: 100, saturation: 100, luminance: -100 } }),
          intensity,
          neutralColorGrading,
        )
        for (const rgb of pixels.slice(1, 4))
          assert.deepEqual(
            applyCreativeColor(rgb, red, primaries),
            applyColorIntensity(rgb, intensity, primaries),
          )
      }
})

test('circular mixer weights have only two neighbors, stable exposure selection and continuous centers/wrap', () => {
  for (let index = 0; index <= 4096; index++) {
    const selected = colorMixerSelection(labColor((index * 2 * Math.PI) / 4096), 'srgb'),
      expanded = weights(selected)
    assert.ok(expanded.every((v) => v >= 0 && v <= 1))
    near(
      expanded.reduce((a, b) => a + b, 0),
      1,
      2e-14,
      'weight sum',
    )
    assert.ok(expanded.filter((v) => v > 0).length <= 2)
  }
  for (const anchor of colorRangeDefinitions) {
    const angle = Math.atan2(anchor.direction[1], anchor.direction[0]),
      center = weights(colorMixerSelection(labColor(angle), 'srgb')),
      left = weights(colorMixerSelection(labColor(angle - 1e-7), 'srgb')),
      right = weights(colorMixerSelection(labColor(angle + 1e-7), 'srgb'))
    for (let index = 0; index < 8; index++) {
      near(left[index], right[index], 1e-10, 'center continuity')
      near(
        center[index],
        index === colorRangeIds.indexOf(anchor.id) ? 1 : 0,
        1e-12,
        'center selectivity',
      )
    }
  }
  for (const primaries of ['srgb', 'rec2020'] as const)
    for (const rgb of [
      [0.2, 0.5, 1],
      [1, -0.2, 0.01],
    ] as ColorTriple[]) {
      const baseline = colorMixerSelection(rgb, primaries),
        expected = weights(baseline)
      for (const gain of [1e-12, 0.0001, 0.18, 1, 4, 16]) {
        const selected = colorMixerSelection(
            [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain],
            primaries,
          ),
          actual = weights(selected)
        for (let i = 0; i < 8; i++)
          near(actual[i], expected[i], 2e-14, 'exposure-independent selection')
        near(selected.protection, baseline.protection, 2e-14, 'exposure-independent protection')
      }
    }
})

test('tone weights stay normalized and balance/blending have the declared direction and global-grade behavior', () => {
  const input: ColorTriple = [0.2, 0.5, 1],
    tone = { hue: 37.4, saturation: 40, luminance: 20 },
    original = compileColorGrading({
      ...neutralColorGrading,
      tones: { shadows: tone, midtones: tone, highlights: tone },
    }),
    expected = applyColorGrading(input, original, 'rec2020')
  for (const blending of [0, 50, 100])
    for (const balance of [-100, 0, 100]) {
      const grade = compileColorGrading({
        ...neutralColorGrading,
        blending,
        balance,
        tones: { shadows: tone, midtones: tone, highlights: tone },
      })
      rgbClose(applyColorGrading(input, grade, 'rec2020'), expected, 'constant global grade')
      for (let index = -1024; index <= 256; index++) {
        const value = colorGradingWeights(0.18 * 2 ** (index / 32), grade)
        assert.ok(value.every((v) => v >= -2e-14 && v <= 1))
        near(value[0] + value[1] + value[2], 1, 2e-14, 'grade weight sum')
      }
    }
  const low = colorGradingWeights(
      0.18,
      compileColorGrading({ ...neutralColorGrading, balance: -100 }),
    ),
    high = colorGradingWeights(0.18, compileColorGrading({ ...neutralColorGrading, balance: 100 }))
  assert.ok(low[0] > high[0] && high[2] > low[2])
  const narrow = colorGradingWeights(
      0.18,
      compileColorGrading({ ...neutralColorGrading, blending: 0 }),
    ),
    wide = colorGradingWeights(0.18, compileColorGrading({ ...neutralColorGrading, blending: 100 }))
  assert.ok(wide[0] > narrow[0] && wide[2] > narrow[2])
})

test('explicit luminance gains, neutral desaturation and HDR monochrome tint preserve the declared luminance', () => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    const all = Object.fromEntries(colorRangeIds.map((id) => [id, { luminance: 100 }]))
    const mixer = compileColorMixer(mix(all))
    for (const rgb of [
      [1, 0, 0],
      [0.2, 0.5, 1],
      [0, 0, 16],
    ] as ColorTriple[]) {
      const output = applyColorMixer(rgb, mixer, primaries),
        a = creativeLab(rgb, primaries),
        b = creativeLab(output, primaries)
      near(b.xyz[1], a.xyz[1] * 2, 2e-12 * Math.max(1, ...output.map(Math.abs)), 'mixer gain')
      near(b.a / labLightness(b.xyz[1]), a.a / a.l, 1e-10, 'relative a')
      near(b.b / labLightness(b.xyz[1]), a.b / a.l, 1e-10, 'relative b')
    }
    const grade = compileColorGrading(reference.configurations[5].grading)
    for (const level of [0, 0.18, 1, 16]) {
      const rgb: ColorTriple = [level, level, level],
        output = applyColorGrading(rgb, grade, primaries)
      near(
        workingToXyz(output, primaries)[1],
        level,
        2e-12 * Math.max(1, ...output.map(Math.abs)),
        'grade luminance',
      )
      if (level === 0) expect(output).toBe(rgb)
      else assert.ok(output[0] !== output[1] || output[1] !== output[2])
    }
  }
})

test('mixer and grade reject unsupported versions, partial/unknown ranges and invalid numeric controls', () => {
  for (const invalid of [
    null,
    [],
    {},
    { ...neutralColorMixer, version: 2 },
    { ...neutralColorMixer, ranges: {} },
    { ...neutralColorMixer, extra: true },
    ...[NaN, Infinity, -101, 101, 0.1, '1'].map((hue) => ({
      ...neutralColorMixer,
      ranges: { ...neutralColorMixer.ranges, red: { ...neutralColorMixer.ranges.red, hue } },
    })),
    {
      ...neutralColorMixer,
      ranges: { ...neutralColorMixer.ranges, unknown: { hue: 0, saturation: 0, luminance: 0 } },
    },
  ])
    expect(() => validateColorMixer(invalid)).toThrow()
  for (const invalid of [
    null,
    [],
    {},
    { ...neutralColorGrading, version: 2 },
    { ...neutralColorGrading, tones: {} },
    { ...neutralColorGrading, balance: 101 },
    { ...neutralColorGrading, blending: 0.5 },
    ...[NaN, Infinity, -0.1, 360, 0.01, '1'].map((hue) => ({
      ...neutralColorGrading,
      tones: {
        ...neutralColorGrading.tones,
        shadows: { ...neutralColorGrading.tones.shadows, hue },
      },
    })),
  ])
    expect(() => validateColorGrading(invalid)).toThrow()
  expect(gradingToneIds).toEqual(['shadows', 'midtones', 'highlights'])
})
