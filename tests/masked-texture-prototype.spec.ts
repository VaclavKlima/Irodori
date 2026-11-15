import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import protocol from '../assets/tests/references/masked-texture/protocol.json' with { type: 'json' }
import reference from '../assets/tests/references/masked-texture/reference.json' with { type: 'json' }
import photographs from '../assets/tests/references/masked-texture/photo-cases.json' with { type: 'json' }
import supplements from '../assets/tests/references/masked-texture/supplemental-cases-v1.json' with { type: 'json' }
import { detailLuminance } from '../src/shared/spatial-detail'
import type { ColorPrimaries } from '../src/shared/color-model'
import { selectPlan, suites } from '../scripts/verification-plan'

type NumericCase = (typeof reference.cases)[number]
type Rectangle = { left: number; top: number; width: number; height: number }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const words = (values: number[]) => new Uint32Array(Float32Array.from(values).buffer)
const byId = (id: string) => {
  const value = reference.cases.find((entry) => entry.id === id)
  if (!value) throw new Error(`Missing frozen numeric case: ${id}`)
  return value
}
const overlaps = (a: Rectangle, b: Rectangle) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height
const feature = (rgba: number[], primaries: string) => {
  const coefficients = detailLuminance(primaries as ColorPrimaries)
  return Array.from({ length: rgba.length / 4 }, (_, pixel) =>
    Math.asinh(
      coefficients.reduce((sum, weight, channel) => sum + weight * rgba[pixel * 4 + channel], 0) /
        0.18,
    ),
  )
}
const centeredRms = (values: number[]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
}
const featureGain = (entry: NumericCase) =>
  centeredRms(feature(entry.expected, entry.primaries)) /
  centeredRms(feature(entry.rgba, entry.primaries))

test('frozen protocol binds the independent oracle, source cases and retained license notice', async () => {
  expect(hash(await readFile('assets/tests/references/masked-texture/protocol.json'))).toBe(
    'f8aa5bc91184276ee3c8fe1115bafa427c4476736db850cc053c0cd1e901f399',
  )
  for (const [path, expected] of [
    [protocol.reference.file, protocol.reference.sha256],
    [reference.provenance.generator, protocol.reference.generatorSha256],
    [protocol.photoCases.file, protocol.photoCases.sha256],
  ])
    expect(hash(await readFile(path))).toBe(expected)
  expect(hash(await readFile('scripts/research/masked-texture/HALIDE-LICENSE.txt'))).toBe(
    '27b7b4b829920bb634dcfd9cf0c31cebce99a664b570dfe9a4bb2dc674b770ba',
  )
  expect(reference.policy).toBe(protocol.id)
  expect(protocol.algorithm.modifiedBands).toEqual([1, 2])
  expect(protocol.algorithm.anchors).toEqual({ minimum: -6, maximum: 6, step: 0.125, count: 97 })
  expect(reference.tolerance).toMatchObject({
    absolute: protocol.gates.absoluteRgb,
    relative: protocol.gates.relativeRgb,
  })
})

test('bounded oracle cases cover real admitted f32 domains and float64 output rounding', () => {
  expect(new Set(reference.cases.map((entry) => entry.id)).size).toBe(reference.cases.length)
  expect(new Set(reference.cases.map((entry) => entry.primaries))).toEqual(
    new Set(['srgb', 'rec2020']),
  )
  expect(reference.cases.some(({ width, height }) => width % 2 === 0 && height % 2 === 0)).toBe(
    true,
  )
  expect(reference.cases.some(({ width, height }) => width % 2 === 1 && height % 2 === 1)).toBe(
    true,
  )
  const amounts = new Set<number>()
  for (const entry of reference.cases) {
    expect(Number.isSafeInteger(entry.width) && entry.width > 0 && entry.width <= 33).toBe(true)
    expect(Number.isSafeInteger(entry.height) && entry.height > 0 && entry.height <= 25).toBe(true)
    expect(entry.rgba.length).toBe(entry.width * entry.height * 4)
    expect(entry.expected.length).toBe(entry.rgba.length)
    expect(entry.mask.length).toBe(entry.width * entry.height)
    expect([...entry.rgba, ...entry.expected, ...entry.mask].every(Number.isFinite)).toBe(true)
    expect(
      [...entry.rgba, ...entry.expected, ...entry.mask].every((v) => Math.fround(v) === v),
    ).toBe(true)
    expect(entry.mask.every((v) => v >= 0 && v <= 1)).toBe(true)
    for (const amount of entry.passes) {
      amounts.add(amount)
      expect(Number.isInteger(amount) && amount >= -100 && amount <= 100).toBe(true)
    }
    const luminance = feature(entry.rgba, entry.primaries)
    for (let pixel = 0; pixel < entry.mask.length; pixel++) {
      const alpha = entry.rgba[pixel * 4 + 3]
      expect(alpha >= 0 && alpha <= 1).toBe(true)
      if (alpha > 0) expect(Math.abs(luminance[pixel])).toBeLessThanOrEqual(6)
    }
    for (const probe of entry.float64Probes)
      expect(probe.rgba.map(Math.fround)).toEqual(
        entry.expected.slice(4 * probe.pixel, 4 * probe.pixel + 4),
      )
  }
  expect([...amounts].sort((a, b) => a - b)).toEqual([-100, -25, 0, 25, 100])
})

test('neutral, zero coverage, alpha, hidden RGB and flat constants retain exact source words', () => {
  let hidden = 0,
    partialChanged = 0
  for (const entry of reference.cases) {
    const original = words(entry.rgba),
      result = words(entry.expected)
    for (let pixel = 0; pixel < entry.mask.length; pixel++) {
      const offset = pixel * 4,
        alpha = entry.rgba[offset + 3]
      expect(result[offset + 3]).toBe(original[offset + 3])
      const bypass =
        entry.passes.every((amount) => amount === 0) || entry.mask[pixel] === 0 || alpha === 0
      if (alpha === 0) hidden++
      if (bypass || entry.id === 'constant-exact')
        expect(Array.from(result.slice(offset, offset + 4))).toEqual(
          Array.from(original.slice(offset, offset + 4)),
        )
      else if (entry.mask[pixel] < 1 && result[offset] !== original[offset]) partialChanged++
    }
  }
  expect(hidden).toBeGreaterThan(0)
  expect(partialChanged).toBeGreaterThan(0)
  expect(byId('alpha-hidden-partial').rgba.some((value) => Math.abs(value) > 1000)).toBe(true)
})

test('positive and negative full coverage are symmetric in feature space, with no RGB clamp', () => {
  const positive = byId('full-positive'),
    negative = byId('full-negative')
  expect(positive.rgba).toEqual(negative.rgba)
  expect(positive.mask.every((value) => value === 1)).toBe(true)
  const original = feature(positive.rgba, positive.primaries),
    up = feature(positive.expected, positive.primaries),
    down = feature(negative.expected, negative.primaries)
  for (let pixel = 0; pixel < original.length; pixel++)
    expect(Math.abs(up[pixel] + down[pixel] - 2 * original[pixel])).toBeLessThan(2e-6)
  const hdr = byId('signed-hdr-partial')
  expect(Math.min(...hdr.expected)).toBeLessThan(0)
  expect(Math.max(...hdr.expected)).toBeGreaterThan(15)
})

test('sequential overlap references preserve order and cannot collapse opposite controls to zero', () => {
  const forward = byId('overlap-positive-negative'),
    reverse = byId('overlap-negative-positive')
  expect(forward.rgba).toEqual(reverse.rgba)
  expect(forward.mask).toEqual(reverse.mask)
  expect(forward.passes).toEqual([...reverse.passes].reverse())
  expect(words(forward.expected)).not.toEqual(words(reverse.expected))
  expect(words(forward.expected)).not.toEqual(words(forward.rgba))
  expect(words(reverse.expected)).not.toEqual(words(reverse.rgba))
})

test('independent reference outputs satisfy the prospectively frozen procedural response screen', () => {
  const gates = protocol.gates.firstProceduralQuality
  for (const band of ['mid', 'texture']) {
    expect(featureGain(byId(`band-${band}`))).toBeGreaterThanOrEqual(
      gates.period4And8Positive25MinFeatureRmsGain,
    )
    expect(featureGain(byId(`band-${band}-negative`))).toBeLessThanOrEqual(
      gates.period4And8Negative25MaxFeatureRmsGain,
    )
  }
  const high = featureGain(byId('band-high'))
  expect(high).toBeGreaterThanOrEqual(gates.period2Positive25FeatureRmsGainRange[0])
  expect(high).toBeLessThanOrEqual(gates.period2Positive25FeatureRmsGainRange[1])
  expect(featureGain(byId('flat-noise-positive'))).toBeLessThanOrEqual(
    gates.flatNoisePositive25MaxFeatureRmsGain,
  )
})

test('photographic controls retain distinct strengths, fixed native regions and unmasked controls', async () => {
  expect(photographs.cases.filter((entry) => entry.enabled)).toHaveLength(1)
  expect(photographs.conditionalSupplementalCases.every((entry) => !entry.enabled)).toBe(true)
  const entry = photographs.cases[0],
    amounts = protocol.variants.independentAmounts
  expect(hash(await readFile(entry.source))).toBe(entry.sha256)
  expect([...entry.maskOrder].sort()).toEqual(entry.masks.map((mask) => mask.id).sort())
  expect([...entry.maskOrder].reverse()).toEqual(['plumage', 'reflected-legs', 'ripples'])
  expect(Object.keys(amounts).sort()).toEqual(entry.masks.map((mask) => mask.id).sort())
  expect(new Set(Object.values(amounts)).size).toBe(entry.masks.length)
  for (const region of [...entry.regions, ...entry.unaffectedControls]) {
    expect(
      Object.values(region)
        .filter((v) => typeof v === 'number')
        .every(Number.isInteger),
    ).toBe(true)
    expect(region.left).toBeGreaterThanOrEqual(0)
    expect(region.top).toBeGreaterThanOrEqual(0)
    expect(region.left + region.width).toBeLessThanOrEqual(entry.width)
    expect(region.top + region.height).toBeLessThanOrEqual(entry.height)
  }
  for (const [index, mask] of entry.masks.entries()) {
    expect(mask.partialManualRegion).toBe(true)
    expect(mask.coverage.kind).toBe('radial')
    for (const other of entry.masks.slice(index + 1))
      expect(overlaps(mask.outerBounds, other.outerBounds)).toBe(false)
    for (const control of entry.unaffectedControls)
      expect(overlaps(mask.outerBounds, control)).toBe(false)
    expect(entry.regions.some((region) => overlaps(mask.outerBounds, region))).toBe(true)
  }
})

test('research contract has one explicit Node target and never joins default fast or GPU selections', () => {
  const matches = suites.filter((suite) => suite.target === 'masked-texture-prototype')
  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({
    file: 'tests/masked-texture-prototype.spec.ts',
    group: 'node',
    scopes: [],
    explicitOnly: true,
  })
  const selected = selectPlan(['--target', 'masked-texture-prototype'])
  expect(selected.groups.flatMap((group) => group.files)).toContain(matches[0].file)
  expect(selected.groups.some((group) => group.name === 'raw-gpu')).toBe(false)
  expect(selectPlan(['--fast']).groups.flatMap((group) => group.files)).not.toContain(
    matches[0].file,
  )
})

test('separate source-only supplements preserve the original frozen method and fixed controls', async () => {
  expect(
    hash(await readFile('assets/tests/references/masked-texture/supplemental-cases-v1.json')),
  ).toBe('54627d431ba43057c03be9c1b8993f4e42d9ac96839745e3a9a470fadb8a6ec0')
  expect(supplements.status).toBe('source-only-frozen-before-supplemental-candidate-rendering')
  expect(supplements.issue).toBe(80)
  for (const inherited of [supplements.parentProtocol, supplements.originalCases])
    expect(hash(await readFile(inherited.path))).toBe(inherited.sha256)
  expect(supplements.parentProtocol.sha256).toBe(
    'f8aa5bc91184276ee3c8fe1115bafa427c4476736db850cc053c0cd1e901f399',
  )
  expect(supplements.originalCases.sha256).toBe(protocol.photoCases.sha256)
  expect(supplements.cases.map((entry) => entry.id).sort()).toEqual(
    photographs.conditionalSupplementalCases.map((entry) => entry.id).sort(),
  )
  for (const entry of supplements.cases) {
    const prior = photographs.conditionalSupplementalCases.find((item) => item.id === entry.id)!
    expect(entry.enabled).toBe(true)
    expect(entry.renderStatus).toBe('not-rendered')
    expect(entry.amounts).toEqual(protocol.variants.moderate)
    expect(entry.stressAmounts).toEqual(protocol.variants.stress)
    expect(entry.noiseReduction).toEqual({ luminance: 0, chroma: 0 })
    expect([entry.comparator.amount, entry.comparator.radius, entry.comparator.threshold]).toEqual(
      protocol.variants.comparison.detailSharpening,
    )
    expect(
      entry.regions.map(({ name, left, top, width, height }) => ({
        name,
        left,
        top,
        width,
        height,
      })),
    ).toEqual(prior.regions)
  }
})

test('supplemental native treatment covers fixed crops and excludes every untouched control', () => {
  for (const entry of supplements.cases) {
    expect(entry.width * entry.height).toBeLessThanOrEqual(protocol.runtime.maxNativePixels)
    expect(entry.masks).toHaveLength(1)
    const mask = entry.masks[0],
      shape = mask.coverage
    expect(entry.maskOrder).toEqual([mask.id])
    expect(mask.partialManualRegion).toBe(true)
    expect(shape.kind).toBe('radial')
    expect(shape.rotationDegrees).toBe(0)
    expect(shape.featherPercent).toBeGreaterThan(0)
    expect(shape.featherPercent).toBeLessThan(100)
    expect(mask.outerBounds).toEqual({
      left: shape.centerPx.x - shape.radiusPx.x,
      top: shape.centerPx.y - shape.radiusPx.y,
      width: 2 * shape.radiusPx.x,
      height: 2 * shape.radiusPx.y,
    })
    for (const region of [...entry.regions, ...entry.unaffectedControls, mask.outerBounds]) {
      expect(
        [region.left, region.top, region.width, region.height].every(Number.isSafeInteger),
      ).toBe(true)
      expect(region.width > 0 && region.height > 0 && region.left >= 0 && region.top >= 0).toBe(
        true,
      )
      expect(region.left + region.width).toBeLessThanOrEqual(entry.width)
      expect(region.top + region.height).toBeLessThanOrEqual(entry.height)
    }
    for (const region of entry.regions) {
      expect([region.width, region.height]).toEqual([512, 512])
      expect(region.maskIds).toEqual([mask.id])
      for (const x of [region.left + 0.5, region.left + region.width - 0.5])
        for (const y of [region.top + 0.5, region.top + region.height - 0.5])
          expect(
            Math.hypot(
              (x - shape.centerPx.x) / shape.radiusPx.x,
              (y - shape.centerPx.y) / shape.radiusPx.y,
            ),
          ).toBeLessThan(1)
      const centerDistance = Math.hypot(
        (region.left + region.width / 2 - shape.centerPx.x) / shape.radiusPx.x,
        (region.top + region.height / 2 - shape.centerPx.y) / shape.radiusPx.y,
      )
      expect(centerDistance).toBeLessThan(1 - shape.featherPercent / 100)
    }
    expect(entry.unaffectedControls).toHaveLength(2)
    for (const control of entry.unaffectedControls) {
      expect([control.width, control.height]).toEqual([96, 96])
      expect(overlaps(mask.outerBounds, control)).toBe(false)
    }
  }
})

test('supplemental raster and scene-linear inputs retain distinct domains and original fixture lineage', async () => {
  for (const entry of supplements.cases) {
    for (const [path, expected] of [
      [entry.notice, entry.noticeSha256],
      [entry.licenseNotice, entry.licenseNoticeSha256],
    ])
      expect(hash(await readFile(path))).toBe(expected)
    const prior = photographs.conditionalSupplementalCases.find((item) => item.id === entry.id)!
    if (entry.kind === 'raster') {
      expect(entry.primaries).toBe('srgb')
      expect(entry.source).toBe(prior.source)
      expect(entry.sha256).toBe(prior.sha256)
      expect(hash(await readFile(entry.source!))).toBe(entry.sha256)
      expect(entry.sourcePreparationEvidence.transform).toMatchObject({ white: 1, quantize: false })
    } else {
      expect(entry.kind).toBe('merge')
      expect(entry.primaries).toBe('rec2020')
      expect(entry.assetBytes).toBe(entry.width * entry.height * 16)
      expect(entry.hdrStrips).toBe(Math.ceil(entry.height / 64))
      expect([entry.manifestSha256, entry.assetSha256, entry.maskSha256]).toEqual([
        prior.manifestSha256,
        prior.assetSha256,
        prior.maskSha256,
      ])
      expect(entry.sourceOriginals).toEqual(prior.sourceOriginals)
      const notice = JSON.parse(await readFile(entry.notice, 'utf8')) as {
        files: { path: string; sha256: string }[]
      }
      expect(entry.originals!.map((item) => item.path)).toEqual(entry.sourceOriginals)
      for (const original of entry.originals!) {
        expect(hash(await readFile(original.path))).toBe(original.sha256)
        expect(
          notice.files.some(
            (item) =>
              join(dirname(entry.notice), item.path) === original.path &&
              item.sha256 === original.sha256,
          ),
        ).toBe(true)
      }
      expect(entry.limitations.join(' ')).toContain('no physical HDR')
    }
  }
})
