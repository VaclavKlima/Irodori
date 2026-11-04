import { randomUUID } from 'node:crypto'
import { COLLECTION_CHUNK_SIZE } from '../../shared/contracts'
import type { EditorContext, EditorContextSnapshot } from '../../shared/agent'
import { agentTools } from './policy'

interface Revision {
  revision: number
  conflicted: boolean
  refreshed: boolean
}
interface FrozenRequest {
  context: EditorContextSnapshot
  requestId: string
  targets: Map<string, Revision>
  paused: boolean
  preparations: Set<string>
}

/** Transport-side ownership is independent of model instructions and hook tool denial. */
export class AgentRequestGate {
  private current?: FrozenRequest
  private beginning: Promise<unknown> = Promise.resolve()
  private pending = new Set<Promise<unknown>>()
  private tasks = new Set<string>()
  private controller = new AbortController()
  get signal() {
    return this.controller.signal
  }
  private accepting = true
  private turn?: { sessionId: string; turnId: string }
  constructor(
    private capture: () => Promise<EditorContextSnapshot>,
    private revision: (id: string) => Promise<number>,
    readonly development: boolean,
    private conversation: (id: string) => Promise<void> = async () => {},
  ) {}

  begin(sessionId: unknown, turnId: unknown): Promise<EditorContext> {
    const work = this.beginning.then(() => this.beginNow(sessionId, turnId))
    this.beginning = work.catch(() => {})
    return work
  }
  private async beginNow(sessionId: unknown, turnId: unknown) {
    if (
      !this.accepting ||
      typeof sessionId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(sessionId) ||
      typeof turnId !== 'string' ||
      turnId.length > 200
    )
      throw new Error('Invalid or stopped agent request.')
    this.end()
    await this.drain()
    this.controller = new AbortController()
    const context = await this.capture()
    if (!this.accepting) throw new Error('The conversation stopped.')
    if (context.transient.crop)
      throw new Error('Apply or cancel the crop, then submit the request again.')
    const ids = new Set([
      ...context.selectedIds,
      ...(context.activePhotoId ? [context.activePhotoId] : []),
    ])
    const targets = new Map<string, Revision>()
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid editor context photograph.')
      targets.set(id, { revision: await this.revision(id), conflicted: false, refreshed: false })
    }
    if (!this.accepting) throw new Error('The conversation stopped.')
    await this.conversation(sessionId)
    this.turn = { sessionId, turnId }
    this.current = {
      context: structuredClone(context),
      requestId: randomUUID(),
      targets,
      paused: false,
      preparations: new Set(),
    }
    return this.context()
  }

  context(offset = 0): EditorContext {
    const value = this.current
    if (!value || !this.accepting)
      throw new Error('No trusted prompt context. Review /hooks and submit again.')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.context.selectedIds.length)
      throw new Error('Invalid selection offset.')
    const target = (photoId: string) => ({
      photoId,
      revision: value.targets.get(photoId)!.revision,
    })
    const next = offset + COLLECTION_CHUNK_SIZE
    return {
      requestId: value.requestId,
      workspace: value.context.workspace,
      active: value.context.activePhotoId ? target(value.context.activePhotoId) : null,
      selection: value.context.selectedIds.slice(offset, next).map(target),
      selectionTotal: value.context.selectedIds.length,
      offset,
      nextOffset: next < value.context.selectedIds.length ? next : null,
      transient: { ...value.context.transient },
      development: this.development,
    }
  }

  async run<T>(
    operation: string,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T> {
    const work = this.perform(operation, args, execute)
    this.pending.add(work)
    try {
      return await work
    } finally {
      this.pending.delete(work)
    }
  }
  private async perform<T>(
    operation: string,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T> {
    const request = this.current
    if (!this.accepting || !request || request.paused || args.requestId !== request.requestId)
      throw new Error(
        'This request is stale or paused. Submit a new request; navigation cannot retarget a turn.',
      )
    if (!(agentTools as readonly string[]).includes(operation))
      throw new Error('This tool is unavailable in the photo console.')
    const ids = [
      args.photoId,
      ...(Array.isArray(args.ids) ? args.ids : []),
      ...((args.pasteRequest as { photoIds?: unknown[] } | undefined)?.photoIds ?? []),
    ].filter((x) => x !== undefined)
    for (const id of ids) {
      if (typeof id !== 'string' || !request.targets.has(id))
        throw new Error("The photograph is outside this request's frozen targets.")
      const known = request.targets.get(id)!
      const actual = await this.revision(id)
      if (actual !== known.revision) {
        if (known.refreshed) {
          request.paused = true
          throw new Error(
            'Edits changed again. Paused to preserve newer manual work; submit a new request.',
          )
        }
        known.conflicted = true
        if (operation !== 'irodori_get_edits')
          throw new Error('Revision conflict. Refresh confirmed edits and retry once.')
        known.revision = actual
        known.refreshed = true
      }
      if (args.expectedRevision !== undefined && args.expectedRevision !== known.revision)
        throw new Error('Revision conflict. Read the confirmed revision before retrying.')
    }
    const preparationId =
      args.preparationId ??
      (args.exportRequest as { preparationId?: string } | undefined)?.preparationId
    if (preparationId !== undefined && !request.preparations.has(String(preparationId)))
      throw new Error('This preparation does not belong to the current request.')
    if (args.taskId !== undefined && !this.tasks.has(String(args.taskId)))
      throw new Error('This task does not belong to this conversation.')
    if (!this.accepting || this.current !== request)
      throw new Error('The request stopped before execution.')
    const result = await execute()
    if (result && typeof result === 'object') {
      const value = result as { id?: string; taskId?: string; photoId?: string; revision?: number }
      if (value.id && ['irodori_prepare_export', 'irodori_prepare_paste_edits'].includes(operation))
        request.preparations.add(value.id)
      if (value.taskId) this.tasks.add(value.taskId)
      if (value.photoId && typeof value.revision === 'number' && request.targets.has(value.photoId))
        request.targets.get(value.photoId)!.revision = value.revision
    }
    return result
  }
  end(sessionId?: unknown, turnId?: unknown) {
    if (
      sessionId !== undefined &&
      (sessionId !== this.turn?.sessionId || turnId !== this.turn?.turnId)
    )
      return
    this.current = undefined
    this.controller.abort()
  }
  stop() {
    this.accepting = false
    this.end()
  }
  async settled() {
    await this.beginning
    await this.drain()
  }
  async drain() {
    await Promise.allSettled([...this.pending])
  }
}
