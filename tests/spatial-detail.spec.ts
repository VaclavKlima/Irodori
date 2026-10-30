import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  neutralNoiseReduction,
  neutralDetailSharpening,
  denoiseDetailTile,
  sharpenDetailTile,
  spatialDetailTile,
  detailSourceBounds,
  spatialDetailSourceBounds,
  DETAIL_MAX_WINDOW_EDGE,
  validateNoiseReduction,
  validateDetailSharpening,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../src/shared/spatial-detail'
import { initialSettings, validatePatch, validateProcessingPatch } from '../src/shared/edits'
import { supportsEditingSettings } from '../src/main/catalog/editing-migration'
import { detailWindow, type DetailReference } from './spatial-detail.helpers'

test('bounded CPU detail operators agree with independent Decimal80 source, halo and combined-stage references', async () => {
  const reference = JSON.parse(
    await readFile('tests/fixtures/detail-reference.json', 'utf8'),
  ) as DetailReference
  expect(reference.precision).toBe(80)
  for (const [name, expected] of Object.entries(reference.sources))
    expect(
      createHash('sha256')
        .update(await readFile(`scripts/research/${name}`))
        .digest('hex'),
    ).toBe(expected)
  let maximum = 0,
    checked = 0,
    worst: unknown
  for (const scene of reference.scenes) {
    const image = { width: scene.width, height: scene.height },
      full = { left: 0, top: 0, ...image },
      source = { ...full, data: new Float32Array(scene.data.flat()) },
      original = Buffer.from(source.data.buffer).toString('hex')
    expect(createHash('sha256').update(new Uint8Array(source.data.buffer)).digest('hex')).toBe(
      scene.sha256,
    )
    for (const entry of scene.cases) {
      const noise = compileNoiseReduction(
          entry.operation === 'noise'
            ? (entry.settings as NoiseReductionSettings)
            : (entry.noise ?? neutralNoiseReduction),
        ),
        sharp = compileDetailSharpening(
          entry.operation === 'noise'
            ? neutralDetailSharpening
            : (entry.settings as DetailSharpeningSettings),
        ),
        prepared =
          entry.operation === 'combined'
            ? { ...full, data: denoiseDetailTile(image, full, source, noise, entry.primaries) }
            : source
      for (const point of entry.points) {
        const tile = { left: point.x, top: point.y, width: 1, height: 1 },
          scalar =
            entry.operation === 'noise'
              ? denoiseDetailTile(image, tile, source, noise, entry.primaries, new Float64Array(4))
              : sharpenDetailTile(
                  image,
                  tile,
                  prepared,
                  sharp,
                  entry.primaries,
                  new Float64Array(4),
                ),
          published = spatialDetailTile(image, tile, source, noise, sharp, entry.primaries)
        for (let c = 0; c < 3; c++) {
          const ratio =
            Math.abs(scalar[c] - point.output[c]) / (2e-12 + 2e-11 * Math.abs(point.output[c]))
          if (ratio > maximum) {
            maximum = ratio
            worst = {
              scene: scene.name,
              operation: entry.operation,
              settings: entry.settings,
              point,
              channel: c,
              actual: scalar[c],
            }
          }
          expect(Math.abs(published[c] - point.output[c])).toBeLessThanOrEqual(
            2e-6 + 2e-5 * Math.abs(point.output[c]),
          )
        }
        expect(published[3]).toBe(point.output[3])
        checked++
      }
    }
    expect(Buffer.from(source.data.buffer).toString('hex')).toBe(original)
  }
  expect(checked).toBe(1728)
  expect(maximum, JSON.stringify(worst)).toBeLessThanOrEqual(1)
})

test('neutral, flat and transparent source bytes including signed zeros remain exact without in-place changes', () => {
  const image = { width: 9, height: 9 },
    full = { left: 0, top: 0, ...image },
    source = new Float32Array(9 * 9 * 4)
  for (let i = 0; i < source.length; i += 4) source.set([-0, 0, -0, (i / 4) % 3 ? 1 : -0], i)
  for (const [noise, sharp] of [
    [neutralNoiseReduction, neutralDetailSharpening],
    [
      { version: 1 as const, luminance: 100, chroma: 100 },
      { version: 1 as const, amount: 100, radius: 3, threshold: 0 },
    ],
  ] as const) {
    const result = spatialDetailTile(
      image,
      full,
      { ...full, data: source },
      compileNoiseReduction(noise),
      compileDetailSharpening(sharp),
      'rec2020',
    )
    expect(new Uint32Array(result.buffer)).toEqual(new Uint32Array(source.buffer))
  }
  const a = new Float32Array(source.length),
    b = new Float32Array(source.length)
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const transparent = x === 0 || y === 0 || x === 8 || y === 8,
        at = (y * 9 + x) * 4
      a.set(transparent ? [16, -8, 3, 0] : [0.1 + x * 0.001, 0.2 - y * 0.001, 0.3, 1], at)
      b.set(transparent ? [-16, 7, 12, 0] : [...a.subarray(at, at + 4)], at)
    }
  const n = compileNoiseReduction({ version: 1, luminance: 50, chroma: 50 }),
    s = compileDetailSharpening({ version: 1, amount: 100, radius: 1, threshold: 0 }),
    aa = spatialDetailTile(image, full, { ...full, data: a }, n, s, 'srgb'),
    bb = spatialDetailTile(image, full, { ...full, data: b }, n, s, 'srgb')
  for (let i = 0; i < aa.length; i += 4) {
    expect(aa[i + 3]).toBe(a[i + 3])
    expect(bb[i + 3]).toBe(b[i + 3])
    for (let c = 0; c < 4; c++) expect(aa[i + c]).toBe(a[i + 3] === 0 ? a[i + c] : bb[i + c])
  }
})

test('combined denoise and all sharpening supports have exact tile seams using only bounded native windows', () => {
  const image = { width: 23, height: 17 },
    full = { left: 0, top: 0, ...image },
    data = new Float32Array(image.width * image.height * 4)
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      data.set(
        [0.01 + x * 0.003, 0.02 + y * 0.002, 0.1 + Math.sin(x * y) * 0.01, (x + y) % 13 ? 1 : 0],
        (y * image.width + x) * 4,
      )
  const n = compileNoiseReduction({ version: 1, luminance: 50, chroma: 50 })
  for (const radius of [0.5, 1, 3]) {
    const s = compileDetailSharpening({ version: 1, amount: 50, radius, threshold: 50 }),
      expected = spatialDetailTile(image, full, { ...full, data }, n, s, 'rec2020'),
      result = new Float32Array(expected.length)
    for (let top = 0; top < image.height; top += 5)
      for (let left = 0; left < image.width; left += 7) {
        const tile = {
            left,
            top,
            width: Math.min(7, image.width - left),
            height: Math.min(5, image.height - top),
          },
          rect = spatialDetailSourceBounds(image, tile, n, s),
          output = spatialDetailTile(image, tile, detailWindow(image, data, rect), n, s, 'rec2020')
        expect(rect.width).toBeLessThanOrEqual(DETAIL_MAX_WINDOW_EDGE)
        for (let y = 0; y < tile.height; y++)
          result.set(
            output.subarray(y * tile.width * 4, (y + 1) * tile.width * 4),
            ((top + y) * image.width + left) * 4,
          )
      }
    expect(new Uint32Array(result.buffer)).toEqual(new Uint32Array(expected.buffer))
  }
})

test('detail controls freeze valid parameters and reject malformed versions, support, windows and aliases before processing', () => {
  const values = { version: 1 as const, luminance: 50, chroma: 25 },
    n = compileNoiseReduction(values)
  Object.assign(values, { luminance: 100 })
  expect(n.settings.luminance).toBe(50)
  for (const v of [
    null,
    [],
    {},
    { ...neutralNoiseReduction, version: 2 },
    { ...neutralNoiseReduction, luminance: NaN },
    { ...neutralNoiseReduction, chroma: 101 },
    { ...neutralNoiseReduction, chroma: 0.5 },
    { ...neutralNoiseReduction, extra: 0 },
  ])
    expect(() => validateNoiseReduction(v)).toThrow()
  for (const v of [
    null,
    {},
    { ...neutralDetailSharpening, version: 2 },
    { ...neutralDetailSharpening, amount: 101 },
    { ...neutralDetailSharpening, radius: 0.4 },
    { ...neutralDetailSharpening, radius: 1.01 },
    { ...neutralDetailSharpening, radius: Infinity },
    { ...neutralDetailSharpening, threshold: -1 },
  ])
    expect(() => validateDetailSharpening(v)).toThrow()
  const image = { width: 9, height: 9 },
    full = { left: 0, top: 0, ...image },
    source = { ...full, data: new Float32Array(9 * 9 * 4) }
  for (let i = 3; i < source.data.length; i += 4) source.data[i] = 1
  const tile = { left: 4, top: 4, width: 1, height: 1 }
  expect(() =>
    denoiseDetailTile(
      image,
      tile,
      { left: 4, top: 4, width: 1, height: 1, data: new Float32Array([1, 1, 1, 1]) },
      n,
      'srgb',
    ),
  ).toThrow('Incomplete')
  expect(() => denoiseDetailTile(image, full, source, n, 'srgb', source.data)).toThrow(
    'destination',
  )
  expect(() =>
    spatialDetailTile(
      image,
      full,
      source,
      n,
      compileDetailSharpening({ version: 1, amount: 50, radius: 1, threshold: 50 }),
      'srgb',
      source.data,
    ),
  ).toThrow('destination')
  expect(() => denoiseDetailTile(image, tile, source, n, 'p3' as never)).toThrow('primaries')
  for (const size of [
    { width: 0, height: 1 },
    { width: 40000, height: 1 },
    { width: 10000, height: 10000 },
  ])
    expect(() => detailSourceBounds(size, tile, 4)).toThrow()
  source.data[3] = -1
  expect(() => denoiseDetailTile(image, tile, source, n, 'srgb')).toThrow('pixels')
  source.data[3] = 1
  source.data[0] = NaN
  expect(() => denoiseDetailTile(image, tile, source, n, 'srgb')).toThrow('pixels')
  expect(() => validatePatch({ noiseReduction: neutralNoiseReduction })).not.toThrow()
  expect(() => validatePatch({ detailSharpening: neutralDetailSharpening })).not.toThrow()
  expect(() => validateProcessingPatch({ noiseReduction: neutralNoiseReduction })).toThrow(
    'Unknown adjustment',
  )
  expect(() => validateProcessingPatch({ detailSharpening: neutralDetailSharpening })).toThrow(
    'Unknown adjustment',
  )
  expect(
    supportsEditingSettings({
      ...initialSettings(),
      version: 10,
      noiseReduction: neutralNoiseReduction,
    }),
  ).toBe(false)
  expect(
    supportsEditingSettings({
      ...initialSettings(),
      version: 10,
      detailSharpening: neutralDetailSharpening,
    }),
  ).toBe(false)
})
