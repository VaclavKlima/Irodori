import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  maskCapabilities,
  maskHasEdges,
  maskBaseReference,
  type PreparedMaskCoverage,
  type ResolvedMask,
  type MaskMutation,
} from '../../shared/masks'
import {
  maskEdgeMemoryPlan,
  maskEdgePixelIdentity,
  validateMaskCoverageRequest,
  type MaskCoverageRequest,
  type MaskCoverageResult,
} from '../../shared/mask-edges'
import type { PhotoMaskContext } from '../../shared/mask-geometry'
import type { CropAdmission } from '../../shared/crop-resources'
import type { EditState } from '../../shared/edits'
import { verifiedMaskBaseBytes } from '../mask-store'
import { maskCoverageNodes, mapMaskCoverage } from '../../shared/masks-gpu'
import { MaskEdgeProcess } from './process'
import type { PreviewDiskReservation } from '../preview-types'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const coverageSource = (source: unknown) => {
  if (source && typeof source === 'object' && 'identity' in source && 'processing' in source) {
    const processing = source.processing as { processing?: unknown; metadata?: unknown }
    return [source.identity, processing.processing, processing.metadata]
  }
  return source
}
interface Owner {
  context(id: string, revision: number): Promise<PhotoMaskContext>
  edits(id: string): Promise<EditState>
  source(id: string): Promise<unknown>
  masks(state: EditState, mutation?: MaskMutation): ResolvedMask[]
  admission(signal: AbortSignal): Promise<CropAdmission>
  reserve(bytes: number): Promise<PreviewDiskReservation>
  prepareRanges?(
    source: unknown,
    masks: ResolvedMask[],
    signal: AbortSignal,
  ): Promise<ResolvedMask[]>
}
interface Cached {
  photoId: string
  path: string
  asset: Omit<PreparedMaskCoverage, 'pngBase64'>
  bytes: number
  release: () => void
}
interface Job {
  requestId: string
  photoId: string
  kind: 'ui' | 'proposal' | 'inspection'
  abort: AbortController
  work: Promise<MaskCoverageResult>
}
/** Disposable coverage only. Main retains all filesystem paths and validates final photo lineage. */
export class MaskEdgeService {
  private runtime: Pick<MaskEdgeProcess, 'prepare' | 'close'>
  private tail: Promise<unknown> = Promise.resolve()
  private jobs = new Set<Job>()
  private cache = new Map<string, Cached>()
  private removing = new Set<string>()
  private closed = false
  constructor(
    private root: string,
    private owner: Owner,
    runtime?: Pick<MaskEdgeProcess, 'prepare' | 'close'>,
  ) {
    this.runtime = runtime ?? new MaskEdgeProcess()
  }
  prepare(value: MaskCoverageRequest, external?: AbortSignal): Promise<MaskCoverageResult> {
    const request = validateMaskCoverageRequest(value)
    if (this.closed || this.removing.has(request.photoId))
      return Promise.reject(
        new Error('Mask edges are unavailable while the photograph is closing or being removed.'),
      )
    const abort = new AbortController()
    const job: Job = {
      photoId: request.photoId,
      requestId: request.requestId ?? randomUUID(),
      kind: external ? 'inspection' : 'ui',
      abort,
      work: Promise.resolve(undefined as never),
    }
    const signal = external ? AbortSignal.any([external, abort.signal]) : abort.signal
    job.work = this.tail.then(() => this.run(request, signal))
    this.jobs.add(job)
    this.tail = job.work.catch(() => undefined)
    return job.work.finally(() => this.jobs.delete(job))
  }
  async prepareProposal(
    mask: ResolvedMask,
    context: PhotoMaskContext,
    external: AbortSignal,
  ): Promise<PreparedMaskCoverage> {
    if (this.closed || this.removing.has(context.photoId))
      throw new Error('The photograph is unavailable.')
    const abort = new AbortController()
    const signal = AbortSignal.any([external, abort.signal])
    const request = { photoId: context.photoId, revision: context.revision, maskIds: [mask.id] }
    const job: Job = {
      photoId: context.photoId,
      requestId: randomUUID(),
      kind: 'proposal',
      abort,
      work: Promise.resolve(undefined as never),
    }
    job.work = this.tail.then(() => this.run(request, signal, mask))
    this.jobs.add(job)
    this.tail = job.work.catch(() => undefined)
    try {
      return (await job.work).coverages[mask.id]
    } finally {
      this.jobs.delete(job)
    }
  }
  private async run(
    request: MaskCoverageRequest,
    signal: AbortSignal,
    proposal?: ResolvedMask,
  ): Promise<MaskCoverageResult> {
    signal.throwIfAborted()
    const [state, context, source] = await Promise.all([
      this.owner.edits(request.photoId),
      this.owner.context(request.photoId, request.revision),
      this.owner.source(request.photoId),
    ])
    signal.throwIfAborted()
    if (state.revision !== request.revision)
      throw new Error('Edits changed. Refresh mask coverage.')
    const masks = proposal ? [proposal] : this.owner.masks(state, request.mutation)
    const allNodes = masks.flatMap((mask) => maskCoverageNodes(mask, true))
    let selected = request.maskIds.map((id) => {
      const mask = allNodes.find((mask) => mask.id === id)
      if (!mask) throw new Error('The selected mask component is unavailable.')
      return mask
    })
    if (selected.some((mask) => maskCoverageNodes(mask).some((node) => node.range))) {
      if (!this.owner.prepareRanges)
        throw new Error('Range coverage preparation is unavailable. Retry GPU.')
      selected = await this.owner.prepareRanges(source, selected, signal)
    }
    // Shared subtrees are prepared once, children before the parent that consumes them.
    const chosen: ResolvedMask[] = []
    const seen = new Set<string>()
    for (const mask of selected)
      for (const node of maskCoverageNodes(mask).reverse())
        if ((maskHasEdges(node) || (proposal && node.id === proposal.id)) && !seen.has(node.id)) {
          seen.add(node.id)
          chosen.push(node)
        }
    const { canonicalWidth: width, canonicalHeight: height } = context.geometry
    const sourceIdentity = digest([request.photoId, coverageSource(source), width, height])
    const memory = maskEdgeMemoryPlan(
      width,
      height,
      selected,
      await this.owner.admission(signal),
      Boolean(proposal),
    )
    if (!memory.accepted)
      throw new Error(
        'Mask edges exceed the current image-memory budget. Reset Mask edges, close other processing or increase the resource budget, then retry GPU.',
      )
    const coverages: Record<string, PreparedMaskCoverage> = {}
    const rangeBases: Record<string, PreparedMaskCoverage> = {}
    for (const mask of selected)
      for (const node of maskCoverageNodes(mask))
        if (node.preparedRangeBase) rangeBases[node.id] = node.preparedRangeBase
    let encoded = Object.values(rangeBases).reduce(
      (sum, base) => sum + Math.ceil((base.pngBase64.length * 3) / 4),
      0,
    )
    if (encoded > maskCapabilities.maxLiveBaseEncodedBytes)
      throw new Error('Prepared ranges exceed the 32 MiB live coverage transfer limit.')
    for (const mask of chosen) {
      signal.throwIfAborted()
      const key = digest([
        sourceIdentity,
        width,
        height,
        maskEdgePixelIdentity(mask),
        maskCoverageNodes(mask).map((node) => node.preparedRangeBase?.key ?? null),
      ])
      let entry = this.cache.get(key)
      if (!entry) {
        await this.prune(maskCapabilities.maxBaseEncodedBytes)
        const release = await this.owner.reserve(maskCapabilities.maxBaseEncodedBytes)
        const directory = join(this.root, 'cache', 'mask-edges', randomUUID()),
          path = join(directory, 'coverage.png')
        try {
          await mkdir(directory, { recursive: true })
          const input = mapMaskCoverage(mask, (node) =>
            node.id !== mask.id && coverages[node.id]
              ? { ...node, preparedCoverage: coverages[node.id] }
              : node,
          )
          const result = await this.runtime.prepare(input, width, height, key, path, signal)
          signal.throwIfAborted()
          if (
            result.key !== key ||
            result.width !== width ||
            result.height !== height ||
            result.encodedBytes > maskCapabilities.maxBaseEncodedBytes
          )
            throw new Error('Prepared mask coverage identity or dimensions changed.')
          const asset = { version: 1 as const, key, hash: result.hash, width, height }
          const bytes = await readFile(path)
          verifiedMaskBaseBytes({
            ...maskBaseReference(asset),
            pngBase64: bytes.toString('base64'),
          })
          if (bytes.byteLength !== result.encodedBytes)
            throw new Error('Prepared mask coverage byte count changed.')
          release.shrink(bytes.byteLength)
          entry = { photoId: request.photoId, path, asset, bytes: bytes.byteLength, release }
          this.cache.set(key, entry)
        } catch (error) {
          await rm(directory, { recursive: true, force: true })
          release()
          throw error
        }
      }
      this.cache.delete(key)
      this.cache.set(key, entry)
      let data: Buffer, asset: PreparedMaskCoverage
      try {
        data = await readFile(entry.path)
        asset = { ...entry.asset, pngBase64: data.toString('base64') }
        verifiedMaskBaseBytes({ ...maskBaseReference(asset), pngBase64: asset.pngBase64 })
      } catch (error) {
        this.cache.delete(key)
        await rm(join(entry.path, '..'), { recursive: true, force: true })
        entry.release()
        throw error
      }
      encoded += data.byteLength
      if (encoded > maskCapabilities.maxLiveBaseEncodedBytes)
        throw new Error(
          'Prepared mask coverage exceeds the 32 MiB transfer limit. Reduce the number of masks using Mask edges.',
        )
      coverages[mask.id] = asset
    }
    signal.throwIfAborted()
    const [after, sourceAfter] = await Promise.all([
      this.owner.edits(request.photoId),
      this.owner.source(request.photoId),
    ])
    signal.throwIfAborted()
    if (
      this.closed ||
      this.removing.has(request.photoId) ||
      after.revision !== request.revision ||
      digest(sourceAfter) !== digest(source)
    )
      throw new Error('The photograph changed while preparing mask coverage.')
    return {
      photoId: request.photoId,
      revision: request.revision,
      sourceIdentity,
      coverages,
      rangeBases,
    }
  }
  private async prune(incoming = 0) {
    let bytes = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [key, entry] of this.cache) {
      if (bytes + incoming <= 64 * 1024 ** 2) break
      this.cache.delete(key)
      await rm(join(entry.path, '..'), { recursive: true, force: true })
      entry.release()
      bytes -= entry.bytes
    }
  }
  async cancel(photoId: string, requestId?: string, all = false) {
    const jobs = [...this.jobs].filter(
      (job) =>
        job.photoId === photoId &&
        (all || (job.kind === 'ui' && (!requestId || job.requestId === requestId))),
    )
    for (const job of jobs) job.abort.abort()
    await Promise.allSettled(jobs.map((job) => job.work))
  }
  async beginRemoval(photoId: string) {
    this.removing.add(photoId)
    await this.cancel(photoId, undefined, true)
    for (const [key, entry] of this.cache)
      if (entry.photoId === photoId) {
        this.cache.delete(key)
        await rm(join(entry.path, '..'), { recursive: true, force: true })
        entry.release()
      }
  }
  endRemoval(photoId: string) {
    this.removing.delete(photoId)
  }
  async close() {
    this.closed = true
    for (const job of this.jobs) job.abort.abort()
    await this.tail
    await this.runtime.close()
    for (const entry of this.cache.values()) {
      await rm(join(entry.path, '..'), { recursive: true, force: true })
      entry.release()
    }
    this.cache.clear()
  }
}
