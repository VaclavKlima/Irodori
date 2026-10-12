import { mkdir } from 'node:fs/promises'
import type { Photo } from '../shared/contracts'
import { PreviewProcess } from './preview-process'
import type { ThumbnailProcessor } from './preview-types'

export interface ReviewThumbnailInput {
  id: string
  path: string
  output: string
}

export interface ReviewThumbnailState {
  state: 'idle' | 'loading' | 'ready' | 'error'
  source?: Photo['previewSource']
  error?: string
}

type ActiveThumbnail = { input: ReviewThumbnailInput; abort: AbortController }

/** One review owns independent lightweight and lower-priority RAW decoder queues. */
export class ReviewThumbnails {
  private visible = new Map<string, ReviewThumbnailInput>()
  private completed = new Set<string>()
  private lightQueue: ReviewThumbnailInput[] = []
  private fallbackQueue: ReviewThumbnailInput[] = []
  private lightActive?: ActiveThumbnail
  private fallbackActive?: ActiveThumbnail
  private lightTask?: Promise<void>
  private fallbackTask?: Promise<void>
  private closed = false
  private cancellation?: Promise<void>

  constructor(
    private onState: (id: string, state: ReviewThumbnailState) => void,
    private light: ThumbnailProcessor = new PreviewProcess(),
    private fallback: ThumbnailProcessor = new PreviewProcess(),
  ) {}

  request(inputs: readonly ReviewThumbnailInput[]): void {
    if (this.closed) return
    const previous = this.visible
    this.visible = new Map(inputs.map((input) => [input.id, input]))
    for (const id of previous.keys())
      if (!this.visible.has(id) && !this.completed.has(id)) this.onState(id, { state: 'idle' })
    for (const active of [this.lightActive, this.fallbackActive])
      if (active && !this.visible.has(active.input.id)) active.abort.abort()
    this.fallbackQueue = this.fallbackQueue.filter((input) => this.visible.has(input.id))
    const awaitingFallback = new Set(this.fallbackQueue.map((input) => input.id))
    // Even an aborted fallback retains its output until its worker has exited.
    if (this.fallbackActive) awaitingFallback.add(this.fallbackActive.input.id)
    const activeLight =
      this.lightActive && !this.lightActive.abort.signal.aborted
        ? this.lightActive.input.id
        : undefined
    this.lightQueue = [...this.visible.values()]
      .filter(
        (input) =>
          !this.completed.has(input.id) &&
          !awaitingFallback.has(input.id) &&
          input.id !== activeLight,
      )
      .sort((a, b) => Number(previous.has(a.id)) - Number(previous.has(b.id)))
    this.pumpLight()
    this.pumpFallback()
  }

  private current(active: ActiveThumbnail): boolean {
    return !this.closed && !active.abort.signal.aborted && this.visible.has(active.input.id)
  }

  private async generate(active: ActiveThumbnail, fallback: boolean): Promise<void> {
    const { input, abort } = active
    try {
      if (!fallback) this.onState(input.id, { state: 'loading' })
      await mkdir(input.output, { recursive: true })
      abort.signal.throwIfAborted()
      const result = await (fallback ? this.fallback : this.light).thumbnail(
        input.path,
        input.output,
        abort.signal,
        fallback,
      )
      if (!this.current(active)) return
      if (result.state === 'needs-fallback') {
        if (fallback) throw new Error('No usable thumbnail could be generated.')
        this.fallbackQueue.push(input)
      } else {
        this.completed.add(input.id)
        this.onState(input.id, { state: 'ready', source: result.source })
      }
    } catch (error) {
      if (!this.current(active)) return
      this.completed.add(input.id)
      this.onState(input.id, {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private pumpLight(): void {
    if (this.closed || this.lightTask || !this.lightQueue.length) return
    this.lightTask = (async () => {
      while (!this.closed && this.lightQueue.length) {
        const input = this.lightQueue.shift()!
        if (!this.visible.has(input.id)) continue
        const active = { input, abort: new AbortController() }
        this.lightActive = active
        await this.generate(active, false)
        this.lightActive = undefined
      }
    })().finally(() => {
      this.lightTask = undefined
      this.pumpLight()
      this.pumpFallback()
    })
  }

  private pumpFallback(): void {
    if (this.closed || this.lightTask || this.fallbackTask || !this.fallbackQueue.length) return
    this.fallbackTask = (async () => {
      while (!this.closed && !this.lightTask && this.fallbackQueue.length) {
        const input = this.fallbackQueue.shift()!
        if (!this.visible.has(input.id)) continue
        const active = { input, abort: new AbortController() }
        this.fallbackActive = active
        await this.generate(active, true)
        this.fallbackActive = undefined
        if (active.abort.signal.aborted && this.visible.has(input.id) && !this.closed) {
          this.lightQueue.unshift(this.visible.get(input.id)!)
          this.pumpLight()
        }
      }
    })().finally(() => {
      this.fallbackTask = undefined
      this.pumpFallback()
    })
  }

  cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation
    this.closed = true
    this.lightQueue = []
    this.fallbackQueue = []
    this.lightActive?.abort.abort()
    this.fallbackActive?.abort.abort()
    this.cancellation = (async () => {
      // Active processor promises settle after their workers exit. Callers can
      // remove review staging only once this promise has completed.
      await Promise.allSettled([this.lightTask, this.fallbackTask])
      await Promise.all([this.light.close(), this.fallback.close()])
      this.visible.clear()
    })()
    return this.cancellation
  }
}
