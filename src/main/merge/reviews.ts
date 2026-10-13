import { randomUUID } from 'node:crypto'
import { mkdir, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { MergeProcess } from './process'
import type { WorkScheduler } from '../work-scheduler'
import type { MergeResult } from './engine'
import {
  exposure,
  mergeFailure,
  type MergeFailure,
  type MergeDiagnostics,
  validateMergeSettings,
  validateMergeSources,
  mergeUnavailable,
  type MergeMode,
  type MergeReview,
  type MergeSettings,
  type MergeSource,
  type MergePreview,
} from '../../shared/merge'

interface ReviewState {
  review: MergeReview
  paths: string[]
  directory: string
  abort: AbortController
  work?: Promise<MergeResult>
  result?: MergeResult
  output?: string
  failure?: MergeFailure
  accepted: boolean
  updating?: boolean
  closing?: boolean
}
export class MergeReviews {
  private state?: ReviewState
  private creating?: string[]
  private creatingWork?: Promise<MergeReview>
  private createAbort?: AbortController
  private closing = false
  readonly worker: MergeProcess
  constructor(
    private root: string,
    private source: (
      id: string,
      signal: AbortSignal,
    ) => Promise<{ source: MergeSource; path: string }>,
    workerPath?: string,
    private scheduler?: WorkScheduler,
    private onAvailabilityChange: () => void = () => {},
  ) {
    this.worker = new MergeProcess(workerPath)
  }
  leased(ids: string[]) {
    return ids.some(
      (id) =>
        this.creating?.includes(id) || this.state?.review.sources.some((s) => s.photo.id === id),
    )
  }
  unavailableReason(): string | undefined {
    return this.closing
      ? 'Merge reviews are closing.'
      : this.state || this.creating
        ? 'Close the current merge review first.'
        : undefined
  }
  active(): MergeReview | null {
    return this.state ? structuredClone(this.state.review) : null
  }
  diagnostics(id: string, revision: number): MergeDiagnostics {
    const s = this.get(id, revision)
    return structuredClone({
      reviewId: id,
      revision,
      status: s.failure ? 'failed' : s.result ? 'ready' : 'pending',
      sources: s.review.sources.map((source) => ({
        id: source.photo.id,
        filename: source.photo.filename,
        diagnostics: s.result?.recipe.sources.find((v) => v.id === source.photo.id)?.transform
          .diagnostics,
      })),
      error: s.failure,
      measurements: s.result?.recipe.measurements,
    })
  }
  async create(ids: string[], mode: MergeMode): Promise<MergeReview> {
    const blocked = this.unavailableReason()
    if (blocked) throw new Error(blocked)
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      !['hdr', 'noise'].includes(mode)
    )
      throw new Error('Invalid merge sources.')
    const unavailable = mergeUnavailable(ids.length)
    if (unavailable) throw new Error(unavailable)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate merge sources.')
    this.creating = [...ids]
    this.onAvailabilityChange()
    const abort = (this.createAbort = new AbortController())
    try {
      const work = this.foreground(async () => {
        const inputs = []
        for (const id of ids) {
          abort.signal.throwIfAborted()
          await this.scheduler?.checkpoint(abort.signal)
          inputs.push(await this.source(id, abort.signal))
        }
        abort.signal.throwIfAborted()
        const sources = structuredClone(inputs.map((i) => i.source))
        validateMergeSources(sources, mode)
        const sorted = [...sources].sort(
          mode === 'hdr'
            ? (a, b) => exposure(a.capture) - exposure(b.capture)
            : (a, b) =>
                (a.photo.capturedAt ?? a.photo.filename).localeCompare(
                  b.photo.capturedAt ?? b.photo.filename,
                ),
        )
        const reference = sorted[Math.floor(sorted.length / 2)]
        for (const s of sources)
          s.relativeEv = Math.log2(exposure(s.capture) / exposure(reference.capture))
        const scratchBytes = Math.ceil(
          sources[0].photo.width * sources[0].photo.height * (sources.length * 20 + 112) +
            (sources.length * 32 + 256) * 1024 ** 2,
        )
        const disk = await statfs(this.root)
        if (disk.bavail * disk.bsize < scratchBytes)
          throw new Error(
            `Insufficient temporary disk space: ${Math.ceil(scratchBytes / 1024 ** 3)} GiB required.`,
          )
        const id = randomUUID(),
          directory = join(this.root, 'merge-reviews', id)
        await mkdir(directory, { recursive: true })
        const review: MergeReview = {
          id,
          revision: 0,
          sources,
          scratchBytes,
          settings: {
            mode,
            autoAlign: true,
            deghost: true,
            strength: 50,
            autoCrop: true,
            referenceId: reference.photo.id,
          },
        }
        this.state = {
          review,
          paths: inputs.map((i) => i.path),
          directory,
          abort: new AbortController(),
          accepted: false,
        }
        return structuredClone(review)
      }, abort.signal)
      this.creatingWork = work
      return await work
    } finally {
      this.creating = undefined
      this.creatingWork = undefined
      this.createAbort = undefined
      this.onAvailabilityChange()
    }
  }
  private foreground<T>(work: () => Promise<T>, signal?: AbortSignal) {
    return this.scheduler ? this.scheduler.run('operation', work, signal) : work()
  }
  private get(id: string, revision?: number, transition = false) {
    const s = this.state
    if (!s || s.review.id !== id) throw new Error('Merge review is unavailable.')
    if (!transition && (s.updating || s.closing))
      throw new Error('Merge review is updating or closing.')
    if (
      revision !== undefined &&
      (!Number.isSafeInteger(revision) || revision !== s.review.revision)
    )
      throw new Error('Stale merge review. Refresh the review before proceeding.')
    return s
  }
  async update(id: string, revision: number, settings: MergeSettings) {
    const s = this.get(id, revision)
    if (s.accepted) throw new Error('This merge was already accepted.')
    validateMergeSettings(
      settings,
      s.review.sources.map((s) => s.photo.id),
    )
    validateMergeSources(s.review.sources, settings.mode)
    const previousReference = s.review.settings.referenceId
    // Advance synchronously before awaiting cancellation so concurrent callers conflict.
    try {
      s.updating = true
      s.review = { ...s.review, revision: revision + 1, settings: structuredClone(settings) }
      s.abort.abort()
      await s.work?.catch(() => {})
      if (this.state !== s || s.closing) throw new Error('Merge review is unavailable.')
      await this.foreground(async () => {
        await rm(join(s.directory, `revision-${revision}`), { recursive: true, force: true })
        if (previousReference !== settings.referenceId)
          await rm(join(s.directory, 'prepared'), { recursive: true, force: true })
      })
      s.work = undefined
      s.result = undefined
      s.failure = undefined
      s.output = undefined
      s.abort = new AbortController()
      s.updating = false
    } finally {
      s.updating = false
    }
    return structuredClone(s.review)
  }
  async preview(id: string, revision: number): Promise<MergePreview> {
    const s = this.get(id, revision)
    if (s.accepted) throw new Error('This merge was already accepted.')
    if (!s.work) {
      const directory = join(s.directory, 'prepared'),
        output = join(s.directory, `revision-${revision}`)
      s.output = output
      s.work = this.foreground(async () => {
        await mkdir(directory, { recursive: true })
        this.get(id, revision)
        return this.worker.run(
          {
            comparisons: true,
            directory,
            output,
            paths: s.paths,
            sources: s.review.sources,
            settings: s.review.settings,
          },
          s.abort.signal,
          () => {},
        )
      }, s.abort.signal)
    }
    let result: MergeResult
    try {
      result = await s.work
      this.get(id, revision)
      if (
        result.recipe.resolution !== 'native' ||
        result.asset.width !== result.recipe.crop.width ||
        result.asset.height !== result.recipe.crop.height
      )
        throw new Error('Invalid native merge preview.')
      s.result = result
    } catch (error) {
      if (this.state === s && s.review.revision === revision) s.failure = mergeFailure(error)
      throw error
    }
    const url = `luma-photo://merge/${id}/${revision}`
    return {
      reviewId: id,
      revision,
      resultUrl: `${url}/result`,
      referenceUrl: `${url}/reference`,
      overlayUrl: `${url}/overlay`,
      width: result.asset.width,
      height: result.asset.height,
      recipe: result.recipe,
    }
  }
  accept(id: string, revision: number) {
    const s = this.get(id, revision)
    if (s.accepted || s.failure || !s.result || !s.output)
      throw new Error('Wait for the current merge preview before accepting.')
    s.accepted = true
    return {
      render: async (signal: AbortSignal) => {
        signal.throwIfAborted()
        return { result: s.result!, output: s.output! }
      },
      review: structuredClone(s.review),
    }
  }
  async dispose(id: string, finished = false) {
    const s = this.get(id, undefined, true)
    if (s.accepted && !finished) throw new Error('Cancel the background merge task first.')
    s.closing = true
    s.abort.abort()
    await s.work?.catch(() => {})
    await rm(s.directory, { recursive: true, force: true })
    if (this.state === s) this.state = undefined
    this.onAvailabilityChange()
  }
  imagePath(parts: string[]) {
    const s = this.state
    if (
      parts.length !== 3 ||
      !s ||
      parts[0] !== s.review.id ||
      parts[1] !== String(s.review.revision) ||
      !s.result ||
      !['result', 'reference', 'overlay'].includes(parts[2]) ||
      !s.output ||
      s.updating ||
      s.closing ||
      s.failure
    )
      return
    return join(s.output, `${parts[2]}.png`)
  }

  stopAdmission() {
    this.closing = true
    this.createAbort?.abort()
    if (this.state && !this.state.accepted) this.state.abort.abort()
  }
  async close() {
    this.stopAdmission()
    await this.creatingWork?.catch(() => undefined)
    if (this.state) await this.dispose(this.state.review.id, true)
  }
}
