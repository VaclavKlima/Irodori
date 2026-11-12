import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MASK_PREVIEW_VERSION,
  maskPreviewInspection,
  maskPreviewLimits,
  maskPreviewMemoryPlan,
  maskPreviewOverlay,
  resolveMaskPreview,
  validateMaskPreviewRequest,
  type MaskPreviewImage,
  type MaskPreviewRequest,
  type MaskPreviewResult,
} from '../../shared/mask-preview'
import type { PreviewContext, InspectionOptions, InspectionResult } from '../../shared/inspection'
import type { MaskCoverageRequest, MaskCoverageResult } from '../../shared/mask-edges'
import { hasMaskAdjustments, maskHasEdges, type ResolvedMask } from '../../shared/masks'
import { mapMaskCoverage, maskCoverageNodes } from '../../shared/masks-gpu'
import type { CropAdmission } from '../../shared/crop-resources'
import type { EditState } from '../../shared/edits'
import type { PreviewDiskReservation } from '../preview-types'
import type { ExportSource } from '../export/types'
import { sameSource, hashFile } from '../export/files'
import { MaskEdgeProcess } from '../mask-edges/process'

export interface MaskPreviewOwner {
  source(id: string): Promise<ExportSource>
  edits(id: string): Promise<EditState>
  masks(state: EditState): ResolvedMask[]
  context(id: string, revision: number, signal: AbortSignal): Promise<PreviewContext>
  prepareCoverage(request: MaskCoverageRequest, signal: AbortSignal): Promise<MaskCoverageResult>
  photo(
    id: string,
    revision: number,
    inspection: InspectionOptions,
    signal: AbortSignal,
  ): Promise<InspectionResult>
  admission(signal: AbortSignal): Promise<CropAdmission>
  reserve(bytes: number): Promise<PreviewDiskReservation>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function validatePng(bytes: Buffer, width: number, height: number) {
  if (
    bytes.byteLength < 33 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw new Error('Mask preview PNG dimensions or encoding changed.')
}
interface Job {
  photoId: string
  abort: AbortController
  work: Promise<MaskPreviewResult>
}

/** Read-only existing-root inspection. No drafts, UI selection or history publication. */
export class MaskPreviews {
  private tail: Promise<unknown> = Promise.resolve()
  private jobs = new Set<Job>()
  private removing = new Set<string>()
  private cleanup = new Map<string, PreviewDiskReservation>()
  private closed = false
  constructor(
    private root: string,
    private owner: MaskPreviewOwner,
    private runtime: Pick<MaskEdgeProcess, 'preview' | 'close'> = new MaskEdgeProcess(),
  ) {}

  get(value: MaskPreviewRequest, external?: AbortSignal): Promise<MaskPreviewResult> {
    const request = validateMaskPreviewRequest(value)
    if (this.closed || this.removing.has(request.photoId))
      return Promise.reject(
        new Error(
          'Mask previews are unavailable while the photograph is closing or being removed.',
        ),
      )
    const abort = new AbortController()
    const signal = external ? AbortSignal.any([external, abort.signal]) : abort.signal
    const job: Job = { photoId: request.photoId, abort, work: Promise.resolve(undefined as never) }
    job.work = this.tail.then(() => this.render(request, signal))
    this.jobs.add(job)
    this.tail = job.work.catch(() => undefined)
    return job.work.finally(() => this.jobs.delete(job))
  }

  private async render(
    request: MaskPreviewRequest,
    signal: AbortSignal,
  ): Promise<MaskPreviewResult> {
    signal.throwIfAborted()
    await this.cleanupPending()
    const source = structuredClone(await this.owner.source(request.photoId))
    if (source.photo.id !== request.photoId)
      throw new Error('The managed mask preview photograph identity changed.')
    const state = await this.owner.edits(request.photoId)
    const validate = async () => {
      signal.throwIfAborted()
      const [current, latest] = await Promise.all([
        this.owner.edits(request.photoId),
        this.owner.source(request.photoId),
      ])
      if (
        current.revision !== request.expectedRevision ||
        source.processing.revision !== request.expectedRevision
      )
        throw new Error('Mask preview revision changed. Refresh confirmed edits before retrying.')
      if (
        digest(latest) !== digest(source) ||
        !sameSource(await lstat(source.path), source.identity)
      )
        throw new Error('The managed mask preview source changed.')
    }
    await validate()
    if (state.revision !== request.expectedRevision)
      throw new Error('Mask preview revision changed. Refresh confirmed edits before retrying.')
    const mask = structuredClone(this.owner.masks(state).find((mask) => mask.id === request.maskId))
    if (!mask)
      throw new Error(
        'Mask preview maskId must identify an existing root mask. Read confirmed edits and choose a root mask ID.',
      )
    const context = await this.owner.context(request.photoId, request.expectedRevision, signal)
    if (
      context.photoId !== request.photoId ||
      context.revision !== request.expectedRevision ||
      !context.geometry
    )
      throw new Error('Mask preview photo geometry or revision changed. Refresh preview context.')
    const resolved = resolveMaskPreview(request, context)
    const nodes = maskCoverageNodes(mask)
    const needed = nodes.filter((node) => maskHasEdges(node) || node.range).map((node) => node.id)
    const prepared = needed.length
      ? await this.owner.prepareCoverage(
          {
            requestId: randomUUID(),
            photoId: request.photoId,
            revision: request.expectedRevision,
            maskIds: needed,
          },
          signal,
        )
      : undefined
    if (
      prepared &&
      (prepared.photoId !== request.photoId || prepared.revision !== request.expectedRevision)
    )
      throw new Error('Prepared mask preview coverage revision changed.')
    const selected = mapMaskCoverage(mask, (node) => {
      const next: ResolvedMask = {
        ...node,
        preparedCoverage: undefined,
        preparedRangeBase: undefined,
      }
      if (!nodes.some((active) => active.id === node.id)) return next
      if (node.range) {
        next.preparedRangeBase = prepared?.rangeBases?.[node.id]
        if (!next.preparedRangeBase)
          throw new Error('Range coverage is not ready. Retry GPU after preparation completes.')
      }
      if (maskHasEdges(node)) {
        next.preparedCoverage = prepared?.coverages[node.id]
        if (!next.preparedCoverage)
          throw new Error('Mask edge coverage is not ready. Retry GPU after preparation completes.')
      }
      return next
    })
    const memory = maskPreviewMemoryPlan(
      request,
      context,
      selected,
      await this.owner.admission(signal),
    )
    if (!memory.accepted)
      throw new Error(
        'Mask preview exceeds the current image-memory budget. Reduce resolutionPercent or the region, close other processing, or increase the resource budget, then retry GPU.',
      )
    if (source.photo.assetKind !== 'derived' && (await hashFile(source.path)) !== request.photoId)
      throw new Error('The managed mask preview original changed or is damaged.')
    await validate()
    const overlay = resolved.labels.includes('overlay')
    const reservation = await this.owner.reserve(
      maskPreviewLimits.imageBytes * (resolved.labels.length + Number(overlay)),
    )
    const directory = join(this.root, 'cache', 'mask-previews', randomUUID())
    try {
      await mkdir(directory, { recursive: true })
      let photoPath: string | undefined, photoIdentity: string | undefined
      if (overlay) {
        // The photo owner has its own queue; this coordinator never runs inside it.
        const photo = await this.owner.photo(
          request.photoId,
          request.expectedRevision,
          maskPreviewInspection(request),
          signal,
        )
        const member = photo.members[0]
        if (
          photo.members.length !== 1 ||
          photo.photoId !== request.photoId ||
          photo.revision !== request.expectedRevision ||
          photo.gridIdentity !== context.gridIdentity ||
          !member ||
          member.label !== 'after' ||
          member.width !== resolved.width ||
          member.height !== resolved.height ||
          member.photoId !== request.photoId ||
          member.revision !== request.expectedRevision ||
          member.gridIdentity !== context.gridIdentity ||
          member.native !== 'photo-native' ||
          member.mimeType !== 'image/png' ||
          member.colorSpace !== 'srgb' ||
          member.encoding.format !== 'png' ||
          member.effectiveRendition !== 'sdr' ||
          !member.renderingIdentity ||
          member.nativeGrid.width !== context.width ||
          member.nativeGrid.height !== context.height ||
          digest(member.photoBounds) !== digest(resolved.photoBounds) ||
          digest(member.bounds) !== digest(resolved.bounds)
        )
          throw new Error('The current SDR overlay photograph grid, bounds or revision changed.')
        const bytes = Buffer.from(member.data, 'base64')
        if (
          bytes.byteLength !== member.byteLength ||
          bytes.byteLength > maskPreviewLimits.imageBytes
        )
          throw new Error(
            'The SDR overlay photograph exceeds the image delivery limit. Reduce resolutionPercent or the region.',
          )
        validatePng(bytes, resolved.width, resolved.height)
        photoPath = join(directory, 'photo.png')
        photoIdentity = member.renderingIdentity
        await writeFile(photoPath, bytes)
      }
      await validate()
      const key = digest([MASK_PREVIEW_VERSION, source, mask, context, request, photoIdentity])
      const outputPath = join(directory, 'preview')
      const output = await this.runtime.preview(
        {
          mask: selected,
          width: resolved.width,
          height: resolved.height,
          key,
          outputPath,
          inspection: {
            geometry: context.geometry,
            grid: { width: context.width, height: context.height },
            bounds: resolved.bounds,
            view: request.view ?? 'pair',
            ...(photoPath ? { photoPath } : {}),
          },
        },
        signal,
      )
      signal.throwIfAborted()
      if (output.key !== key || output.members.length !== resolved.labels.length)
        throw new Error('Mask preview output identity or members changed.')
      const members: MaskPreviewImage[] = []
      let total = 0
      for (const label of resolved.labels) {
        const result = output.members.find((member) => member.label === label)
        const path = `${outputPath}.${label}.png`
        if (
          !result ||
          result.path !== path ||
          result.key !== key ||
          result.width !== resolved.width ||
          result.height !== resolved.height
        )
          throw new Error('Mask preview output dimensions or identity changed.')
        const bytes = await readFile(path)
        const hash = createHash('sha256').update(bytes).digest('hex')
        total += bytes.byteLength
        if (bytes.byteLength !== result.encodedBytes || hash !== result.hash)
          throw new Error('Mask preview output bytes or hash changed.')
        if (bytes.byteLength > maskPreviewLimits.imageBytes || total > maskPreviewLimits.pairBytes)
          throw new Error(
            'Mask preview exceeds the image delivery limit. Reduce resolutionPercent or choose a smaller region.',
          )
        validatePng(bytes, resolved.width, resolved.height)
        members.push({
          label,
          photoId: request.photoId,
          revision: request.expectedRevision,
          maskId: mask.id,
          gridIdentity: context.gridIdentity,
          renderingIdentity: digest([key, label, hash]),
          hash,
          width: resolved.width,
          height: resolved.height,
          native: 'photo-native',
          photoBounds: resolved.photoBounds,
          bounds: resolved.bounds,
          nativeGrid: { width: context.width, height: context.height },
          encoding: { format: 'png', lossless: true },
          mimeType: 'image/png',
          colorSpace: label === 'coverage' ? 'coverage' : 'srgb',
          sourceDynamicRange: context.sourceDynamicRange,
          rendition:
            label === 'coverage' ? 'mask coverage, black 0 and white 1' : 'sRGB SDR mask overlay',
          byteLength: bytes.byteLength,
          data: bytes.toString('base64'),
        })
      }
      await validate()
      const currentContext = await this.owner.context(
        request.photoId,
        request.expectedRevision,
        signal,
      )
      if (digest(currentContext) !== digest(context))
        throw new Error('The mask preview grid changed. Refresh preview context and retry.')
      await validate()
      return {
        photoId: request.photoId,
        revision: request.expectedRevision,
        maskId: mask.id,
        maskName: mask.name,
        enabled: mask.enabled,
        adjustmentsNeutral: !hasMaskAdjustments(mask),
        coverageSemantics: 'stored-mask-shape',
        gridIdentity: context.gridIdentity,
        overlay: maskPreviewOverlay,
        members,
      }
    } finally {
      // Keep the disk claim until every temporary file is gone.
      this.cleanup.set(directory, reservation)
      await this.cleanupPending()
    }
  }

  async beginRemoval(photoId: string): Promise<void> {
    this.removing.add(photoId)
    const jobs = [...this.jobs].filter((job) => job.photoId === photoId)
    for (const job of jobs) job.abort.abort()
    await Promise.allSettled(jobs.map((job) => job.work))
  }
  endRemoval(photoId: string): void {
    this.removing.delete(photoId)
  }
  private async cleanupPending(): Promise<void> {
    for (const [directory, release] of this.cleanup) {
      try {
        await rm(directory, { recursive: true, force: true })
      } catch (cause) {
        // The files still own their disk claim; the next request or close retries cleanup.
        throw new Error(
          'Temporary mask preview cleanup failed. Check preview-cache storage and retry or close the photograph.',
          { cause },
        )
      }
      release()
      this.cleanup.delete(directory)
    }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const job of this.jobs) job.abort.abort()
    await this.tail
    await this.runtime.close()
    await this.cleanupPending()
  }
}
