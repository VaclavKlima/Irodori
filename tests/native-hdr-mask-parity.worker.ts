/** Test-only actual Electron worker. The full-mask oracle is unchanged production JS. */
import type { AdjustmentParameters } from '../src/shared/adjustments'
import type { DisplayTarget, HdrWorkingAsset } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics, reduceHdrMask } from '../src/shared/hdr-statistics'
import { validateHdrAsset, validateHdrStrip } from '../src/renderer/src/preview/hdr-stream'
import { verifyNativeMaskMath } from '../src/renderer/src/preview/native-mask-math'

// Independent observed Electron44.3.0 receipt, matched by the exact LLVM E17 probe.
// Retained D expectations/results remain unchanged in their research archive.
const primitiveControls: readonly (readonly [number, number, string])[] = [
  [-11.507243131689393, -6.353538344650907, 'c0009a2a798c6723'],
  [0, 0, '0000000000000000'],
  [-0, 0, '8000000000000000'],
  [0, -0, '400921fb54442d18'],
  [-0, -0, 'c00921fb54442d18'],
  [1, 1, '3fe921fb54442d18'],
  [-1, 1, 'bfe921fb54442d18'],
  [1, -1, '4002d97c7f3321d2'],
  [-1, -1, 'c002d97c7f3321d2'],
  [1, 0, '3ff921fb54442d18'],
  [-1, 0, 'bff921fb54442d18'],
  [0, 1, '0000000000000000'],
  [-0, 1, '8000000000000000'],
  [5e-324, 1, '0000000000000001'],
  [1, 5e-324, '3ff921fb54442d18'],
  [1e-300, -1, '400921fb54442d18'],
  [-1, 1e-300, 'bff921fb54442d18'],
]

export interface MaskParityRuntimeStart {
  userAgent: string
  primitiveControls: number
  primitiveProbes: { index: number; y: string; x: string; expected: string; actual: string }[]
  primitiveMismatches: { index: number; y: string; x: string; expected: string; actual: string }[]
  primitiveVerificationError?: string
  source: string
  width: number
  height: number
}
export interface MaskParityStart {
  asset: HdrWorkingAsset
  parameters: AdjustmentParameters
  target: DisplayTarget
  nativeSha256: string
}
export interface MaskParityLevel {
  width: number
  height: number
  byteLength: number
  oracleSha256: string
  nativeSha256: string
  differentBytes: number
  firstDifferences: { offset: number; oracle: number; native: number }[]
}
export interface MaskParityResult {
  width: number
  height: number
  sourcePixels: number
  sourceStrips: number
  nativeStrips: number
  comparedBytes: number
  differentBytes: number
  expectedBaseBytes?: number[]
  levels: MaskParityLevel[]
  sourceValidateAndOracleMs: number
  nativeReceiveMs: number
  reduceCompareAndHashMs: number
  visiblePixels: number
}
interface State {
  start: MaskParityStart
  oracle: Uint8Array<ArrayBuffer>
  native: Uint8Array<ArrayBuffer>
  statistics: ReturnType<typeof hdrStatistics>
  sourceStrips: number
  nativeStrips: number
  sourceValidateAndOracleMs: number
  nativeReceiveMs: number
}
type Command =
  | { kind: 'start'; start: MaskParityStart }
  | { kind: 'source' | 'native'; index: number; bytes: ArrayBuffer }
  | { kind: 'finish' }
  | { kind: 'clear' }
let state: State | undefined
let busy = false
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
async function command(value: Command): Promise<unknown> {
  if (value.kind === 'clear') {
    state = undefined
    return { cleared: true }
  }
  if (value.kind === 'start') {
    if (state) throw new Error('A previous parity image is still owned.')
    const view = new DataView(new ArrayBuffer(8))
    const primitiveProbes = primitiveControls.map(([y, x, expected], index) => {
      view.setFloat64(0, Math.atan2(y, x), false)
      const actual = view.getBigUint64(0, false).toString(16).padStart(16, '0')
      return {
        index,
        y: Object.is(y, -0) ? '-0' : String(y),
        x: Object.is(x, -0) ? '-0' : String(x),
        expected,
        actual,
      }
    })
    let primitiveVerificationError: string | undefined
    // Preserve the real production rejection. This independent test continues
    // only to collect the complete actual-JS reference; its final gate must fail.
    try {
      verifyNativeMaskMath()
    } catch (error) {
      primitiveVerificationError = String(error)
    }
    validateHdrAsset(value.start.asset)
    if (!/^[a-f0-9]{64}$/.test(value.start.nativeSha256))
      throw new Error('Missing native whole-mask identity.')
    const pixels = value.start.asset.width * value.start.asset.height
    state = {
      start: value.start,
      oracle: new Uint8Array(pixels),
      native: new Uint8Array(pixels),
      statistics: hdrStatistics('content-hdr', value.start.target, value.start.asset),
      sourceStrips: 0,
      nativeStrips: 0,
      sourceValidateAndOracleMs: 0,
      nativeReceiveMs: 0,
    }
    const runtime: MaskParityRuntimeStart = {
      userAgent: navigator.userAgent,
      primitiveControls: primitiveProbes.length,
      primitiveProbes,
      primitiveMismatches: primitiveProbes.filter((probe) => probe.actual !== probe.expected),
      primitiveVerificationError,
      source: value.start.asset.sha256,
      width: value.start.asset.width,
      height: value.start.asset.height,
    }
    return runtime
  }
  if (!state) throw new Error('No parity image is owned.')
  const current = state,
    { asset, parameters, target } = current.start
  if (value.kind === 'source') {
    if (value.index !== current.sourceStrips || value.index >= asset.strips.length)
      throw new Error('The complete original source strip order changed.')
    const started = performance.now()
    const strip = await validateHdrStrip(asset, value.index, value.bytes, 0)
    // Full unchanged analyzeHdr intentionally computes its statistics too. No
    // mask-only rewrite, sample, subsampling or native implementation is oracle.
    analyzeHdr(
      strip.data,
      parameters,
      asset,
      target,
      current.statistics,
      current.oracle,
      strip.row * asset.width,
    )
    current.sourceValidateAndOracleMs += performance.now() - started
    current.sourceStrips++
    return { strip: value.index, pixels: strip.data.length / 4 }
  }
  if (value.kind === 'native') {
    if (value.index !== current.nativeStrips || value.index >= asset.strips.length)
      throw new Error('The native base-mask strip order changed.')
    const started = performance.now(),
      bytes = new Uint8Array(value.bytes)
    const expected = asset.width * Math.min(64, asset.height - value.index * 64)
    if (bytes.length !== expected || bytes.some((byte) => byte > 15))
      throw new Error('Invalid native base-mask strip geometry or bits.')
    current.native.set(bytes, value.index * asset.width * 64)
    current.nativeStrips++
    current.nativeReceiveMs += performance.now() - started
    return { strip: value.index, pixels: bytes.length }
  }
  if (current.sourceStrips !== asset.strips.length || current.nativeStrips !== asset.strips.length)
    throw new Error('A partial image cannot authorize mask parity.')
  const started = performance.now()
  if ((await digest(current.native)) !== current.start.nativeSha256)
    throw new Error('The actual Electron native mask differs from the controller whole-mask hash.')
  const oracle = reduceHdrMask(current.oracle, asset.width, asset.height)
  const native = reduceHdrMask(current.native, asset.width, asset.height)
  if (oracle.levels.length !== native.levels.length) throw new Error('Different mip counts.')
  const levels: MaskParityLevel[] = []
  for (const [index, expected] of oracle.levels.entries()) {
    const actual = native.levels[index]
    if (
      actual.width !== expected.width ||
      actual.height !== expected.height ||
      actual.data.length !== expected.data.length
    )
      throw new Error('Different mip geometry.')
    const firstDifferences: MaskParityLevel['firstDifferences'] = []
    let differentBytes = 0
    for (let offset = 0; offset < expected.data.length; offset++) {
      if (expected.data[offset] === actual.data[offset]) continue
      differentBytes++
      if (firstDifferences.length < 32)
        firstDifferences.push({
          offset,
          oracle: expected.data[offset],
          native: actual.data[offset],
        })
    }
    levels.push({
      width: expected.width,
      height: expected.height,
      byteLength: expected.data.length,
      oracleSha256: await digest(expected.data),
      nativeSha256: await digest(actual.data),
      differentBytes,
      firstDifferences,
    })
  }
  const result: MaskParityResult = {
    width: asset.width,
    height: asset.height,
    sourcePixels: asset.width * asset.height,
    sourceStrips: current.sourceStrips,
    nativeStrips: current.nativeStrips,
    comparedBytes: levels.reduce((sum, level) => sum + level.byteLength, 0),
    differentBytes: levels.reduce((sum, level) => sum + level.differentBytes, 0),
    ...(current.oracle.length <= 64 ? { expectedBaseBytes: Array.from(current.oracle) } : {}),
    levels,
    sourceValidateAndOracleMs: current.sourceValidateAndOracleMs,
    nativeReceiveMs: current.nativeReceiveMs,
    reduceCompareAndHashMs: performance.now() - started,
    visiblePixels: current.statistics.visiblePixels,
  }
  state = undefined
  return result
}
self.onmessage = ({ data }: MessageEvent<{ id: number; command: Command }>) => {
  if (busy) {
    self.postMessage({ id: data.id, error: 'Parity commands must be sequential.' })
    return
  }
  busy = true
  void command(data.command)
    .then(
      (result) => self.postMessage({ id: data.id, result }),
      (error: unknown) => self.postMessage({ id: data.id, error: String(error) }),
    )
    .finally(() => {
      busy = false
    })
}
