import type { PhotoStatistics } from '../shared/statistics'
import type { HdrPhotoStatistics, HdrAnalysisDomain } from '../shared/hdr-statistics'
import type { HdrPhotoPixel } from '../shared/hdr-pixel'
import {
  validateHdrSource,
  HDR_SOURCE_VERSION,
  HDR_RAW_SOURCE_VERSION,
  HDR_ADJUSTMENT_VERSION,
  HDR_OUTPUT_VERSION,
  type DisplayTarget,
} from '../shared/hdr'
import { ADJUSTMENT_VERSION, neutralAdjustments } from '../shared/adjustments'
import type { ProcessingOptions } from '../shared/lens'
import { CROP_POLICY, LENS_RENDER_VERSION } from './processing/lens-correction'
import { rawDecoderDefinitions } from './processing/formats'
import { cameraProfiles } from './processing/cameras'
import { frameByteLength } from '../shared/preview-frame'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import type { FullPreview, HdrPreview, DisplayPreview } from '../shared/contracts'
import type { FullPreviewProcessor, FullPreviewResult, HdrStatisticsJob } from './preview-types'

// Cache layout version. Source and output identities separately invalidate pixel variants.
export const PREVIEW_VERSION = 'v9'
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
}

/** One foreground consumer, with serialized disk changes and independent stream leases. */
export class FullPreviews {
  private diagnostics: import('../shared/preview-diagnostics').PreviewDiagnostics = {
    loadingStage: 'idle',
    timings: {},
  }
  getDiagnostics() {
    return { ...this.diagnostics }
  }
  private entries = new Map<string, Entry>()
  private background = new Set<Request>()
  private analyses = new Map<AbortController, string>()
  private active?: Request
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
  ) {
    this.directory = join(root, PREVIEW_VERSION)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => undefined)
    return result
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
          metadata.bytes !== file.size + placeholder.size + (metadata.linear?.byteLength ?? 0)
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
        this.entries.set(folder.name, {
          diagnostics: metadata.diagnostics,
          statistics: metadata.statistics,
          sourceKey: metadata.sourceKey,
          linear: metadata.linear,
          adjustments: metadata.adjustments,
          variant: metadata.variant ?? 'uncorrected',
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
          bytes: file.size + placeholder.size + (metadata.linear?.byteLength ?? 0),
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
  async requestHdr(id: string, token: string, regenerate = false): Promise<HdrPreview | null> {
    const preview = await this.prepare(id, token, regenerate, false, true, false, true)
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
    const work = this.enqueue(async () => {
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
        if (options) {
          options.prepareLinear = prepareLinear
          options.workingOnly = workingOnly
        }
        check()
        const sourceKey = options
          ? createHash('sha256')
              .update(
                JSON.stringify([
                  id,
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
                ]),
              )
              .digest('hex')
          : undefined
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
            const dimensions = await this.processor.renderFull(
              this.original(id)!,
              temporary,
              request.abort.signal,
              options,
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
            await writeFile(
              join(temporary, 'entry.json'),
              JSON.stringify({
                ...dimensions,
                sourceKey,
                variant,
                bytes: file.size + placeholder.size + (dimensions.linear?.byteLength ?? 0),
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
              bytes: file.size + placeholder.size + (dimensions.linear?.byteLength ?? 0),
              usedAt: Date.now(),
              pins: 0,
              invalid: false,
            }
            this.entries.set(`${id}-${revision}`, entry)
            published = true
          } finally {
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
          ? `${entry.linear!.hdr?.source.highlightBlend ? HDR_RAW_SOURCE_VERSION : HDR_SOURCE_VERSION}-${entry.linear!.sha256}`
          : entry.renderId
        if (!background)
          this.diagnostics = {
            photoId: id,
            revision: options?.revision ?? 0,
            renderingIdentity: renderId,
            preparationBackend: entry.diagnostics?.backend,
            cacheHit,
            loadingStage: 'prepared',
            timings: { ...entry.diagnostics?.timings, preparationMs: performance.now() - started },
          }
        return {
          adjustments: options?.adjustments ?? entry.adjustments,
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
    })
    request.work = work
    return work
  }

  async statistics(id: string, expectedRevision: number): Promise<PhotoStatistics> {
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

  private async hdrAnalysis<T>(
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

  private detach(releaseFrame = true): void {
    if (!this.active) return
    this.active.abort.abort(new Error('Preview request cancelled.'))
    if (this.active.entry) this.active.entry.pins--
    if (this.active.linearEntry) this.active.linearEntry.pins--
    this.active = undefined
    if (releaseFrame) this.processor.releaseFrame?.()
  }

  async release(token?: string): Promise<void> {
    if (token !== undefined && this.active?.token !== token) return
    this.detach(token === undefined)
    await this.enqueue(() => this.prune())
  }

  /** Acquire synchronously before opening the stream, so eviction cannot remove its file. */
  acquire(
    url: URL,
  ): { path: string; contentType: string; byteLength: number; release: () => void } | undefined {
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
      (kind !== 'full' && kind !== 'placeholder' && kind !== 'linear') ||
      version !== PREVIEW_VERSION ||
      !hashPattern.test(id) ||
      !tokenPattern.test(revision) ||
      this.blocked.has(id) ||
      !this.original(id)
    )
      return
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
    for (const [job, photo] of this.analyses)
      if (photo === id) job.abort(new Error('Photo removed.'))
    for (const job of this.background)
      if (job.id === id) job.abort.abort(new Error('Photo removed.'))
    if (this.active?.id === id) this.detach()
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
    for (const job of this.background) job.abort.abort(new Error('Preview closed.'))
    this.detach()
    await this.tail
    await this.processor.close()
    await this.prune()
  }
}
