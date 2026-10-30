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
  SDR_TARGET,
  type DisplayTarget,
} from '../shared/hdr'
import {
  validateWhiteBalanceSample,
  type WhiteBalanceSample,
  type PhotoWhiteBalanceProposal,
} from '../shared/white-balance-picker'
import { ADJUSTMENT_VERSION, neutralAdjustments, sameAdjustments } from '../shared/adjustments'
import {
  cropGeometry,
  identityCrop,
  isUncropped,
  validateCrop,
  type CropSettings,
  type PhotoCropContext,
} from '../shared/crop'
import type { CropAdmission } from '../shared/crop-resources'
import { detailProofMemoryPlan, type DetailAdmission } from '../shared/detail-resources'
import type { LensSettings, ProcessingOptions } from '../shared/lens'
import { validatePatch } from '../shared/edits'
import { CROP_POLICY, LENS_RENDER_VERSION } from './processing/lens-correction'
import { rawDecoderDefinitions } from './processing/formats'
import { cameraProfile, cameraProfiles } from './processing/cameras'
import {
  frameByteLength,
  PREVIEW_ASSET_VERSION,
  PREPARED_PROOF_VERSION,
} from '../shared/preview-frame'
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
import { validateCpuPreviewSourceRef } from '../shared/native-cpu-preview'
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
import { creativeColorActive, prepareCreativeColor } from '../shared/creative-color'
import type { WorkScheduler } from './work-scheduler'
import {
  validateWorkingAsset,
  workingSourceIdentity,
  croppedWorkingIdentity,
  type WorkingAssetLease,
} from './working-assets'
import {
  detailLineageKey,
  resolveDetailSettings,
  type DetailSourceLineage,
} from './processing/detail-identity'
import {
  preparedWorkingIdentity,
  validatePreparedPreviewLineage,
  type PreparedPreviewLineage,
} from './prepared-preview-lineage'
import {
  PREPARED_COMPARISON_VERSION,
  validatePreparedPreviewSourceRef,
  type PreparedPreviewSourceRef,
} from '../shared/prepared-comparison'

// Cache layout version. Source and output identities separately invalidate pixel variants.
export const PREVIEW_VERSION = PREVIEW_ASSET_VERSION
const hashPattern = /^[a-f0-9]{64}$/
const tokenPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
interface Entry extends FullPreviewResult, PreparedPreviewLineage {
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
  sourceSpace?: boolean
  unfiltered?: boolean
  entry?: Entry
  linearEntry?: Entry
  work?: Promise<DisplayPreview | null>
  first?: HdrFirstSurfacePreparation
  firstDecline?: string
}
interface ComparisonOwner {
  id: string
  abort: AbortController
  after: Entry
  before?: Entry
  work?: Promise<DisplayPreview | null>
}
interface ComparisonContext {
  after: PreparedPreviewSourceRef
  expectedRevision: number
  owner: ComparisonOwner
}
interface CropRequestOptions {
  workingOnly: boolean
  cachedOnly: boolean
  regenerate: boolean
  background: boolean
  firstSurface?: HdrFirstSurfaceRequest
  rendererReservation?: ManagedImageBytes
  started: number
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
  private comparisons = new Map<string, ComparisonOwner>()
  private comparisonDrains = new Set<Promise<DisplayPreview | null>>()
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
  private whiteBalancePicking = false
  private active?: Request
  private cpu?: NativeCpuController
  private firstConfiguration?: FirstSurfaceConfiguration
  private cropAdmission?: (signal: AbortSignal) => Promise<CropAdmission>
  private detailAdmission?: (signal: AbortSignal) => Promise<DetailAdmission>
  private firstSurfaces = new Map<string, FirstSurfaceLease>()
  private firstOwners = new Set<FirstSurfaceLease>()
  private firstPrograms = new Map<string, Readonly<Record<string, string>>>()
  installFirstSurface(configuration: FirstSurfaceConfiguration) {
    this.firstConfiguration = configuration
  }
  installCpuController(controller: NativeCpuController) {
    this.cpu = controller
  }
  installCropAdmission(admission: (signal: AbortSignal) => Promise<CropAdmission>) {
    this.cropAdmission = admission
  }
  installDetailAdmission(admission: (signal: AbortSignal) => Promise<DetailAdmission>) {
    this.detailAdmission = admission
  }
  runCpuForeground<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.scheduler ? this.scheduler.detached(() => this.foreground(work, signal)) : work()
  }
  async acquireCpuWorkingSource(
    request: Pick<CpuPreviewRequest, 'source' | 'expectedSettingsRevision'>,
    signal: AbortSignal,
    comparisonOf?: PreparedPreviewSourceRef,
  ): Promise<CpuWorkingLease> {
    const ref = request.source
    if (comparisonOf) {
      validatePreparedPreviewSourceRef(comparisonOf)
      if (comparisonOf.photoId !== ref.photoId)
        throw new Error('The comparison belongs to another photograph.')
      comparisonOf = structuredClone(comparisonOf)
    }
    const entry = this.entries.get(`${ref.photoId}-${ref.cacheId}`)
    if (
      !entry?.linear?.hdr ||
      !entry.sourceKey ||
      entry.invalid ||
      this.closed ||
      this.blocked.has(ref.photoId) ||
      entry.id !== ref.photoId ||
      entry.linear.sha256 !== ref.workingSha256
    )
      throw new Error('The prepared CPU source is unavailable.')
    // Pin the exact entry synchronously, independently of any active preview token.
    entry.pins++
    const framingOwner =
      this.active?.sourceSpace && (this.active.linearEntry === entry || this.active.entry === entry)
        ? this.active
        : undefined
    let file: Awaited<ReturnType<typeof open>> | undefined,
      released = false,
      comparisonParent: Entry | undefined
    const check = async (expectedSettingsRevision: number, activeSignal: AbortSignal) => {
      activeSignal.throwIfAborted()
      const options = await this.options?.(ref.photoId, activeSignal)
      if (comparisonOf && options) {
        const after = this.comparisonAfter(comparisonOf, options, comparisonParent)
        comparisonParent = after
        if (
          entry.width !== after.width ||
          entry.height !== after.height ||
          JSON.stringify(entry.crop ?? null) !== JSON.stringify(after.crop ?? null)
        )
          throw new Error('The CPU comparison geometry changed.')
      }
      const selected =
        options && comparisonOf
          ? { ...options, noiseReduction: undefined, detailSharpening: undefined }
          : options
      if (
        this.closed ||
        this.blocked.has(ref.photoId) ||
        entry.invalid ||
        !this.original(ref.photoId) ||
        options?.processing !== 'hdr-v1' ||
        options.revision !== expectedSettingsRevision ||
        (!(
          framingOwner &&
          this.active === framingOwner &&
          !framingOwner.abort.signal.aborted &&
          [true, false].some(
            (workingOnly) =>
              preparedWorkingIdentity(
                ref.photoId,
                framingOwner.unfiltered
                  ? { ...options, noiseReduction: undefined, detailSharpening: undefined }
                  : options,
                workingOnly,
                entry,
                true,
              ) === entry.sourceKey,
          )
        ) &&
          ![true, false].some(
            (workingOnly) =>
              preparedWorkingIdentity(ref.photoId, selected!, workingOnly, entry) ===
              entry.sourceKey,
          )) ||
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
    if (request.comparisonOf !== undefined) {
      validateCpuPreviewSourceRef(request.comparisonOf)
      if (
        request.comparison !== 'before' ||
        request.comparisonOf.photoId !== request.source.photoId
      )
        throw new Error('Invalid native Before mask lineage.')
    }
    const after = request.comparisonOf
      ? await this.acquireCpuWorkingSource(
          {
            source: request.comparisonOf,
            expectedSettingsRevision: request.expectedSettingsRevision,
          },
          signal,
        )
      : undefined
    let lease: CpuWorkingLease | undefined
    const release = async () => {
      const results = await Promise.allSettled([lease?.release(), after?.release()]),
        failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
      if (failures.length)
        throw new AggregateError(failures, 'Native mask source-pair release failed.')
    }
    try {
      const parent = request.comparisonOf,
        before = await this.acquireCpuWorkingSource(
          request,
          signal,
          parent
            ? {
                photoId: parent.photoId,
                cacheId: parent.cacheId,
                workingSha256: parent.workingSha256,
              }
            : undefined,
        )
      lease = before
      const check = async (revision: number, activeSignal: AbortSignal) => {
        await after?.check(revision, activeSignal)
        await before.check(revision, activeSignal)
      }
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
      await check(request.expectedSettingsRevision, signal)
      return {
        ...before,
        check,
        release,
        parameters: structuredClone(parameters),
        policy: Object.freeze(policy),
        // Enable strip credit only with the future real worker-drain handshake.
        replacesDrainedJsScan: false,
      }
    } catch (error) {
      await release()
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
        validatePreparedPreviewLineage(metadata, metadata.sourceKey, metadata)
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
          }
          if (metadata.linear.hdr || metadata.detailSource) {
            const digest = createHash('sha256')
            for await (const chunk of createReadStream(join(path, 'linear.f32'), {
              highWaterMark: 1024 * 1024,
            }))
              digest.update(chunk)
            if (digest.digest('hex') !== metadata.linear.sha256)
              throw new Error('Damaged prepared working asset.')
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
          crop: metadata.crop,
          cropSettings: metadata.cropSettings,
          baseSourceKey: metadata.baseSourceKey,
          detailSource: metadata.detailSource,
          detail: metadata.detail,
          preparedProofVersion: metadata.preparedProofVersion,
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

  private workingRef(entry: Entry): PreparedPreviewSourceRef | undefined {
    return entry.linear && entry.sourceKey
      ? { photoId: entry.id, cacheId: entry.revision, workingSha256: entry.linear.sha256 }
      : undefined
  }

  private comparisonAfter(
    ref: PreparedPreviewSourceRef,
    options: ProcessingOptions,
    captured?: Entry,
  ): Entry {
    const entry = captured ?? this.entries.get(`${ref.photoId}-${ref.cacheId}`)
    if (
      !entry?.linear ||
      !entry.sourceKey ||
      entry.invalid ||
      entry.linear.sha256 !== ref.workingSha256 ||
      preparedWorkingIdentity(ref.photoId, options, Boolean(entry.linear.hdr), entry) !==
        entry.sourceKey
    )
      throw new Error('The comparison source revision or processing identity changed.')
    return entry
  }

  /** An independently leased, revision-checked Before source on the same committed native grid. */
  async requestComparison(
    source: PreparedPreviewSourceRef,
    token: string,
    expectedRevision: number,
  ): Promise<DisplayPreview> {
    validatePreparedPreviewSourceRef(source)
    if (
      typeof token !== 'string' ||
      !tokenPattern.test(token) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      this.closed ||
      this.blocked.has(source.photoId) ||
      !this.original(source.photoId) ||
      this.active?.token === token ||
      [...this.background].some((request) => request.token === token)
    )
      throw new Error('Invalid prepared comparison request.')
    if (this.comparisons.size) throw new Error('A comparison source is already in use.')
    const ref = structuredClone(source),
      after = this.entries.get(`${ref.photoId}-${ref.cacheId}`)
    if (!after?.linear || after.invalid || after.linear.sha256 !== ref.workingSha256)
      throw new Error('The prepared comparison source is unavailable.')
    after.pins++
    const owner: ComparisonOwner = { id: ref.photoId, abort: new AbortController(), after }
    this.comparisons.set(token, owner)
    try {
      const work = this.prepare(
        ref.photoId,
        token,
        false,
        false,
        true,
        true,
        Boolean(after.linear.hdr),
        false,
        undefined,
        undefined,
        false,
        undefined,
        true,
        { after: ref, expectedRevision, owner },
      )
      owner.work = work
      this.comparisonDrains.add(work)
      void work.finally(() => this.comparisonDrains.delete(work)).catch(() => undefined)
      const frame = await work
      owner.abort.signal.throwIfAborted()
      if (!frame?.workingSource || !frame.linear || frame.settingsRevision !== expectedRevision)
        throw new Error('The unfiltered comparison source is unavailable.')
      const before = this.entries.get(`${ref.photoId}-${frame.workingSource.cacheId}`)
      if (
        !before?.linear ||
        before.invalid ||
        before.width !== after.width ||
        before.height !== after.height ||
        Boolean(before.linear.hdr) !== Boolean(after.linear.hdr) ||
        JSON.stringify(before.crop ?? null) !== JSON.stringify(after.crop ?? null)
      )
        throw new Error('The comparison geometry or source domain changed.')
      before.pins++
      owner.before = before
      const options = await this.options?.(ref.photoId, owner.abort.signal)
      owner.abort.signal.throwIfAborted()
      if (!options || options.revision !== expectedRevision)
        throw new Error('The comparison settings revision changed.')
      this.comparisonAfter(ref, options)
      return {
        ...frame,
        comparisonOf: {
          version: PREPARED_COMPARISON_VERSION,
          after: ref,
          settingsRevision: expectedRevision,
        },
      }
    } catch (error) {
      if (this.comparisons.get(token) === owner) await this.release(token)
      throw error
    }
  }

  private retireComparison(token: string, reason: string): ComparisonOwner | undefined {
    const owner = this.comparisons.get(token)
    if (!owner) return
    this.comparisons.delete(token)
    owner.abort.abort(new Error(reason))
    owner.after.pins--
    if (owner.before) owner.before.pins--
    return owner
  }

  /** Read-only source lease for a crop draft; it never writes confirmed geometry. */
  async requestCropSource(
    id: string,
    token: string,
    expectedRevision: number,
  ): Promise<DisplayPreview> {
    const before = await this.confirmedCropOptions(id, expectedRevision)
    try {
      const frame = await this.prepare(
        id,
        token,
        false,
        false,
        true,
        false,
        before.processing === 'hdr-v1',
        false,
        undefined,
        undefined,
        true,
      )
      await this.confirmedCropOptions(id, expectedRevision)
      if (!frame?.linear || frame.settingsRevision !== expectedRevision)
        throw new Error('Native crop geometry is unavailable.')
      return { ...frame, sourceSpace: 'uncropped' }
    } catch (error) {
      await this.release(token)
      throw error
    }
  }

  private async confirmedCropOptions(
    id: string,
    expectedRevision: number,
  ): Promise<ProcessingOptions> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !hashPattern.test(id) ||
      this.closed ||
      this.blocked.has(id) ||
      !this.original(id)
    )
      throw new Error('Invalid crop context request.')
    const options = await this.options?.(id, new AbortController().signal)
    if (
      !options ||
      options.revision !== expectedRevision ||
      this.closed ||
      this.blocked.has(id) ||
      !this.original(id)
    )
      throw new Error('Crop context revision conflict. Reload the confirmed settings.')
    return options
  }

  private async nativeCropSource(id: string, expectedRevision: number, sourceLens?: LensSettings) {
    const before = await this.confirmedCropOptions(id, expectedRevision),
      token = randomUUID(),
      frame = await this.prepare(
        id,
        token,
        false,
        false,
        true,
        true,
        before.processing === 'hdr-v1',
        false,
        undefined,
        undefined,
        true,
        sourceLens,
        true,
      ),
      after = await this.confirmedCropOptions(id, expectedRevision)
    if (!frame?.linear) throw new Error('Native crop geometry is unavailable.')
    return {
      source: { width: frame.width, height: frame.height },
      options: after,
      renderingIdentity: frame.renderId,
    }
  }

  /** Authoritative oriented/corrected native dimensions; catalog dimensions are never substituted. */
  async getCropContext(id: string, expectedRevision: number): Promise<PhotoCropContext> {
    const prepared = await this.nativeCropSource(id, expectedRevision),
      source = prepared.source,
      settings = structuredClone(prepared.options.crop ?? identityCrop)
    return {
      photoId: id,
      revision: expectedRevision,
      source,
      settings,
      geometry: cropGeometry(source, settings),
      renderingIdentity: prepared.renderingIdentity,
    }
  }

  /** Main-only preflight uses the proposed lens variant without publishing settings or history. */
  async validateCropEdit(
    id: string,
    expectedRevision: number,
    settings: CropSettings,
    lens?: LensSettings,
  ) {
    validateCrop(settings)
    if (lens) {
      validatePatch({ lens })
      if (Object.keys(lens).length !== 3) throw new Error('Incomplete crop lens settings.')
    }
    const crop = structuredClone(settings),
      sourceLens = lens ? { ...lens } : undefined,
      prepared = await this.nativeCropSource(id, expectedRevision, sourceLens)
    return cropGeometry(prepared.source, crop)
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
    sourceSpace = false,
    sourceLens?: LensSettings,
    unfiltered = false,
    comparison?: ComparisonContext,
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
    const request: Request = {
      id,
      token,
      abort: comparison?.owner.abort ?? new AbortController(),
      sourceSpace,
      unfiltered,
    }
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
            const resolved = structuredClone(await this.options?.(id, request.abort.signal))
            if (comparison) {
              if (!resolved || resolved.revision !== comparison.expectedRevision)
                throw new Error('The comparison settings revision changed.')
              const after = this.comparisonAfter(comparison.after, resolved),
                admission = await this.spatialAdmission(
                  'detail',
                  { rendererReservation },
                  request.abort.signal,
                )
              rendererReservation = admission.reservation
              if (!workingOnly) {
                const memory = detailProofMemoryPlan(after.crop?.source ?? after, admission, {
                  hdr: Boolean(after.linear?.hdr),
                  authoredHdr: Boolean(after.linear?.hdr?.source.display),
                  preferGpu: false,
                })
                if (!memory.accepted)
                  throw new Error('Comparison preview exceeds the frozen managed image budgets.')
              }
            }
            const crop = resolved?.crop,
              options = resolved
                ? {
                    ...resolved,
                    crop: undefined,
                    noiseReduction: unfiltered ? undefined : resolved.noiseReduction,
                    detailSharpening: unfiltered ? undefined : resolved.detailSharpening,
                    adjustments: comparison ? neutralAdjustments : resolved.adjustments,
                    settings: sourceLens ? { ...sourceLens } : resolved.settings,
                  }
                : undefined
            if (workingOnly && options?.processing !== 'hdr-v1') return null
            if (workingOnly && preferPrimary && options?.metadata.hdrJpeg) return null
            if (
              options &&
              (resolveDetailSettings(options).active ||
                (crop && !sourceSpace && !isUncropped(crop)))
            )
              return await this.prepareSpatial(
                request,
                options,
                sourceSpace ? identityCrop : (crop ?? identityCrop),
                {
                  workingOnly,
                  cachedOnly,
                  regenerate,
                  background,
                  firstSurface,
                  rendererReservation,
                  started,
                },
              )
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
              workingSource: linearEntry ? this.workingRef(linearEntry) : undefined,
              ...(linearEntry?.detailSource ? { requiresUnfilteredComparison: true as const } : {}),
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
                    url: `irodori-photo://library/${id}/linear/${PREVIEW_VERSION}/${linearEntry.revision}`,
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
                : `irodori-photo://library/${id}/placeholder/${PREVIEW_VERSION}/${entry.revision}`,
              width: entry.width,
              height: entry.height,
              url: `irodori-photo://library/${id}/${workingOnly ? 'linear' : 'full'}/${PREVIEW_VERSION}/${entry.revision}`,
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

  private async spatialAdmission(
    stage: 'crop' | 'detail',
    flags: Pick<CropRequestOptions, 'rendererReservation'>,
    signal: AbortSignal,
  ): Promise<DetailAdmission> {
    signal.throwIfAborted()
    const provider = stage === 'crop' ? this.cropAdmission : this.detailAdmission,
      admission = provider
        ? await provider(signal)
        : flags.rendererReservation && this.firstConfiguration
          ? {
              policy: await this.firstConfiguration.policy(),
              reservation: flags.rendererReservation,
            }
          : undefined
    signal.throwIfAborted()
    if (!admission)
      throw new Error(
        `${stage === 'crop' ? 'Crop' : 'Detail'} preview requires a current resource admission.`,
      )
    return structuredClone(admission)
  }

  /** Runs inside the existing serialized request, with the same deletion/cancellation owner. */
  private async prepareSpatial(
    request: Request,
    options: ProcessingOptions,
    settings: CropSettings,
    flags: CropRequestOptions,
  ): Promise<DisplayPreview | null> {
    const { id, token, abort } = request,
      signal = abort.signal,
      hdrSource =
        options.processing === 'hdr-v1' && (!options.metadata.hdrJpeg || flags.workingOnly),
      upstreamKey = workingSourceIdentity(id, options, hdrSource),
      detail = resolveDetailSettings(options),
      selectedOptions = { ...options, crop: settings },
      parameters = options.adjustments ?? neutralAdjustments,
      check = () => {
        signal.throwIfAborted()
        if (this.closed || this.blocked.has(id) || !this.original(id))
          throw new Error('This photo is unavailable.')
      },
      recent = () =>
        [...this.entries.values()]
          .filter((entry) => entry.id === id && !entry.invalid)
          .sort((a, b) => b.usedAt - a.usedAt),
      renditionKey = (key: string) =>
        flags.workingOnly
          ? `working-${key}`
          : createHash('sha256')
              .update(
                JSON.stringify([
                  detail.active ? 'detail-rendition-v1' : 'cropped-rendition-v1',
                  PREPARED_PROOF_VERSION,
                  key,
                  parameters,
                  ADJUSTMENT_VERSION,
                  HDR_ADJUSTMENT_VERSION,
                  HDR_OUTPUT_VERSION,
                ]),
              )
              .digest('hex')
    check()
    if (flags.firstSurface)
      request.firstDecline = detail.active
        ? 'detail-view-requires-complete-working-source'
        : 'cropped-view-requires-complete-working-source'
    let source = recent().find(
      (entry) =>
        entry.linear &&
        entry.sourceKey &&
        preparedWorkingIdentity(id, selectedOptions, hdrSource, entry) === entry.sourceKey,
    )
    let sourceCacheHit = !!source
    if (source && flags.regenerate) {
      for (const entry of recent()) if (entry.sourceKey === source.sourceKey) entry.invalid = true
      source = undefined
      sourceCacheHit = false
    }
    if (flags.regenerate)
      for (const entry of recent())
        if (!entry.crop && entry.sourceKey === upstreamKey) entry.invalid = true
    if (source) {
      try {
        if ((await stat(join(source.path, 'linear.f32'))).size !== source.linear!.byteLength)
          throw new Error('Incomplete cropped source.')
      } catch {
        source.invalid = true
        source = undefined
        sourceCacheHit = false
      }
      check()
    }
    let base: Entry | undefined
    if (!source) {
      base = recent().find(
        (entry) =>
          !entry.crop &&
          entry.linear &&
          entry.sourceKey &&
          preparedWorkingIdentity(id, selectedOptions, hdrSource, entry, true) === entry.sourceKey,
      )
      base ??= recent().find(
        (entry) =>
          !entry.crop && !entry.detailSource && entry.linear && entry.sourceKey === upstreamKey,
      )
      if (!base) {
        if (flags.cachedOnly) return null
        const baseOptions: ProcessingOptions = {
          ...options,
          crop: undefined,
          noiseReduction: undefined,
          detailSharpening: undefined,
          firstSurface: undefined,
          prepareLinear: true,
          workingOnly: hdrSource,
        }
        let preparation: import('./preview-types').HdrRawPreparation | undefined
        if (
          hdrSource &&
          options.metadata.hdrEligible &&
          !options.workingAsset &&
          !options.metadata.mergeMaster &&
          !options.metadata.hdrJpeg &&
          flags.rendererReservation &&
          this.firstConfiguration &&
          cameraProfile(options.metadata.make ?? '', options.metadata.model ?? '')?.gpu
        ) {
          preparation = {
            originalSha256: id,
            parentWorkingKey: upstreamKey,
            rendererReservation: flags.rendererReservation,
            policy: await this.firstConfiguration.policy(),
          }
          check()
        }
        base = await this.createPreparedEntry(
          request,
          upstreamKey,
          `uncropped-source-${upstreamKey}`,
          (directory) =>
            this.processor.renderFull(
              this.original(id)!,
              directory,
              signal,
              baseOptions,
              undefined,
              preparation,
            ),
        )
      }
      if (detail.active && !base.detailSource) {
        if (flags.cachedOnly) return null
        if (!this.processor.prepareDetailPreview)
          throw new Error('The detail preview worker is unavailable.')
        const parent = base
        parent.pins++
        try {
          check()
          if (!parent.linear) throw new Error('Missing native detail source.')
          const asset = {
              ...structuredClone(parent.linear),
              width: parent.width,
              height: parent.height,
              path: join(parent.path, 'linear.f32'),
            },
            detailSource: DetailSourceLineage = {
              sourceIdentity: upstreamKey,
              asset: {
                width: asset.width,
                height: asset.height,
                sha256: asset.sha256,
                ...(asset.hdr
                  ? { source: asset.hdr.source, whiteBalance: asset.hdr.whiteBalance }
                  : { transform: asset.transform }),
              },
              noiseReduction: detail.noiseReduction,
              detailSharpening: detail.detailSharpening,
            },
            key = detailLineageKey(detailSource),
            admission = await this.spatialAdmission('detail', flags, signal)
          check()
          base = await this.createPreparedEntry(
            request,
            key,
            renditionKey(key),
            (directory) =>
              this.processor.prepareDetailPreview!(
                this.original(id)!,
                directory,
                {
                  ...admission,
                  asset,
                  sourceIdentity: upstreamKey,
                  noiseReduction: detail.noiseReduction,
                  detailSharpening: detail.detailSharpening,
                  options: {
                    ...options,
                    processing: asset.hdr ? 'hdr-v1' : 'display-referred-v1',
                    noiseReduction: undefined,
                    detailSharpening: undefined,
                    crop: undefined,
                    firstSurface: undefined,
                  },
                  workingOnly: hdrSource,
                  backend: (process.env.IRODORI_PREVIEW_BACKEND ?? 'auto') as
                    'auto' | 'cpu' | 'gpu',
                },
                signal,
              ),
            { detailSource },
          )
          parent.usedAt = Date.now()
        } finally {
          parent.pins--
        }
      }
      base.pins++
      try {
        check()
        if (
          !base.linear ||
          (await stat(join(base.path, 'linear.f32'))).size !== base.linear.byteLength
        )
          throw new Error('Incomplete uncropped working source.')
        const baseKey = base.sourceKey!,
          geometry = cropGeometry(base, settings),
          sourceKey = croppedWorkingIdentity(baseKey, geometry)
        if (geometry.identity) source = base
        else {
          if (flags.cachedOnly) return null
          if (!this.processor.prepareCropPreview)
            throw new Error('The crop preview worker is unavailable.')
          const admission = await this.spatialAdmission('crop', flags, signal)
          check()
          source = await this.createPreparedEntry(
            request,
            sourceKey,
            renditionKey(sourceKey),
            (directory) =>
              this.processor.prepareCropPreview!(
                this.original(id)!,
                directory,
                {
                  ...admission,
                  asset: {
                    ...base!.linear!,
                    width: base!.width,
                    height: base!.height,
                    path: join(base!.path, 'linear.f32'),
                  },
                  settings,
                  options: { ...options, noiseReduction: undefined, detailSharpening: undefined },
                  workingOnly: flags.workingOnly,
                  backend: (process.env.IRODORI_PREVIEW_BACKEND ?? 'auto') as
                    'auto' | 'cpu' | 'gpu',
                },
                signal,
              ).then((frame) => ({ ...frame, detail: base!.detail })),
            { baseSourceKey: baseKey, cropSettings: settings, detailSource: base.detailSource },
          )
        }
        base.usedAt = Date.now()
      } finally {
        base.pins--
      }
    }
    check()
    if (!source?.linear || !source.sourceKey) throw new Error('Cropped working data unavailable.')
    const sourceEntry = source,
      linear = source.linear,
      variant = renditionKey(source.sourceKey)
    sourceEntry.pins++
    request.linearEntry = sourceEntry
    const matching = recent().find(
      (entry) => entry.variant === variant && (flags.workingOnly || entry.format === 'rgba8-srgb'),
    )
    let entry =
      matching ??
      (flags.workingOnly ||
      (sourceEntry.format === 'rgba8-srgb' &&
        sourceEntry.preparedProofVersion === PREPARED_PROOF_VERSION &&
        sameAdjustments(sourceEntry.adjustments ?? neutralAdjustments, parameters))
        ? sourceEntry
        : undefined)
    const cacheHit = sourceCacheHit && !!entry
    if (!entry) {
      if (flags.cachedOnly) return null
      entry = await this.createPreparedEntry(
        request,
        sourceEntry.sourceKey!,
        variant,
        async (directory) => {
          const preparedOptions: ProcessingOptions = {
            ...options,
            noiseReduction: undefined,
            detailSharpening: undefined,
            crop: undefined,
            firstSurface: undefined,
            prepareLinear: false,
            workingOnly: false,
            workingAsset: {
              ...linear,
              width: sourceEntry.width,
              height: sourceEntry.height,
              path: join(sourceEntry.path, 'linear.f32'),
            },
          }
          let backend: 'cpu' | 'gpu' | 'auto' = (process.env.IRODORI_PREVIEW_BACKEND ?? 'auto') as
            'cpu' | 'gpu' | 'auto'
          if (detail.active) {
            const admission = await this.spatialAdmission('detail', flags, signal),
              memory = detailProofMemoryPlan(sourceEntry, admission, {
                hdr: Boolean(linear.hdr),
                authoredHdr: Boolean(linear.hdr?.source.display),
                preferGpu: backend !== 'cpu',
              })
            if (!memory.accepted)
              throw new Error('Detail preview exceeds the frozen managed image budgets.')
            backend = memory.backend
            if (!this.processor.renderPreparedFull)
              throw new Error('The prepared preview worker is unavailable.')
          }
          const frame = this.processor.renderPreparedFull
            ? await this.processor.renderPreparedFull(directory, preparedOptions, signal, backend)
            : await this.processor.renderFull(
                this.original(id)!,
                directory,
                signal,
                preparedOptions,
              )
          check()
          if (
            frame.width !== sourceEntry.width ||
            frame.height !== sourceEntry.height ||
            frame.format !== 'rgba8-srgb' ||
            frame.settingsRevision !== options.revision ||
            !sameAdjustments(frame.adjustments ?? neutralAdjustments, parameters)
          )
            throw new Error('The prepared source and rendered preview disagree.')
          return {
            ...frame,
            detail: sourceEntry.detail,
            crop: sourceEntry.crop,
            renderId:
              sourceEntry.crop || sourceEntry.detailSource
                ? `${frame.renderId}-${sourceEntry.sourceKey}`
                : frame.renderId,
          }
        },
        {
          ...(sourceEntry.crop
            ? { baseSourceKey: sourceEntry.baseSourceKey, cropSettings: settings }
            : {}),
          detailSource: sourceEntry.detailSource,
        },
      )
    }
    check()
    if (
      !flags.workingOnly &&
      ((await stat(join(entry.path, 'full.rgba'))).size !== entry.byteLength ||
        (await stat(join(entry.path, 'placeholder.png'))).size !== entry.placeholderBytes)
    ) {
      entry.invalid = true
      throw new Error('Incomplete cropped display frame. Retry this preview.')
    }
    if (flags.workingOnly && !linear.hdr) throw new Error('HDR crop source unavailable.')
    entry.usedAt = sourceEntry.usedAt = Date.now()
    entry.pins++
    request.entry = entry
    await this.prune()
    check()
    const renderingIdentity = linear.hdr
        ? `${hdrSourceVersion(linear.hdr.source)}-${linear.sha256}`
        : undefined,
      renderId = flags.workingOnly ? renderingIdentity! : entry.renderId
    if (!flags.background)
      this.diagnostics = {
        photoId: id,
        revision: options.revision,
        renderingIdentity: renderId,
        preparationBackend: sourceEntry.diagnostics?.backend,
        cacheHit,
        loadingStage: 'prepared',
        timings: {
          ...sourceEntry.diagnostics?.timings,
          preparationMs: performance.now() - flags.started,
        },
      }
    return {
      crop: sourceEntry.crop,
      firstSurfaceDecline: request.firstDecline,
      adjustments: parameters,
      workingSource: this.workingRef(sourceEntry),
      ...(sourceEntry.detailSource ? { requiresUnfilteredComparison: true as const } : {}),
      settingsRevision: options.revision,
      appliedCorrections: sourceEntry.appliedCorrections,
      cpuSource: renderingIdentity
        ? {
            photoId: id,
            cacheId: sourceEntry.revision,
            workingSha256: linear.sha256,
            renderingIdentity,
          }
        : undefined,
      linear: {
        ...linear,
        url: `irodori-photo://library/${id}/linear/${PREVIEW_VERSION}/${sourceEntry.revision}`,
      },
      photoId: id,
      requestId: token,
      width: sourceEntry.width,
      height: sourceEntry.height,
      format: flags.workingOnly ? 'hdr-working' : 'rgba8-srgb',
      byteLength: flags.workingOnly ? linear.byteLength : entry.byteLength,
      sha256: flags.workingOnly ? linear.sha256 : entry.sha256,
      renderId,
      placeholderUrl: flags.workingOnly
        ? undefined
        : `irodori-photo://library/${id}/placeholder/${PREVIEW_VERSION}/${entry.revision}`,
      url: `irodori-photo://library/${id}/${flags.workingOnly ? 'linear' : 'full'}/${PREVIEW_VERSION}/${entry.revision}`,
    } as DisplayPreview
  }

  /** Publish spatial variants into the existing cache, with path-free recoverable lineage. */
  private async createPreparedEntry(
    request: Request,
    sourceKey: string,
    variant: string,
    produce: (directory: string) => Promise<FullPreviewResult>,
    lineage?: PreparedPreviewLineage,
  ): Promise<Entry> {
    const revision = randomUUID(),
      temporary = join(this.directory, `.tmp-${revision}`),
      path = join(this.directory, `${request.id}-${revision}`)
    let published = false
    try {
      await mkdir(temporary)
      const frame = await produce(temporary)
      request.abort.signal.throwIfAborted()
      const workingOnly = frame.format === 'hdr-working',
        expected = workingOnly ? 0 : frameByteLength(frame.width, frame.height),
        file = workingOnly ? { size: 0 } : await stat(join(temporary, 'full.rgba')),
        placeholder = workingOnly ? { size: 0 } : await stat(join(temporary, 'placeholder.png'))
      if (
        !['rgba8-srgb', 'hdr-working'].includes(frame.format) ||
        frame.byteLength !== expected ||
        file.size !== expected ||
        !hashPattern.test(frame.sha256) ||
        placeholder.size !== frame.placeholderBytes ||
        placeholder.size > 128 * 1024
      )
        throw new Error('The worker produced an invalid prepared preview.')
      if (workingOnly && !frame.linear?.hdr) throw new Error('Missing prepared HDR working source.')
      if (frame.linear) {
        if (
          frame.linear.byteLength !== frameByteLength(frame.width, frame.height) * 4 ||
          frame.linear.byteLength > 512 * 1024 ** 2 ||
          !hashPattern.test(frame.linear.sha256) ||
          (await stat(join(temporary, 'linear.f32'))).size !== frame.linear.byteLength
        )
          throw new Error('Invalid prepared working file.')
        if (frame.linear.hdr) {
          const hdr = frame.linear.hdr
          validateHdrSource(hdr.source)
          if (
            hdr.width !== frame.width ||
            hdr.height !== frame.height ||
            hdr.byteLength !== frame.linear.byteLength ||
            hdr.sha256 !== frame.linear.sha256
          )
            throw new Error('Invalid prepared HDR descriptor.')
        }
      }
      validatePreparedPreviewLineage(frame, sourceKey, lineage ?? {})
      const bytes = file.size + placeholder.size + (frame.linear?.byteLength ?? 0),
        metadata = { ...frame, ...lineage, sourceKey, variant, bytes }
      await writeFile(join(temporary, 'entry.json'), JSON.stringify(metadata))
      request.abort.signal.throwIfAborted()
      await rename(temporary, path)
      request.abort.signal.throwIfAborted()
      const entry: Entry = {
        ...metadata,
        id: request.id,
        revision,
        path,
        usedAt: Date.now(),
        pins: 0,
        invalid: false,
      }
      this.entries.set(`${request.id}-${revision}`, entry)
      published = true
      return entry
    } finally {
      await rm(temporary, { recursive: true, force: true })
      if (!published) await rm(path, { recursive: true, force: true })
    }
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
    for (const [token, owner] of this.comparisons)
      if (owner.id === id) this.retireComparison(token, 'Comparison settings revision changed.')
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

  async proposeWhiteBalance(
    id: string,
    expectedRevision: number,
    sample: WhiteBalanceSample,
  ): Promise<PhotoWhiteBalanceProposal> {
    validateWhiteBalanceSample(sample)
    const snapshot = { ...sample }
    if (this.whiteBalancePicking)
      throw new Error('A white-balance sample is already being prepared. Try again.')
    this.whiteBalancePicking = true
    try {
      const result = await this.hdrAnalysis(
        id,
        expectedRevision,
        'working-hdr',
        SDR_TARGET,
        (path, job, signal) => {
          if (!this.processor.whiteBalanceSample)
            throw new Error('The white-balance sample worker is unavailable.')
          return this.processor.whiteBalanceSample(
            path,
            { asset: job.asset, sample: snapshot },
            signal,
          )
        },
        true,
      )
      return { ...result, sample: snapshot }
    } finally {
      this.whiteBalancePicking = false
    }
  }

  private hdrAnalysis<T>(
    id: string,
    expectedRevision: number,
    domain: HdrAnalysisDomain,
    target: DisplayTarget,
    work: (path: string, job: HdrStatisticsJob, signal: AbortSignal) => Promise<T>,
    sourceSpace = false,
  ): Promise<T & { photoId: string; revision: number; renderingIdentity: string }> {
    return this.foreground(() =>
      this.analyzeHdr(id, expectedRevision, domain, target, work, sourceSpace),
    )
  }
  private async analyzeHdr<T>(
    id: string,
    expectedRevision: number,
    domain: HdrAnalysisDomain,
    target: DisplayTarget,
    work: (path: string, job: HdrStatisticsJob, signal: AbortSignal) => Promise<T>,
    sourceSpace = false,
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
    const preview = await this.prepare(
      id,
      randomUUID(),
      false,
      false,
      true,
      true,
      true,
      false,
      undefined,
      undefined,
      sourceSpace,
      undefined,
      sourceSpace,
    )
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
    const creative = creativeColorActive(prepareCreativeColor(identity.parameters))
    const programKey = JSON.stringify([
      identity.target.mode,
      identity.target.colorSpace,
      identity.kernel,
      ...(creative ? ['creative'] : []),
    ])
    let hashes = this.firstPrograms.get(programKey)
    if (!hashes) {
      const digest = (value: string | Uint8Array) =>
        createHash('sha256').update(value).digest('hex')
      hashes = Object.freeze({
        mip: digest(hdrMipShader),
        orientedMip: digest(hdrOrientedMipShader),
        tiles: digest(hdrCacheKernel('reference', creative).shader),
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
        url: `irodori-photo://library/${request.id}/first/${PREVIEW_VERSION}/${surfaceId}`,
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
    const comparisons = (token === undefined ? [...this.comparisons.keys()] : [token])
      .map((key) => this.retireComparison(key, 'Comparison source released.'))
      .filter((owner) => owner !== undefined)
    if (token !== undefined && this.active?.token !== token) {
      await Promise.all([
        firstDrained,
        ...comparisons.map((owner) => owner.work?.catch(() => undefined)),
      ])
      if (comparisons.length) await this.enqueue(() => this.prune())
      return
    }
    this.detach(token === undefined)
    await Promise.all([
      firstDrained,
      ...comparisons.map((owner) => owner.work?.catch(() => undefined)),
      this.enqueue(() => this.prune()),
    ])
  }

  /** Main-only export reuse never starts a preview or consults mutable current edits. */
  async acquireWorkingAsset(
    id: string,
    options: ProcessingOptions,
    signal: AbortSignal,
    rendition: import('./working-assets').WorkingAssetRendition = 'working',
  ): Promise<WorkingAssetLease | undefined> {
    signal.throwIfAborted()
    if (
      this.closed ||
      this.blocked.has(id) ||
      !this.original(id) ||
      (rendition === 'primary' && options.processing === 'hdr-v1' && !options.metadata.hdrJpeg) ||
      options.metadata.mergeMaster
    )
      return
    const frozen = structuredClone(options),
      hdrSource = rendition === 'working' && options.processing === 'hdr-v1'
    const entry = [...this.entries.values()]
      .filter(
        (candidate) =>
          candidate.id === id &&
          !candidate.crop &&
          candidate.sourceKey &&
          preparedWorkingIdentity(id, frozen, hdrSource, candidate, true) === candidate.sourceKey &&
          candidate.linear &&
          Boolean(candidate.linear.hdr) === hdrSource &&
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
        identity: entry.sourceKey!,
        asset,
        detailSource: entry.detailSource ? structuredClone(entry.detailSource) : undefined,
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
      url.protocol !== 'irodori-photo:' ||
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
    const comparisons = [...this.comparisons]
      .filter(([, owner]) => owner.id === id)
      .map(([token]) => this.retireComparison(token, 'Photo removed.'))
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
    await Promise.all(comparisons.map((owner) => owner?.work?.catch(() => undefined)))
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
    for (const token of this.comparisons.keys())
      this.retireComparison(token, 'Preview service closed.')
    await this.cpu?.close()
    for (const job of this.background) job.abort.abort(new Error('Preview closed.'))
    this.detach()
    await Promise.allSettled(this.comparisonDrains)
    await this.tail
    await this.processor.close()
    await this.retireFirstSurfaces()
    await this.prune()
  }
}
