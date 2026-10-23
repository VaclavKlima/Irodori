import { Worker, type WorkerOptions } from 'node:worker_threads'
import { join } from 'node:path'
import type {
  CatalogCommand,
  CatalogCommands,
  CatalogOperation,
  CatalogOutput,
  CatalogRequest,
  CatalogResponse,
} from './contracts'

export type CatalogWorkerFactory = (path: string, options: WorkerOptions) => Worker
interface Pending {
  resolve(value: unknown): void
  reject(reason: unknown): void
}

/** A failed owner never silently retries an outcome whose COMMIT acknowledgement was lost. */
export class CatalogWriterFailure extends Error {
  readonly outcome = 'unknown'
  readonly workerExited = true
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CatalogWriterFailure'
  }
}

/** One library, one runtime writer. Accepted commands drain even if their caller is cancelled. */
export class CatalogWriter implements CatalogCommands {
  private worker: Worker
  private sequence = 0
  private pending = new Map<number, Pending>()
  private readyResolve!: () => void
  private readyReject!: (error: unknown) => void
  private exitResolve!: () => void
  private readySeen = false
  private closeRequested = false
  private closedAcknowledged = false
  private exited = false
  private problem?: Error
  private readonly ready: Promise<void>
  private readonly exit: Promise<void>
  get failure(): Error | undefined {
    return this.problem
  }
  get isClosed(): boolean {
    return this.exited
  }
  constructor(
    databasePath: string,
    createWorker: CatalogWorkerFactory = (path, options) => new Worker(path, options),
    workerPath = join(import.meta.dirname, 'catalog-worker.js'),
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Keep an early worker failure observed even if open() has not been awaited yet.
    void this.ready.catch(() => undefined)
    this.exit = new Promise((resolve) => {
      this.exitResolve = resolve
    })
    this.worker = createWorker(workerPath, {
      workerData: { databasePath },
      name: 'luma-catalog-writer',
    })
    this.worker.on('message', (message: CatalogResponse) => this.receive(message))
    this.worker.once('error', (error) => this.fail(error))
    this.worker.once('exit', (code) => {
      this.exited = true
      if (!this.closedAcknowledged || code !== 0)
        this.problem ??= new Error(`Catalog writer exited without a clean close (${code}).`)
      if (this.problem) {
        const error = new CatalogWriterFailure(
          'Catalog write acknowledgement was lost. Restart Luma before changing this library.',
          { cause: this.problem },
        )
        this.readyReject(error)
        for (const pending of this.pending.values()) pending.reject(error)
      } else if (this.pending.size) {
        // A close acknowledgement with live commands is a protocol error, never success.
        const error = new CatalogWriterFailure('Catalog writer closed with unconfirmed writes.')
        this.problem = error
        for (const pending of this.pending.values()) pending.reject(error)
      }
      this.pending.clear()
      this.exitResolve()
    })
  }
  open(): Promise<void> {
    return this.ready
  }
  private fail(error: unknown) {
    this.problem ??= error instanceof Error ? error : new Error(String(error))
    // Pending promises settle only from actual thread exit, after SQLite can no longer write.
    if (!this.exited) void this.worker.terminate().catch(() => undefined)
  }
  private receive(value: CatalogResponse) {
    if (this.problem || this.exited) return
    if (!value || typeof value !== 'object') {
      this.fail(new Error('Invalid catalog response.'))
      return
    }
    if (value.type === 'ready') {
      if (this.readySeen || this.closedAcknowledged) {
        this.fail(new Error('Repeated catalog readiness.'))
        return
      }
      this.readySeen = true
      this.readyResolve()
      return
    }
    if (value.type === 'closed') {
      if (!this.closeRequested || this.pending.size || !this.readySeen) {
        this.fail(new Error('Unexpected catalog close acknowledgement.'))
        return
      }
      this.closedAcknowledged = true
      return
    }
    if (
      (value.type !== 'result' && value.type !== 'rejected') ||
      !this.readySeen ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence !== this.pending.keys().next().value
    ) {
      this.fail(new Error('Unattributed or out-of-order catalog response.'))
      return
    }
    const pending = this.pending.get(value.sequence)!
    this.pending.delete(value.sequence)
    if (value.type === 'result') pending.resolve(value.value)
    else if (typeof value.message === 'string') pending.reject(new Error(value.message))
    else {
      this.pending.set(value.sequence, pending)
      this.fail(new Error('Invalid catalog rejection.'))
    }
  }
  command<K extends CatalogOperation>(command: CatalogCommand<K>): Promise<CatalogOutput<K>> {
    if (this.closeRequested || this.problem || this.exited)
      return Promise.reject(
        new Error('Catalog writes are unavailable. Restart Luma before changing this library.'),
      )
    // Capture caller-owned history/manifest objects before the first asynchronous boundary.
    const snapshot = structuredClone(command) as CatalogCommand
    const sequence = ++this.sequence
    const accepted = new Promise<unknown>((resolve, reject) => {
      this.pending.set(sequence, { resolve, reject })
    })
    void this.ready.then(
      () => {
        if (this.problem || this.exited) return
        try {
          this.worker.postMessage({
            type: 'mutate',
            sequence,
            command: snapshot,
          } satisfies CatalogRequest)
        } catch (error) {
          this.fail(error)
        }
      },
      () => undefined,
    )
    return accepted as Promise<CatalogOutput<K>>
  }
  close(): Promise<void> {
    if (!this.closeRequested) {
      this.closeRequested = true
      // FIFO follows every command admitted before close, including during startup.
      void this.ready.then(
        () => {
          if (this.problem || this.exited) return
          try {
            this.worker.postMessage({ type: 'close' } satisfies CatalogRequest)
          } catch (error) {
            this.fail(error)
          }
        },
        () => undefined,
      )
    }
    return this.exit
  }
}
