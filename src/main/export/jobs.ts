import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackgroundTask, TaskErrorPage } from '../../shared/contracts'
import {
  defaultExportOptions,
  exportFilename,
  exportPresets,
  validateExportOptions,
  validateExportPhotoIds,
  EXPORT_CODEC_VERSION,
  EXPORT_RENDERING_VERSION,
  type ExportPreparation,
  type ExportStart,
} from '../../shared/export'
import { syncDirectory } from '../merge/store'
import { ForegroundYield, type WorkScheduler } from '../work-scheduler'
import { ExportStore } from './store'
import {
  cleanPartial,
  hashFile,
  identity,
  sameFile,
  sameSource,
  validateDirectory,
  ownedPartialName,
} from './files'
import type { ExportFile, ExportManifest, ExportSource, ExportRenderResult } from './types'
import { ExportProcess } from './process'
import { verifyExportEncoder } from './encoder'
import { COLLECTION_CHUNK_SIZE } from '../../shared/collections'
import { DISPLAY_RENDERING_VERSION, HDR_CONTENT_VERSION } from '../../shared/display-rendering'
import { ADJUSTMENT_VERSION } from '../../shared/adjustments'
import { LENS_RENDER_VERSION } from '../processing/lens-correction'
import type { WorkingAssetLease } from '../working-assets'
import type { ExportWorkerProgress, ExportWorkerProgressSnapshot } from '../../shared/export'
import { acceptExportWorkerProgress, exportProgressOwner } from './progress'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const active = (task: BackgroundTask) => task.status === 'running' || task.status === 'cancelling'
export type ExportBoundary = 'partial' | 'ready' | 'publishing' | 'published' | 'recorded'
interface Job {
  manifest: ExportManifest
  task: BackgroundTask
  abort: AbortController
  work: Promise<void>
  started: boolean
  early?: Promise<void>
  workerProgress?: ExportWorkerProgressSnapshot
}
export class ExportJobs {
  private preparations = new Map<string, { sources: ExportSource[]; created: number }>()
  private jobs = new Map<string, Job>()
  private leases = new Map<string, number>()
  private tail = Promise.resolve()
  private closed = false
  constructor(
    readonly store: ExportStore,
    private root: string,
    private scheduler: WorkScheduler,
    private readSource: (id: string) => Promise<ExportSource>,
    private current: (source: ExportSource) => boolean,
    private changed: () => void,
    private renderer: Pick<ExportProcess, 'render'> = new ExportProcess(),
    private boundary: (boundary: ExportBoundary) => Promise<void> = async () => {},
    private acquireWorkingAsset?: (
      source: ExportSource,
      signal: AbortSignal,
    ) => Promise<WorkingAssetLease | undefined>,
  ) {}
  private lease(id: string, delta: number) {
    const count = (this.leases.get(id) ?? 0) + delta
    if (count > 0) this.leases.set(id, count)
    else this.leases.delete(id)
  }
  leased(ids: string[]) {
    return ids.some((id) => this.leases.has(id))
  }
  hasActive() {
    return [...this.jobs.values()].some((j) => active(j.task))
  }
  has(id: string) {
    return this.jobs.has(id)
  }
  list() {
    return [...this.jobs.values()].map((j) => ({
      ...structuredClone(j.task),
      ...(j.workerProgress ? { exportWorkerProgress: structuredClone(j.workerProgress) } : {}),
    }))
  }
  async prepare(ids: string[]): Promise<ExportPreparation> {
    if (this.closed) throw new Error('Choose photographs to export.')
    const sources: ExportSource[] = []
    for (const id of validateExportPhotoIds(ids)) sources.push(await this.readSource(id))
    if (this.closed || sources.some((source) => !this.current(source)))
      throw new Error('Export targets changed. Open the export chooser again.')
    const id = randomUUID()
    for (const [key, entry] of this.preparations)
      if (Date.now() - entry.created > 15 * 60_000) this.preparations.delete(key)
    while (
      this.preparations.size &&
      (this.preparations.size >= 32 ||
        [...this.preparations.values()].reduce((n, p) => n + p.sources.length, sources.length) >
          100000)
    )
      this.preparations.delete(this.preparations.keys().next().value!)
    this.preparations.set(id, { sources: structuredClone(sources), created: Date.now() })
    const targets = sources.map((s) => ({
      photoId: s.photo.id,
      filename: s.photo.filename,
      revision: s.processing.revision,
      hdr: s.hdr,
    }))
    const hdr = targets.filter((t) => t.hdr).length
    return { id, targets, hdr, sdr: targets.length - hdr }
  }
  dispose(id: string) {
    this.preparations.delete(id)
  }
  private preparationForStart(request: ExportStart) {
    if (
      this.closed ||
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some(
        (k) => !['preparationId', 'destinationId', 'action', 'options'].includes(k),
      )
    )
      throw new Error('Invalid export request.')
    const prepared = this.preparations.get(request.preparationId)
    if (!prepared || Date.now() - prepared.created > 15 * 60_000)
      throw new Error('Export preparation expired. Open the export chooser again.')
    return prepared
  }
  preparedPhotoIds(request: ExportStart): string[] {
    return this.preparationForStart(request).sources.map((source) => source.photo.id)
  }
  async start(request: ExportStart): Promise<string> {
    const prepared = this.preparationForStart(request)
    const preset = exportPresets.find((p) => p.id === request.action)
    if (!preset && !['custom', 'last-custom'].includes(request.action))
      throw new Error('Invalid export action.')
    if (request.action !== 'custom' && request.options !== undefined)
      throw new Error('Quick export settings cannot be overridden.')
    const options = validateExportOptions(
      preset
        ? { ...defaultExportOptions, quality: preset.quality }
        : request.action === 'custom'
          ? request.options
          : this.store.preferences().lastCustom,
    )
    if (options.output === 'hdr' && prepared.sources.some((s) => !s.hdr)) {
      const count = prepared.sources.filter((s) => !s.hdr).length
      throw new Error(
        `${count} ${count === 1 ? 'photo does' : 'photos do'} not support HDR JPEG. Choose Auto or SDR JPEG.`,
      )
    }
    const grant = this.store.grant(request.destinationId)
    if (options.output !== 'sdr' && prepared.sources.some((source) => source.hdr))
      await verifyExportEncoder()
    await validateDirectory(grant)
    for (const source of prepared.sources) {
      const current = await lstat(source.path)
      if (!current.isFile() || current.isSymbolicLink() || !sameSource(current, source.identity))
        throw new Error('An export source changed. Open the export chooser again.')
    }
    return this.scheduler.run('interactive', () =>
      this.scheduler.mutate(async () => {
        if (
          this.closed ||
          !this.preparations.has(request.preparationId) ||
          prepared.sources.some((s) => !this.current(s))
        )
          throw new Error('Export targets or edits changed. Open the export chooser again.')
        const id = randomUUID()
        const manifest: ExportManifest = {
          version: 1,
          id,
          acceptedAt: new Date().toISOString(),
          rendering: EXPORT_RENDERING_VERSION,
          codec: EXPORT_CODEC_VERSION,
          pipeline: {
            display: DISPLAY_RENDERING_VERSION,
            hdrContent: HDR_CONTENT_VERSION,
            adjustments: ADJUSTMENT_VERSION,
            lens: LENS_RENDER_VERSION,
            sdrEncoder: 'sharp-0.35.4-baseline-444-srgb',
          },
          destinationId: grant.id,
          options,
          sources: structuredClone(prepared.sources),
        }
        const task: BackgroundTask = {
          id,
          kind: 'export',
          title: 'Exporting JPEGs',
          status: 'running',
          errorCount: 0,
          progress: { completed: 0, total: manifest.sources.length, unit: 'items' },
          export: {
            exported: 0,
            skipped: 0,
            failed: 0,
            cancelled: 0,
            destinationId: grant.id,
            destinationLabel: grant.path,
          },
        }
        await this.store.accept(manifest, task, request.action === 'custom')
        this.preparations.delete(request.preparationId)
        const job: Job = {
          manifest,
          task,
          abort: new AbortController(),
          work: Promise.resolve(),
          started: false,
        }
        for (const s of manifest.sources) this.lease(s.photo.id, 1)
        this.jobs.set(id, job)
        job.work = this.scheduler.detached(() =>
          this.tail.then(() => {
            if (job.started) return job.early
            job.started = true
            return this.run(job)
          }),
        )
        this.tail = job.work.catch(() => undefined)
        this.changed()
        return id
      }),
    )
  }
  private async persist(job: Job) {
    await this.store.task(job.task)
    this.changed()
  }
  private async cleanup(job: Job, file: ExportFile) {
    if (!file.partial) return
    if (!ownedPartialName(job.manifest.id, file.index, file.partial))
      throw new Error('Unrecognized partial preserved for review.')
    const grant = this.store.grant(job.manifest.destinationId)
    await validateDirectory(grant)
    await cleanPartial(join(grant.path, file.partial), file.identity)
  }
  private async run(job: Job) {
    const { manifest, task, abort } = job
    let activeAttempt: object | undefined
    const held = new Set(manifest.sources.map((s) => s.photo.id))
    try {
      for (const [index, source] of manifest.sources.entries()) {
        const started = performance.now()
        let retries = 0,
          admittedMs = 0,
          sourceValidationMs = 0
        const file: ExportFile = {
          index,
          photoId: source.photo.id,
          filename: source.photo.filename,
          status: 'pending',
        }
        let workingAsset: WorkingAssetLease | undefined
        try {
          abort.signal.throwIfAborted()
          task.detail = source.photo.filename
          task.phase = 'Rendering from frozen edits'
          await this.persist(job)
          const directory = join(this.root, 'export-work', manifest.id, String(index))
          const preparationDirectory = join(
            this.root,
            'export-work',
            manifest.id,
            `${index}-preparation`,
          )
          let rendered: ExportRenderResult | undefined
          do {
            const waitingStarted = performance.now()
            try {
              rendered = await this.scheduler.export(async (signal) => {
                admittedMs += performance.now() - waitingStarted
                const validationStarted = performance.now()
                await rm(directory, { recursive: true, force: true })
                await mkdir(directory, { recursive: true })
                if (!sameSource(await lstat(source.path), source.identity))
                  throw new Error('The managed export source changed.')
                if (
                  source.photo.assetKind !== 'derived' &&
                  (await hashFile(source.path)) !== source.photo.id
                )
                  throw new Error('The managed original is damaged.')
                if (source.hdr && !source.processing.metadata.mergeMaster && !workingAsset)
                  workingAsset = await this.acquireWorkingAsset?.(source, signal)
                sourceValidationMs += performance.now() - validationStarted
                const attempt = {}
                activeAttempt = attempt
                const workerProgressIdentity = {
                  exportId: manifest.id,
                  fileIndex: index,
                  attemptId: randomUUID(),
                }
                const diagnostic = (job.workerProgress ??= { counter: 0, dropped: 0, events: [] })
                diagnostic.active = {
                  fileIndex: index,
                  attemptId: workerProgressIdentity.attemptId,
                }
                const renderJob: Parameters<ExportProcess['render']>[0] = {
                  source,
                  options: manifest.options,
                  directory,
                  preparationDirectory,
                  workingAsset: workingAsset
                    ? {
                        identity: workingAsset.identity,
                        asset: workingAsset.asset,
                        backend: workingAsset.backend,
                        fallback: workingAsset.fallback,
                      }
                    : undefined,
                  hdr:
                    manifest.options.output === 'hdr' ||
                    (manifest.options.output === 'auto' && source.hdr),
                  workerProgressIdentity,
                }
                const owner = exportProgressOwner(
                  renderJob,
                  performance.timeOrigin + performance.now(),
                )!
                let previous: ExportWorkerProgress | undefined
                try {
                  return await this.renderer.render(renderJob, signal, (value) => {
                    if (
                      this.closed ||
                      signal.aborted ||
                      abort.signal.aborted ||
                      task.status !== 'running' ||
                      this.jobs.get(manifest.id) !== job ||
                      activeAttempt !== attempt
                    )
                      return
                    const accepted = acceptExportWorkerProgress(
                      value,
                      owner,
                      previous,
                      performance.timeOrigin + performance.now(),
                    )
                    if (!accepted) return
                    previous = accepted
                    diagnostic.counter++
                    if (diagnostic.events.length === 64) {
                      diagnostic.events.shift()
                      diagnostic.dropped++
                    }
                    diagnostic.events.push(accepted)
                    this.changed()
                  })
                } finally {
                  if (activeAttempt === attempt) {
                    activeAttempt = undefined
                    delete diagnostic.active
                    this.changed()
                  }
                }
              }, abort.signal)
            } catch (error) {
              if (!(error instanceof ForegroundYield)) throw error
              retries++
              task.phase = 'Waiting for foreground work'
              await this.persist(job)
            }
          } while (!rendered)
          abort.signal.throwIfAborted()
          file.diagnostics = rendered.diagnostics
          const publishStarted = performance.now()
          await this.publish(job, file, rendered)
          if (file.diagnostics) {
            file.diagnostics.retries = retries
            file.diagnostics.stages.admissionMs = admittedMs
            file.diagnostics.stages.sourceValidationMs = sourceValidationMs
            file.diagnostics.stages.publicationMs = performance.now() - publishStarted
            file.diagnostics.stages.fileMs = performance.now() - started
            await this.store.file(manifest.id, file)
            if (process.env.LUMA_EXPORT_DIAGNOSTICS)
              console.info('Export diagnostics', { photoId: source.photo.id, ...file.diagnostics })
          }
        } catch (error) {
          let published = file.status === 'exported'
          if (file.status === 'publishing' && file.outputName && file.identity && file.sha256) {
            try {
              const grant = this.store.grant(manifest.destinationId)
              await validateDirectory(grant)
              const path = join(grant.path, file.outputName)
              published =
                sameFile(await lstat(path), file.identity) && (await hashFile(path)) === file.sha256
            } catch {
              /* Keep unverifiable outputs for explicit recovery review. */
            }
          }
          file.status = published ? 'exported' : abort.signal.aborted ? 'cancelled' : 'failed'
          file.message = published
            ? `Published before interruption: ${message(error)}`
            : abort.signal.aborted
              ? 'Export cancelled before publication.'
              : message(error)
          try {
            await this.cleanup(job, file)
          } catch (error) {
            file.message += ` Partial cleanup: ${message(error)}`
          }
          await this.store.file(manifest.id, file)
        } finally {
          // render() settles only after the worker and its process tree have exited.
          workingAsset?.release()
          this.lease(source.photo.id, -1)
          held.delete(source.photo.id)
          await rm(join(this.root, 'export-work', manifest.id, String(index)), {
            recursive: true,
            force: true,
          }).catch(() => {})
          await rm(join(this.root, 'export-work', manifest.id, `${index}-preparation`), {
            recursive: true,
            force: true,
          }).catch(() => {})
        }
        task.export![file.status as 'exported' | 'skipped' | 'failed' | 'cancelled']++
        task.progress!.completed++
        task.errorCount = task.export!.failed
        await this.persist(job)
      }
      task.status = abort.signal.aborted
        ? 'cancelled'
        : task.export!.failed
          ? 'failed'
          : 'completed'
    } catch (error) {
      task.status = 'failed'
      task.detail = message(error)
    } finally {
      for (const id of held) this.lease(id, -1)
      task.title =
        task.status === 'cancelled'
          ? 'Export cancelled'
          : task.status === 'failed'
            ? 'Export finished with errors'
            : 'Export complete'
      task.phase = undefined
      task.finishedAt = Date.now()
      await this.persist(job)
    }
  }
  private async publish(job: Job, file: ExportFile, rendered: { path: string; sha256: string }) {
    const grant = this.store.grant(job.manifest.destinationId)
    await validateDirectory(grant)
    file.partial = `.luma-export-${job.manifest.id}-${file.index}-${randomUUID()}.partial`
    const partial = join(grant.path, file.partial)
    const handle = await open(partial, 'wx', 0o600)
    try {
      file.identity = identity(await handle.stat())
      file.status = 'writing'
      await this.store.file(job.manifest.id, file)
      await this.boundary('partial')
      for await (const chunk of createReadStream(rendered.path)) {
        job.abort.signal.throwIfAborted()
        await handle.writeFile(chunk)
      }
      await handle.sync()
      file.identity = identity(await handle.stat())
      file.sha256 = await hashFile(partial)
      if (file.sha256 !== rendered.sha256)
        throw new Error('Export validation failed before publication.')
      await this.store.file(job.manifest.id, file)
      await this.boundary('ready')
    } finally {
      await handle.close()
    }
    job.abort.signal.throwIfAborted()
    await this.scheduler.mutate(async () => {
      await validateDirectory(grant)
      const name = exportFilename(file.filename, job.manifest.options.names, file.index)
      for (let collision = 0; collision < 100000; collision++) {
        file.outputName = collision ? name.replace(/\.jpg$/, ` (${collision + 1}).jpg`) : name
        file.status = 'publishing'
        await this.store.file(job.manifest.id, file)
        await this.boundary('publishing')
        const owned = await lstat(partial)
        if (
          !owned.isFile() ||
          owned.isSymbolicLink() ||
          !sameFile(owned, file.identity!) ||
          (await hashFile(partial)) !== file.sha256
        )
          throw new Error('The owned export partial changed before publication.')
        try {
          await link(partial, join(grant.path, file.outputName))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw new Error(`Cannot publish JPEG safely: ${message(error)}`, { cause: error })
          if (job.manifest.options.existing === 'skip') {
            file.status = 'skipped'
            file.message = 'A file with this name already exists.'
            break
          }
          continue
        }
        await this.boundary('published')
        const publishedPath = join(grant.path, file.outputName)
        if (
          !sameFile(await lstat(publishedPath), file.identity!) ||
          (await hashFile(publishedPath)) !== file.sha256
        )
          throw new Error('The published JPEG could not be verified.')
        await syncDirectory(grant.path)
        file.status = 'exported'
        await this.store.file(job.manifest.id, file)
        await this.boundary('recorded')
        break
      }
      if (file.status === 'publishing') throw new Error('Too many filename collisions.')
      await this.store.file(job.manifest.id, file)
      await this.cleanup(job, file)
    }, job.abort.signal)
  }
  async recover() {
    for (const { manifest, task } of this.store.jobs()) {
      const job: Job = {
        manifest,
        task,
        abort: new AbortController(),
        work: Promise.resolve(),
        started: false,
      }
      this.jobs.set(task.id, job)
      if (!active(task)) continue
      let folder: string | undefined
      try {
        folder = await validateDirectory(this.store.grant(manifest.destinationId))
      } catch {
        /* Preserve results when the destination is unavailable. */
      }
      const counts = { exported: 0, skipped: 0, failed: 0, cancelled: 0 }
      for (const file of this.store.files(task.id)) {
        if (
          file.status === 'publishing' &&
          folder &&
          file.outputName &&
          file.identity &&
          file.sha256
        ) {
          try {
            const path = join(folder, file.outputName)
            const info = await lstat(path)
            if (
              info.isFile() &&
              !info.isSymbolicLink() &&
              sameFile(info, file.identity) &&
              (await hashFile(path)) === file.sha256
            )
              file.status = 'exported'
          } catch {
            /* Never alter a destination file during recovery. */
          }
        }
        if (['pending', 'writing', 'publishing'].includes(file.status)) {
          file.status = 'failed'
          file.message = 'Interrupted by application exit; encoding was not resumed.'
        }
        if (folder && file.partial && ownedPartialName(manifest.id, file.index, file.partial)) {
          try {
            await cleanPartial(join(folder, file.partial), file.identity)
          } catch (error) {
            file.message = `Partial cleanup failed: ${message(error)}`
          }
        }
        counts[file.status as keyof typeof counts]++
        await this.store.file(task.id, file)
      }
      task.export = { ...task.export!, ...counts }
      task.errorCount = counts.failed
      task.progress = {
        completed: manifest.sources.length,
        total: manifest.sources.length,
        unit: 'items',
      }
      task.status = 'failed'
      task.title = 'Export interrupted'
      task.phase = undefined
      task.finishedAt = Date.now()
      await this.store.task(task)
    }
    await rm(join(this.root, 'export-work'), { recursive: true, force: true })
  }
  results(id: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !this.jobs.has(id))
      throw new Error('Invalid export results request.')
    const { files, total } = this.store.filePage(id, offset, COLLECTION_CHUNK_SIZE)
    return {
      results: files.map(({ index, photoId, filename, outputName, status, message }) => ({
        index,
        photoId,
        filename,
        outputName,
        status,
        message,
      })),
      total,
    }
  }
  errors(id: string, offset = 0): TaskErrorPage {
    const { files, total } = this.store.filePage(id, offset, COLLECTION_CHUNK_SIZE, true)
    return {
      errors: files.map((f) => ({ filename: f.filename, message: f.message ?? 'Export failed.' })),
      total,
    }
  }
  async cancel(id: string) {
    const job = this.jobs.get(id)
    if (!job || !active(job.task)) return
    job.task.status = 'cancelling'
    job.task.title = 'Cancelling export…'
    job.abort.abort()
    // Capture the cancelling state before an early run can advance it. Persistence
    // and cleanup are both owned, so either rejection must still join the other.
    const persistence = this.persist(job)
    if (!job.started) {
      job.started = true
      job.early = this.scheduler.detached(() => this.run(job))
    }
    const settled = await Promise.allSettled([persistence, job.early ?? job.work])
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length)
      throw new AggregateError(failures, 'Export cancellation could not save its final state.')
  }
  async dismiss(id: string) {
    const job = this.jobs.get(id)
    if (job && active(job.task)) throw new Error('Cancel the export before dismissing it.')
    await this.store.dismiss(id)
    this.jobs.delete(id)
    this.changed()
  }
  async destination(id: string) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('This export has been dismissed.')
    return validateDirectory(this.store.grant(job.manifest.destinationId))
  }
  async close() {
    this.closed = true
    this.preparations.clear()
    for (const job of this.jobs.values()) if (active(job.task)) job.abort.abort()
    await this.tail
  }
}
