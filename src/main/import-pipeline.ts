import { availableParallelism, totalmem } from 'node:os'
import { ForegroundYield, WorkScheduler } from './work-scheduler'
import type { PreviewProcessor, PreviewResult } from './preview-types'

export const IMPORT_STAGING_BYTES = 512 * 1024 ** 2
export const IMPORT_IN_FLIGHT = 4
export function preparationWorkers(memory = totalmem(), threads = availableParallelism()) {
  return memory >= 8 * 1024 ** 3 && threads >= 3 ? 2 : 1
}
export interface ImportPipelineOptions {
  workers?: number
  maxCandidates?: number
  maxBytes?: number
}
export interface StagedOriginal {
  hash: string
  path: string
  directory: string
}
export type ImportOutcome = 'imported' | 'duplicate' | 'deleted'
interface Job<T> {
  candidate: T
  staged?: StagedOriginal
  seed?: PreviewResult
  fallback: boolean
  state: 'copying' | 'waiting' | 'ready' | 'working'
  finishing?: Promise<void>
}
interface PipelineHooks<T> {
  copy(candidate: T): Promise<StagedOriginal>
  known(hash: string): 'duplicate' | 'deleted' | undefined
  prepare(
    processor: PreviewProcessor,
    staged: StagedOriginal,
    signal: AbortSignal,
    fallback: boolean,
    seed?: PreviewResult,
  ): Promise<PreviewResult>
  publish(candidate: T, staged: StagedOriginal, prepared: PreviewResult): Promise<ImportOutcome>
  clean(candidate: T, staged?: StagedOriginal): Promise<void>
  resolved(candidate: T, outcome?: ImportOutcome, error?: unknown): void | Promise<void>
  sourceStopped(error: unknown): boolean
  progress(value: {
    inFlight: number
    stagedBytes: number
    capacity: boolean
    fallback: boolean
  }): void
}

/** One copy producer, bounded originals, independent preparation lanes and hash owners. */
export async function runImportPipeline<T extends { bytes: number }>(
  candidates: T[],
  processors: PreviewProcessor[],
  scheduler: WorkScheduler,
  signal: AbortSignal,
  hooks: PipelineHooks<T>,
  options: ImportPipelineOptions = {},
): Promise<number> {
  const abort = new AbortController()
  signal = AbortSignal.any([signal, abort.signal])
  const limit = options.maxCandidates ?? IMPORT_IN_FLIGHT
  const budget = options.maxBytes ?? IMPORT_STAGING_BYTES
  const jobs = new Set<Job<T>>()
  const reservations = new Map<string, Job<T>[]>()
  const published = new Set<string>()
  const ready: Job<T>[] = []
  const waiters = new Set<() => void>()
  let bytes = 0,
    producerDone = false,
    fallbackBusy = false,
    capacity = false,
    unprocessed = 0
  const pulse = () => {
    hooks.progress({ inFlight: jobs.size, stagedBytes: bytes, capacity, fallback: fallbackBusy })
    for (const wake of [...waiters]) wake()
  }
  const wait = async (predicate: () => boolean) => {
    signal.throwIfAborted()
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        waiters.delete(check)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        clean()
        reject(signal.reason)
      }
      const check = () => {
        if (predicate()) {
          clean()
          resolve()
        }
      }
      waiters.add(check)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else check()
    })
  }
  const enqueue = (job: Job<T>) => {
    job.state = 'ready'
    ready.push(job)
    pulse()
  }
  const finish = (job: Job<T>, outcome?: ImportOutcome, error?: unknown): Promise<void> => {
    if (job.finishing) return job.finishing
    // Assign ownership before any cleanup/notification can suspend or reject.
    job.finishing = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      const failed = (reason: unknown) => {
        failures.push(reason)
        if (!abort.signal.aborted) abort.abort(reason)
      }
      const duplicates: Promise<void>[] = []
      try {
        const hash = job.staged?.hash
        const owners = hash ? reservations.get(hash) : undefined
        if (owners?.[0] === job) {
          owners.shift()
          if (outcome) {
            if (outcome === 'imported') published.add(hash!)
            reservations.delete(hash!)
            for (const duplicate of owners)
              duplicates.push(
                finish(duplicate, hooks.known(hash!) === 'deleted' ? 'deleted' : 'duplicate').catch(
                  failed,
                ),
              )
          } else if (owners.length) enqueue(owners[0])
          else reservations.delete(hash!)
        }
      } catch (reason) {
        failed(reason)
      }
      try {
        await hooks.clean(job.candidate, job.staged)
      } catch (reason) {
        failed(reason)
      } finally {
        if (jobs.delete(job)) bytes -= job.candidate.bytes
        try {
          // Publication has already completed. Its outcome is never replaced by
          // a notification error or delivered a second time through a lane catch.
          await hooks.resolved(job.candidate, outcome, error)
        } catch (reason) {
          failed(reason)
        } finally {
          pulse()
        }
      }
      await Promise.all(duplicates)
      if (failures.length === 1) throw failures[0]
      if (failures.length)
        throw new AggregateError(failures, 'Import completion could not be confirmed.')
    })
    return job.finishing
  }
  const producer = (async () => {
    try {
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]
        const room = () =>
          jobs.size < limit && (bytes + candidate.bytes <= budget || jobs.size === 0)
        capacity = !room()
        pulse()
        await wait(room)
        capacity = false
        await scheduler.preparationCheckpoint(signal)
        signal.throwIfAborted()
        const job: Job<T> = { candidate, fallback: false, state: 'copying' }
        jobs.add(job)
        bytes += candidate.bytes // Reserve the whole original before copying its first chunk.
        pulse()
        try {
          job.staged = await hooks.copy(candidate)
          signal.throwIfAborted()
          const known = hooks.known(job.staged.hash)
          if (known || published.has(job.staged.hash)) await finish(job, known ?? 'duplicate')
          else {
            const owners = reservations.get(job.staged.hash)
            if (owners) {
              owners.push(job)
              job.state = 'waiting'
            } else {
              reservations.set(job.staged.hash, [job])
              enqueue(job)
            }
          }
        } catch (error) {
          if (signal.aborted) throw error
          const stopped = hooks.sourceStopped(error)
          await finish(job, undefined, error)
          if (stopped) {
            unprocessed = candidates.length - index - 1
            break
          }
        }
      }
    } finally {
      producerDone = true
      capacity = false
      pulse()
    }
  })()
  const worker = async (processor: PreviewProcessor) => {
    while (!producerDone || jobs.size) {
      await wait(
        () => ready.some((j) => !j.fallback || !fallbackBusy) || (producerDone && !jobs.size),
      )
      signal.throwIfAborted()
      if (producerDone && !jobs.size) return
      let index = ready.findIndex((j) => !j.fallback)
      if (index < 0 && !fallbackBusy) index = ready.findIndex((j) => j.fallback)
      if (index < 0) continue
      const job = ready.splice(index, 1)[0]
      job.state = 'working'
      const fallback = job.fallback
      if (fallback) fallbackBusy = true
      pulse()
      try {
        const prepared = await scheduler.background(
          (abort) => hooks.prepare(processor, job.staged!, abort, job.fallback, job.seed),
          signal,
          job.fallback,
        )
        if (prepared.needsFallback) {
          job.seed = prepared
          job.fallback = true
          enqueue(job)
        } else {
          signal.throwIfAborted()
          await finish(job, await hooks.publish(job.candidate, job.staged!, prepared))
        }
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof ForegroundYield) enqueue(job)
        else await finish(job, undefined, error)
      } finally {
        if (fallback) fallbackBusy = false
        pulse()
      }
    }
  }
  const work = [producer, ...processors.map(worker)].map((work) =>
    work.catch((error) => {
      abort.abort(error)
      throw error
    }),
  )
  // All lanes settle before staging cleanup, including forced native worker termination.
  const results = await Promise.allSettled(work)
  const cleanup = await Promise.allSettled(
    [...jobs].map(async (job) => {
      try {
        await hooks.clean(job.candidate, job.staged)
      } finally {
        if (jobs.delete(job)) bytes -= job.candidate.bytes
        pulse()
      }
    }),
  )
  const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
  if (failure) throw failure.reason
  const cleanupFailure = cleanup.find((result) => result.status === 'rejected') as
    PromiseRejectedResult | undefined
  if (cleanupFailure) throw cleanupFailure.reason
  return unprocessed
}
