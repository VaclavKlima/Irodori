import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

/** Bounded reader follows native-cpu-pair-sink; source copy stays independent
 * until adoption can factor the shared byte reader without changing framing. */
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
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid mask output length.')
    const bytes = Buffer.alloc(length)
    for (let at = 0; at < length;) {
      this.signal.throwIfAborted()
      if (this.offset === this.current.length) {
        const next = await this.iterator.next()
        this.signal.throwIfAborted()
        if (next.done) throw new Error('Truncated native mask output.')
        if (!next.value.length || next.value.length > 128 * 1024)
          throw new Error('Excess native mask pipe chunk.')
        this.current = next.value
        this.offset = 0
      }
      const count = Math.min(length - at, this.current.length - this.offset)
      bytes.set(this.current.subarray(this.offset, this.offset + count), at)
      this.offset += count
      at += count
    }
    return bytes
  }
  async eof() {
    this.signal.throwIfAborted()
    if (this.offset !== this.current.length || !(await this.iterator.next()).done)
      throw new Error('Excess native mask output.')
    this.signal.throwIfAborted()
  }
}
export async function writeNativeCpuMask(options: {
  stdout: AsyncIterable<Uint8Array>
  expectedRequest: Buffer
  threads: 1 | 4 | 8
  closedSuccessfully: Promise<void>
  file: FileHandle
  signal: AbortSignal
}) {
  const { expectedRequest: request, threads, signal } = options
  if (request.length !== 416 || request.subarray(0, 8).toString() !== 'MASKCPU1')
    throw new Error('Invalid admitted mask request.')
  const width = request.readUInt32LE(16),
    height = request.readUInt32LE(20),
    expectedBytes = width * height
  if (!width || !height || width > 32768 || height > 32768 || expectedBytes * 16 > 512 * 1024 ** 2)
    throw new Error('Invalid admitted mask geometry.')
  const closed = options.closedSuccessfully.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    ),
    reader = new Reader(options.stdout, signal),
    header = await reader.take(432)
  if (
    header.subarray(0, 8).toString() !== 'MASKOUT1' ||
    header.readUInt32LE(8) !== 416 ||
    !header.subarray(12, 428).equals(request) ||
    header.readUInt32LE(428) !== threads
  )
    throw new Error('Native mask response identity mismatch.')
  const digest = createHash('sha256')
  let row = 0,
    strips = 0
  while (row < height) {
    const header = await reader.take(16),
      rows = header.readUInt32LE(8),
      bytes = header.readUInt32LE(12)
    if (
      header.subarray(0, 4).toString() !== 'STRP' ||
      header.readUInt32LE(4) !== row ||
      rows !== Math.min(64, height - row) ||
      bytes !== width * rows
    )
      throw new Error('Native mask strip order or geometry mismatch.')
    const data = await reader.take(bytes)
    if (data.some((value) => value > 15)) throw new Error('Native mask contains unsupported bits.')
    digest.update(data)
    for (let offset = 0; offset < data.length;) {
      signal.throwIfAborted()
      const { bytesWritten } = await options.file.write(data, offset, data.length - offset, null)
      if (!bytesWritten) throw new Error('Incomplete native mask scratch write.')
      offset += bytesWritten
    }
    row += rows
    strips++
  }
  const terminal = await reader.take(72)
  if (
    terminal.subarray(0, 8).toString() !== 'MASKDONE' ||
    terminal.readBigUInt64LE(8) !== BigInt(expectedBytes) ||
    terminal.readUInt32LE(16) !== strips ||
    terminal.readUInt32LE(20) !== 0
  )
    throw new Error('Native mask terminal identity mismatch.')
  const durations = Array.from({ length: 4 }, (_, index) => terminal.readDoubleLE(24 + index * 8)),
    peakOwnedBytes = Number(terminal.readBigUInt64LE(56)),
    stackBytes = Number(terminal.readBigUInt64LE(64))
  if (
    !durations.every((value) => Number.isFinite(value) && value >= 0) ||
    !Number.isSafeInteger(peakOwnedBytes) ||
    peakOwnedBytes <= 0 ||
    !Number.isSafeInteger(stackBytes) ||
    stackBytes < 0 ||
    stackBytes > (threads - 1) * 512 * 1024
  )
    throw new Error('Invalid native mask completion counters.')
  await reader.eof()
  const result = await closed
  if (!result.ok) throw result.error
  signal.throwIfAborted()
  if ((await options.file.stat()).size !== expectedBytes)
    throw new Error('Native mask scratch length mismatch.')
  return {
    width,
    height,
    strips,
    byteLength: expectedBytes,
    sha256: digest.digest('hex'),
    metrics: {
      preparationMs: durations[0],
      readMs: durations[1],
      computeMs: durations[2],
      writeMs: durations[3],
      peakOwnedBytes,
      stackBytes,
    },
  }
}
