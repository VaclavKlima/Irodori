import { objectSelectionMemoryPlan } from '../../shared/object-selection-resources'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { neutralAdjustments } from '../../shared/adjustments'
import { noLensSettings } from '../../shared/lens'
import {
  neutralMaskEdge,
  neutralMaskLight,
  neutralMaskColor,
  maskHasEdges,
  maskBaseReference,
  validatePreparedMaskCoverage,
  type MaskBaseContent,
  type MaskDescriptor,
  type PreparedMaskCoverage,
  type ResolvedMask,
} from '../../shared/masks'
import {
  objectSelectionCapabilities,
  validateAcceptObjectSelection,
  validateObjectSelectionRequest,
  validateSelectionTarget,
  type AcceptObjectSelection,
  type ObjectSelectionContext,
  type ObjectSelectionProposal,
  type ObjectSelectionRequest,
} from '../../shared/object-selection'
import type { PhotoMaskContext } from '../../shared/mask-geometry'
import type { EditState } from '../../shared/edits'
import type { CropAdmission } from '../../shared/crop-resources'
import { PreviewProcess } from '../preview-process'
import type { ExportSource } from '../export/types'
import { ObjectSelectionProcess } from './process'
import { verifiedMaskBaseBytes } from '../mask-store'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface SelectionOwner {
  source(id: string): Promise<ExportSource>
  context(id: string, revision: number): Promise<PhotoMaskContext>
  edits(id: string): Promise<EditState>
  admission(signal: AbortSignal): Promise<CropAdmission>
  commit(request: ObjectSelectionRequest, base: MaskBaseContent, maskId: string): Promise<EditState>
  prepareCoverage?(
    mask: ResolvedMask,
    context: PhotoMaskContext,
    signal: AbortSignal,
  ): Promise<PreparedMaskCoverage>
}
interface HeldProposal {
  public: ObjectSelectionProposal
  request: ObjectSelectionRequest
  base: MaskBaseContent
}

/** Main owns all paths, one source/embedding, one proposal and final revision validation. */
export class ObjectSelectionService {
  private runtime: Pick<ObjectSelectionProcess, 'run' | 'close'>
  private decoder: Pick<PreviewProcess, 'renderFull' | 'close'>
  private active?: { photoId: string; abort: AbortController }
  private tail: Promise<unknown> = Promise.resolve()
  private proposal?: HeldProposal
  private prepared?: {
    photoId: string
    key: string
    path: string
    directory: string
    width: number
    height: number
  }
  private sequence = 0
  private running?: { photoId: string; work: Promise<unknown> }
  private closed = false
  private removing = new Set<string>()
  constructor(
    private root: string,
    private owner: SelectionOwner,
    dependencies: {
      runtime?: Pick<ObjectSelectionProcess, 'run' | 'close'>
      decoder?: Pick<PreviewProcess, 'renderFull' | 'close'>
    } = {},
  ) {
    this.runtime = dependencies.runtime ?? new ObjectSelectionProcess()
    this.decoder = dependencies.decoder ?? new PreviewProcess()
  }
  async context(photoId: string, revision: number): Promise<ObjectSelectionContext> {
    validateSelectionTarget(photoId, revision)
    if (this.closed || this.removing.has(photoId))
      throw new Error(
        'Object selection is unavailable while this photograph is closing or being removed.',
      )
    const [source, context] = await Promise.all([
      this.owner.source(photoId),
      this.owner.context(photoId, revision),
    ])
    if (this.removing.has(photoId)) throw new Error('This photograph is being removed.')
    if (source.processing.revision !== revision)
      throw new Error('Edits changed. Refresh object selection before continuing.')
    if (
      context.geometry.canonicalWidth * context.geometry.canonicalHeight >
        objectSelectionCapabilities.maxPixels ||
      Math.max(context.geometry.canonicalWidth, context.geometry.canonicalHeight) >
        objectSelectionCapabilities.maxDimension
    )
      throw new Error(
        'Object selection supports sources up to 32 megapixels and 8192 pixels per side. Paint/Erase remains available.',
      )
    return {
      photoId,
      revision,
      gridIdentity: hash({
        version: 'object-selection-canonical-v1',
        photoId,
        source: source.identity,
        geometry: context.geometry,
      }),
      width: context.width,
      height: context.height,
      geometry: context.geometry,
      model: objectSelectionCapabilities.model,
      capabilities: objectSelectionCapabilities,
    }
  }
  create(
    value: ObjectSelectionRequest,
    externalSignal?: AbortSignal,
  ): Promise<ObjectSelectionProposal> {
    const request = validateObjectSelectionRequest(value)
    if (this.closed || this.removing.has(request.photoId))
      return Promise.reject(
        new Error(
          'Object selection is unavailable while this photograph is closing or being removed.',
        ),
      )
    this.active?.abort.abort()
    const active = { photoId: request.photoId, abort: new AbortController() }
    this.active = active
    const sequence = ++this.sequence
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, active.abort.signal])
      : active.abort.signal
    const work: Promise<ObjectSelectionProposal> = this.tail.then(async () => {
      const running = { photoId: request.photoId, work }
      this.running = running
      try {
        return await this.generate(request, signal, sequence)
      } finally {
        if (this.running === running) this.running = undefined
      }
    })
    this.tail = work.catch(() => {})
    return work.finally(() => {
      if (this.active === active) this.active = undefined
    })
  }
  private async validate(request: ObjectSelectionRequest) {
    const context = await this.context(request.photoId, request.expectedRevision)
    if (context.gridIdentity !== request.gridIdentity)
      throw new Error('The photograph geometry changed. Indicate the object again.')
    return context
  }
  private async generate(request: ObjectSelectionRequest, signal: AbortSignal, sequence: number) {
    signal.throwIfAborted()
    const context = await this.validate(request)
    const source = await this.owner.source(request.photoId)
    const key = hash({
      version: 'selection-neutral-source-v1',
      photoId: request.photoId,
      source: source.identity,
      metadata: source.processing.metadata,
      processing: source.processing.processing,
    })
    const { canonicalWidth: width, canonicalHeight: height } = context.geometry
    const admission = await this.owner.admission(signal)
    const memory = objectSelectionMemoryPlan(width, height, admission)
    if (!memory.accepted)
      throw new Error(
        `Object selection exceeds the current image-memory budget (RAM ${Math.ceil(memory.ramBytes / 1024 ** 2)}/${Math.floor(admission.policy.ram.effectiveBytes / 1024 ** 2)} MiB; GPU ${Math.ceil(memory.vramBytes / 1024 ** 2)}/${Math.floor(admission.policy.vram.effectiveBytes / 1024 ** 2)} MiB). Close other processing or increase the resource budget, then retry GPU.`,
      )
    if (this.prepared?.key !== key) {
      await this.runtime.close()
      if (this.prepared) await rm(this.prepared.directory, { recursive: true, force: true })
      this.prepared = undefined
      const directory = join(this.root, 'cache', 'object-selection', randomUUID())
      await mkdir(directory, { recursive: true })
      try {
        const frame = await this.decoder.renderFull(source.path, directory, signal, {
          ...source.processing,
          settings: { ...noLensSettings },
          adjustments: structuredClone(neutralAdjustments),
          crop: undefined,
          noiseReduction: undefined,
          detailSharpening: undefined,
          firstSurface: undefined,
          prepareLinear: false,
          workingOnly: false,
        })
        signal.throwIfAborted()
        const path = join(directory, 'full.rgba')
        if (
          frame.width !== width ||
          frame.height !== height ||
          (await stat(path)).size !== width * height * 4
        )
          throw new Error('The prepared selection source does not match the canonical mask grid.')
        if (
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex') !== frame.sha256
        )
          throw new Error('The canonical selection source hash changed.')
        this.prepared = { photoId: request.photoId, key, path, directory, width, height }
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      } finally {
        // Release source-preparation GPU ownership before inference starts.
        await this.decoder.close(true)
      }
    }
    const output = join(this.prepared!.directory, `proposal-${sequence}.png`)
    try {
      const result = await this.runtime.run(
        { key, path: this.prepared!.path, width, height, format: 'rgba8' },
        { key, ...request.prompts },
        output,
        signal,
      )
      signal.throwIfAborted()
      await this.validate(request)
      if (sequence !== this.sequence || this.closed)
        throw new Error('Object selection was superseded.')
      if (result.width !== width || result.height !== height)
        throw new Error('The selection result has a different source grid.')
      const png = await readFile(output)
      if (
        png.byteLength !== result.encodedBytes ||
        createHash('sha256').update(png).digest('hex') !== result.sha256
      )
        throw new Error('The selection result is incomplete or changed.')
      const base: MaskBaseContent = {
        version: 1,
        hash: result.sha256,
        width,
        height,
        pngBase64: png.toString('base64'),
      }
      verifiedMaskBaseBytes(base)
      const current = await this.owner.edits(request.photoId)
      const target = request.maskId
        ? current.settings.maskStack.find((mask) => mask.id === request.maskId)
        : undefined
      if (request.maskId && !target) throw new Error('The mask to refine is unavailable.')
      const id = target?.id ?? randomUUID()
      const resolved = target
        ? source.processing.adjustments?.localMasks?.find((mask) => mask.id === target.id)
        : undefined
      if (target && !resolved)
        throw new Error('The selected mask content is inconsistent. Reload the confirmed masks.')
      const proposal: ObjectSelectionProposal = {
        id: randomUUID(),
        photoId: request.photoId,
        revision: request.expectedRevision,
        gridIdentity: request.gridIdentity,
        modelIdentity: result.modelIdentity,
        mask: {
          ...(resolved ?? {
            id,
            name: 'Object',
            enabled: true,
            inverted: false,
            head: null,
            light: { ...neutralMaskLight },
            color: { ...neutralMaskColor },
            edge: { ...neutralMaskEdge },
            strokes: [],
          }),
          base,
          preparedCoverage: undefined,
        },
      }
      if (maskHasEdges(proposal.mask)) {
        if (!this.owner.prepareCoverage)
          throw new Error(
            'Mask edge coverage preparation is unavailable. Cancel selection and retry GPU.',
          )
        // Retire the opaque model heap before the separate native edge GPU phase.
        // Canonical source files remain reusable for later prompt refinements.
        await this.runtime.close()
        signal.throwIfAborted()
        const coverage = await this.owner.prepareCoverage(
          proposal.mask,
          await this.owner.context(request.photoId, request.expectedRevision),
          signal,
        )
        validatePreparedMaskCoverage(coverage)
        verifiedMaskBaseBytes({ ...maskBaseReference(coverage), pngBase64: coverage.pngBase64 })
        if (coverage.width !== width || coverage.height !== height)
          throw new Error('Prepared mask coverage has a different canonical source grid.')
        proposal.mask.preparedCoverage = coverage
      }
      signal.throwIfAborted()
      await this.validate(request)
      if (sequence !== this.sequence || this.closed)
        throw new Error('Object selection was superseded.')
      this.proposal = { public: proposal, request, base }
      return structuredClone(proposal)
    } finally {
      await rm(output, { force: true })
    }
  }
  accept(value: AcceptObjectSelection): Promise<EditState> {
    const request = validateAcceptObjectSelection(value)
    if (this.closed) return Promise.reject(new Error('Object selection is closed.'))
    const work = this.tail.then(() => this.acceptHeld(request))
    this.tail = work.catch(() => {})
    return work
  }
  private async acceptHeld(request: AcceptObjectSelection): Promise<EditState> {
    const proposal = this.proposal
    if (
      !proposal ||
      proposal.public.id !== request.proposalId ||
      proposal.public.photoId !== request.photoId
    )
      throw new Error('This selection proposal is unavailable. Generate it again.')
    if (request.expectedRevision !== proposal.request.expectedRevision)
      throw new Error('Edits changed. Generate the selection again before accepting it.')
    await this.validate(proposal.request)
    const state = await this.owner.commit(proposal.request, proposal.base, proposal.public.mask.id)
    if (this.proposal === proposal) this.proposal = undefined
    await this.runtime.close()
    return state
  }
  cancel(photoId: string): Promise<void> {
    if (typeof photoId !== 'string' || !/^[a-f0-9]{64}$/.test(photoId))
      return Promise.reject(new Error('Invalid selection photograph.'))
    if (this.active?.photoId === photoId) {
      this.active.abort.abort()
      ++this.sequence
    }
    if (this.proposal?.public.photoId === photoId) this.proposal = undefined
    if (this.prepared?.photoId !== photoId && this.active?.photoId !== photoId)
      return Promise.resolve()
    // New requests queue after cleanup, so a late cancellation cannot kill their
    // worker or remove a same-photo source they have just started to reuse.
    const work = this.tail.then(async () => {
      if (this.prepared?.photoId !== photoId) return
      await this.runtime.close()
      await rm(this.prepared.directory, { recursive: true, force: true })
      this.prepared = undefined
    })
    this.tail = work.catch(() => {})
    return work
  }
  async beginRemoval(photoId: string): Promise<void> {
    this.removing.add(photoId)
    const running = this.running?.photoId === photoId ? this.running.work : undefined
    await this.cancel(photoId)
    // A queued request may have superseded this photo's active token while its
    // cancelled source decoder is still draining. Trash must join that owner too.
    await running?.catch(() => {})
  }
  endRemoval(photoId: string): void {
    this.removing.delete(photoId)
  }
  async close(): Promise<void> {
    this.closed = true
    this.active?.abort.abort()
    ++this.sequence
    await this.tail.catch(() => {})
    await Promise.all([this.runtime.close(), this.decoder.close(true)])
    this.proposal = undefined
    if (this.prepared) await rm(this.prepared.directory, { recursive: true, force: true })
    this.prepared = undefined
  }
}

export function selectedMaskStack(
  current: readonly MaskDescriptor[],
  request: ObjectSelectionRequest,
  base: MaskBaseContent,
  id: string,
): MaskDescriptor[] {
  const reference = { version: 1 as const, hash: base.hash, width: base.width, height: base.height }
  if (request.maskId) {
    if (!current.some((mask) => mask.id === request.maskId))
      throw new Error('The selected mask is unavailable.')
    return current.map((mask) => (mask.id === request.maskId ? { ...mask, base: reference } : mask))
  }
  return [
    {
      id,
      name: 'Object',
      enabled: true,
      inverted: false,
      head: null,
      base: reference,
      light: { ...neutralMaskLight },
      color: { ...neutralMaskColor },
      edge: { ...neutralMaskEdge },
    },
    ...current,
  ]
}
