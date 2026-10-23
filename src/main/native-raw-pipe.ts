// Bounded native sensor transport. The owner also requires EOF and actual child close.
export const nativeRawPipeContract = 'luma-parallel-sony-arw2-rows-v1'
export const nativeRawPipeLimits = {
  inputBytes: 512 * 1024 ** 2,
  packedBytes: 128 * 1024 ** 2,
  rawAllocationBytes: 256 * 1024 ** 2,
  activeLinearBytes: 384 * 1024 ** 2,
  addressSpaceBytes: 2 * 1024 ** 3,
  headerBytes: 64 * 1024,
  trailerBytes: 16 * 1024,
  childTimeoutMs: 60000,
} as const

export interface NativeRawSnapshot {
  libraryVersion: string
  make: string
  model: string
  unpackFunction: string
  width: number
  height: number
  rawWidth: number
  rawHeight: number
  rawPitch: number
  left: number
  top: number
  flip: number
  colors: number
  isFoveon: boolean
  pixelAspect: number
  cfa: number[]
  black: number[]
  commonBlack: number
  cblack: number[]
  colorMaximum: number
  camMul: number[]
  matrix: number[]
  camXyz: number[]
  linearMax: number[]
}
export interface NativeRawPipeHeader {
  contract: typeof nativeRawPipeContract
  protocol: 'u16le-live-rows-v2'
  opened: NativeRawSnapshot
  unpacked: NativeRawSnapshot
  packedBytes: number
  sourceLayout: { rowSamples: number; rowCount: number; strideSamples: number }
  rowKernel: {
    status: 'upstream-control' | 'upstream-fallback' | 'rust-complete'
    requestedThreads: number
    reason?: string
    participants?: number
    observedThreads?: number
    rows?: number
    blocks?: number
    samples?: number
    errorCode?: number
    descriptor?: {
      dataOffset: number
      mappedBytes: number
      compressedBytes: number
      rowBytes: number
      rows: number
      order: number
      flags: number
      curveWords: number
    }
    timings?: { descriptorMs: number; rustDispatchMs: number }
  }
}
export interface NativeRawPipeCompletion {
  contract: typeof nativeRawPipeContract
  complete: true
  packedBytes: number
  rowsWritten: number
  timings: Record<string, number>
  process: {
    threads: number
    peakRssBytes: number
    addressSpaceLimitBytes: number
    librawRawAllocationLimitBytes: number
    packedLimitBytes: number
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid native RAW ${label} object.`)
  return value as Record<string, unknown>
}
function integer(value: unknown, minimum: number, maximum: number, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`Invalid native RAW ${label}.`)
}
function array(value: unknown, length: number, label: string, integral = false) {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some(
      (entry: unknown) =>
        typeof entry !== 'number' ||
        !Number.isFinite(entry) ||
        (integral && (!Number.isSafeInteger(entry) || entry < 0 || entry > 0xffffffff)),
    )
  )
    throw new Error(`Invalid native RAW ${label} array.`)
}
function snapshot(value: unknown) {
  object(value, 'snapshot')
  const result = value as NativeRawSnapshot
  for (const name of ['libraryVersion', 'make', 'model', 'unpackFunction'] as const)
    if (
      typeof result[name] !== 'string' ||
      result[name].length === 0 ||
      result[name].length > 256 ||
      !/^[\x20-\x7e]+$/.test(result[name])
    )
      throw new Error(`Invalid native RAW snapshot ${name}.`)
  for (const name of ['width', 'height', 'rawWidth', 'rawHeight'] as const)
    integer(result[name], 1, 32768, name)
  integer(result.left, 0, result.rawWidth, 'left')
  integer(result.top, 0, result.rawHeight, 'top')
  integer(result.rawPitch, 0, nativeRawPipeLimits.rawAllocationBytes, 'rawPitch')
  integer(result.flip, 0, 7, 'flip')
  integer(result.colors, 1, 4, 'colors')
  integer(result.commonBlack, 0, 0xffffffff, 'commonBlack')
  integer(result.colorMaximum, 0, 0xffffffff, 'colorMaximum')
  if (
    typeof result.isFoveon !== 'boolean' ||
    typeof result.pixelAspect !== 'number' ||
    !Number.isFinite(result.pixelAspect) ||
    result.pixelAspect <= 0 ||
    result.left + result.width > result.rawWidth ||
    result.top + result.height > result.rawHeight ||
    result.rawWidth * result.rawHeight * 2 > nativeRawPipeLimits.packedBytes ||
    result.width * result.height * 16 > nativeRawPipeLimits.activeLinearBytes ||
    result.rawPitch % 2 !== 0
  )
    throw new Error('Invalid native RAW snapshot geometry/type.')
  const stride = result.rawPitch ? result.rawPitch / 2 : result.rawWidth
  if (
    stride < result.rawWidth ||
    stride * result.rawHeight * 2 > nativeRawPipeLimits.rawAllocationBytes
  )
    throw new Error('Invalid native RAW snapshot row storage.')
  array(result.cfa, 4, 'cfa', true)
  if (result.cfa.some((value) => value > 3)) throw new Error('Invalid native RAW CFA channel.')
  array(result.black, 4, 'black', true)
  array(result.cblack, 6, 'cblack', true)
  array(result.camMul, 4, 'camMul')
  array(result.matrix, 12, 'matrix')
  array(result.camXyz, 12, 'camXyz')
  array(result.linearMax, 4, 'linearMax')
  return result
}
function header(value: unknown): NativeRawPipeHeader {
  object(value, 'header')
  const result = value as NativeRawPipeHeader
  if (result.contract !== nativeRawPipeContract || result.protocol !== 'u16le-live-rows-v2')
    throw new Error('Native RAW pipe identity/protocol mismatch.')
  snapshot(result.opened)
  snapshot(result.unpacked)
  integer(result.packedBytes, 2, nativeRawPipeLimits.packedBytes, 'packedBytes')
  object(result.sourceLayout, 'sourceLayout')
  const { rowSamples, rowCount, strideSamples } = result.sourceLayout
  integer(rowSamples, 1, 32768, 'rowSamples')
  integer(rowCount, 1, 32768, 'rowCount')
  integer(strideSamples, rowSamples, nativeRawPipeLimits.rawAllocationBytes / 2, 'strideSamples')
  if (
    rowSamples !== result.unpacked.rawWidth ||
    rowCount !== result.unpacked.rawHeight ||
    strideSamples !== (result.unpacked.rawPitch ? result.unpacked.rawPitch / 2 : rowSamples) ||
    strideSamples * rowCount * 2 > nativeRawPipeLimits.rawAllocationBytes ||
    rowSamples * rowCount * 2 !== result.packedBytes
  )
    throw new Error('Native RAW header and packed row dimensions disagree.')
  const kernel = result.rowKernel
  object(kernel, 'row kernel')
  if (![1, 2, 4, 8].includes(kernel.requestedThreads))
    throw new Error('Invalid row thread request.')
  if (kernel.status === 'upstream-control') {
    if (kernel.requestedThreads !== 1) throw new Error('Invalid upstream row control.')
  } else if (kernel.status === 'upstream-fallback') {
    if (kernel.reason !== 'unsupported-flags-or-layout') throw new Error('Ambiguous row fallback.')
  } else if (kernel.status === 'rust-complete') {
    const descriptor = kernel.descriptor
    object(descriptor, 'row descriptor')
    object(kernel.timings, 'row timings')
    integer(descriptor!.dataOffset, 0, nativeRawPipeLimits.inputBytes, 'row data offset')
    integer(descriptor!.mappedBytes, 1, nativeRawPipeLimits.inputBytes, 'mapped input bytes')
    integer(kernel.observedThreads, 1, kernel.requestedThreads, 'observed row threads')
    if (
      kernel.participants !== Math.min(kernel.requestedThreads, rowCount) ||
      kernel.rows !== rowCount ||
      kernel.blocks !== (rowSamples / 16) * rowCount ||
      kernel.samples !== rowSamples * rowCount ||
      kernel.errorCode !== 0 ||
      descriptor!.compressedBytes !== rowSamples * rowCount ||
      descriptor!.rowBytes !== rowSamples ||
      descriptor!.rows !== rowCount ||
      descriptor!.dataOffset + descriptor!.compressedBytes > descriptor!.mappedBytes ||
      ![0x4949, 0x4d4d].includes(descriptor!.order) ||
      descriptor!.flags !== 0 ||
      descriptor!.curveWords !== 65536 ||
      rowSamples % 32 ||
      result.unpacked.left ||
      result.unpacked.top ||
      result.unpacked.height !== rowCount ||
      Object.keys(kernel.timings!).length !== 2 ||
      (['descriptorMs', 'rustDispatchMs'] as const).some((stage) => {
        const time = kernel.timings![stage]
        return typeof time !== 'number' || !Number.isFinite(time) || time < 0
      })
    )
      throw new Error('Invalid complete Rust row proof.')
  } else throw new Error('Missing row-kernel completion proof.')
  return result
}
function completion(value: unknown, expected: NativeRawPipeHeader): NativeRawPipeCompletion {
  object(value, 'completion')
  const result = value as NativeRawPipeCompletion
  if (
    result.contract !== nativeRawPipeContract ||
    result.complete !== true ||
    result.packedBytes !== expected.packedBytes ||
    result.rowsWritten !== expected.sourceLayout.rowCount
  )
    throw new Error('Missing or inconsistent native RAW completion identity.')
  const timingValues = object(result.timings, 'timings')
  const timingNames = [
    'inputMapMs',
    'openMs',
    'unpackMs',
    'prepareLiveRowsMs',
    'headerWriteMs',
    'payloadWriteWithBackpressureMs',
    'recycleMs',
    'totalBeforeTrailerMs',
  ]
  if (
    Object.keys(timingValues).length !== timingNames.length ||
    timingNames.some(
      (name) =>
        typeof timingValues[name] !== 'number' ||
        !Number.isFinite(timingValues[name]) ||
        (timingValues[name] as number) < 0,
    )
  )
    throw new Error('Invalid native RAW completion timings.')
  object(result.process, 'process')
  integer(result.process.peakRssBytes, 1, Number.MAX_SAFE_INTEGER, 'peakRssBytes')
  if (
    result.process.threads !== 1 ||
    result.process.addressSpaceLimitBytes !== nativeRawPipeLimits.addressSpaceBytes ||
    result.process.librawRawAllocationLimitBytes !== nativeRawPipeLimits.rawAllocationBytes ||
    result.process.packedLimitBytes !== nativeRawPipeLimits.packedBytes
  )
    throw new Error('Native RAW helper resource identity mismatch.')
  return result
}

type Stage = 'header-prefix' | 'header' | 'payload' | 'trailer-prefix' | 'trailer' | 'complete'

/** No chunk list or Buffer.concat: one owned packed buffer plus bounded framing scratch. */
export class NativeRawPipeReader {
  private stage: Stage = 'header-prefix'
  private destination: Buffer<ArrayBuffer> = Buffer.alloc(12)
  private offset = 0
  private headerValue?: NativeRawPipeHeader
  private completionValue?: NativeRawPipeCompletion
  private packed?: Buffer<ArrayBuffer>
  private readonly decode = new TextDecoder('utf-8', { fatal: true })
  private readonly timings: Record<string, number> = {
    parseAndCopyActiveMs: 0,
    payloadCopyActiveMs: 0,
    payloadAllocationMs: 0,
    stdoutBytes: 0,
    payloadChunks: 0,
  }

  constructor(private readonly startedAt: number) {}

  push(bytes: Buffer) {
    const started = performance.now()
    try {
      let read = 0
      while (read < bytes.length) {
        if (this.stage === 'complete') throw new Error('Excess native RAW stdout after trailer.')
        const count = Math.min(bytes.length - read, this.destination.length - this.offset)
        const copyAt = performance.now()
        bytes.copy(this.destination, this.offset, read, read + count)
        if (this.stage === 'payload') {
          this.timings.payloadCopyActiveMs += performance.now() - copyAt
          this.timings.payloadChunks++
        }
        this.offset += count
        read += count
        this.timings.stdoutBytes += count
        if (this.offset === this.destination.length) this.advance()
      }
    } finally {
      this.timings.parseAndCopyActiveMs += performance.now() - started
    }
  }

  private advance() {
    if (this.stage === 'header-prefix' || this.stage === 'trailer-prefix') {
      const isHeader = this.stage === 'header-prefix'
      const expected = isHeader ? 'LUMARAW2' : 'LUMAEND2'
      if (this.destination.toString('latin1', 0, 8) !== expected)
        throw new Error(`Invalid native RAW ${this.stage} magic.`)
      const length = this.destination.readUInt32LE(8)
      const limit = isHeader ? nativeRawPipeLimits.headerBytes : nativeRawPipeLimits.trailerBytes
      if (length < 2 || length > limit) throw new Error('Native RAW JSON frame length exceeded.')
      this.destination = Buffer.alloc(length)
      this.stage = isHeader ? 'header' : 'trailer'
    } else if (this.stage === 'header') {
      this.headerValue = header(JSON.parse(this.decode.decode(this.destination)))
      this.timings.headerReadyMs = performance.now() - this.startedAt
      const allocateAt = performance.now()
      // This ArrayBuffer is the sole JS sensor owner. It cannot escape until complete+exit.
      this.packed = Buffer.from(new ArrayBuffer(this.headerValue.packedBytes))
      this.timings.payloadAllocationMs = performance.now() - allocateAt
      this.destination = this.packed
      this.stage = 'payload'
    } else if (this.stage === 'payload') {
      this.timings.payloadReadyMs = performance.now() - this.startedAt
      this.destination = Buffer.alloc(12)
      this.stage = 'trailer-prefix'
    } else if (this.stage === 'trailer') {
      if (!this.headerValue) throw new Error('Native RAW trailer arrived before its header.')
      this.completionValue = completion(
        JSON.parse(this.decode.decode(this.destination)),
        this.headerValue,
      )
      this.timings.trailerReadyMs = performance.now() - this.startedAt
      this.stage = 'complete'
    } else {
      throw new Error('Unexpected native RAW framing transition.')
    }
    this.offset = 0
  }

  finish() {
    if (this.stage !== 'complete' || !this.headerValue || !this.completionValue || !this.packed)
      throw new Error(`Truncated native RAW pipe at ${this.stage} (${this.offset} bytes).`)
    return {
      header: this.headerValue,
      completion: this.completionValue,
      packed: this.packed,
      timings: { ...this.timings },
    }
  }

  diagnostics() {
    return {
      stage: this.stage,
      segmentBytesReceived: this.offset,
      segmentBytesExpected: this.destination.length,
      declaredPackedBytes: this.headerValue?.packedBytes ?? null,
      timings: { ...this.timings },
    }
  }
}
