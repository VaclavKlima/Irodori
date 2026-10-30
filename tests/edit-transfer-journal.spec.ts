import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BackgroundTask } from '../src/shared/contracts'
import { initialSettings } from '../src/shared/edits'
import {
  copiedEdits,
  type EditApplicationResult,
  type EditPasteTarget,
} from '../src/shared/edit-transfer'
import { processingMetadata } from '../src/main/processing/metadata'
import {
  EditApplicationMutations,
  EditApplicationReadStore,
} from '../src/main/edit-application-store'
import { catalogTransaction } from '../src/main/catalog/transaction'
import { transferFixture } from './edit-transfer.helpers'

const record = (value: unknown) => value as Record<string, unknown>
type StoredOutcome = 'applied' | 'unchanged' | 'conflict' | 'unavailable' | 'failed'

function fixture(size = 3) {
  const db = new DatabaseSync(':memory:'),
    store = new EditApplicationReadStore(db),
    mutations = new EditApplicationMutations(db)
  store.initialize()
  const id = randomUUID(),
    clipboard = {
      id: randomUUID(),
      photoId: 'a'.repeat(64),
      filename: 'Source.png',
      revision: 2,
      copiedAt: '2026-10-29T00:00:00.000Z',
    }
  const targets: EditPasteTarget[] = Array.from({ length: size }, (_, index) => ({
    photoId: (index + 1).toString(16).padStart(64, '0'),
    filename: `Destination-${index}.png`,
    revision: 4,
  }))
  const task: BackgroundTask = {
    id,
    kind: 'edit-application',
    title: 'Applying copied edits',
    status: 'running',
    errorCount: 0,
    progress: { completed: 0, total: size, unit: 'items' },
    editApplication: { applied: 0, unchanged: 0, conflict: 0, unavailable: 0, failed: 0 },
  }
  catalogTransaction(db, () =>
    mutations.accept(
      {
        version: 1,
        id,
        source: copiedEdits(clipboard, initialSettings(), processingMetadata({}, [])),
        groups: ['light'],
        targets,
      },
      task,
    ),
  )
  const changeJson = (
    table: string,
    column: string,
    change: (value: Record<string, unknown>) => void,
    ordinal?: number,
  ) => {
    const where = ordinal === undefined ? 'id = ?' : 'job_id = ? AND ordinal = ?'
    const args = ordinal === undefined ? [id] : [id, ordinal]
    const row = db
      .prepare(`SELECT ${column} AS data FROM ${table} WHERE ${where}`)
      .get(...args) as { data: string }
    const value = record(JSON.parse(row.data))
    change(value)
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`).run(
      JSON.stringify(value),
      ...args,
    )
  }
  const snapshot = () =>
    Object.fromEntries(
      ['edit_applications', 'edit_application_targets', 'edit_application_results'].map((name) => [
        name,
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)
          ? db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()
          : null,
      ]),
    )
  return {
    db,
    id,
    store,
    mutations,
    targets,
    manifest(change: (value: Record<string, unknown>) => void) {
      changeJson('edit_applications', 'manifest', change)
    },
    task(change: (value: Record<string, unknown>) => void) {
      changeJson('edit_applications', 'task', change)
    },
    target(ordinal: number, change: (value: Record<string, unknown>) => void) {
      changeJson('edit_application_targets', 'data', change, ordinal)
    },
    result(ordinal: number, change: (value: Record<string, unknown>) => void) {
      changeJson('edit_application_results', 'data', change, ordinal)
    },
    addResult(ordinal: number, outcome: StoredOutcome = 'applied') {
      const result: EditApplicationResult = {
        ...targets[ordinal],
        ordinal,
        outcome,
        ...(['applied', 'unchanged'].includes(outcome)
          ? { resultingRevision: targets[ordinal].revision + (outcome === 'applied' ? 1 : 0) }
          : { message: 'Not applied.' }),
      }
      db.prepare('INSERT INTO edit_application_results VALUES (?, ?, ?)').run(
        id,
        ordinal,
        JSON.stringify(result),
      )
      changeJson('edit_applications', 'task', (value) => {
        const progress = record(value.progress),
          counts = record(value.editApplication)
        progress.completed = Number(progress.completed) + 1
        counts[outcome] = Number(counts[outcome]) + 1
        if (['conflict', 'unavailable', 'failed'].includes(outcome))
          value.errorCount = Number(value.errorCount) + 1
      })
    },
    snapshot,
    rejectsWithoutWrites() {
      const before = snapshot()
      expect(() => store.validateExisting()).toThrow('format is unsupported')
      expect(snapshot()).toEqual(before)
    },
    close() {
      db.close()
    },
  }
}

test('valid partial, cancelled and completed journals retain their frozen historical records without needing current photos', () => {
  for (const status of ['running', 'cancelling', 'cancelled', 'failed', 'completed'] as const) {
    const f = fixture()
    try {
      f.addResult(0)
      f.addResult(1, 'conflict')
      if (status === 'completed') f.addResult(2, 'unchanged')
      f.task((task) => {
        task.status = status
        if (!['running', 'cancelling'].includes(status)) {
          task.finishedAt = Date.parse('2026-10-29T00:00:01.000Z')
          task.unprocessed = status === 'completed' ? 0 : 1
        }
      })
      const before = f.snapshot()
      expect(() => f.store.validateExisting()).not.toThrow()
      expect(f.snapshot()).toEqual(before)
      expect(f.store.results(f.id).total).toBe(3)
    } finally {
      f.close()
    }
  }
  // Cancellation or a lost final acknowledgement can follow the last durable result.
  for (const status of ['cancelled', 'failed'] as const) {
    const f = fixture(1)
    try {
      f.addResult(0)
      f.task((task) => {
        task.status = status
        task.finishedAt = 1
        task.unprocessed = 0
      })
      const before = f.snapshot()
      expect(() => f.store.validateExisting()).not.toThrow()
      expect(f.snapshot()).toEqual(before)
    } finally {
      f.close()
    }
  }
  const db = new DatabaseSync(':memory:')
  try {
    new EditApplicationReadStore(db).validateExisting()
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(),
    ).toEqual([])
  } finally {
    db.close()
  }
})

test('malformed versions, sources and task counters are rejected before any journal mutation', () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => f.db.prepare('UPDATE edit_applications SET manifest = ?').run('{'),
    (f) =>
      f.manifest((value) => {
        value.version = 2
      }),
    (f) =>
      f.manifest((value) => {
        record(value.source).version = 2
      }),
    (f) =>
      f.manifest((value) => {
        record(record(value.source).settings).version = 999
      }),
    (f) =>
      f.manifest((value) => {
        record(record(value.source).clipboard).groups = ['future-tool']
      }),
    (f) =>
      f.manifest((value) => {
        record(record(value.source).clipboard).revision = -1
      }),
    (f) =>
      f.manifest((value) => {
        record(value.source).lensKinds = ['unknown']
      }),
    (f) =>
      f.task((value) => {
        value.status = 'resuming-automatically'
      }),
    (f) =>
      f.task((value) => {
        value.editApplication = {}
      }),
    (f) =>
      f.task((value) => {
        record(value.progress).completed = -1
      }),
    (f) =>
      f.task((value) => {
        record(value.progress).total = 100001
      }),
    (f) =>
      f.task((value) => {
        record(value.progress).completed = 1.5
      }),
    (f) =>
      f.task((value) => {
        record(value.progress).completed = Number.MAX_SAFE_INTEGER + 1
      }),
    (f) =>
      f.task((value) => {
        record(value.editApplication).applied = 1
      }),
    (f) =>
      f.task((value) => {
        value.errorCount = 1
      }),
    (f) =>
      f.task((value) => {
        value.status = 'completed'
      }),
    (f) =>
      f.task((value) => {
        value.status = 'cancelled'
        value.unprocessed = 3
      }),
    (f) =>
      f.task((value) => {
        value.finishedAt = 1
      }),
    (f) =>
      f.task((value) => {
        value.unprocessed = 2
      }),
  ]
  for (const change of changes) {
    const f = fixture()
    try {
      change(f)
      f.rejectsWithoutWrites()
    } finally {
      f.close()
    }
  }
})

test('target holes, duplicate photos, malformed records and orphan rows cannot be reinterpreted as a recoverable selection', () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => f.db.prepare('DELETE FROM edit_application_targets WHERE ordinal = 1').run(),
    (f) => f.db.prepare('UPDATE edit_application_targets SET ordinal = 4 WHERE ordinal = 1').run(),
    (f) =>
      f.db.prepare('UPDATE edit_application_targets SET ordinal = 1.5 WHERE ordinal = 1').run(),
    (f) =>
      f.target(1, (value) => {
        value.photoId = f.targets[0].photoId
      }),
    (f) =>
      f.target(1, (value) => {
        value.photoId = '/arbitrary/path'
      }),
    (f) =>
      f.target(1, (value) => {
        value.revision = -1
      }),
    (f) =>
      f.target(1, (value) => {
        value.unavailable = ''
      }),
    (f) =>
      f.target(1, (value) => {
        value.futureVersion = true
      }),
    (f) =>
      f.db
        .prepare('UPDATE edit_application_targets SET data = ? WHERE ordinal = 1')
        .run('broken JSON'),
    (f) => {
      f.db.exec('PRAGMA foreign_keys = OFF')
      f.db
        .prepare('INSERT INTO edit_application_targets VALUES (?, ?, ?)')
        .run(randomUUID(), 0, JSON.stringify(f.targets[0]))
    },
    (f) => f.db.exec('DROP TABLE edit_application_targets'),
  ]
  for (const change of changes) {
    const f = fixture()
    try {
      change(f)
      f.rejectsWithoutWrites()
    } finally {
      f.close()
    }
  }
})

test('result rows must match the frozen target, contiguous completed prefix, revision semantics and atomic progress counters', () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) =>
      f.result(0, (value) => {
        value.photoId = f.targets[1].photoId
      }),
    (f) =>
      f.result(0, (value) => {
        value.filename = 'A different file.png'
      }),
    (f) =>
      f.result(0, (value) => {
        value.revision = 1
      }),
    (f) =>
      f.result(0, (value) => {
        value.ordinal = 1
      }),
    (f) =>
      f.result(0, (value) => {
        value.outcome = 'future-outcome'
      }),
    (f) =>
      f.result(0, (value) => {
        value.resultingRevision = 99
      }),
    (f) =>
      f.result(0, (value) => {
        value.outcome = 'unchanged'
      }),
    (f) =>
      f.result(0, (value) => {
        value.message = {}
      }),
    (f) =>
      f.result(0, (value) => {
        value.futureVersion = true
      }),
    (f) =>
      f.target(0, (value) => {
        value.unavailable = 'No compatible source.'
      }),
    (f) => f.db.prepare('DELETE FROM edit_application_results').run(),
    (f) =>
      f.task((value) => {
        record(value.progress).completed = 0
        record(value.editApplication).applied = 0
      }),
    (f) => f.addResult(2),
    (f) =>
      f.db
        .prepare('INSERT INTO edit_application_results VALUES (?, ?, ?)')
        .run(f.id, 8, JSON.stringify({ ...f.targets[0], ordinal: 8, outcome: 'failed' })),
    (f) => {
      f.db.exec('PRAGMA foreign_keys = OFF')
      f.db
        .prepare('INSERT INTO edit_application_results VALUES (?, ?, ?)')
        .run(randomUUID(), 0, JSON.stringify({ ...f.targets[0], ordinal: 0, outcome: 'failed' }))
    },
  ]
  for (const change of changes) {
    const f = fixture()
    try {
      f.addResult(0)
      change(f)
      f.rejectsWithoutWrites()
    } finally {
      f.close()
    }
  }
})

test('large valid journals use bounded streaming queries rather than reloading full manifests per result', () => {
  const f = fixture(1000)
  try {
    for (let ordinal = 0; ordinal < 500; ordinal++) f.addResult(ordinal)
    let queries = 0
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            queries++
            return target.prepare(sql)
          }
        return Reflect.get(target, key, target)
      },
    }) as DatabaseSync
    const before = f.snapshot()
    new EditApplicationReadStore(db).validateExisting()
    expect(queries).toBeLessThanOrEqual(10)
    expect(f.snapshot()).toEqual(before)
  } finally {
    f.close()
  }
})

test('startup rejects an inconsistent persisted journal before recovery or schema writes and preserves the catalog and originals', async () => {
  const t = await transferFixture(2)
  try {
    await t.library.updateEdits(t.ids[0], { exposureEv: 1 }, 0)
    const copy = await t.library.copyEdits(t.ids[0]),
      preparation = await t.library.preparePasteEdits({
        clipboardId: copy.id,
        photoIds: [t.ids[1]],
        groups: ['light'],
      })
    const id = await t.library.startPasteEdits(preparation.id)
    await t.finished(id)
    await t.library.close()
    const path = join(t.root, 'library', 'catalog.sqlite'),
      db = new DatabaseSync(path)
    try {
      const row = db.prepare('SELECT task FROM edit_applications WHERE id = ?').get(id) as {
        task: string
      }
      const task = record(JSON.parse(row.task))
      task.status = 'running'
      delete task.finishedAt
      delete task.unprocessed
      record(task.progress).completed = 0
      record(task.editApplication).applied = 0
      db.prepare('UPDATE edit_applications SET task = ? WHERE id = ?').run(JSON.stringify(task), id)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
    const before = await readFile(path)
    await expect(t.restart()).rejects.toThrow('format is unsupported')
    expect(await readFile(path)).toEqual(before)
    await t.originalsUnchanged()
  } finally {
    await t.close()
  }
})
