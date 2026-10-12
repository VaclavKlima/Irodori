import type { ForegroundActivity } from '../shared/contracts'
import { WorkScheduler } from './work-scheduler'

/** Renderer leases expire even if its process stops sending completion messages. */
export class ForegroundActivities {
  private entries = new Map<string, { sequence: number; timer?: ReturnType<typeof setTimeout> }>()
  constructor(
    private scheduler: WorkScheduler,
    private expiryMs = 2000,
    private idleMs = 150,
  ) {}
  report(value: ForegroundActivity) {
    const entry = this.entries.get(value.activityId)
    if (entry && value.sequence <= entry.sequence) return
    clearTimeout(entry?.timer)
    const next = {
      sequence: value.sequence,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    this.entries.set(value.activityId, next)
    if (value.active) this.scheduler.activity(value.activityId, true)
    next.timer = setTimeout(
      () => {
        next.timer = undefined
        this.scheduler.activity(value.activityId, false)
        // Retain recent sequence tombstones so delayed releases cannot revive a lease.
        if (this.entries.size > 2048)
          for (const [id, old] of this.entries) {
            if (!old.timer) this.entries.delete(id)
            if (this.entries.size <= 2048) break
          }
      },
      value.active ? this.expiryMs : this.idleMs,
    )
    next.timer.unref()
  }
  clear() {
    for (const [id, entry] of this.entries) {
      clearTimeout(entry.timer)
      this.scheduler.activity(id, false)
    }
    this.entries.clear()
  }
}
