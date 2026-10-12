export interface HdrEditRequest<T> {
  serial: number
  epoch: number
  draft: boolean
  navigation: boolean
  value: T
}
/** One active immutable snapshot and one replaceable pending request. */
export class HdrEditQueue<T> {
  private serial = 0
  private epoch = 0
  private pending?: HdrEditRequest<T>
  private active?: HdrEditRequest<T>
  private completed = 0
  request(value: T, draft: boolean, navigation = false) {
    const request = { serial: ++this.serial, epoch: this.epoch, draft, navigation, value }
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
    return request.epoch !== this.epoch || (!request.draft && !request.navigation && !!this.pending)
  }
  get hasPending() {
    return !!this.pending
  }
  finish(request: HdrEditRequest<T>) {
    if (this.active !== request) return false
    this.active = undefined
    // Movement and adjustment drafts advance during input. Idle refinement yields to new input.
    if (
      request.epoch !== this.epoch ||
      request.serial <= this.completed ||
      (!request.draft && !request.navigation && this.pending)
    )
      return false
    this.completed = request.serial
    return true
  }
}
