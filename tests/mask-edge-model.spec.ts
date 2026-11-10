import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  maskHasEdges,
  neutralMaskEdge,
  neutralMaskColor,
  resolveMasks,
  validateMaskEdge,
  validateMaskBaseContent,
  validateMaskMutation,
  validateMaskStack,
  validatePreparedMaskCoverage,
  validateResolvedMasks,
} from '../src/shared/masks'
import { prepareMaskMutation } from '../src/main/mask-store'
import { initialSettings, SETTINGS_VERSION } from '../src/shared/edits'
import {
  migrateEditingHistory,
  supportsEditingSettings,
} from '../src/main/catalog/editing-migration'
import { catalogTransaction } from '../src/main/catalog/transaction'
import { generatedMask } from './helpers/generated-mask'

test('whole-mask edge controls validate exact bounded canonical-pixel values and partial updates', () => {
  for (const value of [
    neutralMaskEdge,
    { featherPx: 0.5, shiftPx: -16 },
    { featherPx: 64, shiftPx: 16 },
  ])
    expect(() => validateMaskEdge(value)).not.toThrow()
  for (const edge of [{ featherPx: 1.5 }, { shiftPx: -3 }, {}])
    expect(() =>
      validateMaskMutation({ operations: [{ kind: 'update', id: randomUUID(), edge }] }),
    ).not.toThrow()
  for (const edge of [
    { featherPx: -0.5, shiftPx: 0 },
    { featherPx: 64.5, shiftPx: 0 },
    { featherPx: 0.25, shiftPx: 0 },
    { featherPx: NaN, shiftPx: 0 },
    { featherPx: Infinity, shiftPx: 0 },
    { featherPx: 0, shiftPx: -17 },
    { featherPx: 0, shiftPx: 17 },
    { featherPx: 0, shiftPx: 0.5 },
    { featherPx: 0, shiftPx: '1' },
    { featherPx: 0 },
    { featherPx: 0, shiftPx: 0, recovery: true },
  ])
    expect(() => validateMaskEdge(edge)).toThrow()
  expect(maskHasEdges({ edge: neutralMaskEdge })).toBe(false)
  expect(maskHasEdges({ edge: { featherPx: 0.5, shiftPx: 0 } })).toBe(true)
  expect(maskHasEdges({ edge: { featherPx: 0, shiftPx: -1 } })).toBe(true)
})

test('edge updates and duplication retain immutable Paint/Erase history and independent controls', () => {
  const id = randomUUID(),
    copy = randomUUID()
  const first = prepareMaskMutation([], {
    operations: [
      { kind: 'create', id, name: 'Subject' },
      {
        kind: 'stroke',
        id,
        stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.3, y: 0.4 }] },
      },
      {
        kind: 'stroke',
        id,
        stroke: { mode: 'subtract', radius: 0.02, feather: 1, points: [{ x: 0.6, y: 0.4 }] },
      },
      { kind: 'update', id, light: { exposureEv: 0.7 }, inverted: true },
    ],
  })
  const before = structuredClone(first)
  expect(first.stack[0].edge).toEqual(neutralMaskEdge)
  const updated = prepareMaskMutation(first.stack, {
    operations: [
      { kind: 'update', id, edge: { featherPx: 12.5 } },
      { kind: 'update', id, edge: { shiftPx: -3 } },
      { kind: 'duplicate', id, newId: copy, name: 'Copy' },
      { kind: 'update', id: copy, edge: { shiftPx: 4 } },
    ],
  })
  expect(first).toEqual(before)
  expect(updated.chunks).toEqual([])
  expect(updated.stack.map((mask) => mask.edge)).toEqual([
    { featherPx: 12.5, shiftPx: 4 },
    { featherPx: 12.5, shiftPx: -3 },
  ])
  for (const mask of updated.stack) {
    expect(mask.head).toBe(first.stack[0].head)
    expect(mask.light).toEqual(first.stack[0].light)
    expect(mask.inverted).toBe(true)
  }
  expect(
    resolveMasks(updated.stack, first.chunks).map((mask) => [mask.edge, mask.strokes]),
  ).toEqual([
    [{ featherPx: 12.5, shiftPx: 4 }, first.chunks.map((chunk) => chunk.stroke)],
    [{ featherPx: 12.5, shiftPx: -3 }, first.chunks.map((chunk) => chunk.stroke)],
  ])
  const reset = prepareMaskMutation(updated.stack, {
    operations: [{ kind: 'update', id, edge: { ...neutralMaskEdge } }],
  })
  expect(reset.stack[1]).toEqual(first.stack[0])
})

test('prepared final coverage is accepted only on resolved transport and never on durable descriptors', () => {
  const stack = prepareMaskMutation([], {
    operations: [{ kind: 'create', id: randomUUID(), name: 'Subject' }],
  }).stack
  const mask = resolveMasks(stack, [])[0]
  const preparedCoverage = { ...generatedMask(4, 3, () => 128), key: 'a'.repeat(64) }
  expect(() => validatePreparedMaskCoverage(preparedCoverage)).not.toThrow()
  expect(() => validateMaskBaseContent({ ...generatedMask(4, 3, () => 128), version: 2 })).toThrow()
  expect(() => validateResolvedMasks([{ ...mask, preparedCoverage }])).not.toThrow()
  expect(() => validateMaskStack([{ ...stack[0], preparedCoverage }])).toThrow('descriptor')
  expect(() => validatePreparedMaskCoverage({ ...preparedCoverage, key: '../coverage' })).toThrow()
  expect(() =>
    validateResolvedMasks([{ ...mask, preparedCoverage: { ...preparedCoverage, version: 2 } }]),
  ).toThrow()
  expect(() =>
    validateMaskMutation({ operations: [{ kind: 'update', id: mask.id, preparedCoverage }] }),
  ).toThrow()
})

test('settings 14 history gains neutral edges without changing revisions, cursor, branches or timestamps', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    const id = randomUUID(),
      stack = prepareMaskMutation([], {
        operations: [{ kind: 'create', id, name: 'Original' }],
      }).stack
    const expected = {
      revision: 11,
      cursor: 1,
      settings: { ...initialSettings(), maskStack: stack },
      snapshots: [0, 1, 2].map((value) => ({
        createdAt: `2026-11-0${value + 1}T12:00:00Z`,
        settings: { ...initialSettings(), exposureEv: value, maskStack: stack },
      })),
    }
    const legacy = JSON.parse(JSON.stringify(expected))
    for (const value of [
      legacy.settings,
      ...legacy.snapshots.map((snapshot: { settings: unknown }) => snapshot.settings),
    ]) {
      value.version = 14
      for (const mask of value.maskStack) {
        delete mask.edge
        delete mask.color
      }
    }
    expect(supportsEditingSettings(legacy.settings, 24)).toBe(true)
    expect(supportsEditingSettings(legacy.settings, 25)).toBe(false)
    db.prepare('INSERT INTO edits VALUES (?, ?)').run('photo', JSON.stringify(legacy))
    catalogTransaction(db, () => migrateEditingHistory(db))
    const actual = JSON.parse((db.prepare('SELECT data FROM edits').get() as { data: string }).data)
    expect(actual).toEqual(expected)
    expect(actual.settings.version).toBe(SETTINGS_VERSION)
    expect(supportsEditingSettings(actual.settings, 27)).toBe(true)
    expect(supportsEditingSettings(actual.settings, 24)).toBe(false)
  } finally {
    db.close()
  }
})

test('future edge fields disguised as older settings refuse the entire migration transaction', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    const good = { ...initialSettings(), version: 14 }
    const bad = {
      ...good,
      maskStack: prepareMaskMutation([], {
        operations: [{ kind: 'create', id: randomUUID(), name: 'Future field' }],
      }).stack,
    }
    for (const version of [13, 14]) expect(supportsEditingSettings({ ...bad, version })).toBe(false)
    db.prepare('INSERT INTO edits VALUES (?, ?)').run(
      'first',
      JSON.stringify({ settings: good, snapshots: [{ settings: good }] }),
    )
    db.prepare('INSERT INTO edits VALUES (?, ?)').run(
      'second',
      JSON.stringify({ settings: bad, snapshots: [{ settings: bad }] }),
    )
    const before = db.prepare('SELECT * FROM edits ORDER BY id').all()
    expect(() => catalogTransaction(db, () => migrateEditingHistory(db))).toThrow('unsupported')
    expect(db.prepare('SELECT * FROM edits ORDER BY id').all()).toEqual(before)
  } finally {
    db.close()
  }
})

test('settings 15 adds neutral Color to all history while preserving authored edges and generated references', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    const id = randomUUID()
    const stack = prepareMaskMutation([], {
      operations: [
        { kind: 'create', id, name: 'Skin' },
        { kind: 'update', id, edge: { featherPx: 12.5, shiftPx: -3 }, light: { exposureEv: 0.5 } },
      ],
    }).stack
    stack[0].base = { version: 1, hash: 'a'.repeat(64), width: 16, height: 12 }
    const expected = {
      revision: 9,
      cursor: 1,
      settings: { ...initialSettings(), maskStack: stack },
      snapshots: [0, 1, 2].map((value) => ({
        createdAt: `2026-11-0${value + 1}T12:00:00Z`,
        settings: { ...initialSettings(), exposureEv: value, maskStack: stack },
      })),
    }
    const legacy = JSON.parse(JSON.stringify(expected))
    for (const settings of [
      legacy.settings,
      ...legacy.snapshots.map((snapshot: { settings: unknown }) => snapshot.settings),
    ]) {
      settings.version = 15
      for (const mask of settings.maskStack) delete mask.color
    }
    expect(supportsEditingSettings(legacy.settings, 25)).toBe(true)
    expect(supportsEditingSettings(legacy.settings, 26)).toBe(false)
    db.prepare('INSERT INTO edits VALUES (?, ?)').run('photo', JSON.stringify(legacy))
    catalogTransaction(db, () => migrateEditingHistory(db))
    const actual = JSON.parse((db.prepare('SELECT data FROM edits').get() as { data: string }).data)
    expect(actual).toEqual(expected)
    expect(actual.settings.maskStack[0].color).toEqual(neutralMaskColor)
    expect(supportsEditingSettings(actual.settings, 27)).toBe(true)
    const before = db.prepare('SELECT data FROM edits').get()
    catalogTransaction(db, () => migrateEditingHistory(db))
    expect(db.prepare('SELECT data FROM edits').get()).toEqual(before)
  } finally {
    db.close()
  }
})

test('Color fields disguised as older settings are rejected before any migration publication', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    const stack = prepareMaskMutation([], {
      operations: [{ kind: 'create', id: randomUUID(), name: 'Future Color' }],
    }).stack
    for (const version of [13, 14, 15]) {
      const masks = structuredClone(stack)
      if (version < 15) for (const mask of masks) Reflect.deleteProperty(mask, 'edge')
      expect(supportsEditingSettings({ ...initialSettings(), version, maskStack: masks })).toBe(
        false,
      )
    }
    const good = { ...initialSettings(), version: 15 }
    const bad = { ...good, maskStack: stack }
    for (const [id, settings] of [
      ['first', good],
      ['second', bad],
    ] as const)
      db.prepare('INSERT INTO edits VALUES (?, ?)').run(
        id,
        JSON.stringify({ settings, snapshots: [{ settings }] }),
      )
    const before = db.prepare('SELECT * FROM edits ORDER BY id').all()
    expect(() => catalogTransaction(db, () => migrateEditingHistory(db))).toThrow('unsupported')
    expect(db.prepare('SELECT * FROM edits ORDER BY id').all()).toEqual(before)
  } finally {
    db.close()
  }
})
