import {
  COLLECTION_CHUNK_SIZE,
  collectionPolicy,
  type CollectionPolicy,
} from '../../../shared/collections'

interface Job<T = unknown> {
  key: string
  priority: number
  signal: AbortSignal
  work: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  promise: Promise<T>
  started: boolean
}
/** One bounded queue serves metadata reads and app-owned thumbnail decoding. */
export class CollectionQueue {
  private jobs = new Map<string, Job>()
  private running = 0
  constructor(public concurrency: number) {}
  request<T>(
    key: string,
    priority: number,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const existing = this.jobs.get(key)
    if (existing && !existing.signal.aborted) {
      existing.priority = Math.min(priority, existing.priority)
      return existing.promise as Promise<T>
    }
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    const job = { key, priority, signal, work, resolve, reject, promise, started: false }
    this.jobs.set(key, job as Job)
    signal.addEventListener(
      'abort',
      () => {
        if (!job.started && this.jobs.get(key) === job) this.jobs.delete(key)
        reject(new DOMException('Cancelled', 'AbortError'))
        this.pump()
      },
      { once: true },
    )
    this.pump()
    return promise
  }
  promote(key: string, priority: number) {
    const job = this.jobs.get(key)
    if (job && !job.signal.aborted) job.priority = Math.min(priority, job.priority)
  }
  private pump() {
    while (this.running < this.concurrency) {
      const job = [...this.jobs.values()]
        .filter((j) => !j.started && !j.signal.aborted)
        .sort((a, b) => a.priority - b.priority)[0]
      if (!job) return
      job.started = true
      this.running++
      void Promise.resolve()
        .then(job.work)
        .then((value) => {
          if (!job.signal.aborted) job.resolve(value)
        }, job.reject)
        .finally(() => {
          if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
          this.running--
          this.pump()
        })
    }
  }
  get pending() {
    return this.jobs.size
  }
}
let policy = collectionPolicy()
export const collectionQueue = new CollectionQueue(policy.concurrency)
export function configureCollections(value: CollectionPolicy) {
  policy = value
  collectionQueue.concurrency = value.concurrency
}
export function currentCollectionPolicy() {
  return policy
}

export interface CollectionWindow {
  visible: number[]
  overscan: number[]
  lookahead: number[]
  pinned?: number[]
  active: boolean
}
export interface CollectionRead<T> {
  records: T[]
  contentRevision?: number
}
export interface CollectionSnapshot<T> {
  records: ReadonlyMap<number, T>
  loading: boolean
  error: string
  version: number
}
let nextController = 0
/** Selection, focus, and preview state never live in this evictable cache. */
export class CollectionController<T> {
  private namespace = ++nextController
  private key = ''
  private total = 0
  private generation = 0
  private read!: (offset: number, signal: AbortSignal) => Promise<CollectionRead<T>>
  private listeners = new Set<() => void>()
  private requests = new Map<number, { abort: AbortController; promise: Promise<void> }>()
  private revisions = new Map<number, number>()
  private accessed = new Map<number, number>()
  private clock = 0
  private window: CollectionWindow = { visible: [], overscan: [], lookahead: [], active: false }
  private snapshot: CollectionSnapshot<T> = {
    records: new Map(),
    loading: false,
    error: '',
    version: 0,
  }
  constructor(
    private queue = collectionQueue,
    private resources = currentCollectionPolicy,
    private onStale?: (error: unknown) => boolean,
  ) {}
  setStaleHandler(handler?: (error: unknown) => boolean) {
    this.onStale = handler
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  configure(
    key: string,
    total: number,
    read: (offset: number, signal: AbortSignal) => Promise<CollectionRead<T>>,
  ) {
    this.read = read
    this.total = total
    if (this.key !== key) {
      this.generation++
      this.cancel()
      this.key = key
      this.revisions.clear()
      this.accessed.clear()
      this.publish({ records: new Map(), error: '' })
    }
    this.schedule()
  }
  setWindow(window: CollectionWindow) {
    const pinned = new Set([...window.visible, ...window.overscan, ...(window.pinned ?? [])])
    this.window = {
      ...window,
      lookahead: window.lookahead.slice(0, Math.max(0, this.resources().records - pinned.size)),
    }
    const wanted = this.offsets()
    for (const [offset, request] of this.requests)
      if (!wanted.has(offset)) {
        request.abort.abort()
        this.requests.delete(offset)
      }
    for (const index of [...window.visible, ...window.overscan, ...(window.pinned ?? [])])
      this.accessed.set(index, ++this.clock)
    this.evict()
    this.schedule()
  }
  private offsets() {
    const result = new Map<number, number>()
    if (!this.window.active) return result
    for (const [indices, priority] of [
      [this.window.lookahead, 2],
      [this.window.overscan, 1],
      [this.window.visible, 0],
      [this.window.pinned ?? [], 0],
    ] as const)
      for (const index of indices)
        if (index >= 0 && index < this.total) {
          const offset = Math.floor(index / COLLECTION_CHUNK_SIZE) * COLLECTION_CHUNK_SIZE
          result.set(offset, Math.min(priority, result.get(offset) ?? priority))
        }
    return result
  }
  private hasChunk(offset: number) {
    for (let i = offset; i < Math.min(this.total, offset + COLLECTION_CHUNK_SIZE); i++)
      if (!this.snapshot.records.has(i)) return false
    return true
  }
  private visibleLoading() {
    return (
      this.window.active &&
      [...this.window.visible, ...this.window.overscan, ...(this.window.pinned ?? [])].some(
        (index) => index >= 0 && index < this.total && !this.snapshot.records.has(index),
      )
    )
  }
  private schedule() {
    if (!this.read || !this.window.active) return
    for (const [offset, priority] of [...this.offsets()].sort((a, b) => a[1] - b[1])) {
      if (!this.hasChunk(offset)) void this.load(offset, priority).catch(() => {})
      else if (this.requests.has(offset)) void this.load(offset, priority).catch(() => {})
    }
    this.publish({ loading: this.visibleLoading() })
  }
  private load(offset: number, priority: number): Promise<void> {
    const existing = this.requests.get(offset)
    const generation = this.generation
    const key = `${this.namespace}:${this.key}:${generation}:${offset}`
    if (existing) {
      // Upgrade a queued speculative read when its chunk enters the viewport.
      this.queue.promote(key, priority)
      return existing.promise
    }
    const abort = new AbortController()
    const read = this.read
    const promise = this.queue
      .request(key, priority, abort.signal, () => read(offset, abort.signal))
      .then((chunk) => {
        if (abort.signal.aborted || generation !== this.generation) return
        if ((this.revisions.get(offset) ?? -1) > (chunk.contentRevision ?? 0)) return
        this.revisions.set(offset, chunk.contentRevision ?? 0)
        const records = new Map(this.snapshot.records)
        for (const [i, record] of chunk.records.entries()) {
          if (offset + i >= this.total) break
          records.set(offset + i, record)
          this.accessed.set(offset + i, ++this.clock)
        }
        this.publish({ records, error: '' })
        this.evict()
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || generation !== this.generation) throw error
        if (!this.onStale?.(error)) this.publish({ error: String(error) })
        throw error
      })
      .finally(() => {
        if (this.requests.get(offset)?.abort === abort) this.requests.delete(offset)
        this.publish({ loading: this.visibleLoading() })
      })
    this.requests.set(offset, { abort, promise })
    return promise
  }
  private evict() {
    const pinned = new Set([
      ...this.window.visible,
      ...this.window.overscan,
      ...(this.window.pinned ?? []),
    ])
    const capacity = Math.max(this.resources().records, pinned.size)
    if (this.snapshot.records.size <= capacity) return
    const records = new Map(this.snapshot.records)
    const candidates = [...records.keys()]
      .filter((i) => !pinned.has(i))
      .sort((a, b) => (this.accessed.get(a) ?? 0) - (this.accessed.get(b) ?? 0))
    for (const index of candidates) {
      if (records.size <= capacity) break
      records.delete(index)
      this.accessed.delete(index)
    }
    this.publish({ records })
  }
  async get(index: number): Promise<T | undefined> {
    if (index < 0 || index >= this.total) return
    this.window = { ...this.window, pinned: [...new Set([...(this.window.pinned ?? []), index])] }
    this.accessed.set(index, ++this.clock)
    if (!this.snapshot.records.has(index))
      await this.load(Math.floor(index / COLLECTION_CHUNK_SIZE) * COLLECTION_CHUNK_SIZE, 0)
    return this.snapshot.records.get(index)
  }
  async refreshWindow(minimumContentRevision = Infinity) {
    if (!this.window.active) return
    const generation = this.generation
    await Promise.all(
      [...this.offsets()]
        .filter(([, priority]) => priority < 2)
        .map(async ([offset, priority]) => {
          const pending = this.requests.get(offset)
          if (pending) await pending.promise
          if (generation !== this.generation || !this.offsets().has(offset)) return
          if ((this.revisions.get(offset) ?? -1) < minimumContentRevision)
            await this.load(offset, priority)
        }),
    )
  }
  retry() {
    this.publish({ error: '' })
    this.schedule()
  }
  cancel() {
    for (const request of this.requests.values()) request.abort.abort()
    this.requests.clear()
    this.publish({ loading: false })
  }
  suspend() {
    this.window = { ...this.window, active: false }
    this.cancel()
  }
  close() {
    this.generation++
    this.suspend()
    this.listeners.clear()
  }
  private publish(change: Partial<CollectionSnapshot<T>>) {
    if (
      Object.entries(change).every(
        ([key, value]) => this.snapshot[key as keyof CollectionSnapshot<T>] === value,
      )
    )
      return
    this.snapshot = { ...this.snapshot, ...change, version: this.snapshot.version + 1 }
    for (const listener of this.listeners) listener()
  }
}

/** Events during a read dirty one serialized follow-up, instead of overlapping windows. */
export class CollectionRefresh {
  private running?: Promise<void>
  private dirty = false
  private closed = false
  constructor(private work: () => Promise<void>) {}
  setWork(work: () => Promise<void>) {
    this.work = work
  }
  resume() {
    this.closed = false
  }
  request(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.dirty = true
    if (!this.running)
      this.running = (async () => {
        while (this.dirty && !this.closed) {
          this.dirty = false
          await this.work()
        }
      })().finally(() => {
        this.running = undefined
      })
    return this.running
  }
  close() {
    this.closed = true
    this.dirty = false
  }
}
