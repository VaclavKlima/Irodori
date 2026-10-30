import type { ElectronApplication } from '@playwright/test'

export interface MainSqlTimingEvent {
  tag: string
  startedAtEpochMs: number
  endedAtEpochMs: number
  durationMs: number
}

/** Benchmark-local observation. No SQL is issued; the existing actual catalog is observed. */
export async function observeMainSqlTiming(app: ElectronApplication, isolatedUserDataDir: string) {
  return app.evaluateHandle(({ app }, isolatedUserDataDir) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const sqlite = process.getBuiltinModule('node:sqlite')
    if (
      !path.isAbsolute(isolatedUserDataDir) ||
      !path.basename(isolatedUserDataDir).startsWith('irodori-e2e-') ||
      fs.realpathSync(isolatedUserDataDir) !== fs.realpathSync(app.getPath('userData'))
    )
      throw new Error('SQL observation requires the shared isolated fixture profile.')
    const expectedCatalog = fs.realpathSync(
      path.join(isolatedUserDataDir, 'library', 'catalog.sqlite'),
    )
    const location = sqlite.DatabaseSync.prototype.location
    if (typeof location !== 'function')
      throw new Error('Actual catalog binding requires DatabaseSync.location.')

    type Call = (this: unknown, ...args: unknown[]) => unknown
    interface Slot {
      prototype: object
      name: string
      descriptor: PropertyDescriptor & { value: Call; writable: true }
      wrapped?: Call
    }
    const events: MainSqlTimingEvent[] = []
    const slots: Slot[] = []
    const databases = new WeakMap<object, string>()
    const statements = new WeakMap<object, string>()
    const catalogConnectionIds = new Set<string>()
    let nextDatabase = 0,
      closed = false,
      dropped = 0,
      observerErrors = 0
    let execCalls = 0,
      runCalls = 0,
      unboundRunCalls = 0,
      mappedStatements = 0
    const maxEvents = 256,
      slowMs = 2
    const now = () => performance.now()
    const origin = performance.timeOrigin
    const object = (value: unknown): value is object =>
      (typeof value === 'object' && value !== null) || typeof value === 'function'
    const owner = (value: unknown) => {
      if (!object(value)) return 'unbound'
      const previous = databases.get(value)
      if (previous) return previous
      try {
        const actual = Reflect.apply(location, value, ['main']) as string | null
        const catalog = actual !== null && fs.realpathSync(actual) === expectedCatalog
        const tag = `${catalog ? 'catalog' : 'other'}#${++nextDatabase}`
        databases.set(value, tag)
        if (catalog) catalogConnectionIds.add(tag)
        return tag
      } catch {
        // A bad receiver must still reach the original method and throw its
        // original exception; observation must not replace native behavior.
        return 'unbound'
      }
    }
    const record = (tag: string, started: number, ended: number, transaction: boolean) => {
      if (closed || (!transaction && ended - started < slowMs)) return
      try {
        const event = {
          tag,
          startedAtEpochMs: origin + started,
          endedAtEpochMs: origin + ended,
          durationMs: ended - started,
        }
        if (events.length < maxEvents) events.push(event)
        else dropped++
      } catch {
        observerErrors++
      }
    }
    const slot = (prototype: object, name: string): Slot => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      if (!descriptor || typeof descriptor.value !== 'function' || descriptor.writable !== true)
        throw new Error(`SQL diagnostic requires a writable own ${name} method.`)
      return { prototype, name, descriptor: descriptor as Slot['descriptor'] }
    }
    // Validate every slot before mutating any prototype. No constructor is replaced.
    const exec = slot(sqlite.DatabaseSync.prototype, 'exec')
    const prepare = slot(sqlite.DatabaseSync.prototype, 'prepare')
    const run = slot(sqlite.StatementSync.prototype, 'run')
    exec.wrapped = function (...args) {
      let tag = 'unbound'
      try {
        tag = owner(this)
      } catch {
        observerErrors++
      }
      let kind = 'EXEC'
      if (typeof args[0] === 'string') {
        const transaction = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(args[0])
        if (transaction) kind = transaction[1].toUpperCase()
      }
      const started = now()
      let threw = true
      try {
        const result = Reflect.apply(exec.descriptor.value, this, args)
        threw = false
        return result
      } finally {
        record(`${tag}/${kind}${threw ? '/throw' : ''}`, started, now(), kind !== 'EXEC')
        execCalls++
      }
    }
    prepare.wrapped = function (...args) {
      // Map the actual returned statement, without reading SQL, parameters or
      // results. Existing statements are reported unbound rather than guessed.
      const statement = Reflect.apply(prepare.descriptor.value, this, args)
      try {
        if (object(statement)) {
          statements.set(statement, owner(this))
          mappedStatements++
        }
      } catch {
        observerErrors++
      }
      return statement
    }
    run.wrapped = function (...args) {
      const tag = object(this) ? (statements.get(this) ?? 'unbound') : 'unbound'
      const started = now()
      let threw = true
      try {
        const result = Reflect.apply(run.descriptor.value, this, args)
        threw = false
        return result
      } finally {
        record(`${tag}/RUN${threw ? '/throw' : ''}`, started, now(), false)
        runCalls++
        if (tag === 'unbound') unboundRunCalls++
      }
    }
    const restore = () => {
      const conflicts: string[] = []
      for (const item of [...slots].reverse()) {
        try {
          const current = Object.getOwnPropertyDescriptor(item.prototype, item.name)
          if (current?.value === item.wrapped)
            Object.defineProperty(item.prototype, item.name, item.descriptor)
          else if (current?.value !== item.descriptor.value) conflicts.push(item.name)
        } catch {
          conflicts.push(item.name)
        }
      }
      return conflicts
    }
    try {
      for (const item of [exec, prepare, run]) {
        Object.defineProperty(item.prototype, item.name, {
          ...item.descriptor,
          value: item.wrapped,
        })
        // Own rollback even if the independent installation check below fails.
        slots.push(item)
        if (Object.getOwnPropertyDescriptor(item.prototype, item.name)?.value !== item.wrapped)
          throw new Error(`SQL observer could not install ${item.name}.`)
      }
    } catch (error) {
      restore()
      throw error
    }
    const snapshot = () => ({
      version: 'actual-main-sql-duration-diagnostic-v1',
      clock: 'Actual main process performance.timeOrigin + performance.now epoch milliseconds.',
      scope:
        'Existing actual connections; catalog# tags match the isolated catalog location. No SQL/parameters/results retained.',
      slowMs,
      maxEvents,
      dropped,
      observerErrors,
      calls: { exec: execCalls, run: runCalls, unboundRun: unboundRunCalls, mappedStatements },
      catalogConnectionIds: [...catalogConnectionIds],
      events: events.slice(),
      limitations: [
        'Previously prepared statements have no public connection accessor and remain unbound.',
        'prepare maps ownership only; prepare/all/get/iterate and other methods are not timed.',
        'Unbound/other tags never prove catalog attribution.',
        'Synchronous call duration does not separate SQLite CPU, file I/O, lock waits or fsync.',
        'This instrumentation is a new diagnostic observation, not unchanged-run acceptance.',
      ],
    })
    let receipt:
      | (ReturnType<typeof snapshot> & { restoredAll: boolean; restoreConflicts: string[] })
      | undefined
    return {
      snapshot,
      close: () => {
        if (receipt) return receipt
        closed = true
        const restoreConflicts = restore()
        receipt = { ...snapshot(), restoredAll: restoreConflicts.length === 0, restoreConflicts }
        return receipt
      },
    }
  }, isolatedUserDataDir)
}
