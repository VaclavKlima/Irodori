import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import reference from './fixtures/tone-curve-reference.json' with { type: 'json' }
import {
  applyToneCurves,
  compileToneCurve,
  compileToneCurves,
  evaluateToneCurve,
  identityToneCurves,
  validateToneCurve,
  curveAxis,
  inverseCurveAxis,
} from '../src/shared/tone-curves'
import { workingToCieLab } from '../src/shared/color-intensity'
import { workingToXyz, type ColorTriple } from '../src/shared/color-model'

test('compiled tone curves match independent Decimal80 Hermite-basis values and endpoint derivatives', async () => {
  expect(reference.precision).toBe(80)
  expect(reference.curves).toHaveLength(10)
  expect(
    createHash('sha256')
      .update(await readFile('scripts/research/tone-curve-reference.py'))
      .digest('hex'),
  ).toBe(reference.generatorSha256)
  for (const example of reference.curves) {
    const curve = compileToneCurve(example.points)
    for (const vector of example.vectors) {
      const output = evaluateToneCurve(curve, vector.input)
      expect(
        Math.abs(output - vector.output),
        JSON.stringify({ curve: example.name, vector, output }),
      ).toBeLessThanOrEqual(2e-12 + 2e-11 * Math.abs(vector.output))
    }
    const slopes = [
      curve.startSlope,
      ...curve.segments.map(
        (s) => (3 * s.coefficients[0] + 2 * s.coefficients[1] + s.coefficients[2]) * s.inverseSpan,
      ),
    ]
    for (let i = 0; i < slopes.length; i++)
      expect(Math.abs(slopes[i] - example.slopes[i])).toBeLessThanOrEqual(
        2e-12 + 2e-11 * Math.abs(example.slopes[i]),
      )
  }
})

test('every segment stays inside its endpoint envelope and monotone curves retain monotone unbounded tails', () => {
  let maximumOvershoot = 0,
    minimumDerivative = Infinity,
    minimumStep = Infinity,
    envelopeSamples = 0,
    monotoneSamples = 0
  for (const example of reference.curves) {
    const curve = compileToneCurve(example.points)
    for (let i = 0; i < curve.segments.length; i++) {
      const segment = curve.segments[i],
        lo = Math.min(example.points[i].output, example.points[i + 1].output),
        hi = Math.max(example.points[i].output, example.points[i + 1].output)
      for (let sample = 0; sample <= 128; sample++) {
        const t = sample / 128,
          x = segment.input + t / segment.inverseSpan,
          y = evaluateToneCurve(curve, x)
        maximumOvershoot = Math.max(maximumOvershoot, lo - y, y - hi)
        envelopeSamples++
        if (example.points.every((p, i) => i === 0 || p.output >= example.points[i - 1].output))
          minimumDerivative = Math.min(
            minimumDerivative,
            (3 * segment.coefficients[0] * t * t +
              2 * segment.coefficients[1] * t +
              segment.coefficients[2]) *
              segment.inverseSpan,
          )
      }
    }
    if (example.points.every((p, i) => i === 0 || p.output >= example.points[i - 1].output)) {
      let prior = -Infinity
      for (let i = 0; i <= 2048; i++) {
        const value = evaluateToneCurve(curve, -32 + (i * 160) / 2048)
        minimumStep = Math.min(minimumStep, value - prior)
        monotoneSamples++
        prior = value
      }
      expect(evaluateToneCurve(curve, 1e6)).toBeGreaterThan(999000)
    }
  }
  expect(maximumOvershoot).toBeLessThanOrEqual(1e-11)
  expect(minimumDerivative).toBeGreaterThanOrEqual(-1e-10)
  expect(minimumStep).toBeGreaterThanOrEqual(-1e-10)
  expect(envelopeSamples).toBe(6708)
  expect(monotoneSamples).toBe(12294)
})

test('identity bypass is exact and Master maps linear Y while retaining Lab opponents on signed HDR inputs', () => {
  const identity = compileToneCurves(identityToneCurves)
  const master = compileToneCurves({
    ...identityToneCurves,
    master: reference.curves.find((c) => c.name === 'matte')!.points,
  })
  for (const primaries of ['srgb', 'rec2020'] as const)
    for (const source of [
      [0, 0, 0],
      [0.18, 0.18, 0.18],
      [0.2, 0.4, 0.1],
      [-0.1, 0.2, 0.5],
      [16, 2, 0.05],
      [-1, -0.5, -0.1],
    ] as const) {
      expect(applyToneCurves(source, identity, primaries)).toBe(source)
      const result = applyToneCurves(source, master, primaries)
      expect(result.every(Number.isFinite)).toBe(true)
      const wanted = evaluateToneCurve(master.master, workingToXyz(source, primaries)[1])
      expect(Math.abs(workingToXyz(result, primaries)[1] - wanted)).toBeLessThanOrEqual(
        2e-12 + 2e-11 * Math.abs(wanted),
      )
      const before = workingToCieLab(source, primaries),
        after = workingToCieLab(result, primaries)
      expect(Math.abs(after[1] - before[1])).toBeLessThanOrEqual(2e-10)
      expect(Math.abs(after[2] - before[2])).toBeLessThanOrEqual(2e-10)
    }
  const onlyRed = compileToneCurves({
    ...identityToneCurves,
    red: [
      { input: 0, output: 0.03 },
      { input: 1, output: 1.2 },
    ],
  })
  const rgb: ColorTriple = [0.18, 0.4, -0.1],
    colored = applyToneCurves(rgb, onlyRed, 'srgb')
  expect(colored[0]).not.toBe(rgb[0])
  expect(colored[1]).toBe(rgb[1])
  expect(colored[2]).toBe(rgb[2])
})

test('invalid, unordered, duplicate and excessive points reject while graph coordinates remain reversible', () => {
  for (const points of [
    [],
    [{ input: 0, output: 0 }],
    [
      { input: 0, output: 0 },
      { input: 0, output: 1 },
    ],
    [
      { input: 1, output: 1 },
      { input: 0, output: 0 },
    ],
    [
      { input: 0, output: 0 },
      { input: 0.00009, output: 1 },
    ],
    [
      { input: 0, output: NaN },
      { input: 1, output: 1 },
    ],
    [
      { input: 0, output: 0 },
      { input: 65, output: 1 },
    ],
    Array.from({ length: 17 }, (_, i) => ({ input: i, output: i })),
  ])
    expect(() => validateToneCurve(points)).toThrow('2–16')
  for (const x of [-100, -16, -1, -1e-12, 0, 1e-12, 0.18, 1, 16, 64, 1000])
    expect(Math.abs(inverseCurveAxis(curveAxis(x)) - x)).toBeLessThanOrEqual(
      2e-12 * Math.max(1, Math.abs(x)),
    )
})
