import { expect, test } from '@playwright/test'
import reference from './fixtures/aces-reference.json' with { type: 'json' }
import { rec2020ToAces, renderDisplay, effectiveHeadroom } from '../src/shared/display-rendering'
import { encodeHdr, SDR_TARGET, type RGB } from '../src/shared/hdr'
import { neutralAdjustments } from '../src/shared/adjustments'
import { hdrStatistics, analyzeHdr } from '../src/shared/hdr-statistics'
import type { HdrWorkingAsset } from '../src/shared/hdr'

test('complete CPU ACES rendering conforms to independent pinned CTL for both gamuts and headrooms 1, 2, 4, 8', () => {
  let maximumRatio = 0
  let worst: unknown
  for (const sample of reference.targets) {
    const target = {
      mode: sample.peak === 1 ? ('sdr' as const) : ('hdr' as const),
      peak: sample.peak,
      colorSpace: sample.colorSpace as 'srgb' | 'display-p3' | 'rec2020',
    }
    for (let i = 0; i < reference.inputs.length; i++) {
      const actual = renderDisplay(reference.inputs[i] as RGB, target).rgb
      for (let c = 0; c < 3; c++) {
        const expected = sample.rgb[i][c]
        const ratio = Math.abs(actual[c] - expected) / (2e-6 + 2e-5 * Math.abs(expected))
        if (ratio > maximumRatio) {
          maximumRatio = ratio
          worst = { i, c, target, actual: actual[c], expected }
        }
      }
    }
  }
  expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
})
test('Bradford adaptation preserves the neutral axis and the rendering contract caps relative headroom', () => {
  for (const value of [-1, 0, 0.18, 1, 16])
    for (const c of rec2020ToAces([value, value, value])) expect(c).toBeCloseTo(value, 12)
  expect(effectiveHeadroom({ mode: 'hdr', peak: 1000, colorSpace: 'srgb' })).toBe(100)
  expect(effectiveHeadroom({ mode: 'hdr', peak: NaN, colorSpace: 'srgb' })).toBe(1)
  expect(effectiveHeadroom({ mode: 'sdr', peak: 8, colorSpace: 'srgb' })).toBe(1)
  expect(renderDisplay([0, 0, 0], SDR_TARGET).rgb).toEqual([0, 0, 0])
  expect(renderDisplay([0.001, 0.001, 0.001], SDR_TARGET).luminance).toBeLessThan(
    renderDisplay([0.18, 0.18, 0.18], SDR_TARGET).luminance / 100,
  )
})
test('display encoding is applied once and preserves the extended signed transfer', () => {
  for (const value of [-4, -0.1, 0, 0.0031308, 0.18, 1, 4, 8]) {
    const encoded = encodeHdr(value),
      m = Math.abs(encoded)
    const decoded = Math.sign(encoded) * (m <= 0.04045 ? m / 12.92 : ((m + 0.055) / 1.055) ** 2.4)
    expect(decoded).toBeCloseTo(value, 7)
  }
  expect(encodeHdr(1)).toBeCloseTo(1, 12)
  const out = renderDisplay([0.18, 0.18, 0.18], SDR_TARGET).rgb[0]
  expect(encodeHdr(out)).toBeCloseTo(0.3491890769, 6)
  expect(Math.abs(encodeHdr(encodeHdr(out)) - encodeHdr(out))).toBeGreaterThan(0.1)
})
test('Output statistics use final display-linear pixels and exclude transparent samples', () => {
  const asset = { source: { normalization: { sourceSaturation: null } } } as HdrWorkingAsset
  const input = new Float32Array([0.18, 0.18, 0.18, 1, 16, 16, 16, 0.5, 65536, 0, 0, 0])
  const result = hdrStatistics('output', SDR_TARGET, asset)
  analyzeHdr(input, neutralAdjustments, asset, SDR_TARGET, result)
  expect(result.visiblePixels).toBe(2)
  expect(result.aboveWhite).toBe(0)
  expect(result.exceedingHeadroom).toBeNull()
  expect(result.rgbHistogram!.rgb[0].reduce((a, b) => a + b, 0)).toBe(2)
  const low = renderDisplay(
    [Math.fround(0.18), Math.fround(0.18), Math.fround(0.18)],
    SDR_TARGET,
  ).luminance
  expect(result.bins[Math.floor((Math.log2(low) + 16) * 8)]).toBe(1)
})
