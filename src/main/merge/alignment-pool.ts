import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  MergeError,
  type MergeFailure,
  type MergeTransform,
  type MergeMeasurements,
  type MergeReadMeasurements,
} from '../../shared/merge'
import type { PreparedSource } from './prepare'
import type { registerNative } from './registration'

type LaneResult = Awaited<ReturnType<typeof registerNative>> & {
  readBytes: number
  runtimeMs: number
  queuedMs: number
  timeline: { submittedMs: number; admittedMs: number; completedMs: number }
  reads: MergeReadMeasurements
  patches?: MergeMeasurements['attempts'][number]['patches']
}
type Result = LaneResult & { lane: number }
/** A sequential lane owns immutable descriptors and native planes. */
class AlignmentLane {
  private worker: Worker
  private tail: Promise<unknown> = Promise.resolve()
  private sequence = 0
  private pending?: {
    resolve: (value: LaneResult) => void
    reject: (error: unknown) => void
    queuedMs: number
    timeline: LaneResult['timeline']
  }
  private sent = new Set<string>()
  private closed = false
  heapBytes = 0
  constructor(private clockOrigin: number) {
    const path = existsSync(join(import.meta.dirname, 'alignment-worker.js'))
      ? join(import.meta.dirname, 'alignment-worker.js')
      : resolve('out/main/alignment-worker.js')
    this.worker = new Worker(path)
    this.worker.on(
      'message',
      (m: {
        result?: Omit<LaneResult, 'readBytes' | 'queuedMs' | 'reads' | 'timeline'>
        error?: MergeFailure
        readBytes: number
        reads: MergeReadMeasurements
        timings?: Result['timings']
        wasmBytes: number
        runtimeMs?: number
        patches?: Result['patches']
      }) => {
        this.heapBytes = Math.max(this.heapBytes, m.wasmBytes)
        const pending = this.pending
        this.pending = undefined
        if (pending) pending.timeline.completedMs = performance.now() - this.clockOrigin
        if (m.result && pending)
          pending.resolve({
            ...m.result,
            readBytes: m.readBytes,
            reads: m.reads,
            queuedMs: pending.queuedMs,
            timeline: pending.timeline,
          })
        else
          pending?.reject(
            Object.assign(new MergeError(m.error!), {
              timings: m.timings,
              readBytes: m.readBytes,
              runtimeMs: m.runtimeMs,
              patches: m.patches,
              reads: m.reads,
              queuedMs: pending?.queuedMs,
              timeline: pending?.timeline,
            }),
          )
      },
    )
    this.worker.on('error', (error) => this.pending?.reject(error))
    this.worker.on('exit', (code) => {
      this.closed = true
      if (this.pending) this.pending.reject(new Error(`Alignment worker stopped (${code}).`))
      this.pending = undefined
    })
  }
  pause(value: boolean) {
    if (!this.closed) this.worker.postMessage({ pause: value })
  }
  run(
    reference: [string, PreparedSource],
    neighbor: [string, PreparedSource],
    source: [string, PreparedSource],
    transform: MergeTransform,
  ): Promise<LaneResult> {
    const queued = performance.now()
    const result = this.tail
      .catch(() => {})
      .then(
        () =>
          new Promise<LaneResult>((resolve, reject) => {
            if (this.closed) {
              reject(new Error('Alignment cancelled.'))
              return
            }
            const sources: [string, PreparedSource][] = []
            for (const entry of [reference, neighbor, source])
              if (!this.sent.has(entry[0])) {
                this.sent.add(entry[0])
                sources.push(entry)
              }
            const admitted = performance.now()
            this.pending = {
              resolve,
              reject,
              queuedMs: admitted - queued,
              timeline: {
                submittedMs: queued - this.clockOrigin,
                admittedMs: admitted - this.clockOrigin,
                completedMs: 0,
              },
            }
            this.worker.postMessage({
              id: ++this.sequence,
              referenceId: reference[0],
              neighborId: neighbor[0],
              sourceId: source[0],
              sources,
              transform,
            })
          }),
      )
    this.tail = result
    return result
  }
  async close() {
    this.closed = true
    await this.worker.terminate()
    await this.tail.catch(() => {})
  }
}

/** Two lanes each have a 256 MiB WASM cap, preserving the combined 512 MiB bound. */
export class AlignmentPool {
  private lanes: AlignmentLane[]
  constructor(clockOrigin = performance.now()) {
    this.lanes = [new AlignmentLane(clockOrigin), new AlignmentLane(clockOrigin)]
  }
  private queued = [0, 0]
  private closed = false
  get wasmBytes() {
    return this.lanes.reduce((sum, lane) => sum + lane.heapBytes, 0)
  }
  pause(value: boolean) {
    for (const lane of this.lanes) lane.pause(value)
  }
  async run(
    reference: [string, PreparedSource],
    neighbor: [string, PreparedSource],
    source: [string, PreparedSource],
    transform: MergeTransform,
  ): Promise<Result> {
    if (this.closed) throw new Error('Alignment cancelled.')
    const index = this.queued[0] <= this.queued[1] ? 0 : 1
    this.queued[index]++
    try {
      return {
        ...(await this.lanes[index].run(reference, neighbor, source, transform)),
        lane: index,
      }
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { lane: index })
      throw error
    } finally {
      this.queued[index]--
    }
  }
  async close() {
    this.closed = true
    await Promise.all(this.lanes.map((lane) => lane.close()))
  }
}
