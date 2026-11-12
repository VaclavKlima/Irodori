import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  defaultColorMaskRange,
  defaultLuminanceMaskRange,
  maskRangeColorFromHex,
  maskRangeColorSample,
  maskRangeColorToHex,
  maskRangeParameters,
  sampledLuminanceMaskRange,
  sampleMaskRangePixels,
  validateMaskRange,
} from '../src/shared/mask-ranges'
import { prepareMaskMutation } from '../src/main/mask-store'
import { initialSettings, SETTINGS_VERSION } from '../src/shared/edits'
import {
  CATALOG_VERSION,
  migrateEditingHistory,
  supportsEditingSettings,
} from '../src/main/catalog/editing-migration'
import {
  maskCapabilities,
  resolveMasks,
  validateMaskMutation,
  validateMaskStack,
  validateResolvedMasks,
} from '../src/shared/masks'
import { validatePresetDefinition } from '../src/shared/presets'
import { generatedMask } from './helpers/generated-mask'

const color = () => defaultColorMaskRange(maskRangeColorFromHex('#19854A'))
const gradient = { kind: 'linear' as const, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
const stroke = { mode: 'add' as const, radius: 0.1, feather: 0, points: [{ x: 0.5, y: 0.5 }] }

test('range contracts bound sample counts and controls while preserving HDR and unbounded upper values', () => {
  expect(maskCapabilities.version).toBe(6)
  for (const range of [
    color(),
    defaultLuminanceMaskRange,
    { ...defaultLuminanceMaskRange, lower: 200, upper: null },
    { ...defaultLuminanceMaskRange, lower: 1200, upper: 5000 },
    {
      ...color(),
      samples: Array.from({ length: 5 }, () => ({ a: 0, b: 0 })),
      range: 100,
      softness: 0,
    },
  ])
    expect(() => validateMaskRange(range)).not.toThrow()
  for (const range of [
    { ...color(), samples: [] },
    { ...color(), samples: Array(6).fill({ a: 0, b: 0 }) },
    { ...color(), samples: [{ a: Infinity, b: 0 }] },
    { ...color(), samples: [{ a: 0, b: 0, hidden: true }] },
    { ...color(), range: -1 },
    { ...color(), range: 100.1 },
    { ...color(), softness: 0.5 },
    { ...color(), version: 2 },
    { ...color(), liveSamplePoint: { x: 0, y: 0 } },
    { ...defaultLuminanceMaskRange, lower: -1 },
    { ...defaultLuminanceMaskRange, upper: 24 },
    { ...defaultLuminanceMaskRange, upper: NaN },
    { ...defaultLuminanceMaskRange, lower: 1e300, upper: null },
  ])
    expect(() => validateMaskRange(range)).toThrow()
  expect(maskRangeParameters({ ...color(), range: 20, softness: 25 })).toEqual({
    radius: 0.2,
    outer: 0.25,
  })
  expect(
    maskRangeParameters({ version: 1, kind: 'luminance', lower: 100, upper: 200, softness: 25 }),
  ).toEqual({ lower: 1, upper: 2, transition: 0.25 })
  expect(
    maskRangeParameters({ version: 1, kind: 'luminance', lower: 200, upper: null, softness: 25 }),
  ).toEqual({ lower: 2, upper: null, transition: 0.5 })
})

test('relative Oklab samples match independent primary coordinates and stay stable across exposure scale', () => {
  // Published Oklab red [0.62795536, 0.22486306, 0.12584630], normalized by L.
  const red = maskRangeColorSample([1, 0, 0], 'srgb')!
  expect(red.a).toBeCloseTo(0.22486306 / 0.62795536, 6)
  expect(red.b).toBeCloseTo(0.1258463 / 0.62795536, 6)
  const green = maskRangeColorSample([0.1, 0.6, 0.2], 'rec2020')!
  for (const scale of [1e-30, 1e-10, 0.01, 1, 1000, 1e30]) {
    const sample = maskRangeColorSample([0.1 * scale, 0.6 * scale, 0.2 * scale], 'rec2020')!
    expect(sample.a).toBeCloseTo(green.a, 12)
    expect(sample.b).toBeCloseTo(green.b, 12)
  }
  expect(maskRangeColorSample([0, 0, 0], 'srgb')).toBeNull()
  expect(maskRangeColorSample([-1, -1, -1], 'srgb')).toBeNull()
  expect(maskRangeColorSample([-0.01, 0.2, 0.1], 'rec2020')).not.toBeNull()
  expect(() => maskRangeColorSample([NaN, 0, 0], 'srgb')).toThrow('nonfinite')
  const gray = maskRangeColorFromHex('#808080')
  expect(Math.hypot(gray.a, gray.b)).toBeLessThan(1e-7)
  expect(maskRangeColorFromHex('#FF0000')).toEqual(red)
  expect(maskRangeColorToHex(red)).toMatch(/^#[0-9A-F]{6}$/)
  expect(() => maskRangeColorFromHex('#000000')).toThrow('Luminance range')
  expect(() => maskRangeColorFromHex('#FFF')).toThrow('#RRGGBB')
})

test('fixed-neighborhood sampling uses straight linear color and alpha weights without clamping HDR', () => {
  const result = sampleMaskRangePixels(
    new Float32Array([1, 0, 0, 0.25, 3, 0, 0, 0.75, 0, 20, 0, 0]),
    'srgb',
  )
  const red = maskRangeColorFromHex('#FF0000')
  expect(result.color!.a).toBeCloseTo(red.a, 12)
  expect(result.color!.b).toBeCloseTo(red.b, 12)
  // Independent linear-sRGB Y red coefficient 0.21263900587151027; weighted red is 2.5.
  expect(result.luminance).toBeCloseTo(53.15975146787757, 10)
  expect(result.validPixels).toBe(2)
  const hdr = sampleMaskRangePixels(new Float32Array([4, 4, 4, 1]), 'rec2020')
  expect(hdr.luminance).toBeCloseTo(400, 10)
  expect(sampleMaskRangePixels(new Float32Array([0, 0, 0, 1]), 'srgb').color).toBeNull()
  expect(() => sampleMaskRangePixels(new Float32Array([1, 1, 1, 0]), 'srgb')).toThrow('transparent')
  expect(() => sampleMaskRangePixels(new Float32Array(50 * 4), 'srgb')).toThrow('7 × 7')
  expect(() => sampleMaskRangePixels(new Float32Array([1, 1, NaN, 1]), 'srgb')).toThrow('invalid')
  expect(sampledLuminanceMaskRange(400)).toEqual({
    version: 1,
    kind: 'luminance',
    lower: 360,
    upper: 440,
    softness: 25,
  })
  expect(sampledLuminanceMaskRange(0)).toEqual({
    version: 1,
    kind: 'luminance',
    lower: 0,
    upper: 1,
    softness: 25,
  })
})

test('authored ranges and explicit source replacement preserve corrections, nesting, independent copies and neutral root adjustments', () => {
  const id = randomUUID(),
    part = randomUUID(),
    copy = randomUUID()
  const created = prepareMaskMutation([], {
    operations: [
      { kind: 'create', id, name: 'Color', range: color() },
      { kind: 'stroke', id, strokeTarget: 'primary', stroke },
      { kind: 'stroke', id, stroke },
      {
        kind: 'component-add',
        id,
        componentId: part,
        name: 'Bright only',
        operator: 'intersect',
        range: defaultLuminanceMaskRange,
      },
      { kind: 'duplicate', id, newId: copy, name: 'Independent' },
    ],
  })
  const original = created.stack[1],
    duplicate = created.stack[0]
  expect(original.range).toEqual(duplicate.range)
  expect(original.range).not.toBe(duplicate.range)
  expect(original.operands![0].id).not.toBe(duplicate.operands![0].id)
  expect(original.light.exposureEv).toBe(0)
  expect(() =>
    prepareMaskMutation(created.stack, { operations: [{ kind: 'update', id, gradient }] }),
  ).toThrow('mutually exclusive')
  const changed = prepareMaskMutation(created.stack, {
    operations: [{ kind: 'update', id, gradient, replacePrimary: true }],
  })
  expect(changed.stack[1]).toMatchObject({
    gradient,
    head: original.head,
    resultHead: original.resultHead,
    operands: original.operands,
  })
  expect(changed.stack[1]).not.toHaveProperty('range')
  const cleared = prepareMaskMutation(created.stack, {
    operations: [{ kind: 'component-update', id, componentId: part, clearPrimary: true }],
  })
  expect(cleared.stack[1].operands![0]).not.toHaveProperty('range')
  const resolved = resolveMasks(created.stack, created.chunks)
  expect(resolved[1].range).toEqual(original.range)
  resolved[1].preparedRangeBase = { ...generatedMask(4, 3, () => 128), key: 'a'.repeat(64) }
  expect(() => validateResolvedMasks(resolved)).not.toThrow()
  expect(() =>
    validateMaskStack([{ ...original, preparedRangeBase: resolved[1].preparedRangeBase }]),
  ).toThrow()
  expect(() => validateMaskStack([{ ...original, gradient }])).toThrow('mutually exclusive')
  expect(() =>
    validateMaskMutation({ operations: [{ kind: 'update', id, replacePrimary: true }] }),
  ).toThrow('complete')
  expect(() =>
    validateMaskMutation({
      operations: [
        { kind: 'component-update', id, componentId: part, range: color(), clearPrimary: true },
      ],
    }),
  ).toThrow('separately')
})

test('settings-18 history migrates without changing masks, branches or appearance and rejects disguised old range content', () => {
  expect(SETTINGS_VERSION).toBe(19)
  expect(CATALOG_VERSION).toBe(29)
  const id = randomUUID(),
    part = randomUUID()
  const maskStack = prepareMaskMutation([], {
    operations: [
      { kind: 'create', id, name: 'Old gradient', gradient },
      {
        kind: 'component-add',
        id,
        componentId: part,
        name: 'Old part',
        operator: 'subtract',
        gradient,
      },
    ],
  }).stack
  const settings = { ...initialSettings(), version: 18, maskStack }
  expect(supportsEditingSettings(settings, 28)).toBe(true)
  expect(supportsEditingSettings(settings, 29)).toBe(false)
  const disguised = structuredClone(settings)
  Object.assign(disguised.maskStack[0].operands![0], { range: defaultLuminanceMaskRange })
  delete disguised.maskStack[0].operands![0].gradient
  expect(supportsEditingSettings(disguised, 28)).toBe(false)
  const timestamp = '2026-11-12T12:00:00.000Z'
  const history = {
    settings,
    revision: 7,
    cursor: 0,
    snapshots: [
      { settings, createdAt: timestamp },
      { settings: { ...settings, exposureEv: 2 }, createdAt: timestamp },
    ],
  }
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    db.prepare('INSERT INTO edits VALUES (?, ?)').run('a'.repeat(64), JSON.stringify(history))
    migrateEditingHistory(db)
    const migrated = JSON.parse(
      (db.prepare('SELECT data FROM edits').get() as { data: string }).data,
    )
    expect(migrated).toEqual({
      ...history,
      settings: { ...settings, version: 19 },
      snapshots: history.snapshots.map((s) => ({ ...s, settings: { ...s.settings, version: 19 } })),
    })
    expect(supportsEditingSettings(migrated.settings, 29)).toBe(true)
    expect(() =>
      validatePresetDefinition({
        version: 1,
        settingsVersion: 18,
        groups: ['color'],
        values: { saturation: 0, vibrance: 0 },
        compatibility: { lensKinds: [] },
      }),
    ).not.toThrow()
  } finally {
    db.close()
  }
})
