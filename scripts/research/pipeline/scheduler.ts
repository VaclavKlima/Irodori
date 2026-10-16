export interface Job<T> {
  kind: 'foreground' | 'background'
  signal?: AbortSignal
  // Each asynchronous step owns a bounded tile or codec phase and yields resources.
  steps: AsyncGenerator<unknown, T>
}
/** Cooperative prototype: at most one step owns compute, and two photos are admitted. */
export class ResearchScheduler {
  private jobs: {
    job: Job<unknown>
    resolve(value: unknown): void
    reject(error: unknown): void
  }[] = []
  private running = false
  private foreground = false
  setEditing(value: boolean) {
    this.foreground = value
  }
  submit<T>(job: Job<T>): Promise<T> {
    if (this.jobs.length >= 2)
      return Promise.reject(new Error('Two-photo research admission limit reached.'))
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ job, resolve: (value) => resolve(value as T), reject })
      void this.drain()
    })
  }
  private async drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.jobs.length) {
        const entry = this.jobs.find((j) => j.job.kind === 'foreground') ?? this.jobs[0]
        try {
          entry.job.signal?.throwIfAborted()
          const result = await entry.job.steps.next()
          entry.job.signal?.throwIfAborted()
          if (result.done) {
            this.jobs.splice(this.jobs.indexOf(entry), 1)
            entry.resolve(result.value)
          } else {
            // Round-robin background photos only after the foreground queue empties.
            this.jobs.splice(this.jobs.indexOf(entry), 1)
            this.jobs.push(entry)
          }
        } catch (error) {
          this.jobs.splice(this.jobs.indexOf(entry), 1)
          try {
            await entry.job.steps.return(undefined)
          } catch {
            /* Keep the original job failure. */
          }
          entry.reject(error)
        }
        // Yield even when steps are synchronous; interaction can admit foreground work.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.foreground && entry.job.kind === 'background' ? 4 : 0),
        )
      }
    } finally {
      this.running = false
    }
  }
}
