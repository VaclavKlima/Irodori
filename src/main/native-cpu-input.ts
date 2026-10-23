import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import type { HdrWorkingAsset } from '../shared/hdr'
import { collectHdrSample } from '../shared/hdr-source-sample'

function writeOwned(target: Writable, bytes: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const clean = () => {
      signal.removeEventListener('abort', abort)
      target.removeListener('error', failed)
      target.removeListener('close', closed)
    }
    const failed = (error: unknown) => {
      clean()
      reject(error)
    }
    const abort = () => failed(signal.reason)
    const closed = () =>
      failed(new Error('Native CPU stdin closed before consuming its input strip.'))
    signal.addEventListener('abort', abort, { once: true })
    target.once('error', failed)
    target.once('close', closed)
    // Wait for the callback even when write() returns true. The caller cannot
    // reuse this one credited strip until Node has consumed its borrowed bytes.
    try {
      target.write(bytes, (error) => {
        clean()
        if (error) reject(error)
        else resolve()
      })
    } catch (error) {
      failed(error)
    }
    if (signal.aborted) abort()
  })
}

/** The caller has already pinned and opened the exact main-owned corrected
 * source with O_NOFOLLOW and validated its metadata contract. It retains both
 * FileHandle and cache pin until child close, including failures/abort. This
 * routine does not close/release those owners and must run concurrently with
 * the bounded child-output sink to avoid a two-pipe deadlock. The controller
 * installs persistent stdin/stdout error observers until child close, covering
 * late error events after per-write callbacks or an abort has already settled. */
async function attestAndFeed(
  file: FileHandle,
  asset: HdrWorkingAsset,
  input: Writable,
  signal: AbortSignal,
  collectSamples: boolean,
) {
  const opened = await file.stat()
  signal.throwIfAborted()
  if (
    !opened.isFile() ||
    opened.size !== asset.byteLength ||
    asset.byteLength !== asset.width * asset.height * 16 ||
    asset.strips.length !== Math.ceil(asset.height / 64)
  )
    throw new Error('The leased CPU working source has incorrect dimensions.')
  const started = performance.now(),
    digest = createHash('sha256'),
    samples = collectSamples ? collectHdrSample(asset) : undefined
  const storage = Buffer.alloc(asset.width * Math.min(asset.height, 64) * 16)
  for (let index = 0; index < asset.strips.length; index++) {
    signal.throwIfAborted()
    const row = index * 64,
      expected = asset.width * Math.min(64, asset.height - row) * 16
    const strip = asset.strips[index]
    if (strip.byteLength !== expected || !/^[a-f0-9]{64}$/.test(strip.sha256))
      throw new Error('Invalid CPU working strip manifest.')
    const bytes = storage.subarray(0, expected)
    let filled = 0
    while (filled < expected) {
      const result = await file.read(
        bytes,
        filled,
        expected - filled,
        row * asset.width * 16 + filled,
      )
      signal.throwIfAborted()
      if (!result.bytesRead) throw new Error('Incomplete CPU working strip.')
      filled += result.bytesRead
    }
    // Both updates are synchronous; no WebCrypto snapshot or second F32 plane.
    if (createHash('sha256').update(bytes).digest('hex') !== strip.sha256)
      throw new Error('Damaged CPU working strip.')
    digest.update(bytes)
    samples?.add(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), row)
    await writeOwned(input, bytes, signal)
  }
  signal.throwIfAborted()
  const final = await file.stat()
  if (
    digest.digest('hex') !== asset.sha256 ||
    final.dev !== opened.dev ||
    final.ino !== opened.ino ||
    final.size !== opened.size
  )
    throw new Error('The CPU working source changed or its whole-file hash does not match.')
  // FullPreviews touches mtime for LRU usage, including unrelated HDR/statistics
  // requests. Content identity is the verified bytes, not that usage timestamp.
  // Only now give the child EOF. Its own exact-read/finite validation and EOF
  // guard must succeed before the controller publishes any result descriptor.
  await new Promise<void>((resolve, reject) => {
    const clean = () => {
      input.removeListener('error', failed)
      input.removeListener('close', closed)
      input.removeListener('finish', finished)
      signal.removeEventListener('abort', abort)
    }
    const failed = (error: unknown) => {
      clean()
      reject(error)
    }
    const finished = () => {
      clean()
      resolve()
    }
    const closed = () =>
      input.writableFinished
        ? finished()
        : failed(new Error('Native CPU stdin closed before EOF completed.'))
    const abort = () => failed(signal.reason)
    input.once('error', failed)
    input.once('close', closed)
    input.once('finish', finished)
    signal.addEventListener('abort', abort, { once: true })
    input.end((error?: Error | null) => {
      if (error) failed(error)
      else if (input.writableFinished) finished()
    })
    if (signal.aborted) abort()
  })
  signal.throwIfAborted()
  return { samples, elapsedMs: performance.now() - started, sourceAttestedByMain: true as const }
}

/** Existing presentation behavior remains the default collector path. */
export async function attestAndFeedCpuSource(
  file: FileHandle,
  asset: HdrWorkingAsset,
  input: Writable,
  signal: AbortSignal,
) {
  const result = await attestAndFeed(file, asset, input, signal, true)
  if (!result.samples) throw new Error('CPU presentation sample collection is missing.')
  return { ...result, samples: result.samples }
}
/** Same exact attestation/feed, without allocating unused mask statistics samples. */
export function attestAndFeedCpuMaskSource(
  file: FileHandle,
  asset: HdrWorkingAsset,
  input: Writable,
  signal: AbortSignal,
) {
  return attestAndFeed(file, asset, input, signal, false)
}
