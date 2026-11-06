import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initialSettings } from '../src/shared/edits'
import { defaultEditTransferGroups } from '../src/shared/edit-transfer'
import { presetValues, type PresetSnapshot } from '../src/shared/presets'
import { DEFAULT_PRESET_APPEARANCE } from '../src/shared/preset-appearance'
import { PresetReadStore, PresetMutations } from '../src/main/preset-store'
import { catalogTransaction } from '../src/main/catalog/transaction'
import { processingMetadata } from '../src/main/processing/metadata'
import { profile } from './white-balance-picker.helpers'
import { transferFixture } from './edit-transfer.helpers'

test('both creation modes persist independently; management changes no photo history or clipboard', async () => {
  const t = await transferFixture(2)
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1.5, saturation: 22 }, 0)
    const clipboard = await t.library.copyEdits(t.ids[1]),
      before = await t.library.getEditHistory(t.ids[0])
    const captured = await t.library.createPreset({
      name: '  Woodland  ',
      source: { mode: 'photo', photoId: t.ids[0], groups: [...defaultEditTransferGroups] },
    })
    expect(captured.name).toBe('Woodland')
    expect(captured.appearance).toEqual(DEFAULT_PRESET_APPEARANCE)
    expect(captured.definition.values).toMatchObject({ exposureEv: 1.5, saturation: 22 })
    const explicit = await t.library.createPreset({
      name: 'Color',
      appearance: { icon: 'sunset', color: 'amber' },
      source: {
        mode: 'explicit',
        settingsVersion: 12,
        groups: ['color'],
        values: { saturation: -20, vibrance: 7 },
      },
    })
    expect(t.library.getEditClipboard()).toEqual(clipboard)
    expect(explicit.appearance).toEqual({ icon: 'sunset', color: 'amber' })
    expect(await t.library.getEditHistory(t.ids[0])).toEqual(before)
    expect(t.events.filter((e) => e.presetsChanged)).toHaveLength(2)
    const renamed = await t.library.updatePreset({
      presetId: captured.id,
      expectedPresetRevision: 1,
      name: 'Woodland soft',
    })
    expect(renamed).toMatchObject({
      revision: 2,
      definition: captured.definition,
      appearance: captured.appearance,
    })
    const updated = await t.library.updatePreset({
      presetId: captured.id,
      expectedPresetRevision: 2,
      source: { mode: 'photo', photoId: t.ids[1], groups: ['light'] },
    })
    expect(updated).toMatchObject({
      revision: 3,
      appearance: captured.appearance,
      definition: { groups: ['light'], values: { exposureEv: 0 } },
    })
    await expect(
      t.library.updatePreset({ presetId: captured.id, expectedPresetRevision: 2, name: 'Old' }),
    ).rejects.toThrow('revision conflict')
    await expect(
      t.library.deletePreset({ presetId: captured.id, expectedPresetRevision: 1 }),
    ).rejects.toThrow('revision conflict')
    await t.library.deletePreset({ presetId: explicit.id, expectedPresetRevision: 1 })
    await t.restart()
    expect(t.library.getPreset(captured.id)).toEqual(updated)
    expect(t.library.listPresets().total).toBe(1)
    expect(await t.library.getEditHistory(t.ids[0])).toEqual(before)
    expect(t.library.getEditClipboard()).toBeNull()
  } finally {
    await t.close()
  }
})

test('appearance-only edits persist partial markers and reject invalid or stale writes without photo history or clipboard changes', async () => {
  const t = await transferFixture(1)
  try {
    const clipboard = await t.library.copyEdits(t.ids[0]),
      history = await t.library.getEditHistory(t.ids[0])
    const p = await t.library.createPreset({
      name: 'Golden Hour',
      appearance: { icon: 'sunset', color: 'amber' },
      source: {
        mode: 'explicit',
        settingsVersion: 12,
        groups: ['color'],
        values: { saturation: 10, vibrance: 20 },
      },
    })
    const frozen = await t.library.preparePresetApplication({
      presetId: p.id,
      expectedPresetRevision: 1,
      photoIds: t.ids,
    })
    const updated = await t.library.updatePreset({
      presetId: p.id,
      expectedPresetRevision: 1,
      appearance: { color: 'violet' },
    })
    expect(updated).toMatchObject({
      revision: 2,
      appearance: { icon: 'sunset', color: 'violet' },
      definition: p.definition,
      createdAt: p.createdAt,
    })
    expect(frozen.source).toEqual(p)
    for (const appearance of [
      { icon: 'unknown' },
      { color: '#ff00ff' },
      {},
      { color: 'amber', path: '/private' },
    ])
      await expect(
        t.library.updatePreset({
          presetId: p.id,
          expectedPresetRevision: 2,
          appearance: appearance as { color: 'amber' },
        }),
      ).rejects.toThrow('supported preset icon and color')
    await expect(
      t.library.updatePreset({
        presetId: p.id,
        expectedPresetRevision: 1,
        appearance: { icon: 'fog' },
      }),
    ).rejects.toThrow('revision conflict')
    expect(t.events.filter((event) => event.presetsChanged)).toHaveLength(2)
    expect(t.library.listPresets().presets[0].appearance).toEqual(updated.appearance)
    expect(t.library.getEditClipboard()).toEqual(clipboard)
    expect(await t.library.getEditHistory(t.ids[0])).toEqual(history)
    const task = await t.library.startPresetApplication(frozen.id)
    await t.finished(task)
    expect(t.library.editTransfers.store.job(task).manifest.source).toEqual(p)
    await t.restart()
    expect(t.library.getPreset(p.id)).toEqual(updated)
    expect((await t.library.getEditHistory(t.ids[0])).snapshots).toHaveLength(2)
  } finally {
    await t.close()
  }
})

test('store v1 migration adds General and Neutral without rewriting photo history, preset revisions or historic job sources', async () => {
  const t = await transferFixture(1)
  try {
    const p = await t.library.createPreset({
        name: 'Legacy',
        source: { mode: 'photo', photoId: t.ids[0], groups: ['light'] },
      }),
      legacy: PresetSnapshot = structuredClone(p),
      history = await t.library.getEditHistory(t.ids[0]),
      jobId = randomUUID()
    delete legacy.appearance
    await t.library.editTransfers.store.accept(
      {
        version: 2,
        id: jobId,
        source: legacy,
        groups: ['light'],
        targets: [{ photoId: t.ids[0], filename: 'Photo-0.png', revision: 0 }],
      },
      {
        id: jobId,
        kind: 'edit-application',
        title: 'Applying preset',
        status: 'running',
        errorCount: 0,
        progress: { completed: 0, total: 1, unit: 'items' },
        editApplication: { applied: 0, unchanged: 0, conflict: 0, unavailable: 0, failed: 0 },
      },
    )
    await t.library.close()
    const path = join(t.root, 'library/catalog.sqlite'),
      db = new DatabaseSync(path)
    db.prepare('UPDATE edit_presets SET data = ? WHERE id = ?').run(JSON.stringify(legacy), p.id)
    db.exec('UPDATE preset_store SET version = 1')
    const manifest = (
      db.prepare('SELECT manifest FROM edit_applications WHERE id = ?').get(jobId) as {
        manifest: string
      }
    ).manifest
    db.close()
    await t.restart()
    expect(t.library.getPreset(p.id)).toEqual(p)
    expect(t.library.listPresets()).toMatchObject({
      storeRevision: 1,
      presets: [{ id: p.id, revision: 1, appearance: DEFAULT_PRESET_APPEARANCE }],
    })
    expect(await t.library.getEditHistory(t.ids[0])).toEqual(history)
    expect(t.library.editTransfers.store.job(jobId).manifest.source).toEqual(legacy)
    expect(t.library.editTransfers.store.results(jobId).results[0].outcome).toBe('interrupted')
    await t.restart()
    expect(t.library.getPreset(p.id)).toEqual(p)
    const stored = new DatabaseSync(path, { readOnly: true })
    try {
      expect(stored.prepare('SELECT * FROM preset_store').get()).toMatchObject({
        version: 2,
        revision: 1,
      })
      expect(
        (
          stored.prepare('SELECT manifest FROM edit_applications WHERE id = ?').get(jobId) as {
            manifest: string
          }
        ).manifest,
      ).toBe(manifest)
    } finally {
      stored.close()
    }
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})

test('appearance migration is atomic and malformed or future appearance is refused without writes', () => {
  const db = new DatabaseSync(':memory:'),
    read = new PresetReadStore(db),
    mutations = new PresetMutations(db)
  try {
    read.initialize()
    const legacy = {
      kind: 'preset' as const,
      id: randomUUID(),
      name: 'Legacy',
      revision: 5,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z',
      definition: {
        version: 1 as const,
        settingsVersion: 12 as const,
        groups: ['color' as const],
        values: { saturation: 10, vibrance: 0 },
        compatibility: { lensKinds: [] },
      },
    }
    mutations.create({ ...legacy, revision: 1, appearance: { ...DEFAULT_PRESET_APPEARANCE } })
    db.prepare('UPDATE edit_presets SET data = ?').run(JSON.stringify(legacy))
    db.exec('UPDATE preset_store SET version = 1')
    read.validateExisting()
    const snapshot = () => [
      db.prepare('SELECT * FROM preset_store').all(),
      db.prepare('SELECT * FROM edit_presets').all(),
    ]
    const before = snapshot()
    db.exec(
      "CREATE TRIGGER reject_migration BEFORE UPDATE ON preset_store BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END",
    )
    expect(() => catalogTransaction(db, () => read.initialize())).toThrow(
      'injected migration failure',
    )
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER reject_migration')
    catalogTransaction(db, () => read.initialize())
    expect(read.get(legacy.id)).toEqual({ ...legacy, appearance: DEFAULT_PRESET_APPEARANCE })
    for (const appearance of [null, { icon: 'future', color: 'neutral' }, { icon: 'general' }]) {
      db.prepare('UPDATE edit_presets SET data = ?').run(JSON.stringify({ ...legacy, appearance }))
      const invalid = snapshot()
      expect(() => read.validateExisting()).toThrow('format is unsupported')
      expect(snapshot()).toEqual(invalid)
    }
  } finally {
    db.close()
  }
})

test('unique names, strict complete explicit groups and failed writes leave no partial definition or revision', async () => {
  const t = await transferFixture(1)
  try {
    const source = { mode: 'photo' as const, photoId: t.ids[0], groups: ['light' as const] }
    const p = await t.library.createPreset({ name: 'Woodland', source })
    await expect(t.library.createPreset({ name: ' woodland ', source })).rejects.toThrow(
      'already exists',
    )
    await expect(
      t.library.createPreset({
        name: 'Partial',
        source: {
          mode: 'explicit',
          settingsVersion: 12,
          groups: ['light'],
          values: { exposureEv: 2 },
        },
      }),
    ).rejects.toThrow('complete values')
    const another = await t.library.createPreset({ name: 'Other', source })
    await expect(
      t.library.updatePreset({ presetId: another.id, expectedPresetRevision: 1, name: p.name }),
    ).rejects.toThrow('already exists')
    const before = t.library.listPresets()
    const db = new DatabaseSync(join(t.root, 'library/catalog.sqlite'))
    db.exec(
      "CREATE TRIGGER reject_preset BEFORE UPDATE ON edit_presets BEGIN SELECT RAISE(ABORT, 'injected preset disk failure'); END",
    )
    db.close()
    await expect(
      t.library.updatePreset({ presetId: p.id, expectedPresetRevision: 1, name: 'Renamed' }),
    ).rejects.toThrow('injected preset disk failure')
    expect(t.library.getPreset(p.id)).toEqual(p)
    expect(t.library.listPresets()).toEqual(before)
    expect(t.events.filter((e) => e.presetsChanged)).toHaveLength(2)
  } finally {
    await t.close()
  }
})

test('search, alphabetical chunks and stable anchor locations reject stale ordering revisions', async () => {
  const t = await transferFixture(0)
  try {
    const source = {
      mode: 'explicit' as const,
      settingsVersion: 12 as const,
      groups: ['color' as const],
      values: { saturation: 1, vibrance: 0 },
    }
    for (let i = 64; i >= 0; i--)
      await t.library.createPreset({ name: `Look ${String(i).padStart(3, '0')}`, source })
    const first = t.library.listPresets(),
      last = t.library.listPresets({ offset: 60, expectedStoreRevision: first.storeRevision })
    expect(first.presets).toHaveLength(60)
    expect(first.total).toBe(65)
    expect(first.presets[0].name).toBe('Look 000')
    expect(last.presets).toHaveLength(5)
    expect(
      t.library.listPresets({ search: '  LOOK 06  ', anchorId: last.presets[2].id }),
    ).toMatchObject({ total: 5, anchorIndex: 2 })
    await t.library.updatePreset({
      presetId: last.presets[2].id,
      expectedPresetRevision: 1,
      name: 'A look',
    })
    expect(() => t.library.listPresets({ expectedStoreRevision: first.storeRevision })).toThrow(
      'collection changed',
    )
    expect(t.library.listPresets({ anchorId: last.presets[2].id }).anchorIndex).toBe(0)
  } finally {
    await t.close()
  }
})

test('concurrent preset mutations publish one winner and reject stale update/deletion revisions', async () => {
  const t = await transferFixture(0)
  try {
    const p = await t.library.createPreset({
      name: 'Original',
      source: {
        mode: 'explicit',
        settingsVersion: 12,
        groups: ['color'],
        values: { saturation: 10, vibrance: 0 },
      },
    })
    const outcomes = await Promise.allSettled([
      t.library.updatePreset({ presetId: p.id, expectedPresetRevision: 1, name: 'Renamed' }),
      t.library.deletePreset({ presetId: p.id, expectedPresetRevision: 1 }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(
      (outcome) => outcome.status === 'rejected',
    ) as PromiseRejectedResult
    expect(String(rejected.reason)).toContain('revision conflict')
    expect(t.library.getPreset(p.id)).toMatchObject({ name: 'Renamed', revision: 2 })
  } finally {
    await t.close()
  }
})

test('frozen preset batches survive updates, deletion, source removal and restart with one-step history and no-op results', async () => {
  const t = await transferFixture()
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1.25, saturation: 20 }, 0)
    const p = await t.library.createPreset({
      name: 'Saved',
      source: { mode: 'photo', photoId: t.ids[0], groups: ['light'] },
    })
    const preparation = await t.library.preparePresetApplication({
      presetId: p.id,
      expectedPresetRevision: 1,
      photoIds: [t.ids[1], t.ids[2], t.ids[0], 'f'.repeat(64)],
    })
    preparation.targets.reverse()
    preparation.source.definition.values.exposureEv = 4
    const newer = await t.library.updatePreset({
      presetId: p.id,
      expectedPresetRevision: 1,
      source: { mode: 'photo', photoId: t.ids[1], groups: ['light'] },
    })
    await t.library.deletePreset({ presetId: p.id, expectedPresetRevision: newer.revision })
    await t.library.updateEdits(t.ids[2], { contrast: 20 }, 0)
    const id = await t.library.startPresetApplication(preparation.id)
    expect((await t.finished(id)).editApplication).toEqual({
      applied: 1,
      unchanged: 1,
      conflict: 1,
      unavailable: 1,
      failed: 0,
    })
    const history = await t.library.getEditHistory(t.ids[1])
    expect(history.snapshots).toHaveLength(2)
    expect(history.settings).toMatchObject({ exposureEv: 1.25, saturation: 0 })
    expect((await t.library.undoEdit(t.ids[1], 1)).settings.exposureEv).toBe(0)
    expect((await t.library.redoEdit(t.ids[1], 2)).settings.exposureEv).toBe(1.25)
    const results = t.library.editTransfers.store.results(id)
    await t.restart()
    expect(t.library.editTransfers.store.results(id)).toEqual(results)
    expect((await t.library.getEdits(t.ids[1])).settings.exposureEv).toBe(1.25)
    expect(t.library.listPresets().total).toBe(0)
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})

test('camera-dependent explicit and captured definitions use verified facts without calibration or source dependencies', async () => {
  const t = await transferFixture(2)
  try {
    const metadata = processingMetadata({}, [])
    metadata.whiteBalance = profile
    metadata.lensProfile.distortion = { radii: [0, 1], values: [1, 1.1] }
    await t.library.catalogCommands.command({
      operation: 'processing.publish',
      payload: {
        id: t.ids[0],
        data: { metadata, settings: initialSettings().lens, revision: 0 },
        createdAt: new Date().toISOString(),
      },
    })
    const source = {
      mode: 'explicit' as const,
      settingsVersion: 12 as const,
      groups: ['white-balance' as const, 'lens' as const],
      values: {
        whiteBalance: { mode: 'custom' as const, kelvin: 6500, tint: 10 },
        lens: { distortion: false },
      },
    }
    await expect(t.library.createPreset({ name: 'Unverified', source })).rejects.toThrow(
      'verified reference',
    )
    await expect(
      t.library.createPreset({
        name: 'Wrong reference',
        source: { ...source, referencePhotoId: t.ids[1] },
      }),
    ).rejects.toThrow('unavailable')
    const p = await t.library.createPreset({
      name: 'Camera',
      source: { ...source, referencePhotoId: t.ids[0] },
    })
    const captured = await t.library.createPreset({
      name: 'Captured camera',
      source: { mode: 'photo', photoId: t.ids[0], groups: ['white-balance', 'lens'] },
    })
    expect(captured.definition.compatibility).toEqual(p.definition.compatibility)
    expect(captured.definition.values).toEqual({
      whiteBalance: { mode: 'as-shot' },
      lens: { distortion: true },
    })
    expect(p.definition.compatibility).toEqual({
      whiteBalanceIdentity: profile.identity,
      lensKinds: ['distortion'],
    })
    expect(JSON.stringify(p)).not.toMatch(/radii|asShotGains|cameraToWorking|original\.png|photoId/)
    const prepared = await t.library.preparePresetApplication({
      presetId: p.id,
      expectedPresetRevision: p.revision,
      photoIds: t.ids,
    })
    expect(prepared.targets[0].unavailable).toBeUndefined()
    expect(prepared.targets[1].unavailable).toContain('verified')
    t.library.editTransfers.dispose(prepared.id)
    await t.library.catalogCommands.command({
      operation: 'removal.finish',
      payload: { id: t.ids[0] },
    })
    await t.restart()
    expect(t.library.getPreset(p.id)).toEqual(p)
    expect(t.library.getPreset(captured.id)).toEqual(captured)
    const next = await t.library.preparePresetApplication({
      presetId: p.id,
      expectedPresetRevision: 1,
      photoIds: [t.ids[1]],
    })
    expect(next.targets[0].unavailable).toContain('verified')
  } finally {
    await t.close()
  }
})

test('cancellation drains admitted edits and restart retains interrupted accepted preset jobs without replay', async () => {
  const t = await transferFixture(4)
  let release!: () => void, entered!: () => void
  const hold = new Promise<void>((r) => {
      release = r
    }),
    admitted = new Promise<void>((r) => {
      entered = r
    })
  let work: Promise<void> | undefined
  try {
    const p = await t.library.createPreset({
      name: 'Batch',
      source: {
        mode: 'explicit',
        settingsVersion: 12,
        groups: ['color'],
        values: { saturation: 20, vibrance: 0 },
      },
    })
    const prepared = await t.library.preparePresetApplication({
      presetId: p.id,
      expectedPresetRevision: 1,
      photoIds: t.ids.slice(1),
    })
    t.listen((event) => {
      if (event.editsChanged?.photoId === t.ids[1])
        work = t.library.scheduler.detached(() =>
          t.library.scheduler.run('interactive', async () => {
            entered()
            await hold
          }),
        )
    })
    const id = await t.library.startPresetApplication(prepared.id)
    await admitted
    await t.library.cancelTask(id)
    expect(t.library.editTransfers.store.results(id).results.map((r) => r.outcome)).toEqual([
      'applied',
      'cancelled',
      'cancelled',
    ])
    release()
    await work
    const interruptedId = randomUUID()
    await t.library.editTransfers.store.accept(
      {
        version: 2,
        id: interruptedId,
        source: p,
        groups: p.definition.groups,
        targets: [{ photoId: t.ids[2], filename: 'Photo-2.png', revision: 0 }],
      },
      {
        id: interruptedId,
        kind: 'edit-application',
        title: 'Applying preset',
        status: 'running',
        errorCount: 0,
        progress: { completed: 0, total: 1, unit: 'items' },
        editApplication: { applied: 0, unchanged: 0, conflict: 0, unavailable: 0, failed: 0 },
      },
    )
    await t.restart()
    expect(t.library.editTransfers.store.results(interruptedId).results[0].outcome).toBe(
      'interrupted',
    )
    expect((await t.library.getEdits(t.ids[2])).revision).toBe(0)
    expect(t.library.editTransfers.store.results(id).results[0].outcome).toBe('applied')
  } finally {
    release()
    await work
    await t.close()
  }
})

test('future or malformed preset formats are rejected before library startup writes', async () => {
  const t = await transferFixture(1)
  try {
    await t.library.createPreset({
      name: 'Retained',
      source: { mode: 'photo', photoId: t.ids[0], groups: ['light'] },
    })
    await t.library.close()
    const path = join(t.root, 'library/catalog.sqlite'),
      db = new DatabaseSync(path)
    db.exec('UPDATE preset_store SET version = 999')
    db.close()
    const before = await readFile(path)
    await expect(t.restart()).rejects.toThrow('preset store format is unsupported')
    expect(await readFile(path)).toEqual(before)
  } finally {
    await t.close()
  }
})

test('writer transaction rolls back a failed insert without publishing collection revision', () => {
  const db = new DatabaseSync(':memory:'),
    read = new PresetReadStore(db),
    mutations = new PresetMutations(db)
  try {
    read.initialize()
    const now = new Date().toISOString(),
      compatibility = { lensKinds: [] }
    const p = {
      kind: 'preset' as const,
      id: randomUUID(),
      name: 'Rollback',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      appearance: { ...DEFAULT_PRESET_APPEARANCE },
      definition: {
        version: 1 as const,
        settingsVersion: 12 as const,
        groups: ['color' as const],
        values: presetValues(initialSettings(), ['color'], compatibility),
        compatibility,
      },
    }
    db.exec(
      "CREATE TRIGGER reject_revision BEFORE UPDATE ON preset_store BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    )
    expect(() => catalogTransaction(db, () => mutations.create(p))).toThrow('disk full')
    expect(read.list()).toMatchObject({ presets: [], total: 0, storeRevision: 0 })
  } finally {
    db.close()
  }
})
