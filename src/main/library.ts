import { totalmem, cpus } from 'node:os'
import { collectionPolicy, CollectionChangedError } from '../shared/collections'
import { WorkspaceStore } from './workspace'
import { ExportStore, ExportReadStore } from './export/store'
import { ExportJobs } from './export/jobs'
import type { ExportProcess } from './export/process'
import { identity } from './export/files'
import { verifyExportEncoder } from './export/encoder'
import {
  EXPORT_CODEC_VERSION,
  EXPORT_RENDERING_VERSION,
  validateExportPhotoIds,
} from '../shared/export'
import type { WorkspaceChange } from '../shared/workspace'
import type { GalleryRevision } from '../shared/stacks'
import { MergeReviews } from './merge/reviews'
import { StackStore } from './stacks'
import { BrowseStore } from './browse'
import { PhotoActionsStore, actionAvailability, originalMergeApplicable } from './photo-actions'
import { DEFAULT_BROWSE_QUERY, validatedCaptureDate, type BrowseQuery } from '../shared/browse'
import { CAPTURE_METADATA_VERSION } from '../shared/capture-sequence'
import { durableJson, recoverMerges, syncDirectory, verifyMaster } from './merge/store'
import {
  MERGE_VERSION,
  validateMergeVersion,
  type MergeBundleManifest,
  type MergeManifest,
  type MergeMeasurements,
  type MergeMode,
  type MergeSettings,
  type MergeSource,
} from '../shared/merge'
import { srgbTransform } from '../shared/adjustments'
import type { HdrAnalysisRequest, HdrPhotoStatistics } from '../shared/hdr-statistics'
import type { HdrPhotoPixel } from '../shared/hdr-pixel'
import type { PhotoStatistics } from '../shared/statistics'
import { SDR_TARGET, validateHdrSource, type DisplayTarget } from '../shared/hdr'
import {
  SETTINGS_VERSION,
  validatePatch,
  type EditState,
  type EditPatch,
  type EditHistory,
  type EditFlushScope,
} from '../shared/edits'
import { photoExtensions } from './processing/formats'
import {
  automaticLensSettings,
  PROCESSING_METADATA_VERSION,
  correctionKinds,
  type CorrectionKind,
  type LensState,
  type ProcessingOptions,
} from '../shared/lens'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, type Stats } from 'node:fs'
import { cp, mkdir, open, readdir, realpath, rename, rm, stat, lstat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CatalogWriter, CatalogWriterFailure } from './catalog/writer'
import { CatalogMutations } from './catalog/domain'
import type { CatalogCommand, CatalogOperation, CatalogOutput } from './catalog/contracts'
import { RemovalStore } from './removal-store'
import { copyOriginal } from './copy-original'
import {
  ImportSourceRecords,
  inspectImportSource,
  hashImportSource,
  importSourceKey,
  sameImportSourceWitness,
  type ImportSourceWitness,
} from './import-source-records'
import { WorkScheduler } from './work-scheduler'
import { ForegroundActivities } from './foreground-activity'
import {
  runImportPipeline,
  preparationWorkers,
  type ImportPipelineOptions,
} from './import-pipeline'
import { FullPreviews } from './full-previews'
import { PreviewProcess } from './preview-process'
import {
  COLLECTION_CHUNK_SIZE,
  type ImportCandidate,
  type ImportReview,
  type ImportReviewSummary,
  type ImportReviewChunk,
  type ReviewThumbnailRequest,
  type LibraryEvent,
  type Photo,
  type PhotoPage,
  type BackgroundTask,
  type TaskErrorPage,
  type ForegroundActivity,
} from '../shared/contracts'
import type {
  CaptureMetadataProcessor,
  FullPreviewProcessor,
  PreviewProcessor,
} from './preview-types'
import { ReviewThumbnails, type ReviewThumbnailState } from './review-thumbnails'
import { DeviceDirectoryVisibility } from './device-directory-visibility'
import {
  CameraRecognition,
  cameraMetadataMatches,
  cameraSourceKey,
  sampleCameraOriginal,
  type CameraSourceKey,
} from './camera-recognition'
import {
  DeviceUnavailableError,
  assertDevicePathContained,
  pathWithin,
  type DeviceSource,
} from './import-devices'

const extensions = new Set(photoExtensions.map((extension) => `.${extension}`))
const hashPattern = /^[a-f0-9]{64}$/
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const reviewNameOrder = new Intl.Collator('en', { numeric: true })

interface Candidate extends ImportCandidate {
  path: string
  identity?: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>
  cacheDir?: string
  sourceRecord?: { key: string; witness: ImportSourceWitness; reusable: boolean }
  cameraKey?: CameraSourceKey
  sourceWitness?: ImportSourceWitness
  recognitionRejected?: boolean
  sourcePhotoId?: string
  recognitionHint?: string
  verifiedHash?: string
  checkingSource?: boolean
  copiedHash?: string
}

interface Session {
  id: string
  source: string
  phase: ImportReview['phase']
  candidates: Candidate[]
  candidatesById: Map<string, Candidate>
  counts: ReviewCounts
  counted: Map<string, ReviewCounts>
  membershipRevision?: string
  orderedCandidates?: Candidate[]
  skipped: number
  abort: AbortController
  task: Promise<void>
  firstImportedId?: string
  selectionRevision: number
  orderingRevision: number
  contentRevision: number
  thumbnailGeneration: number
  defaultSelected: boolean
  thumbnails: Pick<ReviewThumbnails, 'request' | 'cancel'>
  sourceError?: string
  device?: { source: DeviceSource; validate: (force?: boolean) => Promise<void> }
  onlyMissing?: boolean
  accepting?: boolean
  checkingPrevious?: string
  verificationMode?: import('../shared/contracts').ImportVerificationMode
  verificationAbort: AbortController
  verificationGeneration: number
  verificationCursor: number
  verificationTask: Promise<void>
  verificationPending: boolean
}

type ReviewCounts = Pick<
  ImportReview,
  | 'selected'
  | 'selectedBytes'
  | 'totalBytes'
  | 'alreadyImported'
  | 'alreadyImportedBytes'
  | 'unchecked'
  | 'ready'
  | 'duplicates'
  | 'errors'
  | 'imported'
>
const emptyReviewCounts = (): ReviewCounts => ({
  selected: 0,
  selectedBytes: 0,
  totalBytes: 0,
  alreadyImported: 0,
  alreadyImportedBytes: 0,
  unchecked: 0,
  ready: 0,
  duplicates: 0,
  errors: 0,
  imported: 0,
})

export class PhotoLibrary {
  readonly scheduler = new WorkScheduler()
  private activities = new ForegroundActivities(this.scheduler)
  private importSuppression = new Map<string, Set<string>>()
  readonly fullPreviews: FullPreviews
  readonly merges: MergeReviews
  exports!: ExportJobs
  private db!: DatabaseSync
  private catalog?: CatalogWriter
  private stacks!: StackStore
  private browse!: BrowseStore
  private workspace!: WorkspaceStore
  readonly collectionResources = collectionPolicy(totalmem(), cpus().length)
  private importSources!: ImportSourceRecords
  private cameraRecognition!: CameraRecognition
  private lensTail: Promise<unknown> = Promise.resolve()
  private metadataTail: Promise<unknown> = Promise.resolve()
  private captureTail: Promise<unknown> = Promise.resolve()
  private removals!: RemovalStore
  private retainedUnsupportedMerges = new Map<string, string>()
  private session?: Session
  private closed = false
  private closing?: Promise<void>
  private replacingSession = false
  private notification?: ReturnType<typeof setTimeout>
  private tasks = new Map<
    string,
    {
      snapshot: BackgroundTask
      errors: TaskErrorPage['errors']
      importCapacity?: boolean
      abort?: AbortController
      work?: Promise<void>
    }
  >()

  constructor(
    readonly root: string,
    private processor: PreviewProcessor,
    private emit: (event: LibraryEvent) => void,
    private transfer: typeof copyOriginal = copyOriginal,
    private trash: (path: string) => Promise<void> = async () => {
      throw new Error('System Trash is unavailable.')
    },
    private metadataProcessor: Pick<PreviewProcess, 'inspect' | 'close'> = new PreviewProcess(),
    mergeWorkerPath?: string,
    private mergeBoundary?: (
      boundary: 'staged' | 'journaled' | 'published' | 'committed',
    ) => Promise<void>,
    private captureProcessor: CaptureMetadataProcessor = new PreviewProcess(),
    private reviewThumbnailFactory: (
      onState: (id: string, state: ReviewThumbnailState) => void,
    ) => Pick<ReviewThumbnails, 'request' | 'cancel'> = (onState) => new ReviewThumbnails(onState),
    private directoryVisibility: Pick<
      DeviceDirectoryVisibility,
      'hiddenEntries' | 'close'
    > = new DeviceDirectoryVisibility(),
    private importOptions: ImportPipelineOptions = {},
    private inspectSource = inspectImportSource,
    private hashSource = hashImportSource,
    private sampleSource = sampleCameraOriginal,
    private exportRenderer?: Pick<ExportProcess, 'render'>,
    fullPreviewProcessor: FullPreviewProcessor = new PreviewProcess(),
    private createCatalogWriter: (databasePath: string) => CatalogWriter = (path) =>
      new CatalogWriter(path),
  ) {
    this.merges = new MergeReviews(
      root,
      async (id, signal) => (await this.inspectMergeSources([id], signal))[0],
      mergeWorkerPath,
      this.scheduler,
      () => this.changed(),
      (ids, signal) => this.inspectMergeSources(ids, signal),
    )
    this.fullPreviews = new FullPreviews(
      join(root, 'cache', 'previews'),
      (id) => {
        if (this.closed) return
        const photo = this.find(id)
        return photo
          ? join(
              root,
              'originals',
              id,
              photo.assetKind === 'derived'
                ? 'linear.f32'
                : `original${extname(photo.filename).toLowerCase()}`,
            )
          : undefined
      },
      fullPreviewProcessor,
      undefined,
      (id, signal) => this.processingOptions(id, signal),
      undefined,
      this.scheduler,
    )
    this.scheduler.onChange(() => {
      this.merges.worker.pause(this.scheduler.interactiveRequestPending)
      let changed = false
      for (const task of this.tasks.values()) {
        if (task.snapshot.kind === 'import' && task.snapshot.status === 'running') {
          const waitingReason =
            this.scheduler.preparationWaitingReason ??
            (task.importCapacity ? 'pipeline-capacity' : undefined)
          if (task.snapshot.waitingReason !== waitingReason) {
            task.snapshot.waitingReason = waitingReason
            changed = true
          }
          if (task.snapshot.waitingReason && task.snapshot.transfer)
            task.snapshot.transfer.bytesPerSecond = 0
        }
      }
      if (changed) this.changed()
    })
  }

  private inspectCapture(path: string, signal: AbortSignal) {
    const work = this.captureTail.then(() => {
      signal.throwIfAborted()
      return this.captureProcessor.inspectCapture(path, signal)
    })
    this.captureTail = work.catch(() => undefined)
    return work
  }

  private async inspectMergeSources(ids: string[], signal: AbortSignal) {
    const inputs: { source: MergeSource; path: string }[] = []
    for (const id of ids) {
      signal.throwIfAborted()
      await this.scheduler.checkpoint(signal)
      const photo = this.find(id)
      if (
        !photo ||
        photo.assetKind === 'derived' ||
        extname(photo.filename).toLowerCase() !== '.arw'
      )
        throw new Error('Merge requires original Sony RAW photographs.')
      const path = join(
        this.root,
        'originals',
        id,
        `original${extname(photo.filename).toLowerCase()}`,
      )
      let metadata = (await this.processingOptions(id, signal)).metadata
      if (!metadata.capture) {
        const work = this.metadataTail.then(() => this.metadataProcessor.inspect(path, signal))
        this.metadataTail = work.catch(() => undefined)
        metadata = await work
      }
      signal.throwIfAborted()
      if (!metadata.capture)
        throw new Error(`${photo.filename}: numeric exposure metadata is unavailable.`)
      inputs.push({ path, source: { photo, metadata, capture: metadata.capture, relativeEv: 0 } })
    }
    const beforeRead = async (index: number) => {
      signal.throwIfAborted()
      await this.scheduler.checkpoint(signal)
      const input = inputs[index],
        current = this.find(input.source.photo.id)
      if (
        this.closed ||
        !current ||
        current.assetKind === 'derived' ||
        current.filename !== input.source.photo.filename ||
        !existsSync(input.path)
      )
        throw new Error('This photo is unavailable.')
    }
    const work = this.captureTail.then(async () => {
      signal.throwIfAborted()
      if (this.captureProcessor.inspectCaptures)
        return this.captureProcessor.inspectCaptures(
          inputs.map((input) => input.path),
          signal,
          beforeRead,
        )
      const results = []
      for (let index = 0; index < inputs.length; index++) {
        await beforeRead(index)
        results.push(await this.captureProcessor.inspectCapture(inputs[index].path, signal))
      }
      return results
    })
    this.captureTail = work.catch(() => undefined)
    const captures = await work
    signal.throwIfAborted()
    if (captures.length !== inputs.length) throw new Error('Invalid merge capture metadata.')
    for (let index = 0; index < inputs.length; index++)
      inputs[index].source.captureMetadata = captures[index]
    return inputs
  }

  private closeCaptureProcessor() {
    const work = this.captureTail.then(() => this.captureProcessor.close())
    this.captureTail = work.catch(() => undefined)
    return work
  }

  reportForegroundActivity(value: ForegroundActivity): void {
    if (this.closed) return
    const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
    if (
      !value ||
      !uuid.test(value.activityId) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      typeof value.active !== 'boolean' ||
      Object.keys(value).some(
        (k) => !['activityId', 'sequence', 'active', 'photoId', 'reviewId'].includes(k),
      ) ||
      !!value.photoId === !!value.reviewId ||
      (value.photoId && !hashPattern.test(value.photoId)) ||
      (value.reviewId && !uuid.test(value.reviewId))
    )
      throw new Error('Invalid foreground activity.')
    if (
      value.active &&
      ((value.photoId && !this.find(value.photoId)) ||
        (value.reviewId && this.merges.active()?.id !== value.reviewId))
    )
      return
    this.activities.report(value)
  }
  releaseForegroundActivities(): void {
    this.activities.clear()
  }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    this.db = new DatabaseSync(join(this.root, 'catalog.sqlite'))
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    const fresh =
      version.user_version === 0 &&
      !this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()
    if (!fresh && version.user_version !== 17)
      throw new Error(
        version.user_version > 17
          ? 'This library requires a newer version of Luma.'
          : 'This catalog format is unsupported. Its files were preserved; reimport originals into a fresh library.',
      )
    if (
      fresh &&
      existsSync(join(this.root, 'originals')) &&
      (await readdir(join(this.root, 'originals'))).length
    )
      throw new Error(
        'This unversioned library contains managed originals. Its files were preserved; restore its catalog or reimport originals into a fresh library.',
      )
    // Check persisted contracts before WAL, schema/history writes or recovery cleanup.
    if (!fresh) {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM photos WHERE processing_identity IS NULL OR processing_identity NOT IN ('hdr-v1', 'display-referred-v1') LIMIT 1",
          )
          .get()
      )
        throw new Error(
          'This library has an unsupported processing identity. Its files were preserved.',
        )
      for (const row of this.db.prepare('SELECT data FROM edits').all() as { data: string }[]) {
        const history = JSON.parse(row.data)
        if (
          !history ||
          !Array.isArray(history.snapshots) ||
          !history.snapshots.length ||
          [
            history.settings,
            ...history.snapshots.map((snapshot: { settings: unknown }) => snapshot?.settings),
          ].some(
            (settings) =>
              !settings ||
              settings.version !== SETTINGS_VERSION ||
              !['hdr-v1', 'display-referred-v1'].includes(settings.processing),
          )
        )
          throw new Error('This edit history format is unsupported. Its files were preserved.')
      }
      new ExportReadStore(this.db).preferences()
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    await mkdir(join(this.root, 'originals'), { recursive: true })
    // Fresh schema setup and current-history initialization precede runtime ownership.
    const bootstrap = new CatalogMutations(this.db)
    this.stacks = new StackStore(this.db)
    this.browse = new BrowseStore(this.db)
    this.workspace = new WorkspaceStore(this.db, this.browse)
    this.importSources = new ImportSourceRecords(this.db)
    this.cameraRecognition = new CameraRecognition(this.db)
    this.db.exec('BEGIN')
    try {
      if (fresh) {
        this.db.exec(
          'CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT NOT NULL, photo TEXT NOT NULL, processing_identity TEXT NOT NULL); CREATE TABLE removals (id TEXT PRIMARY KEY, staged TEXT NOT NULL); CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TRIGGER remove_processing AFTER DELETE ON photos BEGIN DELETE FROM processing WHERE id = old.id; END; CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TRIGGER remove_edits AFTER DELETE ON photos BEGIN DELETE FROM edits WHERE id = old.id; END; CREATE TABLE merge_publications (id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL); CREATE TABLE derived_assets (id TEXT PRIMARY KEY, manifest TEXT NOT NULL); CREATE TRIGGER remove_derived AFTER DELETE ON photos BEGIN DELETE FROM derived_assets WHERE id = old.id; END;',
        )
        this.stacks.initialize()
        this.importSources.initialize()
        this.cameraRecognition.initialize()
        this.browse.initialize()
        this.workspace.initialize()
        new ExportReadStore(this.db).initialize()
      } else this.cameraRecognition.prepare()
      for (const row of this.db.prepare('SELECT id, data FROM processing').all() as {
        id: string
        data: string
      }[]) {
        const data = JSON.parse(row.data) as ProcessingOptions
        bootstrap.seedEdits(row.id, data, new Date().toISOString())
      }
      if (fresh) this.db.exec('PRAGMA user_version = 17')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    // No runtime path may write through this connection, including an accidental lazy read.
    this.db.exec('PRAGMA query_only = ON;')
    this.catalog = this.createCatalogWriter(join(this.root, 'catalog.sqlite'))
    await this.catalog.open()
    this.removals = new RemovalStore(this.root, this.db, this.trash, this.catalog)
    await this.removals.recover()
    const retained = await recoverMerges(this.root, this.db, (manifest) =>
      this.commitMerge(manifest),
    )
    this.retainedUnsupportedMerges = new Map(
      retained.map((entry) => [entry.id, entry.manifestSha256]),
    )
    for (const entry of retained) {
      const id = randomUUID()
      this.tasks.set(id, {
        snapshot: {
          id,
          kind: 'merge',
          title: 'Merged photo unsupported',
          status: 'failed',
          phase: 'Publication retained',
          detail: entry.filename,
          errorCount: 1,
          finishedAt: Date.now(),
        },
        errors: [
          {
            filename: entry.filename,
            message: `${entry.reason} Its bundle and publication journal were retained.`,
          },
        ],
      })
    }
    this.exports = new ExportJobs(
      new ExportStore(this.db, this.catalog),
      this.root,
      this.scheduler,
      async (id) => {
        const processing = await this.processingOptions(id)
        const photo = this.find(id)
        if (!photo) throw new Error('This export photo is unavailable.')
        const path = join(
          this.root,
          'originals',
          id,
          photo.assetKind === 'derived'
            ? 'linear.f32'
            : `original${extname(photo.filename).toLowerCase()}`,
        )
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error('The managed export source is unavailable.')
        return {
          photo,
          path,
          identity: identity(info),
          processing,
          hdr: !!(processing.metadata.hdrEligible || processing.metadata.mergeMaster),
        }
      },
      (source) => {
        const photo = this.find(source.photo.id)
        const processing = this.readProcessing(source.photo.id)
        return (
          !!photo &&
          photo.filename === source.photo.filename &&
          JSON.stringify(processing) === JSON.stringify(source.processing)
        )
      },
      () => this.changed(),
      this.exportRenderer,
      undefined,
      (source, signal) =>
        this.fullPreviews.acquireWorkingAsset(source.photo.id, source.processing, signal),
    )
    await this.exports.recover()
    await rm(join(this.root, 'merge-reviews'), { recursive: true, force: true })
    // Only application-owned, unpublished files are recovered here.
    await rm(join(this.root, 'staging'), { recursive: true, force: true })
    await mkdir(join(this.root, 'staging'), { recursive: true })
    for (const entry of await readdir(join(this.root, 'originals'), { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        hashPattern.test(entry.name) &&
        !this.find(entry.name) &&
        !this.retainedUnsupportedMerges.has(entry.name)
      ) {
        await rm(join(this.root, 'originals', entry.name), { recursive: true, force: true })
      }
    }
    await this.fullPreviews.open()
  }

  private write<K extends CatalogOperation>(command: CatalogCommand<K>): Promise<CatalogOutput<K>> {
    if (!this.catalog) return Promise.reject(new Error('Catalog writer is not open.'))
    return this.catalog.command(command)
  }

  private find(id: string): Photo | undefined {
    const row = this.db.prepare('SELECT photo FROM photos WHERE id = ?').get(id) as
      { photo: string } | undefined
    return row ? (JSON.parse(row.photo) as Photo) : undefined
  }

  private readProcessing(id: string): ProcessingOptions | undefined {
    const row = this.db.prepare('SELECT data FROM processing WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) return undefined
    const data = JSON.parse(row.data) as ProcessingOptions
    if (data.metadata.mergeMaster) validateMergeVersion(data.metadata.mergeMaster.recipe?.version)
    const edits = this.readEdits(id)
    return {
      ...data,
      workingAsset: data.metadata.mergeMaster
        ? {
            path: join(this.root, 'originals', id, 'linear.f32'),
            width: data.metadata.mergeMaster.asset.width,
            height: data.metadata.mergeMaster.asset.height,
            byteLength: data.metadata.mergeMaster.asset.byteLength,
            sha256: data.metadata.mergeMaster.asset.sha256,
            transform: srgbTransform,
            hdr: data.metadata.mergeMaster.asset,
          }
        : undefined,
      processing: edits.settings.processing,
      settings: edits.settings.lens,
      adjustments: {
        whiteBalance: edits.settings.whiteBalance,
        exposureEv: edits.settings.exposureEv,
        contrast: edits.settings.contrast,
        highlights: edits.settings.highlights,
        shadows: edits.settings.shadows,
        whites: edits.settings.whites,
        blacks: edits.settings.blacks,
      },
      revision: edits.revision,
    }
  }

  private reusableProcessing(
    id: string,
    data: ProcessingOptions | undefined,
  ): ProcessingOptions | undefined {
    const photo = this.find(id)
    if (!photo) return undefined
    if (photo.assetKind === 'derived') {
      if (!data?.metadata.mergeMaster) throw new Error('The merged working source is unavailable.')
      // A validated master has no original container to inspect when metadata versions change.
      return data
    }
    return data?.metadata.version === PROCESSING_METADATA_VERSION ? data : undefined
  }

  private async processingOptions(
    id: string,
    signal = new AbortController().signal,
  ): Promise<ProcessingOptions> {
    signal.throwIfAborted()
    this.assertRecovered(true)
    if (typeof id !== 'string' || !hashPattern.test(id) || this.closed || !this.find(id))
      throw new Error('This photo is unavailable.')
    // Cached catalog reads need no original-file access or foreground admission.
    const existing = this.readProcessing(id)
    const cached = this.reusableProcessing(id, existing)
    if (cached) return cached
    return this.scheduler.run('interactive', () => this.loadProcessingOptions(id, signal), signal)
  }
  private async loadProcessingOptions(
    id: string,
    signal = new AbortController().signal,
  ): Promise<ProcessingOptions> {
    this.assertRecovered()
    if (typeof id !== 'string' || !hashPattern.test(id) || this.closed || !this.find(id))
      throw new Error('This photo is unavailable.')
    const existing = this.readProcessing(id)
    const cached = this.reusableProcessing(id, existing)
    if (cached) return cached
    const work = this.metadataTail.then(async () => {
      signal.throwIfAborted()
      const existing = this.readProcessing(id)
      const cached = this.reusableProcessing(id, existing)
      if (cached) return cached
      const photo = this.find(id)
      if (!photo || this.closed) throw new Error('This photo is unavailable.')
      const path = join(
        this.root,
        'originals',
        id,
        `original${extname(photo.filename).toLowerCase()}`,
      )
      const metadata = await this.metadataProcessor.inspect(path, signal)
      signal.throwIfAborted()
      if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
      const data: ProcessingOptions = {
        metadata,
        settings: existing?.settings ?? { ...automaticLensSettings },
        revision: existing?.revision ?? 0,
      }
      await this.scheduler.mutate(async () => {
        this.assertRecovered()
        if (!this.find(id)) throw new Error('This photo is unavailable.')
        await this.write({
          operation: 'processing.publish',
          payload: {
            id,
            data,
            createdAt: new Date().toISOString(),
          },
        })
        this.changed(undefined, true)
      }, signal)
      return this.readProcessing(id)!
    })
    this.metadataTail = work.catch(() => undefined)
    return work
  }

  async getLensSettings(id: string): Promise<LensState> {
    const data = await this.processingOptions(id)
    return {
      photoId: id,
      revision: data.revision,
      settings: data.settings,
      profile: data.metadata.lensProfile,
      fixed: !!data.metadata.mergeMaster,
    }
  }

  private readEdits(id: string): EditHistory {
    const row = this.db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as
      { data: string } | undefined
    if (row) {
      const history = JSON.parse(row.data) as EditHistory
      if (
        history.settings.version !== SETTINGS_VERSION ||
        history.snapshots.some((snapshot) => snapshot.settings.version !== SETTINGS_VERSION)
      )
        throw new Error('These edits require a newer version of Luma.')
      return history
    }
    throw new Error('This photo has no confirmed edit history.')
  }

  async getEditHistory(id: string): Promise<EditHistory> {
    await this.processingOptions(id)
    if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
    return this.readEdits(id)
  }

  displayTarget?: () => DisplayTarget
  flushEditorEdits: (scope: EditFlushScope) => Promise<void> = async () => {}
  getPhotoStatistics(id: string, expectedRevision: number): Promise<PhotoStatistics>
  getPhotoStatistics(
    id: string,
    expectedRevision: number,
    request: HdrAnalysisRequest,
  ): Promise<HdrPhotoStatistics>
  getPhotoStatistics(
    id: string,
    expectedRevision: number,
    request?: HdrAnalysisRequest,
  ): Promise<PhotoStatistics | HdrPhotoStatistics>
  async getPhotoStatistics(
    id: string,
    expectedRevision: number,
    request?: HdrAnalysisRequest,
  ): Promise<PhotoStatistics | HdrPhotoStatistics> {
    if (request === undefined) return this.fullPreviews.statistics(id, expectedRevision)
    return this.withHdrTarget(id, request, (target) =>
      this.fullPreviews.hdrStatistics(id, expectedRevision, request.domain, target),
    )
  }

  getPhotoPixel(
    id: string,
    expectedRevision: number,
    x: number,
    y: number,
    request: HdrAnalysisRequest,
  ): Promise<HdrPhotoPixel> {
    return this.withHdrTarget(id, request, (target) =>
      this.fullPreviews.hdrPixel(id, expectedRevision, x, y, request.domain, target),
    )
  }

  private async withHdrTarget<T>(
    id: string,
    request: HdrAnalysisRequest,
    work: (target: DisplayTarget) => Promise<T>,
  ): Promise<T> {
    if (
      !request ||
      !['working-hdr', 'content-hdr', 'output'].includes(request.domain) ||
      Object.keys(request).some((key) => !['domain', 'target', 'targetGeneration'].includes(key)) ||
      (request.target !== undefined && !['sdr', 'current'].includes(request.target)) ||
      (request.targetGeneration !== undefined &&
        (!Number.isSafeInteger(request.targetGeneration) || request.targetGeneration < 0))
    )
      throw new Error('Invalid HDR analysis request.')
    const current =
      request.domain !== 'working-hdr' &&
      (request.target === 'current' || (request.domain === 'output' && request.target !== 'sdr'))
    let target = current ? this.displayTarget?.() : SDR_TARGET
    if (!target || (current && request.targetGeneration !== target.generation))
      throw new Error('Display target generation conflict.')
    if (
      current &&
      target.presentation?.photoId === id &&
      target.presentation.stage === 'presented' &&
      target.presentation.backend === 'canvas2d-hdr-sdr'
    )
      target = { ...target, mode: 'sdr', colorSpace: 'srgb', peak: 1 }
    const result = await work(target)
    if (
      current &&
      (this.displayTarget?.().generation !== target.generation ||
        this.displayTarget?.().presentation?.backend !== target.presentation?.backend)
    )
      throw new Error('Display target generation conflict.')
    return result
  }

  async getEdits(id: string): Promise<EditState> {
    return this.editState(await this.getEditHistory(id))
  }

  private editState(history: EditHistory): EditState {
    const { photoId, revision, settings, canUndo, canRedo } = history
    return {
      photoId,
      revision,
      settings,
      canUndo,
      canRedo,
      hdrEligible: this.readProcessing(photoId)?.metadata.hdrEligible,
      hdrJpeg: this.readProcessing(photoId)?.metadata.hdrJpeg,
      whiteBalanceProfile: this.readProcessing(photoId)?.metadata.whiteBalance,
      referenceWhiteBalance: !!this.readProcessing(photoId)?.metadata.mergeMaster,
    }
  }

  private async publishEdit(history: EditHistory, expectedRevision: number): Promise<EditState> {
    this.assertRecovered()
    const confirmed = await this.write({
      operation: 'edits.commit',
      payload: { history, expectedRevision },
    })
    if (!this.closed) this.fullPreviews.settingsChanged(confirmed.history.photoId)
    if (!this.closed)
      this.emit({
        editsChanged: { photoId: confirmed.history.photoId, revision: confirmed.history.revision },
        lensChanged: confirmed.lensChanged
          ? { photoId: confirmed.history.photoId, revision: confirmed.history.revision }
          : undefined,
      })
    return this.editState(confirmed.history)
  }

  async updateEdits(id: string, patch: EditPatch, expectedRevision: number): Promise<EditState> {
    validatePatch(patch)
    if (patch.lens && this.find(id)?.assetKind === 'derived')
      throw new Error('Lens corrections are fixed in merged masters.')
    await this.processingOptions(id)
    if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
    const data = this.readProcessing(id)!
    const history = this.readEdits(id)
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      history.revision !== expectedRevision
    )
      throw new Error('Edit conflict: reload the confirmed settings and try again.')
    for (const kind of correctionKinds)
      if (patch.lens?.[kind] !== undefined && !data.metadata.lensProfile[kind])
        throw new Error('This correction is unavailable.')
    if (patch.whiteBalance?.mode === 'custom' && !data.metadata.whiteBalance)
      throw new Error('White balance is unavailable for this camera.')
    const settings = {
      ...history.settings,
      ...patch,
      lens: { ...history.settings.lens, ...patch.lens },
    }
    if (JSON.stringify(settings) === JSON.stringify(history.settings)) {
      return this.editState(history)
    }
    history.settings = settings
    history.snapshots = history.snapshots.slice(0, history.cursor + 1)
    history.snapshots.push({ settings, createdAt: new Date().toISOString() })
    history.cursor++
    return this.scheduler.run('interactive', () =>
      this.scheduler.mutate(async () => {
        if (!this.find(id)) throw new Error('This photo is unavailable.')
        return this.publishEdit(history, expectedRevision)
      }),
    )
  }

  async undoEdit(id: string, expectedRevision: number): Promise<EditState> {
    return this.moveEdit(id, expectedRevision, -1)
  }
  async redoEdit(id: string, expectedRevision: number): Promise<EditState> {
    return this.moveEdit(id, expectedRevision, 1)
  }
  private async moveEdit(
    id: string,
    expectedRevision: number,
    direction: -1 | 1,
  ): Promise<EditState> {
    await this.processingOptions(id)
    if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
    const history = this.readEdits(id)
    const cursor = history.cursor + direction
    if (cursor < 0 || cursor >= history.snapshots.length)
      throw new Error('No edit history in that direction.')
    history.cursor = cursor
    history.settings = history.snapshots[cursor].settings
    return this.scheduler.run('interactive', () =>
      this.scheduler.mutate(async () => {
        if (!this.find(id)) throw new Error('This photo is unavailable.')
        return this.publishEdit(history, expectedRevision)
      }),
    )
  }

  async updateLensSettings(id: string, kind: CorrectionKind, enabled: boolean): Promise<LensState> {
    if (!correctionKinds.includes(kind) || typeof enabled !== 'boolean')
      throw new Error('Invalid lens correction setting.')
    const work = this.lensTail.then(async () => {
      const state = await this.getEdits(id)
      await this.updateEdits(id, { lens: { [kind]: enabled } }, state.revision)
      return this.getLensSettings(id)
    })
    this.lensTail = work.catch(() => undefined)
    return work
  }

  getWorkspaceState() {
    return this.workspace.read()
  }
  async getExportCapabilities() {
    const unavailable = await verifyExportEncoder().then(
      () => undefined,
      (error) => errorMessage(error),
    )
    return {
      format: 'jpeg' as const,
      hdr: 'iso-21496-1' as const,
      codec: EXPORT_CODEC_VERSION,
      rendering: EXPORT_RENDERING_VERSION,
      hdrAvailable: !unavailable,
      hdrUnavailableReason: unavailable,
    }
  }
  getExportPreferences() {
    return this.exports.store.publicPreferences()
  }
  async prepareExport(ids: string[]) {
    this.assertRecovered(true)
    const photoIds = validateExportPhotoIds(ids)
    await this.flushEditorEdits({ kind: 'photos', photoIds })
    return this.exports.prepare(photoIds)
  }
  async startExport(request: import('../shared/export').ExportStart) {
    this.assertRecovered(true)
    const snapshot = structuredClone(request)
    const photoIds = this.exports.preparedPhotoIds(snapshot)
    await this.flushEditorEdits({ kind: 'photos', photoIds })
    return this.exports.start(snapshot)
  }
  saveWorkspaceState(change: WorkspaceChange) {
    if (this.closed) throw new Error('This library is closed.')
    return this.write({ operation: 'workspace.save', payload: change })
  }
  getCollectionPolicy() {
    return this.collectionResources
  }
  getGallerySummary(selectedIds: string[] = []) {
    return this.stacks.gallerySummary(selectedIds)
  }
  getGalleryChunk(offset: number, revision: GalleryRevision) {
    return this.stacks.galleryChunk(offset, revision)
  }

  list(offset = 0): PhotoPage {
    this.validateOffset(offset)
    const rows = this.db
      .prepare('SELECT photo FROM photos ORDER BY imported_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(COLLECTION_CHUNK_SIZE, offset) as { photo: string }[]
    const count = this.db.prepare('SELECT COUNT(*) AS total FROM photos').get() as { total: number }
    return { photos: rows.map((row) => JSON.parse(row.photo) as Photo), total: count.total }
  }

  getBrowseSummary(query: BrowseQuery, selectedIds: string[] = []) {
    return this.browse.summary(query, selectedIds)
  }
  getPhotoActionsContext(photoId: string | null, selectedIds: string[]) {
    const context = new PhotoActionsStore(this.db).read(photoId, selectedIds)
    const recovery = this.recoveryReason()
    const organization = this.libraryOperationReason('organization') ?? recovery
    const foreground =
      this.libraryOperationReason('foreground') ?? (!this.scheduler.mutating ? recovery : undefined)
    const merge = foreground ?? this.merges.unavailableReason()
    const trash = (ids: string[]) =>
      this.libraryOperationReason('foreground', true) ??
      foreground ??
      (this.exports?.leased(ids)
        ? 'Finish or cancel the export before deleting its source photographs.'
        : this.merges.leased(ids)
          ? 'Close the merge review or cancel its task before deleting source photographs.'
          : undefined)
    const { photo, selection, group } = context
    const selected = selection.map((p) => p.id)
    const groupIds = group?.photos.map((p) => p.id) ?? []
    context.availability = {
      'photo-export': actionAvailability(!!photo, recovery),
      'selection-export': actionAvailability(selection.length > 0, recovery),
      'photo-cover': actionAvailability(!!group && photo?.id !== group.stack.coverId, organization),
      'photo-remove': actionAvailability(!!group, organization),
      'selection-hdr': actionAvailability(originalMergeApplicable(selection), merge),
      'selection-noise': actionAvailability(originalMergeApplicable(selection), merge),
      'selection-group': actionAvailability(
        selection.length >= 2 && selection.every((p) => !p.groupId),
        organization,
      ),
      'group-select': actionAvailability(!!group && !context.equivalent.groupSelection),
      'group-hdr': actionAvailability(originalMergeApplicable(group?.originals ?? []), merge),
      'group-noise': actionAvailability(originalMergeApplicable(group?.originals ?? []), merge),
      'group-ungroup': actionAvailability(!!group, organization),
      'library-scan': actionAvailability(context.originalArwCount >= 2, organization),
      'photo-trash': actionAvailability(!!photo, trash(photo ? [photo.id] : [])),
      'selection-trash': actionAvailability(selection.length > 0, trash(selected)),
      'group-trash': actionAvailability(!!group, trash(groupIds)),
    }
    return context
  }
  getBrowseChunk(query: BrowseQuery, offset = 0, expectedRevision?: number) {
    return this.browse.chunk(query, offset, expectedRevision)
  }
  locateBrowsePhoto(query: BrowseQuery, id: string, expectedRevision?: number) {
    return this.browse.locate(query, id, expectedRevision)
  }
  getBrowseRange(query: BrowseQuery, fromId: string, toId: string) {
    return this.browse.range(query, fromId, toId)
  }
  getBrowseSection(query: BrowseQuery, key: string) {
    return this.browse.section(query, key)
  }

  listStacks() {
    return this.stacks.overview()
  }
  getPhotoStack(id: string) {
    return this.stacks.forPhoto(id)
  }
  getStackMembers(id: string, offset = 0) {
    return this.stacks.members(id, offset)
  }
  getStackSnapshot(id: string, revision: number) {
    return this.stacks.snapshot(id, revision)
  }
  listGallery(offset = 0, selectedIds: string[] = []) {
    return this.stacks.gallery(offset, selectedIds)
  }
  locateGalleryPhoto(id: string, direction: -1 | 0 | 1 = 0, revision?: GalleryRevision) {
    if (typeof id !== 'string' || !hashPattern.test(id) || ![-1, 0, 1].includes(direction))
      throw new Error('Invalid photo navigation.')
    if (!this.find(id)) return null
    return this.stacks.locate(id, direction, revision)
  }
  getGalleryRange(from: string, to: string) {
    return this.stacks.range(from, to)
  }
  private async mutateStack<T>(work: () => Promise<T>): Promise<T> {
    const reason = this.libraryOperationReason('organization')
    if (reason) throw new Error(reason)
    this.assertRecovered()
    return this.scheduler.run('operation', () =>
      this.scheduler.mutate(async () => {
        const current = this.libraryOperationReason('organization')
        if (current) throw new Error(current)
        this.assertRecovered()
        const result = await work()
        this.changed(undefined, true)
        return result
      }),
    )
  }
  groupPhotos(ids: string[], coverId: string, revision: number) {
    return this.mutateStack(() =>
      this.write({ operation: 'stack.group', payload: { ids, coverId, revision } }),
    )
  }
  ungroupStack(id: string, revision: number) {
    return this.mutateStack(() =>
      this.write({ operation: 'stack.ungroup', payload: { id, revision } }),
    )
  }
  removeFromStack(id: string, revision: number) {
    return this.mutateStack(() =>
      this.write({ operation: 'stack.remove', payload: { photoId: id, revision } }),
    )
  }
  setStackCover(id: string, photoId: string, revision: number) {
    return this.mutateStack(() =>
      this.write({ operation: 'stack.cover', payload: { id, photoId, revision } }),
    )
  }
  async setStackExpanded(id: string, expanded: boolean, revision: number) {
    // Expansion is safe while a task imports or inspects originals; membership stays fixed.
    if (this.closed) throw new Error('This library is closed.')
    this.assertRecovered()
    const result = await this.write({
      operation: 'stack.expanded',
      payload: { id, expanded, revision },
    })
    this.changed(undefined, true)
    return result
  }

  groupCaptureSequences(): string {
    const reason = this.libraryOperationReason('organization')
    if (reason) throw new Error(reason)
    this.assertRecovered()
    const photos = (
      this.db
        .prepare(
          "SELECT photo FROM photos WHERE COALESCE(json_extract(photo, '$.assetKind'), 'original') != 'derived' ORDER BY imported_at, rowid",
        )
        .all() as { photo: string }[]
    ).map((r) => JSON.parse(r.photo) as Photo)
    const id = randomUUID()
    const task = {
      snapshot: {
        id,
        kind: 'capture-grouping',
        title: 'Grouping capture sequences',
        status: 'running',
        progress: { completed: 0, total: photos.length, unit: 'items' },
        items: { completed: 0, total: photos.length, label: 'photos inspected' },
        errorCount: 0,
      } as BackgroundTask,
      errors: [] as TaskErrorPage['errors'],
      abort: new AbortController(),
      work: Promise.resolve(),
    }
    this.tasks.set(id, task)
    this.changed()
    task.work = (async () => {
      try {
        for (const photo of photos) {
          task.abort.signal.throwIfAborted()
          task.snapshot.detail = photo.filename
          this.changed()
          try {
            if (this.stacks.capture(photo.id)?.version !== CAPTURE_METADATA_VERSION) {
              const path = join(
                this.root,
                'originals',
                photo.id,
                `original${extname(photo.filename).toLowerCase()}`,
              )
              const metadata = await this.inspectCapture(path, task.abort.signal)
              task.abort.signal.throwIfAborted()
              await this.write({
                operation: 'capture.publish',
                payload: { photoId: photo.id, metadata },
              })
            }
          } catch (error) {
            if (task.abort.signal.aborted) throw error
            task.errors.push({ filename: photo.filename, message: errorMessage(error) })
          }
          task.snapshot.progress!.completed++
          task.snapshot.items!.completed++
          task.snapshot.errorCount = task.errors.length
          this.changed()
          // Yield even for cached metadata so cancellation can interrupt a long scan.
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        task.abort.signal.throwIfAborted()
        const count = await this.write({ operation: 'capture.reconcile', payload: {} })
        task.snapshot.detail = `${count} ${count === 1 ? 'stack' : 'stacks'} created or extended`
      } catch (error) {
        if (!task.abort.signal.aborted)
          task.errors.push({ filename: 'Library', message: errorMessage(error) })
      } finally {
        await this.closeCaptureProcessor()
        task.snapshot.status = task.abort.signal.aborted
          ? 'cancelled'
          : task.errors.length
            ? 'failed'
            : 'completed'
        task.snapshot.title = task.abort.signal.aborted
          ? 'Capture grouping cancelled'
          : task.errors.length
            ? 'Capture grouping finished with errors'
            : 'Capture grouping complete'
        task.snapshot.errorCount = task.errors.length
        task.snapshot.finishedAt = Date.now()
        this.changed(undefined, true)
      }
    })()
    return id
  }

  listTasks(): BackgroundTask[] {
    return [...this.tasks.values()]
      .map((task) => structuredClone(task.snapshot))
      .concat(this.exports?.list() ?? [])
  }

  deletePhotos(ids: string[]): string | null {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !hashPattern.test(id)))
      throw new Error('Invalid photo selection.')
    const reason = this.libraryOperationReason('foreground', true)
    if (reason) throw new Error(reason)
    this.assertRecovered(true)
    if (this.exports?.leased(ids))
      throw new Error('Finish or cancel the export before deleting its source photographs.')
    if (this.merges.leased(ids))
      throw new Error(
        'Close the merge review or cancel its task before deleting source photographs.',
      )
    const photos = [...new Set(ids)]
      .map((id) => this.find(id))
      .filter((photo): photo is Photo => Boolean(photo))
    if (!photos.length) return null
    const id = randomUUID()
    const task = {
      snapshot: {
        id,
        kind: 'delete',
        title: 'Moving photos to Trash',
        status: 'running',
        progress: { completed: 0, total: photos.length, unit: 'items' },
        items: { completed: 0, total: photos.length, label: 'photos moved to Trash' },
        errorCount: 0,
      } as BackgroundTask,
      errors: [] as TaskErrorPage['errors'],
      abort: new AbortController(),
      work: Promise.resolve(),
    }
    this.tasks.set(id, task)
    this.changed()
    task.work = this.scheduler
      .run(
        'operation',
        async () => {
          try {
            if (this.session && this.session.phase !== 'importing')
              await this.dispose(this.session.id)
            for (const photo of photos) {
              if (task.abort.signal.aborted) break
              task.snapshot.detail = photo.filename
              this.changed()
              let attempted = false
              try {
                await this.scheduler.checkpoint(task.abort.signal)
                await this.scheduler.mutate(async () => {
                  attempted = true
                  this.assertRecovered()
                  if (this.exports?.leased([photo.id]))
                    throw new Error(
                      'Finish or cancel the export before deleting its source photographs.',
                    )
                  if (this.merges.leased([photo.id]))
                    throw new Error('Close the merge review before deleting source photographs.')
                  if (!this.find(photo.id)) return
                  const stack = this.getPhotoStack(photo.id)
                  const cover = stack?.coverId
                  const survivor = stack
                    ? this.getStackMembers(stack.id).photos.find((p) => p.id !== photo.id)?.id
                    : undefined
                  const neighbor =
                    this.locateGalleryPhoto(photo.id, 1) ?? this.locateGalleryPhoto(photo.id, -1)
                  let replacementId = cover && cover !== photo.id ? cover : neighbor?.photo.id
                  await this.fullPreviews.beginRemoval(photo.id)
                  try {
                    await this.removals.remove(photo.id)
                    for (const hashes of this.importSuppression.values()) hashes.add(photo.id)
                    // A surviving promoted cover occupies the deleted cover's gallery position.
                    replacementId =
                      this.listStacks().stacks.find((s) => s.id === stack?.id)?.coverId ??
                      survivor ??
                      replacementId
                  } finally {
                    await this.fullPreviews.endRemoval(photo.id, !this.find(photo.id))
                  }
                  task.snapshot.items!.completed++
                  if (!this.closed)
                    this.emit({ libraryChanged: true, deletedIds: [photo.id], replacementId })
                }, task.abort.signal)
              } catch (error) {
                if (!task.abort.signal.aborted)
                  task.errors.push({ filename: photo.filename, message: errorMessage(error) })
              }
              if (attempted) task.snapshot.progress!.completed++
              task.snapshot.errorCount = task.errors.length
              this.changed()
            }
          } catch (error) {
            task.errors.push({ filename: 'Library', message: errorMessage(error) })
          } finally {
            task.snapshot.status = task.abort.signal.aborted
              ? 'cancelled'
              : task.errors.length
                ? 'failed'
                : 'completed'
            task.snapshot.title = task.abort.signal.aborted
              ? 'Deletion cancelled'
              : task.errors.length
                ? 'Deletion finished with errors'
                : 'Moved to Trash'
            task.snapshot.errorCount = task.errors.length
            task.snapshot.detail = undefined
            task.snapshot.finishedAt = Date.now()
            this.changed(undefined, true)
          }
        },
        task.abort.signal,
      )
      .catch((error) => {
        if (!task.abort.signal.aborted)
          task.errors.push({ filename: 'Library', message: errorMessage(error) })
        if (!task.snapshot.finishedAt) {
          task.snapshot.status = task.abort.signal.aborted ? 'cancelled' : 'failed'
          task.snapshot.title = task.abort.signal.aborted ? 'Deletion cancelled' : 'Deletion failed'
          task.snapshot.errorCount = task.errors.length
          task.snapshot.finishedAt = Date.now()
          this.changed()
        }
      })
    return id
  }

  private hasCaptureTask(): boolean {
    return [...this.tasks.values()].some(
      ({ snapshot }) =>
        snapshot.kind === 'capture-grouping' && ['running', 'cancelling'].includes(snapshot.status),
    )
  }
  private libraryOperationReason(
    kind: 'organization' | 'foreground',
    replacing = kind === 'organization',
  ): string | undefined {
    if (
      this.closed ||
      (replacing && this.replacingSession) ||
      this.session?.phase === 'scanning' ||
      (kind === 'organization' ? this.hasActiveTask(false) : this.hasCaptureTask())
    )
      return 'Finish or cancel the current library operation first.'
    return undefined
  }

  hasActiveTask(includeExports = true): boolean {
    return (
      (includeExports && !!this.exports?.hasActive()) ||
      !!this.session?.accepting ||
      [...this.tasks.values()].some(({ snapshot }) =>
        ['running', 'cancelling'].includes(snapshot.status),
      )
    )
  }

  taskErrors(id: string, offset = 0): TaskErrorPage {
    this.validateOffset(offset)
    if (this.exports?.has(id)) return this.exports.errors(id, offset)
    const task = this.tasks.get(id)
    if (!task) throw new Error('This task has been dismissed.')
    return {
      errors: task.errors
        .slice(offset, offset + COLLECTION_CHUNK_SIZE)
        .map((error) => ({ ...error })),
      total: task.errors.length,
    }
  }

  async cancelTask(id: string): Promise<void> {
    if (this.exports?.has(id)) return this.exports.cancel(id)
    const task = this.tasks.get(id)
    if (!task) throw new Error('This task has been dismissed.')
    if (!['running', 'cancelling'].includes(task.snapshot.status)) return
    task.snapshot.status = 'cancelling'
    task.snapshot.title =
      task.snapshot.kind === 'delete'
        ? 'Cancelling deletion…'
        : task.snapshot.kind === 'merge'
          ? 'Cancelling merge…'
          : task.snapshot.kind === 'capture-grouping'
            ? 'Cancelling capture grouping…'
            : 'Cancelling import…'
    this.changed()
    if (task.abort) {
      task.abort.abort()
      await task.work
    } else await this.cancel(id)
  }

  async dismissTask(id: string): Promise<void> {
    if (this.exports?.has(id)) return this.exports.dismiss(id)
    const task = this.tasks.get(id)
    if (!task) return
    if (['running', 'cancelling'].includes(task.snapshot.status))
      throw new Error('Cancel the task before dismissing it.')
    this.tasks.delete(id)
    if (!this.closed) this.emit({ tasksChanged: true })
  }

  private recoveryReason(): string | undefined {
    if (this.catalog?.failure)
      return 'Catalog writes are unavailable. Restart Luma before changing this library.'
    if (this.db.prepare('SELECT 1 FROM removals LIMIT 1').get())
      return 'An interrupted deletion needs recovery. Restart Luma before changing the library.'
    for (const row of this.db
      .prepare('SELECT id, manifest_sha256 FROM merge_publications')
      .all() as {
      id: string
      manifest_sha256: string
    }[]) {
      if (this.retainedUnsupportedMerges.get(row.id) !== row.manifest_sha256)
        return 'An interrupted merge publication needs recovery. Restart Luma before changing the library.'
    }
    return undefined
  }
  private assertRecovered(admission = false): void {
    if (this.catalog?.failure)
      throw new Error('Catalog writes are unavailable. Restart Luma before changing this library.')
    if (admission && this.scheduler.mutating) return
    const reason = this.recoveryReason()
    if (reason) throw new Error(reason)
  }

  private validateOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid collection offset.')
  }

  private getSession(id: string): Session {
    if (!this.session || this.session.id !== id) throw new Error('This import session has expired.')
    return this.session
  }

  private changed(session?: Session, libraryChanged = false): void {
    if (this.closed) return
    if (session) session.contentRevision++
    if (libraryChanged)
      this.emit({
        sessionId: session?.id,
        libraryChanged: true,
        firstImportedId: session?.firstImportedId,
      })
    if (this.notification) return
    this.notification = setTimeout(() => {
      this.notification = undefined
      if (!this.closed) this.emit({ sessionId: this.session?.id, tasksChanged: true })
    }, 80)
  }

  async scan(
    paths: string[],
    recursive: boolean,
    device?: Session['device'],
    onlyMissing = true,
    verificationMode: import('../shared/contracts').ImportVerificationMode = 'camera-fast',
  ): Promise<string> {
    if (typeof onlyMissing !== 'boolean') throw new Error('Invalid missing-photo option.')
    if (!['camera-fast', 'full'].includes(verificationMode))
      throw new Error('Invalid verification mode.')
    if (
      this.closed ||
      this.replacingSession ||
      this.hasActiveTask(false) ||
      this.session?.phase === 'importing'
    )
      throw new Error('Finish or cancel the current import before choosing another source.')
    this.assertRecovered()
    this.replacingSession = true
    try {
      if (this.session) await this.dispose(this.session.id)
      const session: Session = {
        id: randomUUID(),
        source:
          device?.source.displayName ??
          (paths.length === 1 ? basename(paths[0]) : `${paths.length} selected files`),
        phase: 'scanning',
        candidates: [],
        candidatesById: new Map(),
        counts: emptyReviewCounts(),
        counted: new Map(),
        skipped: 0,
        defaultSelected: true,
        selectionRevision: 0,
        orderingRevision: 0,
        contentRevision: 0,
        thumbnailGeneration: 0,
        abort: new AbortController(),
        task: Promise.resolve(),
        device,
        onlyMissing: device ? onlyMissing : undefined,
        verificationMode: device ? verificationMode : undefined,
        verificationAbort: new AbortController(),
        verificationGeneration: 0,
        verificationCursor: 0,
        verificationTask: Promise.resolve(),
        verificationPending: false,
        thumbnails: this.reviewThumbnailFactory((id, value) => {
          if (
            this.session !== session ||
            !['scanning', 'review'].includes(session.phase) ||
            session.abort.signal.aborted
          )
            return
          const candidate = session.candidatesById.get(id)
          if (!candidate) return
          candidate.thumbnailState = value.state
          candidate.thumbnailMessage = value.error
          if (value.state === 'ready')
            candidate.thumbnailUrl = `luma-photo://review/${session.id}/${id}/thumb`
          this.changed(session)
        }),
      }
      this.session = session
      session.task = this.scanFiles(session, paths, recursive)
        .catch((error) => {
          if (!session.abort.signal.aborted) {
            if (error instanceof DeviceUnavailableError) this.invalidateDevice(session, error)
            else this.addError(session, session.source, error)
          }
        })
        .finally(async () => {
          // Policy changes replace the current verification without delaying their acknowledgement.
          let current: Promise<void>
          do {
            current = session.verificationTask
            await current
          } while (current !== session.verificationTask)
          session.phase = session.abort.signal.aborted ? 'cancelled' : 'review'
          this.changed(session)
        })
      return session.id
    } finally {
      this.replacingSession = false
    }
  }

  private invalidateDevice(session: Session, error: unknown): void {
    session.sourceError ??= errorMessage(error)
    session.abort.abort()
    session.verificationAbort.abort()
    void session.thumbnails.cancel()
    this.changed(session)
  }

  async validateDeviceReview(revalidate?: (source: DeviceSource) => Promise<void>): Promise<void> {
    const session = this.session
    if (!session?.device || session.sourceError || !['scanning', 'review'].includes(session.phase))
      return
    try {
      if (revalidate) await revalidate(session.device.source)
      else await session.device.validate()
    } catch (error) {
      if (error instanceof DeviceUnavailableError) {
        if (this.session === session) this.invalidateDevice(session, error)
      } else throw error
    }
  }

  requestReviewThumbnails(id: string, request: string[] | ReviewThumbnailRequest): void {
    if (!this.session || this.session.id !== id) return
    const s = this.session
    const value = Array.isArray(request)
      ? { generation: s.thumbnailGeneration + 1, visible: request, lookahead: [] }
      : request
    if (
      !value ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      ![value.visible, value.lookahead].every(
        (ids) => Array.isArray(ids) && ids.every((v) => typeof v === 'string'),
      ) ||
      value.visible.length > 10000 ||
      value.lookahead.length > this.collectionResources.records ||
      Object.keys(value).some((k) => !['generation', 'visible', 'lookahead'].includes(k))
    )
      throw new Error('Invalid thumbnail selection.')
    if (value.generation <= s.thumbnailGeneration) return
    s.thumbnailGeneration = value.generation
    if (
      !['scanning', 'review'].includes(s.phase) ||
      s.sourceError ||
      s.abort.signal.aborted ||
      s.accepting
    )
      return
    this.refreshAlreadyImported(s)
    const visible = new Set(value.visible)
    const inputs = [...new Set([...value.visible, ...value.lookahead])].flatMap((id) => {
      const c = s.candidatesById.get(id)
      if (!c) throw new Error('This photo is unavailable in the review.')
      if (c.sourcePhotoId || c.checkingSource) return []
      c.cacheDir ??= join(this.root, 'staging', s.id, c.id)
      return [{ id: c.id, path: c.path, output: c.cacheDir, priority: visible.has(id) ? 0 : 1 }]
    })
    s.thumbnails.request(inputs)
  }

  private addError(session: Session, path: string, error: unknown): void {
    this.addCandidate(session, {
      id: randomUUID(),
      path,
      filename: basename(path),
      relativePath: basename(path),
      bytes: 0,
      status: 'error',
      selected: false,
      thumbnailState: 'idle',
      message: errorMessage(error),
    })
    this.changed(session)
  }

  private addCandidate(s: Session, c: Candidate): void {
    s.orderingRevision++
    s.candidates.push(c)
    s.candidatesById.set(c.id, c)
    this.countCandidate(s, c)
  }

  private countCandidate(s: Session, c: Candidate): void {
    const next = emptyReviewCounts()
    const eligible = ['unchecked', 'ready'].includes(c.status)
    if (eligible) next.totalBytes = c.bytes
    if (eligible && c.selected && !(s.onlyMissing && c.alreadyImported)) {
      next.selected = 1
      next.selectedBytes = c.bytes
    }
    if (c.alreadyImported) {
      next.alreadyImported = 1
      next.alreadyImportedBytes = c.bytes
    }
    const status = {
      unchecked: 'unchecked',
      ready: 'ready',
      duplicate: 'duplicates',
      error: 'errors',
      imported: 'imported',
    } as const
    if (c.status in status) next[status[c.status as keyof typeof status]] = 1
    const old = s.counted.get(c.id) ?? emptyReviewCounts()
    for (const key of Object.keys(next) as (keyof ReviewCounts)[])
      s.counts[key] += next[key] - old[key]
    s.counted.set(c.id, next)
  }

  private async scanFiles(session: Session, paths: string[], recursive: boolean): Promise<void> {
    const visited = new Set<string>()
    const managedRoot = await realpath(this.root)
    if (session.device) await session.device.validate(true)
    const visit = async (path: string, base: string, explicit: boolean): Promise<void> => {
      if (session.abort.signal.aborted) return
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) {
          session.skipped++
          return
        }
        const canonical = await realpath(path)
        if (
          canonical === managedRoot ||
          canonical.startsWith(managedRoot + sep) ||
          visited.has(canonical)
        )
          return
        if (session.device) {
          assertDevicePathContained(session.device.source, canonical)
          const root = session.device.source.roots.find(
            (r) => pathWithin(r.path, canonical) && String(info.dev) === r.filesystemDevice,
          )
          if (!root || String(info.dev) !== root.filesystemDevice) {
            session.skipped++
            return
          }
        }
        visited.add(canonical)
        if (info.isDirectory()) {
          const hidden = session.device
            ? await this.directoryVisibility.hiddenEntries(canonical, session.abort.signal)
            : new Set<string>()
          for (const entry of await readdir(canonical, { withFileTypes: true })) {
            if (session.abort.signal.aborted) break
            if (
              entry.isSymbolicLink() ||
              (session.device &&
                (entry.name.startsWith('.') ||
                  hidden.has(entry.name) ||
                  (entry.isDirectory() &&
                    /^(?:\$recycle\.bin|recycler|recycled|system volume information|lost\+found|\$extend)$/i.test(
                      entry.name,
                    ))))
            ) {
              session.skipped++
              continue
            }
            if (entry.isDirectory() && !recursive) continue
            const child = join(canonical, entry.name)
            if (
              session.device &&
              session.device.source.roots.some((r) => r.nestedMounts.includes(child))
            ) {
              session.skipped++
              continue
            }
            await visit(child, base, false)
          }
          return
        }
        if (!info.isFile()) {
          session.skipped++
          return
        }
        if (!extensions.has(extname(canonical).toLowerCase())) {
          if (explicit)
            this.addError(session, path, 'Unsupported format. Choose JPEG, PNG, TIFF, or Sony ARW.')
          else session.skipped++
          return
        }
        const inspection = session.device ? await this.inspectSource(canonical) : undefined
        const sourceKey =
          session.device && inspection
            ? importSourceKey(session.device.source, canonical)
            : undefined
        const sourceRecord =
          sourceKey && inspection
            ? { key: sourceKey, witness: inspection.witness, reusable: inspection.reusable }
            : undefined
        const candidate: Candidate = {
          id: randomUUID(),
          filename: basename(path),
          relativePath: relative(base, path) || basename(path),
          path: canonical,
          bytes: info.size,
          identity: {
            dev: info.dev,
            ino: info.ino,
            size: info.size,
            mtimeMs: info.mtimeMs,
            ctimeMs: info.ctimeMs,
          },
          status: 'unchecked',
          selected: session.defaultSelected,
          sourceRecord,
          cameraKey: session.device ? cameraSourceKey(session.device.source, canonical) : undefined,
          sourceWitness: inspection?.witness,
          checkingSource: !!session.device,
          thumbnailState: 'idle',
        }
        this.addCandidate(session, candidate)
        if (session.device) this.startVerification(session)
        this.changed(session)
      } catch (error) {
        if (error instanceof DeviceUnavailableError) throw error
        if (!session.abort.signal.aborted) this.addError(session, path, error)
      }
    }
    for (const path of paths)
      await visit(
        resolve(path),
        (await stat(path).catch(() => undefined))?.isDirectory()
          ? resolve(path)
          : resolve(path, '..'),
        true,
      )
    if (session.device && !session.abort.signal.aborted) await session.device.validate(true)
  }

  private async validateSource(s: Session, c: Candidate, force = false): Promise<void> {
    s.abort.signal.throwIfAborted()
    if (s.sourceError) throw new DeviceUnavailableError()
    if (s.device) {
      await s.device.validate(force)
      assertDevicePathContained(s.device.source, c.path)
    }
    const current = await lstat(c.path)
    const canonical = await realpath(c.path)
    if (
      !c.identity ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      canonical !== c.path ||
      current.dev !== c.identity.dev ||
      current.ino !== c.identity.ino ||
      current.size !== c.identity.size ||
      current.mtimeMs !== c.identity.mtimeMs ||
      current.ctimeMs !== c.identity.ctimeMs
    )
      throw new Error(
        'The source changed after review. Choose it again to review the updated photo.',
      )
    if (c.sourceRecord) {
      const inspection = await this.inspectSource(c.path)
      if (
        (c.sourceRecord.reusable && !inspection.reusable) ||
        !sameImportSourceWitness(inspection.witness, c.sourceRecord.witness)
      )
        throw new Error(
          'The source changed after review. Choose it again to review the updated photo.',
        )
    }
    s.abort.signal.throwIfAborted()
  }

  private sourceReadControl(s: Session, c: Candidate, signal: AbortSignal) {
    return {
      chunk: <T>(work: () => Promise<T>) =>
        this.scheduler.background(async (_signal, paused) => {
          if (paused) await this.validateSource(s, c, true)
          signal.throwIfAborted()
          return work()
        }, signal),
    }
  }

  private hashPreviousSource(s: Session, c: Candidate, signal = s.abort.signal): Promise<string> {
    return this.hashSource(c.path, signal, this.sourceReadControl(s, c, signal))
  }

  private markRecognized(s: Session, c: Candidate, id?: string): void {
    const photo = id ? this.liveCameraOriginal(id) : undefined
    if (c.sourcePhotoId && !photo && c.thumbnailUrl?.startsWith('luma-photo://library/')) {
      c.thumbnailUrl = undefined
      c.thumbnailState = 'idle'
    }
    c.alreadyImported = !!photo
    c.sourcePhotoId = photo?.id
    if (photo) c.recognitionHint = photo.id
    if (photo && ['scanning', 'review'].includes(s.phase)) {
      c.thumbnailUrl = photo.thumbnailUrl
      c.thumbnailState = 'ready'
    }
    this.countCandidate(s, c)
  }

  private liveCameraOriginal(id: string): Photo | undefined {
    if (!this.cameraRecognition.live(id)) return
    const photo = this.find(id)
    return photo &&
      existsSync(
        join(this.root, 'originals', id, `original${extname(photo.filename).toLowerCase()}`),
      )
      ? photo
      : undefined
  }

  private async recognize(s: Session, c: Candidate, signal: AbortSignal): Promise<void> {
    const witness = c.sourceWitness
    if (!witness || c.status === 'error' || c.recognitionRejected) return
    const binding = c.cameraKey && this.cameraRecognition.binding(c.cameraKey)
    // A changed observation must go through the ordinary copy/hash path, even if samples agree.
    if (binding && !cameraMetadataMatches(binding, witness)) return
    const boundId =
      binding && this.liveCameraOriginal(binding.photoId) ? binding.photoId : undefined
    if (s.verificationMode === 'camera-fast' && boundId) {
      this.markRecognized(s, c, boundId)
      return
    }
    const legacy =
      s.verificationMode === 'full'
        ? ((c.sourceRecord &&
            this.importSources.find(c.sourceRecord.key, c.sourceRecord.witness)) ??
          (c.recognitionHint && this.liveCameraOriginal(c.recognitionHint)
            ? c.recognitionHint
            : undefined))
        : undefined
    const pool =
      s.verificationMode === 'camera-fast'
        ? this.cameraRecognition.candidates(c.filename, c.bytes)
        : []
    if (!boundId && !legacy && !pool.length) return
    s.checkingPrevious = c.filename
    this.changed(s)
    await this.validateSource(s, c)
    signal.throwIfAborted()
    if (s.verificationMode === 'full') {
      const hash = await this.hashPreviousSource(s, c, signal)
      await this.validateSource(s, c)
      signal.throwIfAborted()
      if (this.liveCameraOriginal(hash)) {
        c.verifiedHash = hash
        if (c.cameraKey)
          await this.write({
            operation: 'camera.record',
            payload: { key: c.cameraKey, witness, photoId: hash, proof: 'full' },
          })
        this.markRecognized(s, c, hash)
      } else c.recognitionRejected = true
      return
    }
    // All unbound Fast candidates use the complete bounded pool, including legacy hints.
    const card = await this.sampleSource(c.path, signal, this.sourceReadControl(s, c, signal))
    const matches: string[] = []
    for (const original of pool) {
      signal.throwIfAborted()
      let digest = this.cameraRecognition.sample(original.id)
      if (!digest) {
        try {
          const path = join(
            this.root,
            'originals',
            original.id,
            `original${extname(original.filename).toLowerCase()}`,
          )
          digest = (await this.sampleSource(path, signal, this.sourceReadControl(s, c, signal)))
            .digest
          signal.throwIfAborted()
          await this.write({
            operation: 'camera.sample',
            payload: { photoId: original.id, digest },
          })
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof DeviceUnavailableError) throw error
          continue
        }
      }
      if (digest === card.digest && this.liveCameraOriginal(original.id)) matches.push(original.id)
    }
    await this.validateSource(s, c)
    signal.throwIfAborted()
    if (matches.length === 1) {
      if (c.cameraKey)
        await this.write({
          operation: 'camera.record',
          payload: { key: c.cameraKey, witness, photoId: matches[0], proof: 'sample' },
        })
      this.markRecognized(s, c, matches[0])
    }
  }

  private startVerification(s: Session, restart = false): void {
    if (restart) {
      s.verificationAbort.abort()
      s.verificationAbort = new AbortController()
      s.verificationGeneration++
      s.verificationCursor = 0
      for (const c of s.candidates) {
        c.verifiedHash = undefined
        c.checkingSource = !!c.sourceWitness
        this.markRecognized(s, c)
      }
    } else if (s.verificationPending) return
    const generation = s.verificationGeneration
    const signal = AbortSignal.any([s.abort.signal, s.verificationAbort.signal])
    const previous = s.verificationTask
    s.verificationPending = true
    s.verificationTask = (async () => {
      await previous
      while (s.verificationCursor < s.candidates.length) {
        signal.throwIfAborted()
        const c = s.candidates[s.verificationCursor]
        try {
          await this.recognize(s, c, signal)
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof DeviceUnavailableError) throw error
          c.status = 'error'
          c.selected = false
          c.message = errorMessage(error)
        }
        signal.throwIfAborted()
        s.verificationCursor++
        c.checkingSource = false
        this.countCandidate(s, c)
        this.changed(s)
      }
    })()
      .catch((error) => {
        if (!signal.aborted && generation === s.verificationGeneration) {
          if (error instanceof DeviceUnavailableError) this.invalidateDevice(s, error)
          else this.addError(s, s.source, error)
        }
      })
      .finally(() => {
        if (generation !== s.verificationGeneration) return
        s.verificationPending = false
        s.checkingPrevious = undefined
        if (!signal.aborted && s.verificationCursor < s.candidates.length) this.startVerification(s)
        this.changed(s)
      })
    this.changed(s)
  }

  setImportVerificationMode(
    id: string,
    mode: import('../shared/contracts').ImportVerificationMode,
  ): void {
    const s = this.getSession(id)
    if (!['camera-fast', 'full'].includes(mode)) throw new Error('Invalid verification mode.')
    if (
      !s.device ||
      this.closed ||
      this.replacingSession ||
      s.accepting ||
      s.abort.signal.aborted ||
      s.sourceError ||
      !['scanning', 'review'].includes(s.phase)
    )
      throw new Error('This review is no longer selectable.')
    if (s.verificationMode === mode) return
    s.verificationMode = mode
    s.selectionRevision++
    this.startVerification(s, true)
  }

  private refreshAlreadyImported(s: Session, force = false): void {
    const revision = this.cameraRecognition.revision()
    if (!force && s.membershipRevision === revision) return
    s.membershipRevision = revision
    for (const c of s.candidates) {
      if (!c.sourcePhotoId) continue
      const binding = c.cameraKey && this.cameraRecognition.binding(c.cameraKey)
      const matchingBinding =
        !c.cameraKey ||
        s.verificationMode === 'full' ||
        (binding?.photoId === c.sourcePhotoId &&
          !!c.sourceWitness &&
          cameraMetadataMatches(binding, c.sourceWitness))
      if (!matchingBinding || !this.liveCameraOriginal(c.sourcePhotoId)) this.markRecognized(s, c)
    }
  }

  private selectedCandidates(s: Session): Candidate[] {
    return s.candidates.filter(
      (c) =>
        c.selected &&
        ['unchecked', 'ready'].includes(c.status) &&
        !(s.onlyMissing && c.alreadyImported),
    )
  }

  private orderedReview(s: Session) {
    if (s.orderedCandidates?.length !== s.candidates.length) {
      s.orderedCandidates = [...s.candidates].sort((a, b) => {
        const aTime = a.identity?.mtimeMs ?? -Infinity,
          bTime = b.identity?.mtimeMs ?? -Infinity
        if (aTime !== bTime) return aTime > bTime ? -1 : 1
        return reviewNameOrder.compare(a.relativePath, b.relativePath) || a.id.localeCompare(b.id)
      })
    }
    return s.orderedCandidates
  }
  reviewSummary(id: string): ImportReviewSummary {
    const s = this.getSession(id)
    this.refreshAlreadyImported(s)
    return {
      sessionId: id,
      source: s.source,
      sourceError: s.sourceError,
      checkingPrevious: s.checkingPrevious,
      onlyMissing: s.onlyMissing,
      verificationMode: s.verificationMode,
      verificationPending: s.verificationPending,
      ...s.counts,
      phase: s.phase,
      total: s.candidates.length,
      orderingRevision: s.orderingRevision,
      contentRevision: s.contentRevision,
      selectionRevision: s.selectionRevision,
      skipped: s.skipped,
      firstImportedId: s.firstImportedId,
    }
  }
  private candidate(c: Candidate, s: Session): ImportCandidate {
    const {
      id,
      filename,
      relativePath,
      bytes,
      status,
      selected,
      alreadyImported,
      thumbnailUrl,
      thumbnailState,
      thumbnailMessage,
      message,
    } = c
    return {
      id,
      filename,
      relativePath,
      bytes,
      status,
      selected: selected && !(s.onlyMissing && alreadyImported),
      alreadyImported,
      thumbnailUrl,
      thumbnailState,
      thumbnailMessage,
      message,
    }
  }
  reviewChunk(id: string, offset: number, orderingRevision: number): ImportReviewChunk {
    this.validateOffset(offset)
    const s = this.getSession(id)
    this.refreshAlreadyImported(s)
    if (!Number.isSafeInteger(orderingRevision) || s.orderingRevision !== orderingRevision)
      throw new CollectionChangedError()
    return {
      sessionId: id,
      offset,
      orderingRevision,
      contentRevision: s.contentRevision,
      selectionRevision: s.selectionRevision,
      candidates: this.orderedReview(s)
        .slice(offset, offset + COLLECTION_CHUNK_SIZE)
        .map((c) => this.candidate(c, s)),
    }
  }
  locateReviewCandidate(id: string, candidateId: string, orderingRevision: number) {
    const s = this.getSession(id)
    if (!Number.isSafeInteger(orderingRevision) || orderingRevision !== s.orderingRevision)
      throw new CollectionChangedError()
    const index = this.orderedReview(s).findIndex((c) => c.id === candidateId)
    return index < 0
      ? null
      : { orderingRevision, index, candidate: this.candidate(this.orderedReview(s)[index], s) }
  }
  review(id: string, offset = 0): ImportReview {
    const summary = this.reviewSummary(id)
    return {
      ...summary,
      candidates: this.reviewChunk(id, offset, summary.orderingRevision).candidates,
    }
  }

  select(id: string, ids: string[] | null, selected: boolean): void {
    const s = this.getSession(id)
    if (
      this.replacingSession ||
      s.accepting ||
      s.abort.signal.aborted ||
      !['scanning', 'review'].includes(s.phase) ||
      s.sourceError
    )
      throw new Error('This review is no longer selectable.')
    if (
      typeof selected !== 'boolean' ||
      (ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')))
    )
      throw new Error('Invalid photo selection.')
    this.refreshAlreadyImported(s)
    s.selectionRevision++
    if (ids === null) s.defaultSelected = selected
    const chosen = ids === null ? s.candidates : ids.flatMap((id) => s.candidatesById.get(id) ?? [])
    for (const c of chosen)
      if (['unchecked', 'ready'].includes(c.status) && !(s.onlyMissing && c.alreadyImported)) {
        c.selected = selected
        this.countCandidate(s, c)
      }
    this.changed(s)
  }

  setImportOnlyMissing(id: string, enabled: boolean): void {
    const s = this.getSession(id)
    if (typeof enabled !== 'boolean') throw new Error('Invalid missing-photo option.')
    if (!s.device) throw new Error('Missing-photo selection is available for device imports.')
    if (
      this.closed ||
      this.replacingSession ||
      s.accepting ||
      s.abort.signal.aborted ||
      s.sourceError ||
      !['scanning', 'review'].includes(s.phase)
    )
      throw new Error('This review is no longer selectable.')
    this.refreshAlreadyImported(s)
    s.onlyMissing = enabled
    for (const c of s.candidates) this.countCandidate(s, c)
    s.selectionRevision++
    this.changed(s)
  }

  importSelected(id: string): void | Promise<void> {
    if (this.closed || this.replacingSession || this.hasActiveTask(false))
      throw new Error('Finish or cancel the current library operation first.')
    this.assertRecovered()
    const s = this.getSession(id)
    this.refreshAlreadyImported(s)
    if (
      s.phase !== 'review' ||
      s.verificationPending ||
      s.accepting ||
      s.abort.signal.aborted ||
      s.sourceError ||
      !this.selectedCandidates(s).length
    )
      throw new Error('Select at least one photo after scanning finishes.')
    const skipped = s.onlyMissing ? s.candidates.filter((c) => c.selected && c.alreadyImported) : []
    if (!s.device && !skipped.length) return this.acceptImport(s)
    s.accepting = true
    const acceptance = (async () => {
      try {
        if (s.device) await s.device.validate(true)
        s.abort.signal.throwIfAborted()
        for (const c of skipped) {
          await this.validateSource(s, c)
          if (s.verificationMode === 'full') {
            const hash = await this.hashPreviousSource(s, c)
            await this.validateSource(s, c)
            if (hash !== c.verifiedHash)
              throw new Error(
                'The source changed after review. Choose it again to review the updated photo.',
              )
            if (c.cameraKey && c.sourceWitness)
              await this.write({
                operation: 'camera.record',
                payload: {
                  key: c.cameraKey,
                  witness: c.sourceWitness,
                  photoId: hash,
                  proof: 'full',
                },
              })
          }
        }
        s.abort.signal.throwIfAborted()
        this.assertRecovered()
        this.refreshAlreadyImported(s, true)
        this.acceptImport(s)
      } catch (error) {
        if (error instanceof DeviceUnavailableError && this.session === s)
          this.invalidateDevice(s, error)
        throw error
      } finally {
        s.accepting = false
      }
    })()
    // Cancellation and shutdown await validation; IPC receives its original failure.
    s.task = acceptance.catch(() => undefined)
    return acceptance
  }

  private acceptImport(s: Session): void {
    const id = s.id
    const selected = this.selectedCandidates(s)
    if (!selected.length) throw new Error('Select at least one photo after scanning finishes.')
    const task = {
      importCapacity: false,
      snapshot: {
        id,
        kind: 'import',
        waitingReason: this.scheduler.preparationWaitingReason,
        title: 'Importing photos',
        status: 'running' as BackgroundTask['status'],
        progress: {
          completed: 0,
          total: selected.length,
          unit: 'items' as const,
        },
        transfer: {
          copied: 0,
          prepared: 0,
          bytes: 0,
          totalBytes: selected.reduce((sum, c) => sum + c.bytes, 0),
          bytesPerSecond: 0,
        },
        skippedAfterDeletion: 0,
        importMeasurements: {
          copyActiveMs: 0,
          preparationMs: 0,
          stagingPeakBytes: 0,
          inFlightPeak: 0,
        },
        items: { completed: 0, total: selected.length, label: 'photos imported' },
        errorCount: 0,
        outcomes: { processed: 0, imported: 0, duplicates: 0, failed: 0 },
      } as BackgroundTask,
      errors: [] as TaskErrorPage['errors'],
      abort: s.abort,
      work: Promise.resolve(),
    }
    this.tasks.set(id, task)
    this.importSuppression.set(id, new Set())
    s.phase = 'importing'
    this.changed(s)
    task.work = s.task = (async () => {
      try {
        await s.thumbnails.cancel()
        await this.commit(s, selected)
        if (!s.abort.signal.aborted && !task.errors.length)
          await this.scheduler.mutate(async () => {
            this.assertRecovered()
            await this.write({ operation: 'capture.reconcile', payload: {} })
          }, s.abort.signal)
      } catch (error) {
        if (!s.abort.signal.aborted)
          task.errors.push({ filename: s.source, message: errorMessage(error) })
      } finally {
        // Result summaries outlive preview staging and the review session.
        try {
          await rm(join(this.root, 'staging', id), { recursive: true, force: true })
        } catch (error) {
          task.errors.push({
            filename: s.source,
            message: `Could not clean temporary files: ${errorMessage(error)}`,
          })
        }
        s.phase = s.abort.signal.aborted ? 'cancelled' : 'complete'
        task.snapshot.status = s.abort.signal.aborted
          ? 'cancelled'
          : task.errors.length
            ? 'failed'
            : 'completed'
        task.snapshot.title = s.abort.signal.aborted
          ? 'Import cancelled'
          : task.errors.length
            ? 'Import finished with errors'
            : 'Import complete'
        task.snapshot.errorCount = task.errors.length
        task.snapshot.detail = undefined
        task.snapshot.waitingReason = undefined
        task.snapshot.transfer!.bytesPerSecond = 0
        task.snapshot.finishedAt = Date.now()
        this.importSuppression.delete(id)
        this.changed(s, true)
      }
    })()
  }

  private async commit(s: Session, selected: Candidate[]): Promise<void> {
    const task = this.tasks.get(s.id)!
    const signal = s.abort.signal
    const suppressed = this.importSuppression.get(s.id)!
    const started = performance.now()
    const measurements = task.snapshot.importMeasurements!
    const transfer = task.snapshot.transfer!
    const processors = [this.processor]
    const count = this.importOptions.workers ?? preparationWorkers()
    if (this.processor.createWorker)
      while (processors.length < count) processors.push(this.processor.createWorker())
    const stagingFor = (c: Candidate) => join(this.root, 'staging', s.id, `copy-${c.id}`)
    const known = (hash: string) =>
      suppressed.has(hash)
        ? ('deleted' as const)
        : this.find(hash)
          ? ('duplicate' as const)
          : undefined
    let activeCopyBytes = 0
    try {
      task.snapshot.unprocessed = await runImportPipeline(
        selected,
        processors,
        this.scheduler,
        signal,
        {
          known,
          copy: async (c) => {
            await this.validateSource(s, c, true)
            const directory = stagingFor(c)
            await mkdir(directory, { recursive: true })
            task.snapshot.detail = c.filename
            this.changed(s)
            const path = join(directory, `original${extname(c.path).toLowerCase()}`)
            let copied = 0
            const hash = await this.transfer(
              c.path,
              path,
              signal,
              (bytes) => {
                const increment = Math.min(bytes, c.bytes - copied)
                copied += increment
                transfer.bytes += increment
                activeCopyBytes += bytes
                this.changed(s)
              },
              {
                checkpoint: () => this.scheduler.preparationCheckpoint(signal),
                resumed: () => this.validateSource(s, c, true),
                chunk: (work) =>
                  this.scheduler.background(async (_signal, paused) => {
                    if (paused) await this.validateSource(s, c, true)
                    return work()
                  }, signal),
                active: (ms) => {
                  measurements.copyActiveMs += ms
                  transfer.bytesPerSecond = measurements.copyActiveMs
                    ? (activeCopyBytes / measurements.copyActiveMs) * 1000
                    : 0
                },
              },
            )
            await this.validateSource(s, c)
            signal.throwIfAborted()
            if (!hashPattern.test(hash))
              throw new Error('The copied photo has an invalid content hash.')
            transfer.copied++
            c.copiedHash = hash
            return { hash, path, directory }
          },
          prepare: async (processor, staged, abort, fallback, seed) => {
            const at = performance.now()
            try {
              const prepared = processor.prepare
                ? await processor.prepare(staged.path, staged.directory, abort, fallback, seed)
                : await processor.process(staged.path, staged.directory, abort)
              if (!prepared.needsFallback) transfer.prepared++
              return prepared
            } catch (error) {
              // process() cancellation waits for exit before generated assets are removed.
              for (const name of ['embedded.jpg', 'preview.jpg', 'thumb.jpg'])
                await rm(join(staged.directory, name), { force: true })
              throw error
            } finally {
              measurements.preparationMs += performance.now() - at
            }
          },
          publish: async (c, staged, preview) =>
            this.scheduler.mutate(async () => {
              this.assertRecovered()
              signal.throwIfAborted()
              const existing = known(staged.hash)
              if (existing) return existing
              const finalDir = join(this.root, 'originals', staged.hash)
              const photo: Photo = {
                ...preview.metadata,
                id: staged.hash,
                filename: c.filename,
                format: extname(c.path).slice(1).toUpperCase(),
                bytes: c.bytes,
                importedAt: new Date().toISOString(),
                thumbnailUrl: `luma-photo://library/${staged.hash}/thumb`,
                previewUrl: `luma-photo://library/${staged.hash}/preview`,
                previewSource: preview.source,
              }
              await rename(staged.directory, finalDir)
              try {
                await this.write({
                  operation: 'original.publish',
                  payload: {
                    photo,
                    processingIdentity: preview.processing?.hdrEligible
                      ? 'hdr-v1'
                      : 'display-referred-v1',
                    metadata: preview.processing,
                    capture: preview.captureMetadata,
                    createdAt: photo.importedAt,
                  },
                })
              } catch (error) {
                // An acknowledgement can be lost after durable publication. The dead writer
                // cannot make further progress; preserve this owned bundle for readback/reopen.
                if (error instanceof CatalogWriterFailure) throw error
                await rm(finalDir, { recursive: true, force: true })
                throw error
              }
              task.snapshot.items!.completed++
              task.snapshot.outcomes!.imported++
              c.thumbnailUrl = photo.thumbnailUrl
              s.firstImportedId ??= photo.id
              measurements.firstPublicationMs ??= performance.now() - started
              this.changed(s, true)
              return 'imported'
            }, signal),
          clean: async (c) => {
            await rm(stagingFor(c), { recursive: true, force: true }).catch(() => undefined)
          },
          resolved: async (c, outcome, error) => {
            c.selected = false
            if (outcome === 'imported') c.status = 'imported'
            else if (outcome === 'duplicate') {
              c.status = 'duplicate'
              c.message = 'Already imported'
              task.snapshot.outcomes!.duplicates++
            } else if (outcome === 'deleted') {
              c.status = 'skipped'
              c.message = 'Skipped after deletion'
              task.snapshot.skippedAfterDeletion!++
            } else {
              c.status = 'error'
              c.message = errorMessage(error)
              task.snapshot.outcomes!.failed++
              task.errors.push({ filename: c.filename, message: c.message })
              task.snapshot.errorCount = task.errors.length
            }
            task.snapshot.outcomes!.processed++
            this.countCandidate(s, c)
            task.snapshot.progress!.completed = task.snapshot.outcomes!.processed
            this.changed(s)
            if (
              (outcome === 'imported' || outcome === 'duplicate') &&
              c.sourceRecord &&
              c.copiedHash
            )
              await this.write({
                operation: 'source.record',
                payload: {
                  key: c.sourceRecord.key,
                  witness: c.sourceRecord.witness,
                  photoId: c.copiedHash,
                },
              })
            if (
              (outcome === 'imported' || outcome === 'duplicate') &&
              c.cameraKey &&
              c.sourceWitness &&
              c.copiedHash
            )
              await this.write({
                operation: 'camera.record',
                payload: {
                  key: c.cameraKey,
                  witness: c.sourceWitness,
                  photoId: c.copiedHash,
                  proof: 'full',
                },
              })
          },
          sourceStopped: (error) => {
            if (!(error instanceof DeviceUnavailableError)) return false
            s.sourceError ??= errorMessage(error)
            return true
          },
          progress: (state) => {
            measurements.stagingPeakBytes = Math.max(
              measurements.stagingPeakBytes,
              state.stagedBytes,
            )
            measurements.inFlightPeak = Math.max(measurements.inFlightPeak, state.inFlight)
            task.importCapacity = state.capacity
            task.snapshot.waitingReason =
              this.scheduler.preparationWaitingReason ??
              (state.capacity ? 'pipeline-capacity' : undefined)
            this.changed(s)
          },
        },
        this.importOptions,
      )
    } finally {
      await Promise.all(processors.map((p) => p.close()))
    }
  }

  async cancel(id: string): Promise<void> {
    const accepted = this.tasks.get(id)
    if (accepted?.snapshot.kind === 'import' && accepted.abort && this.session?.id !== id) {
      accepted.abort.abort()
      await accepted.work
      return
    }
    const s = this.getSession(id)
    const task = this.tasks.get(id)
    if (task && task.snapshot.status === 'running') {
      task.snapshot.status = 'cancelling'
      task.snapshot.title = 'Cancelling import…'
      this.changed(s)
    }
    s.abort.abort()
    s.verificationAbort.abort()
    await Promise.all([s.task, s.verificationTask, s.thumbnails.cancel()])
    s.phase = 'cancelled'
    this.changed(s)
  }

  async dispose(id: string): Promise<void> {
    // Closing accepted review UI does not own or cancel the background task.
    if (this.session?.id === id && this.session.phase === 'importing') {
      this.session = undefined
      return
    }
    await this.cancel(id)
    await rm(join(this.root, 'staging', id), { recursive: true, force: true })
    this.session = undefined
  }

  imagePath(url: string): string | undefined {
    if (this.closed) return
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'luma-photo:' ||
      parsed.search ||
      parsed.hash ||
      parsed.port ||
      parsed.username ||
      parsed.password
    )
      return
    const parts = parsed.pathname.slice(1).split('/')
    if (parsed.hostname === 'merge') return this.merges.imagePath(parts)
    if (parsed.hostname === 'library' && parts.length === 2) {
      const [id, kind] = parts
      if (hashPattern.test(id) && ['thumb', 'preview'].includes(kind) && this.find(id)) {
        const original = join(this.root, 'originals', id, `${kind}.jpg`)
        if (existsSync(original)) return original
        const staged = this.removals.stagedPath(id)
        return staged ? join(staged, `${kind}.jpg`) : original
      }
    }
    if (
      parsed.hostname === 'review' &&
      parts.length === 3 &&
      this.session?.id === parts[0] &&
      parts[2] === 'thumb'
    ) {
      const candidate = this.session.candidatesById.get(parts[1])
      if (candidate?.cacheDir && candidate.thumbnailState === 'ready')
        return join(candidate.cacheDir, 'thumb.jpg')
    }
  }

  getActiveMergeReview() {
    return this.merges.active()
  }
  getMergeDiagnostics(id: string, revision: number) {
    return this.merges.diagnostics(id, revision)
  }
  async createMergeReview(ids: string[], mode: MergeMode) {
    const reason = this.libraryOperationReason('foreground')
    if (reason) throw new Error(reason)
    this.assertRecovered(true)
    return this.merges.create(ids, mode)
  }
  updateMergeReview(id: string, revision: number, settings: MergeSettings) {
    return this.merges.update(id, revision, settings)
  }
  requestMergePreview(id: string, revision: number) {
    return this.merges.preview(id, revision)
  }
  disposeMergeReview(id: string) {
    return this.merges.dispose(id)
  }
  async getMergeProvenance(id: string) {
    const row = this.db.prepare('SELECT manifest FROM derived_assets WHERE id = ?').get(id) as
      { manifest: string } | undefined
    if (!row) throw new Error('This photo is not a merged asset.')
    const manifest = JSON.parse(row.manifest) as MergeBundleManifest
    const available = await Promise.all(
      manifest.recipe.sources.map(async (source) => {
        const photo = this.find(source.id)
        return (
          !!photo &&
          existsSync(
            join(
              this.root,
              'originals',
              source.id,
              `original${extname(photo.filename).toLowerCase()}`,
            ),
          )
        )
      }),
    )
    let supportedSource = true
    try {
      validateHdrSource(manifest.asset.source)
    } catch {
      supportedSource = false
    }
    return {
      manifest,
      reproducible:
        manifest.version === MERGE_VERSION &&
        manifest.recipe.version === MERGE_VERSION &&
        supportedSource &&
        available.every(Boolean),
    }
  }
  private commitMerge(manifest: MergeManifest): Promise<void> {
    return this.write({
      operation: 'merge.publish',
      payload: { manifest, createdAt: manifest.photo.importedAt },
    })
  }
  startMerge(reviewId: string, revision: number): string {
    if (this.closed || this.hasCaptureTask() || this.session?.phase === 'scanning')
      throw new Error('Finish the current library operation first.')
    this.assertRecovered(true)
    const accepted = this.merges.accept(reviewId, revision),
      id = randomUUID()
    const task = {
      snapshot: {
        id,
        kind: 'merge',
        title: 'Merging photographs',
        status: 'running',
        phase: 'Publishing reviewed master',
        errorCount: 0,
        progress: { completed: 0, total: 3, unit: 'items' },
      } as BackgroundTask,
      errors: [] as TaskErrorPage['errors'],
      abort: new AbortController(),
      work: Promise.resolve(),
    }
    this.tasks.set(id, task)
    this.changed()
    task.work = (async () => {
      let pendingDirectory: string | undefined
      let journaled = false
      const acceptedAt = performance.now()
      let publication: MergeMeasurements['publication']
      const timed = async <T>(
        field: 'copyingMs' | 'fileSyncMs' | 'manifestMs' | 'directorySyncMs' | 'renameMs',
        work: () => Promise<T>,
      ): Promise<T> => {
        const started = performance.now()
        try {
          return await work()
        } finally {
          if (publication) publication[field] += performance.now() - started
        }
      }
      const verification = () => ({
        readingMs: 0,
        hashingMs: 0,
        pixelValidationMs: 0,
        metadataMs: 0,
        closingMs: 0,
      })
      try {
        await this.scheduler.run(
          'operation',
          async () => {
            const admittedAt = performance.now()
            const { review } = accepted
            const { result, output } = await accepted.render(task.abort.signal)
            task.snapshot.title = 'Publishing merged photo'
            const publicationStart = performance.now()
            publication = {
              clock: 'main-performance',
              runtimeMs: 0,
              operationQueueMs: admittedAt - acceptedAt,
              reviewHandoffMs: publicationStart - admittedAt,
              sourceVerification: verification(),
              destinationVerification: verification(),
              copyingMs: 0,
              fileSyncMs: 0,
              manifestMs: 0,
              directorySyncMs: 0,
              mutationQueueMs: 0,
              journalMs: 0,
              renameMs: 0,
              catalogCommitMs: 0,
              cleanupMs: 0,
            }
            const measurements = structuredClone(result.measurements)
            measurements.publication = publication
            task.snapshot.mergeMeasurements = measurements
            task.snapshot.phase = 'Verifying master'
            task.snapshot.detail = undefined
            this.changed()
            const photoId = createHash('sha256').update(randomUUID()).digest('hex'),
              directory = join(this.root, 'merge-publications', photoId)
            const reference = review.sources.find(
              (s) => s.photo.id === review.settings.referenceId,
            )!
            const referenceDate =
              [
                reference.captureMetadata?.preciseTime,
                reference.captureMetadata?.dateTimeOriginal,
                reference.metadata.capturedAt,
                reference.photo.capturedAt,
              ]
                .map(validatedCaptureDate)
                .find((date) => date !== null) ??
              this.browse.locate(DEFAULT_BROWSE_QUERY, reference.photo.id)?.photo.captureDate
            const photo: Photo = {
              id: photoId,
              assetKind: 'derived',
              filename: `${basename(reference.photo.filename, extname(reference.photo.filename))}-${review.settings.mode === 'hdr' ? 'HDR' : 'Stack'}.luma`,
              format: 'LUMA HDR',
              bytes: result.asset.byteLength,
              width: result.asset.width,
              height: result.asset.height,
              importedAt: new Date().toISOString(),
              thumbnailUrl: `luma-photo://library/${photoId}/thumb`,
              previewUrl: `luma-photo://library/${photoId}/preview`,
              previewSource: 'decoded',
              camera: reference.photo.camera,
              lens: reference.photo.lens,
              capturedAt: referenceDate ?? undefined,
              captureDateOrigin: {
                kind: 'merge-reference',
                photoId: reference.photo.id,
                filename: reference.photo.filename,
              },
            }
            const metadata = {
              ...reference.metadata,
              capturedAt: photo.capturedAt,
              capture: undefined,
              mergeMaster: undefined,
            }
            const manifest: MergeManifest = {
              version: MERGE_VERSION,
              photo,
              metadata,
              asset: result.asset,
              recipe: result.recipe,
            }
            await verifyMaster(output, manifest, publication.sourceVerification)
            task.abort.signal.throwIfAborted()
            // Cleanup ownership begins only after this job creates its own directory.
            await mkdir(directory)
            pendingDirectory = directory
            let copiedBytes = 0
            for (const name of ['linear.f32', 'motion.mask', 'thumb.jpg', 'preview.jpg']) {
              task.abort.signal.throwIfAborted()
              await timed('copyingMs', async () => {
                await cp(join(output, name), join(directory, name), {
                  errorOnExist: true,
                  force: false,
                })
                copiedBytes += (await stat(join(directory, name))).size
              })
              await timed('fileSyncMs', async () => {
                const file = await open(join(directory, name), 'r+')
                try {
                  await file.sync()
                } finally {
                  await file.close()
                }
              })
            }
            await timed('manifestMs', () => durableJson(join(directory, 'manifest.json'), manifest))
            await verifyMaster(directory, manifest, publication.destinationVerification)
            await timed('directorySyncMs', () => syncDirectory(directory))
            await timed('directorySyncMs', () =>
              syncDirectory(join(this.root, 'merge-publications')),
            )
            await this.mergeBoundary?.('staged')
            task.abort.signal.throwIfAborted()
            const mutationQueuedAt = performance.now()
            let mutationAdmitted = false
            await this.scheduler
              .mutate(async () => {
                mutationAdmitted = true
                publication!.mutationQueueMs = performance.now() - mutationQueuedAt
                this.assertRecovered()
                const journalStart = performance.now()
                // Once journaled, finish publication even when cancellation arrives.
                try {
                  await this.write({
                    operation: 'merge.journal',
                    payload: {
                      id: photoId,
                      manifestSha256: createHash('sha256')
                        .update(JSON.stringify(manifest))
                        .digest('hex'),
                    },
                  })
                } catch (error) {
                  // Lost ACK must not turn a durable publication journal into disposable staging.
                  if (error instanceof CatalogWriterFailure) {
                    // Unknown comes first: an unavailable read connection cannot prove absence.
                    journaled = true
                    try {
                      journaled = !!this.db
                        .prepare('SELECT 1 FROM merge_publications WHERE id = ?')
                        .get(photoId)
                    } catch (readback) {
                      throw new AggregateError(
                        [error, readback],
                        'Merge journal acknowledgement and readback failed; publication bytes were retained.',
                        { cause: readback },
                      )
                    }
                  }
                  throw error
                } finally {
                  publication!.journalMs = performance.now() - journalStart
                }
                journaled = true
                await this.mergeBoundary?.('journaled')
                task.snapshot.phase = 'Publishing master'
                task.snapshot.progress!.completed = 2
                this.changed()
                await timed('renameMs', () =>
                  rename(directory, join(this.root, 'originals', photoId)),
                )
                await timed('directorySyncMs', () => syncDirectory(join(this.root, 'originals')))
                await timed('directorySyncMs', () =>
                  syncDirectory(join(this.root, 'merge-publications')),
                )
                await this.mergeBoundary?.('published')
                const commitStart = performance.now()
                try {
                  await this.commitMerge(manifest)
                } finally {
                  publication!.catalogCommitMs = performance.now() - commitStart
                }
                await this.mergeBoundary?.('committed')
              }, task.abort.signal)
              .finally(() => {
                if (!mutationAdmitted)
                  publication!.mutationQueueMs = performance.now() - mutationQueuedAt
              })
            measurements.stages.publication = performance.now() - publicationStart
            measurements.runtimeMs += measurements.stages.publication
            measurements.disk.readBytes +=
              copiedBytes +
              (result.asset.byteLength +
                result.recipe.maskDimensions.width * result.recipe.maskDimensions.height) *
                2
            measurements.disk.writtenBytes +=
              copiedBytes + Buffer.byteLength(JSON.stringify(manifest))
            task.snapshot.mergeMeasurements = measurements
            task.snapshot.resultPhotoId = photoId
            task.snapshot.progress!.completed = 3
            task.snapshot.status = 'completed'
            task.snapshot.title = 'Merged photo ready'
          },
          task.abort.signal,
        )
      } catch (error) {
        task.snapshot.status = task.abort.signal.aborted ? 'cancelled' : 'failed'
        task.snapshot.title = task.abort.signal.aborted ? 'Merge cancelled' : 'Merge failed'
        if (!task.abort.signal.aborted) {
          task.errors.push({ filename: 'Merge', message: errorMessage(error) })
          task.snapshot.errorCount = 1
        }
      } finally {
        const cleanupStart = performance.now()
        try {
          if (pendingDirectory && !journaled)
            await rm(pendingDirectory, { recursive: true, force: true })
          await this.merges.dispose(reviewId, true)
        } finally {
          if (publication) {
            publication.cleanupMs = performance.now() - cleanupStart
            publication.runtimeMs = performance.now() - acceptedAt
          }
        }
        task.snapshot.finishedAt = Date.now()
        this.changed(undefined, true)
      }
    })()
    return id
  }

  close(): Promise<void> {
    return (this.closing ??= this.performClose())
  }

  private async performClose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.activities.clear()
    this.merges.stopAdmission()
    if (this.notification) clearTimeout(this.notification)
    try {
      for (const task of this.tasks.values())
        if (['running', 'cancelling'].includes(task.snapshot.status)) task.abort?.abort()
      for (const [id, task] of this.tasks) {
        if (task.snapshot.status === 'running' || task.snapshot.status === 'cancelling')
          await this.cancelTask(id)
      }
      if (this.session) await this.dispose(this.session.id)
      await this.closeCaptureProcessor()
      await this.metadataProcessor.close()
      await this.directoryVisibility.close()
      await this.metadataTail
      await this.exports?.close()
      await this.fullPreviews.close()
      await this.merges.close()
      this.scheduler.close()
    } finally {
      try {
        await this.processor.close()
      } finally {
        try {
          await this.catalog?.close()
        } finally {
          this.db?.close()
        }
      }
    }
  }
}
