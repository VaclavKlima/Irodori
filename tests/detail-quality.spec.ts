import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  denoiseDetailTile,
  sharpenDetailTile,
  spatialDetailTile,
} from '../src/shared/spatial-detail'

interface QualityCase {
  name: string
  width: number
  height: number
  luminance: number
  chroma: number
  clean: number[][]
  entering: number[][]
  output: number[][]
  cleanFeatures: number[][]
  enteringFeatures: number[][]
}
interface QualityReference {
  sources: Record<string, string>
  coefficients: { srgb: number[] }
  cases: QualityCase[]
}
async function fixture() {
  return JSON.parse(
    await readFile('tests/fixtures/detail-quality.json', 'utf8'),
  ) as QualityReference
}
const rms = (values: number[]) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length)
const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length
function features(data: Float32Array, coefficients: number[]) {
  return Array.from({ length: data.length / 4 }, (_, i) => {
    const y =
        data[i * 4] * coefficients[0] +
        data[i * 4 + 1] * coefficients[1] +
        data[i * 4 + 2] * coefficients[2],
      s = Math.hypot(y, 0.18)
    return [
      Math.asinh(y / 0.18),
      Math.asinh((data[i * 4] - y) / s),
      Math.asinh((data[i * 4 + 2] - y) / s),
    ]
  })
}

test('production NLM meets frozen noise, texture, edge, star and merge-boundary gates against independent prefix references', async () => {
  const reference = await fixture()
  for (const [name, sha] of Object.entries(reference.sources))
    expect(
      createHash('sha256')
        .update(await readFile(`scripts/research/${name}`))
        .digest('hex'),
    ).toBe(sha)
  let maximum = 0,
    checked = 0,
    alphaExact = true
  for (const scene of reference.cases) {
    const { width: w, height: h } = scene,
      image = { width: w, height: h },
      tile = { left: 0, top: 0, ...image },
      data = new Float32Array(scene.entering.flat()),
      output = denoiseDetailTile(
        image,
        tile,
        { ...tile, data },
        compileNoiseReduction({ version: 1, luminance: scene.luminance, chroma: scene.chroma }),
        'srgb',
      ),
      actual = features(output, reference.coefficients.srgb),
      truth = scene.cleanFeatures,
      entering = scene.enteringFeatures,
      ids = Array.from(
        { length: (w - 8) * (h - 8) },
        (_, i) => (Math.floor(i / (w - 8)) + 4) * w + (i % (w - 8)) + 4,
      ),
      errors = (values: number[][], channels: number[]) =>
        channels.flatMap((c) => ids.map((i) => values[i][c] - truth[i][c]))
    for (let i = 0; i < output.length; i++) {
      const expected = scene.output[Math.floor(i / 4)][i % 4]
      maximum = Math.max(
        maximum,
        Math.abs(output[i] - expected) / (2e-6 + 2e-5 * Math.abs(expected)),
      )
      if (i % 4 === 3 && !Object.is(output[i], data[i])) alphaExact = false
      checked++
    }
    if (scene.name === 'flat-luminance') {
      expect(rms(errors(actual, [0])) / rms(errors(entering, [0]))).toBeLessThanOrEqual(0.55)
      expect(Math.abs(mean(errors(actual, [0])))).toBeLessThanOrEqual(0.003)
    }
    if (scene.name === 'flat-chroma') {
      expect(rms(errors(actual, [1, 2])) / rms(errors(entering, [1, 2]))).toBeLessThanOrEqual(0.45)
      for (const c of [1, 2]) expect(Math.abs(mean(errors(actual, [c])))).toBeLessThanOrEqual(0.003)
    }
    if (scene.name.startsWith('period-')) {
      const period = Number(scene.name.split('-')[1]),
        pattern = ids.map((i) =>
          period === 2 ? ((i % w) % 2 ? -1 : 1) : Math.sin((2 * Math.PI * (i % w)) / period),
        ),
        amplitude = (values: number[][]) => {
          const center = mean(ids.map((i) => values[i][0]))
          return (
            ids.reduce((s, i, j) => s + (values[i][0] - center) * pattern[j], 0) /
            pattern.reduce((s, p) => s + p * p, 0)
          )
        },
        retained = amplitude(actual) / amplitude(truth)
      expect(retained, scene.name).toBeGreaterThanOrEqual(0.9)
      expect(retained, scene.name).toBeLessThanOrEqual(1.05)
    }
    if (scene.name === 'edge' || scene.name === 'isoluminant') {
      const c = scene.name === 'edge' ? 0 : 1,
        step = scene.name === 'edge' ? 0.7 : 0.4
      for (const x of [w / 2 - 1, w / 2])
        expect(
          Math.abs(
            mean(
              Array.from(
                { length: h - 8 },
                (_, j) => actual[(j + 4) * w + x][c] - truth[(j + 4) * w + x][c],
              ),
            ),
          ) / step,
        ).toBeLessThanOrEqual(0.03)
      const edgeWidth = (values: number[][]) => {
        const p = Array.from({ length: w }, (_, x) =>
            mean(Array.from({ length: h - 8 }, (_, j) => values[(j + 4) * w + x][c])),
          ),
          lo = mean(p.slice(4, 10)),
          hi = mean(p.slice(w - 10, w - 4)),
          crossing = (q: number) => {
            const target = lo + (hi - lo) * q
            for (let x = 0; x < w - 1; x++)
              if (p[x] <= target && p[x + 1] >= target)
                return x + (target - p[x]) / (p[x + 1] - p[x])
            return Infinity
          }
        return crossing(0.9) - crossing(0.1)
      }
      expect(edgeWidth(actual) - edgeWidth(truth)).toBeLessThanOrEqual(0.5)
    }
    if (scene.name === 'stars') {
      for (const [x, y] of [
        [8, 8],
        [23, 8],
        [8, 16],
        [23, 16],
      ]) {
        const i = y * w + x
        expect((actual[i][0] - 0.04) / (entering[i][0] - 0.04)).toBeGreaterThanOrEqual(0.9)
        for (let yy = y - 2; yy <= y + 2; yy++)
          for (let xx = x - 2; xx <= x + 2; xx++)
            expect(actual[yy * w + xx][0]).toBeLessThanOrEqual(actual[i][0])
      }
      for (let c = 0; c < 3; c++) {
        const values = scene.entering.map((p) => p[c]),
          min = Math.min(...values),
          max = Math.max(...values)
        for (let i = c; i < output.length; i += 4) {
          expect(output[i]).toBeGreaterThanOrEqual(min)
          expect(output[i]).toBeLessThanOrEqual(max)
        }
      }
    }
    if (scene.name === 'merge-boundary') {
      const jump = (values: number[][], c: number) => {
        const side = (left: number) =>
          mean(
            Array.from(
              { length: (h - 8) * 6 },
              (_, i) => values[(Math.floor(i / 6) + 4) * w + left + (i % 6)][c],
            ),
          )
        return side(w / 2 - 6) - side(w / 2)
      }
      for (let c = 0; c < 3; c++)
        expect(Math.abs(jump(actual, c) - jump(entering, c))).toBeLessThanOrEqual(0.003)
    }
  }
  expect(checked).toBe(27648)
  expect(alphaExact).toBe(true)
  expect(maximum).toBeLessThanOrEqual(1)
})

test('protected detail sharpening keeps the frozen halo/noise bounds and increases a soft edge at native scale', async () => {
  const reference = await fixture(),
    scene = reference.cases.find((s) => s.name === 'flat-luminance')!,
    image = { width: scene.width, height: scene.height },
    tile = { left: 0, top: 0, ...image },
    data = new Float32Array(scene.entering.flat()),
    parameters = compileDetailSharpening({ version: 1, amount: 50, radius: 1, threshold: 50 }),
    output = sharpenDetailTile(image, tile, { ...tile, data }, parameters, 'srgb'),
    actual = features(output, reference.coefficients.srgb),
    indices = Array.from(
      { length: (image.width - 8) * (image.height - 8) },
      (_, i) => (Math.floor(i / (image.width - 8)) + 4) * image.width + (i % (image.width - 8)) + 4,
    ),
    ratio =
      rms(indices.map((i) => actual[i][0] - scene.cleanFeatures[i][0])) /
      rms(indices.map((i) => scene.enteringFeatures[i][0] - scene.cleanFeatures[i][0]))
  expect(ratio).toBeLessThanOrEqual(1.1)
  const combined = spatialDetailTile(
      image,
      tile,
      { ...tile, data },
      compileNoiseReduction({ version: 1, luminance: 50, chroma: 0 }),
      parameters,
      'srgb',
    ),
    ff = features(combined, reference.coefficients.srgb)
  expect(
    rms(indices.map((i) => ff[i][0] - scene.cleanFeatures[i][0])) /
      rms(indices.map((i) => scene.enteringFeatures[i][0] - scene.cleanFeatures[i][0])),
  ).toBeLessThanOrEqual(0.55)
  const size = { width: 32, height: 9 },
    full = { left: 0, top: 0, ...size },
    soft = new Float32Array(32 * 9 * 4)
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 32; x++) {
      const value = 0.18 * Math.sinh(0.7 + 0.35 * Math.tanh(x + 0.5 - 16))
      soft.set([value, value, value, 1], (y * 32 + x) * 4)
    }
  const sharpened = sharpenDetailTile(size, full, { ...full, data: soft }, parameters, 'srgb'),
    before = soft[(4 * 32 + 16) * 4] - soft[(4 * 32 + 15) * 4],
    after = sharpened[(4 * 32 + 16) * 4] - sharpened[(4 * 32 + 15) * 4]
  expect(after / before).toBeGreaterThanOrEqual(1.05)
  let maximumOvershoot = 0,
    maximumOutsideSupportChange = 0,
    checked = 0
  for (const primaries of ['srgb', 'rec2020'] as const)
    for (const radius of [0.5, 1, 3])
      for (const scale of [0.001, 0.18, 16]) {
        const input = new Float32Array(32 * 9 * 4)
        for (let y = 0; y < 9; y++)
          for (let x = 0; x < 32; x++) {
            const value = x < 16 ? scale / 4 : scale
            input.set([value, value, value, 1], (y * 32 + x) * 4)
          }
        const p = compileDetailSharpening({ version: 1, amount: 100, radius, threshold: 0 }),
          filtered = sharpenDetailTile(size, full, { ...full, data: input }, p, primaries),
          range = Math.fround(scale) - Math.fround(scale / 4)
        for (let y = 0; y < 9; y++)
          for (let x = 0; x < 32; x++)
            for (let c = 0; c < 3; c++) {
              const i = (y * 32 + x) * 4 + c
              maximumOvershoot = Math.max(
                maximumOvershoot,
                (Math.fround(scale / 4) - filtered[i]) / range,
                (filtered[i] - Math.fround(scale)) / range,
              )
              if (x < 16 - p.support || x >= 16 + p.support)
                maximumOutsideSupportChange = Math.max(
                  maximumOutsideSupportChange,
                  Math.abs(filtered[i] - input[i]),
                )
              checked++
            }
      }
  // Maxima retain every per-pixel bound without tens of thousands of matcher calls.
  expect(checked).toBe(15552)
  expect(maximumOvershoot).toBeLessThanOrEqual(0.05)
  expect(maximumOutsideSupportChange).toBe(0)
})
