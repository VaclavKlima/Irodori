import { AsyncLocalStorage } from 'node:async_hooks'

type Priority = 'interactive' | 'operation'
interface Owner {
  priority: Priority
  mutation?: boolean
}
export class ForegroundYield extends Error {
  constructor() {
    super('Background preparation yielded to foreground work.')
  }
}

/** Foreground demand stops admission immediately. Native work drains before handoff. */
export class WorkScheduler {
  private context = new AsyncLocalStorage<Owner>()
  private interactive = 0
  private activities = new Set<string>()
  private operations: object[] = []
  private operation?: object
  private backgroundJobs = new Set<AbortController | undefined>()
  private backgroundCount = 0
  private critical = false
  private listeners = new Set<() => void>()
  private closed = false
  private exportPending = 0
  private exporting?: AbortController
  detached<T>(work: () => T): T {
    return this.context.exit(work)
  }

  get interactivePending() {
    return this.interactive > 0 || this.activities.size > 0
  }
  get mutating() {
    return this.critical
  }
  get waitingReason(): 'foreground' | 'library-operation' | 'export' | undefined {
    return this.interactivePending
      ? 'foreground'
      : this.operations.length || this.operation
        ? 'library-operation'
        : this.exportPending
          ? 'export'
          : undefined
  }
  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed() {
    if (this.interactivePending || this.operations.length || this.operation)
      this.exporting?.abort(new ForegroundYield())
    if (this.waitingReason) for (const job of this.backgroundJobs) job?.abort(new ForegroundYield())
    for (const listener of [...this.listeners]) listener()
  }
  activity(id: string, active: boolean) {
    if (active && !this.closed) {
      if (this.activities.has(id)) return
      this.activities.add(id)
    } else if (!this.activities.delete(id)) return
    this.changed()
  }
  private async wait(ready: () => boolean, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('The work scheduler is closed.')
    if (ready()) return
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        this.listeners.delete(check)
        signal?.removeEventListener('abort', abort)
      }
      const abort = () => {
        clean()
        reject(signal?.reason)
      }
      const check = () => {
        if (this.closed) {
          clean()
          reject(new Error('The work scheduler is closed.'))
        } else if (ready()) {
          clean()
          resolve()
        }
      }
      this.listeners.add(check)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else check()
    })
  }
  async run<T>(priority: Priority, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Metadata, analysis and publication invoked by an admitted owner inherit it.
    if (this.context.getStore()) {
      signal?.throwIfAborted()
      return work()
    }
    const ticket = {}
    if (priority === 'interactive') this.interactive++
    else this.operations.push(ticket)
    this.changed()
    try {
      const ready = () =>
        !this.critical &&
        !this.exporting &&
        this.backgroundCount === 0 &&
        (priority === 'interactive' ||
          (!this.interactivePending && !this.operation && this.operations[0] === ticket))
      do {
        await this.wait(ready, signal)
      } while (!ready())
      if (priority === 'operation') {
        this.operations.shift()
        this.operation = ticket
      }
      return await this.context.run({ priority }, work)
    } finally {
      if (priority === 'interactive') this.interactive--
      else {
        this.operations = this.operations.filter((t) => t !== ticket)
        if (this.operation === ticket) this.operation = undefined
      }
      this.changed()
    }
  }
  async checkpoint(signal?: AbortSignal): Promise<boolean> {
    const owner = this.context.getStore()
    const ready = () =>
      owner?.priority === 'interactive' ||
      (owner?.priority === 'operation' ? !this.interactivePending : !this.waitingReason)
    const paused = !ready()
    await this.wait(ready, signal)
    return paused
  }
  async background<T>(
    work: (signal: AbortSignal, paused: boolean) => Promise<T>,
    signal: AbortSignal,
    interruptible = false,
  ): Promise<T> {
    let paused = false
    do {
      paused = (await this.checkpoint(signal)) || paused
    } while (this.waitingReason)
    const controller = interruptible ? new AbortController() : undefined
    const jobSignal = controller ? AbortSignal.any([signal, controller.signal]) : signal
    if (controller) this.backgroundJobs.add(controller)
    this.backgroundCount++
    try {
      return await work(jobSignal, paused)
    } catch (error) {
      if (!signal.aborted && controller?.signal.aborted) throw new ForegroundYield()
      throw error
    } finally {
      if (controller) this.backgroundJobs.delete(controller)
      this.backgroundCount--
      this.changed()
    }
  }
  /** Export owns the expensive background allowance; imports drain before admission.
   * Foreground requests abort its isolated worker and retry the unfinished file. */
  async export<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    this.exportPending++
    this.changed()
    const controller = new AbortController()
    const ready = () =>
      !this.interactivePending &&
      !this.operation &&
      !this.operations.length &&
      !this.critical &&
      !this.backgroundCount &&
      !this.exporting
    try {
      do {
        await this.wait(ready, signal)
      } while (!ready())
      this.exporting = controller
      return await work(AbortSignal.any([signal, controller.signal]))
    } catch (error) {
      if (!signal.aborted && controller.signal.aborted) throw new ForegroundYield()
      throw error
    } finally {
      if (this.exporting === controller) this.exporting = undefined
      this.exportPending--
      this.changed()
    }
  }
  async mutate<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = this.context.getStore()
    if (owner?.mutation) return work()
    const ready = () =>
      !this.critical &&
      (owner?.priority === 'interactive' ||
        (owner?.priority === 'operation' ? !this.interactivePending : !this.waitingReason))
    do {
      await this.wait(ready, signal)
    } while (!ready())
    this.critical = true
    try {
      return await this.context.run(
        { priority: owner?.priority ?? 'operation', mutation: true },
        work,
      )
    } finally {
      this.critical = false
      this.changed()
    }
  }
  close() {
    this.closed = true
    this.activities.clear()
    this.changed()
  }
}
