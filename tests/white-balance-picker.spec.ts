import { expect, test } from '@playwright/test'
import {
  proposeNeutralWhiteBalance,
  validateWhiteBalanceSample,
  whiteBalanceSampleArea,
} from '../src/shared/white-balance-picker'
import { whiteBalanceMatrix } from '../src/shared/white-balance'
import { profile, normalization, product, patch } from './white-balance-picker.helpers'
import { sensorBlendParameters, sensorBlendRgb } from '../src/main/gpu/sensor-blend'

test('published D50 and D65 neutral patches recover neutrality through one combined provider setting', () => {
  // Independent white chromaticities: W3C CSS Color 4, 2026-10-22, predefined white points.
  // Synthetic camera responses are not measurements of a physical camera or neutral card.
  for (const [x, y] of [
    [0.3457, 0.3585],
    [0.3127, 0.329],
  ]) {
    const xyz = [x / y, 1, (1 - x - y) / y]
    const pixels = patch(product(profile.xyzToCamera, xyz).map((v) => v * 0.15))
    const result = proposeNeutralWhiteBalance(pixels, profile, normalization)
    expect(result.status, JSON.stringify(result)).toBe('valid')
    if (result.status !== 'valid') throw new Error('Expected a valid independent neutral.')
    expect(result.accepted).toBe(49)
    expect(result.residual!).toBeLessThanOrEqual(0.01)
    const matrix = whiteBalanceMatrix(result.settings, profile)!
    const corrected = product(matrix, Array.from(pixels.subarray(0, 3)))
    for (const value of corrected)
      expect(Math.abs(value / corrected[1] - 1)).toBeLessThanOrEqual(0.01)
    const original = [...pixels]
    // One contaminated pixel is excluded; the accepted estimate remains stable.
    pixels.set([20, 20, 20, 1], 0)
    expect(proposeNeutralWhiteBalance(pixels, profile, normalization)).toMatchObject({
      status: 'valid',
      settings: result.settings,
      accepted: 48,
      rejected: { clipped: 1 },
    })
    expect(original.slice(4)).toEqual([...pixels].slice(4))
  }
})

test('darkness, clipping, transparency, small areas, uneven lighting and unsupported data produce no edit proposal', () => {
  for (const [pixels, reason] of [
    [patch([0, 0, 0]), 'dark'],
    [patch([0.001, 0.001, 0.001]), 'dark'],
    [patch([1, 1, 1]), 'clipped'],
    [patch([0.1, 0.1, 0.1], 49, 0), 'insufficient-coverage'],
    [patch([0.1, 0.1, 0.1], 9), 'insufficient-coverage'],
    [patch([0.01, 0.4, 0.02]), 'out-of-model'],
  ] as const)
    expect(proposeNeutralWhiteBalance(pixels, profile, normalization)).toMatchObject({
      status: 'invalid',
      reason,
    })
  const uneven = patch([0.1, 0.1, 0.1])
  uneven.set(patch([0.15, 0.1, 0.07], 24))
  expect(proposeNeutralWhiteBalance(uneven, profile, normalization)).toMatchObject({
    status: 'invalid',
    reason: 'uneven-sample',
  })
  expect(proposeNeutralWhiteBalance(uneven, undefined, normalization)).toMatchObject({
    status: 'invalid',
    reason: 'unsupported-source',
  })
  expect(
    proposeNeutralWhiteBalance(uneven, profile, { ...normalization, sourceSaturation: null }),
  ).toMatchObject({ status: 'invalid', reason: 'source-limits-unavailable' })
  expect(() =>
    proposeNeutralWhiteBalance(new Float32Array(32 * 32 * 4), profile, normalization),
  ).toThrow('bounded')
})

test('the conservative source threshold rejects clipped samples after highlight blending', () => {
  const normal = {
    ...normalization,
    sourceSaturation: { thresholds: [0.95, 0.95, 0.95, 0.95], saturatedSites: 1, totalSites: 49 },
  }
  const blend = sensorBlendParameters(normal)!
  expect(blend).not.toBeNull()
  for (const r of [0, 0.2, 0.8, 0.95, 1])
    for (const g of [0, 0.2, 0.8, 0.95, 1])
      for (const b of [0, 0.2, 0.8, 0.95, 1]) {
        if (Math.max(r, g, b) < 0.95) continue
        const balanced = sensorBlendRgb([r, g / 2, b * 0.75], blend)
        const working = product(
          profile.cameraToWorking,
          balanced.map((v) => v * normal.restoreGain),
        )
        const pixels = new Float32Array(Array.from({ length: 49 }, () => [...working, 1]).flat())
        expect(
          proposeNeutralWhiteBalance(pixels, profile, normal).status,
          JSON.stringify({ r, g, b, working }),
        ).toBe('invalid')
      }
})

test('sample geometry uses oriented native pixel centers and clips only the sample area at image boundaries', () => {
  expect(whiteBalanceSampleArea({ x: 0.5, y: 0.5, diameter: 7 }, 101, 81)).toEqual({
    x: 47,
    y: 37,
    width: 7,
    height: 7,
    centerX: 50,
    centerY: 40,
  })
  expect(whiteBalanceSampleArea({ x: 1, y: 1, diameter: 15 }, 101, 81)).toEqual({
    x: 93,
    y: 73,
    width: 8,
    height: 8,
    centerX: 100,
    centerY: 80,
  })
  for (const invalid of [
    { x: -0.1, y: 0.5, diameter: 7 },
    { x: 0.5, y: NaN, diameter: 7 },
    { x: 0.5, y: 0.5, diameter: 1000 },
    { x: 0.5, y: 0.5, diameter: 7, path: '/tmp/source' },
  ])
    expect(() => validateWhiteBalanceSample(invalid)).toThrow('normalized')
})
