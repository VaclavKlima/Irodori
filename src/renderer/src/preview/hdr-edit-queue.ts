export type HdrRequestIntent = 'interactive' | 'navigation' | 'refinement'
export interface HdrEditRequest<T> {
  readonly serial: number
  readonly epoch: number
  readonly intent: HdrRequestIntent
  readonly value: T
}
/** Intent controls supersession independently of the rendering's sampling quality. */
export class HdrEditQueue<T> {
  private serial = 0
  private epoch = 0
  private pending?: HdrEditRequest<T>
  private active?: HdrEditRequest<T>
  private completed = 0
  request(value: T, intent: HdrRequestIntent) {
    const request = Object.freeze({ serial: ++this.serial, epoch: this.epoch, intent, value })
    this.pending = request
    return request.serial
  }
  invalidate() {
    this.epoch++
    this.pending = undefined
  }
  take() {
    if (this.active || !this.pending) return undefined
    this.active = this.pending
    this.pending = undefined
    return this.active
  }
  superseded(request: HdrEditRequest<T>) {
    return request.epoch !== this.epoch || (request.intent === 'refinement' && !!this.pending)
  }
  get hasPending() {
    return !!this.pending
  }
  finish(request: HdrEditRequest<T>) {
    if (this.active !== request) return false
    this.active = undefined
    // Sharp completed movement and interactive frames advance even when more input arrives.
    if (
      request.epoch !== this.epoch ||
      request.serial <= this.completed ||
      (request.intent === 'refinement' && this.pending)
    )
      return false
    this.completed = request.serial
    return true
  }
}
