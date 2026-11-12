import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { MaskContentStore, prepareMaskMutation } from '../src/main/mask-store'
import {
  coverageNodes,
  maskChunkBytes,
  resolveMasks,
  validateMaskMutation,
  validateMaskStack,
  validateResolvedMasks,
  type MaskStroke,
} from '../src/shared/masks'

const stroke: MaskStroke = { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.3, y: 0.4 }] }
const gradient = { kind: 'linear' as const, start: { x: 0.2, y: 0.1 }, end: { x: 0.8, y: 0.9 } }

function fixture() {
  const id = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    nested = randomUUID()
  const result = prepareMaskMutation([], {
    operations: [
      { kind: 'create', id, name: 'Water', gradient },
      { kind: 'component-add', id, componentId: a, name: 'Bird', operator: 'subtract', stroke },
      {
        kind: 'component-add',
        id,
        componentId: b,
        name: 'Reflection',
        operator: 'intersect',
        gradient,
      },
      {
        kind: 'component-add',
        id,
        parentId: a,
        componentId: nested,
        name: 'Feathers',
        operator: 'add',
        gradient,
      },
      { kind: 'stroke', id, componentId: a, stroke: { ...stroke, mode: 'subtract' } },
      { kind: 'stroke', id, stroke },
    ],
  })
  return { id, a, b, nested, ...result }
}

test('compound trees retain fixed starting coverage, ordered parent-local operands and separate corrections', () => {
  const f = fixture(),
    root = f.stack[0]
  expect(root.gradient).toEqual(gradient)
  expect(root.head).toBeNull()
  expect(root.resultHead).not.toBeNull()
  expect(root.operands!.map((part) => part.operator)).toEqual(['subtract', 'intersect'])
  const resolved = resolveMasks(f.stack, f.chunks)
  validateResolvedMasks(resolved)
  expect(resolved[0].strokes).toHaveLength(0)
  expect(resolved[0].resultStrokes).toHaveLength(1)
  expect(resolved[0].operands![0].strokes).toEqual([stroke])
  expect(resolved[0].operands![0].resultStrokes![0].mode).toBe('subtract')
  const reordered = prepareMaskMutation(f.stack, {
    operations: [{ kind: 'component-reorder', id: f.id, ids: [f.b, f.a] }],
  })
  expect(reordered.stack[0].gradient).toEqual(gradient)
  expect(reordered.stack[0].operands!.map((part) => part.id)).toEqual([f.b, f.a])
  expect(() =>
    prepareMaskMutation(f.stack, {
      operations: [{ kind: 'component-reorder', id: f.id, ids: [f.a, f.nested] }],
    }),
  ).toThrow('within its parent')
  expect(() =>
    prepareMaskMutation(f.stack, {
      operations: [{ kind: 'component-remove', id: f.id, componentId: f.id }],
    }),
  ).toThrow('Starting coverage')
})

test('copying combined coverage preserves grouping and immutable content with fresh IDs, independent geometry and no adjustments', () => {
  const f = fixture(),
    destination = randomUUID(),
    copy = randomUUID()
  const copied = prepareMaskMutation(f.stack, {
    operations: [
      { kind: 'update', id: f.id, light: { exposureEv: 2 }, color: { saturation: 20 } },
      { kind: 'create', id: destination, name: 'Destination' },
      {
        kind: 'component-copy',
        id: destination,
        componentId: copy,
        name: 'Bird copy',
        operator: 'subtract',
        sourceMaskId: f.id,
      },
    ],
  })
  const group = copied.stack[0].operands![0],
    original = copied.stack[1]
  expect(group.resultHead).toBe(original.resultHead)
  expect(group.operands![0].head).toBe(original.operands![0].head)
  expect(group.operands![0].resultHead).toBe(original.operands![0].resultHead)
  expect(group).not.toHaveProperty('light')
  expect(group).not.toHaveProperty('color')
  expect(
    coverageNodes(group)
      .map((node) => node.id)
      .some((id) => coverageNodes(original).some((node) => node.id === id)),
  ).toBe(false)
  const changed = prepareMaskMutation(copied.stack, {
    operations: [
      { kind: 'component-update', id: f.id, componentId: f.nested, clearPrimary: true },
      {
        kind: 'component-update',
        id: destination,
        componentId: copy,
        inverted: true,
        edge: { featherPx: 2 },
        operator: 'intersect',
      },
    ],
  })
  expect(changed.stack[0].operands![0].operands![0].operands![0].gradient).toEqual(gradient)
  expect(changed.stack[1].operands![0].operands![0].gradient).toBeUndefined()
  expect(changed.stack[0].light.exposureEv).toBe(0)
  expect(changed.stack[0].operands![0]).toMatchObject({
    inverted: true,
    edge: { featherPx: 2, shiftPx: 0 },
    operator: 'intersect',
  })
})

test('copying a disabled source activates the new operand while retaining internal disabled parts and duplicate state', () => {
  const f = fixture(),
    destination = randomUUID(),
    copy = randomUUID(),
    duplicate = randomUUID()
  const source = prepareMaskMutation(f.stack, {
    operations: [
      { kind: 'update', id: f.id, enabled: false, light: { exposureEv: 2 } },
      { kind: 'component-update', id: f.id, componentId: f.a, enabled: false },
    ],
  })
  const copied = prepareMaskMutation(source.stack, {
    operations: [
      { kind: 'create', id: destination, name: 'Enabled destination', gradient },
      {
        kind: 'component-copy',
        id: destination,
        componentId: copy,
        name: 'Active protection',
        operator: 'subtract',
        sourceMaskId: f.id,
      },
      {
        kind: 'component-duplicate',
        id: f.id,
        componentId: f.a,
        newId: duplicate,
        name: 'Disabled duplicate',
      },
    ],
  })
  const group = copied.stack[0].operands![0]
  expect(group.enabled).toBe(true)
  expect(group.operands!.map((part) => part.enabled)).toEqual([false, true])
  expect(group.gradient).toEqual(source.stack[0].gradient)
  expect(group.resultHead).toBe(source.stack[0].resultHead)
  expect(group).not.toHaveProperty('light')
  expect(copied.stack[1].enabled).toBe(false)
  expect(copied.stack[1].operands!.find((part) => part.id === duplicate)!.enabled).toBe(false)
  expect(resolveMasks(copied.stack, f.chunks)[0].operands![0].enabled).toBe(true)
  expect(source.stack[0].enabled).toBe(false)
})

test('component duplication/removal preserves grouping and original content without live dependencies', () => {
  const f = fixture(),
    copy = randomUUID()
  const changed = prepareMaskMutation(f.stack, {
    operations: [
      {
        kind: 'component-duplicate',
        id: f.id,
        componentId: f.a,
        newId: copy,
        name: 'Bird duplicate',
      },
      { kind: 'component-remove', id: f.id, componentId: f.a },
      {
        kind: 'component-update',
        id: f.id,
        componentId: copy,
        enabled: false,
        name: 'Disabled bird',
      },
    ],
  })
  expect(changed.stack[0].operands!.map((node) => node.id)).toEqual([copy, f.b])
  expect(changed.stack[0].operands![0].operands![0].id).not.toBe(f.nested)
  expect(changed.stack[0].operands![0].head).toBe(f.stack[0].operands![0].head)
  expect(resolveMasks(changed.stack, f.chunks)[0].operands![0].strokes).toEqual([stroke])
})

test('immutable store traverses every disabled/nested primary and result chain and reopens without new content', () => {
  const f = fixture(),
    db = new DatabaseSync(':memory:')
  try {
    const store = new MaskContentStore(db)
    store.initialize()
    const disabled = prepareMaskMutation(f.stack, {
      operations: [{ kind: 'component-update', id: f.id, componentId: f.a, enabled: false }],
    })
    store.publish('photo', disabled.stack, f.chunks)
    const chunks = store.content('photo', disabled.stack)
    expect(chunks.map((chunk) => chunk.hash).sort()).toEqual(
      [...new Set(f.chunks.map((chunk) => chunk.hash))].sort(),
    )
    const reopened = new MaskContentStore(db)
    expect(resolveMasks(disabled.stack, reopened.content('photo', disabled.stack))).toEqual(
      resolveMasks(disabled.stack, f.chunks),
    )
    store.publish('photo', disabled.stack)
  } finally {
    db.close()
  }
})

test('resource admission counts disabled operands, total nodes and depth and rejects invalid component targets/operators', () => {
  const id = randomUUID(),
    empty = prepareMaskMutation([], { operations: [{ kind: 'create', id, name: 'Root' }] }).stack
  const max = prepareMaskMutation(empty, {
    operations: Array.from({ length: 31 }, () => ({
      kind: 'component-add' as const,
      id,
      componentId: randomUUID(),
      name: 'Part',
      operator: 'add' as const,
    })),
  })
  expect(coverageNodes(max.stack[0])).toHaveLength(32)
  expect(() =>
    prepareMaskMutation(max.stack, {
      operations: [
        { kind: 'component-add', id, componentId: randomUUID(), name: 'Excess', operator: 'add' },
      ],
    }),
  ).toThrow('node or depth')
  const deep = structuredClone(empty)
  let parent = deep[0] as import('../src/shared/masks').MaskCoverageNode
  for (let index = 0; index < 8; index++) {
    const child = {
      id: randomUUID(),
      name: 'Disabled',
      enabled: false,
      inverted: false,
      head: null,
      edge: { featherPx: 0, shiftPx: 0 },
      operator: 'add' as const,
      operands: [],
    }
    parent.operands = [child]
    parent = child
  }
  expect(() => validateMaskStack(deep)).toThrow('node or depth')
  const many = Array.from({ length: 9 }, () => {
    const root = structuredClone(max.stack[0])
    for (const node of coverageNodes(root)) node.id = randomUUID()
    return root
  })
  expect(() => validateMaskStack(many)).toThrow('node or depth')
  for (const invalid of [
    { kind: 'component-add', id, componentId: randomUUID(), name: 'Bad', operator: 'multiply' },
    { kind: 'component-update', id, componentId: 'bad', enabled: true },
    { kind: 'stroke', id, stroke, strokeTarget: 'unknown' },
    { kind: 'component-reorder', id, ids: [id, id] },
  ])
    expect(() => validateMaskMutation({ operations: [invalid] })).toThrow()
})

test('legacy brush chains resolve as primary coverage without relocation or changed immutable hashes', () => {
  const id = randomUUID(),
    hash = createHash('sha256').update(maskChunkBytes(null, stroke)).digest('hex')
  const stack = prepareMaskMutation([], {
    operations: [{ kind: 'create', id, name: 'Legacy' }],
  }).stack
  stack[0].head = hash
  delete stack[0].operands
  delete stack[0].resultHead
  const resolved = resolveMasks(stack, [{ hash, parent: null, stroke }])
  expect(resolved[0].head).toBe(hash)
  expect(resolved[0].strokes).toEqual([stroke])
  expect(resolved[0].resultStrokes).toEqual([])
  expect(resolved[0].operands).toEqual([])
})

test('settings 17 migration preserves brush/object/gradient histories, revision/cursor/timestamps and immutable bytes', async () => {
  const { initialSettings, SETTINGS_VERSION } = await import('../src/shared/edits')
  const { migrateEditingHistory, supportsEditingSettings } =
    await import('../src/main/catalog/editing-migration')
  const { generatedMask } = await import('./helpers/generated-mask')
  const { validatePresetDefinition } = await import('../src/shared/presets')
  const db = new DatabaseSync(':memory:'),
    store = new MaskContentStore(db)
  try {
    store.initialize()
    db.exec('CREATE TABLE edits(id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    const id = randomUUID(),
      objectId = randomUUID(),
      gradientId = randomUUID()
    const created = prepareMaskMutation([], {
      operations: [
        { kind: 'create', id, name: 'Brush' },
        { kind: 'stroke', id, strokeTarget: 'primary', stroke },
        { kind: 'create', id: objectId, name: 'Object' },
        {
          kind: 'stroke',
          id: objectId,
          strokeTarget: 'primary',
          stroke: { ...stroke, mode: 'subtract' },
        },
        { kind: 'create', id: gradientId, name: 'Gradient', gradient },
        { kind: 'update', id: gradientId, inverted: true, edge: { featherPx: 4, shiftPx: -2 } },
      ],
    })
    const base = generatedMask(3, 2, (x) => (x ? 255 : 0))
    created.stack[1].base = { version: 1, hash: base.hash, width: base.width, height: base.height }
    store.publish('photo', created.stack, created.chunks, [base])
    const immutableBefore = db.prepare('SELECT * FROM mask_content ORDER BY hash').all()
    const basesBefore = db.prepare('SELECT * FROM mask_base_content ORDER BY hash').all()
    const settings = { ...initialSettings(), version: 17, maskStack: created.stack }
    for (const node of settings.maskStack) {
      delete node.operands
      delete node.resultHead
    }
    expect(supportsEditingSettings(settings, 27)).toBe(true)
    const history = {
      photoId: 'photo',
      revision: 29,
      cursor: 1,
      canUndo: true,
      canRedo: true,
      settings,
      snapshots: [
        { createdAt: '2026-11-01T10:01:00Z', settings: { ...settings, maskStack: [] } },
        { createdAt: '2026-11-01T10:02:00Z', settings },
        { createdAt: '2026-11-01T10:03:00Z', settings: { ...settings, contrast: 17 } },
      ],
    }
    const before = resolveMasks(created.stack, created.chunks, [base])
    db.prepare('INSERT INTO edits VALUES (?,?)').run('photo', JSON.stringify(history))
    migrateEditingHistory(db)
    const actual = JSON.parse((db.prepare('SELECT data FROM edits').get() as { data: string }).data)
    expect(actual).toEqual({
      ...history,
      settings: {
        ...settings,
        version: SETTINGS_VERSION,
        maskStack: settings.maskStack.map((mask) => ({ ...mask, operands: [], resultHead: null })),
      },
      snapshots: history.snapshots.map((snapshot) => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          version: SETTINGS_VERSION,
          maskStack: snapshot.settings.maskStack.map((mask) => ({
            ...mask,
            operands: [],
            resultHead: null,
          })),
        },
      })),
    })
    expect(
      resolveMasks(
        actual.settings.maskStack,
        store.content('photo', actual.settings.maskStack),
        store.bases('photo', actual.settings.maskStack),
      ),
    ).toEqual(before)
    expect(db.prepare('SELECT * FROM mask_content ORDER BY hash').all()).toEqual(immutableBefore)
    expect(db.prepare('SELECT * FROM mask_base_content ORDER BY hash').all()).toEqual(basesBefore)
    const migrated = (db.prepare('SELECT data FROM edits').get() as { data: string }).data
    migrateEditingHistory(db)
    expect((db.prepare('SELECT data FROM edits').get() as { data: string }).data).toBe(migrated)
    expect(() =>
      validatePresetDefinition({
        version: 1,
        settingsVersion: 17,
        groups: ['light'],
        values: { exposureEv: 0.5, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
        compatibility: { lensKinds: [] },
      }),
    ).not.toThrow()
  } finally {
    db.close()
  }
})
