import type { AdjustmentParameters } from '../../../shared/adjustments'
/** At most one in-flight job and one latest draft; completion bypasses the throttle. */
export class AnalysisQueue {
  private generation = 0
  private busy = false
  private last = 0
  private pending?: { parameters: AdjustmentParameters; generation: number; immediate: boolean }
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private releaseActivity?: () => void
  constructor(
    private worker: Pick<Worker, 'postMessage' | 'terminate'>,
    private identity: string,
    private masks: boolean,
    private activity?: () => () => void,
  ) {}
  update(parameters: AdjustmentParameters, immediate: boolean) {
    if (this.closed) return
    this.releaseActivity ??= this.activity?.()
    this.pending = { parameters, generation: ++this.generation, immediate }
    this.send()
  }
  accepts(result: { generation: number; identity: string }): boolean {
    return (
      !this.closed && result.identity === this.identity && result.generation === this.generation
    )
  }
  finished() {
    this.busy = false
    this.send()
    if (!this.pending) {
      this.releaseActivity?.()
      this.releaseActivity = undefined
    }
  }
  private send() {
    clearTimeout(this.timer)
    if (this.closed || this.busy || !this.pending) return
    const delay = this.pending.immediate ? 0 : Math.max(0, 100 - (performance.now() - this.last))
    this.timer = setTimeout(() => {
      if (this.closed || this.busy || !this.pending) return
      this.busy = true
      this.last = performance.now()
      this.worker.postMessage({ ...this.pending, identity: this.identity, masks: this.masks })
      this.pending = undefined
    }, delay)
  }
  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.worker.terminate()
    this.releaseActivity?.()
    this.releaseActivity = undefined
  }
}
