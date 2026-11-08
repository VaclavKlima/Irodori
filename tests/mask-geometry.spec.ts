import { expect, test } from '@playwright/test'
import { cropGeometry, identityCrop, mapCropAffine } from '../src/shared/crop'
import {
  identityMaskGeometry,
  maskCanonicalPoint,
  maskOutputSize,
  validateMaskGeometry,
  type MaskGeometry,
} from '../src/shared/mask-geometry'

test('mask coordinates retain the source grid through every decoder orientation and crop', () => {
  for (let flip = 0; flip < 8; flip++) {
    const sourceWidth = 80,
      sourceHeight = 60
    const canonicalWidth = flip & 4 ? sourceHeight : sourceWidth
    const canonicalHeight = flip & 4 ? sourceWidth : sourceHeight
    const base: MaskGeometry = {
      version: 1,
      sourceWidth,
      sourceHeight,
      canonicalWidth,
      canonicalHeight,
      flip,
    }
    for (const quarterTurns of [0, 1, 2, 3] as const) {
      const crop = cropGeometry(
        { width: canonicalWidth, height: canonicalHeight },
        {
          ...identityCrop,
          quarterTurns,
          width: 0.6,
          height: 0.6,
        },
      )
      const geometry = { ...base, crop }
      validateMaskGeometry(geometry)
      expect(maskOutputSize(geometry)).toEqual({ width: crop.width, height: crop.height })
      for (const point of [
        { x: 0.5, y: 0.5 },
        { x: crop.width / 2, y: crop.height / 2 },
      ]) {
        const expected = mapCropAffine(crop.outputToSource, point)
        const actual = maskCanonicalPoint(point, geometry)
        expect(actual.x).toBeCloseTo(expected.x / canonicalWidth, 13)
        expect(actual.y).toBeCloseTo(expected.y / canonicalHeight, 13)
      }
    }
  }
})

test('lens coverage uses the green distortion mapping and its correction crop in source pixel centers', () => {
  const geometry: MaskGeometry = {
    ...identityMaskGeometry(100, 80),
    correction: { width: 90, height: 72, left: 5, top: 4, distortion: Array(4096).fill(0.8) },
  }
  validateMaskGeometry(geometry)
  for (const point of [
    { x: 0.5, y: 0.5 },
    { x: 45, y: 36 },
    { x: 89.5, y: 71.5 },
  ]) {
    const actual = maskCanonicalPoint(point, geometry)
    expect(actual.x).toBeCloseTo((50 + (point.x + 5 - 50) * 0.8) / 100, 13)
    expect(actual.y).toBeCloseTo((40 + (point.y + 4 - 40) * 0.8) / 80, 13)
  }
  const transported = JSON.parse(JSON.stringify(geometry)) as MaskGeometry
  expect(maskCanonicalPoint({ x: 12, y: 23 }, transported)).toEqual(
    maskCanonicalPoint({ x: 12, y: 23 }, geometry),
  )
  expect(() =>
    validateMaskGeometry({ ...geometry, correction: { ...geometry.correction!, distortion: [1] } }),
  ).toThrow('lens geometry')
})

test('mask geometry refuses invalid source identities and non-finite mappings', () => {
  expect(() => validateMaskGeometry({ ...identityMaskGeometry(10, 20), flip: 4 })).toThrow(
    'source geometry',
  )
  expect(() => validateMaskGeometry(identityMaskGeometry(0, 20))).toThrow('source geometry')
  const crop = cropGeometry({ width: 10, height: 20 }, identityCrop)
  expect(() =>
    validateMaskGeometry({
      ...identityMaskGeometry(10, 20),
      crop: { ...crop, outputToSource: [NaN, 0, 0, 1, 0, 0] },
    }),
  ).toThrow('crop geometry')
})
