import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  INSPECTION_IMAGE_LIMIT,
  INSPECTION_PAIR_LIMIT,
  resolveInspection,
  type InspectionBounds,
  type InspectionOptions,
  type InspectionResult,
  type PreviewContext,
} from '../../shared/inspection'
import {
  validatePhotoDiagnosticsRequest,
  type DiagnosticImage,
  type DiagnosticPart,
  type PhotoDiagnosticsRequest,
  type PhotoDiagnosticsResult,
} from '../../shared/photo-diagnostics'
import { SDR_TARGET, type DisplayTarget } from '../../shared/hdr'
import type { AgentPresentationContext } from '../../shared/agent-presentation'
import type { PhotoStatistics } from '../../shared/statistics'
import type { HdrPhotoStatistics } from '../../shared/hdr-statistics'
import type { CropAdmission } from '../../shared/crop-resources'
import type { PreviewDiskReservation } from '../preview-types'
import { MaskEdgeProcess } from '../mask-edges/process'

type Size = { width: number; height: number }
type HdrMap = {
  mask: Uint8Array
  aboveWhite: number
  exceedingHeadroom: number | null
  outputClipped: number
  gamutLimited: number
}

interface PhotoDiagnosticOwners {
  context(id: string, revision: number, signal: AbortSignal): Promise<PreviewContext>
  presentation(id: string, revision: number): Promise<AgentPresentationContext>
  getDisplayTarget(): DisplayTarget | undefined
  hdrMap(
    id: string,
    revision: number,
    target: DisplayTarget,
    bounds: InspectionBounds,
    size: Size,
    signal: AbortSignal,
  ): Promise<HdrMap>
  hdrStatistics(
    id: string,
    revision: number,
    target: DisplayTarget,
    bounds: InspectionBounds,
    signal: AbortSignal,
  ): Promise<HdrPhotoStatistics>
  sdrStatistics(
    id: string,
    revision: number,
    bounds: InspectionBounds,
    size: Size,
    signal: AbortSignal,
  ): Promise<PhotoStatistics & { mask: Uint8Array }>
  photo(
    id: string,
    revision: number,
    options: InspectionOptions,
    signal: AbortSignal,
  ): Promise<InspectionResult>
  admission(signal: AbortSignal): Promise<CropAdmission>
  reserve(bytes: number): Promise<PreviewDiskReservation>
}

const available = <T>(value: T): DiagnosticPart<T> => ({ status: 'available', value })
const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason })
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function part<T>(work: Promise<T>, signal: AbortSignal): Promise<DiagnosticPart<T>> {
  try {
    return available(await work)
  } catch (error) {
    signal.throwIfAborted()
    return unavailable(error instanceof Error ? error.message : String(error))
  }
}

export class PhotoDiagnostics {
  private active?: { id: string; abort: AbortController; work: Promise<PhotoDiagnosticsResult> }
  private removing = new Set<string>()
  private cleanup = new Map<string, PreviewDiskReservation>()
  private closed = false

  constructor(
    private root: string,
    private owner: PhotoDiagnosticOwners,
    private runtime: Pick<MaskEdgeProcess, 'diagnosticOverlays' | 'close'> = new MaskEdgeProcess(),
  ) {}

  get(value: PhotoDiagnosticsRequest, external: AbortSignal): Promise<PhotoDiagnosticsResult> {
    const request = validatePhotoDiagnosticsRequest(value)
    if (this.closed || this.removing.has(request.photoId))
      throw new Error(
        'Photo diagnostics are unavailable while the photograph is closing or being removed.',
      )
    if (this.active)
      throw new Error('Photo diagnostics are busy. Retry after the current request finishes.')
    const abort = new AbortController()
    const work = this.run(request, AbortSignal.any([abort.signal, external])).finally(() => {
      if (this.active?.abort === abort) this.active = undefined
    })
    this.active = { id: request.photoId, abort, work }
    return work
  }

  async beginRemoval(id: string) {
    this.removing.add(id)
    if (this.active?.id !== id) return
    this.active.abort.abort(new Error('The diagnostic photograph is being removed.'))
    await this.active.work.catch(() => undefined)
  }

  endRemoval(id: string) {
    this.removing.delete(id)
  }

  async close() {
    this.closed = true
    this.active?.abort.abort(new Error('Photo diagnostics are closing.'))
    await this.active?.work.catch(() => undefined)
    await this.runtime.close()
    for (const [path, release] of this.cleanup) {
      await rm(path, { recursive: true, force: true })
      this.cleanup.delete(path)
      release()
    }
  }

  private async target(request: PhotoDiagnosticsRequest) {
    if (request.target === 'sdr')
      return { selection: 'sdr' as const, target: SDR_TARGET, generation: SDR_TARGET.generation }
    const presentation = await this.owner.presentation(request.photoId, request.expectedRevision)
    const latest = this.owner.getDisplayTarget()
    if (
      presentation.frame.status !== 'presented' ||
      !latest ||
      latest.generation !== request.targetGeneration ||
      presentation.workspaceTarget.targetGeneration !== latest.generation ||
      latest.presentation?.photoId !== request.photoId ||
      latest.presentation.revision !== request.expectedRevision ||
      latest.presentation.targetGeneration !== latest.generation ||
      latest.presentation.stage !== 'presented' ||
      latest.presentation.mode !== presentation.frame.mode
    )
      throw new Error(
        'The current display or photo revision changed. Read presentation context before retrying.',
      )
    if (presentation.frame.mode === 'hdr' && latest.mode !== 'hdr')
      throw new Error('HDR diagnostics require a matching HDR display target.')
    return {
      selection: 'current' as const,
      target: presentation.frame.mode === 'hdr' ? latest : SDR_TARGET,
      generation: latest.generation,
    }
  }

  private async run(
    request: PhotoDiagnosticsRequest,
    signal: AbortSignal,
  ): Promise<PhotoDiagnosticsResult> {
    const { photoId, expectedRevision: revision } = request
    signal.throwIfAborted()
    const [context, selection] = await Promise.all([
      this.owner.context(photoId, revision, signal),
      this.target(request),
    ])
    signal.throwIfAborted()
    if (context.photoId !== photoId || context.revision !== revision)
      throw new Error('The diagnostics photo or revision changed.')
    const options: InspectionOptions = { region: request.region, encoding: { format: 'png' } }
    const resolved = resolveInspection(options, context)
    const bounds = resolved.photoBounds
    const size = { width: resolved.width, height: resolved.height }
    const { target } = selection
    const hdrTarget = target.mode === 'hdr'
    const hdr = context.sourceDynamicRange === 'hdr'
    const base = {
      photoId,
      revision,
      gridIdentity: context.gridIdentity,
      bounds,
      nativeGrid: { width: context.width, height: context.height },
      sourceDynamicRange: context.sourceDynamicRange,
      target: {
        selection: selection.selection,
        mode: target.mode,
        colorSpace: target.colorSpace,
        generation: selection.generation,
        headroom: target.headroom,
      },
    }

    const hdrMap = hdr
      ? await part(this.owner.hdrMap(photoId, revision, target, bounds, size, signal), signal)
      : unavailable('This photograph has an SDR source.')
    const result: PhotoDiagnosticsResult = {
      ...base,
      histogram: unavailable('Histogram unavailable.'),
      clipping: unavailable('Clipping map unavailable.'),
      aboveWhite:
        hdrMap.status === 'available'
          ? available({
              domain: 'content-hdr',
              referenceWhite: 1,
              exact: true,
              count: hdrMap.value.aboveWhite,
              exceedingHeadroom: hdrMap.value.exceedingHeadroom,
              gamutLimited: hdrTarget ? hdrMap.value.gamutLimited : null,
            })
          : hdrMap,
      images: [],
    }
    const maps: {
      label: DiagnosticImage['label']
      mask: Uint8Array
      legend: Record<string, string>
    }[] = []
    if (hdrTarget) {
      const statistics = await part(
        this.owner.hdrStatistics(photoId, revision, target, bounds, signal),
        signal,
      )
      result.histogram =
        statistics.status === 'available'
          ? available({ domain: 'output-hdr', exact: true, statistics: statistics.value })
          : statistics
      result.clipping =
        hdrMap.status === 'available'
          ? available({ exact: true, counts: { output: hdrMap.value.outputClipped } })
          : hdrMap
      if (hdrMap.status === 'available')
        maps.push({
          label: 'clipping',
          mask: hdrMap.value.mask,
          legend: { red: 'HDR output channel clipped' },
        })
    } else {
      const sdr = await part(
        this.owner.sdrStatistics(photoId, revision, bounds, size, signal),
        signal,
      )
      if (sdr.status === 'available') {
        const { mask, ...statistics } = sdr.value
        result.histogram = available({ domain: 'output-sdr', exact: true, statistics })
        result.clipping = available({
          exact: true,
          counts: { highlights: statistics.highlightClipped, shadows: statistics.shadowClipped },
        })
        maps.push({
          label: 'clipping',
          mask,
          legend: {
            red: 'SDR highlight clipping',
            blue: 'SDR shadow clipping',
            magenta: 'Both clipping types in this reduced pixel',
          },
        })
      } else {
        result.histogram = sdr
        result.clipping = sdr
      }
    }
    if (hdrMap.status === 'available')
      maps.push({
        label: 'above-white',
        mask: hdrMap.value.mask,
        legend: { cyan: 'HDR content luminance above reference white (1×)' },
      })

    if (maps.length) {
      const images = await part(
        this.encode(request, context, options, bounds, size, target, maps, signal),
        signal,
      )
      if (images.status === 'available') result.images = images.value
      else result.imagesUnavailable = images.reason
    }
    signal.throwIfAborted()
    const current = await this.owner.context(photoId, revision, signal)
    const finalTarget = await this.target(request)
    signal.throwIfAborted()
    if (current.gridIdentity !== context.gridIdentity || current.revision !== revision)
      throw new Error('The diagnostic grid or revision changed.')
    if (
      finalTarget.generation !== selection.generation ||
      finalTarget.target.mode !== target.mode ||
      finalTarget.target.colorSpace !== target.colorSpace ||
      finalTarget.target.peak !== target.peak ||
      finalTarget.target.headroom !== target.headroom
    )
      throw new Error('The diagnostic display target changed.')
    return result
  }

  private async encode(
    request: PhotoDiagnosticsRequest,
    context: PreviewContext,
    options: InspectionOptions,
    bounds: InspectionBounds,
    size: Size,
    target: DisplayTarget,
    maps: { label: DiagnosticImage['label']; mask: Uint8Array; legend: Record<string, string> }[],
    signal: AbortSignal,
  ): Promise<DiagnosticImage[]> {
    const { width, height } = size
    if (maps.some(({ mask }) => !(mask instanceof Uint8Array) || mask.length !== width * height))
      throw new Error('Diagnostic mask dimensions changed.')
    const release = await this.owner.reserve(INSPECTION_IMAGE_LIMIT * (1 + maps.length))
    let directory: string | undefined
    try {
      const root = join(this.root, 'cache', 'photo-diagnostics')
      await mkdir(root, { recursive: true })
      directory = await mkdtemp(join(root, 'diagnostic-'))
      const photo = await this.owner.photo(
        request.photoId,
        request.expectedRevision,
        options,
        signal,
      )
      const member = photo.members[0]
      const shown = member?.photoBounds
      if (
        photo.photoId !== request.photoId ||
        photo.revision !== request.expectedRevision ||
        photo.gridIdentity !== context.gridIdentity ||
        photo.members.length !== 1 ||
        !member ||
        member.width !== width ||
        member.height !== height ||
        member.mimeType !== 'image/png' ||
        shown?.x !== bounds.x ||
        shown.y !== bounds.y ||
        shown.width !== bounds.width ||
        shown.height !== bounds.height ||
        member.byteLength > INSPECTION_IMAGE_LIMIT
      )
        throw new Error('The diagnostic image does not match the committed photo region.')
      const admission = await this.owner.admission(signal)
      // PNG transport strings, decoded RGBA, masks and sequential encode work.
      const ramBytes =
        member.data.length * 2 +
        INSPECTION_IMAGE_LIMIT * (3 + maps.length * 4) +
        width * height * (16 + maps.length * 5)
      if (admission.reservation.ramBytes + ramBytes > admission.policy.ram.effectiveBytes)
        throw new Error('Diagnostic overlays exceed the current managed image-memory budget.')
      const basePath = join(directory, 'base.png')
      const baseBytes = Buffer.from(member.data, 'base64')
      if (baseBytes.length !== member.byteLength)
        throw new Error('The diagnostic image is incomplete.')
      await writeFile(basePath, baseBytes, { flag: 'wx' })
      const masks = maps.map(({ label, mask }) => ({
        label,
        ...size,
        dataBase64: Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength).toString('base64'),
        outputPath: join(directory!, label + '.png'),
        targetMode: target.mode,
      }))
      const outputs = await this.runtime.diagnosticOverlays({ basePath, masks }, signal)
      signal.throwIfAborted()
      if (
        outputs.length !== masks.length ||
        outputs.reduce((n, output) => n + output.byteLength, 0) > INSPECTION_PAIR_LIMIT
      )
        throw new Error('Diagnostic overlays exceed the inspection delivery limit.')
      return await Promise.all(
        outputs.map(async (output, index): Promise<DiagnosticImage> => {
          const expected = masks[index]
          if (
            output.label !== expected.label ||
            output.path !== expected.outputPath ||
            output.width !== width ||
            output.height !== height ||
            output.byteLength > INSPECTION_IMAGE_LIMIT
          )
            throw new Error('Invalid diagnostic overlay output.')
          const info = await lstat(output.path)
          if (!info.isFile() || info.size !== output.byteLength)
            throw new Error('Diagnostic overlay is incomplete.')
          const data = await readFile(output.path)
          if (sha(data) !== output.sha256) throw new Error('Diagnostic overlay hash changed.')
          return {
            label: output.label,
            width,
            height,
            mimeType: 'image/png',
            byteLength: data.length,
            sha256: output.sha256,
            legend: maps[index].legend,
            data: data.toString('base64'),
          }
        }),
      )
    } finally {
      if (directory) {
        const owned = directory
        this.cleanup.set(owned, release)
        await rm(owned, { recursive: true, force: true })
        this.cleanup.delete(owned)
      }
      release()
    }
  }
}
