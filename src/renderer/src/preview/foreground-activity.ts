import type { ForegroundActivity, IrodoriApi } from '../../../shared/contracts'

export class ForegroundActivityClient {
  private activityId = crypto.randomUUID()
  private sequence = 0
  private reasons = new Set<object>()
  private heartbeat?: ReturnType<typeof setInterval>
  private pulseTimer?: ReturnType<typeof setTimeout>
  private pulseRelease?: () => void
  constructor(
    private target: Pick<ForegroundActivity, 'photoId' | 'reviewId'>,
    private report: IrodoriApi['reportForegroundActivity'],
  ) {}
  private send(active: boolean) {
    void this.report({
      ...this.target,
      activityId: this.activityId,
      sequence: ++this.sequence,
      active,
    }).catch(() => undefined)
  }
  begin() {
    const token = {}
    this.reasons.add(token)
    if (!this.heartbeat) {
      this.send(true)
      this.heartbeat = setInterval(() => this.send(true), 500)
    }
    return () => {
      this.reasons.delete(token)
      if (!this.reasons.size && this.heartbeat) {
        clearInterval(this.heartbeat)
        this.heartbeat = undefined
        this.send(false)
      }
    }
  }
  pulse() {
    this.pulseRelease ??= this.begin()
    clearTimeout(this.pulseTimer)
    this.pulseTimer = setTimeout(() => {
      this.pulseRelease?.()
      this.pulseRelease = undefined
    }, 150)
  }
  clear() {
    clearTimeout(this.pulseTimer)
    this.pulseRelease = undefined
    this.reasons.clear()
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.send(false)
  }
}
