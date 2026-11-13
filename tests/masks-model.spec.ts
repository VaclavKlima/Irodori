import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { initialSettings } from '../src/shared/edits'
import { copiedEdits, transferredSettings } from '../src/shared/edit-transfer'
import { processingMetadata } from '../src/main/processing/metadata'
import { prepareMaskMutation } from '../src/main/mask-store'
import { maskBrushExample, validateMaskStroke } from '../src/shared/mask-brush'
import { hasLocalMasks, localMaskPixelData } from '../src/shared/masks-gpu'
import {
  neutralMaskLight,
  neutralMaskColor,
  neutralMaskEdge,
  hasMaskAdjustments,
  resolveMasks,
  validateMaskColor,
  validateMaskMutation,
  type MaskStroke,
  type ResolvedMask,
} from '../src/shared/masks'

const stroke: MaskStroke = {
  mode: 'add',
  radius: 0.04,
  feather: 0.75,
  points: [
    { x: 0.2, y: 0.4 },
    { x: 0.3, y: 0.6 },
  ],
}

test('brush diagnostics locate exact fields and operation indices without weakening numeric limits', () => {
  const id = randomUUID(),
    valid = { kind: 'stroke', id, stroke }
  const cases: [unknown, string, string][] = [
    [{ ...valid, id: 'not-a-uuid' }, '.id', 'lowercase UUID'],
    [{ ...valid, componentId: null }, '.componentId', 'lowercase UUID'],
    [{ ...valid, strokeTarget: 'paint' }, '.strokeTarget', '"primary" or "result"'],
    [{ ...valid, flow: 1 }, '.flow', 'Unknown field'],
    [{ kind: 'stroke', id }, '.stroke', 'Required'],
    ...['mode', 'feather', 'points', 'radius'].map((key): [unknown, string, string] => [
      {
        ...valid,
        stroke: Object.fromEntries(Object.entries(stroke).filter(([name]) => name !== key)),
      },
      `.stroke.${key}`,
      'Required',
    ]),
    ...[0, -1, 0.50001, 1e-320, NaN, Infinity, '0.1'].map((radius): [unknown, string, string] => [
      { ...valid, stroke: { ...stroke, radius } },
      '.stroke.radius',
      'positive in Float32',
    ]),
    ...[-0.1, 1.01, NaN, Infinity, '0'].map((feather): [unknown, string, string] => [
      { ...valid, stroke: { ...stroke, feather } },
      '.stroke.feather',
      '0 through 1',
    ]),
    [{ ...valid, stroke: { ...stroke, mode: 'paint' } }, '.stroke.mode', 'Paint'],
    [{ ...valid, stroke: { ...stroke, flow: 1 } }, '.stroke.flow', 'Unknown field'],
    [{ ...valid, stroke: { ...stroke, points: [] } }, '.stroke.points', '1–4096'],
    [
      { ...valid, stroke: { ...stroke, points: Array(4097).fill({ x: 0, y: 0 }) } },
      '.stroke.points',
      '1–4096',
    ],
    [
      { ...valid, stroke: { ...stroke, points: [{ x: 0, y: NaN }] } },
      '.stroke.points[0].y',
      'finite normalized',
    ],
    [
      { ...valid, stroke: { ...stroke, points: [{ x: -0.1, y: 0 }] } },
      '.stroke.points[0].x',
      '0 through 1',
    ],
    [
      { ...valid, stroke: { ...stroke, points: [{ x: 1.1, y: 0 }] } },
      '.stroke.points[0].x',
      '0 through 1',
    ],
    [{ ...valid, stroke: { ...stroke, points: [{ x: 0 }] } }, '.stroke.points[0].y', 'Required'],
    [
      { ...valid, stroke: { ...stroke, points: [{ x: 0, y: 0, pressure: 1 }] } },
      '.stroke.points[0].pressure',
      'Unknown field',
    ],
  ]
  for (const [operation, path, reason] of cases) {
    let message = ''
    try {
      validateMaskMutation({ operations: [{ kind: 'create', id, name: 'Uncommitted' }, operation] })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain(`maskMutation.operations[1]${path}:`)
    expect(message).toContain(reason)
    expect(message).toContain('Minimal valid operation:')
    expect(message).toContain('irodori_get_mask_context')
    const example = JSON.parse(message.split('Minimal valid operation: ')[1].split('. Place it')[0])
    validateMaskMutation({ operations: [example] })
  }
  for (const mode of ['add', 'subtract'] as const)
    for (const radius of [2 ** -149, 0.5])
      validateMaskStroke({ ...maskBrushExample(mode, { x: 0, y: 1 }), radius, feather: 1 })
  validateMaskStroke({ ...stroke, points: Array(4096).fill({ x: 0, y: 1 }) })
})

test('brush component creation and envelope errors retain paths and atomic preparation', () => {
  const id = randomUUID(),
    componentId = randomUUID()
  expect(() => validateMaskMutation({ operations: [] })).toThrow('maskMutation.operations:')
  expect(() => validateMaskMutation({ operations: [{}] })).toThrow(
    'maskMutation.operations[0].kind:',
  )
  expect(() => validateMaskMutation({ operations: [null] })).toThrow('maskMutation.operations[0]:')
  expect(() => validateMaskMutation({ operations: [], extra: true })).toThrow('maskMutation.extra:')
  expect(() =>
    validateMaskMutation({
      operations: [
        {
          kind: 'component-add',
          id,
          componentId,
          name: 'Part',
          operator: 'add',
          stroke: { ...stroke, feather: 2 },
        },
      ],
    }),
  ).toThrow('maskMutation.operations[0].stroke.feather:')
  const { stack } = prepareMaskMutation([], { operations: [{ kind: 'create', id, name: 'Saved' }] })
  const before = structuredClone(stack)
  for (const operation of [
    { kind: 'stroke' as const, id: randomUUID(), stroke },
    { kind: 'stroke' as const, id, componentId, stroke },
    {
      kind: 'component-add' as const,
      id,
      componentId,
      parentId: randomUUID(),
      name: 'Part',
      operator: 'add' as const,
      stroke,
    },
  ]) {
    expect(() =>
      prepareMaskMutation(stack, {
        operations: [{ kind: 'update', id, name: 'Must not persist' }, operation],
      }),
    ).toThrow('maskMutation.operations[1].')
    expect(stack).toEqual(before)
  }
})

test('empty and erase-only masks preserve analysis until their coverage can affect pixels', () => {
  const mask: ResolvedMask = {
    id: randomUUID(),
    name: 'New mask',
    enabled: true,
    inverted: false,
    head: null,
    light: { ...neutralMaskLight, exposureEv: 1.83 },
    color: { ...neutralMaskColor },
    edge: { ...neutralMaskEdge },
    strokes: [],
  }
  expect(hasLocalMasks({ localMasks: [mask] })).toBe(false)
  expect(localMaskPixelData({ localMasks: [mask] })).toEqual([])
  mask.strokes = [{ ...stroke, mode: 'subtract' }]
  expect(hasLocalMasks({ localMasks: [mask] })).toBe(false)
  mask.inverted = true
  expect(hasLocalMasks({ localMasks: [mask] })).toBe(true)
  mask.inverted = false
  mask.strokes = [stroke]
  expect(hasLocalMasks({ localMasks: [mask] })).toBe(true)
  mask.enabled = false
  expect(hasLocalMasks({ localMasks: [mask] })).toBe(false)
})

test('local Color validates bounded relative integers independently from Light', () => {
  const id = randomUUID()
  for (const color of [neutralMaskColor, { temperature: -100, tint: 100, saturation: -100 }])
    expect(() => validateMaskColor(color)).not.toThrow()
  for (const color of [{ temperature: 1 }, { tint: -12 }, { saturation: 100 }, {}])
    expect(() =>
      validateMaskMutation({ operations: [{ kind: 'update', id, color }] }),
    ).not.toThrow()
  for (const color of [
    { temperature: 101 },
    { tint: -101 },
    { saturation: 0.5 },
    { tint: NaN },
    { temperature: Infinity },
    { saturation: '10' },
    { kelvin: 5500 },
    { vibrance: 10 },
  ])
    expect(() => validateMaskMutation({ operations: [{ kind: 'update', id, color }] })).toThrow()
  expect(() => validateMaskColor({ temperature: 0, tint: 0 })).toThrow()
  expect(hasMaskAdjustments({ light: neutralMaskLight, color: neutralMaskColor })).toBe(false)
  for (const color of [{ temperature: 1 }, { tint: -1 }, { saturation: 1 }])
    expect(
      hasMaskAdjustments({ light: neutralMaskLight, color: { ...neutralMaskColor, ...color } }),
    ).toBe(true)
})

test('partial Color updates, duplication and reset retain independent Light and immutable geometry', () => {
  const id = randomUUID(),
    copy = randomUUID()
  const first = prepareMaskMutation([], {
    operations: [
      { kind: 'create', id, name: 'Skin' },
      { kind: 'stroke', id, strokeTarget: 'primary', stroke },
      { kind: 'update', id, light: { exposureEv: 0.3 }, color: { temperature: 12, tint: 4 } },
      { kind: 'update', id, color: { saturation: -15 } },
      { kind: 'duplicate', id, newId: copy, name: 'Foliage' },
      { kind: 'update', id: copy, color: { temperature: -8 } },
    ],
  })
  expect(first.stack.map((mask) => mask.color)).toEqual([
    { temperature: -8, tint: 4, saturation: -15 },
    { temperature: 12, tint: 4, saturation: -15 },
  ])
  expect(first.stack[0].head).toBe(first.stack[1].head)
  expect(resolveMasks(first.stack, first.chunks)[0].color).toEqual(first.stack[0].color)
  const reset = prepareMaskMutation(first.stack, {
    operations: [{ kind: 'update', id, color: { ...neutralMaskColor } }],
  })
  expect(reset.chunks).toEqual([])
  expect(reset.stack[0]).toEqual(first.stack[0])
  expect(reset.stack[1]).toEqual({ ...first.stack[1], color: neutralMaskColor })
  expect(first.stack[1].color.temperature).toBe(12)
})

test('compound mask creation, independent Light, copy-on-write duplication and exact top-first order', () => {
  const a = randomUUID(),
    b = randomUUID(),
    c = randomUUID()
  const first = prepareMaskMutation([], {
    operations: [
      { kind: 'create', id: a, name: 'Trunk' },
      { kind: 'stroke', id: a, strokeTarget: 'primary', stroke },
      { kind: 'update', id: a, light: { exposureEv: 0.7, shadows: 20 } },
      { kind: 'duplicate', id: a, newId: b, name: 'Reflection' },
      { kind: 'update', id: b, light: { exposureEv: -1, blacks: -15 }, inverted: true },
      { kind: 'create', id: c, name: 'Untouched' },
    ],
  })
  expect(first.stack.map((mask) => mask.id)).toEqual([c, b, a])
  expect(first.stack[1].head).toBe(first.stack[2].head)
  expect(first.stack[2].light).toEqual({ ...neutralMaskLight, exposureEv: 0.7, shadows: 20 })
  const refined = prepareMaskMutation(first.stack, {
    operations: [
      { kind: 'stroke', id: b, strokeTarget: 'primary', stroke: { ...stroke, mode: 'subtract' } },
      { kind: 'reorder', ids: [a, c, b] },
    ],
  })
  const resolved = resolveMasks(refined.stack, [...first.chunks, ...refined.chunks])
  expect(resolved.map((mask) => [mask.id, mask.strokes.length])).toEqual([
    [a, 1],
    [c, 0],
    [b, 2],
  ])
  expect(first.stack.map((mask) => mask.id)).toEqual([c, b, a])
  expect(() =>
    prepareMaskMutation(first.stack, { operations: [{ kind: 'reorder', ids: [a, b] }] }),
  ).toThrow('every current mask')
})

test('mask commands reject unbounded, nonfinite, out-of-source and unsupported data', () => {
  const id = randomUUID()
  for (const invalid of [
    { ...stroke, points: [{ x: -0.1, y: 0 }] },
    { ...stroke, radius: Infinity },
    { ...stroke, radius: 1e-320 },
    { ...stroke, points: Array.from({ length: 4097 }, () => ({ x: 0.2, y: 0.3 })) },
    { ...stroke, flow: 0.2 },
  ])
    expect(() =>
      validateMaskMutation({ operations: [{ kind: 'stroke', id, stroke: invalid }] }),
    ).toThrow()
  expect(() =>
    validateMaskMutation({ operations: [{ kind: 'update', id, light: { saturation: 50 } }] }),
  ).toThrow()
  expect(() =>
    resolveMasks(
      [
        {
          id,
          name: 'Missing',
          enabled: true,
          inverted: false,
          head: 'a'.repeat(64),
          light: { ...neutralMaskLight },
          color: { ...neutralMaskColor },
          edge: { ...neutralMaskEdge },
        },
      ],
      [],
    ),
  ).toThrow('missing')
})

test('copying and applying global groups preserves destination masks and never transfers source geometry', () => {
  const source = initialSettings(),
    destination = initialSettings()
  source.exposureEv = 1.25
  source.maskStack = prepareMaskMutation([], {
    operations: [{ kind: 'create', id: randomUUID(), name: 'Source mask' }],
  }).stack
  destination.maskStack = prepareMaskMutation([], {
    operations: [{ kind: 'create', id: randomUUID(), name: 'Destination mask' }],
  }).stack
  const copied = copiedEdits(
    {
      id: randomUUID(),
      photoId: 'a'.repeat(64),
      filename: 'Source.png',
      revision: 1,
      copiedAt: new Date().toISOString(),
    },
    source,
    processingMetadata({}, []),
  )
  expect(copied.clipboard.groups).not.toContain('masks')
  const result = transferredSettings(destination, copied, ['light'])
  expect(result.exposureEv).toBe(1.25)
  expect(result.maskStack).toEqual(destination.maskStack)
  expect(result.maskStack).not.toEqual(source.maskStack)
})
