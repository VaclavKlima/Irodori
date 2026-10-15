import { expect, test } from '@playwright/test'
import { readFile, readdir, rename, writeFile, lstat, mkdir, link } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { ExportProcess } from '../src/main/export/process'
import { ExportJobs, type ExportBoundary } from '../src/main/export/jobs'
import { ExportStore } from '../src/main/export/store'
import { identity } from '../src/main/export/files'
import { defaultExportOptions } from '../src/shared/export'
import type { ExportRenderJob } from '../src/main/export/types'
import { neutralAdjustments } from '../src/shared/adjustments'
import { exportFixture, sha } from './export.helpers'
import { finishTask } from './stack.helpers'

async function controlled(
  t: Awaited<ReturnType<typeof exportFixture>>,
  render: (job: ExportRenderJob, signal: AbortSignal) => Promise<{ path: string; sha256: string }>,
  boundary?: (b: ExportBoundary) => Promise<void>,
) {
  t.library.exports = new ExportJobs(
    new ExportStore(t.db),
    join(t.root, 'library'),
    t.library.scheduler,
    async (id) => {
      const photo = t.photos.find((p) => p.id === id)!
      const edits = await t.library.getEdits(id)
      const row = t.db.prepare('SELECT data FROM processing WHERE id = ?').get(id) as {
        data: string
      }
      const path = join(t.root, 'library', 'originals', id, 'original.png')
      return {
        photo,
        path,
        identity: identity(await lstat(path)),
        hdr: false,
        processing: {
          ...JSON.parse(row.data),
          revision: edits.revision,
          adjustments: { ...neutralAdjustments, ...edits.settings },
        },
      }
    },
    (s) => {
      const row = t.db.prepare('SELECT data FROM edits WHERE id = ?').get(s.photo.id) as
        { data: string } | undefined
      return !!row && JSON.parse(row.data).revision === s.processing.revision
    },
    () => {},
    { render },
    boundary,
  )
}
async function fakeRender(job: ExportRenderJob) {
  const path = join(job.directory, 'output.jpg'),
    bytes = Buffer.from(`jpeg-${job.source.processing.adjustments?.exposureEv}`)
  await writeFile(path, bytes)
  return { path, sha256: sha(bytes) }
}
const wait = async (t: Awaited<ReturnType<typeof exportFixture>>, id: string) => {
  await expect
    .poll(() => t.library.listTasks().find((j) => j.id === id)?.finishedAt, { timeout: 20000 })
    .toBeTruthy()
  return t.library.listTasks().find((j) => j.id === id)!
}

test('acceptance freezes committed edits, saves Custom atomically and preserves history and browsing revisions', async () => {
  const t = await exportFixture()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  try {
    await controlled(t, async (job, signal) => {
      await Promise.race([
        gate,
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        }),
      ])
      return fakeRender(job)
    })
    const grant = await t.library.exports.store.authorize(t.destination)
    const before = await t.library.getEditHistory(t.photos[0].id)
    const revision = t.db.prepare('SELECT revision FROM browse_state').get()
    let prepared = await t.library.prepareExport([t.photos[0].id])
    await t.library.updateEdits(t.photos[0].id, { exposureEv: 1 }, 0)
    await expect(
      t.library.startExport({
        preparationId: prepared.id,
        destinationId: grant.id,
        action: 'high',
      }),
    ).rejects.toThrow('edits changed')
    expect((await t.library.getExportPreferences()).lastCustom).toBeNull()
    prepared = await t.library.prepareExport([t.photos[0].id])
    const options = { ...defaultExportOptions, quality: 81 }
    const id = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'custom',
      options,
    })
    expect((await t.library.getExportPreferences()).lastCustom?.quality).toBe(81)
    expect(() => t.library.deletePhotos([t.photos[0].id])).toThrow('export')
    expect(
      t.library.getPhotoActionsContext(t.photos[0].id, [t.photos[0].id]).availability[
        'selection-trash'
      ],
    ).toMatchObject({ kind: 'blocked' })
    // Organization and editing remain available while the source is leased.
    t.library.groupPhotos(
      t.photos.map((p) => p.id),
      t.photos[0].id,
      t.library.listStacks().revision,
    )
    await t.library.updateEdits(t.photos[0].id, { exposureEv: 2 }, 1)
    release()
    expect((await wait(t, id)).export).toMatchObject({ exported: 1, failed: 0 })
    expect(await readFile(join(t.destination, 'Photo-0.jpg'), 'utf8')).toBe('jpeg-1')
    expect(t.library.exports.leased([t.photos[0].id])).toBe(false)
    const after = await t.library.getEditHistory(t.photos[0].id)
    expect(after.snapshots.length).toBe(before.snapshots.length + 2)
    expect(t.db.prepare('SELECT revision FROM browse_state').get()).toEqual(revision)
    const next = await t.library.prepareExport([t.photos[0].id])
    const quick = await t.library.startExport({
      preparationId: next.id,
      destinationId: grant.id,
      action: 'smaller',
    })
    await wait(t, quick)
    expect((await t.library.getExportPreferences()).lastCustom?.quality).toBe(81)
    expect(await readFile(join(t.destination, 'Photo-0 (2).jpg'), 'utf8')).toBe('jpeg-2')
  } finally {
    release?.()
    await t.close()
  }
})

test('complete 125-photo selections retain frozen order, deduplicate targets and cancel without deleting completed output', async () => {
  const t = await exportFixture(125)
  let second = false
  try {
    await controlled(t, async (job, signal) => {
      if (second)
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      second = true
      return fakeRender(job)
    })
    const grant = await t.library.exports.store.authorize(t.destination)
    const ids = t.photos.map((p) => p.id).reverse()
    const prepared = await t.library.prepareExport([...ids, ids[0]])
    expect(prepared.targets.map((p) => p.photoId)).toEqual(ids)
    const id = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'custom',
      options: { ...defaultExportOptions, names: { mode: 'sequence', prefix: 'Batch-' } },
    })
    await expect
      .poll(async () => (await readdir(t.destination)).includes('Batch-0001.jpg'))
      .toBe(true)
    await t.library.cancelTask(id)
    const task = await wait(t, id)
    expect(task.progress).toMatchObject({ completed: 125, total: 125 })
    expect(task.export).toMatchObject({ exported: 1, cancelled: 124, failed: 0 })
    const first = t.library.exports.results(id)
    const middle = t.library.exports.results(id, 60)
    const last = t.library.exports.results(id, 120)
    expect(first.total).toBe(125)
    expect([...first.results, ...middle.results, ...last.results].map((f) => f.photoId)).toEqual(
      ids,
    )
    expect(await readdir(t.destination)).toEqual(['Batch-0001.jpg'])
    expect(t.library.exports.leased(ids)).toBe(false)
  } finally {
    await t.close()
  }
})

test('destination grants persist, reject a replaced directory and never redirect; explicit HDR is counted', async () => {
  const t = await exportFixture()
  try {
    await controlled(t, fakeRender)
    const grant = await t.library.exports.store.authorize(t.destination)
    const prepared = await t.library.prepareExport(t.photos.map((p) => p.id))
    await expect(
      t.library.startExport({
        preparationId: prepared.id,
        destinationId: grant.id,
        action: 'custom',
        options: { ...defaultExportOptions, output: 'hdr' },
      }),
    ).rejects.toThrow('2 photos do not support')
    await rename(t.destination, `${t.destination}-moved`)
    await mkdir(t.destination)
    await expect(
      t.library.startExport({
        preparationId: prepared.id,
        destinationId: grant.id,
        action: 'high',
      }),
    ).rejects.toThrow('Choose another folder')
    expect((await t.library.getExportPreferences()).destination).toMatchObject({
      id: grant.id,
      available: false,
    })
    expect((await t.library.getExportPreferences()).lastCustom).toBeNull()
    await expect(
      t.library.startExport({
        preparationId: prepared.id,
        destinationId: '/arbitrary/path',
        action: 'high',
      }),
    ).rejects.toThrow('authorized')
    expect(await readdir(t.destination)).toEqual([])
  } finally {
    await t.close()
  }
})

test('collisions skip or rename exclusively and encoder failures retain results without leaked partials', async () => {
  const t = await exportFixture()
  try {
    await controlled(t, fakeRender)
    const grant = await t.library.exports.store.authorize(t.destination)
    await writeFile(join(t.destination, 'Photo-0.jpg'), 'existing')
    let prepared = await t.library.prepareExport(t.photos.map((p) => p.id))
    const id = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'custom',
      options: { ...defaultExportOptions, existing: 'skip' },
    })
    expect((await wait(t, id)).export).toMatchObject({ exported: 1, skipped: 1 })
    expect(await readFile(join(t.destination, 'Photo-0.jpg'), 'utf8')).toBe('existing')
    await t.library.exports.close()
    await controlled(t, async () => {
      throw new Error('Encoder allocation failed.')
    })
    prepared = await t.library.prepareExport([t.photos[0].id])
    const failed = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'high',
    })
    expect((await wait(t, failed)).status).toBe('failed')
    expect(t.library.taskErrors(failed).errors[0].message).toContain('allocation')
    expect((await readdir(t.destination)).some((f) => f.endsWith('.partial'))).toBe(false)
  } finally {
    await t.close()
  }
})

test('cancellation waits for exclusive publication already in progress', async () => {
  const t = await exportFixture()
  let reached!: () => void, release!: () => void
  const atPublication = new Promise<void>((r) => {
      reached = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  try {
    await controlled(t, fakeRender, async (b) => {
      if (b === 'published') {
        reached()
        await gate
      }
    })
    const grant = await t.library.exports.store.authorize(t.destination)
    const prepared = await t.library.prepareExport(t.photos.map((p) => p.id))
    const id = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'high',
    })
    await atPublication
    let cancelled = false
    const cancellation = t.library.cancelTask(id).then(() => {
      cancelled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(cancelled).toBe(false)
    release()
    await cancellation
    expect((await wait(t, id)).export).toMatchObject({ exported: 1, cancelled: 1 })
    expect(await readdir(t.destination)).toEqual(['Photo-0.jpg'])
  } finally {
    release?.()
    await t.close()
  }
})

test('restart reconciles a linked publication by inode and hash, cleans only owned partials and never resumes', async () => {
  const t = await exportFixture()
  try {
    await controlled(t, fakeRender)
    const grant = await t.library.exports.store.authorize(t.destination)
    const prepared = await t.library.prepareExport(t.photos.map((p) => p.id))
    const id = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'high',
    })
    await wait(t, id)
    const files = t.library.exports.store.files(id)
    const partial = files[0].partial!
    await link(join(t.destination, 'Photo-0.jpg'), join(t.destination, partial))
    files[0].partial = partial
    files[0].status = 'publishing'
    t.library.exports.store.file(id, files[0])
    const foreign = files[1].partial!
    await writeFile(join(t.destination, foreign), 'untouched')
    files[1].partial = foreign
    files[1].status = 'writing'
    t.library.exports.store.file(id, files[1])
    const task = t.library.listTasks().find((j) => j.id === id)!
    task.status = 'running'
    task.finishedAt = undefined
    t.library.exports.store.task(task)
    await t.library.exports.recover()
    expect(t.library.exports.results(id).results.map((f) => f.status)).toEqual([
      'exported',
      'failed',
    ])
    expect(await readFile(join(t.destination, foreign), 'utf8')).toBe('untouched')
    expect((await readdir(t.destination)).includes(partial)).toBe(false)
    expect(t.library.exports.list()[0].title).toBe('Export interrupted')
    const before = await readdir(t.destination)
    await t.library.exports.recover()
    expect(await readdir(t.destination)).toEqual(before)
  } finally {
    await t.close()
  }
})

test('catalog 17 export migration is transactional, rejects unknown preference versions and is idempotent', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new ExportStore(db)
    db.exec('BEGIN; PRAGMA user_version = 16')
    store.migrate()
    db.exec('ROLLBACK')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'export_%'").all()).toEqual(
      [],
    )
    db.exec('BEGIN')
    store.migrate()
    db.exec('PRAGMA user_version = 17; COMMIT')
    const before = store.preferences()
    store.migrate()
    expect(store.preferences()).toEqual(before)
    db.prepare('UPDATE export_preferences SET data = ?').run('{"version":2}')
    expect(() => store.migrate()).toThrow('newer Luma')
  } finally {
    db.close()
  }
})

test('real isolated worker writes a baseline sRGB JPEG and releases its source lease', async () => {
  const t = await exportFixture(1)
  try {
    const renderer = new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    )
    await controlled(t, renderer.render.bind(renderer))
    const grant = await t.library.exports.store.authorize(t.destination)
    const p = await t.library.prepareExport([t.photos[0].id])
    const id = await t.library.startExport({
      preparationId: p.id,
      destinationId: grant.id,
      action: 'high',
    })
    expect((await wait(t, id)).export).toMatchObject({ exported: 1, failed: 0 })
    expect((await readFile(join(t.destination, 'Photo-0.jpg'))).subarray(0, 2)).toEqual(
      Buffer.from([255, 216]),
    )
    expect(t.library.exports.leased([t.photos[0].id])).toBe(false)
    expect((await finishTask(t.library, t.library.deletePhotos([t.photos[0].id])!)).status).toBe(
      'completed',
    )
  } finally {
    await t.close()
  }
})

test('foreground interaction drains an export worker and retries only the unfinished file', async () => {
  const t = await exportFixture(2)
  const attempts: string[] = []
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    await controlled(t, async (job, signal) => {
      attempts.push(job.source.photo.id)
      if (attempts.length === 1) {
        entered()
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      }
      return fakeRender(job)
    })
    const grant = await t.library.exports.store.authorize(t.destination)
    const prepared = await t.library.prepareExport(t.photos.map((p) => p.id))
    const id = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'high',
    })
    await started
    await t.library.scheduler.run('interactive', async () => {
      expect(t.library.exports.leased(t.photos.map((p) => p.id))).toBe(true)
    })
    expect((await wait(t, id)).export).toMatchObject({ exported: 2, failed: 0 })
    expect(attempts).toEqual([t.photos[0].id, t.photos[0].id, t.photos[1].id])
    expect((await readdir(t.destination)).every((name) => name.endsWith('.jpg'))).toBe(true)
  } finally {
    await t.close()
  }
})

test('a destination write failure cleans its owned partial and retains independent file outcomes', async () => {
  const t = await exportFixture(2)
  let fail = true
  try {
    await controlled(t, fakeRender, async (boundary) => {
      if (boundary === 'partial' && fail) {
        fail = false
        throw new Error('ENOSPC: destination is full.')
      }
    })
    await writeFile(join(t.destination, 'existing.jpg'), 'preserved')
    const grant = await t.library.exports.store.authorize(t.destination)
    const prepared = await t.library.prepareExport(t.photos.map((p) => p.id))
    const id = await t.library.startExport({
      preparationId: prepared.id,
      destinationId: grant.id,
      action: 'high',
    })
    expect((await wait(t, id)).export).toMatchObject({ exported: 1, failed: 1 })
    expect(t.library.taskErrors(id).errors[0].message).toContain('ENOSPC')
    expect(await readFile(join(t.destination, 'existing.jpg'), 'utf8')).toBe('preserved')
    expect(await readdir(t.destination)).toEqual(['Photo-1.jpg', 'existing.jpg'])
  } finally {
    await t.close()
  }
})

test('cancelling an isolated encoder waits for its worker and auxiliary process tree to exit', async () => {
  const t = await exportFixture(1)
  try {
    const worker = join(t.root, 'encoder.mjs')
    await writeFile(
      worker,
      `import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
process.on('message', async job => {
 const auxiliary=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await writeFile(join(job.directory,'workers.json'),JSON.stringify([process.pid,auxiliary.pid]));
 setInterval(()=>{},1000);
});
`,
    )
    const renderer = new ExportProcess(worker, resolve('out/main/preview-worker.js'))
    await controlled(t, renderer.render.bind(renderer))
    const grant = await t.library.exports.store.authorize(t.destination)
    const p = await t.library.prepareExport([t.photos[0].id])
    const id = await t.library.startExport({
      preparationId: p.id,
      destinationId: grant.id,
      action: 'high',
    })
    const witness = join(t.root, 'library', 'export-work', id, '0', 'workers.json')
    await expect
      .poll(() =>
        readFile(witness, 'utf8').then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    const pids: number[] = JSON.parse(await readFile(witness, 'utf8'))
    await t.library.cancelTask(id)
    for (const pid of pids)
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
        .toBe(true)
    expect(t.library.exports.leased([t.photos[0].id])).toBe(false)
    expect(await readdir(t.destination)).toEqual([])
  } finally {
    await t.close()
  }
})

test('a queued job accepts frozen settings promptly and cancels without waiting for the active job', async () => {
  const t = await exportFixture(1)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let attempts = 0
  try {
    await controlled(t, async (job, signal) => {
      attempts++
      await Promise.race([
        gate,
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        }),
      ])
      return fakeRender(job)
    })
    const grant = await t.library.exports.store.authorize(t.destination)
    const first = await t.library.prepareExport([t.photos[0].id])
    const active = await t.library.startExport({
      preparationId: first.id,
      destinationId: grant.id,
      action: 'high',
    })
    await expect.poll(() => attempts).toBe(1)
    const second = await t.library.prepareExport([t.photos[0].id])
    const queued = await t.library.startExport({
      preparationId: second.id,
      destinationId: grant.id,
      action: 'custom',
      options: { ...defaultExportOptions, quality: 87 },
    })
    expect(t.library.listTasks().filter((task) => task.status === 'running')).toHaveLength(2)
    await t.library.cancelTask(queued)
    expect(t.library.listTasks().find((task) => task.id === queued)?.status).toBe('cancelled')
    expect(t.library.listTasks().find((task) => task.id === active)?.status).toBe('running')
    expect(t.library.exports.leased([t.photos[0].id])).toBe(true)
    release()
    expect((await wait(t, active)).export).toMatchObject({ exported: 1 })
    expect((await t.library.getExportPreferences()).lastCustom?.quality).toBe(87)
    expect(await readdir(t.destination)).toEqual(['Photo-0.jpg'])
    expect(t.library.exports.leased([t.photos[0].id])).toBe(false)
  } finally {
    release?.()
    await t.close()
  }
})
