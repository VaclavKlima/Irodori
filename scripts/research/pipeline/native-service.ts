import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'

export const REQUEST_MAGIC = 0x31554d4c
export const RESPONSE_MAGIC = 0x31524d4c
/** Local research transport. No native handles, shaders, or paths enter app IPC. */
export class NativeService {
  readonly child: ChildProcessWithoutNullStreams
  private chunks: Buffer[] = []
  private size = 0
  private waiters: (() => void)[] = []
  private ended = false
  private closed = false
  private failure = ''
  private active = false
  constructor(binary: string, threads: number) {
    if (!Number.isInteger(threads) || threads < 1 || threads > 8)
      throw new Error('Invalid thread budget.')
    this.child = spawn(binary, [String(threads)], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk)
      this.size += chunk.length
      this.wake()
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.failure = (this.failure + chunk.toString()).slice(-2000)
    })
    this.child.on('error', (error) => {
      this.failure = error.message
      this.ended = true
      this.wake()
    })
    this.child.on('close', () => {
      this.closed = true
      this.ended = true
      this.wake()
    })
    // EPIPE is reported through the pending request, without an unhandled stream event.
    this.child.stdin.on('error', (error) => {
      this.failure = error.message
      this.ended = true
      this.wake()
    })
  }
  private wake() {
    this.waiters.splice(0).forEach((wake) => wake())
  }
  private async read(length: number) {
    while (this.size < length) {
      if (this.ended) throw new Error(this.failure || 'Research service ended before its response.')
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    const result = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const first = this.chunks[0],
        count = Math.min(first.length, length - offset)
      first.copy(result, offset, 0, count)
      if (count === first.length) this.chunks.shift()
      else this.chunks[0] = first.subarray(count)
      offset += count
      this.size -= count
    }
    return result
  }
  async process(
    data: Float32Array,
    width: number,
    height: number,
    id: number,
    ev = 0.5,
    amount = 0.25,
  ) {
    if (this.active)
      throw new Error(
        'One request per service; use two explicitly budgeted processes for two photos.',
      )
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 32768 ||
      height > 32768 ||
      data.length !== width * height * 4 ||
      data.byteLength > 128 * 1024 ** 2 ||
      !Number.isInteger(id) ||
      id < 0 ||
      id > 0xffffffff
    )
      throw new Error('Invalid research frame.')
    this.active = true
    const started = performance.now(),
      header = Buffer.alloc(32)
    header.writeUInt32LE(REQUEST_MAGIC, 0)
    header.writeUInt32LE(width, 4)
    header.writeUInt32LE(height, 8)
    header.writeUInt32LE(id, 12)
    header.writeDoubleLE(ev, 16)
    header.writeDoubleLE(amount, 24)
    try {
      this.child.stdin.write(header)
      // The caller retains its immutable input; the native service owns the receiving allocation.
      await new Promise<void>((resolve, reject) =>
        this.child.stdin.write(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          (error) => (error ? reject(error) : resolve()),
        ),
      )
      const response = await this.read(32)
      if (
        response.readUInt32LE(0) !== RESPONSE_MAGIC ||
        response.readUInt32LE(4) !== width ||
        response.readUInt32LE(8) !== height ||
        response.readUInt32LE(12) !== id
      )
        throw new Error('Research service response identity mismatch.')
      const payload = await this.read(data.byteLength)
      const output = new Float32Array(data.length)
      new Uint8Array(output.buffer).set(payload)
      return {
        data: output,
        endToEndMs: performance.now() - started,
        computeMs: response.readDoubleLE(16) / 1e6,
        ownedBytes: response.readDoubleLE(24),
        transferredBytes: data.byteLength * 2 + 64,
      }
    } finally {
      this.active = false
    }
  }
  async close() {
    if (this.closed) return
    const closed = once(this.child, 'close')
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000)
    try {
      await closed
    } finally {
      clearTimeout(timer)
    }
  }
}
