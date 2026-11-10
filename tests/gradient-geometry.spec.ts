import { expect, test } from '@playwright/test'
import { identityMaskGeometry, maskCanonicalPoint } from '../src/shared/mask-geometry'
import {
  centeredGradient,
  gradientFromDrag,
  gradientGuide,
  gradientHandlePoint,
  moveGradientHandle,
} from '../src/renderer/src/preview/gradient-geometry'
import { validateMaskGradient } from '../src/shared/masks'

test('centered defaults use photo extent and elliptical source pixels', () => {
  const geo = identityMaskGeometry(400, 200)
  expect(centeredGradient('linear', geo)).toEqual({
    kind: 'linear',
    start: { x: 0.5, y: 0.25 },
    end: { x: 0.5, y: 0.75 },
  })
  expect(centeredGradient('radial', geo)).toEqual({
    kind: 'radial',
    center: { x: 0.5, y: 0.5 },
    radiusX: 0.25,
    radiusY: 0.25,
    rotation: 0,
    feather: 50,
  })
  const radial = gradientFromDrag('radial', { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.7 })
  expect(radial).toMatchObject({
    radiusX: 0.3,
    radiusY: expect.closeTo(0.2),
    rotation: 0,
    feather: 50,
  })
  expect(() =>
    validateMaskGradient(gradientFromDrag('linear', { x: 0, y: 0 }, { x: 0, y: 0 }), 400, 200),
  ).toThrow()
})
test('handles keep rotation and movement in actual source pixels', () => {
  const g = {
    kind: 'radial' as const,
    center: { x: 0.5, y: 0.5 },
    radiusX: 0.25,
    radiusY: 0.25,
    rotation: 90,
    feather: 50,
  }
  expect(gradientHandlePoint(g, 'radiusX', 400, 200)).toEqual({ x: 0.5, y: 1 })
  const moved = moveGradientHandle(g, 'move', { x: 0.5, y: 0.5 }, { x: 0.6, y: 0.7 }, 400, 200)
  expect(moved).toMatchObject({
    center: { x: 0.6, y: 0.7 },
    radiusX: 0.25,
    radiusY: 0.25,
    rotation: 90,
  })
  expect(moveGradientHandle(g, 'radiusX', g.center, { x: 0.5, y: 0.75 }, 400, 200)).toMatchObject({
    radiusX: 0.125,
  })
})
test('sampled lens guides round-trip into the authored ellipse', () => {
  const geometry = {
    ...identityMaskGeometry(400, 200),
    correction: {
      width: 380,
      height: 180,
      left: 10,
      top: 10,
      distortion: Array.from({ length: 4096 }, (_, i) => 1 + 0.07 * (i / 4095) ** 2),
    },
  }
  const g = centeredGradient('radial', geometry)
  if (g.kind !== 'radial') throw Error('Expected ellipse')
  const lines = gradientGuide(g, geometry)!
  expect(lines).not.toBeNull()
  for (const output of lines[0]) {
    const p = maskCanonicalPoint(output, geometry)
    expect(Math.hypot((p.x - g.center.x) / g.radiusX, (p.y - g.center.y) / g.radiusY)).toBeCloseTo(
      1,
      4,
    )
  }
})

test('off-photo and panoramic guides clip to the source domain without refusing reliable handles', () => {
  for (const geometry of [identityMaskGeometry(200, 200), identityMaskGeometry(2400, 200)]) {
    const g = { kind: 'linear' as const, start: { x: -1, y: 2 }, end: { x: 2, y: -1 } },
      lines = gradientGuide(g, geometry)
    expect(lines).not.toBeNull()
    expect(lines!.length).toBeGreaterThan(0)
    for (const line of lines!)
      for (const output of line) {
        const p = maskCanonicalPoint(output, geometry)
        expect(p.x).toBeGreaterThanOrEqual(-1)
        expect(p.x).toBeLessThanOrEqual(2)
        expect(p.y).toBeGreaterThanOrEqual(-1)
        expect(p.y).toBeLessThanOrEqual(2)
      }
    for (const handle of ['start', 'move', 'end'] as const)
      expect(
        gradientHandlePoint(g, handle, geometry.canonicalWidth, geometry.canonicalHeight),
      ).toEqual(handle === 'move' ? { x: 0.5, y: 0.5 } : g[handle])
    // A horizontal transition has very long perpendiculars in a panorama.
    expect(
      gradientGuide(
        { kind: 'linear', start: { x: 0.25, y: 0.5 }, end: { x: 0.75, y: 0.5 } },
        geometry,
      ),
    ).not.toBeNull()
  }
})

test('partly outside ellipses retain separate clipped arcs and still refuse a folded lens', () => {
  const geometry = identityMaskGeometry(400, 200),
    g = {
      kind: 'radial' as const,
      center: { x: -0.8, y: 0.5 },
      radiusX: 1,
      radiusY: 0.25,
      rotation: 0,
      feather: 50,
    },
    lines = gradientGuide(g, geometry)
  expect(lines).not.toBeNull()
  for (const line of lines!)
    for (const output of line) {
      const p = maskCanonicalPoint(output, geometry)
      expect(p.x).toBeGreaterThanOrEqual(-1)
      expect(p.x).toBeLessThanOrEqual(2)
    }
  const arcs = lines!.filter((line) => line.length > 2)
  expect(arcs.length).toBeGreaterThan(2)
  // The outer and inner ellipses exit on the left. Each retained arc follows its
  // source ellipse, apart from the one clipped endpoint on the sampled chord.
  for (const arc of arcs) {
    const inside = arc.slice(1, -1)
    if (!inside.length) continue
    const first = maskCanonicalPoint(inside[0], geometry),
      scale = Math.hypot((first.x - g.center.x) / g.radiusX, (first.y - g.center.y) / g.radiusY)
    expect(Math.min(Math.abs(scale - 1), Math.abs(scale - 0.5))).toBeLessThan(1e-10)
    for (const output of inside) {
      const p = maskCanonicalPoint(output, geometry)
      expect(
        Math.hypot((p.x - g.center.x) / g.radiusX, (p.y - g.center.y) / g.radiusY),
      ).toBeCloseTo(scale, 10)
    }
  }
  expect(
    gradientGuide(g, {
      ...geometry,
      correction: {
        width: 400,
        height: 200,
        left: 0,
        top: 0,
        distortion: Array.from({ length: 4096 }, (_, i) => (i < 2000 ? 1 : 0.01)),
      },
    }),
  ).toBeNull()
})
