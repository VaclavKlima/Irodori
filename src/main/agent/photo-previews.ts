import {
  resolveInspection,
  validateInspectionOptions,
  INSPECTION_IMAGE_LIMIT,
  INSPECTION_PAIR_LIMIT,
  inspectionHdrCapability,
  type InspectionOptions,
  type InspectionResult,
  type PreviewContext,
  type InspectionImage,
} from '../../shared/inspection'
import { neutralInspectionSource, prepareInspectionContext } from './inspection-source'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_PREVIEW_CACHE_LIMIT,
  AGENT_PREVIEW_LIMIT,
  type AgentPhotoPreview,
} from '../../shared/agent'
import { defaultExportOptions, EXPORT_RENDERING_VERSION } from '../../shared/export'
import { cropGeometry, identityCrop } from '../../shared/crop'
import type { CropAdmission } from '../../shared/crop-resources'
import { exportCropPolicy } from '../export/crop-policy'
import { exportDetailPolicy } from '../export/detail-policy'
import { exportResizePolicy } from '../export/resize-policy'
import { sameSource, hashFile } from '../export/files'
import { ExportProcess } from '../export/process'
import type { ExportSource } from '../export/types'
import type { WorkingAssetLease } from '../working-assets'
import type { WorkScheduler } from '../work-scheduler'

const freezeLease = (lease?: WorkingAssetLease) =>
  lease
    ? structuredClone({
        identity: lease.identity,
        asset: lease.asset,
        backend: lease.backend,
        fallback: lease.fallback,
        detailSource: lease.detailSource,
      })
    : undefined

/** A compact rendition, never an import thumbnail, original, screen capture or zoomed viewport. */
export class AgentPhotoPreviews {
  private cache = new Map<string, AgentPhotoPreview>()
  private retained = 0
  private tail: Promise<unknown> = Promise.resolve()
  private lifetime = new AbortController()
  constructor(
    private root: string,
    private source: (id: string) => Promise<ExportSource>,
    private current: (id: string) => Promise<number>,
    private acquire: (
      source: ExportSource,
      signal: AbortSignal,
      primary?: 'primary',
    ) => Promise<WorkingAssetLease | undefined>,
    private admission: (signal: AbortSignal) => Promise<CropAdmission>,
    private scheduler: WorkScheduler,
    private renderer: Pick<ExportProcess, 'render'> = new ExportProcess(),
  ) {}
  get bytes() {
    return this.retained
  }

  get(
    photoId: string,
    revision: number,
    signal = new AbortController().signal,
  ): Promise<AgentPhotoPreview> {
    if (!/^[a-f0-9]{64}$/.test(photoId) || !Number.isSafeInteger(revision) || revision < 0)
      return Promise.reject(new Error('Invalid preview photograph or revision.'))
    const work = this.tail.then(() =>
      this.render(photoId, revision, AbortSignal.any([signal, this.lifetime.signal])),
    )
    this.tail = work.catch(() => {})
    return work
  }
  context(
    photoId: string,
    revision: number,
    signal = new AbortController().signal,
  ): Promise<PreviewContext> {
    return this.enqueueInspection(
      photoId,
      revision,
      signal,
      async (source, directory, active, validate) => {
        const lease = await this.acquire(source, active)
        try {
          const prepared = await prepareInspectionContext(
            source,
            directory,
            active,
            freezeLease(lease),
          )
          await validate()
          return prepared.context
        } finally {
          lease?.release()
        }
      },
    )
  }

  inspect(
    photoId: string,
    revision: number,
    options: InspectionOptions,
    signal = new AbortController().signal,
  ): Promise<InspectionResult> {
    options = validateInspectionOptions(options)
    if (options.hdr) return Promise.reject(new Error(inspectionHdrCapability.reason))
    return this.enqueueInspection(
      photoId,
      revision,
      signal,
      async (source, directory, active, validate) => {
        const lease = await this.acquire(source, active)
        let primary: WorkingAssetLease | undefined
        try {
          const preparation = join(directory, 'source')
          await mkdir(preparation)
          const prepared = await prepareInspectionContext(
            source,
            preparation,
            active,
            freezeLease(lease),
          )
          const resolved = resolveInspection(options, prepared.context)
          if (source.hdr && source.processing.metadata.hdrJpeg)
            primary = await this.acquire(source, active, 'primary')
          const members: InspectionImage[] = []
          for (const label of resolved.labels) {
            await validate()
            const memberDirectory = join(directory, label)
            await mkdir(memberDirectory)
            const renditionSource = label === 'before' ? neutralInspectionSource(source) : source
            const baseAdmission = await this.admission(active)
            const admission = {
              ...baseAdmission,
              reservation: {
                ...baseAdmission.reservation,
                ramBytes:
                  baseAdmission.reservation.ramBytes +
                  members.reduce((bytes, member) => bytes + Buffer.byteLength(member.data), 0),
              },
            }
            const result = await this.renderer.render(
              {
                source: renditionSource,
                options: {
                  ...defaultExportOptions,
                  output: 'sdr',
                  metadata: 'none',
                  quality: resolved.encoding.format === 'jpeg' ? resolved.encoding.quality : 80,
                  size: {
                    mode: 'fit',
                    width: resolved.width,
                    height: resolved.height,
                    allowEnlargement: false,
                    method: 'lanczos3',
                  },
                },
                inspection: {
                  bounds: resolved.bounds,
                  width: resolved.width,
                  height: resolved.height,
                  encoding: resolved.encoding.format,
                },
                hdr: false,
                directory: memberDirectory,
                workingAsset: prepared.working,
                primaryWorkingAsset: freezeLease(primary),
                cropPolicy: { ...exportCropPolicy },
                cropAdmission: admission,
                detailPolicy: { ...exportDetailPolicy },
                detailAdmission: admission,
                resizePolicy: { ...exportResizePolicy },
                resizeAdmission: admission,
              },
              active,
            )
            await validate()
            const expectedPath = join(
              memberDirectory,
              resolved.encoding.format === 'png' ? 'output.png' : 'output.jpg',
            )
            if (
              result.path !== expectedPath ||
              result.geometry?.width !== resolved.width ||
              result.geometry?.height !== resolved.height
            )
              throw new Error(
                'The inspection renderer returned invalid geometry or an invalid output path.',
              )
            const info = await lstat(result.path)
            if (!info.isFile() || info.isSymbolicLink() || info.size > INSPECTION_IMAGE_LIMIT)
              throw new Error(
                'The inspection image exceeds 8 MiB. Request a smaller region, lower resolutionPercent, or JPEG with lower quality. Resolution and quality were not reduced.',
              )
            const encoded = await readFile(result.path)
            if (createHash('sha256').update(encoded).digest('hex') !== result.sha256)
              throw new Error('The encoded inspection image is incomplete.')
            const renderingIdentity = createHash('sha256')
              .update(
                JSON.stringify({
                  policy: 'inspection-v1',
                  rendering: EXPORT_RENDERING_VERSION,
                  photoId,
                  revision,
                  processing: renditionSource.processing,
                  identity: source.identity,
                  options,
                  label,
                }),
              )
              .digest('hex')
            members.push({
              label,
              photoId,
              revision,
              renderingIdentity,
              gridIdentity: prepared.context.gridIdentity,
              width: resolved.width,
              height: resolved.height,
              native: 'photo-native',
              photoBounds: resolved.photoBounds,
              bounds: resolved.bounds,
              nativeGrid: { width: prepared.context.width, height: prepared.context.height },
              encoding: resolved.encoding,
              mimeType: resolved.encoding.format === 'png' ? 'image/png' : 'image/jpeg',
              colorSpace: 'srgb',
              sourceDynamicRange: prepared.context.sourceDynamicRange,
              sourceMetadata: prepared.context.sourceMetadata,
              requestedRendition: 'sdr',
              effectiveRendition: 'sdr',
              hdr: prepared.context.hdr,
              rendition: 'sRGB SDR rendition',
              comparison:
                label === 'before'
                  ? 'neutral rendition derived from current revision'
                  : 'current revision',
              byteLength: encoded.byteLength,
              data: encoded.toString('base64'),
            })
          }
          if (
            members.reduce((bytes, member) => bytes + member.byteLength, 0) > INSPECTION_PAIR_LIMIT
          )
            throw new Error(
              'The inspection pair exceeds 16 MiB. Request smaller regions or lower resolution/quality.',
            )
          await validate()
          return { photoId, revision, gridIdentity: prepared.context.gridIdentity, members }
        } finally {
          primary?.release()
          lease?.release()
        }
      },
    )
  }

  private enqueueInspection<T>(
    photoId: string,
    revision: number,
    signal: AbortSignal,
    work: (
      source: ExportSource,
      directory: string,
      signal: AbortSignal,
      validate: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(photoId) || !Number.isSafeInteger(revision) || revision < 0)
      return Promise.reject(new Error('Invalid preview photograph or revision.'))
    const active = AbortSignal.any([signal, this.lifetime.signal])
    const pending = this.tail.then(async () => {
      active.throwIfAborted()
      const source = structuredClone(await this.source(photoId))
      const validate = async () => {
        active.throwIfAborted()
        if ((await this.current(photoId)) !== revision || source.processing.revision !== revision)
          throw new Error('Preview revision changed. Refresh confirmed edits before retrying.')
        if (!sameSource(await lstat(source.path), source.identity))
          throw new Error('The managed preview source changed.')
      }
      await validate()
      if (source.photo.assetKind !== 'derived' && (await hashFile(source.path)) !== photoId)
        throw new Error('The managed preview original changed or is damaged.')
      return this.scheduler.run(
        'interactive',
        async () => {
          const directory = join(this.root, 'cache', 'agent-previews', randomUUID())
          await mkdir(directory, { recursive: true })
          try {
            return await work(source, directory, active, validate)
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        },
        active,
      )
    })
    this.tail = pending.catch(() => {})
    return pending
  }

  private async render(
    photoId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<AgentPhotoPreview> {
    signal.throwIfAborted()
    const validate = async () => {
      signal.throwIfAborted()
      if ((await this.current(photoId)) !== revision)
        throw new Error('Preview revision changed. Refresh confirmed edits before retrying.')
    }
    await validate()
    const source = await this.source(photoId)
    const renderingIdentity = createHash('sha256')
      .update(
        JSON.stringify({
          policy: 'agent-sdr-jpeg-1024-q80-v1',
          rendering: EXPORT_RENDERING_VERSION,
          crop: exportCropPolicy,
          detail: exportDetailPolicy,
          resize: exportResizePolicy,
          photoId,
          revision,
          processing: source.processing,
          sourceIdentity: source.identity,
        }),
      )
      .digest('hex')
    const cached = this.cache.get(renderingIdentity)
    if (cached) {
      await validate()
      this.cache.delete(renderingIdentity)
      this.cache.set(renderingIdentity, cached)
      return { ...cached }
    }
    return this.scheduler.run(
      'interactive',
      async () => {
        await validate()
        const directory = join(this.root, 'cache', 'agent-previews', randomUUID())
        let working: WorkingAssetLease | undefined, primary: WorkingAssetLease | undefined
        await mkdir(directory, { recursive: true })
        try {
          if (
            !sameSource(await lstat(source.path), source.identity) ||
            (source.photo.assetKind !== 'derived' && (await hashFile(source.path)) !== photoId)
          )
            throw new Error('The managed preview original changed or is damaged.')
          if (!source.processing.metadata.mergeMaster) {
            working = await this.acquire(source, signal)
            if (source.hdr && source.processing.metadata.hdrJpeg)
              primary = await this.acquire(source, signal, 'primary')
          }
          const admission = await this.admission(signal)
          const result = await this.renderer.render(
            {
              source,
              options: {
                ...defaultExportOptions,
                output: 'sdr',
                metadata: 'none',
                quality: 80,
                size: { mode: 'longest', edge: 1024, allowEnlargement: false, method: 'lanczos3' },
              },
              hdr: false,
              directory,
              workingAsset: freezeLease(working),
              primaryWorkingAsset: freezeLease(primary),
              cropPolicy: { ...exportCropPolicy },
              cropAdmission: admission,
              detailPolicy: { ...exportDetailPolicy },
              detailAdmission: admission,
              resizePolicy: { ...exportResizePolicy },
              resizeAdmission: admission,
            },
            signal,
          )
          await validate()
          if (!sameSource(await lstat(source.path), source.identity))
            throw new Error('The managed preview source changed.')
          if (result.path !== join(directory, 'output.jpg'))
            throw new Error('Invalid preview output path.')
          const info = await lstat(result.path)
          if (!info.isFile() || info.isSymbolicLink() || info.size > AGENT_PREVIEW_LIMIT)
            throw new Error('The photo preview exceeds its 1 MiB payload limit.')
          const encoded = await readFile(result.path)
          if (createHash('sha256').update(encoded).digest('hex') !== result.sha256)
            throw new Error('The encoded preview is incomplete.')
          const asset = working?.asset ?? source.processing.workingAsset
          const geometry = result.geometry
          if (
            !geometry ||
            Math.max(geometry.width, geometry.height) > 1024 ||
            geometry.width < 1 ||
            geometry.height < 1
          )
            throw new Error('Invalid compact preview dimensions.')
          if (asset) {
            const cropped = cropGeometry(asset, source.processing.crop ?? identityCrop)
            if (geometry.width > cropped.width || geometry.height > cropped.height)
              throw new Error('A photo preview cannot enlarge its source.')
          }
          const preview: AgentPhotoPreview = {
            photoId,
            revision,
            renderingIdentity,
            ...geometry,
            colorSpace: 'srgb',
            rendition: 'sRGB SDR rendition',
            mimeType: 'image/jpeg',
            quality: 80,
            byteLength: encoded.byteLength,
            data: encoded.toString('base64'),
          }
          const bytes = Buffer.byteLength(preview.data)
          await validate()
          while (this.cache.size && this.retained + bytes > AGENT_PREVIEW_CACHE_LIMIT) {
            const [key, value] = this.cache.entries().next().value!
            this.retained -= Buffer.byteLength(value.data)
            this.cache.delete(key)
          }
          this.cache.set(renderingIdentity, preview)
          this.retained += bytes
          return { ...preview }
        } finally {
          primary?.release()
          working?.release()
          await rm(directory, { recursive: true, force: true })
        }
      },
      signal,
    )
  }
  async close() {
    this.lifetime.abort()
    await this.tail
    this.cache.clear()
    this.retained = 0
  }
}
