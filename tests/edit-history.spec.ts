import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewEngine } from '../src/main/preview-engine'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
import type { EditHistory, EditPatch } from '../src/shared/edits'
import type { Photo } from '../src/shared/contracts'
const id = 'a'.repeat(64)
test('migrates v3 choices and revisions, commits shared history atomically, rejects conflicts, branches redo and cleans deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-edits-'))
  await mkdir(join(root, 'originals', id), { recursive: true })
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  db.exec(
    'CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT, photo TEXT); CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT); PRAGMA user_version = 3',
  )
  db.prepare('INSERT INTO photos VALUES (?, ?, ?)').run(
    id,
    '2026',
    JSON.stringify({ id, filename: 'test.arw' }),
  )
  const metadata = processingMetadata({
    'IFD0:Make': 'SONY',
    'IFD0:Model': 'ZV-1',
    'SubIFD:DistortionCorrParams': '3 100 0 -100',
  })
  db.prepare('INSERT INTO processing VALUES (?, ?)').run(
    id,
    JSON.stringify({ metadata, settings: noLensSettings, revision: 7 }),
  )
  db.close()
  const events: number[] = []
  let library = new PhotoLibrary(root, new PreviewEngine(), (event) => {
    if (event.editsChanged) events.push(event.editsChanged.revision)
  })
  try {
    await library.open()
    expect(await library.getEdits(id)).toMatchObject({
      revision: 7,
      settings: {
        shadows: 0,
        whites: 0,
        blacks: 0,
        version: 7,
        processing: 'hdr-v1',
        whiteBalance: { mode: 'as-shot' },
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
        lens: noLensSettings,
      },
      canUndo: false,
    })
    await library.updateEdits(id, { exposureEv: 1.25 }, 7)
    await library.updateLensSettings(id, 'distortion', true)
    expect((await library.getEditHistory(id)).snapshots).toHaveLength(3)
    expect(await library.undoEdit(id, 9)).toMatchObject({
      revision: 10,
      settings: { exposureEv: 1.25, lens: noLensSettings },
      canRedo: true,
    })
    await library.redoEdit(id, 10)
    await library.undoEdit(id, 11)
    await library.updateEdits(id, { exposureEv: -2 }, 12)
    expect(await library.getEdits(id)).toMatchObject({ revision: 13, canRedo: false })
    const beforeConcurrent = await library.getEditHistory(id)
    const concurrent = await Promise.allSettled([
      library.updateEdits(id, { exposureEv: 0.5 }, 13),
      library.updateEdits(id, { exposureEv: 0.75 }, 13),
    ])
    expect(concurrent.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const winner = concurrent.findIndex((result) => result.status === 'fulfilled')
    const accepted = concurrent[winner]
    const rejected = concurrent[1 - winner]
    expect(rejected.status === 'rejected' && rejected.reason.message).toContain('Edit conflict')
    const committed = await library.getEditHistory(id)
    expect(committed).toMatchObject({
      revision: 14,
      cursor: beforeConcurrent.cursor + 1,
      canUndo: true,
      canRedo: false,
      settings: { exposureEv: [0.5, 0.75][winner] },
    })
    expect(committed.snapshots.slice(0, -1)).toEqual(beforeConcurrent.snapshots)
    expect(committed.snapshots.at(-1)!.settings).toEqual(committed.settings)
    expect(accepted.status === 'fulfilled' && accepted.value.settings).toEqual(committed.settings)
    expect(events.filter((revision) => revision === 14)).toEqual([14])
    for (const exposureEv of [NaN, Infinity, 5.1, -5.01, 0.001, '1'])
      await expect(
        library.updateEdits(id, { exposureEv: exposureEv as number }, 14),
      ).rejects.toThrow('Exposure')
    await expect(library.updateEdits(id, { lens: { vignetting: true } }, 14)).rejects.toThrow(
      'unavailable',
    )
    const before = await library.getEditHistory(id)
    const fault = new DatabaseSync(join(root, 'catalog.sqlite'))
    fault.exec(
      "CREATE TRIGGER fail_edits BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'Test disk failure'); END",
    )
    await expect(library.updateEdits(id, { exposureEv: -1 }, 14)).rejects.toThrow(
      'Test disk failure',
    )
    expect(await library.getEditHistory(id)).toEqual(before)
    fault.exec('DROP TRIGGER fail_edits')
    fault.close()
    await library.close()
    library = new PhotoLibrary(root, new PreviewEngine(), () => {})
    await library.open()
    expect(await library.getEditHistory(id)).toEqual(before)
    expect(events).toEqual([8, 9, 10, 11, 12, 13, 14])
    const deletion = new DatabaseSync(join(root, 'catalog.sqlite'))
    deletion.prepare('DELETE FROM photos WHERE id = ?').run(id)
    expect(deletion.prepare('SELECT COUNT(*) AS count FROM edits').get()).toMatchObject({
      count: 0,
    })
    deletion.close()
    await expect(library.getEdits(id)).rejects.toThrow('unavailable')
  } finally {
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

const combinedPatch: EditPatch = {
  exposureEv: -0.75,
  contrast: 35,
  highlights: -30,
  shadows: 20,
  whites: -15,
  blacks: 8,
}
type HistoryAction = 'update' | 'undo' | 'redo'

async function historyFixture(beforeTrash?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'luma-history-race-'))
  await mkdir(join(root, 'trash'))
  const events: number[] = [],
    invalidations: string[] = []
  const library = new PhotoLibrary(
    root,
    {
      process: async () => {
        throw new Error('Synthetic history must not decode a photograph.')
      },
      close: async () => {},
    },
    (event) => {
      if (event.editsChanged) events.push(event.editsChanged.revision)
    },
    undefined,
    async (path) => {
      await beforeTrash?.()
      await rename(path, join(root, 'trash', basename(path)))
    },
    {
      inspect: async () => {
        throw new Error('Synthetic current-version metadata must not be inspected.')
      },
      close: async () => {},
    },
  )
  await library.open()
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  const photo: Photo = {
    id,
    filename: 'synthetic.png',
    format: 'PNG',
    width: 12,
    height: 8,
    bytes: 16,
    importedAt: '2026-10-16T00:00:00.000Z',
    previewSource: 'image',
    thumbnailUrl: '',
    previewUrl: '',
  }
  db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'display-referred-v1')").run(
    id,
    photo.importedAt,
    JSON.stringify(photo),
  )
  db.prepare('INSERT INTO processing VALUES (?, ?)').run(
    id,
    JSON.stringify({ metadata: processingMetadata({}, []), settings: noLensSettings, revision: 0 }),
  )
  await mkdir(join(root, 'originals', id))
  await writeFile(join(root, 'originals', id, 'original.png'), 'synthetic source')
  const settingsChanged = library.fullPreviews.settingsChanged.bind(library.fullPreviews)
  library.fullPreviews.settingsChanged = (photoId) => {
    invalidations.push(photoId)
    settingsChanged(photoId)
  }
  const persisted = () => {
    const row = db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as { data: string }
    return JSON.parse(row.data) as EditHistory
  }
  const act = (action: HistoryAction, revision: number) =>
    action === 'update'
      ? library.updateEdits(id, combinedPatch, revision)
      : action === 'undo'
        ? library.undoEdit(id, revision)
        : library.redoEdit(id, revision)
  const middle = async () => {
    await library.updateEdits(id, { exposureEv: 1, contrast: 10 }, 0)
    await library.updateEdits(id, { exposureEv: 2, contrast: 20 }, 1)
    await library.undoEdit(id, 2)
    const history = await library.getEditHistory(id)
    expect(history).toMatchObject({ revision: 3, cursor: 1, canUndo: true, canRedo: true })
    events.length = 0
    invalidations.length = 0
    return history
  }
  return {
    library,
    db,
    events,
    invalidations,
    persisted,
    act,
    middle,
    close: async () => {
      await library.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function expectHistoryAction(before: EditHistory, after: EditHistory, action: HistoryAction) {
  const cursor = before.cursor + (action === 'undo' ? -1 : 1)
  const settings =
    action === 'update'
      ? { ...before.settings, ...combinedPatch, lens: before.settings.lens }
      : before.snapshots[cursor].settings
  expect(after).toMatchObject({
    revision: before.revision + 1,
    cursor,
    settings,
    canUndo: cursor > 0,
    canRedo: action !== 'update' && cursor < before.snapshots.length - 1,
  })
  if (action === 'update') {
    expect(after.snapshots).toHaveLength(cursor + 1)
    expect(after.snapshots.slice(0, -1)).toEqual(before.snapshots.slice(0, cursor))
    expect(after.snapshots.at(-1)!.settings).toEqual(settings)
  } else expect(after.snapshots).toEqual(before.snapshots)
}

for (const actions of [
  ['update', 'undo'],
  ['update', 'redo'],
  ['undo', 'redo'],
] as const)
  test(`concurrent ${actions.join(' and ')} publish exactly one complete history transition`, async () => {
    const t = await historyFixture()
    try {
      const before = await t.middle()
      const results = await Promise.allSettled(
        actions.map((action) => t.act(action, before.revision)),
      )
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      const winner = results.findIndex((result) => result.status === 'fulfilled')
      const rejected = results[1 - winner]
      expect(rejected.status === 'rejected' && rejected.reason.message).toContain('Edit conflict')
      const after = await t.library.getEditHistory(id)
      expectHistoryAction(before, after, actions[winner])
      expect(t.persisted()).toEqual(after)
      const accepted = results[winner]
      expect(accepted.status === 'fulfilled' && accepted.value.settings).toEqual(after.settings)
      expect(t.events).toEqual([before.revision + 1])
      expect(t.invalidations).toEqual([id])
    } finally {
      await t.close()
    }
  })

for (const action of ['update', 'undo', 'redo'] as const)
  test(`a failed ${action} transaction preserves history and retries at the same revision`, async () => {
    const t = await historyFixture()
    try {
      const before = await t.middle()
      t.db.exec(
        "CREATE TRIGGER fail_edits BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'Test publication failure'); END",
      )
      await expect(t.act(action, before.revision)).rejects.toThrow('Test publication failure')
      expect(await t.library.getEditHistory(id)).toEqual(before)
      expect(t.persisted()).toEqual(before)
      expect(t.events).toEqual([])
      expect(t.invalidations).toEqual([])
      t.db.exec('DROP TRIGGER fail_edits')
      await t.act(action, before.revision)
      const after = await t.library.getEditHistory(id)
      expectHistoryAction(before, after, action)
      expect(t.persisted()).toEqual(after)
      expect(t.events).toEqual([before.revision + 1])
      expect(t.invalidations).toEqual([id])
    } finally {
      await t.close()
    }
  })

test('current no-ops preserve redo and publish nothing while stale no-ops conflict', async () => {
  const t = await historyFixture()
  try {
    const before = await t.middle()
    const unchanged = await t.library.updateEdits(
      id,
      { exposureEv: before.settings.exposureEv, contrast: before.settings.contrast },
      before.revision,
    )
    expect(unchanged).toMatchObject({ revision: before.revision, canRedo: true })
    expect(await t.library.getEditHistory(id)).toEqual(before)
    expect(t.persisted()).toEqual(before)
    expect(t.events).toEqual([])
    expect(t.invalidations).toEqual([])
    await t.act('update', before.revision)
    const after = await t.library.getEditHistory(id)
    await expect(t.library.updateEdits(id, combinedPatch, before.revision)).rejects.toThrow(
      'Edit conflict',
    )
    await t.library.updateEdits(id, combinedPatch, after.revision)
    expect(await t.library.getEditHistory(id)).toEqual(after)
    expect(t.persisted()).toEqual(after)
    expect(t.events).toEqual([before.revision + 1])
    expect(t.invalidations).toEqual([id])
  } finally {
    await t.close()
  }
})

test('an edit queued during Trash rejects a removed photo without recreating its history', async () => {
  let entered!: () => void, finishTrash!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    finishTrash = resolve
  })
  const t = await historyFixture(async () => {
    entered()
    await gate
  })
  try {
    const before = await t.middle()
    const deletion = t.library.deletePhotos([id])!
    await started
    const pending = t.act('update', before.revision)
    const rejected = expect(pending).rejects.toThrow('unavailable')
    await expect.poll(() => t.library.scheduler.interactivePending).toBe(true)
    finishTrash()
    await rejected
    await expect
      .poll(() => t.library.listTasks().find((task) => task.id === deletion)?.status)
      .toBe('completed')
    expect(t.db.prepare('SELECT COUNT(*) AS count FROM edits WHERE id = ?').get(id)).toEqual({
      count: 0,
    })
    expect(t.events).toEqual([])
    expect(t.invalidations).toEqual([])
  } finally {
    finishTrash()
    await t.close()
  }
})
