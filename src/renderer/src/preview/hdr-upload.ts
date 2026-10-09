import type { HdrWorkingAsset } from '../../../shared/hdr'
import { publishHdrSample } from './hdr-sample'
let idleWorker: Worker | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
/** Credit-based transfer bounds validated strips, including in-flight GPU submissions. */
export async function* uploadHdr(asset: HdrWorkingAsset, signal: AbortSignal) {
  const worker =
    idleWorker ?? new Worker(new URL('./hdr-upload-worker.ts', import.meta.url), { type: 'module' })
  idleWorker = undefined
  clearTimeout(idleTimer)
  let complete = false
  const queue: { data: Float32Array<ArrayBuffer>; row: number; timings: Record<string, number> }[] =
    []
  let wake: (() => void) | undefined,
    done = false,
    failure: Error | undefined
  let sample: Float32Array | undefined
  let draftSample: Float32Array | undefined
  const abort = () => {
    worker.terminate()
    wake?.()
  }
  signal.addEventListener('abort', abort, { once: true })
  worker.onmessage = ({ data }) => {
    if (data.error) failure = new Error(data.error)
    else if (data.done) {
      done = true
      sample = data.sample
      draftSample = data.draftSample
    } else queue.push(data)
    wake?.()
  }
  worker.onerror = (event) => {
    failure = new Error(event.message)
    wake?.()
  }
  worker.postMessage({ asset })
  try {
    for (;;) {
      signal.throwIfAborted()
      if (failure) throw failure
      const strip = queue.shift()
      if (strip) {
        yield strip
        worker.postMessage({ ack: true })
        continue
      }
      if (done) break
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    if (sample && draftSample) publishHdrSample(asset.sha256, sample, draftSample)
    complete = true
  } finally {
    if (complete && !signal.aborted && !idleWorker) {
      // Retain compiled validation code, never an in-flight request or source buffer.
      worker.onmessage = null
      worker.onerror = null
      idleWorker = worker
      idleTimer = setTimeout(() => {
        if (idleWorker === worker) {
          worker.terminate()
          idleWorker = undefined
        }
      }, 30000)
    } else worker.terminate()
    signal.removeEventListener('abort', abort)
  }
}
