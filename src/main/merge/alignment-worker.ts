import { parentPort } from 'node:worker_threads'
import { registerNative } from './registration'
import { mergeFailure, type MergeTransform } from '../../shared/merge'
import type { PreparedSource } from './prepare'
import { mergeReadBytes, resetMergeReads } from './sampling'
import { openCv } from './opencv'
import { mergeReadMeasurements } from './read-metrics'

const sources = new Map<string, PreparedSource>()
let paused = false
parentPort!.on(
  'message',
  (message: {
    pause?: boolean
    id?: number
    referenceId: string
    neighborId: string
    sourceId: string
    sources: [string, PreparedSource][]
    transform: MergeTransform
  }) => {
    if (message.pause !== undefined) {
      paused = message.pause
      return
    }
    for (const [id, source] of message.sources) if (!sources.has(id)) sources.set(id, source)
    resetMergeReads()
    const start = performance.now()
    const checkpoint = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      while (paused) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const register = async () => {
      const cv = await openCv()
      cv.patchStats(true)
      return registerNative(
        sources.get(message.referenceId)!,
        sources.get(message.neighborId)!,
        sources.get(message.sourceId)!,
        message.transform,
        checkpoint,
      )
    }
    void register().then(
      async (result) =>
        parentPort!.postMessage({
          id: message.id,
          result: {
            ...result,
            runtimeMs: performance.now() - start,
            patches: (await openCv()).patchStats(),
          },
          readBytes: mergeReadBytes(),
          reads: mergeReadMeasurements(),
          wasmBytes: (await openCv()).memory(),
        }),
      async (error) =>
        parentPort!.postMessage({
          id: message.id,
          error: mergeFailure(error),
          readBytes: mergeReadBytes(),
          reads: mergeReadMeasurements(),
          timings: error.timings,
          runtimeMs: performance.now() - start,
          patches: (await openCv().catch(() => undefined))?.patchStats(),
          wasmBytes: (await openCv().catch(() => undefined))?.memory() ?? 0,
        }),
    )
  },
)
