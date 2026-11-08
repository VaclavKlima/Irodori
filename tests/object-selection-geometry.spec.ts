import { expect, test } from '@playwright/test'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import { croppedMaskGeometry, identityMaskGeometry } from '../src/shared/mask-geometry'
import { selectionCanonicalBox, selectionCanonicalPoint } from '../src/shared/object-selection'
import {
  selectionDisplayPoint,
  selectionScreenPoint,
} from '../src/renderer/src/preview/object-selection-geometry'

test('object guides use the completed photograph view and current viewport dimensions', () => {
  const geometry = {
    image: { width: 2000, height: 1000 },
    viewport: { width: 800, height: 600 },
    view: { fit: false, scale: 2, x: -100, y: 40 },
    serial: 4,
  }
  const viewport = { width: 400, height: 300 }
  const point = selectionDisplayPoint({ x: 200, y: 150 }, geometry, viewport)!
  expect(point).toEqual({ x: 1050, y: 480 })
  expect(selectionScreenPoint(point, geometry, viewport)).toEqual({ x: 200, y: 150 })
  expect(selectionDisplayPoint({ x: -10000, y: 10000 }, geometry, viewport)).toBeNull()
  expect(selectionDisplayPoint({ x: -10000, y: 10000 }, geometry, viewport, true)).toEqual({
    x: 0,
    y: 1000,
  })
})

test('a guide box has an outward native-pixel pad without changing the displayed rectangle', () => {
  const mapped = selectionCanonicalBox(
    { x: 800, y: 500 },
    { x: 200, y: 100 },
    identityMaskGeometry(1000, 600),
  )!
  expect(mapped.rectangle).toEqual({ x: 200, y: 100, width: 600, height: 400 })
  expect(mapped.box).toEqual([0.199, 100 / 600 - 1 / 600, 0.801, 500 / 600 + 1 / 600])
  expect(
    selectionCanonicalBox({ x: 0, y: 0 }, { x: 1000, y: 600 }, identityMaskGeometry(1000, 600))
      ?.box,
  ).toEqual([0, 0, 1, 1])
})

test('equal-sized rotation and lens geometry map point and box guides into canonical source coordinates', () => {
  const size = { width: 1000, height: 600 }
  const rotated = croppedMaskGeometry(
    identityMaskGeometry(1000, 600),
    cropGeometry(size, { ...identityCrop, quarterTurns: 2 }),
  )
  const mapped = selectionCanonicalBox({ x: 100, y: 120 }, { x: 300, y: 240 }, rotated)!
  expect(mapped.box[0]).toBeCloseTo(0.699)
  expect(mapped.box[1]).toBeCloseTo(0.6 - 1 / 600)
  expect(mapped.box[2]).toBeCloseTo(0.901)
  expect(mapped.box[3]).toBeCloseTo(0.8 + 1 / 600)
  const lens = {
    ...identityMaskGeometry(1000, 600),
    correction: {
      width: 900,
      height: 560,
      left: 50,
      top: 20,
      distortion: Array.from({ length: 4096 }, (_, i) => 0.9 + (i / 4095) * 0.2),
    },
  }
  const box = selectionCanonicalBox({ x: 200, y: 160 }, { x: 700, y: 420 }, lens)!.box
  for (let i = 0; i <= 64; i++)
    for (const point of [
      { x: 200 + (500 * i) / 64, y: 160 },
      { x: 200 + (500 * i) / 64, y: 420 },
      { x: 200, y: 160 + (260 * i) / 64 },
      { x: 700, y: 160 + (260 * i) / 64 },
    ]) {
      const [x, y] = selectionCanonicalPoint(point, lens)!
      expect(x).toBeGreaterThanOrEqual(box[0])
      expect(x).toBeLessThanOrEqual(box[2])
      expect(y).toBeGreaterThanOrEqual(box[1])
      expect(y).toBeLessThanOrEqual(box[3])
    }
})

test('unfinished or outside guides are refused instead of silently targeting the whole photograph', () => {
  const geometry = identityMaskGeometry(1000, 600)
  expect(selectionCanonicalBox({ x: 10, y: 10 }, { x: 10.2, y: 100 }, geometry)).toBeNull()
  expect(selectionCanonicalBox({ x: -2, y: 10 }, { x: 50, y: 100 }, geometry)).toBeNull()
  expect(selectionCanonicalPoint({ x: Number.NaN, y: 10 }, geometry)).toBeNull()
})
