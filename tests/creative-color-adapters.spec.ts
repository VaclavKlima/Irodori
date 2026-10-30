import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  neutralAdjustments,
  renderAdjustments,
  sameAdjustments,
  srgbTransform,
} from '../src/shared/adjustments'
import { prepareCreativeColor } from '../src/shared/creative-color'
import { neutralColorMixer, type ColorMixerSettings } from '../src/shared/color-mixer'
import { neutralColorGrading, type ColorGradingSettings } from '../src/shared/color-grading'
import { adjustHdr, HDR_SOURCE_VERSION, SDR_TARGET, type HdrWorkingAsset } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import { rasterLinear } from '../src/main/export/raster'
import { initialSettings, validatePatch } from '../src/shared/edits'
import { supportsEditingSettings } from '../src/main/catalog/editing-migration'
import type { ColorPrimaries, ColorTriple } from '../src/shared/color-model'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: {
    input: ColorTriple
    output: ColorTriple
    primaries: ColorPrimaries
    configuration: number
  }[]
}
const parameters = reference.configurations.map((c) => ({
    ...neutralAdjustments,
    ...c.intensity,
    colorMixer: c.mixer,
    colorGrading: c.grading,
  })),
  compiled = parameters.map((p) => prepareCreativeColor(p)!)
const near = (actual: number, expected: number, message: string) =>
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= 2e-12 + 2e-11 * Math.abs(expected),
    `${message}: ${actual} vs ${expected}`,
  )
const byte = (value: number) => {
  const v = Math.max(0, Math.min(1, value))
  return Math.round(255 * (v < 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
}

test('CPU HDR, raster export and SDR preview adapters retain the independent color graph and alpha', () => {
  let hdrCount = 0,
    rasterCount = 0
  for (const v of reference.gpuVectors) {
    const p = parameters[v.configuration],
      color = compiled[v.configuration]
    if (v.primaries === 'rec2020') {
      const actual = adjustHdr([...v.input], p, undefined, color)
      for (let c = 0; c < 3; c++) near(actual[c], v.output[c], 'HDR adapter')
      hdrCount++
    } else if (v.input.every((c) => c >= 0)) {
      const actual = rasterLinear([...v.input], p, color),
        alpha = Math.fround((rasterCount % 4) / 3),
        preview = renderAdjustments(new Float32Array([...v.input, alpha]), p, srgbTransform)
      for (let c = 0; c < 3; c++) {
        near(actual[c], Math.max(0, Math.min(1, v.output[c])), 'raster adapter')
        assert.ok(Math.abs(preview[c] - byte(v.output[c])) <= 1, 'SDR byte conversion')
      }
      assert.equal(preview[3], Math.round(alpha * 255))
      rasterCount++
    }
  }
  expect(hdrCount).toBe(1260)
  expect(rasterCount).toBeGreaterThan(900)
  // Raster inputs retain the existing nonnegative input policy before creative color.
  const p = parameters[9],
    color = compiled[9],
    source = reference.gpuVectors.find(
      (v) =>
        v.primaries === 'srgb' &&
        v.configuration === 9 &&
        v.input[0] === 0 &&
        v.input[1] === 0 &&
        v.input[2] === 1,
    )!
  const clipped = rasterLinear([0, -0.1, 1], p, color)
  for (let c = 0; c < 3; c++)
    near(clipped[c], Math.max(0, Math.min(1, source.output[c])), 'legacy raster input clamp')
})

test('working HDR statistics include mixer luminance and use the same prepared color settings', () => {
  const vectors = reference.gpuVectors.filter(
      (v) =>
        v.primaries === 'rec2020' &&
        v.configuration === 9 &&
        (v.input.every((c) => c === 0) ||
          v.input.every((c) => c < 0) ||
          (v.input[0] > v.input[1] && v.input[1] > v.input[2] && v.input[2] > 0)),
    ),
    pixels = new Float32Array(vectors.flatMap((v) => [...v.input, 1])),
    sha = createHash('sha256').update(new Uint8Array(pixels.buffer)).digest('hex'),
    asset: HdrWorkingAsset = {
      kind: 'hdr-working-v1',
      width: vectors.length,
      height: 1,
      byteLength: pixels.byteLength,
      sha256: sha,
      strips: [{ byteLength: pixels.byteLength, sha256: sha }],
      source: {
        version: HDR_SOURCE_VERSION,
        processing: 'hdr-v1',
        colorSpace: 'rec2020',
        whitePoint: 'D65',
        transfer: 'linear',
        alpha: 'straight',
        decoder: 'synthetic-color-adapter-reference',
        orientation: 'applied-once',
        cameraProfile: 'synthetic-color-adapter-reference',
        normalization: {
          black: [0, 0, 0, 0],
          maximum: 65535,
          gains: [1, 1, 1, 1],
          restoreGain: 1,
          referenceWhite: 1,
          sourceSaturation: null,
        },
      },
    },
    result = hdrStatistics('working-hdr', SDR_TARGET, asset),
    expected = {
      zero: 0,
      negative: 0,
      aboveWhite: 0,
      underflow: 0,
      overflow: 0,
      bins: Array(256).fill(0) as number[],
    }
  analyzeHdr(pixels, parameters[9], asset, SDR_TARGET, result)
  for (const v of vectors) {
    const y =
      v.output[0] * (26158966 / 99577255) +
      v.output[1] * (472592308 / 697040785) +
      v.output[2] * (8267143 / 139408157)
    expected.aboveWhite += Number(y > 1)
    if (y === 0) expected.zero++
    else if (y < 0) expected.negative++
    else {
      const stop = Math.log2(y)
      if (stop < -16) expected.underflow++
      else if (stop >= 16) expected.overflow++
      else expected.bins[Math.floor((stop + 16) * 8)]++
    }
  }
  expect(vectors.length).toBeGreaterThan(20)
  expect(result.visiblePixels).toBe(vectors.length)
  for (const key of ['zero', 'negative', 'aboveWhite', 'underflow', 'overflow', 'bins'] as const)
    expect(result[key]).toEqual(expected[key])
})

test('color equality includes powerless controls and only versioned settings can persist creative color', () => {
  expect(prepareCreativeColor(neutralAdjustments)).toBeUndefined()
  expect(
    sameAdjustments(neutralAdjustments, {
      ...neutralAdjustments,
      colorMixer: neutralColorMixer,
      colorGrading: neutralColorGrading,
    }),
  ).toBe(true)
  const copy = structuredClone(parameters[0])
  Object.assign(copy.colorGrading.tones.midtones, { hue: 120 })
  expect(sameAdjustments(parameters[0], copy)).toBe(false)
  expect(sameAdjustments(copy, structuredClone(copy))).toBe(true)
  assert.doesNotThrow(() => validatePatch({ colorMixer: neutralColorMixer }))
  assert.doesNotThrow(() => validatePatch({ colorGrading: neutralColorGrading }))
  const current = initialSettings()
  expect(supportsEditingSettings(current as unknown as Record<string, unknown>)).toBe(true)
  expect(supportsEditingSettings({ ...current, version: 9, colorMixer: neutralColorMixer })).toBe(
    false,
  )
  expect(
    supportsEditingSettings({ ...current, version: 9, colorGrading: neutralColorGrading }),
  ).toBe(false)
})
