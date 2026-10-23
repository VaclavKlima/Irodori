import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Socket } from 'node:net'
import { RESOURCE_POLICY_VERSION } from '../shared/resource-policy'
import { prepareNativeRawExecutable } from './native-raw-executable'
import type {
  HdrRawPreparation,
  NativeRawDiagnostics,
  NativeRawWorkerContext,
  NativeRawMainMessage,
} from './preview-types'

const MIB = 1024 ** 2
const INPUT_LIMIT = 512 * MIB
const RAW_ALLOCATION_LIMIT = 256 * MIB
const SENSOR_RECEIVER_LIMIT = 128 * MIB
// Bounded framing, native curve/storage metadata and pipe/receiver transfer allowance.
// Runtime heaps, thread stacks and driver allocations are not process hard caps.
const TRANSFER_ALLOWANCE = 8 * MIB
export type NativeRawExecutableResolver = typeof prepareNativeRawExecutable

function bytes(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid native RAW resource bytes.')
  return value
}
function sum(...values: number[]) {
  return bytes(values.reduce((total, value) => total + bytes(value), 0))
}
export function nativeRawPreparationMemory(inputBytes: number, context: HdrRawPreparation) {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > INPUT_LIMIT)
    throw new Error('The native RAW original exceeds its input contract.')
  const ramBytes = sum(
    inputBytes,
    RAW_ALLOCATION_LIMIT,
    SENSOR_RECEIVER_LIMIT,
    TRANSFER_ALLOWANCE,
    context.rendererReservation.ramBytes,
  )
  const vramBytes = bytes(context.rendererReservation.vramBytes)
  return Object.freeze({
    ramBytes,
    vramBytes,
    accepted:
      ramBytes <= bytes(context.policy.ram.effectiveBytes) &&
      vramBytes <= bytes(context.policy.vram.effectiveBytes),
  })
}

function snapshot(context: NativeRawWorkerContext): NativeRawWorkerContext {
  const copy = structuredClone(context)
  if (
    !/^[a-f0-9]{32}$/.test(copy.nonce) ||
    !/^[a-f0-9]{64}$/.test(copy.originalSha256) ||
    typeof copy.parentWorkingKey !== 'string' ||
    !copy.parentWorkingKey ||
    copy.parentWorkingKey.length > 8192 ||
    copy.policy.version !== RESOURCE_POLICY_VERSION ||
    copy.policy.scope !== 'managed-image-resources' ||
    !Number.isSafeInteger(copy.policy.revision) ||
    copy.policy.revision < 0
  )
    throw new Error('Invalid native RAW admission context.')
  bytes(copy.policy.ram.effectiveBytes)
  bytes(copy.policy.vram.effectiveBytes)
  bytes(copy.rendererReservation.ramBytes)
  bytes(copy.rendererReservation.vramBytes)
  Object.freeze(copy.policy.ram)
  Object.freeze(copy.policy.vram)
  Object.freeze(copy.policy)
  Object.freeze(copy.rendererReservation)
  return Object.freeze(copy)
}

function send(worker: ChildProcess, value: NativeRawMainMessage, socket?: Socket) {
  return new Promise<void>((resolve, reject) => {
    if (!worker.connected) return reject(new Error('The native RAW receiver disconnected.'))
    worker.send(value, socket, { keepOpen: false }, (error) => (error ? reject(error) : resolve()))
  })
}
async function readiness(stream: NodeJS.ReadableStream) {
  let value = ''
  for await (const part of stream) {
    value += Buffer.isBuffer(part) ? part.toString('utf8') : String(part)
    if (Buffer.byteLength(value) > 128) throw new Error('Native RAW readiness exceeded its bound.')
  }
  return value
}

interface OwnerOptions {
  readonly worker: ChildProcess
  readonly path: string
  readonly context: NativeRawWorkerContext
  readonly signal: AbortSignal
  readonly current: () => boolean
  readonly failed: (error: Error) => void
  readonly executable?: NativeRawExecutableResolver
}

/** One direct native child under one existing full request; no queue, cache or process registry. */
export class NativeRawOwner {
  readonly context: NativeRawWorkerContext
  private requested = false
  private readerInstalled = false
  private handoffStarted = false
  private transferred = false
  private armed = false
  private started = false
  private completed = false
  private retiring = false
  private work?: Promise<void>
  private draining?: Promise<void>
  private source?: FileHandle
  private sourceStat?: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
  private child?: ChildProcess
  private nativeClose?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private nativeClosed = false
  private sender?: Socket
  private escalation?: ReturnType<typeof setTimeout>
  private stderr = ''

  constructor(private readonly options: OwnerOptions) {
    if (!isAbsolute(options.path)) throw new Error('Expected a trusted absolute RAW original path.')
    this.context = snapshot(options.context)
  }

  private check() {
    this.options.signal.throwIfAborted()
    if (this.retiring || !this.options.current()) throw new Error('Native RAW source cancelled.')
  }
  private nonce(value: unknown) {
    if (value !== this.context.nonce) throw new Error('Native RAW request identity mismatch.')
  }

  request(nonce: unknown) {
    this.nonce(nonce)
    this.check()
    if (this.requested) throw new Error('Duplicate native RAW source request.')
    this.requested = true
    // Installed synchronously before the first setup await. Retirement owns late continuations.
    this.work = this.perform()
    void this.work.catch((error: unknown) => {
      if (!this.retiring)
        this.options.failed(error instanceof Error ? error : new Error(String(error)))
    })
  }

  readerReady(nonce: unknown) {
    this.nonce(nonce)
    this.check()
    if (!this.requested || !this.handoffStarted || this.readerInstalled)
      throw new Error('Unexpected native RAW receiver acknowledgement.')
    this.readerInstalled = true
    this.start()
  }

  private start() {
    if (!this.armed || !this.transferred || !this.readerInstalled || this.started) return
    this.check()
    if (!this.child?.stdin || this.child.exitCode !== null || this.child.signalCode !== null)
      throw new Error('Native RAW helper stopped before source admission.')
    this.started = true
    this.child.stdin.end(`LUMA-RAW-START1 ${this.context.nonce}\n`)
  }

  private stop() {
    const child = this.child
    if (!child || this.nativeClosed || child.exitCode !== null || child.signalCode !== null) return
    const signal = (name: NodeJS.Signals) => {
      if (this.nativeClosed || child.exitCode !== null || child.signalCode !== null || !child.pid)
        return
      try {
        process.kill(-child.pid, name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(name)
      }
    }
    signal('SIGTERM')
    this.escalation ??= setTimeout(() => signal('SIGKILL'), 1000)
    // Closing the detached local wrapper never consumes bytes in the actual receiver.
    this.sender?.destroy()
    this.child?.stdin?.destroy()
  }

  private async releaseSource() {
    const file = this.source
    this.source = undefined
    if (!file) return
    try {
      const current = await file.stat({ bigint: true }),
        initial = this.sourceStat
      if (
        initial &&
        (current.dev !== initial.dev ||
          current.ino !== initial.ino ||
          current.size !== initial.size ||
          current.mtimeNs !== initial.mtimeNs ||
          current.ctimeNs !== initial.ctimeNs)
      )
        throw new Error('The managed RAW original changed during native source preparation.')
    } finally {
      await file.close()
    }
  }

  private async perform() {
    let succeeded = false
    try {
      const executable = await (this.options.executable ?? prepareNativeRawExecutable)()
      this.check()
      if (executable.status === 'unavailable') {
        this.completed = true
        await send(this.options.worker, {
          type: 'raw-source-declined',
          nonce: this.context.nonce,
          reason: 'unavailable',
          message: executable.reason,
        })
        succeeded = true
        return
      }
      this.source = await open(this.options.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      this.check()
      const info = await this.source.stat({ bigint: true })
      this.sourceStat = info
      this.check()
      if (!info.isFile() || info.size < 1n || info.size > BigInt(INPUT_LIMIT))
        throw new Error('Invalid managed native RAW original.')
      const memory = nativeRawPreparationMemory(Number(info.size), this.context)
      if (!memory.accepted) {
        await this.releaseSource()
        this.check()
        this.completed = true
        await send(this.options.worker, {
          type: 'raw-source-declined',
          nonce: this.context.nonce,
          reason: 'memory-limit',
          message: 'Native RAW preparation exceeds the frozen managed image resource budget.',
        })
        succeeded = true
        return
      }
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      const childStarted = performance.now()
      const child = spawn(
        executable.path,
        [
          '--owned-rows-v1',
          String(process.pid),
          this.context.nonce,
          String(info.dev),
          String(info.ino),
          String(info.size),
        ],
        {
          detached: true,
          env,
          stdio: ['pipe', 'pipe', 'pipe', this.source.fd, 'pipe'],
        },
      )
      this.child = child
      this.nativeClose = new Promise((resolve) => {
        child.once('close', (code, signal) => {
          this.nativeClosed = true
          clearTimeout(this.escalation)
          resolve({ code, signal })
        })
      })
      const failed = (error: Error) => {
        if (!this.retiring) this.options.failed(error)
        this.stop()
      }
      child.on('error', failed)
      child.stdin?.on('error', failed)
      child.stdout?.on('error', failed)
      child.stderr?.on('error', failed)
      child.stderr?.on('data', (part: Buffer) => {
        this.stderr = (
          this.stderr + part.subarray(Math.max(0, part.length - 8192)).toString()
        ).slice(-8192)
      })
      const readyPipe = child.stdio[4]
      if (!readyPipe || !('readable' in readyPipe))
        throw new Error('Missing native RAW readiness pipe.')
      const ready = await readiness(readyPipe as NodeJS.ReadableStream)
      this.check()
      if (ready !== `ARMED ${this.context.nonce}\n`)
        throw new Error(`Invalid native RAW readiness: ${this.stderr}`)
      const armedMs = performance.now() - childStarted
      this.armed = true
      if (!(child.stdout instanceof Socket) || child.stdout.readableLength !== 0)
        throw new Error('Native RAW stdout is not an untouched transferable stream.')
      this.sender = child.stdout
      this.handoffStarted = true
      try {
        await send(
          this.options.worker,
          { type: 'raw-source-stream', nonce: this.context.nonce },
          this.sender,
        )
      } finally {
        this.sender.destroy()
      }
      this.check()
      this.transferred = true
      this.start()
      const exit = await this.nativeClose
      await this.releaseSource()
      this.check()
      const diagnostics: NativeRawDiagnostics = {
        validationMs: executable.validationMs,
        sourceBytes: Number(info.size),
        peakRamBytes: memory.ramBytes,
        peakGpuBytes: memory.vramBytes,
        childMs: performance.now() - childStarted,
        armedMs,
      }
      // Kernel exit and source-pin close precede this message, not a worker-supplied claim.
      this.completed = true
      await send(this.options.worker, {
        type: 'raw-source-exit',
        nonce: this.context.nonce,
        code: exit.code,
        signal: exit.signal,
        diagnostics,
      })
      succeeded = true
    } finally {
      if (!succeeded) this.stop()
      if (this.nativeClose) await this.nativeClose
      this.sender?.destroy()
      await this.releaseSource()
    }
  }

  async finish() {
    if (this.requested && !this.completed)
      throw new Error('The preview worker completed before its native RAW owner retired.')
    await this.work
  }

  retire(): Promise<void> {
    if (this.draining) return this.draining
    this.retiring = true
    this.stop()
    this.draining = (async () => {
      await this.work?.catch(() => undefined)
      this.stop()
      if (this.nativeClose) await this.nativeClose
      await this.releaseSource()
    })()
    return this.draining
  }
}
