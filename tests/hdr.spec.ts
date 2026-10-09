import { expect, test } from '@playwright/test'
import { adjustHdr, outputHdr, SDR_TARGET, type RGB, type HdrWorkingAsset } from '../src/shared/hdr'
import { neutralAdjustments } from '../src/shared/adjustments'
import { analyzeHdr, hdrStatistics, reduceHdrMask } from '../src/shared/hdr-statistics'
import { sensorBlendParameters, sensorBlendRgb } from '../src/main/gpu/sensor-blend'
import { hdrRangeColor } from '../src/renderer/src/preview/hdr-ranges'
import { renderHdrContent } from '../src/shared/display-rendering'

test('HDR values and signed channels survive exposure round trips; alpha is separate', () => {
  for (const value of [0, 0.18, 1, 2, 4, 16, -0.1]) {
    const input: RGB = [value, value, value]
    const brighter = adjustHdr(input, { ...neutralAdjustments, exposureEv: 1 })
    expect(adjustHdr(brighter, { ...neutralAdjustments, exposureEv: -1 })).toEqual(input)
  }
})
test('ACES gamut handling and reference white limiting bound extreme colors', () => {
  for (const rgb of [
    [16, -0.1, 4],
    [-2, 4, 1],
    [0, 16, 0],
    [4, 0, 0],
  ] as RGB[]) {
    for (const colorSpace of ['srgb', 'display-p3'] as const) {
      const result = outputHdr(rgb, { ...SDR_TARGET, colorSpace, peak: 4, mode: 'hdr' })
      expect(result.rgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 4)).toBe(true)
    }
  }
})
test('HDR histograms have exact boundaries, alpha exclusion and distinct warnings', () => {
  const asset = { source: { normalization: { sourceSaturation: null } } } as HdrWorkingAsset
  const target = { ...SDR_TARGET, peak: 4, headroom: 4, mode: 'hdr' as const }
  const result = hdrStatistics('working-hdr', target, asset)
  const values = [0, -1, 2 ** -17, 2 ** -16, 1, 2, 4, 16, 65536]
  const data = new Float32Array(values.flatMap((v) => [v, v, v, 1]).concat([2, 2, 2, 0]))
  analyzeHdr(data, neutralAdjustments, asset, target, result)
  expect(result.visiblePixels).toBe(9)
  expect([result.zero, result.negative, result.underflow, result.overflow]).toEqual([1, 1, 1, 1])
  expect(result.bins[0]).toBe(1)
  expect(result.bins[128]).toBe(1)
  expect(result.bins.reduce((a, b) => a + b, 0)).toBe(5)
  expect(result.aboveWhite).toBe(4)
  expect(result.exceedingHeadroom).toBeNull()
  const output = hdrStatistics('output', target, asset)
  analyzeHdr(data, neutralAdjustments, asset, target, output)
  const renderedLuminances = values.map((v) => outputHdr([v, v, v], target).luminance)
  expect(output.exceedingHeadroom).toBe(
    values.filter((v) => renderHdrContent([v, v, v]).luminance > target.headroom).length,
  )
  expect(output.aboveWhite).toBe(renderedLuminances.filter((y) => y > 1).length)
  expect(result.sourceSaturation).toBeNull()
  const mask = new Uint8Array(35)
  mask[17] = 8
  const pyramid = reduceHdrMask(mask, 7, 5)
  expect(pyramid.levels.at(-1)!.data[0]).toBe(8)
})

test('RGB output histogram maps encoded SDR and fixed HDR stop boundaries independently of content', async () => {
  const { rgbHistogram, rgbHistogramBin, addRgbHistogram } =
    await import('../src/shared/rgb-histogram')
  const sdr = rgbHistogram(SDR_TARGET)
  expect(sdr.rgb[0]).toHaveLength(256)
  for (let i = 0; i < 256; i++) {
    const encoded = i / 255
    const linear = encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4
    expect(rgbHistogramBin(linear, sdr)).toBe(i)
    addRgbHistogram(sdr, [linear, linear, linear], i === 0 ? 0 : 0.5)
  }
  expect(sdr.visiblePixels).toBe(255)
  expect(sdr.rgb[0]).toEqual(sdr.rgb[1])
  expect(sdr.rgb[1]).toEqual(sdr.rgb[2])
  const hdr = rgbHistogram({ ...SDR_TARGET, mode: 'hdr', peak: 8, headroom: 8, generation: 7 })
  expect(hdr).toMatchObject({ maxStops: 4, targetGeneration: 7, displayLimitStops: 3 })
  expect(hdr.rgb[0]).toHaveLength(512)
  expect([0, 1, 1 + Number.EPSILON, 2, 4, 8, 16, 32].map((v) => rgbHistogramBin(v, hdr))).toEqual([
    0, 255, 256, 320, 384, 448, 511, 511,
  ])
  addRgbHistogram(hdr, [0, 2, 4], 1)
  expect(hdr.rgb[0][0]).toBe(1)
  expect(hdr.rgb[1][320]).toBe(1)
  expect(hdr.rgb[2][384]).toBe(1)
  expect(rgbHistogramBin(-2, hdr)).toBe(0)
  expect(rgbHistogram({ ...SDR_TARGET, mode: 'hdr', peak: 20, headroom: 20 }).maxStops).toBe(4)
  expect(() => addRgbHistogram(hdr, [NaN, 0, 0], 1)).toThrow('Invalid')
})

test('HDR presentation budgets count actual source mips and large viewport allocations', async () => {
  const { hdrPresentationMemory, HDR_PRESENTATION_BUDGET } =
    await import('../src/renderer/src/preview/hdr-memory')
  const small = hdrPresentationMemory(2, 2, 10, 10)
  expect(small.textureBytes).toBe((4 + 1) * 16)
  expect(small.canvasBytes).toBe(3200)
  expect(small.transportBytes).toBe(2 * 1024 ** 2)
  expect(HDR_PRESENTATION_BUDGET).toBe(768 * 1024 ** 2)
  const ultrawide = hdrPresentationMemory(4000, 3000, 3440, 1440)
  expect(ultrawide.total).toBeLessThan(HDR_PRESENTATION_BUDGET)
  // A native 20 MP source and a wide canvas fit because upload and presentation do not overlap.
  const sony = hdrPresentationMemory(5472, 3648, 2900, 1000)
  expect(sony.uploadPeak).toBeLessThan(HDR_PRESENTATION_BUDGET)
  expect(sony.presentationPeak).toBeLessThan(HDR_PRESENTATION_BUDGET)
  expect(sony.total).toBeLessThan(HDR_PRESENTATION_BUDGET)
  const retina = hdrPresentationMemory(5496, 3672, 4800, 1800)
  expect(retina.total).toBeGreaterThan(512 * 1024 ** 2)
  expect(retina.total).toBeLessThan(HDR_PRESENTATION_BUDGET)
  expect(retina.cacheSlots).toBeLessThan(sony.cacheSlots)
  expect(retina.cacheSlots).toBeGreaterThan(0)
  // The offscreen completed-frame surface is included; larger surfaces use explicit fallback.
  expect(hdrPresentationMemory(5496, 3672, 5800, 2000).total).toBeGreaterThan(
    HDR_PRESENTATION_BUDGET,
  )
  const fixed = hdrPresentationMemory(5496, 3672).minimumPresentationPeak
  const pixels = Math.floor((HDR_PRESENTATION_BUDGET - fixed) / 32)
  expect(hdrPresentationMemory(5496, 3672, pixels, 1).total).toBeLessThanOrEqual(
    HDR_PRESENTATION_BUDGET,
  )
  expect(hdrPresentationMemory(5496, 3672, pixels + 1, 1).total).toBeGreaterThan(
    HDR_PRESENTATION_BUDGET,
  )
  expect(hdrPresentationMemory(6000, 4000, 6880, 2880).total).toBeGreaterThan(
    HDR_PRESENTATION_BUDGET,
  )
})

test('sensor-aware highlight blending preserves intensity, smooth onset and unsaturated HDR color', () => {
  const normal = {
    black: [64, 64, 64, 64],
    maximum: 1000,
    gains: [2, 1, 1.5, 1],
    restoreGain: 2,
    referenceWhite: 0.5,
    sourceSaturation: { thresholds: [964, 964, 964, 964], saturatedSites: 0, totalSites: 4 },
  }
  const parameters = sensorBlendParameters(normal)!
  expect(parameters).not.toBeNull()
  const full = sensorBlendRgb([1, 0.5, 0.75], parameters)
  for (const v of full) expect(v).toBeCloseTo(0.75, 12)
  const partial: RGB = [0.95, 0.475, 0.7125]
  const blended = sensorBlendRgb(partial, parameters)
  expect(blended.reduce((a, b) => a + b)).toBeCloseTo(
    partial.reduce((a, b) => a + b),
    12,
  )
  expect(Math.max(...blended) - Math.min(...blended)).toBeLessThan(
    Math.max(...partial) - Math.min(...partial),
  )
  expect(Math.max(...blended) - Math.min(...blended)).toBeGreaterThan(0)
  const colored: RGB = [0.85, 0.1, 0.6]
  expect(sensorBlendRgb(colored, parameters)).toEqual(colored)
  expect(sensorBlendParameters({ ...normal, sourceSaturation: null })).toBeNull()
  expect(sensorBlendRgb(partial, null)).toEqual(partial)
})

test('HDR ranges classify final display-linear colors with exact stop and headroom boundaries', () => {
  const target = { ...SDR_TARGET, mode: 'hdr' as const, peak: 16, headroom: 16 }
  const colors = [null, [0, 1, 1], [0, 0, 1], [0.6, 0, 1], [1, 0, 1]]
  for (const [i, v] of [1, 2, 4, 8, 16].entries())
    expect(hdrRangeColor([v, v, v], target, 0, 0)).toEqual(colors[i])
  expect(hdrRangeColor([4.01, 4.01, 4.01], { ...target, peak: 4, headroom: 4 }, 0, 0)).toEqual([
    1, 0, 0,
  ])
  expect(hdrRangeColor([4.01, 4.01, 4.01], { ...target, peak: 4, headroom: 4 }, 4, 0)).toEqual([
    0.35, 0.02, 0.02,
  ])
  expect(hdrRangeColor([0.8, 0, 0], target, 0, 0)).toBeNull()
})
