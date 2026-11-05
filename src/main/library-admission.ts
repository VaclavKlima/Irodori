import { AsyncLocalStorage } from 'node:async_hooks'

/** Library entry-to-completion ownership, including validation before scheduler admission. */
export class LibraryAdmission {
  private accepted = new Set<Promise<unknown>>()
  private context = new AsyncLocalStorage<boolean>()
  private sealed = false
  tasksPaused = false

  assertTask(): void {
    if (!this.context.getStore() && (this.tasksPaused || this.sealed))
      throw new Error('Finish closing the application before starting another library operation.')
  }

  run<T>(work: () => Promise<T>, checkpoint = false): Promise<T> {
    if (this.context.getStore()) return work()
    if (this.sealed && !checkpoint) return Promise.reject(new Error('This library is closing.'))
    let start!: () => void
    const pending = new Promise<T>((resolve, reject) => {
      start = () => {
        try {
          resolve(work())
        } catch (error) {
          reject(error)
        }
      }
    })
    this.accepted.add(pending)
    void pending.then(
      () => this.accepted.delete(pending),
      () => this.accepted.delete(pending),
    )
    this.context.run(true, start)
    return pending
  }

  seal(): void {
    this.sealed = true
    this.tasksPaused = true
  }

  async drain(): Promise<void> {
    while (this.accepted.size) await Promise.allSettled([...this.accepted])
  }
}
