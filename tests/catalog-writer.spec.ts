import { test, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import {
  CatalogWriter,
  CatalogWriterFailure,
  type CatalogWorkerFactory,
} from '../src/main/catalog/writer'
import { CatalogMutations } from '../src/main/catalog/domain'
import type { CatalogCommand } from '../src/main/catalog/contracts'
import { PhotoLibrary } from '../src/main/library'
import { initialSettings, type EditHistory } from '../src/shared/edits'
import {
  PROCESSING_METADATA_VERSION,
  noLensSettings,
  type ProcessingOptions,
} from '../src/shared/lens'
import { unavailableProfile } from '../src/main/processing/metadata'
import type { BackgroundTask, Photo } from '../src/shared/contracts'

const timestamp = '2026-10-20T12:00:00.000Z'
const metadata: ProcessingOptions['metadata'] = {
  version: PROCESSING_METADATA_VERSION,
  lensProfile: unavailableProfile,
}
const photo = (id: string): Photo => ({
  id,
  filename: `${id[0]}.png`,
  format: 'PNG',
  width: 3,
  height: 2,
  bytes: 4,
  importedAt: timestamp,
  previewSource: 'image',
  previewUrl: '',
  thumbnailUrl: '',
})
function history(id: string, exposureEv = 0): EditHistory {
  const settings = { ...initialSettings(noLensSettings), exposureEv }
  return {
    photoId: id,
    revision: 0,
    settings,
    cursor: 1,
    canUndo: false,
    canRedo: false,
    snapshots: [
      { settings: initialSettings(noLensSettings), createdAt: timestamp },
      { settings, createdAt: timestamp },
    ],
  }
}

async function fixture(
  mode: 'normal' | 'held' | 'before-write-exit' | 'after-commit-exit' | 'rollback-exit' = 'normal',
) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-catalog-writer-'))
  const path = join(root, 'catalog.sqlite'),
    db = new DatabaseSync(path),
    gate = new Int32Array(new SharedArrayBuffer(8))
  const owners: CatalogWriter[] = []
  let closed = false
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT NOT NULL, photo TEXT NOT NULL, processing_identity TEXT NOT NULL);
      CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE removals (id TEXT PRIMARY KEY, staged TEXT NOT NULL);
      CREATE TABLE derived_assets (id TEXT PRIMARY KEY, manifest TEXT NOT NULL);
      CREATE TABLE merge_publications (id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL);`)
    const boot = new CatalogMutations(db)
    boot.stacks.initialize()
    boot.browse.initialize()
    boot.workspace.initialize()
    boot.sources.initialize()
    boot.camera.initialize()
    boot.exports.initialize()
    boot.execute({
      operation: 'original.publish',
      payload: {
        photo: photo('a'.repeat(64)),
        processingIdentity: 'display-referred-v1',
        metadata,
        createdAt: timestamp,
      },
    })
    const task: BackgroundTask = {
      id: 'export-job',
      kind: 'export',
      title: 'Before',
      status: 'running',
      errorCount: 0,
    }
    db.prepare('INSERT INTO export_jobs VALUES (?, ?, ?)').run(task.id, '{}', JSON.stringify(task))
    db.exec('PRAGMA query_only=ON')
    const file = join(root, 'worker.mjs')
    await build({
      stdin: {
        contents: `
      import { parentPort, workerData } from 'node:worker_threads'
      import { DatabaseSync } from 'node:sqlite'
      import { CatalogMutations } from ${JSON.stringify(resolve('src/main/catalog/domain.ts'))}
      import { serveCatalog } from ${JSON.stringify(resolve('src/main/catalog/serve.ts'))}
      const db = new DatabaseSync(workerData.databasePath)
      db.exec('PRAGMA synchronous=FULL')
      const domain = new CatalogMutations(db)
      domain.camera.initialize()
      const gate = new Int32Array(workerData.gate), mode = workerData.mode
      if (mode === 'held') {
        db.function('hold_catalog_transaction', () => {
          Atomics.store(gate, 0, 1); Atomics.notify(gate, 0)
          while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0)
          return 0
        })
        db.exec('CREATE TEMP TRIGGER held_edit AFTER UPDATE ON edits BEGIN SELECT hold_catalog_transaction(); END')
      }
      if (mode === 'rollback-exit') db.exec("CREATE TEMP TRIGGER rollback_workspace BEFORE INSERT ON workspace_state BEGIN SELECT RAISE(ROLLBACK, 'Fixture rollback already ended transaction'); END")
      const execute = domain.execute.bind(domain)
      domain.execute = command => {
        if (mode === 'before-write-exit' && command.operation === 'edits.commit') process.exit(31)
        const value = execute(command)
        if (mode === 'after-commit-exit' && command.operation === 'edits.commit') process.exit(32)
        return value
      }
      serveCatalog(parentPort, domain)
    `,
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      packages: 'external',
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile: file,
      logLevel: 'silent',
    })
    const create: CatalogWorkerFactory = (_entry, options) => {
      const actual = new Worker(file, {
        ...options,
        workerData: { ...options.workerData, gate: gate.buffer, mode },
      })
      actual.once('exit', () => {
        closed = true
      })
      return actual
    }
    const owner = new CatalogWriter(path, create)
    owners.push(owner)
    await owner.open()
    return {
      root,
      path,
      db,
      gate,
      owner,
      task,
      get actualClosed() {
        return closed
      },
      async fresh() {
        const next = new CatalogWriter(path, undefined, resolve('out/main/catalog-worker.js'))
        owners.push(next)
        await next.open()
        return next
      },
      async close() {
        Atomics.store(gate, 1, 1)
        Atomics.notify(gate, 1)
        await Promise.all(owners.map((owner) => owner.close()))
        db.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    Atomics.store(gate, 1, 1)
    Atomics.notify(gate, 1)
    await Promise.all(owners.map((owner) => owner.close()))
    if (db.isOpen) db.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

// A real SQLite transaction is held by a fixture UDF before COMMIT. This does not
// simulate a measured fsync duration and adds no production test-mode switch.
test('held writer leaves main responsive and serializes durable workspace/export/import writes', async () => {
  const f = await fixture('held'),
    work: Promise<unknown>[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    expect(() => f.db.prepare('UPDATE edits SET data = data').run()).toThrow(/readonly|read-only/i)
    let heartbeat = 0,
      settled = 0
    timer = setInterval(() => {
      heartbeat++
    }, 1)
    const track = (promise: Promise<unknown>) => {
      const watched = promise.then((value) => {
        settled++
        return value
      })
      void watched.catch(() => undefined)
      work.push(watched)
      return watched
    }
    const edit = history('a'.repeat(64), 0.25)
    track(
      f.owner.command({
        operation: 'edits.commit',
        payload: { history: edit, expectedRevision: 0 },
      }),
    )
    await expect.poll(() => Atomics.load(f.gate, 0)).toBe(1)
    const change = { state: { consoleOpen: true } },
      nextPhoto = photo('b'.repeat(64)),
      task = { ...f.task, title: 'Persisted' }
    track(f.owner.command({ operation: 'workspace.save', payload: change }))
    track(f.owner.command({ operation: 'export.task', payload: { task } }))
    track(
      f.owner.command({
        operation: 'original.publish',
        payload: {
          photo: nextPhoto,
          processingIdentity: 'display-referred-v1',
          metadata,
          createdAt: timestamp,
        },
      }),
    )
    edit.settings.exposureEv = 4
    change.state.consoleOpen = false
    task.title = 'Mutated'
    nextPhoto.filename = 'Mutated.png'
    const before = heartbeat
    await expect.poll(() => heartbeat).toBeGreaterThan(before + 2)
    expect(settled).toBe(0)
    expect(
      JSON.parse(
        (
          f.db.prepare('SELECT data FROM edits WHERE id = ?').get('a'.repeat(64)) as {
            data: string
          }
        ).data,
      ).revision,
    ).toBe(0)
    let drained = false
    const close = f.owner.close().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(f.owner.command({ operation: 'capture.reconcile', payload: {} })).rejects.toThrow(
      'unavailable',
    )
    Atomics.store(f.gate, 1, 1)
    Atomics.notify(f.gate, 1)
    await Promise.all(work)
    await close
    expect(f.actualClosed).toBe(true)
    expect(f.owner.isClosed).toBe(true)
    expect(
      JSON.parse(
        (
          f.db.prepare('SELECT data FROM edits WHERE id = ?').get('a'.repeat(64)) as {
            data: string
          }
        ).data,
      ),
    ).toMatchObject({ revision: 1, cursor: 1, canUndo: true, settings: { exposureEv: 0.25 } })
    expect(
      JSON.parse((f.db.prepare('SELECT data FROM workspace_state').get() as { data: string }).data)
        .consoleOpen,
    ).toBe(true)
    expect(
      JSON.parse((f.db.prepare('SELECT task FROM export_jobs').get() as { task: string }).task)
        .title,
    ).toBe('Persisted')
    expect(
      JSON.parse(
        (
          f.db.prepare('SELECT photo FROM photos WHERE id = ?').get('b'.repeat(64)) as {
            photo: string
          }
        ).photo,
      ).filename,
    ).toBe('b.png')
    expect(
      JSON.parse(
        (
          f.db.prepare('SELECT data FROM edits WHERE id = ?').get('b'.repeat(64)) as {
            data: string
          }
        ).data,
      ),
    ).toMatchObject({ revision: 0, cursor: 0, canUndo: false, canRedo: false })
  } finally {
    if (timer) clearInterval(timer)
    Atomics.store(f.gate, 1, 1)
    Atomics.notify(f.gate, 1)
    await Promise.allSettled(work)
    await f.close()
  }
})

for (const [mode, expectedRevision] of [
  ['before-write-exit', 0],
  ['after-commit-exit', 1],
] as const)
  test(`${mode}: unknown ACK waits actual exit and fresh owner prevents duplicate history`, async () => {
    const f = await fixture(mode)
    try {
      const command: CatalogCommand<'edits.commit'> = {
        operation: 'edits.commit',
        payload: { history: history('a'.repeat(64), 0.5), expectedRevision: 0 },
      }
      await assert.rejects(f.owner.command(command), (error) => {
        assert(error instanceof CatalogWriterFailure)
        assert.equal(f.actualClosed, true)
        assert.equal(f.owner.isClosed, true)
        assert.equal(error.workerExited, true)
        assert.equal(error.outcome, 'unknown')
        return true
      })
      expect(f.owner.failure).toBeTruthy()
      await expect(f.owner.command(command)).rejects.toThrow('unavailable')
      const saved = JSON.parse(
        (f.db.prepare('SELECT data FROM edits').get() as { data: string }).data,
      )
      expect(saved.revision).toBe(expectedRevision)
      expect(saved.snapshots).toHaveLength(expectedRevision ? 2 : 1)
      const next = await f.fresh()
      if (expectedRevision) await expect(next.command(command)).rejects.toThrow('Edit conflict')
      else await next.command(command)
      const final = JSON.parse(
        (f.db.prepare('SELECT data FROM edits').get() as { data: string }).data,
      )
      expect(final.revision).toBe(1)
      expect(final.snapshots).toHaveLength(2)
      await next.close()
      expect(next.isClosed).toBe(true)
    } finally {
      await f.close()
    }
  })

test('production worker keeps stale CAS rejection reusable and read-after-ACK visible', async () => {
  const f = await fixture()
  try {
    await f.owner.close()
    const next = await f.fresh()
    const command: CatalogCommand<'edits.commit'> = {
      operation: 'edits.commit',
      payload: { history: history('a'.repeat(64), -0.25), expectedRevision: 0 },
    }
    const [first, stale] = await Promise.allSettled([next.command(command), next.command(command)])
    expect(first.status).toBe('fulfilled')
    expect(stale.status).toBe('rejected')
    expect(next.failure).toBeUndefined()
    expect(
      JSON.parse((f.db.prepare('SELECT data FROM edits').get() as { data: string }).data),
    ).toMatchObject({ revision: 1, settings: { exposureEv: -0.25 } })
    expect(
      await next.command({
        operation: 'workspace.save',
        payload: { state: { consoleOpen: true } },
      }),
    ).toBe(1)
    await next.close()
    expect(next.isClosed).toBe(true)
  } finally {
    await f.close()
  }
})

test('metadata-less publication gets seeded history through the worker before pure library reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-catalog-metadata-')),
    owners: CatalogWriter[] = []
  const args: ConstructorParameters<typeof PhotoLibrary> = [
    root,
    {
      process: async () => {
        throw new Error('Unexpected decode')
      },
      close: async () => {},
    },
    () => {},
  ]
  args[5] = { inspect: async () => metadata, close: async () => {} }
  args[17] = (path) => {
    const owner = new CatalogWriter(path, undefined, resolve('out/main/catalog-worker.js'))
    owners.push(owner)
    return owner
  }
  const library = new PhotoLibrary(...args)
  let observed: DatabaseSync | undefined
  try {
    await library.open()
    const mainRead = Reflect.get(library, 'db') as DatabaseSync
    expect(() => mainRead.prepare('DELETE FROM photos').run()).toThrow(/readonly|read-only/i)
    const original = photo('c'.repeat(64))
    await mkdir(join(root, 'originals', original.id))
    await writeFile(join(root, 'originals', original.id, 'original.png'), 'managed test bytes')
    await owners[0].command({
      operation: 'original.publish',
      payload: { photo: original, processingIdentity: 'display-referred-v1', createdAt: timestamp },
    })
    observed = new DatabaseSync(join(root, 'catalog.sqlite'), { readOnly: true })
    expect(observed.prepare('SELECT 1 FROM edits').get()).toBeUndefined()
    expect(await library.getEdits(original.id)).toMatchObject({
      photoId: original.id,
      revision: 0,
      canUndo: false,
      canRedo: false,
    })
    const before = observed.prepare('SELECT data FROM edits').get()
    expect(before).toBeTruthy()
    expect(await library.getEditHistory(original.id)).toMatchObject({ revision: 0, cursor: 0 })
    expect(observed.prepare('SELECT data FROM edits').get()).toEqual(before)
    await Promise.all([library.close(), library.close()])
    expect(owners[0].isClosed).toBe(true)
  } finally {
    await library.close()
    observed?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rollback failure in an extracted Store retires the actual writer instead of reporting a reusable rejection', async () => {
  const f = await fixture('rollback-exit')
  try {
    await assert.rejects(
      f.owner.command({ operation: 'workspace.save', payload: { state: { consoleOpen: true } } }),
      (error) => {
        assert(error instanceof CatalogWriterFailure)
        assert.equal(f.actualClosed, true)
        return true
      },
    )
    expect(f.owner.failure).toBeTruthy()
    expect(f.db.prepare('SELECT 1 FROM workspace_state').get()).toBeUndefined()
    const next = await f.fresh()
    expect(
      await next.command({
        operation: 'workspace.save',
        payload: { state: { consoleOpen: true } },
      }),
    ).toBe(1)
    await next.close()
    expect(next.isClosed).toBe(true)
  } finally {
    await f.close()
  }
})
