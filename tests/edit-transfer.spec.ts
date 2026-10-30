import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToWork } from 'node:timers/promises'
import { CAPTURE_METADATA_VERSION } from '../src/shared/capture-sequence'
import { copiedEdits, defaultEditTransferGroups, transferPatch } from '../src/shared/edit-transfer'
import { mergeEditPatch, type EditHistory } from '../src/shared/edits'
import { processingMetadata } from '../src/main/processing/metadata'
import type { BackgroundTask } from '../src/shared/contracts'
import { transferFixture } from './edit-transfer.helpers'

test('frozen copied groups share one history step, Undo/Redo, immutable source snapshots and retained restart results', async () => {
  const t = await transferFixture()
  try {
    await t.library.updateEdits(
      t.ids[0],
      {
        exposureEv: 1.5,
        saturation: 25,
        noiseReduction: { luminance: 30 },
        detailSharpening: { amount: 20 },
      },
      0,
    )
    const clipboard = await t.library.copyEdits(t.ids[0])
    const preparation = await t.library.preparePasteEdits({
      clipboardId: clipboard.id,
      photoIds: t.ids.slice(1),
      groups: defaultEditTransferGroups,
    })
    preparation.targets.reverse()
    preparation.groups.length = 0
    await t.library.updateEdits(t.ids[0], { exposureEv: -2 }, 1)
    const id = await t.library.startPasteEdits(preparation.id),
      task = await t.finished(id)
    expect(task.editApplication).toEqual({
      applied: 3,
      unchanged: 0,
      conflict: 0,
      unavailable: 0,
      failed: 0,
    })
    expect(
      t.library.editTransfers.store.results(id).results.map((result) => result.photoId),
    ).toEqual(t.ids.slice(1))
    for (const photoId of t.ids.slice(1)) {
      const history = await t.library.getEditHistory(photoId)
      expect(history.snapshots).toHaveLength(2)
      expect(history.settings).toMatchObject({
        exposureEv: 1.5,
        saturation: 25,
        noiseReduction: { luminance: 30 },
        detailSharpening: { amount: 20 },
      })
      expect((await t.library.undoEdit(photoId, 1)).settings.exposureEv).toBe(0)
      expect((await t.library.redoEdit(photoId, 2)).settings.exposureEv).toBe(1.5)
    }
    const results = t.library.editTransfers.store.results(id)
    await t.restart()
    expect(t.library.getEditClipboard()).toBeNull()
    expect(t.library.editTransfers.store.results(id)).toEqual(results)
    expect((await t.library.getEdits(t.ids[1])).revision).toBe(3)
    await t.originalsUnchanged()
    await t.library.dismissTask(id)
    expect(t.library.editTransfers.has(id)).toBe(false)
  } finally {
    await t.close()
  }
})

test('batch preserves the complete frozen selection and reports conflicts, missing photos and unchanged settings individually', async () => {
  const t = await transferFixture()
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
    const clipboard = await t.library.copyEdits(t.ids[0]),
      missing = 'f'.repeat(64)
    const prepared = await t.library.preparePasteEdits({
      clipboardId: clipboard.id,
      photoIds: [t.ids[1], missing, t.ids[0], t.ids[2]],
      groups: ['light'],
    })
    expect(prepared.targets[1].unavailable).toBeTruthy()
    await t.library.updateEdits(t.ids[1], { contrast: 20 }, 0)
    const id = await t.library.startPasteEdits(prepared.id),
      task = await t.finished(id)
    expect(
      t.library.editTransfers.store.results(id).results.map((result) => result.outcome),
    ).toEqual(['conflict', 'unavailable', 'unchanged', 'applied'])
    expect(task).toMatchObject({
      status: 'completed',
      progress: { completed: 4, total: 4 },
      errorCount: 2,
    })
    expect((await t.library.getEdits(t.ids[1])).settings).toMatchObject({
      exposureEv: 0,
      contrast: 20,
    })
    expect((await t.library.getEditHistory(t.ids[0])).snapshots).toHaveLength(2)
    expect(t.library.taskErrors(id).total).toBe(2)
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('cancellation drains an admitted photo, yields to interactive work and leaves later destinations unchanged', async () => {
  const t = await transferFixture(),
    release = gate(),
    entered = gate()
  let interactive: Promise<void> | undefined
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 2 }, 0)
    const clipboard = await t.library.copyEdits(t.ids[0]),
      prepared = await t.library.preparePasteEdits({
        clipboardId: clipboard.id,
        photoIds: t.ids.slice(1),
        groups: ['light'],
      })
    t.listen((event) => {
      if (event.editsChanged?.photoId === t.ids[1])
        interactive = t.library.scheduler.detached(() =>
          t.library.scheduler.run('interactive', async () => {
            entered.resolve()
            await release.promise
          }),
        )
    })
    const id = await t.library.startPasteEdits(prepared.id)
    await entered.promise
    await t.library.cancelTask(id)
    expect(t.library.listTasks().find((task) => task.id === id)).toMatchObject({
      status: 'cancelled',
      progress: { completed: 1, total: 3 },
      unprocessed: 2,
    })
    expect(
      t.library.editTransfers.store.results(id).results.map((result) => result.outcome),
    ).toEqual(['applied', 'cancelled', 'cancelled'])
    expect((await t.library.getEdits(t.ids[2])).revision).toBe(0)
    await t.originalsUnchanged()
  } finally {
    release.resolve()
    await interactive
    await t.close()
  }
})

async function accepted(t: Awaited<ReturnType<typeof transferFixture>>) {
  await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
  const state = await t.library.getEdits(t.ids[0]),
    clipboard = await t.library.copyEdits(t.ids[0]),
    id = randomUUID()
  const source = copiedEdits(clipboard, state.settings, processingMetadata({}, []))
  const targets = await Promise.all(
    t.ids.slice(1).map(async (photoId, index) => ({
      photoId,
      filename: `Photo-${index + 1}.png`,
      revision: (await t.library.getEdits(photoId)).revision,
    })),
  )
  const task: BackgroundTask = {
    id,
    kind: 'edit-application',
    title: 'Applying copied edits',
    status: 'running',
    errorCount: 0,
    progress: { completed: 0, total: targets.length, unit: 'items' },
    editApplication: { applied: 0, unchanged: 0, conflict: 0, unavailable: 0, failed: 0 },
  }
  await t.library.editTransfers.store.accept(
    { version: 1, id, source, groups: ['light'], targets },
    task,
  )
  return { id, source, task }
}
function changed(history: EditHistory, exposureEv: number) {
  history.settings = mergeEditPatch(history.settings, { exposureEv })
  history.snapshots = [
    ...history.snapshots.slice(0, history.cursor + 1),
    { settings: history.settings, createdAt: '2026-10-29T00:00:01.000Z' },
  ]
  history.cursor++
  return history
}

test('catalog atomically rejects a mismatched application and commits its history, result and counts exactly once', async () => {
  const t = await transferFixture(3)
  try {
    const job = await accepted(t),
      before = await t.library.getEditHistory(t.ids[1]),
      commit = { id: job.id, ordinal: 0 }
    await expect(
      t.library.editTransfers.store.result(
        { id: job.id, ordinal: 1 },
        { outcome: 'failed', message: 'Out of order' },
      ),
    ).rejects.toThrow('no longer pending')
    await expect(
      t.library.catalogCommands.command({
        operation: 'edits.commit',
        payload: {
          history: changed(structuredClone(before), 2),
          expectedRevision: 0,
          application: commit,
        },
      }),
    ).rejects.toThrow('settings conflict')
    expect(await t.library.getEditHistory(t.ids[1])).toEqual(before)
    expect(t.library.editTransfers.store.results(job.id).results[0].outcome).toBe('pending')
    const patch = transferPatch(job.source, ['light'])
    const history = changed(structuredClone(before), patch.exposureEv!)
    await t.library.catalogCommands.command({
      operation: 'edits.commit',
      payload: { history, expectedRevision: 0, application: commit },
    })
    expect(t.library.editTransfers.store.job(job.id).task).toMatchObject({
      progress: { completed: 1 },
      editApplication: { applied: 1 },
    })
    const after = await t.library.getEditHistory(t.ids[1])
    await expect(
      t.library.catalogCommands.command({
        operation: 'edits.commit',
        payload: {
          history: changed(structuredClone(after), 1),
          expectedRevision: 1,
          application: commit,
        },
      }),
    ).rejects.toThrow('no longer pending')
    expect(await t.library.getEditHistory(t.ids[1])).toEqual(after)
    await t.restart()
    expect(t.library.listTasks().find((task) => task.id === job.id)).toMatchObject({
      status: 'failed',
      phase: 'Interrupted',
      unprocessed: 1,
    })
    expect(t.library.editTransfers.store.results(job.id).results.map((r) => r.outcome)).toEqual([
      'applied',
      'interrupted',
    ])
    expect(await t.library.getEditHistory(t.ids[1])).toEqual(after)
    expect((await t.library.getEdits(t.ids[2])).revision).toBe(0)
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})

test('large metadata-only selections retain frozen order and bounded continuous result chunks', async () => {
  const t = await transferFixture(66)
  try {
    await t.library.updateEdits(t.ids[0], { saturation: 20 }, 0)
    const copy = await t.library.copyEdits(t.ids[0]),
      ids = [...t.ids].reverse()
    const p = await t.library.preparePasteEdits({
      clipboardId: copy.id,
      photoIds: ids,
      groups: ['color'],
    })
    const id = await t.library.startPasteEdits(p.id)
    await t.finished(id)
    const first = t.library.editTransfers.store.results(id),
      rest = t.library.editTransfers.store.results(id, first.results.length)
    expect(first.total).toBe(66)
    expect(first.results.length).toBeLessThan(66)
    expect([...first.results, ...rest.results].map((r) => r.photoId)).toEqual(ids)
    expect(t.library.editTransfers.store.results(id, 66).results).toEqual([])
    expect(
      t.library.editTransfers.store.results(id).results.every((r) => r.outcome === 'applied'),
    ).toBe(true)
    expect(rest.results.at(-1)?.outcome).toBe('unchanged')
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})

test('finishing capture grouping preserves the copied settings and subsequent paste admission', async () => {
  const t = await transferFixture(2)
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
    const copy = await t.library.copyEdits(t.ids[0])
    for (const photoId of t.ids)
      await t.library.catalogCommands.command({
        operation: 'capture.publish',
        payload: { photoId, metadata: { version: CAPTURE_METADATA_VERSION, format: 'PNG' } },
      })
    const grouping = t.library.groupCaptureSequences()
    expect((await t.finished(grouping)).status).toBe('completed')
    expect(t.library.getEditClipboard()).toEqual(copy)
    const preparation = await t.library.preparePasteEdits({
      clipboardId: copy.id,
      photoIds: [t.ids[1]],
      groups: ['light'],
    })
    const id = await t.library.startPasteEdits(preparation.id)
    expect((await t.finished(id)).editApplication?.applied).toBe(1)
  } finally {
    await t.close()
  }
})

test('shutdown waits for an admitted edit application to durably finish before closing processors and the catalog', async () => {
  const t = await transferFixture(2),
    entered = gate(),
    release = gate()
  const store = t.library.editTransfers.store,
    saveTask = store.task.bind(store)
  let finalized = false
  store.task = async (task) => {
    if (['completed', 'cancelled'].includes(task.status)) {
      entered.resolve()
      await release.promise
    }
    await saveTask(task)
    finalized = true
  }
  const processor = (t.library as unknown as { metadataProcessor: { close(): Promise<void> } })
    .metadataProcessor
  const closeProcessor = processor.close.bind(processor)
  processor.close = async () => {
    expect(finalized, 'edit application must drain before processor shutdown').toBe(true)
    await closeProcessor()
  }
  let closing: Promise<void> | undefined
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
    const copy = await t.library.copyEdits(t.ids[0]),
      preparation = await t.library.preparePasteEdits({
        clipboardId: copy.id,
        photoIds: [t.ids[1]],
        groups: ['light'],
      })
    const id = await t.library.startPasteEdits(preparation.id)
    await entered.promise
    closing = t.library.close()
    void closing.catch(() => {})
    await yieldToWork()
    expect(finalized).toBe(false)
    release.resolve()
    await closing
    await t.restart()
    expect(t.library.listTasks().find((task) => task.id === id)?.status).toBe('completed')
    expect(t.library.editTransfers.store.results(id).results[0].outcome).toBe('applied')
    await t.originalsUnchanged()
  } finally {
    release.resolve()
    await closing
    await t.close()
  }
})

test('cancelling a durably accepted job before its acceptance acknowledgement prevents every destination edit', async () => {
  const t = await transferFixture(2),
    visible = gate(),
    release = gate()
  const store = t.library.editTransfers.store,
    accept = store.accept.bind(store)
  let taskId = '',
    start: Promise<string> | undefined,
    cancellation: Promise<void> | undefined
  store.accept = async (manifest, task) => {
    await accept(manifest, task)
    taskId = task.id
    visible.resolve()
    await release.promise
  }
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
    const copy = await t.library.copyEdits(t.ids[0]),
      prepared = await t.library.preparePasteEdits({
        clipboardId: copy.id,
        photoIds: [t.ids[1]],
        groups: ['light'],
      })
    start = t.library.startPasteEdits(prepared.id)
    await visible.promise
    expect(t.library.editTransfers.has(taskId)).toBe(true)
    cancellation = t.library.cancelTask(taskId)
    await yieldToWork()
    expect(t.library.listTasks().find((task) => task.id === taskId)?.status).toBe('cancelling')
    release.resolve()
    await cancellation
    expect(await start).toBe(taskId)
    expect((await t.finished(taskId)).status).toBe('cancelled')
    expect((await t.library.getEdits(t.ids[1])).revision).toBe(0)
    expect(t.library.editTransfers.store.results(taskId).results[0].outcome).toBe('cancelled')
    await t.originalsUnchanged()
  } finally {
    release.resolve()
    await start
    await cancellation
    await t.close()
  }
})

test('a slower earlier copy cannot replace the source chosen by a newer copy request', async () => {
  const t = await transferFixture(2),
    waiting = gate(),
    release = gate()
  let earlier: ReturnType<typeof t.library.copyEdits> | undefined
  try {
    t.library.flushEditorEdits = async (scope) => {
      if (scope.kind === 'photos' && scope.photoIds.includes(t.ids[0])) {
        waiting.resolve()
        await release.promise
      }
    }
    earlier = t.library.copyEdits(t.ids[0])
    await waiting.promise
    const latest = await t.library.copyEdits(t.ids[1])
    release.resolve()
    await expect(earlier).rejects.toThrow('newer copy request')
    expect(t.library.getEditClipboard()).toEqual(latest)
    expect(latest.photoId).toBe(t.ids[1])
  } finally {
    release.resolve()
    await earlier?.catch(() => {})
    await t.close()
  }
})

test('lost acceptance acknowledgement exposes interrupted work and requires restart instead of applying or duplicating edits', async () => {
  const t = await transferFixture(2),
    store = t.library.editTransfers.store,
    accept = store.accept.bind(store)
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
    const copy = await t.library.copyEdits(t.ids[0]),
      prepared = await t.library.preparePasteEdits({
        clipboardId: copy.id,
        photoIds: [t.ids[1]],
        groups: ['light'],
      })
    store.accept = async (manifest, task) => {
      await accept(manifest, task)
      throw new Error('Acceptance acknowledgement lost.')
    }
    await expect(t.library.startPasteEdits(prepared.id)).rejects.toThrow('acknowledgement lost')
    const task = t.library.listTasks().find((task) => task.kind === 'edit-application')!
    expect(task).toMatchObject({ status: 'failed', phase: 'Interrupted' })
    expect(task.detail).toContain('Restart Irodori')
    expect((await t.library.getEdits(t.ids[1])).revision).toBe(0)
    await expect(t.library.startPasteEdits(prepared.id)).rejects.toThrow('Restart Irodori')
    await t.restart()
    expect(t.library.listTasks().find((entry) => entry.id === task.id)).toMatchObject({
      status: 'failed',
      unprocessed: 1,
    })
    expect(t.library.editTransfers.store.results(task.id).results[0].outcome).toBe('interrupted')
    expect((await t.library.getEdits(t.ids[1])).revision).toBe(0)
    await t.library.dismissTask(task.id)
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})
