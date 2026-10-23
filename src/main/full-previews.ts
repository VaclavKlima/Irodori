import type { PhotoStatistics } from '../shared/statistics'
import type { HdrPhotoStatistics, HdrAnalysisDomain } from '../shared/hdr-statistics'
import type { HdrPhotoPixel } from '../shared/hdr-pixel'
import {
  validateHdrSource,
  HDR_SOURCE_VERSION,
  HDR_RAW_SOURCE_VERSION,
  HDR_JPEG_SOURCE_VERSION,
  hdrSourceVersion,
  HDR_ADJUSTMENT_VERSION,
  HDR_OUTPUT_VERSION,
  type DisplayTarget,
} from '../shared/hdr'
import { ADJUSTMENT_VERSION, neutralAdjustments, sameAdjustments } from '../shared/adjustments'
import type { ProcessingOptions } from '../shared/lens'
import { CROP_POLICY, LENS_RENDER_VERSION } from './processing/lens-correction'
import { rawDecoderDefinitions } from './processing/formats'
import { cameraProfile, cameraProfiles } from './processing/cameras'
import { frameByteLength, PREVIEW_ASSET_VERSION } from '../shared/preview-frame'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
  open,
  type FileHandle,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import type {
  NativeCpuController,
  CpuWorkingLease,
  CpuMaskSourceLease,
} from './native-cpu-controller'
import type { CpuPreviewRequest } from '../shared/native-cpu-preview'
import type { NativeHdrMaskRequest } from '../shared/native-hdr-mask'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import type { FullPreview, HdrPreview, DisplayPreview } from '../shared/contracts'
import type {
  FullPreviewProcessor,
  FullPreviewResult,
  HdrStatisticsJob,
  HdrFirstSurfaceArtifact,
  HdrFirstSurfaceProgress,
  PreviewWarmResult,
} from './preview-types'
import {
  validateHdrFirstSurfaceRequest,
  validateHdrFirstSurfaceOrientation,
  hdrFirstSurfaceRequestKey,
  HDR_FIRST_SURFACE_VERSION,
  type HdrFirstSurfaceRequest,
  type HdrFirstSurfacePreparation,
  type HdrFirstSurfaceOffer,
} from '../shared/hdr-first-surface'
import {
  validateManagedImageBytes,
  type ManagedImageBytes,
  type ResourcePolicySnapshot,
} from '../shared/resource-policy'
import { HDR_SOURCE_MIP_POLICY } from '../renderer/src/preview/hdr-source-cache'
import { hdrCacheTileSize } from '../renderer/src/preview/hdr-render-cache'
import {
  hdrCacheKernel,
  hdrMipShader,
  hdrOrientedMipShader,
  hdrShader,
  type HdrCacheKernelKind,
} from '../renderer/src/preview/hdr-shader'
import { HDR_RENDERING_TABLE_HASHES } from '../shared/hdr-rendering-tables'
import type { WorkScheduler } from './work-scheduler'
import {
  validateWorkingAsset,
  workingSourceIdentity,
  type WorkingAssetLease,
} from './working-assets'

// Cache layout version. Source and output identities separately invalidate pixel variants.
export const PREVIEW_VERSION = PREVIEW_ASSET_VERSION
const hashPattern = /^[a-f0-9]{64}$/
const tokenPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
interface Entry extends FullPreviewResult {
  variant: string
  sourceKey?: string
  id: string
  revision: string
  path: string
  bytes: number
  usedAt: number
  pins: number
  invalid: boolean
}
interface Request {
  id: string
  token: string
  abort: AbortController
  entry?: Entry
  linearEntry?: Entry
  work?: Promise<DisplayPreview | null>
  first?: HdrFirstSurfacePreparation
  firstDecline?: string
}
interface FirstSurfaceLease {
  offer: HdrFirstSurfaceOffer
  file: FileHandle
  path: string
  entry?: Entry
  pins: number
  retired: boolean
  drained: Promise<void>
  finish: () => void
}
interface FirstSurfaceConfiguration {
  policy: () => Promise<ResourcePolicySnapshot>
  publish: (offer: HdrFirstSurfaceOffer) => void
}

/** One foreground consumer, with serialized disk changes and independent stream leases. */
export class FullPreviews {
  private prewarmOutcome?: import('../shared/preview-diagnostics').PreviewDiagnostics['prewarm']
  private prewarmPromise?: Promise<PreviewWarmResult | undefined>
  private prewarmStarted = 0
  private diagnostics: import('../shared/preview-diagnostics').PreviewDiagnostics = {
    loadingStage: 'idle',
    timings: {},
  }
  getDiagnostics() {
    const prewarm = this.prewarmOutcome
    return {
      ...this.diagnostics,
      prewarm: prewarm
        ? {
            ...prewarm,
            elapsedMs:
              prewarm.status === 'pending'
                ? performance.now() - this.prewarmStarted
                : prewarm.elapsedMs,
          }
        : undefined,
    }
  }
  /** One startup hint only; process/device retirement and demand joins remain processor-owned. */
  prewarmHdr(kernel: HdrCacheKernelKind): Promise<PreviewWarmResult | undefined> {
    if (this.prewarmPromise) return this.prewarmPromise
    this.prewarmStarted = performance.now()
    this.prewarmOutcome = { status: 'pending', kernel }
    this.prewarmPromise = Promise.resolve().then(async () => {
      try {
        const result = this.closed ? undefined : await this.processor.prewarmHdr?.(kernel)
        this.prewarmOutcome = {
          status: result?.status ?? 'skipped',
          kernel,
          elapsedMs: performance.now() - this.prewarmStarted,
          workerElapsedMs: result?.elapsedMs,
          workerTimings: result?.timings,
          reason:
            result?.reason ??
            (this.closed
              ? 'Preview service closed.'
              : result
                ? undefined
                : 'Processor does not support HDR prewarm.'),
        }
        return result
      } catch (error) {
        this.prewarmOutcome = {
          status: 'unavailable',
          kernel,
          elapsedMs: performance.now() - this.prewarmStarted,
          reason: error instanceof Error ? error.message : String(error),
        }
        return undefined
      }
    })
    return this.prewarmPromise
  }
  private entries = new Map<string, Entry>()
  private background = new Set<Request>()
  private analyses = new Map<AbortController, string>()
  private active?: Request
  private cpu?: NativeCpuController
  private firstConfiguration?: FirstSurfaceConfiguration
  private firstSurfaces = new Map<string, FirstSurfaceLease>()
  private firstOwners = new Set<FirstSurfaceLease>()
  private firstPrograms = new Map<string, Readonly<Record<string, string>>>()
  installFirstSurface(configuration: FirstSurfaceConfiguration) {
    this.firstConfiguration = configuration
  }
  installCpuController(controller: NativeCpuController) {
    this.cpu = controller
  }
  runCpuForeground<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.scheduler ? this.scheduler.detached(() => this.foreground(work, signal)) : work()
  }
  async acquireCpuWorkingSource(
    request: Pick<CpuPreviewRequest, 'source' | 'expectedSettingsRevision'>,
    signal: AbortSignal,
  ): Promise<CpuWorkingLease> {
    const ref = request.source
    const entry = this.entries.get(`${ref.photoId}-${ref.cacheId}`)
    if (
      !entry?.linear?.hdr ||
      entry.invalid ||
      this.closed ||
      this.blocked.has(ref.photoId) ||
      entry.id !== ref.photoId ||
      entry.linear.sha256 !== ref.workingSha256
    )
      throw new Error('The prepared CPU source is unavailable.')
    // Pin the exact entry synchronously, independently of any active preview token.
    entry.pins++
    let file: Awaited<ReturnType<typeof open>> | undefined,
      released = false
    const check = async (expectedSettingsRevision: number, activeSignal: AbortSignal) => {
      activeSignal.throwIfAborted()
      const options = await this.options?.(ref.photoId, activeSignal)
      if (
        this.closed ||
        this.blocked.has(ref.photoId) ||
        entry.invalid ||
        !this.original(ref.photoId) ||
        options?.processing !== 'hdr-v1' ||
        options.revision !== expectedSettingsRevision ||
        ![
          workingSourceIdentity(ref.photoId, options, true),
          workingSourceIdentity(ref.photoId, options, false),
        ].includes(entry.sourceKey ?? '') ||
        `${hdrSourceVersion(entry.linear!.hdr!.source)}-${entry.linear!.sha256}` !==
          ref.renderingIdentity
      )
        throw new Error('CPU source revision or correction identity changed.')
      activeSignal.throwIfAborted()
    }
    const release = async () => {
      if (released) return
      released = true
      try {
        await file?.close()
      } finally {
        entry.pins--
        void this.enqueue(() => this.prune()).catch(() => undefined)
      }
    }
    try {
      await check(request.expectedSettingsRevision, signal)
      const asset = structuredClone(entry.linear.hdr)
      validateHdrSource(asset.source)
      if (
        asset.width !== entry.width ||
        asset.height !== entry.height ||
        asset.byteLength !== entry.linear.byteLength ||
        asset.byteLength !== entry.width * entry.height * 16 ||
        asset.sha256 !== entry.linear.sha256 ||
        asset.byteLength > 512 * 1024 ** 2
      )
        throw new Error('The cached CPU source descriptor is invalid.')
      file = await open(join(entry.path, 'linear.f32'), constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await file.stat()
      if (!info.isFile() || info.size !== asset.byteLength)
        throw new Error('The CPU source file is incomplete.')
      await check(request.expectedSettingsRevision, signal)
      return { source: structuredClone(ref), asset, file, check, release }
    } catch (error) {
      await release()
      throw error
    }
  }
  /** Same verified entry/FD as CPU preview; a separate temporary mask lease.
   * Freeze the supplied source policy or one fresh main-owned safe-job snapshot.
   * ResourceService global generations are not compared across unrelated calls. */
  async acquireCpuMaskWorkingSource(
    request: NativeHdrMaskRequest,
    signal: AbortSignal,
    frozenPolicy?: Readonly<ResourcePolicySnapshot>,
  ): Promise<CpuMaskSourceLease> {
    const lease = await this.acquireCpuWorkingSource(request, signal)
    try {
      const options = await this.options?.(request.source.photoId, signal)
      if (
        !options ||
        options.revision !== request.expectedSettingsRevision ||
        options.processing !== 'hdr-v1'
      )
        throw new Error('Native mask history is not confirmed for this exact source.')
      const parameters = request.comparison === 'before' ? neutralAdjustments : options.adjustments
      if (!parameters) throw new Error('Native mask confirmed adjustments are unavailable.')
      if (!frozenPolicy && !this.firstConfiguration)
        throw new Error('Native mask resource policy is unavailable.')
      const policy = structuredClone(frozenPolicy ?? (await this.firstConfiguration!.policy()))
      signal.throwIfAborted()
      await lease.check(request.expectedSettingsRevision, signal)
      return {
        ...lease,
        parameters: structuredClone(parameters),
        policy: Object.freeze(policy),
        // Enable strip credit only with the future real worker-drain handshake.
        replacesDrainedJsScan: false,
      }
    } catch (error) {
      await lease.release()
      throw error
    }
  }
  private running?: Request
  private blocked = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private retainedPhoto?: string
  private directory: string

  constructor(
    private root: string,
    private original: (id: string) => string | undefined,
    private processor: FullPreviewProcessor,
    private budget = 2 * 1024 ** 3,
    private options?: (id: string, signal: AbortSignal) => Promise<ProcessingOptions>,
    private activity?: (busy: boolean) => void,
    private scheduler?: WorkScheduler,
  ) {
    this.directory = join(root, PREVIEW_VERSION)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => undefined)
    return result
  }
  private foreground<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.scheduler ? this.scheduler.run('interactive', work, signal) : work()
  }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^v\d+$/.test(entry.name) && entry.name !== PREVIEW_VERSION)
        await rm(join(this.root, entry.name), { recursive: true, force: true })
    }
    for (const folder of await readdir(this.directory, { withFileTypes: true })) {
      const path = join(this.directory, folder.name)
      if (!folder.isDirectory()) continue
      const id = folder.name.slice(0, 64)
      const revision = folder.name.slice(65)
      try {
        if (!hashPattern.test(id) || !tokenPattern.test(revision) || !this.original(id))
          throw new Error('Disposable preview')
        const metadata = JSON.parse(await readFile(join(path, 'entry.json'), 'utf8'))
        if (typeof metadata.variant !== 'string' || !metadata.variant)
          throw new Error('Unsupported preview cache entry.')
        const workingOnly = metadata.format === 'hdr-working'
        if (workingOnly && !metadata.linear?.hdr) throw new Error('Missing HDR source descriptor.')
        const file = workingOnly
          ? { size: 0, isFile: () => true, mtimeMs: Date.now() }
          : await stat(join(path, 'full.rgba'))
        const placeholder = workingOnly
          ? { size: 0, isFile: () => true }
          : await stat(join(path, 'placeholder.png'))
        if (
          !file.isFile() ||
          file.size !== (workingOnly ? 0 : frameByteLength(metadata.width, metadata.height)) ||
          file.size !== metadata.byteLength ||
          (!workingOnly && metadata.format !== 'rgba8-srgb') ||
          !hashPattern.test(metadata.sha256) ||
          typeof metadata.renderId !== 'string' ||
          !placeholder.isFile() ||
          placeholder.size !== metadata.placeholderBytes ||
          placeholder.size > 128 * 1024 ||
          metadata.bytes !==
            file.size +
              placeholder.size +
              (metadata.linear?.byteLength ?? 0) +
              (metadata.firstSurface?.byteLength ?? 0)
        )
          throw new Error('Incomplete preview')
        if (metadata.linear) {
          const linear = await stat(join(path, 'linear.f32'))
          if (
            linear.size !== frameByteLength(metadata.width, metadata.height) * 4 ||
            linear.size !== metadata.linear.byteLength ||
            linear.size > 512 * 1024 ** 2 ||
            !hashPattern.test(metadata.linear.sha256)
          )
            throw new Error('Incomplete linear preview')
          if (metadata.linear.hdr) {
            const hdr = metadata.linear.hdr
            validateHdrSource(hdr.source)
            if (
              hdr.width !== metadata.width ||
              hdr.height !== metadata.height ||
              hdr.byteLength !== linear.size ||
              hdr.sha256 !== metadata.linear.sha256
            )
              throw new Error('Inconsistent HDR descriptor.')
            const digest = createHash('sha256')
            for await (const chunk of createReadStream(join(path, 'linear.f32'), {
              highWaterMark: 1024 * 1024,
            }))
              digest.update(chunk)
            if (digest.digest('hex') !== hdr.sha256) throw new Error('Damaged HDR working asset.')
          }
        }
        if (metadata.firstSurface) {
          try {
            this.validateFirstArtifact(metadata.firstSurface)
            const firstFile = await open(
              join(path, 'first.rgba16'),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            )
            try {
              await this.validateFirstFile(firstFile, metadata.firstSurface)
            } finally {
              await firstFile.close()
            }
          } catch {
            // A stale/damaged optional rendition must not discard its independently verified F32 source.
            await rm(join(path, 'first.rgba16'), { force: true })
            metadata.bytes -= metadata.firstSurface.byteLength
            delete metadata.firstSurface
            metadata.firstSurfaceDecline = 'cached-first-surface-unavailable'
            await writeFile(join(path, 'entry.json'), JSON.stringify(metadata))
          }
        }
        this.entries.set(folder.name, {
          firstSurface: metadata.firstSurface,
          firstSurfaceDecline: metadata.firstSurfaceDecline,
          diagnostics: metadata.diagnostics,
          statistics: metadata.statistics,
          sourceKey: metadata.sourceKey,
          linear: metadata.linear,
          adjustments: metadata.adjustments,
          variant: metadata.variant,
          settingsRevision: metadata.settingsRevision,
          appliedCorrections: metadata.appliedCorrections,
          id,
          revision,
          path,
          width: metadata.width,
          height: metadata.height,
          byteLength: metadata.byteLength,
          format: metadata.format,
          sha256: metadata.sha256,
          renderId: metadata.renderId,
          placeholderBytes: metadata.placeholderBytes,
          bytes:
            file.size +
            placeholder.size +
            (metadata.linear?.byteLength ?? 0) +
            (metadata.firstSurface?.byteLength ?? 0),
          usedAt: file.mtimeMs,
          pins: 0,
          invalid: false,
        })
      } catch {
        await rm(path, { recursive: true, force: true })
      }
    }
    await this.prune()
  }

  request(id: string, token: string, regenerate = false): Promise<FullPreview> {
    return this.prepare(id, token, regenerate, false).then((preview) => {
      if (!preview || preview.format !== 'rgba8-srgb')
        throw new Error('The full preview was not generated.')
      return preview
    })
  }

  requestEditing(id: string, token: string): Promise<FullPreview> {
    return this.prepare(id, token, false, false, true).then((preview) => {
      if (!preview?.linear || preview.format !== 'rgba8-srgb')
        throw new Error('A floating-point preview is unavailable.')
      return preview
    })
  }

  async requestCached(id: string, token: string): Promise<FullPreview | null> {
    const preview = await this.prepare(id, token, false, true)
    return preview?.format === 'rgba8-srgb' ? preview : null
  }
  async requestHdr(
    id: string,
    token: string,
    regenerate = false,
    mode: 'sdr' | 'hdr' = 'hdr',
    firstSurface?: HdrFirstSurfaceRequest,
    rendererReservation?: ManagedImageBytes,
  ): Promise<HdrPreview | null> {
    if (mode !== 'sdr' && mode !== 'hdr') throw new Error('Invalid preview mode.')
    if (firstSurface !== undefined) validateHdrFirstSurfaceRequest(firstSurface)
    if (rendererReservation !== undefined) {
      validateManagedImageBytes(rendererReservation)
      if (
        firstSurface &&
        (firstSurface.rendererReservation.ramBytes !== rendererReservation.ramBytes ||
          firstSurface.rendererReservation.vramBytes !== rendererReservation.vramBytes)
      )
        throw new Error('HDR preparation reservations disagree.')
    }
    const preview = await this.prepare(
      id,
      token,
      regenerate,
      false,
      true,
      false,
      true,
      mode === 'sdr',
      firstSurface === undefined ? undefined : structuredClone(firstSurface),
      rendererReservation === undefined
        ? firstSurface === undefined
          ? undefined
          : structuredClone(firstSurface.rendererReservation)
        : structuredClone(rendererReservation),
    )
    return preview?.format === 'hdr-working' ? preview : null
  }

  private prepare(
    id: string,
    token: string,
    regenerate: boolean,
    cachedOnly: boolean,
    prepareLinear = false,
    background = false,
    workingOnly = false,
    preferPrimary = false,
    firstSurface?: HdrFirstSurfaceRequest,
    rendererReservation?: ManagedImageBytes,
  ): Promise<DisplayPreview | null> {
    if (
      this.closed ||
      typeof id !== 'string' ||
      !hashPattern.test(id) ||
      typeof token !== 'string' ||
      !tokenPattern.test(token) ||
      typeof regenerate !== 'boolean'
    )
      return Promise.reject(new Error('Invalid preview request.'))
    if (this.blocked.has(id) || !this.original(id))
      return Promise.reject(new Error('This photo is unavailable.'))
    if (!background) {
      if (this.retainedPhoto && this.retainedPhoto !== id) this.processor.releaseFrame?.()
      this.retainedPhoto = id
    }
    if (!background) {
      for (const job of this.analyses.keys())
        job.abort(new Error('Statistics interrupted by foreground preview.'))
      for (const job of this.background)
        job.abort.abort(new Error('Statistics interrupted by active preview.'))
      this.detach(false)
    }
    const started = performance.now()
    if (!background) this.diagnostics = { photoId: id, loadingStage: 'preparing', timings: {} }
    const request: Request = { id, token, abort: new AbortController() }
    if (background) this.background.add(request)
    else this.active = request
    const work = this.foreground(
      () =>
        this.enqueue(async () => {
          this.running = request
          this.activity?.(true)
          try {
            const check = () => {
              request.abort.signal.throwIfAborted()
              if (this.closed || this.blocked.has(id) || !this.original(id))
                throw new Error('This photo is unavailable.')
            }
            check()
            const options = await this.options?.(id, request.abort.signal)
            if (workingOnly && options?.processing !== 'hdr-v1') return null
            if (workingOnly && preferPrimary && options?.metadata.hdrJpeg) return null
            if (options) {
              options.prepareLinear = prepareLinear
              options.workingOnly = workingOnly
            }
            check()
            const sourceKey = options ? workingSourceIdentity(id, options, workingOnly) : undefined
            if (firstSurface && this.firstConfiguration && options && sourceKey) {
              const policy = await this.firstConfiguration.policy()
              check()
              request.first = {
                ...firstSurface,
                originalSha256: id,
                parentWorkingKey: sourceKey,
                policy,
              }
              if (
                firstSurface.settingsRevision !== options.revision ||
                !sameAdjustments(firstSurface.parameters, options.adjustments ?? neutralAdjustments)
              )
                request.firstDecline = 'settings-revision-changed'
              else if (
                !firstSurface.view.fit ||
                firstSurface.view.x !== 0 ||
                firstSurface.view.y !== 0 ||
                firstSurface.comparison !== 'after' ||
                firstSurface.hdrRanges
              )
                request.firstDecline = 'unsupported-first-surface-view'
              else if (options.metadata.mergeMaster || options.metadata.hdrJpeg)
                request.firstDecline = 'unsupported-first-surface-source'
              else if (workingOnly) options.firstSurface = request.first
            } else if (firstSurface) request.firstDecline = 'first-surface-unavailable'
            let linearEntry =
              sourceKey && !regenerate
                ? [...this.entries.values()].find(
                    (entry) =>
                      entry.id === id &&
                      entry.sourceKey === sourceKey &&
                      entry.linear &&
                      !entry.invalid,
                  )
                : undefined
            if (linearEntry && options && !options.metadata.mergeMaster) {
              linearEntry.pins++
              request.linearEntry = linearEntry
              options.workingAsset = {
                path: join(linearEntry.path, 'linear.f32'),
                width: linearEntry.width,
                height: linearEntry.height,
                ...linearEntry.linear!,
              }
              options.prepareLinear = false
              if (workingOnly) delete options.workingAsset
            }
            const variant = workingOnly
              ? `working-${sourceKey}`
              : options
                ? createHash('sha256')
                    .update(
                      JSON.stringify([
                        id,
                        options.metadata.hdrJpeg
                          ? workingOnly
                            ? HDR_JPEG_SOURCE_VERSION
                            : 'jpeg-sdr-primary-v1'
                          : null,
                        options.processing ?? 'display-referred-v1',
                        options.processing === 'hdr-v1'
                          ? options.metadata.mergeMaster
                            ? HDR_SOURCE_VERSION
                            : HDR_RAW_SOURCE_VERSION
                          : null,
                        LENS_RENDER_VERSION,
                        CROP_POLICY,
                        rawDecoderDefinitions,
                        cameraProfiles,
                        options.metadata.lensProfile.identity,
                        options.metadata.whiteBalance?.identity,
                        options.settings,
                        options.adjustments ?? neutralAdjustments,
                        options.processing === 'hdr-v1'
                          ? [HDR_ADJUSTMENT_VERSION, HDR_OUTPUT_VERSION]
                          : ADJUSTMENT_VERSION,
                      ]),
                    )
                    .digest('hex')
                : 'uncorrected'
            if (regenerate) {
              for (const entry of this.entries.values())
                if (
                  entry.id === id &&
                  (entry.variant === variant || (workingOnly && entry.sourceKey === sourceKey))
                )
                  entry.invalid = true
            }
            let entry: Entry | undefined = [...this.entries.values()]
              .filter((entry) => entry.id === id && entry.variant === variant && !entry.invalid)
              .sort((a, b) => b.usedAt - a.usedAt)[0]
            if (!entry && workingOnly && linearEntry?.linear?.hdr) entry = linearEntry
            if (entry) {
              try {
                if (
                  workingOnly &&
                  (await stat(join(entry.path, 'linear.f32'))).size !== entry.linear?.byteLength
                )
                  throw new Error('Incomplete HDR source.')
                const file = workingOnly ? { size: 0 } : await stat(join(entry.path, 'full.rgba'))
                const placeholder = workingOnly
                  ? { size: 0 }
                  : await stat(join(entry.path, 'placeholder.png'))
                if (
                  !workingOnly &&
                  (file.size !== entry.byteLength || placeholder.size !== entry.placeholderBytes)
                )
                  throw new Error('Incomplete preview')
              } catch {
                entry.invalid = true
                entry = undefined
              }
            }
            const cacheHit = !!entry
            if (!entry && cachedOnly) return null
            if (!entry) {
              const revision = randomUUID()
              const temporary = join(this.directory, `.tmp-${revision}`)
              const path = join(this.directory, `${id}-${revision}`)
              let published = false
              try {
                await mkdir(temporary)
                check()
                let rawPreparation: import('./preview-types').HdrRawPreparation | undefined
                if (
                  workingOnly &&
                  sourceKey &&
                  options?.processing === 'hdr-v1' &&
                  options.metadata.hdrEligible &&
                  !options.workingAsset &&
                  !options.metadata.mergeMaster &&
                  !options.metadata.hdrJpeg &&
                  rendererReservation &&
                  this.firstConfiguration &&
                  cameraProfile(options.metadata.make ?? '', options.metadata.model ?? '')?.gpu
                ) {
                  const policy = request.first?.policy ?? (await this.firstConfiguration.policy())
                  check()
                  rawPreparation = {
                    originalSha256: id,
                    parentWorkingKey: sourceKey,
                    policy,
                    rendererReservation,
                  }
                }
                const dimensions = await this.processor.renderFull(
                  this.original(id)!,
                  temporary,
                  request.abort.signal,
                  options,
                  options?.firstSurface
                    ? (progress) => this.acceptFirstProgress(request, progress, temporary)
                    : undefined,
                  rawPreparation,
                )
                check()
                const file = workingOnly ? { size: 0 } : await stat(join(temporary, 'full.rgba'))
                const placeholder = workingOnly
                  ? { size: 0 }
                  : await stat(join(temporary, 'placeholder.png'))
                if (
                  file.size !==
                    (workingOnly ? 0 : frameByteLength(dimensions.width, dimensions.height)) ||
                  file.size !== dimensions.byteLength ||
                  dimensions.format !== (workingOnly ? 'hdr-working' : 'rgba8-srgb') ||
                  !hashPattern.test(dimensions.sha256) ||
                  placeholder.size !== dimensions.placeholderBytes ||
                  placeholder.size > 128 * 1024
                )
                  throw new Error('The decoder produced an invalid preview.')
                if (workingOnly) {
                  const asset = dimensions.linear?.hdr
                  if (
                    !asset ||
                    !dimensions.linear ||
                    asset.byteLength !== frameByteLength(dimensions.width, dimensions.height) * 4 ||
                    asset.sha256 !== dimensions.linear.sha256 ||
                    !hashPattern.test(asset.sha256) ||
                    (await stat(join(temporary, 'linear.f32'))).size !== asset.byteLength
                  )
                    throw new Error('The decoder produced an invalid HDR source.')
                  validateHdrSource(asset.source)
                }
                if (
                  dimensions.firstSurface &&
                  (!this.matchesFirstArtifact(request, dimensions.firstSurface) ||
                    dimensions.firstSurface.identity.image.width !== dimensions.width ||
                    dimensions.firstSurface.identity.image.height !== dimensions.height)
                )
                  throw new Error(
                    'The first HDR surface lineage does not match the completed source.',
                  )
                await writeFile(
                  join(temporary, 'entry.json'),
                  JSON.stringify({
                    ...dimensions,
                    sourceKey,
                    variant,
                    bytes:
                      file.size +
                      placeholder.size +
                      (dimensions.linear?.byteLength ?? 0) +
                      (dimensions.firstSurface?.byteLength ?? 0),
                  }),
                )
                check()
                await rename(temporary, path)
                check()
                entry = {
                  ...dimensions,
                  sourceKey,
                  variant,
                  id,
                  revision,
                  path,
                  bytes:
                    file.size +
                    placeholder.size +
                    (dimensions.linear?.byteLength ?? 0) +
                    (dimensions.firstSurface?.byteLength ?? 0),
                  usedAt: Date.now(),
                  pins: 0,
                  invalid: false,
                }
                this.entries.set(`${id}-${revision}`, entry)
                for (const owner of this.firstOwners) {
                  if (owner.offer.requestId === request.token && !owner.entry) {
                    owner.entry = entry
                    entry.pins++
                  }
                }
                published = true
              } finally {
                if (!published) await this.retireFirstSurfaces(request.token)
                await rm(temporary, { recursive: true, force: true })
                if (!published) await rm(path, { recursive: true, force: true })
              }
            }
            if (prepareLinear && !entry.linear && !linearEntry) {
              const temporary = join(this.directory, `.tmp-${randomUUID()}`)
              entry.pins++
              try {
                await this.prune(entry.byteLength * 5 + entry.placeholderBytes)
                await mkdir(temporary)
                const prepared = await this.processor.renderFull(
                  this.original(id)!,
                  temporary,
                  request.abort.signal,
                  options,
                )
                check()
                if (
                  !prepared.linear ||
                  prepared.width !== entry.width ||
                  prepared.height !== entry.height ||
                  prepared.linear.byteLength !== entry.byteLength * 4 ||
                  prepared.linear.byteLength > 512 * 1024 ** 2 ||
                  !hashPattern.test(prepared.linear.sha256)
                )
                  throw new Error('Invalid linear preview.')
                const linear = await stat(join(temporary, 'linear.f32'))
                if (linear.size !== prepared.linear.byteLength)
                  throw new Error('Incomplete linear preview.')
                await rename(join(temporary, 'linear.f32'), join(entry.path, 'linear.f32'))
                entry.linear = prepared.linear
                entry.bytes += prepared.linear.byteLength
                await writeFile(join(entry.path, 'entry.json'), JSON.stringify(entry))
              } finally {
                entry.pins--
                await rm(temporary, { recursive: true, force: true })
              }
            }
            if (workingOnly && request.first && !request.firstDecline && cacheHit) {
              if (!entry.firstSurface || entry.firstSurfaceDecline)
                request.firstDecline = 'cached-source-has-no-first-surface'
              else {
                const artifact = {
                  ...entry.firstSurface,
                  identity: {
                    ...entry.firstSurface.identity,
                    generation: request.first.generation,
                  },
                }
                try {
                  if (this.matchesFirstArtifact(request, artifact))
                    await this.publishFirstSurface(
                      request,
                      artifact,
                      join(entry.path, 'first.rgba16'),
                      entry,
                    )
                  else request.firstDecline = 'cached-first-surface-identity-mismatch'
                } catch {
                  request.abort.signal.throwIfAborted()
                  check()
                  request.firstDecline = 'cached-first-surface-unavailable'
                }
              }
            }
            if (workingOnly) linearEntry = entry
            else linearEntry ??= entry.linear ? entry : undefined
            check()
            entry.usedAt = Date.now()
            await utimes(
              join(entry.path, workingOnly ? 'linear.f32' : 'full.rgba'),
              new Date(),
              new Date(entry.usedAt),
            )
            check()
            entry.pins++
            request.entry = entry
            await this.prune()
            check()
            const renderId = workingOnly
              ? `${hdrSourceVersion(entry.linear!.hdr!.source)}-${entry.linear!.sha256}`
              : entry.renderId
            if (!background)
              this.diagnostics = {
                photoId: id,
                revision: options?.revision ?? 0,
                renderingIdentity: renderId,
                preparationBackend: entry.diagnostics?.backend,
                cacheHit,
                loadingStage: 'prepared',
                timings: {
                  ...entry.diagnostics?.timings,
                  preparationMs: performance.now() - started,
                },
              }
            return {
              firstSurfacePolicy: request.first?.policy,
              firstSurfaceLineage:
                entry.linear?.hdr && entry.sourceKey
                  ? { parentWorkingKey: entry.sourceKey, workingSha256: entry.linear.sha256 }
                  : undefined,
              firstSurfaceDecline: request.firstDecline ?? entry.firstSurfaceDecline,
              adjustments: options?.adjustments ?? entry.adjustments,
              cpuSource: linearEntry?.linear?.hdr
                ? {
                    photoId: id,
                    cacheId: linearEntry.revision,
                    workingSha256: linearEntry.linear.sha256,
                    renderingIdentity: `${hdrSourceVersion(linearEntry.linear.hdr.source)}-${linearEntry.linear.sha256}`,
                  }
                : undefined,
              linear: linearEntry?.linear
                ? {
                    ...linearEntry.linear,
                    url: `luma-photo://library/${id}/linear/${PREVIEW_VERSION}/${linearEntry.revision}`,
                  }
                : undefined,
              settingsRevision: options?.revision ?? 0,
              appliedCorrections: entry.appliedCorrections,
              photoId: id,
              requestId: token,
              format: workingOnly ? 'hdr-working' : entry.format,
              byteLength: workingOnly ? entry.linear!.byteLength : entry.byteLength,
              sha256: workingOnly ? entry.linear!.sha256 : entry.sha256,
              renderId,
              placeholderUrl: workingOnly
                ? undefined
                : `luma-photo://library/${id}/placeholder/${PREVIEW_VERSION}/${entry.revision}`,
              width: entry.width,
              height: entry.height,
              url: `luma-photo://library/${id}/${workingOnly ? 'linear' : 'full'}/${PREVIEW_VERSION}/${entry.revision}`,
            } as DisplayPreview
          } catch (error) {
            if (this.active === request) {
              this.diagnostics.loadingStage = 'failed'
              this.detach(false)
            }
            throw error
          } finally {
            if (background) {
              if (request.entry) request.entry.pins--
              if (request.linearEntry) request.linearEntry.pins--
              this.background.delete(request)
            }
            if (this.running === request) this.running = undefined
            this.activity?.(false)
          }
        }),
      request.abort.signal,
    )
    request.work = work
    return work
  }

  statistics(id: string, expectedRevision: number): Promise<PhotoStatistics> {
    return this.foreground(() => this.analyzeStatistics(id, expectedRevision))
  }
  private async analyzeStatistics(id: string, expectedRevision: number): Promise<PhotoStatistics> {
    const check = async () => {
      const options = await this.options?.(id, new AbortController().signal)
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        options?.revision !== expectedRevision ||
        this.blocked.has(id) ||
        !this.original(id)
      )
        throw new Error('Statistics revision conflict or photo unavailable.')
    }
    await check()
    const preview = await this.prepare(id, randomUUID(), false, false, false, true)
    if (!preview || preview.format !== 'rgba8-srgb')
      throw new Error('Statistics frame unavailable.')
    const lease = this.acquire(new URL(preview.url))
    if (!lease) throw new Error('Statistics frame unavailable.')
    try {
      return await this.enqueue(async () => {
        await check()
        const entry = [...this.entries.values()].find(
          (entry) => entry.path + '/full.rgba' === lease.path,
        )!
        if (!entry.statistics) {
          if (!this.processor.statistics) throw new Error('Statistics processor unavailable.')
          entry.statistics = await this.processor.statistics(
            lease.path,
            preview,
            new AbortController().signal,
          )
          await writeFile(join(entry.path, 'entry.json'), JSON.stringify(entry))
        }
        await check()
        return {
          ...entry.statistics,
          photoId: id,
          revision: expectedRevision,
          renderingIdentity: preview.renderId,
        }
      })
    } finally {
      lease.release()
    }
  }

  settingsChanged(id: string): void {
    for (const [job, photo] of this.analyses)
      if (photo === id) job.abort(new Error('Statistics revision conflict.'))
    for (const job of this.background)
      if (job.id === id) job.abort.abort(new Error('Statistics revision conflict.'))
    if (this.active?.id === id) this.detach(false)
  }

  hdrStatistics(
    id: string,
    expectedRevision: number,
    domain: HdrAnalysisDomain,
    target: DisplayTarget,
  ): Promise<HdrPhotoStatistics> {
    return this.hdrAnalysis(id, expectedRevision, domain, target, (path, job, signal) => {
      if (!this.processor.hdrStatistics) throw new Error('HDR analysis worker unavailable.')
      return this.processor.hdrStatistics(path, job, signal)
    })
  }

  hdrPixel(
    id: string,
    expectedRevision: number,
    x: number,
    y: number,
    domain: HdrAnalysisDomain,
    target: DisplayTarget,
  ): Promise<HdrPhotoPixel> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0)
      return Promise.reject(new Error('Invalid native pixel coordinates.'))
    return this.hdrAnalysis(id, expectedRevision, domain, target, (path, job, signal) => {
      if (!this.processor.hdrPixel) throw new Error('HDR pixel worker unavailable.')
      return this.processor.hdrPixel(path, { ...job, x, y }, signal)
    })
  }

  private hdrAnalysis<T>(
    id: string,
    expectedRevision: number,
    domain: HdrAnalysisDomain,
    target: DisplayTarget,
    work: (path: string, job: HdrStatisticsJob, signal: AbortSignal) => Promise<T>,
  ): Promise<T & { photoId: string; revision: number; renderingIdentity: string }> {
    return this.foreground(() => this.analyzeHdr(id, expectedRevision, domain, target, work))
  }
  private async analyzeHdr<T>(
    id: string,
    expectedRevision: number,
    domain: HdrAnalysisDomain,
    target: DisplayTarget,
    work: (path: string, job: HdrStatisticsJob, signal: AbortSignal) => Promise<T>,
  ): Promise<T & { photoId: string; revision: number; renderingIdentity: string }> {
    const controller = new AbortController()
    const check = async () => {
      controller.signal.throwIfAborted()
      const options = await this.options?.(id, controller.signal)
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        options?.revision !== expectedRevision ||
        options.processing !== 'hdr-v1' ||
        this.closed ||
        this.blocked.has(id) ||
        !this.original(id)
      )
        throw new Error('HDR analysis revision conflict or processing unavailable.')
      return options
    }
    await check()
    const preview = await this.prepare(id, randomUUID(), false, false, true, true, true)
    if (!preview?.linear?.hdr || !preview.linear.url)
      throw new Error('HDR working data unavailable.')
    if (domain === 'output' && target.mode === 'sdr' && preview.linear.hdr.source.display)
      throw new Error(
        'SDR output analysis of imported HDR JPEGs is unavailable. Use content-hdr or the SDR image histogram.',
      )
    const lease = this.acquire(new URL(preview.linear.url))
    if (!lease) throw new Error('HDR working data unavailable.')
    this.analyses.set(controller, id)
    try {
      return await this.enqueue(async () => {
        const options = await check()
        const result = await work(
          lease.path,
          {
            asset: preview.linear!.hdr!,
            adjustments: options.adjustments ?? neutralAdjustments,
            domain,
            target,
          },
          controller.signal,
        )
        await check()
        return {
          ...result,
          photoId: id,
          revision: expectedRevision,
          renderingIdentity: preview.renderId,
        }
      })
    } finally {
      lease.release()
      this.analyses.delete(controller)
    }
  }

  private firstRequest(identity: HdrFirstSurfaceArtifact['identity']): HdrFirstSurfaceRequest {
    return {
      version: identity.version,
      generation: identity.generation,
      settingsRevision: identity.settingsRevision,
      parameters: identity.parameters,
      target: identity.target,
      viewport: identity.viewport,
      dpr: identity.dpr,
      view: identity.view,
      comparison: identity.comparison,
      split: identity.split,
      hdrRanges: identity.hdrRanges,
      kernel: identity.kernel,
      rendererReservation: { ramBytes: 0, vramBytes: 0 },
    }
  }
  private validateFirstArtifact(artifact: HdrFirstSurfaceArtifact) {
    const identity = artifact?.identity
    if (
      !identity ||
      identity.version !== HDR_FIRST_SURFACE_VERSION ||
      !hashPattern.test(identity.originalSha256) ||
      !hashPattern.test(identity.parentWorkingKey) ||
      !identity.image ||
      !Number.isSafeInteger(identity.image.width) ||
      identity.image.width < 1 ||
      !Number.isSafeInteger(identity.image.height) ||
      identity.image.height < 1 ||
      identity.image.width * identity.image.height * 16 > 512 * 1024 ** 2 ||
      !identity.sourceIdentity ||
      typeof identity.sourceIdentity !== 'object' ||
      Array.isArray(identity.sourceIdentity) ||
      identity.sourceIdentity.adjustmentVersion !== HDR_ADJUSTMENT_VERSION ||
      identity.sourceIdentity.outputVersion !== HDR_OUTPUT_VERSION ||
      identity.sourceIdentity.mipPolicy !== HDR_SOURCE_MIP_POLICY ||
      identity.sourceIdentity.arithmetic !== 'reference' ||
      identity.sourceIdentity.tileSize !==
        hdrCacheTileSize(identity.image.width, identity.image.height)
    )
      throw new Error('Invalid first HDR surface identity.')
    validateHdrFirstSurfaceRequest(this.firstRequest(identity))
    validateHdrFirstSurfaceOrientation(
      identity.sourceIdentity.orientation,
      identity.image,
      identity.viewport,
    )
    const programKey = JSON.stringify([
      identity.target.mode,
      identity.target.colorSpace,
      identity.kernel,
    ])
    let hashes = this.firstPrograms.get(programKey)
    if (!hashes) {
      const digest = (value: string | Uint8Array) =>
        createHash('sha256').update(value).digest('hex')
      hashes = Object.freeze({
        mip: digest(hdrMipShader),
        orientedMip: digest(hdrOrientedMipShader),
        tiles: digest(hdrCacheKernel().shader),
        presentation: digest(hdrShader),
        tables:
          HDR_RENDERING_TABLE_HASHES[
            identity.target.mode === 'hdr' ? 'hdr' : identity.target.colorSpace
          ],
      })
      this.firstPrograms.set(programKey, hashes)
    }
    if (
      !artifact.programHashes ||
      Object.keys(artifact.programHashes).length !== Object.keys(hashes).length ||
      Object.entries(hashes).some(([key, hash]) => artifact.programHashes[key] !== hash)
    )
      throw new Error('The first HDR surface pixel programs do not match this application.')
    const width = Math.round(identity.viewport.width * identity.dpr)
    const height = Math.round(identity.viewport.height * identity.dpr)
    const scale = Math.min(
      1,
      identity.viewport.width / identity.image.width,
      identity.viewport.height / identity.image.height,
    )
    if (
      artifact.width !== width ||
      artifact.height !== height ||
      artifact.byteLength !== width * height * 8 ||
      !hashPattern.test(artifact.sha256) ||
      !identity.view.fit ||
      identity.view.x !== 0 ||
      identity.view.y !== 0 ||
      identity.view.scale !== scale ||
      identity.comparison !== 'after' ||
      identity.hdrRanges
    )
      throw new Error('Invalid first HDR surface layout or Fit identity.')
  }
  private matchesFirstArtifact(request: Request, artifact: HdrFirstSurfaceArtifact) {
    this.validateFirstArtifact(artifact)
    const first = request.first
    return (
      !!first &&
      artifact.identity.originalSha256 === request.id &&
      artifact.identity.parentWorkingKey === first.parentWorkingKey &&
      hdrFirstSurfaceRequestKey(this.firstRequest(artifact.identity)) ===
        hdrFirstSurfaceRequestKey({
          version: first.version,
          generation: first.generation,
          settingsRevision: first.settingsRevision,
          parameters: first.parameters,
          target: first.target,
          viewport: first.viewport,
          dpr: first.dpr,
          view: first.view,
          comparison: first.comparison,
          split: first.split,
          hdrRanges: first.hdrRanges,
          kernel: first.kernel,
          rendererReservation: first.rendererReservation,
        })
    )
  }
  private async validateFirstFile(file: FileHandle, artifact: HdrFirstSurfaceArtifact) {
    const info = await file.stat()
    if (!info.isFile() || info.size !== artifact.byteLength)
      throw new Error('Incomplete first HDR surface file.')
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(1024 ** 2, artifact.byteLength))
    let position = 0
    while (position < artifact.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.byteLength, artifact.byteLength - position),
        position,
      )
      if (!bytesRead) throw new Error('Incomplete first HDR surface file.')
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if (digest.digest('hex') !== artifact.sha256) throw new Error('Damaged first HDR surface file.')
  }
  private async acceptFirstProgress(
    request: Request,
    progress: HdrFirstSurfaceProgress,
    output: string,
  ) {
    request.abort.signal.throwIfAborted()
    if (this.active !== request || !request.first)
      throw new Error('First HDR surface request cancelled.')
    if (progress.status === 'declined') {
      if (typeof progress.reason !== 'string' || !progress.reason || progress.reason.length > 256)
        throw new Error('Invalid first HDR surface decline.')
      request.firstDecline = progress.reason
      await this.retireFirstSurfaces(request.token)
      return
    }
    if (progress.status !== 'ready') throw new Error('Invalid first HDR surface progress.')
    await this.publishFirstSurface(request, progress.artifact, join(output, 'first.rgba16'))
  }
  private async publishFirstSurface(
    request: Request,
    artifact: HdrFirstSurfaceArtifact,
    path: string,
    entry?: Entry,
  ) {
    if (!this.matchesFirstArtifact(request, artifact))
      throw new Error('The first HDR surface does not match its admitted request.')
    const check = async () => {
      request.abort.signal.throwIfAborted()
      const options = await this.options?.(request.id, request.abort.signal)
      if (
        this.active !== request ||
        this.closed ||
        this.blocked.has(request.id) ||
        !this.original(request.id) ||
        !options ||
        options.revision !== request.first!.settingsRevision ||
        !sameAdjustments(options.adjustments ?? neutralAdjustments, request.first!.parameters) ||
        workingSourceIdentity(request.id, options, true) !== request.first!.parentWorkingKey
      )
        throw new Error('First HDR surface source or revision changed.')
      request.abort.signal.throwIfAborted()
    }
    await check()
    const first = request.first!
    const canvasBytes = artifact.width * artifact.height * 32
    if (
      first.rendererReservation.ramBytes + artifact.byteLength * 4 + canvasBytes >
        first.policy.ram.effectiveBytes ||
      first.rendererReservation.vramBytes + artifact.byteLength + canvasBytes >
        first.policy.vram.effectiveBytes
    ) {
      request.firstDecline = 'memory-limit'
      return
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let published = false
    try {
      await this.validateFirstFile(file, artifact)
      await check()
      const surfaceId = randomUUID()
      const offer: HdrFirstSurfaceOffer = {
        version: HDR_FIRST_SURFACE_VERSION,
        photoId: request.id,
        requestId: request.token,
        surfaceId,
        identity: structuredClone(artifact.identity),
        policy: request.first!.policy,
        width: artifact.width,
        height: artifact.height,
        format: 'rgba16float-le',
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        url: `luma-photo://library/${request.id}/first/${PREVIEW_VERSION}/${surfaceId}`,
      }
      let finish!: () => void
      const drained = new Promise<void>((resolve) => {
        finish = resolve
      })
      const owner: FirstSurfaceLease = {
        offer,
        file,
        path,
        entry,
        pins: 1,
        retired: false,
        drained,
        finish,
      }
      if (entry) entry.pins++
      this.firstSurfaces.set(surfaceId, owner)
      this.firstOwners.add(owner)
      published = true
      try {
        this.firstConfiguration!.publish(offer)
      } catch (error) {
        this.retireFirstSurface(owner)
        await drained
        throw error
      }
    } finally {
      if (!published) await file.close()
    }
  }
  private closeFirstSurface(owner: FirstSurfaceLease) {
    if (!owner.retired || owner.pins !== 0) return
    owner.pins = -1
    void owner.file
      .close()
      .catch((error: unknown) => console.warn('First HDR surface close:', error))
      .finally(() => {
        if (owner.entry) owner.entry.pins--
        this.firstOwners.delete(owner)
        owner.finish()
        void this.enqueue(() => this.prune()).catch(() => undefined)
      })
  }
  private retireFirstSurface(owner: FirstSurfaceLease) {
    if (owner.retired) return
    owner.retired = true
    this.firstSurfaces.delete(owner.offer.surfaceId)
    owner.pins--
    this.closeFirstSurface(owner)
  }
  private async retireFirstSurfaces(requestId?: string) {
    const owners = [...this.firstOwners].filter(
      (owner) => requestId === undefined || owner.offer.requestId === requestId,
    )
    for (const owner of owners) this.retireFirstSurface(owner)
    await Promise.all(owners.map((owner) => owner.drained))
  }
  async releaseFirstSurface(requestId: string, surfaceId: string) {
    if (
      typeof requestId !== 'string' ||
      !tokenPattern.test(requestId) ||
      typeof surfaceId !== 'string' ||
      !tokenPattern.test(surfaceId)
    )
      throw new Error('Invalid first HDR surface release.')
    const owner =
      this.firstSurfaces.get(surfaceId) ??
      [...this.firstOwners].find((candidate) => candidate.offer.surfaceId === surfaceId)
    if (!owner || owner.offer.requestId !== requestId) return
    this.retireFirstSurface(owner)
    await owner.drained
  }

  private detach(releaseFrame = true): void {
    if (!this.active) return
    void this.retireFirstSurfaces(this.active.token)
    this.active.abort.abort(new Error('Preview request cancelled.'))
    if (this.active.entry) this.active.entry.pins--
    if (this.active.linearEntry) this.active.linearEntry.pins--
    this.active = undefined
    if (releaseFrame) this.processor.releaseFrame?.()
  }

  async release(token?: string): Promise<void> {
    const firstDrained = this.retireFirstSurfaces(token)
    if (token !== undefined && this.active?.token !== token) {
      await firstDrained
      return
    }
    this.detach(token === undefined)
    await Promise.all([firstDrained, this.enqueue(() => this.prune())])
  }

  /** Main-only export reuse never starts a preview or consults mutable current edits. */
  async acquireWorkingAsset(
    id: string,
    options: ProcessingOptions,
    signal: AbortSignal,
  ): Promise<WorkingAssetLease | undefined> {
    signal.throwIfAborted()
    if (
      this.closed ||
      this.blocked.has(id) ||
      !this.original(id) ||
      options.processing !== 'hdr-v1' ||
      options.metadata.mergeMaster
    )
      return
    const identity = workingSourceIdentity(id, options)
    const entry = [...this.entries.values()]
      .filter(
        (candidate) =>
          candidate.id === id &&
          candidate.sourceKey === identity &&
          candidate.linear?.hdr &&
          !candidate.invalid,
      )
      .sort((a, b) => b.usedAt - a.usedAt)[0]
    if (!entry?.linear) return
    // Pin synchronously before the first disk await, including validation itself.
    entry.pins++
    let released = false
    const release = () => {
      if (released) return
      released = true
      entry.pins--
      void this.enqueue(() => this.prune()).catch(() => undefined)
    }
    const asset = {
      ...structuredClone(entry.linear),
      path: join(entry.path, 'linear.f32'),
      width: entry.width,
      height: entry.height,
    }
    try {
      await validateWorkingAsset(asset, signal)
      signal.throwIfAborted()
      if (this.closed || this.blocked.has(id) || entry.invalid || !this.original(id)) {
        release()
        return
      }
      entry.usedAt = Date.now()
      return {
        identity,
        asset,
        backend: entry.diagnostics?.backend,
        fallback: entry.diagnostics?.fallback,
        release,
      }
    } catch {
      if (!signal.aborted) entry.invalid = true
      release()
      signal.throwIfAborted()
      return
    }
  }

  /** Acquire synchronously before opening the stream, so eviction cannot remove its file. */
  acquire(url: URL):
    | {
        path: string
        file?: FileHandle
        contentType: string
        byteLength: number
        release: () => void
      }
    | undefined {
    if (
      this.closed ||
      url.protocol !== 'luma-photo:' ||
      url.hostname !== 'library' ||
      url.search ||
      url.hash ||
      url.port ||
      url.username ||
      url.password
    )
      return
    const [id, kind, version, revision, extra] = url.pathname.slice(1).split('/')
    if (
      extra !== undefined ||
      (kind !== 'full' && kind !== 'placeholder' && kind !== 'linear' && kind !== 'first') ||
      version !== PREVIEW_VERSION ||
      !hashPattern.test(id) ||
      !tokenPattern.test(revision) ||
      this.blocked.has(id) ||
      !this.original(id)
    )
      return
    if (kind === 'first') {
      const owner = this.firstSurfaces.get(revision)
      if (!owner || owner.retired || owner.offer.photoId !== id) return
      owner.pins++
      let released = false
      return {
        path: owner.path,
        file: owner.file,
        contentType: 'application/octet-stream',
        byteLength: owner.offer.byteLength,
        release: () => {
          if (released) return
          released = true
          owner.pins--
          this.closeFirstSurface(owner)
        },
      }
    }
    const entry = this.entries.get(`${id}-${revision}`)
    if (
      !entry ||
      entry.invalid ||
      (kind === 'linear' && !entry.linear) ||
      (entry.format === 'hdr-working' && kind !== 'linear')
    )
      return
    entry.pins++
    let released = false
    return {
      path: join(
        entry.path,
        kind === 'linear' ? 'linear.f32' : kind === 'full' ? 'full.rgba' : 'placeholder.png',
      ),
      contentType: kind === 'placeholder' ? 'image/png' : 'application/octet-stream',
      byteLength:
        kind === 'linear'
          ? entry.linear!.byteLength
          : kind === 'full'
            ? entry.byteLength
            : entry.placeholderBytes,
      release: () => {
        if (released) return
        released = true
        entry.pins--
        void this.enqueue(() => this.prune()).catch(() => undefined)
      },
    }
  }

  async beginRemoval(id: string): Promise<void> {
    this.blocked.add(id)
    await this.cpu?.beforeRemoval(id)
    for (const [job, photo] of this.analyses)
      if (photo === id) job.abort(new Error('Photo removed.'))
    for (const job of this.background)
      if (job.id === id) job.abort.abort(new Error('Photo removed.'))
    if (this.active?.id === id) this.detach()
    const firstDrains = [...this.firstOwners]
      .filter((owner) => owner.offer.photoId === id)
      .map((owner) => {
        this.retireFirstSurface(owner)
        return owner.drained
      })
    await Promise.all(firstDrains)
    // A superseded worker may still be stopping while the next photo is queued.
    const running = this.running
    if (running?.id === id) {
      running.abort.abort(new Error('Preview request cancelled.'))
      await running.work?.catch(() => undefined)
    }
  }

  endRemoval(id: string, removed: boolean): void {
    if (removed)
      for (const entry of this.entries.values()) if (entry.id === id) entry.invalid = true
    this.blocked.delete(id)
    // Invalidate immediately, but do not hold up Trash for an unrelated photo's decode.
    void this.enqueue(() => this.prune()).catch(() => undefined)
  }

  private async prune(reservedBytes = 0): Promise<void> {
    let bytes =
      reservedBytes + [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    const entries = [...this.entries.entries()].sort(
      ([, a], [, b]) => Number(b.invalid) - Number(a.invalid) || a.usedAt - b.usedAt,
    )
    for (const [key, entry] of entries) {
      if (entry.pins || (!entry.invalid && bytes <= this.budget)) continue
      // Cache cleanup must never turn a successful Trash operation into a reported failure.
      // Remove from lookup before awaiting unlink: a protocol request can arrive during disk I/O.
      this.entries.delete(key)
      try {
        await rm(entry.path, { recursive: true, force: true })
        bytes -= entry.bytes
      } catch {
        entry.invalid = true
        this.entries.set(key, entry)
      }
    }
  }

  async close(): Promise<void> {
    for (const job of this.analyses.keys()) job.abort(new Error('Preview service closed.'))
    this.closed = true
    await this.cpu?.close()
    for (const job of this.background) job.abort.abort(new Error('Preview closed.'))
    this.detach()
    await this.tail
    await this.processor.close()
    await this.retireFirstSurfaces()
    await this.prune()
  }
}
