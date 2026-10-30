import { setImmediate as yieldToInput } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import type { BackgroundTask, Photo } from '../shared/contracts'
import type { EditPatch, EditState } from '../shared/edits'
import type { ProcessingMetadata } from '../shared/lens'
import {
  copiedEdits,
  editTransferCapabilities,
  transferPatch,
  transferUnavailable,
  validateTransferGroups,
  type CopiedEdits,
  type EditPastePreparation,
  type EditApplicationOutcome,
  type PasteEditsRequest,
} from '../shared/edit-transfer'
import { validateExportPhotoIds } from '../shared/export'
import { EditApplicationStore, type ApplicationCommit } from './edit-application-store'
import type { WorkScheduler } from './work-scheduler'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
type ReadPhoto = { photo: Photo; state: EditState; metadata: ProcessingMetadata }

/** Metadata-only editing jobs: one admitted photo at a time, with normal interactive priority above it. */
export class EditTransfers {
  private clipboard?: CopiedEdits
  private copyGeneration = 0
  private preparations = new Map<
    string,
    { value: EditPastePreparation; source: CopiedEdits; created: number }
  >()
  private closed = false
  private preparing = 0
  private admission?: Promise<string>
  private accepting?: { id: string; abort: AbortController }
  private active?: { id: string; abort: AbortController; work: Promise<void> }
  private failure?: { id: string; message: string }
  constructor(
    readonly store: EditApplicationStore,
    private scheduler: WorkScheduler,
    private read: (id: string) => Promise<ReadPhoto>,
    private update: (
      id: string,
      patch: EditPatch,
      revision: number,
      application: ApplicationCommit,
    ) => Promise<EditState>,
    private flush: (ids: string[]) => Promise<void>,
    private changed: () => void,
  ) {}
  async recover() {
    for (const task of this.store.tasks()) {
      if (!['running', 'cancelling'].includes(task.status)) continue
      task.status = 'failed'
      task.phase = 'Interrupted'
      task.title = 'Edit application interrupted'
      task.detail =
        'Previously completed edits are retained. Unfinished photographs were not changed.'
      task.unprocessed = task.progress!.total - task.progress!.completed
      task.finishedAt = Date.now()
      await this.store.task(task)
    }
  }
  getClipboard() {
    return this.clipboard ? structuredClone(this.clipboard.clipboard) : null
  }
  async copy(id: string) {
    validateExportPhotoIds([id])
    const generation = ++this.copyGeneration
    await this.flush([id])
    const { photo, state, metadata } = await this.read(id)
    if (this.closed) throw new Error('This library is closed.')
    if (generation !== this.copyGeneration)
      throw new Error('A newer copy request replaced this one.')
    this.clipboard = copiedEdits(
      {
        id: randomUUID(),
        photoId: id,
        filename: photo.filename,
        revision: state.revision,
        copiedAt: new Date().toISOString(),
      },
      state.settings,
      metadata,
    )
    this.changed()
    return this.getClipboard()!
  }
  async prepare(request: PasteEditsRequest): Promise<EditPastePreparation> {
    if (this.preparing >= editTransferCapabilities.maxConcurrentPreparations)
      throw new Error('Wait for the current photo checks before preparing another paste.')
    this.preparing++
    try {
      return await this.prepareSnapshot(request)
    } finally {
      this.preparing--
    }
  }
  private async prepareSnapshot(request: PasteEditsRequest): Promise<EditPastePreparation> {
    if (
      !request ||
      Object.keys(request).some((key) => !['clipboardId', 'photoIds', 'groups'].includes(key))
    )
      throw new Error('Invalid paste request.')
    const photoIds = validateExportPhotoIds(request.photoIds),
      groups = structuredClone(request.groups)
    validateTransferGroups(groups)
    const source = this.clipboard && structuredClone(this.clipboard)
    if (!source || request.clipboardId !== source.clipboard.id)
      throw new Error('Copy edits before pasting.')
    transferPatch(source, groups)
    await this.flush(photoIds)
    const targets: EditPastePreparation['targets'] = []
    for (const photoId of photoIds) {
      if (targets.length % 64 === 0) await yieldToInput()
      if (this.closed) throw new Error('This library is closed.')
      try {
        const { photo, state, metadata } = await this.read(photoId)
        targets.push({
          photoId,
          filename: photo.filename,
          revision: state.revision,
          unavailable: transferUnavailable(source, groups, metadata),
        })
      } catch (error) {
        targets.push({ photoId, filename: photoId, revision: -1, unavailable: message(error) })
      }
    }
    if (this.closed) throw new Error('This library is closed.')
    const value = { id: randomUUID(), source: source.clipboard, groups, targets }
    for (const [id, entry] of this.preparations)
      if (Date.now() - entry.created > editTransferCapabilities.preparationTtlMs)
        this.preparations.delete(id)
    while (
      this.preparations.size &&
      (this.preparations.size >= editTransferCapabilities.maxPreparations ||
        [...this.preparations.values()].reduce(
          (n, p) => n + p.value.targets.length,
          targets.length,
        ) > editTransferCapabilities.maxPreparedTargets)
    )
      this.preparations.delete(this.preparations.keys().next().value!)
    this.preparations.set(value.id, { value: structuredClone(value), source, created: Date.now() })
    return structuredClone(value)
  }
  dispose(id: string) {
    this.preparations.delete(id)
  }
  start(id: string): Promise<string> {
    if (this.failure)
      return Promise.reject(new Error('Restart Irodori before starting another edit application.'))
    if (this.admission || this.active)
      return Promise.reject(new Error('Finish or cancel the current edit application first.'))
    const admission = this.begin(id)
    this.admission = admission
    void admission
      .finally(() => {
        if (this.admission === admission) this.admission = undefined
      })
      .catch(() => {})
    return admission
  }
  private async begin(preparationId: string) {
    const entry = this.preparations.get(preparationId)
    if (
      this.closed ||
      !entry ||
      Date.now() - entry.created > editTransferCapabilities.preparationTtlMs
    )
      throw new Error('Paste preparation expired. Open the paste chooser again.')
    const { value, source } = entry
    await this.flush(value.targets.map((target) => target.photoId))
    if (this.closed) throw new Error('This library is closed.')
    const id = randomUUID(),
      abort = new AbortController()
    const task: BackgroundTask = {
      id,
      kind: 'edit-application',
      title: 'Applying copied edits',
      status: 'running',
      phase: 'Applying',
      progress: { completed: 0, total: value.targets.length, unit: 'items' },
      errorCount: 0,
      editApplication: { applied: 0, unchanged: 0, conflict: 0, unavailable: 0, failed: 0 },
    }
    const accepting = { id, abort }
    this.accepting = accepting
    try {
      await this.store.accept(
        { version: 1, id, source, groups: value.groups, targets: value.targets },
        task,
      )
    } catch (error) {
      // A committed acceptance can be visible before the writer acknowledgement arrives.
      // Keep uncertain durable work inert until restart recovery classifies it.
      if (this.store.has(id)) {
        this.failure = {
          id,
          message: `Edit acceptance was not acknowledged. Restart Irodori; no destination edits were started. ${message(error)}`,
        }
        this.changed()
      }
      throw error
    } finally {
      if (this.accepting === accepting) this.accepting = undefined
    }
    this.preparations.delete(preparationId)
    if (this.closed) abort.abort()
    const active = { id, abort, work: Promise.resolve() }
    this.active = active
    active.work = this.scheduler
      .detached(() => this.run(id, value, source, abort.signal))
      .catch((error) => {
        this.failure = { id, message: message(error) }
        this.changed()
      })
      .finally(() => {
        if (this.active === active) this.active = undefined
      })
    this.changed()
    return id
  }
  private async run(
    id: string,
    preparation: EditPastePreparation,
    source: CopiedEdits,
    signal: AbortSignal,
  ) {
    const patch = transferPatch(source, preparation.groups)
    for (let ordinal = 0; ordinal < preparation.targets.length && !signal.aborted; ordinal++) {
      const target = preparation.targets[ordinal],
        commit = { id, ordinal }
      let outcome: EditApplicationOutcome = 'failed'
      try {
        await this.scheduler.run(
          'operation',
          async () => {
            signal.throwIfAborted()
            if (target.unavailable) {
              outcome = 'unavailable'
              throw new Error(target.unavailable)
            }
            const current = await this.read(target.photoId)
            if (current.state.revision !== target.revision) {
              outcome = 'conflict'
              throw new Error('Edits changed after preparation. This photograph was not changed.')
            }
            const reason = transferUnavailable(source, preparation.groups, current.metadata)
            if (reason) {
              outcome = 'unavailable'
              throw new Error(reason)
            }
            // Once publication is admitted, cancellation waits for its durable result.
            signal.throwIfAborted()
            await this.update(target.photoId, patch, target.revision, commit)
          },
          signal,
        )
      } catch (error) {
        // The edit and success marker commit together, even if acknowledgement was lost.
        if (['applied', 'unchanged'].includes(this.store.results(id, ordinal).results[0]?.outcome))
          continue
        if (signal.aborted) break
        if (outcome === 'failed' && /conflict/i.test(message(error))) outcome = 'conflict'
        await this.store.result(commit, { outcome, message: message(error) })
      }
      this.changed()
    }
    const task = this.store.job(id).task
    task.status = signal.aborted ? 'cancelled' : 'completed'
    task.phase = signal.aborted ? 'Cancelled' : 'Finished'
    task.title = signal.aborted ? 'Edit application cancelled' : 'Edit application finished'
    task.unprocessed = task.progress!.total - task.progress!.completed
    task.finishedAt = Date.now()
    await this.store.task(task)
    this.changed()
  }
  has(id: string) {
    return this.store.has(id)
  }
  hasActive() {
    return !!this.active || !!this.admission
  }
  list() {
    return this.store.tasks().map((stored) => {
      const task =
        ((this.active?.id === stored.id && this.active.abort.signal.aborted) ||
          (this.accepting?.id === stored.id && this.accepting.abort.signal.aborted)) &&
        stored.status === 'running'
          ? { ...stored, status: 'cancelling' as const, phase: 'Cancelling' }
          : stored
      return this.failure?.id === task.id
        ? {
            ...task,
            status: 'failed' as const,
            phase: 'Interrupted',
            detail: this.failure.message,
          }
        : task
    })
  }
  async cancel(id: string) {
    if (this.accepting?.id === id) {
      this.accepting.abort.abort()
      this.changed()
      await this.admission?.catch(() => {})
    }
    if (this.active?.id !== id) return
    const active = this.active
    active.abort.abort()
    this.changed()
    await active.work
  }
  stopAdmission() {
    this.closed = true
    this.clipboard = undefined
    this.preparations.clear()
    this.accepting?.abort.abort()
    this.active?.abort.abort()
  }
  async close() {
    this.stopAdmission()
    await this.admission?.catch(() => {})
    this.active?.abort.abort()
    await this.active?.work
  }
}
