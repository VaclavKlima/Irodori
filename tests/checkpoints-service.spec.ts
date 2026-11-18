import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { transferFixture } from './edit-transfer.helpers'
import { generatedMask } from './helpers/generated-mask'
import {
  MaskContentStore,
  prepareMaskBaseReplacement,
  prepareMaskMutation,
} from '../src/main/mask-store'
import { EditCheckpointReadStore, EditCheckpointMutations } from '../src/main/edit-checkpoint-store'
import { catalogTransaction } from '../src/main/catalog/transaction'
import { initialSettings, SETTINGS_VERSION } from '../src/shared/edits'
import { COLLECTION_CHUNK_SIZE } from '../src/shared/collections'
import type { EditCheckpoint, EditComparisonSource } from '../src/shared/edit-checkpoints'

const ref = (checkpoint: EditCheckpoint) => ({
  photoId: checkpoint.photoId,
  checkpointId: checkpoint.id,
  expectedCheckpointRevision: checkpoint.revision,
})

test('complete named versions survive branch pruning and restart, restore in one Undo step, and retain generated/brush mask content', async () => {
  const t = await transferFixture(1),
    photoId = t.ids[0]
  try {
    t.library.fullPreviews.validateMaskEdit = async () => {}
    await t.library.updateEdits(
      photoId,
      {
        exposureEv: 0.4,
        saturation: 8,
        noiseReduction: { luminance: 15, chroma: 20 },
        detailSharpening: { amount: 32, radius: 1.2 },
      },
      0,
    )
    const natural = await t.library.createEditCheckpoint({
      photoId,
      name: ' Natural ',
      expectedRevision: 1,
    })
    const maskId = randomUUID(),
      base = generatedMask(8, 6, (x) => (x < 4 ? 255 : 0))
    const mutation = prepareMaskMutation([], {
      operations: [
        { kind: 'create', id: maskId, name: 'Subject' },
        {
          kind: 'stroke',
          id: maskId,
          stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.5, y: 0.5 }] },
        },
        {
          kind: 'update',
          id: maskId,
          light: { exposureEv: 0.5 },
          color: { saturation: 5 },
          texture: 10,
        },
      ],
    })
    const history = await t.library.getEditHistory(photoId)
    history.settings = {
      ...history.settings,
      maskStack: prepareMaskBaseReplacement(mutation.stack, maskId, base),
    }
    history.snapshots.push({ settings: history.settings, createdAt: '2026-11-16T12:00:00Z' })
    history.cursor++
    await t.library.catalogCommands.command({
      operation: 'edits.commit',
      payload: { history, expectedRevision: 1, maskChunks: mutation.chunks, maskBases: [base] },
    })
    await t.library.updateEdits(
      photoId,
      { contrast: 35, noiseReduction: { luminance: 35 }, detailSharpening: { amount: 65 } },
      2,
    )
    const strongerState = await t.library.getEdits(photoId)
    const stronger = await t.library.createEditCheckpoint({
      photoId,
      name: 'Stronger',
      expectedRevision: 3,
    })
    const beforeSave = await t.library.getEditHistory(photoId)
    expect(stronger.settings).toEqual(strongerState.settings)
    expect(await t.library.getEditHistory(photoId)).toEqual(beforeSave)
    expect(JSON.stringify(stronger)).not.toMatch(/pngBase64|"points"/)
    await t.library.undoEdit(photoId, 3)
    await t.library.undoEdit(photoId, 4)
    await t.library.updateEdits(photoId, { exposureEv: -0.3 }, 5)
    expect(
      (await t.library.getEditHistory(photoId)).snapshots.some(
        (entry) => entry.settings.maskStack.length,
      ),
    ).toBe(false)
    await t.restart()
    t.library.fullPreviews.validateMaskEdit = async () => {}
    const beforeRestore = await t.library.getEditHistory(photoId)
    const restored = await t.library.restoreEditCheckpoint({
      ...ref(stronger),
      expectedRevision: 6,
    })
    expect(restored.settings).toEqual(strongerState.settings)
    expect(restored.maskContent).toEqual(strongerState.maskContent)
    expect(restored.maskBases).toEqual(strongerState.maskBases)
    expect((await t.library.getEditHistory(photoId)).snapshots).toHaveLength(
      beforeRestore.snapshots.length + 1,
    )
    expect((await t.library.undoEdit(photoId, restored.revision)).settings).toEqual(
      beforeRestore.settings,
    )
    const again = await t.library.restoreEditCheckpoint({
      ...ref(natural),
      expectedRevision: restored.revision + 1,
    })
    expect(again.settings).toEqual(natural.settings)
    const unchanged = await t.library.getEditHistory(photoId)
    expect(
      await t.library.restoreEditCheckpoint({ ...ref(natural), expectedRevision: again.revision }),
    ).toMatchObject({ revision: again.revision })
    expect(await t.library.getEditHistory(photoId)).toEqual(unchanged)
    expect((await t.library.listEditCheckpoints(photoId)).total).toBe(2)
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})

test('management preserves photo history and clipboard, uses per-photo names and checkpoint revisions', async () => {
  const t = await transferFixture(2)
  try {
    const photoId = t.ids[0],
      clipboard = await t.library.copyEdits(photoId),
      history = await t.library.getEditHistory(photoId)
    const checkpoint = await t.library.createEditCheckpoint({
      photoId,
      name: 'Natural',
      expectedRevision: 0,
    })
    await expect(
      t.library.createEditCheckpoint({ photoId, name: 'ＮＡＴＵＲＡＬ', expectedRevision: 0 }),
    ).rejects.toThrow('already exists')
    await t.library.createEditCheckpoint({
      photoId: t.ids[1],
      name: 'natural',
      expectedRevision: 0,
    })
    const renamed = await t.library.renameEditCheckpoint({ ...ref(checkpoint), name: 'Soft' })
    expect(renamed).toMatchObject({
      revision: 2,
      name: 'Soft',
      settings: checkpoint.settings,
      createdAt: checkpoint.createdAt,
    })
    await expect(
      t.library.renameEditCheckpoint({ ...ref(checkpoint), name: 'Stale' }),
    ).rejects.toThrow('revision conflict')
    await expect(t.library.deleteEditCheckpoint(ref(checkpoint))).rejects.toThrow(
      'revision conflict',
    )
    await expect(t.library.getEditCheckpoint(t.ids[1], checkpoint.id)).rejects.toThrow(
      'unavailable',
    )
    await t.library.deleteEditCheckpoint(ref(renamed))
    expect(await t.library.getEditHistory(photoId)).toEqual(history)
    expect(t.library.getEditClipboard()).toEqual(clipboard)
    expect(t.events.filter((event) => event.editsChanged)).toHaveLength(0)
    expect((await t.library.listEditCheckpoints(photoId)).total).toBe(0)
    expect((await t.library.listEditCheckpoints(t.ids[1])).total).toBe(1)
    await t.restart()
    expect((await t.library.listEditCheckpoints(photoId)).total).toBe(0)
  } finally {
    await t.close()
  }
})

test('save, restore and failed disk writes never overwrite newer edits or partially publish state', async () => {
  const t = await transferFixture(1),
    photoId = t.ids[0],
    db = new DatabaseSync(join(t.root, 'library/catalog.sqlite'))
  try {
    const checkpoint = await t.library.createEditCheckpoint({
      photoId,
      name: 'Natural',
      expectedRevision: 0,
    })
    await t.library.updateEdits(photoId, { exposureEv: 1 }, 0)
    await expect(
      t.library.createEditCheckpoint({ photoId, name: 'Old', expectedRevision: 0 }),
    ).rejects.toThrow('Edit conflict')
    await expect(
      t.library.restoreEditCheckpoint({ ...ref(checkpoint), expectedRevision: 0 }),
    ).rejects.toThrow('Edit conflict')
    const before = await t.library.getEditHistory(photoId),
      events = t.events.filter((event) => event.editsChanged).length
    db.exec(
      "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON edit_checkpoints BEGIN SELECT RAISE(ABORT, 'Test checkpoint disk failure'); END",
    )
    await expect(
      t.library.createEditCheckpoint({ photoId, name: 'Failed', expectedRevision: 1 }),
    ).rejects.toThrow('disk failure')
    expect((await t.library.listEditCheckpoints(photoId)).total).toBe(1)
    db.exec('DROP TRIGGER fail_checkpoint')
    db.exec(
      "CREATE TRIGGER fail_checkpoint_restore BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'Test restore disk failure'); END",
    )
    await expect(
      t.library.restoreEditCheckpoint({ ...ref(checkpoint), expectedRevision: 1 }),
    ).rejects.toThrow('disk failure')
    expect(await t.library.getEditHistory(photoId)).toEqual(before)
    expect(t.events.filter((event) => event.editsChanged)).toHaveLength(events)
    db.exec('DROP TRIGGER fail_checkpoint_restore')
    const concurrent = await Promise.allSettled([
      t.library.restoreEditCheckpoint({ ...ref(checkpoint), expectedRevision: 1 }),
      t.library.updateEdits(photoId, { contrast: 20 }, 1),
    ])
    expect(concurrent.map((entry) => entry.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await t.library.getEdits(photoId)).revision).toBe(2)
  } finally {
    db.close()
    await t.close()
  }
})

test('frozen comparison sources resolve complete independent settings and reject stale Current, renamed/deleted versions and changed files', async () => {
  const t = await transferFixture(2),
    photoId = t.ids[0]
  try {
    const checkpoint = await t.library.createEditCheckpoint({
      photoId,
      name: 'Natural',
      expectedRevision: 0,
    })
    await t.library.updateEdits(photoId, { exposureEv: 1, noiseReduction: { luminance: 25 } }, 0)
    const references: [EditComparisonSource, EditComparisonSource] = [
      { kind: 'checkpoint', checkpointId: checkpoint.id, expectedCheckpointRevision: 1 },
      { kind: 'current', expectedRevision: 1 },
    ]
    const before = await t.library.getEditHistory(photoId),
      frozen = await t.library.resolveEditComparisonSources(photoId, references)
    const a = await t.library.frozenEditComparisonSource(frozen[0]),
      b = await t.library.frozenEditComparisonSource(frozen[1])
    expect(a.processing.adjustments?.exposureEv).toBe(0)
    expect(b.processing.adjustments?.exposureEv).toBe(1)
    expect(a.processing.noiseReduction?.luminance).toBe(0)
    expect(b.processing.noiseReduction?.luminance).toBe(25)
    expect(a.path).toBe(b.path)
    expect(a.identity).toEqual(b.identity)
    expect(await t.library.getEditHistory(photoId)).toEqual(before)
    await expect(t.library.resolveEditComparisonSources(t.ids[1], references)).rejects.toThrow(
      'unavailable',
    )
    await t.library.updateEdits(photoId, { contrast: 10 }, 1)
    await expect(t.library.assertEditComparisonSources(frozen)).rejects.toThrow(
      'Current comparison revision changed',
    )
    const savedPair = await t.library.resolveEditComparisonSources(photoId, [
      references[0],
      references[0],
    ])
    const renamed = await t.library.renameEditCheckpoint({ ...ref(checkpoint), name: 'Soft' })
    await expect(t.library.assertEditComparisonSources(savedPair)).rejects.toThrow(
      'revision conflict',
    )
    const renamedRef: EditComparisonSource = {
      kind: 'checkpoint',
      checkpointId: renamed.id,
      expectedCheckpointRevision: renamed.revision,
    }
    const filePair = await t.library.resolveEditComparisonSources(photoId, [renamedRef, renamedRef])
    await writeFile(a.path, 'replaced source')
    await expect(t.library.assertEditComparisonSources(filePair)).rejects.toThrow(
      'managed comparison source changed',
    )
    await t.library.deleteEditCheckpoint(ref(renamed))
    await expect(t.library.assertEditComparisonSources(filePair)).rejects.toThrow()
  } finally {
    await t.close()
  }
})

test('checkpoint listing uses bounded newest-first chunks, literal normalized search and ordering revisions', () => {
  const db = new DatabaseSync(':memory:'),
    photoId = 'a'.repeat(64),
    store = new EditCheckpointMutations(db)
  try {
    db.exec('CREATE TABLE photos(id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO photos VALUES (?)').run(photoId)
    new MaskContentStore(db).initialize()
    store.initialize()
    const checkpoints: EditCheckpoint[] = Array.from(
      { length: COLLECTION_CHUNK_SIZE + 3 },
      (_, index) => ({
        version: 1,
        kind: 'checkpoint',
        id: randomUUID(),
        photoId,
        name: `Version ${index} %`,
        revision: 1,
        createdAt: new Date(Date.UTC(2026, 10, 16, 0, 0, index)).toISOString(),
        updatedAt: '2026-11-16T00:00:00.000Z',
        capturedFromRevision: 0,
        settings: initialSettings(),
      }),
    )
    for (const checkpoint of checkpoints) catalogTransaction(db, () => store.create(checkpoint))
    const first = store.list(photoId),
      anchor = checkpoints[2]
    expect(first.checkpoints).toHaveLength(COLLECTION_CHUNK_SIZE)
    expect(first.checkpoints[0].id).toBe(checkpoints.at(-1)!.id)
    const second = store.list(photoId, {
      offset: COLLECTION_CHUNK_SIZE,
      expectedStoreRevision: first.storeRevision,
      anchorId: anchor.id,
    })
    expect(second.anchorIndex).toBe(COLLECTION_CHUNK_SIZE)
    expect(second.checkpoints.map((entry) => entry.id)).toEqual(
      checkpoints
        .slice(0, 3)
        .reverse()
        .map((entry) => entry.id),
    )
    expect(store.list(photoId, { search: '%' }).total).toBe(checkpoints.length)
    expect(store.list(photoId, { search: 'ＶＥＲＳＩＯＮ 0' }).total).toBe(1)
    catalogTransaction(db, () => store.delete(ref(anchor)))
    expect(() => store.list(photoId, { expectedStoreRevision: first.storeRevision })).toThrow(
      'collection changed',
    )
  } finally {
    db.close()
  }
})

test('independent checkpoint migration preserves metadata and history; future and incomplete stores are refused before writes', () => {
  const db = new DatabaseSync(':memory:'),
    photoId = 'a'.repeat(64),
    store = new EditCheckpointMutations(db)
  try {
    db.exec('CREATE TABLE photos(id TEXT PRIMARY KEY)')
    db.prepare('INSERT INTO photos VALUES (?)').run(photoId)
    new MaskContentStore(db).initialize()
    store.initialize()
    const checkpoint: EditCheckpoint = {
      version: 1,
      kind: 'checkpoint',
      id: randomUUID(),
      photoId,
      name: 'Natural',
      revision: 3,
      capturedFromRevision: 17,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-15T00:00:00Z',
      settings: initialSettings(),
    }
    const legacy = { ...checkpoint, settings: { ...checkpoint.settings, version: 19 } }
    db.prepare('INSERT INTO edit_checkpoints VALUES (?, ?, ?, ?, ?)').run(
      checkpoint.id,
      photoId,
      'natural',
      checkpoint.createdAt,
      JSON.stringify(legacy),
    )
    store.validateExisting()
    catalogTransaction(db, () => store.initialize())
    expect(store.get(photoId, checkpoint.id)).toEqual(checkpoint)
    expect(store.get(photoId, checkpoint.id).settings.version).toBe(SETTINGS_VERSION)
    db.exec('UPDATE checkpoint_store SET version = 999')
    const before = db.prepare('SELECT * FROM checkpoint_store').get()
    expect(() => new EditCheckpointReadStore(db).validateExisting()).toThrow('preserved')
    expect(db.prepare('SELECT * FROM checkpoint_store').get()).toEqual(before)
  } finally {
    db.close()
  }
  const incomplete = new DatabaseSync(':memory:')
  try {
    incomplete.exec(
      'CREATE TABLE checkpoint_store(singleton INTEGER, version INTEGER, revision INTEGER); INSERT INTO checkpoint_store VALUES(1,1,0)',
    )
    expect(() => new EditCheckpointReadStore(incomplete).validateExisting()).toThrow('preserved')
  } finally {
    incomplete.close()
  }
})

test('only committed photo removal deletes checkpoint rows and failed removal transactions preserve them', async () => {
  const t = await transferFixture(1),
    photoId = t.ids[0],
    db = new DatabaseSync(join(t.root, 'library/catalog.sqlite'))
  try {
    const checkpoint = await t.library.createEditCheckpoint({
      photoId,
      name: 'Natural',
      expectedRevision: 0,
    })
    db.exec(
      "CREATE TRIGGER fail_remove_version BEFORE DELETE ON photos BEGIN SELECT RAISE(ABORT, 'Test removal failure'); END",
    )
    await expect(
      t.library.catalogCommands.command({ operation: 'removal.finish', payload: { id: photoId } }),
    ).rejects.toThrow('removal failure')
    expect(await t.library.getEditCheckpoint(photoId, checkpoint.id)).toEqual(checkpoint)
    db.exec('DROP TRIGGER fail_remove_version')
    await t.library.catalogCommands.command({
      operation: 'removal.finish',
      payload: { id: photoId },
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM edit_checkpoints').get()).toMatchObject({
      count: 0,
    })
    await expect(t.library.getEditCheckpoint(photoId, checkpoint.id)).rejects.toThrow('unavailable')
  } finally {
    db.close()
    await t.close()
  }
})

test('a checkpoint deleted during restore admission cannot publish its stale settings', async () => {
  const t = await transferFixture(1),
    photoId = t.ids[0],
    maskId = randomUUID()
  let release!: () => void
  try {
    t.library.fullPreviews.validateMaskEdit = async () => {}
    await t.library.mutateMasks(photoId, 0, {
      operations: [{ kind: 'create', id: maskId, name: 'Subject' }],
    })
    const checkpoint = await t.library.createEditCheckpoint({
      photoId,
      name: 'Masked',
      expectedRevision: 1,
    })
    await t.library.mutateMasks(photoId, 1, { operations: [{ kind: 'delete', id: maskId }] })
    const before = await t.library.getEditHistory(photoId)
    let entered!: () => void
    const admission = new Promise<void>((resolve) => {
      entered = resolve
    })
    t.library.fullPreviews.validateMaskEdit = async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const pending = t.library.restoreEditCheckpoint({ ...ref(checkpoint), expectedRevision: 2 })
    await admission
    await t.library.deleteEditCheckpoint(ref(checkpoint))
    const rejection = expect(pending).rejects.toThrow('unavailable')
    release()
    await rejection
    expect(await t.library.getEditHistory(photoId)).toEqual(before)
  } finally {
    release?.()
    await t.close()
  }
})

test('missing immutable checkpoint mask data refuses restore and startup without changing current edits or stored versions', async () => {
  const t = await transferFixture(1),
    photoId = t.ids[0],
    maskId = randomUUID()
  const db = new DatabaseSync(join(t.root, 'library/catalog.sqlite'))
  try {
    t.library.fullPreviews.validateMaskEdit = async () => {}
    await t.library.mutateMasks(photoId, 0, {
      operations: [
        { kind: 'create', id: maskId, name: 'Subject' },
        {
          kind: 'stroke',
          id: maskId,
          stroke: { mode: 'add', radius: 0.1, feather: 0.2, points: [{ x: 0.5, y: 0.5 }] },
        },
      ],
    })
    const checkpoint = await t.library.createEditCheckpoint({
      photoId,
      name: 'Masked',
      expectedRevision: 1,
    })
    await t.library.undoEdit(photoId, 1)
    await t.library.updateEdits(photoId, { contrast: 5 }, 2)
    const before = await t.library.getEditHistory(photoId)
    db.prepare('DELETE FROM mask_content WHERE photo_id = ?').run(photoId)
    await expect(
      t.library.restoreEditCheckpoint({ ...ref(checkpoint), expectedRevision: 3 }),
    ).rejects.toThrow('mask content is missing')
    expect(await t.library.getEditHistory(photoId)).toEqual(before)
    const saved = db.prepare('SELECT * FROM edit_checkpoints').all()
    await expect(t.restart()).rejects.toThrow('library was preserved')
    expect(db.prepare('SELECT * FROM edit_checkpoints').all()).toEqual(saved)
    const current = db.prepare('SELECT data FROM edits WHERE id = ?').get(photoId) as {
      data: string
    }
    expect(JSON.parse(current.data)).toEqual(before)
  } finally {
    db.close()
    await t.close()
  }
})

test('source-processing promotion preserves old checkpoint contents and refuses incompatible restore or comparison', async () => {
  const t = await transferFixture(1),
    photoId = t.ids[0]
  const db = new DatabaseSync(join(t.root, 'library/catalog.sqlite'))
  try {
    const checkpoint = await t.library.createEditCheckpoint({
      photoId,
      name: 'Before HDR classification',
      expectedRevision: 0,
    })
    const row = db.prepare('SELECT data FROM processing WHERE id = ?').get(photoId) as {
      data: string
    }
    const processing = JSON.parse(row.data)
    processing.metadata.hdrJpeg = { state: 'supported' }
    await t.library.catalogCommands.command({
      operation: 'processing.publish',
      payload: { id: photoId, data: processing, createdAt: '2026-11-16T12:00:00Z' },
    })
    const before = await t.library.getEditHistory(photoId)
    expect(before.settings.processing).toBe('hdr-v1')
    await expect(
      t.library.restoreEditCheckpoint({ ...ref(checkpoint), expectedRevision: before.revision }),
    ).rejects.toThrow('earlier source processing identity')
    await expect(
      t.library.resolveEditComparisonSources(photoId, [
        { kind: 'checkpoint', checkpointId: checkpoint.id, expectedCheckpointRevision: 1 },
        { kind: 'current', expectedRevision: before.revision },
      ]),
    ).rejects.toThrow('earlier source processing identity')
    expect(await t.library.getEditCheckpoint(photoId, checkpoint.id)).toEqual(checkpoint)
    expect(await t.library.getEditHistory(photoId)).toEqual(before)
  } finally {
    db.close()
    await t.close()
  }
})
