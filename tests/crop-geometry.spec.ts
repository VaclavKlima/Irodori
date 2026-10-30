import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import reference from './fixtures/crop-reference.json' with { type: 'json' }
import {
  cropGeometry,
  cropPointToSource,
  fitCrop,
  identityCrop,
  mapCropAffine,
  quarterTurnedSize,
  rotateCrop,
  sourcePointToCrop,
  validateCrop,
  type CropSettings,
} from '../src/shared/crop'

test('geometry projects only native dimensions and survives JSON transport without pixel payloads', () => {
  const source = { width: 7, height: 5, data: new Float32Array(140), path: '/not-part-of-geometry' }
  for (const quarterTurns of [0, 1, 2, 3] as const) {
    expect(Object.keys(quarterTurnedSize(source, quarterTurns)).sort()).toEqual(['height', 'width'])
    const geometry = cropGeometry(source, { ...identityCrop, quarterTurns })
    expect(geometry.source).toEqual({ width: 7, height: 5 })
    expect(JSON.parse(JSON.stringify(geometry))).toEqual(geometry)
    expect(JSON.stringify(geometry).length).toBeLessThan(1000)
  }
})

test('crop fitting and affine mapping agree with independent Decimal80 corner-search rotations', async () => {
  expect(reference.precision).toBe(80)
  expect(reference.cases).toHaveLength(216)
  expect(
    createHash('sha256')
      .update(await readFile('scripts/research/crop-reference.py'))
      .digest('hex'),
  ).toBe(reference.generatorSha256)
  let maximumFractionError = 0,
    maximumPixelError = 0,
    maximumInverseError = 0,
    checked = 0
  for (const vector of reference.cases) {
    const fitted = fitCrop(vector.source, vector.requested as CropSettings),
      geometry = cropGeometry(vector.source, fitted)
    maximumFractionError = Math.max(
      maximumFractionError,
      Math.abs(fitted.width - vector.fitted.width),
      Math.abs(fitted.height - vector.fitted.height),
    )
    expect({ width: geometry.width, height: geometry.height }).toEqual(vector.output)
    for (const sample of vector.vectors) {
      const point = mapCropAffine(geometry.outputToSource, sample.point),
        inverse = mapCropAffine(geometry.sourceToOutput, point)
      maximumPixelError = Math.max(
        maximumPixelError,
        Math.abs(point.x - sample.source.x),
        Math.abs(point.y - sample.source.y),
      )
      maximumInverseError = Math.max(
        maximumInverseError,
        Math.abs(inverse.x - sample.point.x),
        Math.abs(inverse.y - sample.point.y),
      )
      checked++
    }
  }
  expect(checked).toBe(1512)
  expect(maximumFractionError).toBeLessThanOrEqual(2e-14)
  expect(maximumPixelError).toBeLessThanOrEqual(2e-9)
  expect(maximumInverseError).toBeLessThanOrEqual(2e-9)
})

test('identity, integer crops and quarter turns map every pixel to an exact native pixel permutation', () => {
  for (const source of [
    { width: 7, height: 5 },
    { width: 8, height: 6 },
  ]) {
    expect(cropGeometry(source, identityCrop).identity).toBe(true)
    for (const initial of [
      identityCrop,
      {
        ...identityCrop,
        centerX: 3 / source.width,
        centerY: 2 / source.height,
        width: 4 / source.width,
        height: 2 / source.height,
      },
    ]) {
      let crop = initial
      const start = cropGeometry(source, crop),
        expected = new Set<string>()
      for (let y = 0; y < start.height; y++)
        for (let x = 0; x < start.width; x++) {
          const point = mapCropAffine(start.outputToSource, { x: x + 0.5, y: y + 0.5 })
          expected.add(`${point.x}:${point.y}`)
        }
      for (let turn = 0; turn < 4; turn++) {
        const geometry = cropGeometry(source, crop),
          actual = new Set<string>()
        expect(geometry.pixelAligned).toBe(true)
        expect(geometry.width).toBe(turn % 2 ? start.height : start.width)
        expect(geometry.height).toBe(turn % 2 ? start.width : start.height)
        for (let y = 0; y < geometry.height; y++)
          for (let x = 0; x < geometry.width; x++) {
            const point = mapCropAffine(geometry.outputToSource, { x: x + 0.5, y: y + 0.5 })
            expect(point.x - Math.floor(point.x)).toBe(0.5)
            expect(point.y - Math.floor(point.y)).toBe(0.5)
            actual.add(`${point.x}:${point.y}`)
          }
        expect(actual).toEqual(expected)
        crop = rotateCrop(crop, 1)
      }
      const finish = cropGeometry(source, crop)
      expect(finish.outputToSource).toEqual(start.outputToSource)
      expect(cropGeometry(source, rotateCrop(initial, -1)).outputToSource).toEqual(
        cropGeometry(source, rotateCrop(rotateCrop(rotateCrop(initial, 1), 1), 1)).outputToSource,
      )
    }
  }
})

test('normalized picker mapping and ROI projection retain original native coordinates after straighten and turns', () => {
  const source = { width: 5496, height: 3672 }
  for (const quarterTurns of [0, 1, 2, 3] as const) {
    const crop = fitCrop(source, {
        ...identityCrop,
        quarterTurns,
        angle: 12.34,
        centerX: 0.4,
        width: 0.6,
        height: 0.8,
      }),
      geometry = cropGeometry(source, crop)
    for (const point of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.41, y: 0.62 },
    ]) {
      const native = cropPointToSource(geometry, point)!,
        roundTrip = sourcePointToCrop(geometry, native)!
      expect(native.x).toBeGreaterThanOrEqual(0)
      expect(native.x).toBeLessThanOrEqual(1)
      expect(native.y).toBeGreaterThanOrEqual(0)
      expect(native.y).toBeLessThanOrEqual(1)
      expect(Math.abs(roundTrip.x - point.x)).toBeLessThanOrEqual(2e-12)
      expect(Math.abs(roundTrip.y - point.y)).toBeLessThanOrEqual(2e-12)
    }
    expect(cropPointToSource(geometry, { x: 1.001, y: 0.5 })).toBeNull()
    expect(cropPointToSource(geometry, { x: NaN, y: 0.5 })).toBeNull()
    expect(sourcePointToCrop(geometry, { x: NaN, y: 0.5 })).toBeNull()
    // A native square projects to a rotated quadrilateral, not a screen-sized sampling box.
    const center = cropPointToSource(geometry, { x: 0.5, y: 0.5 })!,
      a = sourcePointToCrop(geometry, {
        x: center.x - 7 / source.width,
        y: center.y - 7 / source.height,
      })!,
      b = sourcePointToCrop(geometry, {
        x: center.x + 7 / source.width,
        y: center.y - 7 / source.height,
      })!
    expect(
      Math.abs(Math.hypot((b.x - a.x) * geometry.width, (b.y - a.y) * geometry.height) - 14),
    ).toBeLessThanOrEqual(2e-9)
  }
})

test('invalid contracts, outside bounds, too-small crops and incompatible aspect locks reject without mutation', () => {
  for (const patch of [
    { version: 2 },
    { angle: NaN },
    { angle: 45.01 },
    { angle: 0.001 },
    { centerX: 0 },
    { centerY: 1 },
    { centerX: '0.5' },
    { width: 0 },
    { width: 1.1 },
    { height: Infinity },
    { quarterTurns: 4 },
    { quarterTurns: 0.5 },
    { aspectRatio: 0 },
    { aspectRatio: Infinity },
    { unknown: 1 },
  ])
    expect(() => validateCrop({ ...identityCrop, ...patch })).toThrow('Invalid crop')
  const source = { width: 1200, height: 800 }
  expect(() => cropGeometry(source, { ...identityCrop, angle: 12 })).toThrow('outside')
  expect(() => cropGeometry(source, { ...identityCrop, width: 0.0001 })).toThrow('one native pixel')
  expect(() => cropGeometry(source, { ...identityCrop, aspectRatio: 1 })).toThrow('aspect ratio')
  expect(() => cropGeometry({ width: 0, height: 800 }, identityCrop)).toThrow('dimensions')
  const locked = fitCrop(source, { ...identityCrop, aspectRatio: 1, angle: -30 }),
    geometry = cropGeometry(source, locked)
  expect(geometry.width).toBe(geometry.height)
  expect(locked.centerX).toBe(0.5)
  expect(locked.centerY).toBe(0.5)
  expect(cropGeometry(source, { ...identityCrop, aspectRatio: 1.5 }).identity).toBe(true)
  expect(identityCrop).toEqual({
    version: 1,
    quarterTurns: 0,
    angle: 0,
    centerX: 0.5,
    centerY: 0.5,
    width: 1,
    height: 1,
    aspectRatio: null,
  })
})
