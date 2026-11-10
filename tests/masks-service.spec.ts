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
    expect(changed.settings.maskStack.map((mask) => mask.resultHead)).toEqual([
      corrected.settings.maskStack[0].resultHead,
      corrected.settings.maskStack[0].resultHead,
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

test('shared compound service persists nested independent copies and one-step component edits across Undo/Redo and restart', async () => {
  const f = await transferFixture(1),
    photoId = f.ids[0],
    sourceId = randomUUID(),
    destinationId = randomUUID(),
    birdId = randomUUID(),
    copyId = randomUUID()
  f.library.fullPreviews.validateMaskEdit = async () => {}
  try {
    const created = await f.library.mutateMasks(photoId, 0, {
      operations: [
        {
          kind: 'create',
          id: sourceId,
          name: 'Bird',
          gradient: {
            kind: 'radial',
            center: { x: 0.5, y: 0.5 },
            radiusX: 0.3,
            radiusY: 0.4,
            rotation: 0,
            feather: 25,
          },
        },
        {
          kind: 'component-add',
          id: sourceId,
          componentId: birdId,
          name: 'Feathers',
          operator: 'add',
          stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.3, y: 0.4 }] },
        },
        {
          kind: 'stroke',
          id: sourceId,
          componentId: birdId,
          stroke: { mode: 'subtract', radius: 0.05, feather: 0, points: [{ x: 0.2, y: 0.4 }] },
        },
        {
          kind: 'create',
          id: destinationId,
          name: 'Protected water',
          gradient: { kind: 'linear', start: { x: 0.1, y: 0.1 }, end: { x: 0.9, y: 0.9 } },
        },
        {
          kind: 'component-copy',
          id: destinationId,
          componentId: copyId,
          name: 'Bird protection',
          sourceMaskId: sourceId,
          operator: 'subtract',
        },
        { kind: 'update', id: destinationId, light: { exposureEv: -1 } },
      ],
    })
    expect(created.revision).toBe(1)
    expect((await f.library.getEditHistory(photoId)).snapshots).toHaveLength(2)
    const copied = structuredClone(created.settings.maskStack[0].operands![0])
    const changed = await f.library.mutateMasks(photoId, 1, {
      operations: [
        { kind: 'component-update', id: sourceId, componentId: birdId, clearPrimary: true },
        {
          kind: 'component-update',
          id: destinationId,
          componentId: copyId,
          operator: 'intersect',
          edge: { featherPx: 3 },
        },
      ],
    })
    expect(changed.revision).toBe(2)
    expect(changed.settings.maskStack[0].operands![0].operands).toEqual(copied.operands)
    await expect(
      f.library.mutateMasks(photoId, 1, {
        operations: [{ kind: 'component-remove', id: destinationId, componentId: copyId }],
      }),
    ).rejects.toThrow('conflict')
    const undone = await f.library.undoEdit(photoId, 2)
    expect(undone.settings.maskStack).toEqual(created.settings.maskStack)
    await f.restart()
    f.library.fullPreviews.validateMaskEdit = async () => {}
    const restored = await f.library.getEdits(photoId)
    expect(restored.settings.maskStack).toEqual(created.settings.maskStack)
    expect(restored.maskContent).toEqual(created.maskContent)
    const redone = await f.library.redoEdit(photoId, restored.revision)
    expect(redone.settings.maskStack).toEqual(changed.settings.maskStack)
    const history = await f.library.getEditHistory(photoId)
    expect(history.snapshots).toHaveLength(3)
    expect(JSON.stringify(history)).not.toContain('"points"')
  } finally {
    await f.close()
  }
})

test('transient compound edge previews resolve draft geometry through the service without publishing history or immutable content', async () => {
  const { MaskEdgeService } = await import('../src/main/mask-edges/service')
  const { identityMaskGeometry } = await import('../src/shared/mask-geometry')
  const { cropAdmission } = await import('./crop-frame.helpers')
  const { dirname } = await import('node:path')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const sharp = (await import('sharp')).default
  const f = await transferFixture(1),
    photoId = f.ids[0],
    id = randomUUID(),
    partId = randomUUID()
  const inputs: import('../src/shared/masks').ResolvedMask[] = []
  try {
    f.library.fullPreviews.validateMaskEdit = async () => {}
    f.library.cropAdmission = async () => cropAdmission()
    f.library.getMaskContext = async (_photoId, revision) => ({
      photoId,
      revision,
      width: 8,
      height: 6,
      geometry: identityMaskGeometry(8, 6),
      renderingIdentity: 'draft-compound-context',
    })
    expect(f.library.maskEdges).toBeInstanceOf(MaskEdgeService)
    Reflect.set(f.library.maskEdges, 'runtime', {
      close: async () => {},
      prepare: async (
        mask: import('../src/shared/masks').ResolvedMask,
        width: number,
        height: number,
        key: string,
        path: string,
        signal: AbortSignal,
      ) => {
        inputs.push(structuredClone(mask))
        signal.throwIfAborted()
        const png = await sharp(Buffer.alloc(width * height, 128), {
          raw: { width, height, channels: 1 },
        })
          .toColourspace('b-w')
          .png()
          .toBuffer()
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, png)
        return {
          path,
          key,
          width,
          height,
          hash: createHash('sha256').update(png).digest('hex'),
          encodedBytes: png.length,
        }
      },
    })
    const committed = await f.library.mutateMasks(photoId, 0, {
      operations: [
        {
          kind: 'create',
          id,
          name: 'Water',
          gradient: { kind: 'linear', start: { x: 0.1, y: 0.1 }, end: { x: 0.9, y: 0.9 } },
        },
        { kind: 'update', id, edge: { featherPx: 2 } },
      ],
    })
    const before = await f.library.getEditHistory(photoId)
    const db = new DatabaseSync(join(f.root, 'library', 'catalog.sqlite'))
    try {
      const immutableBefore = db.prepare('SELECT * FROM mask_content').all()
      const draft = await f.library.prepareMaskCoverage({
        photoId,
        revision: committed.revision,
        maskIds: [id],
        mutation: {
          operations: [
            {
              kind: 'component-add',
              id,
              componentId: partId,
              name: 'Uncommitted protection',
              operator: 'subtract',
              stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.4, y: 0.5 }] },
            },
            { kind: 'component-update', id, componentId: partId, edge: { featherPx: 1 } },
            {
              kind: 'stroke',
              id,
              stroke: {
                mode: 'subtract',
                radius: 0.05,
                feather: 0.5,
                points: [{ x: 0.6, y: 0.5 }],
              },
            },
          ],
        },
      })
      expect(draft.coverages[id]).toBeDefined()
      expect(draft.coverages[partId]).toBeDefined()
      expect(inputs.find((node) => node.id === partId)!.strokes).toHaveLength(1)
      const preparedRoot = inputs.find((node) => node.id === id)!
      expect(preparedRoot.resultStrokes).toHaveLength(1)
      expect(preparedRoot.operands![0].preparedCoverage).toEqual(draft.coverages[partId])
      expect(await f.library.getEditHistory(photoId)).toEqual(before)
      expect(db.prepare('SELECT * FROM mask_content').all()).toEqual(immutableBefore)
      await f.library.cancelMaskCoverage(photoId)
      expect(await f.library.getEdits(photoId)).toEqual(committed)
      await expect(
        f.library.prepareMaskCoverage({
          photoId,
          revision: 0,
          maskIds: [id],
          mutation: {
            operations: [
              {
                kind: 'stroke',
                id,
                stroke: { mode: 'add', radius: 0.1, feather: 0, points: [{ x: 0.5, y: 0.5 }] },
              },
            ],
          },
        }),
      ).rejects.toThrow(/changed|conflict/i)
      expect(inputs).toHaveLength(2)
    } finally {
      db.close()
    }
  } finally {
    await f.close()
  }
})
