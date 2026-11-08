import { test, expect } from '@playwright/test'
import {
  inspectionPoint,
  inspectionDrag,
  inspectionGeometryMatches,
  validInspectionRectangle,
} from '../src/renderer/src/preview/inspection-geometry'
import type { AgentInspectionRegion } from '../src/shared/agent'
import { croppedMaskGeometry, identityMaskGeometry } from '../src/shared/mask-geometry'
import { cropGeometry, identityCrop } from '../src/shared/crop'

const rectangle: AgentInspectionRegion['region'] = {
  units: 'pixels',
  gridIdentity: 'grid',
  x: 20,
  y: 30,
  width: 100,
  height: 80,
}
const size = { width: 2000, height: 1000 }

test('accepts omitted identity crop while rejecting equal-sized rotated geometry', () => {
  const base = identityMaskGeometry(size.width, size.height)
  expect(
    inspectionGeometryMatches(base, croppedMaskGeometry(base, cropGeometry(size, identityCrop))),
  ).toBe(true)
  expect(
    inspectionGeometryMatches(
      base,
      croppedMaskGeometry(base, cropGeometry(size, { ...identityCrop, quarterTurns: 2 })),
    ),
  ).toBe(false)
})

test('maps pointer edges through committed presentation and current viewport size', () => {
  const geometry = {
    image: size,
    viewport: { width: 800, height: 600 },
    view: { fit: false, scale: 2, x: -100, y: 40 },
    serial: 1,
  }
  // Requested view changes do not participate in mapping until presentation commits them.
  expect(inspectionPoint({ x: 200, y: 150 }, geometry, { width: 400, height: 300 })).toEqual({
    x: 1050,
    y: 480,
  })
  expect(inspectionPoint({ x: -10000, y: 10000 }, geometry, geometry.viewport)).toEqual({
    x: 0,
    y: 1000,
  })
})

test('creates outward integer bounds in either direction and keeps move inside full photograph', () => {
  expect(
    inspectionDrag({ x: 11.7, y: 22.2 }, { x: 2.6, y: 7.8 }, rectangle, 'create', size),
  ).toMatchObject({ x: 2, y: 7, width: 10, height: 16 })
  expect(
    inspectionDrag({ x: 50, y: 60 }, { x: -500, y: 3000 }, rectangle, 'move', size),
  ).toMatchObject({ x: 0, y: 920, width: 100, height: 80 })
  expect(inspectionDrag({ x: 20, y: 30 }, { x: 130, y: 120 }, rectangle, 'nw', size)).toMatchObject(
    { x: 120, y: 110, width: 10, height: 10 },
  )
})

test('numeric regions reject fractional, empty and outside pixel extents', () => {
  expect(validInspectionRectangle(rectangle, size)).toBe(true)
  for (const patch of [{ x: -1 }, { width: 0 }, { height: 0.5 }, { x: 1999 }, { y: Number.NaN }])
    expect(validInspectionRectangle({ ...rectangle, ...patch }, size)).toBe(false)
})
