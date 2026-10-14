import {
  DEFAULT_WORKSPACE,
  type WorkspaceChange,
  type WorkspaceSnapshot,
  type WorkspaceState,
} from '../../../shared/workspace'

/** Fixed 500ms interaction throttle: subsequent changes do not postpone a checkpoint. */
export class WorkspaceCheckpoint {
  private state: WorkspaceState = DEFAULT_WORKSPACE
  private committedState: WorkspaceState = DEFAULT_WORKSPACE
  private selected = new Set<string>()
  private committedSelected = this.selected
  private ready = false
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private closed = false
  private failed = false
  constructor(
    private save: (change: WorkspaceChange) => Promise<number>,
    private onStatus: (message: string) => void = () => {},
    private interval = 500,
  ) {}
  hydrate(snapshot: WorkspaceSnapshot) {
    this.state = { ...DEFAULT_WORKSPACE, ...snapshot.state }
    this.committedState = this.state
    this.selected = new Set(snapshot.selected.map((p) => p.id))
    this.committedSelected = this.selected
    this.ready = true
  }
  patch(change: Partial<WorkspaceState>) {
    if (!this.ready || this.closed) return
    if (
      Object.entries(change).every(
        ([key, value]) =>
          JSON.stringify(this.state[key as keyof WorkspaceState]) === JSON.stringify(value),
      )
    )
      return
    this.state = { ...this.state, ...change }
    this.schedule()
  }
  selection(ids: Iterable<string>) {
    if (!this.ready || this.closed) return
    const next = new Set(ids)
    if (next.size === this.selected.size && [...next].every((id) => this.selected.has(id))) return
    this.selected = next
    this.schedule()
  }
  private dirty() {
    return this.state !== this.committedState || this.selected !== this.committedSelected
  }
  private schedule() {
    if (!this.ready || this.closed || this.timer || this.failed || !this.dirty()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => {})
    }, this.interval)
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.ready || this.closed) return Promise.resolve()
    if (this.running) return this.running.then(() => (this.dirty() ? this.flush() : undefined))
    this.running = (async () => {
      if (!this.dirty()) return
      const state = this.state,
        selected = this.selected
      const change: WorkspaceChange = {}
      const scalar = Object.fromEntries(
        Object.entries(state).filter(
          ([key, value]) =>
            JSON.stringify(value) !==
            JSON.stringify(this.committedState[key as keyof WorkspaceState]),
        ),
      )
      if (Object.keys(scalar).length) change.state = scalar
      const added = [...selected].filter((id) => !this.committedSelected.has(id)),
        removed = [...this.committedSelected].filter((id) => !selected.has(id))
      if (added.length || removed.length) change.selection = { added, removed }
      try {
        await this.save(change)
        this.committedState = state
        this.committedSelected = selected
        this.failed = false
        this.onStatus('')
      } catch (error) {
        this.failed = true
        this.onStatus('Workspace recovery could not be saved.')
        throw error
      }
    })().finally(() => {
      this.running = undefined
      if (!this.failed) this.schedule()
    })
    return this.running
  }
  retry() {
    this.failed = false
    return this.flush()
  }
  resume() {
    this.closed = false
    this.schedule()
  }
  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
