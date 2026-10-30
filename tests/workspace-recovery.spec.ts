import { expect, test } from '@playwright/test'
import {
  DEFAULT_INSPECTOR_SECTIONS,
  DEFAULT_WORKSPACE,
  type WorkspaceState,
} from '../src/shared/workspace'
import { stackFixture, finishTask } from './stack.helpers'

test('current workspace checkpoints persist idempotently without advancing catalog or stack browsing revisions', async () => {
  const t = await stackFixture(3)
  try {
    expect(t.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 21 })
    const before = t.library.getGallerySummary()
    expect(t.library.getWorkspaceState()).toMatchObject({
      checkpoint: 0,
      state: null,
      selected: [],
    })
    await t.library.saveWorkspaceState({
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
  } finally {
    await t.close()
  }
})
test('large selection deltas preserve normalized rows during scalar-only scrolling and rollback failed transactions', async () => {
  const t = await stackFixture(2400)
  try {
    const ids = t.photos.map((p) => p.id)
    await t.library.saveWorkspaceState({
      selection: { added: ids, removed: [] },
      state: DEFAULT_WORKSPACE,
    })
    const rows = t.db.prepare('SELECT rowid, photo_id FROM workspace_selection').all()
    await t.library.saveWorkspaceState({
      state: { editorAnchor: { id: ids[1000], index: 1000, inset: 17 } },
    })
    expect(t.db.prepare('SELECT rowid, photo_id FROM workspace_selection').all()).toEqual(rows)
    await t.library.saveWorkspaceState({ selection: { removed: [ids[2]], added: [] } })
    expect(t.library.getWorkspaceState().selected).toHaveLength(2399)
    const before = t.library.getWorkspaceState()
    await expect(
      t.library.saveWorkspaceState({
        state: { consoleOpen: 'invalid' as unknown as boolean },
        selection: { removed: ids, added: [] },
      }),
    ).rejects.toThrow('Invalid workspace state')
    expect(t.library.getWorkspaceState()).toEqual(before)
    await expect(
      t.library.saveWorkspaceState({ selection: { removed: [], added: ['/tmp/photo'] } }),
    ).rejects.toThrow('Invalid workspace selection')
    // An explicitly empty selection is a completed checkpoint, not a startup default.
    await t.library.saveWorkspaceState({ selection: { removed: ids, added: [] } })
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
    await t.library.saveWorkspaceState({
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

test('legacy workspace disclosures default safely and new checkpoints validate and preserve inspector state independently of photo edits', async () => {
  const t = await stackFixture(2)
  try {
    const legacy: Partial<WorkspaceState> = { ...DEFAULT_WORKSPACE, activeId: t.photos[0].id }
    delete legacy.inspector
    delete legacy.creativeColor
    t.db.prepare('INSERT INTO workspace_state VALUES (1, 8, ?)').run(JSON.stringify(legacy))
    expect(t.library.getWorkspaceState().state?.inspector).toEqual(DEFAULT_INSPECTOR_SECTIONS)
    const before = t.library.getGallerySummary()
    // Earlier inspector checkpoints have no Crop disclosure; add its default on read/save.
    const earlier = {
      ...DEFAULT_WORKSPACE,
      inspector: { histogram: false, light: true, color: true, lens: false, metadata: true },
    }
    t.db
      .prepare('UPDATE workspace_state SET data = ? WHERE singleton = 1')
      .run(JSON.stringify(earlier))
    expect(t.library.getWorkspaceState().state?.inspector).toEqual({
      ...DEFAULT_INSPECTOR_SECTIONS,
      histogram: false,
    })
    await t.library.saveWorkspaceState({ state: { consoleOpen: false } })
    expect(t.library.getWorkspaceState().state?.inspector).toEqual({
      ...DEFAULT_INSPECTOR_SECTIONS,
      histogram: false,
    })
    t.db
      .prepare('UPDATE workspace_state SET data = ? WHERE singleton = 1')
      .run(JSON.stringify(legacy))
    const sections = {
      ...DEFAULT_INSPECTOR_SECTIONS,
      histogram: false,
      light: false,
      color: true,
      crop: false,
      lens: true,
      metadata: false,
    }
    await t.library.saveWorkspaceState({ state: { consoleOpen: true } })
    expect(t.library.getWorkspaceState().state?.inspector).toEqual(DEFAULT_INSPECTOR_SECTIONS)
    await t.library.saveWorkspaceState({ state: { inspector: sections } })
    await t.library.saveWorkspaceState({
      state: { creativeColor: { range: 'aqua', tone: 'highlights' } },
    })
    expect(t.library.getGallerySummary()).toEqual(before)
    const saved = t.library.getWorkspaceState()
    await t.restart()
    expect(t.library.getWorkspaceState()).toEqual(saved)
    expect(saved.state?.inspector).toEqual(sections)
    expect(saved.state?.creativeColor).toEqual({ range: 'aqua', tone: 'highlights' })
    for (const invalid of [
      null,
      [],
      {},
      { range: 'cyan', tone: 'shadows' },
      { range: 'red', tone: 'global' },
      { range: 'red', tone: 'shadows', unknown: true },
    ]) {
      await expect(
        t.library.saveWorkspaceState({
          state: { creativeColor: invalid as WorkspaceState['creativeColor'] },
        }),
      ).rejects.toThrow('Invalid workspace state')
      expect(t.library.getWorkspaceState()).toEqual(saved)
    }
    for (const invalid of [
      null,
      [],
      {},
      { ...sections, color: 1 },
      { ...sections, unknown: true },
    ]) {
      await expect(
        t.library.saveWorkspaceState({
          state: { inspector: invalid as unknown as WorkspaceState['inspector'] },
          selection: { added: [t.photos[1].id], removed: [] },
        }),
      ).rejects.toThrow('Invalid workspace state')
      expect(t.library.getWorkspaceState()).toEqual(saved)
    }
  } finally {
    await t.close()
  }
})
