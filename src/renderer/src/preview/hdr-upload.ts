import type { HdrWorkingAsset } from '../../../shared/hdr'
import type { HdrSourceSamples, HdrSourceUploadVerification } from './hdr-source-cache'
export interface HdrUploadedSource {
  samples: HdrSourceSamples
  verification: HdrSourceUploadVerification
}
let idleWorker: Worker | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
/** Credit-based transfer bounds validated strips, including in-flight GPU submissions. */
export async function* uploadHdr(
  asset: HdrWorkingAsset,
  signal: AbortSignal,
  verified: (source: HdrUploadedSource) => void,
) {
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
  let completed: HdrUploadedSource | undefined
  let yieldedStrips = 0,
    yieldedBytes = 0
  const abort = () => {
    worker.terminate()
    wake?.()
  }
  signal.addEventListener('abort', abort, { once: true })
  worker.onmessage = ({ data }) => {
    if (data.error) failure = new Error(data.error)
    else if (data.done) {
      done = true
      completed = {
        samples: { sourceSha256: data.sourceSha256, sample: data.sample, draft: data.draftSample },
        verification: data.verification,
      }
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
        const expected = asset.strips[yieldedStrips]
        if (
          !expected ||
          strip.row !== yieldedStrips * 64 ||
          strip.data.byteLength !== expected.byteLength
        )
          throw new Error('Incomplete or reordered HDR upload.')
        yieldedStrips++
        yieldedBytes += strip.data.byteLength
        yield strip
        worker.postMessage({ ack: true })
        continue
      }
      if (done) break
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    signal.throwIfAborted()
    const proof = completed?.verification
    if (
      !completed ||
      !proof ||
      proof.eof !== true ||
      proof.sourceSha256 !== asset.sha256 ||
      completed.samples.sourceSha256 !== asset.sha256 ||
      proof.verifiedBytes !== yieldedBytes ||
      yieldedBytes !== asset.byteLength ||
      yieldedStrips !== asset.strips.length ||
      !Array.isArray(proof.verifiedStripHashes) ||
      proof.verifiedStripHashes.length !== asset.strips.length ||
      proof.verifiedStripHashes.some((hash, index) => hash !== asset.strips[index].sha256)
    )
      throw new Error('The HDR upload did not complete source verification.')
    // Publication belongs to the current presenter after its mip fence, never to a detached uploader.
    verified(completed)
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
