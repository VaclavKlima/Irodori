import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { NATIVE_CPU_REQUEST_BYTES } from '../shared/native-color-protocol'

const MAX_PIPE_CHUNK = 128 * 1024
const MAX_TRAILER = 64 * 1024

class Reader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private current: Uint8Array = new Uint8Array(0)
  private offset = 0
  constructor(
    source: AsyncIterable<Uint8Array>,
    private signal: AbortSignal,
  ) {
    this.iterator = source[Symbol.asyncIterator]()
  }
  async take(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid native output read.')
    const output = Buffer.alloc(length)
    let filled = 0
    while (filled < length) {
      this.signal.throwIfAborted()
      if (this.offset === this.current.length) {
        const next = await this.iterator.next()
        this.signal.throwIfAborted()
        if (next.done) throw new Error('Truncated native CPU output.')
        if (!next.value.length || next.value.length > MAX_PIPE_CHUNK)
          throw new Error('Native CPU pipe chunk exceeds its admitted bound.')
        this.current = next.value
        this.offset = 0
      }
      const count = Math.min(length - filled, this.current.length - this.offset)
      output.set(this.current.subarray(this.offset, this.offset + count), filled)
      this.offset += count
      filled += count
    }
    return output
  }
  async eof() {
    this.signal.throwIfAborted()
    if (this.offset !== this.current.length || !(await this.iterator.next()).done)
      throw new Error('Unexpected trailing native CPU output.')
    this.signal.throwIfAborted()
  }
}
async function writeAll(file: FileHandle, bytes: Uint8Array, signal: AbortSignal) {
  let offset = 0
  while (offset < bytes.length) {
    signal.throwIfAborted()
    const result = await file.write(bytes, offset, bytes.length - offset, null)
    if (!result.bytesWritten) throw new Error('Incomplete CPU RGBA scratch write.')
    offset += result.bytesWritten
  }
}

export interface CpuPairSinkOptions {
  readonly stdout: AsyncIterable<Uint8Array>
  /** Exact main-created fixed request, never reconstructed from child fields. */
  readonly expectedRequest: Buffer
  readonly threads: 1 | 4 | 8
  /** Resolve ONLY on child close with code zero; reject on error/nonzero/signal. */
  readonly closedSuccessfully: Promise<void>
  /** An omitted plane is still fully parsed and hashed, without a scratch write. */
  readonly after?: FileHandle
  readonly before?: FileHandle
  readonly signal: AbortSignal
}

/** Caller owns kill/drain, private scratch files and their close/unlink lifetime.
 * This does not publish a manifest. On rejection it must kill the child and await
 * producer/sink/close allSettled before releasing any source or file owner. */
export async function writeNativeCpuPair(options: CpuPairSinkOptions) {
  const { expectedRequest: request, threads, signal } = options
  if (
    (!options.after && !options.before) ||
    request.length !== NATIVE_CPU_REQUEST_BYTES ||
    request.subarray(0, 8).toString() !== 'IRODCPU3' ||
    request.readUInt32LE(8) !== 3
  )
    throw new Error('Invalid expected native CPU request.')
  const width = request.readUInt32LE(24),
    height = request.readUInt32LE(28)
  if (!width || !height || width > 32768 || height > 32768 || width * height * 16 > 512 * 1024 ** 2)
    throw new Error('Invalid admitted CPU output geometry.')
  // Observe immediately; parser can still be awaiting a pipe read at child close.
  const close = options.closedSuccessfully.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const reader = new Reader(options.stdout, signal)
  const header = await reader.take(NATIVE_CPU_REQUEST_BYTES + 16)
  if (
    header.subarray(0, 8).toString() !== 'IRODRGB1' ||
    header.readUInt32LE(8) !== NATIVE_CPU_REQUEST_BYTES ||
    !header.subarray(12, NATIVE_CPU_REQUEST_BYTES + 12).equals(request) ||
    header.readUInt32LE(NATIVE_CPU_REQUEST_BYTES + 12) !== threads
  )
    throw new Error('Native CPU response does not match the admitted request.')
  const afterHash = createHash('sha256'),
    beforeHash = createHash('sha256')
  let row = 0,
    strips = 0
  while (row < height) {
    const strip = await reader.take(24),
      count = strip.readUInt32LE(12),
      bytes = strip.readUInt32LE(16)
    if (
      strip.subarray(0, 8).toString() !== 'IRODROW1' ||
      strip.readUInt32LE(8) !== row ||
      !count ||
      count > 64 ||
      count > height - row ||
      strip.readUInt32LE(20) !== 0 ||
      bytes !== width * count * 4
    )
      throw new Error('Native CPU row ordering or byte count is invalid.')
    // Only a bounded plane is resident in main; each file write completes before
    // its buffer can die. There is no full-frame main accumulator or extra IPC copy.
    const after = await reader.take(bytes)
    afterHash.update(after)
    if (options.after) await writeAll(options.after, after, signal)
    const before = await reader.take(bytes)
    beforeHash.update(before)
    if (options.before) await writeAll(options.before, before, signal)
    row += count
    strips++
  }
  const trailerHeader = await reader.take(12),
    length = trailerHeader.readUInt32LE(8)
  if (trailerHeader.subarray(0, 8).toString() !== 'IRODEND1' || !length || length > MAX_TRAILER)
    throw new Error('Native CPU completion trailer is invalid.')
  const raw: unknown = JSON.parse((await reader.take(length)).toString())
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid native CPU metrics.')
  const metrics = raw as Record<string, unknown>
  if (
    metrics.implementation !== 'float64-ctl-cpu-strip-v1' ||
    metrics.threads !== threads ||
    metrics.renderedStrips !== strips ||
    metrics.sourceHashVerifiedByChild !== false
  )
    throw new Error('Native CPU completion identity is invalid.')
  for (const field of [
    'preparationMs',
    'readMs',
    'renderMs',
    'outputMs',
    'elapsedMs',
    'plannedStripAndWorkerBytes',
  ])
    if (
      typeof metrics[field] !== 'number' ||
      !Number.isFinite(metrics[field]) ||
      metrics[field] < 0
    )
      throw new Error(`Invalid native CPU metric ${field}.`)
  await reader.eof()
  const completion = await close
  if (!completion.ok) throw completion.error
  signal.throwIfAborted()
  const expectedBytes = width * height * 4
  if (
    (options.after && (await options.after.stat()).size !== expectedBytes) ||
    (options.before && (await options.before.stat()).size !== expectedBytes)
  )
    throw new Error('CPU scratch files have incorrect final lengths.')
  return {
    width,
    height,
    strips,
    after: { byteLength: expectedBytes, sha256: afterHash.digest('hex') },
    before: { byteLength: expectedBytes, sha256: beforeHash.digest('hex') },
    metrics,
  }
}
