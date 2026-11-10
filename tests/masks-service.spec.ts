import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import { processingMetadata } from '../src/main/processing/metadata'
import { MaskContentStore, prepareMaskMutation } from '../src/main/mask-store'
import { catalogTransaction } from '../src/main/catalog/transaction'
import { initialSettings, type EditHistory } from '../src/shared/edits'
import { transferFixture } from './edit-transfer.helpers'
import { neutralMaskColor, type MaskGradient } from '../src/shared/masks'
import { migrateEditingHistory } from '../src/main/catalog/editing-migration'

const processor = {
  process: async () => {
    throw new Error('Mask metadata checks must reuse source preparation.')
  },
  close: async () => {},
}

test('shared mask service persists compact references, one-step compound history, conflict rejection and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-masks-')),
    photoId = 'a'.repeat(64),
    id = randomUUID(),
    duplicate = randomUUID()
  let library = new PhotoLibrary(root, processor, () => {})
  try {
    await library.open()
    library.fullPreviews.validateMaskEdit = async () => {}
    await library.catalogCommands.command({
      operation: 'original.publish',
      payload: {
        photo: {
          id: photoId,
          filename: 'Mask.png',
          format: 'PNG',
          width: 100,
          height: 80,
          bytes: 1,
          importedAt: '2026-11-07T00:00:00Z',
          previewSource: 'image',
          thumbnailUrl: '',
          previewUrl: '',
        },
        processingIdentity: 'display-referred-v1',
        createdAt: '2026-11-07T00:00:00Z',
        metadata: processingMetadata({}, []),
      },
    })
    const first = await library.mutateMasks(photoId, 0, {
      operations: [
        { kind: 'create', id, name: 'Trunk' },
        {
          kind: 'stroke',
          id,
          stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.2, y: 0.3 }] },
        },
        { kind: 'update', id, light: { shadows: 15 } },
        { kind: 'update', id, color: { temperature: 12, tint: -4, saturation: -15 } },
      ],
    })
    expect(first.revision).toBe(1)
    expect(first.maskContent).toHaveLength(1)
    expect((await library.getEditHistory(photoId)).snapshots).toHaveLength(2)
    const fault = new DatabaseSync(join(root, 'catalog.sqlite'))
    try {
      fault.exec(
        "CREATE TRIGGER fail_mask_history BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'Test mask history failure'); END",
      )
      await expect(
        library.mutateMasks(photoId, 1, {
          operations: [
            {
              kind: 'stroke',
              id,
              stroke: {
                mode: 'subtract',
                radius: 0.05,
                feather: 0.8,
                points: [{ x: 0.4, y: 0.5 }],
              },
            },
          ],
        }),
      ).rejects.toThrow('Test mask history failure')
      expect(fault.prepare('SELECT COUNT(*) AS count FROM mask_content').get()).toMatchObject({
        count: 1,
      })
      expect((await library.getEdits(photoId)).revision).toBe(1)
    } finally {
      fault.exec('DROP TRIGGER IF EXISTS fail_mask_history')
      fault.close()
    }
    const changed = await library.mutateMasks(photoId, 1, {
      operations: [
        { kind: 'duplicate', id, newId: duplicate, name: 'Reflection' },
        { kind: 'update', id: duplicate, light: { exposureEv: -0.5 } },
        { kind: 'update', id: duplicate, color: { temperature: -20 } },
        { kind: 'reorder', ids: [id, duplicate] },
      ],
    })
    expect(changed.revision).toBe(2)
    expect(changed.maskContent).toHaveLength(1)
    expect(changed.settings.maskStack.map((mask) => mask.color)).toEqual([
      { temperature: 12, tint: -4, saturation: -15 },
      { temperature: -20, tint: -4, saturation: -15 },
    ])
    await expect(
      library.mutateMasks(photoId, 1, { operations: [{ kind: 'delete', id }] }),
    ).rejects.toThrow('conflict')
    const undone = await library.undoEdit(photoId, 2)
    expect(undone.settings.maskStack).toEqual(first.settings.maskStack)
    await library.close()
    library = new PhotoLibrary(root, processor, () => {})
    await library.open()
    library.fullPreviews.validateMaskEdit = async () => {}
    const restored = await library.getEdits(photoId)
    expect(restored.revision).toBe(3)
    expect(restored.maskContent).toEqual(first.maskContent)
    const redone = await library.redoEdit(photoId, 3)
    expect(redone.settings.maskStack).toEqual(changed.settings.maskStack)
    expect(redone.maskContent).toHaveLength(1)
    const history = await library.getEditHistory(photoId)
    expect(JSON.stringify(history)).not.toContain('"points"')
  } finally {
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('immutable mask publication rolls back invalid content and retains data after branch pruning', () => {
  const db = new DatabaseSync(':memory:'),
    store = new MaskContentStore(db),
    photoId = 'a'.repeat(64),
    id = randomUUID()
  try {
    store.initialize()
    const first = prepareMaskMutation([], {
      operations: [
        { kind: 'create', id, name: 'Brush' },
        {
          kind: 'stroke',
          id,
          stroke: { mode: 'add', radius: 0.1, feather: 1, points: [{ x: 0.5, y: 0.5 }] },
        },
      ],
    })
    catalogTransaction(db, () => store.publish(photoId, first.stack, first.chunks))
    const bad = { ...first.chunks[0], hash: 'b'.repeat(64) }
    expect(() => catalogTransaction(db, () => store.publish(photoId, first.stack, [bad]))).toThrow(
      'hash',
    )
    expect(store.content(photoId, first.stack)).toEqual(first.chunks)
    expect(() => store.content('b'.repeat(64), first.stack)).toThrow('missing')
    catalogTransaction(db, () => store.publish(photoId, []))
    expect(store.content(photoId, first.stack)).toEqual(first.chunks)
    expect(db.prepare('SELECT COUNT(*) AS count FROM mask_content').get()).toMatchObject({
      count: 1,
    })
  } finally {
    db.close()
  }
})

test('v12 migration preserves authored curves, redo snapshots, revision and timestamps while adding empty masks', () => {
  const db = new DatabaseSync(':memory:'),
    settings = initialSettings()
  settings.curves = {
    ...settings.curves,
    red: [
      { input: 0, output: 0 },
      { input: 1, output: 0.8 },
    ],
  }
  const history: EditHistory = {
    photoId: 'a'.repeat(64),
    revision: 8,
    settings,
    canUndo: false,
    canRedo: true,
    cursor: 0,
    snapshots: [
      { settings, createdAt: '2026-11-01T00:00:00Z' },
      { settings: { ...settings, exposureEv: 1 }, createdAt: '2026-11-02T00:00:00Z' },
    ],
  }
  const legacy = JSON.parse(JSON.stringify(history))
  for (const item of [
    legacy.settings,
    ...legacy.snapshots.map((snapshot: { settings: unknown }) => snapshot.settings),
  ]) {
    item.version = 12
    delete item.maskStack
  }
  try {
    db.exec('CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    db.prepare('INSERT INTO edits VALUES (?, ?)').run(history.photoId, JSON.stringify(legacy))
    catalogTransaction(db, () => migrateEditingHistory(db))
    const migrated = JSON.parse(
      (db.prepare('SELECT data FROM edits').get() as { data: string }).data,
    )
    expect(migrated).toEqual(history)
  } finally {
    db.close()
  }
})

test('atomic neutral gradients request geometry admission, duplicate corrections and preserve geometry through restart and Undo/Redo', async () => {
  const f = await transferFixture(1),
    photoId = f.ids[0],
    id = randomUUID(),
    duplicate = randomUUID()
  const admitted: unknown[] = []
  f.library.fullPreviews.validateMaskEdit = async (_id, _revision, masks) => {
    admitted.push(structuredClone(masks))
  }
  try {
    const gradient: MaskGradient = {
      kind: 'linear',
      start: { x: -0.25, y: 0.1 },
      end: { x: 1.25, y: 0.9 },
    }
    const created = await f.library.mutateMasks(photoId, 0, {
      operations: [{ kind: 'create', id, name: 'Sky gradient', gradient }],
    })
    expect(created.settings.maskStack[0]).toMatchObject({ gradient, color: neutralMaskColor })
    expect(admitted).toHaveLength(1)
    expect((await f.library.getEditHistory(photoId)).snapshots).toHaveLength(2)
    const corrected = await f.library.mutateMasks(photoId, 1, {
      operations: [
        {
          kind: 'stroke',
          id,
          stroke: { mode: 'subtract', radius: 0.1, feather: 0.5, points: [{ x: 0.4, y: 0.5 }] },
        },
      ],
    })
    const next: MaskGradient = {
      kind: 'radial',
      center: { x: 0.6, y: 0.4 },
      radiusX: 0.4,
      radiusY: 0.5,
      rotation: -25,
      feather: 50,
    }
    const changed = await f.library.mutateMasks(photoId, 2, {
      operations: [
        { kind: 'update', id, gradient: next },
        { kind: 'duplicate', id, newId: duplicate, name: 'Copy' },
      ],
    })
    expect(admitted).toHaveLength(3)
    expect(changed.settings.maskStack.map((mask) => mask.gradient)).toEqual([next, next])
    expect(changed.maskContent).toEqual(corrected.maskContent)
    expect(changed.settings.maskStack.map((mask) => mask.head)).toEqual([
      corrected.settings.maskStack[0].head,
      corrected.settings.maskStack[0].head,
    ])
    await f.library.undoEdit(photoId, 3)
    await f.restart()
    const state = await f.library.getEdits(photoId)
    expect(state.settings.maskStack[0].gradient).toEqual(gradient)
    const redone = await f.library.redoEdit(photoId, state.revision)
    expect(redone.settings.maskStack).toEqual(changed.settings.maskStack)
    expect(redone.maskContent).toEqual(corrected.maskContent)
  } finally {
    await f.close()
  }
})
