import { expect, test } from '@playwright/test'
import { DEFAULT_WORKSPACE } from '../src/shared/workspace'
import { stackFixture, finishTask } from './stack.helpers'

test('migration 16 is transactional, idempotent, and workspace commits do not advance catalog or stack browsing revisions', async () => {
  const t = await stackFixture(3)
  try {
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 16 })
    const before = t.library.getGallerySummary()
    expect(t.library.getWorkspaceState()).toMatchObject({
      checkpoint: 0,
      state: null,
      selected: [],
    })
    t.library.saveWorkspaceState({
      state: { ...DEFAULT_WORKSPACE, activeId: t.photos[0].id, consoleOpen: true },
      selection: { added: [t.photos[0].id], removed: [] },
    })
    const saved = t.library.getWorkspaceState()
    expect(saved).toMatchObject({
      checkpoint: 1,
      state: { activeId: t.photos[0].id, consoleOpen: true },
      selected: [{ id: t.photos[0].id }],
    })
    expect(t.library.getGallerySummary()).toEqual(before)
    await t.restart()
    expect(t.library.getWorkspaceState()).toEqual(saved)
    const revision = t.library.getGallerySummary()
    await t.restart()
    expect(t.library.getWorkspaceState()).toEqual(saved)
    expect(t.library.getGallerySummary()).toEqual(revision)
    await t.library.close()
    t.db.exec(
      'DROP TRIGGER remove_workspace_selection; DROP TABLE workspace_selection; DROP TABLE workspace_state; DROP TABLE collection_catalog_state; CREATE TABLE collection_catalog_state(singleton TEXT); PRAGMA user_version = 15;',
    )
    await expect(t.restart()).rejects.toThrow()
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 15 })
    expect(
      t.db.prepare("SELECT name FROM sqlite_master WHERE name='workspace_state'").get(),
    ).toBeUndefined()
    t.db.exec('DROP TABLE collection_catalog_state')
    await t.restart()
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 16 })
  } finally {
    await t.close()
  }
})
test('large selection deltas preserve normalized rows during scalar-only scrolling and rollback failed transactions', async () => {
  const t = await stackFixture(2400)
  try {
    const ids = t.photos.map((p) => p.id)
    t.library.saveWorkspaceState({
      selection: { added: ids, removed: [] },
      state: DEFAULT_WORKSPACE,
    })
    const rows = t.db.prepare('SELECT rowid, photo_id FROM workspace_selection').all()
    t.library.saveWorkspaceState({
      state: { editorAnchor: { id: ids[1000], index: 1000, inset: 17 } },
    })
    expect(t.db.prepare('SELECT rowid, photo_id FROM workspace_selection').all()).toEqual(rows)
    t.library.saveWorkspaceState({ selection: { removed: [ids[2]], added: [] } })
    expect(t.library.getWorkspaceState().selected).toHaveLength(2399)
    const before = t.library.getWorkspaceState()
    expect(() =>
      t.library.saveWorkspaceState({
        state: { consoleOpen: 'invalid' as unknown as boolean },
        selection: { removed: ids, added: [] },
      }),
    ).toThrow('Invalid workspace state')
    expect(t.library.getWorkspaceState()).toEqual(before)
    expect(() =>
      t.library.saveWorkspaceState({ selection: { removed: [], added: ['/tmp/photo'] } }),
    ).toThrow('Invalid workspace selection')
    // An explicitly empty selection is a completed checkpoint, not a startup default.
    t.library.saveWorkspaceState({ selection: { removed: ids, added: [] } })
    await t.restart()
    expect(t.library.getWorkspaceState().selected).toEqual([])
    expect(t.library.getWorkspaceState().state).not.toBeNull()
  } finally {
    await t.close()
  }
})
test('deleted references are pruned and removed list anchors recover through a cover or surviving neighbor without resuming tasks', async () => {
  const t = await stackFixture(6)
  try {
    const ids = t.photos.map((p) => p.id)
    t.library.saveWorkspaceState({
      state: {
        ...DEFAULT_WORKSPACE,
        mode: 'library',
        activeId: ids[1],
        editorFocusId: ids[1],
        libraryFocusId: ids[1],
        rangeAnchorId: ids[1],
        editorAnchor: { id: ids[1], index: 1, inset: 12, coverId: ids[0] },
        libraryAnchor: { id: ids[1], index: 1, inset: 20, afterId: ids[2] },
        preview: { photoId: ids[1], fit: false, scale: 2, centerX: 0.6, centerY: 0.4 },
      },
      selection: { added: [ids[1], ids[3]], removed: [] },
    })
    const task = t.library.deletePhotos([ids[1]])!
    expect((await finishTask(t.library, task)).status).toBe('completed')
    await t.restart()
    const snapshot = t.library.getWorkspaceState()
    expect(snapshot.state).toMatchObject({
      mode: 'library',
      activeId: null,
      editorFocusId: null,
      libraryFocusId: null,
      rangeAnchorId: null,
      preview: null,
      editorAnchor: { id: ids[0], inset: 12 },
      libraryAnchor: { id: ids[2], inset: 20 },
    })
    expect(snapshot.selected.map((p) => p.id)).toEqual([ids[3]])
    expect(t.library.listTasks()).toEqual([])
  } finally {
    await t.close()
  }
})
