import { expect, test } from '@playwright/test'
import {
  maskCapabilities,
  validateMaskGradient,
  validateMaskMutation,
  validateMaskStack,
  neutralMaskLight,
} from '../src/shared/masks'
import {
  hasLocalMasks,
  localMaskPixelData,
  localMaskAllocationBytes,
  maskHasCoverage,
  MASK_DESCRIPTOR_VEC4S,
  packLocalMasks,
} from '../src/shared/masks-gpu'
import { maskEdgePixelIdentity } from '../src/shared/mask-edges'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { generatedMask } from './helpers/generated-mask'
import { gradientMask } from './helpers/mask-gradients'
import { referenceCoverage } from './helpers/mask-reference'

test('linear and radial contracts admit extended source geometry and refuse degenerate or unsupported shapes', () => {
  const linear = { kind: 'linear', start: { x: -1, y: 2 }, end: { x: 2, y: -1 } },
    radial = {
      kind: 'radial',
      center: { x: 2, y: -1 },
      radiusX: 2,
      radiusY: 2,
      rotation: -180,
      feather: 100,
    }
  expect(maskCapabilities.version).toBe(4)
  for (const gradient of [linear, radial, { ...radial, feather: 0 }, { ...radial, rotation: 180 }])
    expect(() => validateMaskGradient(gradient, 100, 80)).not.toThrow()
  for (const gradient of [
    { ...linear, start: { x: -1.00001, y: 0.5 } },
    { ...linear, end: { x: NaN, y: 0 } },
    { ...linear, end: linear.start },
    { ...linear, start: { x: 0.5, y: 0.5 }, end: { x: 0.5001, y: 0.5 } },
    { ...linear, start: { x: 0.5, y: 0.5, z: 0 } },
    { ...radial, radiusX: 0.001 },
    { ...radial, radiusY: 0 },
    { ...radial, radiusX: 2.01 },
    { ...radial, rotation: 181 },
    { ...radial, rotation: Infinity },
    { ...radial, feather: 0.5 },
    { ...radial, feather: -1 },
    { ...radial, feather: 101 },
    { ...radial, center: { x: 2.1, y: 0.5 } },
    { ...radial, extra: true },
  ])
    expect(() => validateMaskGradient(gradient, 100, 80)).toThrow()
  expect(() =>
    validateMaskGradient(
      { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 0.01, y: 0 } },
      100,
      80,
    ),
  ).not.toThrow()
  expect(() =>
    validateMaskGradient({ ...radial, radiusX: 0.01, radiusY: 0.0125 }, 100, 80),
  ).not.toThrow()
})

test('gradient creation/replacement retains source bounds while brush points stay inside the source', () => {
  const gradient = { kind: 'linear' as const, start: { x: -0.5, y: 0.4 }, end: { x: 1.5, y: 0.6 } },
    mask = gradientMask(gradient)
  expect(() =>
    validateMaskMutation({
      operations: [{ kind: 'create', id: mask.id, name: mask.name, gradient }],
    }),
  ).not.toThrow()
  expect(() =>
    validateMaskMutation({ operations: [{ kind: 'update', id: mask.id, gradient }] }),
  ).not.toThrow()
  expect(() =>
    validateMaskMutation({
      operations: [
        {
          kind: 'stroke',
          id: mask.id,
          stroke: { mode: 'add', radius: 0.1, feather: 0, points: [gradient.start] },
        },
      ],
    }),
  ).toThrow()
  const descriptor = { ...mask }
  Reflect.deleteProperty(descriptor, 'strokes')
  expect(() => validateMaskStack([descriptor])).not.toThrow()
  expect(() =>
    validateMaskStack([{ ...descriptor, base: generatedMask(10, 8, () => 255) }]),
  ).toThrow()
})

test('cubic transition vectors and radial source-pixel rotation preserve aspect and feather extremes', () => {
  const linear = gradientMask({
    kind: 'linear',
    start: { x: 0.25, y: 0.5 },
    end: { x: 0.75, y: 0.5 },
  })
  for (const [x, expected] of [
    [0, 1],
    [0.25, 1],
    [0.375, 0.84375],
    [0.5, 0.5],
    [0.625, 0.15625],
    [0.75, 0],
    [1, 0],
  ])
    expect(referenceCoverage(linear, x, 0.5, 200, 100)).toBe(expected)
  for (const feather of [0, 50, 100]) {
    const radial = gradientMask({
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radiusX: 0.2,
      radiusY: 0.2,
      rotation: 90,
      feather,
    })
    // The 40px x radius rotates vertically; the 20px y radius rotates horizontally.
    expect(referenceCoverage(radial, 0.5, 0.5, 200, 100)).toBe(1)
    expect(referenceCoverage(radial, 0.5, 0.95, 200, 100)).toBe(0)
    expect(referenceCoverage(radial, 0.625, 0.5, 200, 100)).toBe(0)
    expect(referenceCoverage(radial, 0.5, 0.8, 200, 100)).toBeCloseTo(
      feather === 0 ? 1 : feather === 50 ? 0.5 : 0.15625,
      12,
    )
  }
})

test('gradient identity, neutral admission, Color offsets and final prepared coverage stay independent', () => {
  const mask = gradientMask({ kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }),
    image = { width: 100, height: 80 },
    parameters = { localMasks: [mask], maskGeometry: identityMaskGeometry(100, 80) }
  expect(maskHasCoverage(mask)).toBe(true)
  expect(hasLocalMasks(parameters)).toBe(true)
  const initial = structuredClone(localMaskPixelData(parameters)),
    key = maskEdgePixelIdentity(mask),
    packed = packLocalMasks(parameters, image)
  expect(MASK_DESCRIPTOR_VEC4S).toBe(11)
  expect([...packed.subarray(60, 68)]).toEqual([1, 0, 0, 0, 100, 0, 0, 0])
  expect(localMaskAllocationBytes(parameters, image)).toBe(packed.byteLength)
  mask.gradient = { ...mask.gradient!, end: { x: 0.8, y: 0.2 } } as typeof mask.gradient
  expect(localMaskPixelData(parameters)).not.toEqual(initial)
  expect(maskEdgePixelIdentity(mask)).not.toBe(key)
  mask.light = { ...neutralMaskLight }
  expect(hasLocalMasks(parameters)).toBe(false)
  expect(() => packLocalMasks(parameters, image)).not.toThrow()
  mask.gradient = { kind: 'linear', start: { x: 0.5, y: 0.5 }, end: { x: 0.50001, y: 0.5 } }
  expect(() => packLocalMasks(parameters, image)).toThrow(/one source pixel/)
  mask.gradient = { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
  mask.edge = { featherPx: 1, shiftPx: 1 }
  mask.preparedCoverage = { ...generatedMask(100, 80, () => 128), key: 'a'.repeat(64) }
  const final = packLocalMasks(parameters, image, true)
  expect([...final.subarray(60, 68)]).toEqual(new Array(8).fill(0))
  expect(final[25]).toBe(0) // inversion is already included
  expect(final[27]).toBe(1) // final R8 layer replaces the analytic base
})
