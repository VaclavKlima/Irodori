import { lstat } from 'node:fs/promises'
import type { DisplayPreview } from '../shared/contracts'
import type { EditComparisonSource, FrozenEditComparisonSource } from '../shared/edit-checkpoints'
import type {
  EditComparisonInspectionOptions,
  EditComparisonInspectionResult,
  EditComparisonMemberId,
  EditComparisonSession,
  PrepareEditComparisonRequest,
} from '../shared/edit-comparisons'
import { INSPECTION_PAIR_LIMIT, validateInspectionOptions } from '../shared/inspection'
import type { ManagedImageBytes } from '../shared/resource-policy'
import type { AgentPhotoPreviews } from './agent/photo-previews'
import { hashFile, sameSource } from './export/files'
import type { ExportSource } from './export/types'
import type { FullPreviews } from './full-previews'

type Pair<T> = readonly [T, T]
interface Owner {
  consumer: 'renderer' | 'mcp'
  disposal?: Promise<void>
  photoId: string
  abort: AbortController
  snapshots?: Pair<FrozenEditComparisonSource>
  sources?: Pair<ExportSource>
  session?: EditComparisonSession
  frames: Map<EditComparisonMemberId, string>
  work: Set<Promise<unknown>>
  tail: Promise<unknown>
}
export interface EditComparisonDependencies {
  resolve(
    photoId: string,
    sources: Pair<EditComparisonSource>,
  ): Promise<Pair<FrozenEditComparisonSource>>
  assert(sources: Pair<FrozenEditComparisonSource>): void | Promise<void>
  source(snapshot: FrozenEditComparisonSource): Promise<ExportSource>
  previews: Pick<FullPreviews, 'requestFrozen' | 'release'>
  inspection: Pick<AgentPhotoPreviews, 'contextFrozen' | 'inspectFrozen'>
}
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

/** One bounded read-only pair; every publication validates both immutable members. */
export class EditComparisons {
  private owners = new Map<string, Owner>()
  private closed = false
  constructor(private dependencies: EditComparisonDependencies) {}

  async prepare(
    request: PrepareEditComparisonRequest,
    signal?: AbortSignal,
    consumer: 'renderer' | 'mcp' = 'renderer',
  ): Promise<EditComparisonSession> {
    if (
      this.closed ||
      !request ||
      !/^[a-f0-9]{64}$/.test(request.photoId) ||
      !tokenPattern.test(request.requestId) ||
      this.owners.has(request.requestId) ||
      this.owners.size >= 2 ||
      [...this.owners.values()].some((owner) => owner.consumer === consumer)
    )
      throw new Error('A version comparison is already open or the request is invalid.')
    const frozen = structuredClone(request),
      owner: Owner = {
        consumer,
        photoId: frozen.photoId,
        abort: new AbortController(),
        frames: new Map(),
        work: new Set(),
        tail: Promise.resolve(),
      }
    this.owners.set(frozen.requestId, owner)
    const abort = () =>
      owner.abort.abort(signal?.reason ?? new Error('Comparison preparation cancelled.'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const work = (async () => {
      owner.abort.signal.throwIfAborted()
      owner.snapshots = await this.dependencies.resolve(frozen.photoId, [
        frozen.baseline,
        frozen.target,
      ])
      const a = await this.dependencies.source(owner.snapshots[0])
      owner.abort.signal.throwIfAborted()
      const b = await this.dependencies.source(owner.snapshots[1])
      owner.sources = [structuredClone(a), structuredClone(b)]
      await this.validate(owner)
      if (a.photo.assetKind !== 'derived' && (await hashFile(a.path)) !== a.photo.id)
        throw new Error('The managed comparison original changed or is damaged.')
      const contextA = await this.dependencies.inspection.contextFrozen(a, owner.abort.signal, () =>
        this.validate(owner),
      )
      const contextB = await this.dependencies.inspection.contextFrozen(b, owner.abort.signal, () =>
        this.validate(owner),
      )
      if (contextA.gridIdentity !== contextB.gridIdentity)
        throw new Error(
          'These versions have different crop, rotation or lens geometry. Choose versions with matching framing to compare the same region.',
        )
      await this.validate(owner)
      const session: EditComparisonSession = {
        id: frozen.requestId,
        photoId: frozen.photoId,
        context: contextA,
        members: owner.snapshots.map(({ source, label, identity, capturedFromRevision }) => ({
          source,
          label,
          identity,
          capturedFromRevision,
        })) as unknown as EditComparisonSession['members'],
      }
      owner.session = structuredClone(session)
      return session
    })()
    owner.work.add(work)
    try {
      return await work
    } catch (error) {
      owner.work.delete(work)
      await this.dispose(frozen.photoId, frozen.requestId)
      throw error
    } finally {
      owner.work.delete(work)
      signal?.removeEventListener('abort', abort)
    }
  }

  async frame(
    photoId: string,
    sessionId: string,
    member: EditComparisonMemberId,
    requestId: string,
    rendition: 'sdr' | 'hdr',
    rendererReservation?: ManagedImageBytes,
  ): Promise<DisplayPreview> {
    const owner = this.owner(photoId, sessionId)
    if (!['a', 'b'].includes(member) || !tokenPattern.test(requestId))
      throw new Error('Invalid version comparison frame request.')
    const work = owner.tail.then(async () => {
      await this.validate(owner)
      const previous = owner.frames.get(member)
      if (previous) await this.dependencies.previews.release(previous)
      owner.abort.signal.throwIfAborted()
      owner.frames.set(member, requestId)
      const source = owner.sources![member === 'a' ? 0 : 1]
      const preview = await this.dependencies.previews.requestFrozen(
        photoId,
        requestId,
        source.processing,
        rendition,
        rendererReservation,
      )
      await this.validate(owner)
      if (
        preview.photoId !== photoId ||
        preview.requestId !== requestId ||
        preview.settingsRevision !== source.processing.revision ||
        preview.width !== owner.session!.context.width ||
        preview.height !== owner.session!.context.height
      )
        throw new Error('The comparison frame no longer matches its native grid.')
      return preview
    })
    owner.tail = work.catch(() => undefined)
    owner.work.add(work)
    try {
      return await work
    } catch (error) {
      await this.dependencies.previews.release(requestId)
      if (owner.frames.get(member) === requestId) owner.frames.delete(member)
      throw error
    } finally {
      owner.work.delete(work)
    }
  }

  async inspect(
    photoId: string,
    sessionId: string,
    inspection: EditComparisonInspectionOptions,
    signal?: AbortSignal,
  ): Promise<EditComparisonInspectionResult> {
    const owner = this.owner(photoId, sessionId)
    if (inspection && 'comparison' in inspection)
      throw new Error('Version comparison always returns both selected members.')
    const options = validateInspectionOptions({ ...inspection, comparison: 'after' }),
      active = signal ? AbortSignal.any([signal, owner.abort.signal]) : owner.abort.signal,
      validate = async () => {
        active.throwIfAborted()
        await this.validate(owner)
      }
    const work = owner.tail.then(async () => {
      await validate()
      const a = await this.dependencies.inspection.inspectFrozen(
        owner.sources![0],
        options,
        active,
        validate,
      )
      const b = await this.dependencies.inspection.inspectFrozen(
        owner.sources![1],
        options,
        active,
        validate,
        a.members.reduce((bytes, image) => bytes + image.byteLength * 3, 0),
      )
      const members = [a.members[0], b.members[0]]
      if (
        members.some((image) => image.gridIdentity !== owner.session!.context.gridIdentity) ||
        members.reduce((bytes, image) => bytes + image.byteLength, 0) > INSPECTION_PAIR_LIMIT
      )
        throw new Error(
          'The version comparison has incompatible geometry or exceeds its pair payload limit.',
        )
      await validate()
      return {
        photoId,
        sessionId,
        gridIdentity: owner.session!.context.gridIdentity,
        members: members.map((image, index) => ({
          ...image,
          label: index === 0 ? 'a' : 'b',
          version: owner.session!.members[index],
          comparison:
            owner.session!.members[index].source.kind === 'checkpoint'
              ? 'saved checkpoint'
              : 'frozen current edit',
        })) as unknown as EditComparisonInspectionResult['members'],
      }
    })
    owner.tail = work.catch(() => undefined)
    owner.work.add(work)
    try {
      return await work
    } finally {
      owner.work.delete(work)
    }
  }

  private owner(photoId: string, sessionId: string): Owner {
    const owner = this.owners.get(sessionId)
    if (!owner?.session || owner.photoId !== photoId || this.closed || owner.abort.signal.aborted)
      throw new Error('This version comparison is unavailable. Select the versions again.')
    return owner
  }
  private async validate(owner: Owner) {
    owner.abort.signal.throwIfAborted()
    if (!owner.snapshots || !owner.sources) throw new Error('The comparison has not been prepared.')
    await this.dependencies.assert(owner.snapshots)
    for (const source of owner.sources)
      if (!sameSource(await lstat(source.path), source.identity))
        throw new Error('The managed comparison source changed.')
    await this.dependencies.assert(owner.snapshots)
    owner.abort.signal.throwIfAborted()
  }
  async dispose(photoId: string, sessionId: string): Promise<void> {
    const owner = this.owners.get(sessionId)
    if (!owner) return
    if (owner.photoId !== photoId) throw new Error('The comparison belongs to another photograph.')
    if (owner.disposal) return owner.disposal
    owner.abort.abort(new Error('Version comparison closed.'))
    owner.disposal = (async () => {
      await Promise.all(
        [...owner.frames.values()].map((token) => this.dependencies.previews.release(token)),
      )
      await Promise.allSettled([...owner.work])
      if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId)
    })()
    return owner.disposal
  }
  async remove(photoId: string) {
    await Promise.all(
      [...this.owners]
        .filter(([, owner]) => owner.photoId === photoId)
        .map(([id]) => this.dispose(photoId, id)),
    )
  }
  async close() {
    this.closed = true
    await Promise.all([...this.owners].map(([id, owner]) => this.dispose(owner.photoId, id)))
  }
}
