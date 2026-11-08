import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_PREVIEW_LIMIT } from '../../shared/agent'
import { cropGeometry, identityCrop } from '../../shared/crop'
import { exportGeometry } from '../../shared/export'
import { exportProofDecodePlan, requireExportAllocation } from '../../shared/export-resources'
import {
  OUTPUT_PROOF_VERSION,
  outputProofPixelKey,
  validateOutputProofRequest,
  type OutputProof,
  type OutputProofOverview,
  type OutputProofRequest,
  type OutputProofInspection,
} from '../../shared/export-proof'
import type { CropAdmission } from '../../shared/crop-resources'
import type { PreviewAssetStreamLease } from '../preview-asset-stream'
import { PreviewProcess } from '../preview-process'
import type { WorkScheduler } from '../work-scheduler'
import {
  validateWorkingAsset,
  type WorkingAssetLease,
  type WorkingAssetRendition,
} from '../working-assets'
import { hashFile } from './files'
import type { ExportJobs } from './jobs'
import { ExportProcess } from './process'
import type { ExportSource } from './types'
import type { OutputProofDecodeJob, OutputProofDecoded } from './proof-decode'
import { outputSharpeningMode } from '../../shared/output-sharpening'
import {
  INSPECTION_IMAGE_LIMIT,
  INSPECTION_PAIR_LIMIT,
  inspectionHdrCapability,
  resolveInspection,
  validateInspectionOptions,
  type InspectionImage,
  type InspectionOptions,
} from '../../shared/inspection'
import { inspectionContext, neutralInspectionSource } from '../agent/inspection-source'

interface Asset {
  path: string
  file: FileHandle
  byteLength: number
}
interface Entry {
  owner: string
  proof: OutputProof
  directory: string
  decoded: OutputProofDecoded
  assets: Map<string, Asset>
  streams: number
  abort: AbortController
  releaseSource: () => void
  releaseDisk: () => void
  draining?: () => void
  inspection?: InspectionImage
}
interface InspectionMemberRequest {
  options: InspectionOptions
  label: 'before' | 'after'
}
type Request = { token: string; abort: AbortController; work: Promise<OutputProof> }
type Decoder = (
  path: string,
  directory: string,
  job: OutputProofDecodeJob,
  signal: AbortSignal,
) => Promise<OutputProofDecoded>
const frozenLease = (lease?: WorkingAssetLease) =>
  lease
    ? structuredClone({
        identity: lease.identity,
        asset: lease.asset,
        backend: lease.backend,
        fallback: lease.fallback,
        detailSource: lease.detailSource,
      })
    : undefined

/** One isolated encode/decode candidate globally. Only its owner can replace or cancel it. */
export class OutputProofs {
  private requests = new Map<string, Request>()
  private entries = new Map<string, Entry>()
  private retirements = new Set<Promise<void>>()
  private tail: Promise<unknown> = Promise.resolve()
  private lifetime = new AbortController()
  private overviewBytes = 0
  private pendingCount = 0
  constructor(
    private root: string,
    private exports: ExportJobs,
    private scheduler: WorkScheduler,
    private acquireWorking: (
      source: ExportSource,
      signal: AbortSignal,
      rendition?: WorkingAssetRendition,
    ) => Promise<WorkingAssetLease | undefined>,
    private admission: (signal: AbortSignal) => Promise<CropAdmission>,
    private reserveDisk: (bytes: number) => Promise<() => void>,
    private renderer: Pick<ExportProcess, 'render'> = new ExportProcess(),
    private decode: Decoder = async (path, directory, job, signal) => {
      const worker = new PreviewProcess()
      try {
        return await worker.decodeOutputProof(path, directory, job, signal)
      } finally {
        await worker.close(true)
      }
    },
  ) {}
  get bytes() {
    return this.overviewBytes
  }

  request(
    owner: string,
    value: OutputProofRequest,
    signal?: AbortSignal,
    inspection?: InspectionMemberRequest,
  ): Promise<OutputProof> {
    const request = validateOutputProofRequest(value)
    if (this.lifetime.signal.aborted)
      return Promise.reject(new Error('Output preview service is closed.'))
    if (this.pendingCount >= 32)
      return Promise.reject(
        new Error('Output preview is busy. Try again after the current request.'),
      )
    if (this.requests.get(owner)?.token === request.token)
      return Promise.reject(new Error('Use a distinct output preview request token.'))
    this.requests.get(owner)?.abort.abort(new Error('Output preview superseded.'))
    const abort = new AbortController(),
      active = AbortSignal.any([abort.signal, this.lifetime.signal, ...(signal ? [signal] : [])])
    const work = this.tail.then(() =>
      this.scheduler.detached(() =>
        this.scheduler.run(
          'interactive',
          () => this.render(owner, request, active, inspection),
          active,
        ),
      ),
    )
    const pending = { token: request.token, abort, work }
    this.pendingCount++
    this.requests.set(owner, pending)
    this.tail = work.catch(() => undefined)
    void work
      .finally(() => {
        this.pendingCount--
        if (this.requests.get(owner) === pending) this.requests.delete(owner)
      })
      .catch(() => undefined)
    return work
  }
  cancel(owner: string, token: string) {
    const request = this.requests.get(owner)
    if (request?.token === token) request.abort.abort(new Error('Output preview cancelled.'))
  }
  async disposeOwner(owner: string) {
    const request = this.requests.get(owner)
    request?.abort.abort(new Error('Output preview owner closed.'))
    await request?.work.catch(() => undefined)
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => e.owner === owner)
        .map((e) => this.release(owner, e.proof.id)),
    )
  }
  private async render(
    owner: string,
    request: OutputProofRequest,
    signal: AbortSignal,
    inspection?: InspectionMemberRequest,
  ): Promise<OutputProof> {
    signal.throwIfAborted()
    if (this.entries.size >= 2)
      throw new Error('Release the previous output preview before generating another.')
    const sourceLease = this.exports.acquireProofSource(request.preparationId, request.photoId)
    const { pipeline } = sourceLease,
      source =
        inspection?.label === 'before'
          ? neutralInspectionSource(sourceLease.source)
          : sourceLease.source
    let working: WorkingAssetLease | undefined,
      primary: WorkingAssetLease | undefined,
      releaseDisk: (() => void) | undefined
    const assets = new Map<string, Asset>(),
      id = randomUUID(),
      directory = join(this.root, 'cache', 'output-proofs', id)
    let retained = false
    try {
      await sourceLease.validate()
      signal.throwIfAborted()
      const pixelKey = outputProofPixelKey(request.options, source.hdr),
        hdr = JSON.parse(pixelKey).output === 'hdr'
      if (source.photo.assetKind !== 'derived' && (await hashFile(source.path)) !== source.photo.id)
        throw new Error('The managed output preview original is damaged.')
      const dimensions = source.processing.metadata.mergeMaster?.asset ?? source.photo
      if (!dimensions.width || !dimensions.height)
        throw new Error('Output preview source dimensions are unavailable.')
      const input = cropGeometry(
        { width: dimensions.width, height: dimensions.height },
        source.processing.crop ?? identityCrop,
      )
      const estimate = exportGeometry(input.width, input.height, request.options.size)
      // Reserve source preparation, spatial intermediates, output planes and bounded compressed bytes.
      releaseDisk = await this.reserveDisk(
        dimensions.width * dimensions.height * 32 +
          estimate.width * estimate.height * 24 +
          (outputSharpeningMode(request.options) === 'off'
            ? 0
            : estimate.width * estimate.height * (hdr ? 24 : 12)) +
          256 * 1024 ** 2,
      )
      await mkdir(join(directory, 'render'), { recursive: true })
      await mkdir(join(directory, 'decoded'))
      if (!source.processing.metadata.mergeMaster) {
        working = await this.acquireWorking(source, signal)
        if (source.hdr && source.processing.metadata.hdrJpeg)
          primary = await this.acquireWorking(source, signal, 'primary')
      }
      const admission = await this.admission(signal)
      const result = await this.renderer.render(
        {
          source,
          options: request.options,
          hdr,
          directory: join(directory, 'render'),
          preparationDirectory: join(directory, 'preparation'),
          workingAsset: frozenLease(working),
          primaryWorkingAsset: frozenLease(primary),
          cropPolicy: pipeline.crop,
          detailPolicy: pipeline.detail,
          resizePolicy: pipeline.resize,
          outputSharpeningPolicy: pipeline.outputSharpening,
          cropAdmission: admission,
          detailAdmission: admission,
          resizeAdmission: admission,
          outputSharpeningAdmission: admission,
        },
        signal,
      )
      // ExportProcess resolves only after the encoder process and its children have exited.
      working?.release()
      working = undefined
      primary?.release()
      primary = undefined
      signal.throwIfAborted()
      await sourceLease.validate()
      const outputPaths = [
        join(directory, 'render', 'output.jpg'),
        ...(hdr ? [join(directory, 'render', 'encoder-output.jpg')] : []),
      ]
      if (!outputPaths.includes(result.path) || !result.geometry)
        throw new Error('Invalid encoded output preview.')
      const info = await lstat(result.path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await hashFile(result.path)) !== result.sha256
      )
        throw new Error('The encoded output preview is damaged.')
      if (inspection && !result.sourceGeometry)
        throw new Error('Output inspection requires authoritative source geometry.')
      const context = inspection
          ? inspectionContext(sourceLease.source, result.sourceGeometry!)
          : undefined,
        resolved =
          inspection && context
            ? resolveInspection(inspection.options, context, result.geometry)
            : undefined
      const decodeJob = {
        ...result.geometry,
        hdr,
        admission: await this.admission(signal),
        ...(resolved ? { inspection: resolved } : {}),
      }
      requireExportAllocation(
        exportProofDecodePlan(
          decodeJob.width,
          decodeJob.height,
          hdr,
          info.size,
          decodeJob.admission,
        ),
      )
      const decoded = await this.decode(result.path, join(directory, 'decoded'), decodeJob, signal)
      signal.throwIfAborted()
      await sourceLease.validate()
      if (
        decoded.width !== result.geometry.width ||
        decoded.height !== result.geometry.height ||
        decoded.byteLength !== decoded.width * decoded.height * 4 ||
        hdr !== !!decoded.linear?.hdr ||
        (!inspection &&
          (decoded.overview.width < 1 ||
            decoded.overview.height < 1 ||
            Math.max(decoded.overview.width, decoded.overview.height) > 1024 ||
            decoded.overview.byteLength > AGENT_PREVIEW_LIMIT))
      )
        throw new Error('Invalid decoded output preview dimensions.')
      const identity = createHash('sha256')
        .update(
          JSON.stringify({
            version: OUTPUT_PROOF_VERSION,
            source: source.photo.id,
            revision: source.processing.revision,
            processing: source.processing,
            sourceIdentity: source.identity,
            pipeline,
            pixelKey,
          }),
        )
        .digest('hex')
      const addAsset = async (name: string, path: string, byteLength: number, sha256: string) => {
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        assets.set(name, { path, file, byteLength })
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== byteLength || (await hashFile(path)) !== sha256)
          throw new Error('The decoded output preview is incomplete or damaged.')
      }
      await addAsset(
        'primary',
        join(directory, 'decoded', 'primary.rgba'),
        decoded.byteLength,
        decoded.sha256,
      )
      if (!inspection)
        await addAsset(
          'overview',
          join(directory, 'decoded', 'overview.jpg'),
          decoded.overview.byteLength,
          decoded.overview.sha256,
        )
      if (decoded.linear) {
        await validateWorkingAsset(
          {
            ...decoded.linear,
            width: decoded.width,
            height: decoded.height,
            path: join(directory, 'decoded', 'linear.f32'),
          },
          signal,
        )
        await addAsset(
          'linear',
          join(directory, 'decoded', 'linear.f32'),
          decoded.linear.byteLength,
          decoded.linear.sha256,
        )
      }
      const url = (name: string) => `irodori-photo://output-proof/${id}/${name}`
      const proof: OutputProof = {
        version: OUTPUT_PROOF_VERSION,
        id,
        identity,
        photoId: source.photo.id,
        revision: source.processing.revision,
        filename: source.photo.filename,
        output: hdr ? 'hdr' : 'sdr',
        quality: request.options.quality,
        outputSharpening: outputSharpeningMode(request.options),
        width: decoded.width,
        height: decoded.height,
        resizeMethod: result.diagnostics
          ? result.diagnostics.resize
            ? 'lanczos3'
            : 'original'
          : decoded.width === input.width && decoded.height === input.height
            ? 'original'
            : 'lanczos3',
        pixelKey,
        pipeline,
        primary: {
          photoId: source.photo.id,
          requestId: request.token,
          url: url('primary'),
          width: decoded.width,
          height: decoded.height,
          format: 'rgba8-srgb',
          byteLength: decoded.byteLength,
          sha256: decoded.sha256,
          renderId: identity,
        },
        ...(decoded.linear
          ? {
              linear: {
                ...decoded.linear,
                url: url('linear'),
                hdr: { ...decoded.linear.hdr!, url: url('linear') },
              },
            }
          : {}),
      }
      let inspectionImage: InspectionImage | undefined
      if (inspection && context && resolved) {
        const transfer = decoded.inspection
        if (
          !transfer ||
          transfer.width !== resolved.width ||
          transfer.height !== resolved.height ||
          transfer.byteLength > INSPECTION_IMAGE_LIMIT ||
          transfer.byteLength < 1 ||
          transfer.mimeType !== (resolved.encoding.format === 'png' ? 'image/png' : 'image/jpeg')
        )
          throw new Error('Invalid decoded output inspection image.')
        const path = join(
          directory,
          'decoded',
          `inspection.${resolved.encoding.format === 'png' ? 'png' : 'jpg'}`,
        )
        await addAsset('inspection', path, transfer.byteLength, transfer.sha256)
        const bytes = await readFile(path)
        inspectionImage = {
          label: inspection.label,
          photoId: proof.photoId,
          revision: proof.revision,
          renderingIdentity: createHash('sha256')
            .update(JSON.stringify({ identity, label: inspection.label, resolved }))
            .digest('hex'),
          gridIdentity: context.gridIdentity,
          width: transfer.width,
          height: transfer.height,
          native: 'export-native',
          photoBounds: resolved.photoBounds,
          bounds: resolved.bounds,
          nativeGrid: result.geometry,
          encoding: resolved.encoding,
          mimeType: transfer.mimeType,
          colorSpace: 'srgb',
          sourceDynamicRange: context.sourceDynamicRange,
          sourceMetadata: context.sourceMetadata,
          requestedRendition: 'sdr',
          effectiveRendition: 'sdr',
          hdr: { ...inspectionHdrCapability },
          rendition: 'sRGB SDR rendition',
          comparison:
            inspection.label === 'before'
              ? 'neutral rendition derived from current revision'
              : 'current revision',
          byteLength: bytes.byteLength,
          data: bytes.toString('base64'),
        }
      }
      // No retained source preparation or rendered intermediates in a completed proof.
      await rm(join(directory, 'preparation'), { recursive: true, force: true })
      await rm(join(directory, 'render'), { recursive: true, force: true })
      releaseDisk()
      releaseDisk = undefined
      releaseDisk = await this.reserveDisk(
        [...assets.values()].reduce((sum, asset) => sum + asset.byteLength, 0),
      )
      signal.throwIfAborted()
      await sourceLease.validate()
      this.entries.set(id, {
        owner,
        proof,
        directory,
        decoded,
        assets,
        streams: 0,
        abort: new AbortController(),
        releaseSource: sourceLease.release,
        releaseDisk,
        inspection: inspectionImage,
      })
      retained = true
      return structuredClone(proof)
    } finally {
      working?.release()
      primary?.release()
      if (!retained) {
        await Promise.all([...assets.values()].map((asset) => asset.file.close()))
        await rm(directory, { recursive: true, force: true })
        releaseDisk?.()
        sourceLease.release()
      }
    }
  }
  acquire(url: URL): PreviewAssetStreamLease | undefined {
    if (
      url.protocol !== 'irodori-photo:' ||
      url.hostname !== 'output-proof' ||
      url.search ||
      url.hash
    )
      return
    const match = /^\/([a-f0-9-]{36})\/(primary|linear)$/.exec(url.pathname)
    if (!match) return
    const entry = this.entries.get(match[1]),
      asset = entry?.assets.get(match[2])
    if (!entry || !asset || entry.abort.signal.aborted) return
    entry.streams++
    let released = false
    return {
      ...asset,
      contentType: 'application/octet-stream',
      signal: entry.abort.signal,
      release: () => {
        if (!released) {
          released = true
          entry.streams--
          if (!entry.streams) entry.draining?.()
        }
      },
    }
  }
  release(owner: string, id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner) return Promise.resolve()
    this.entries.delete(id)
    entry.abort.abort()
    const work = (async () => {
      if (entry.streams)
        await new Promise<void>((resolve) => {
          entry.draining = resolve
        })
      try {
        await Promise.all([...entry.assets.values()].map((asset) => asset.file.close()))
        await rm(entry.directory, { recursive: true, force: true })
      } finally {
        entry.releaseSource()
        entry.releaseDisk()
      }
    })()
    this.retirements.add(work)
    void work.finally(() => this.retirements.delete(work)).catch(() => undefined)
    return work
  }
  async inspect(
    value: OutputProofRequest,
    options: InspectionOptions,
    signal?: AbortSignal,
  ): Promise<OutputProofInspection> {
    const request = validateOutputProofRequest(value),
      inspection = validateInspectionOptions(options)
    if (inspection.hdr) throw new Error(inspectionHdrCapability.reason)
    const owner = `console:${randomUUID()}`,
      frozen = this.exports.acquireProofSource(request.preparationId, request.photoId),
      members: InspectionImage[] = []
    let exportMetadata: OutputProofInspection['export'] | undefined,
      retainedBytes = 0
    try {
      await frozen.validate()
      const labels: ('before' | 'after')[] =
        inspection.comparison === 'pair' ? ['before', 'after'] : [inspection.comparison ?? 'after']
      for (const label of labels) {
        await frozen.validate()
        signal?.throwIfAborted()
        const proof = await this.request(owner, { ...request, token: randomUUID() }, signal, {
          options: inspection,
          label,
        })
        try {
          const image = this.entries.get(proof.id)?.inspection
          if (!image) throw new Error('Output inspection did not produce an image.')
          members.push(structuredClone(image))
          const { version, output, quality, outputSharpening, width, height, pixelKey, pipeline } =
            proof
          exportMetadata = {
            version,
            output,
            quality,
            outputSharpening,
            width,
            height,
            pixelKey,
            pipeline,
          }
          const bytes = Buffer.byteLength(image.data)
          this.overviewBytes += bytes
          retainedBytes += bytes
        } finally {
          // Release full decoded planes before encoding/decoding the next complete JPEG.
          await this.release(owner, proof.id)
        }
      }
      await frozen.validate()
      signal?.throwIfAborted()
      if (members.reduce((sum, member) => sum + member.byteLength, 0) > INSPECTION_PAIR_LIMIT)
        throw new Error(
          'Inspection exceeds its 16 MiB pair limit. Request a smaller region or lower resolution.',
        )
      if (members.some((member) => member.gridIdentity !== members[0].gridIdentity))
        throw new Error('The output inspection grid changed. Select the region again.')
      return {
        photoId: request.photoId,
        revision: frozen.source.processing.revision,
        gridIdentity: members[0].gridIdentity,
        members,
        export: exportMetadata!,
      }
    } finally {
      try {
        await this.disposeOwner(owner)
      } finally {
        frozen.release()
        this.overviewBytes -= retainedBytes
      }
    }
  }
  async overview(request: OutputProofRequest, signal?: AbortSignal): Promise<OutputProofOverview> {
    const owner = `console:${randomUUID()}`
    try {
      const proof = await this.request(owner, request, signal),
        entry = this.entries.get(proof.id)!
      this.overviewBytes += AGENT_PREVIEW_LIMIT * 3
      try {
        signal?.throwIfAborted()
        const bytes = await readFile(entry.assets.get('overview')!.path)
        if (
          bytes.byteLength > AGENT_PREVIEW_LIMIT ||
          createHash('sha256').update(bytes).digest('hex') !== entry.decoded.overview.sha256
        )
          throw new Error('The output preview overview is damaged.')
        const { primary, linear, id, ...metadata } = proof
        void primary
        void linear
        void id
        return {
          ...metadata,
          overview: {
            width: entry.decoded.overview.width,
            height: entry.decoded.overview.height,
            rendition:
              'SDR overview of decoded JPEG primary; inspect full resolution in Output preview',
            mimeType: 'image/jpeg',
            byteLength: bytes.byteLength,
          },
          data: bytes.toString('base64'),
        }
      } finally {
        this.overviewBytes -= AGENT_PREVIEW_LIMIT * 3
      }
    } finally {
      await this.disposeOwner(owner)
    }
  }
  async close() {
    this.lifetime.abort(new Error('Output preview service closed.'))
    await this.tail
    await Promise.all([...this.entries.values()].map((e) => this.release(e.owner, e.proof.id)))
    await Promise.all(this.retirements)
  }
}
