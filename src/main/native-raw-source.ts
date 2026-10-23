import { Socket } from 'node:net'
import type { SendHandle } from 'node:child_process'
import { readGpuSource, type RawSensorReader, type RawSource } from './gpu/raw-source'
import { cameraProfile } from './processing/cameras'
import { NativeRawPipeReader, nativeRawPipeLimits, type NativeRawSnapshot } from './native-raw-pipe'
import type { NativeRawWorkerContext, NativeRawMainMessage } from './preview-types'

export interface NativeRawPreparedSource {
  readonly source: RawSource
  readonly make: string
  readonly model: string
  readonly inputBytes: number
  readonly timings: {
    readonly sourceMs: number
    readonly validateMs: number
    readonly receiveMs: number
    readonly openMs: number
    readonly unpackMs: number
  }
}
export type HdrRawSourceFactory = () => Promise<NativeRawPreparedSource | null>

/** The existing numerical source policy consumes validated getters without a decoder cast. */
export function nativeRawSensorReader(
  value: NativeRawSnapshot,
  pixels: Uint16Array<ArrayBuffer>,
): RawSensorReader {
  return {
    getIParams: () => ({ normalized_make: value.make, normalized_model: value.model }),
    getColors: () => value.colors,
    getIsFoveon: () => value.isFoveon,
    getPixelAspect: () => value.pixelAspect,
    getCblack: (index) => value.cblack[index],
    getRawImage: () => pixels,
    color: (row, column) => value.cfa[(row % 2) * 2 + (column % 2)],
    getBlackLevel: (index) => value.black[index],
    getCamMul: (index) => value.camMul[index],
    getRgbCam: (row, column) => value.matrix[row * 4 + column],
    getActiveWidth: () => value.width,
    getActiveHeight: () => value.height,
    getRawWidth: () => value.rawWidth,
    getLeftMargin: () => value.left,
    getTopMargin: () => value.top,
    getColorMaximum: () => value.colorMaximum,
    getBlack: () => value.commonBlack,
    getLinearMax: (index) => value.linearMax[index],
    getFlip: () => value.flip,
  }
}

type Pending = {
  readonly context: NativeRawWorkerContext
  readonly reader: NativeRawPipeReader
  readonly started: number
  readonly resolve: (source: NativeRawPreparedSource | null) => void
  readonly reject: (reason: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  socket?: Socket
  ended: boolean
  exit?: Extract<NativeRawMainMessage, { type: 'raw-source-exit' }>
}

/** The main process owns the native child. This worker owns only its transferred reader. */
export class NativeRawSourceClient {
  private pending?: Pending

  constructor(
    private readonly send: (message: {
      type: 'raw-source-request' | 'raw-source-reader-ready'
      nonce: string
    }) => void,
  ) {}

  prepare(context: NativeRawWorkerContext): Promise<NativeRawPreparedSource | null> {
    if (this.pending) return Promise.reject(new Error('A native RAW receiver is already active.'))
    return new Promise((resolve, reject) => {
      const started = performance.now()
      const timer = setTimeout(
        () => this.fail(new Error('Native RAW receiver timed out.')),
        nativeRawPipeLimits.childTimeoutMs,
      )
      this.pending = {
        context,
        reader: new NativeRawPipeReader(started),
        started,
        resolve,
        reject,
        timer,
        ended: false,
      }
      try {
        this.send({ type: 'raw-source-request', nonce: context.nonce })
      } catch (error) {
        this.fail(error)
      }
    })
  }

  accept(message: NativeRawMainMessage, handle?: SendHandle): void {
    const pending = this.pending
    if (!pending || message.nonce !== pending.context.nonce) {
      if (handle instanceof Socket) handle.destroy()
      this.fail(new Error('Unexpected native RAW control identity.'))
      throw new Error('Unexpected native RAW control identity.')
    }
    try {
      if (message.type === 'raw-source-stream') {
        if (pending.socket || pending.exit || !(handle instanceof Socket))
          throw new Error('Invalid or duplicate native RAW stream.')
        pending.socket = handle
        handle.on('data', (part: Buffer) => {
          if (this.pending !== pending) return
          try {
            pending.reader.push(part)
          } catch (error) {
            this.fail(error)
          }
        })
        handle.once('end', () => {
          if (this.pending !== pending) return
          pending.ended = true
          this.finish(pending)
        })
        handle.once('error', (error) => {
          if (this.pending === pending) this.fail(error)
        })
        handle.once('close', () => {
          if (this.pending === pending && !pending.ended)
            this.fail(new Error('Native RAW stream closed before EOF.'))
        })
        this.send({ type: 'raw-source-reader-ready', nonce: pending.context.nonce })
        handle.resume()
      } else if (message.type === 'raw-source-declined') {
        if (handle || pending.socket || pending.exit)
          throw new Error('Native RAW declined after handoff.')
        if (message.reason !== 'unavailable') throw new Error(message.message)
        this.settle(pending, null)
      } else {
        if (handle || pending.exit) throw new Error('Duplicate native RAW completion.')
        pending.exit = message
        if (message.code !== 0 || message.signal !== null)
          throw new Error('Native RAW decoder did not close successfully.')
        if (!pending.socket) throw new Error('Native RAW closed without a reader.')
        this.finish(pending)
      }
    } catch (error) {
      if (handle instanceof Socket && handle !== pending.socket) handle.destroy()
      this.fail(error)
    }
  }

  private finish(pending: Pending): void {
    if (this.pending !== pending || !pending.ended || !pending.exit) return
    try {
      const result = pending.reader.finish(),
        value = result.header.unpacked,
        kernel = result.header.rowKernel
      if (
        value.libraryVersion !== '0.22.1-Release' ||
        value.unpackFunction !== 'sony_arw2_load_raw()' ||
        !cameraProfile(value.make, value.model)?.gpu ||
        result.header.opened.make !== value.make ||
        result.header.opened.model !== value.model ||
        !pending.exit.diagnostics ||
        !Number.isSafeInteger(pending.exit.diagnostics.sourceBytes) ||
        pending.exit.diagnostics.sourceBytes < 1 ||
        pending.exit.diagnostics.sourceBytes > nativeRawPipeLimits.inputBytes
      )
        throw new Error('Native RAW source does not match the admitted decoder contract.')
      // Unsupported layouts retain the same trusted decoder identity and actual
      // close barrier before the existing WASM eligibility check may run.
      if (
        kernel.status === 'upstream-fallback' ||
        !(value.width * 2 > value.height * 2.9 && value.width * 2 < value.height * 3.1)
      )
        return this.settle(pending, null)
      if (
        kernel.status !== 'rust-complete' ||
        kernel.requestedThreads !== 8 ||
        kernel.descriptor?.mappedBytes !== pending.exit.diagnostics.sourceBytes
      )
        throw new Error('Native RAW did not complete the admitted row kernel.')
      const validating = performance.now(),
        packed = result.packed
      const source = readGpuSource(
        nativeRawSensorReader(
          value,
          new Uint16Array(packed.buffer, packed.byteOffset, packed.byteLength / 2),
        ),
        true,
      )
      if (
        !source?.normalization ||
        source.pixels.buffer !== packed.buffer ||
        source.pixels.byteLength !== packed.byteLength
      )
        throw new Error('Native RAW did not yield one validated sensor owner.')
      this.settle(pending, {
        source,
        make: value.make,
        model: value.model,
        inputBytes: pending.exit.diagnostics.sourceBytes,
        timings: {
          sourceMs: performance.now() - pending.started,
          validateMs: performance.now() - validating,
          receiveMs: result.timings.trailerReadyMs,
          openMs: result.completion.timings.openMs,
          unpackMs: result.completion.timings.unpackMs,
        },
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private settle(pending: Pending, source: NativeRawPreparedSource | null): void {
    if (this.pending !== pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.socket?.destroy()
    pending.resolve(source)
  }
  private fail(error: unknown): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.socket?.destroy()
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  }
  close(): void {
    this.fail(new Error('Native RAW receiver closed.'))
  }
}
