import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { WorkingFrame } from '../../shared/adjustments'
import type { ColorPrimaries } from '../../shared/color-model'
import { validateHdrSource, type HdrWorkingAsset } from '../../shared/hdr'
import { frameByteLength, MAX_FRAME_BYTES } from '../../shared/preview-frame'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  detailLuminance,
  SPATIAL_DETAIL_STAGE,
  SPATIAL_DETAIL_VERSION,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../../shared/spatial-detail'
import {
  detailFrameMemoryPlan,
  DETAIL_BAND_ROWS,
  type DetailAdmission,
  type DetailFrameMemoryPlan,
} from '../../shared/detail-resources'
import type { SpatialDetailGpu } from '../gpu/spatial-detail'
import { detailBands, type DetailBackend, type DetailBandDiagnostics } from './detail-bands'
import { validateDetailTransform } from './detail-identity'

export interface DetailFrameJob {
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
  readonly primaries: ColorPrimaries
  readonly backend: DetailBackend
  /** Other owners only; this adapter charges the input's complete backing allocation. */
  readonly admission?: DetailAdmission
}
export interface DetailFrameReader {
  readonly active: boolean
  readonly width: number
  readonly height: number
  readonly primaries: ColorPrimaries
  readonly stage: typeof SPATIAL_DETAIL_STAGE
  readonly operatorVersion: typeof SPATIAL_DETAIL_VERSION
  readonly transform: WorkingFrame['transform']
  readonly memory?: DetailFrameMemoryPlan
  /** Upstream provenance only; these hashes never describe newly filtered pixels. */
  readonly sourceHdr?: HdrWorkingAsset
  readonly diagnostics: DetailBandDiagnostics
  /** Borrowed bands; retain the immutable input lease through iteration and retirement. */
  readonly strips: AsyncGenerator<Float32Array<ArrayBuffer>>
}

export { validateDetailTransform } from './detail-identity'

function reader(
  frame: WorkingFrame,
  job: DetailFrameJob,
  signal: AbortSignal,
  retainOutput: boolean,
  makeGpu?: () => SpatialDetailGpu,
): DetailFrameReader {
  signal.throwIfAborted()
  const frozen = structuredClone(job),
    width = frame.width,
    height = frame.height,
    data = frame.data,
    byteLength = frameByteLength(width, height) * 4,
    noise = compileNoiseReduction(frozen.noiseReduction),
    sharp = compileDetailSharpening(frozen.detailSharpening),
    active = noise.active || sharp.active
  detailLuminance(frozen.primaries)
  if (
    !(data instanceof Float32Array) ||
    !(data.buffer instanceof ArrayBuffer) ||
    data.byteLength !== byteLength ||
    data.buffer.byteLength > MAX_FRAME_BYTES ||
    !['auto', 'cpu', 'gpu'].includes(frozen.backend)
  )
    throw new Error('Invalid detail working frame.')
  const transform = active ? structuredClone(frame.transform) : frame.transform
  validateDetailTransform(transform)
  const hdr = frame.hdr ? structuredClone(frame.hdr) : undefined
  if (hdr) {
    validateHdrSource(hdr.source)
    if (
      frozen.primaries !== 'rec2020' ||
      hdr.kind !== 'hdr-working-v1' ||
      hdr.width !== width ||
      hdr.height !== height ||
      hdr.byteLength !== byteLength ||
      !/^[a-f0-9]{64}$/.test(hdr.sha256) ||
      !Array.isArray(hdr.strips) ||
      hdr.strips.length !== Math.ceil(height / DETAIL_BAND_ROWS) ||
      hdr.strips.some(
        (strip, i) =>
          strip.byteLength !==
            Math.min(DETAIL_BAND_ROWS, height - i * DETAIL_BAND_ROWS) * width * 16 ||
          !/^[a-f0-9]{64}$/.test(strip.sha256),
      )
    )
      throw new Error('Invalid detail source HDR descriptor.')
  }
  const diagnostics: DetailBandDiagnostics = {
      backend: active ? 'cpu' : 'identity',
      cpuTiles: 0,
      gpuTiles: 0,
      precisionRecoveryTiles: 0,
      maxSourceStrips: 0,
    },
    base = {
      active,
      width,
      height,
      primaries: frozen.primaries,
      stage: SPATIAL_DETAIL_STAGE,
      operatorVersion: SPATIAL_DETAIL_VERSION,
      transform,
      sourceHdr: hdr,
      diagnostics,
    } as const
  if (!active)
    return {
      ...base,
      strips: (async function* () {
        // Reuse the upstream validated frame; no filter surface, scan, copy or GPU setup.
        for (let y = 0; y < height; y += DETAIL_BAND_ROWS) {
          signal.throwIfAborted()
          yield data.subarray(y * width * 4, (y + DETAIL_BAND_ROWS) * width * 4)
        }
      })(),
    }
  if (!frozen.admission) throw new Error('Detail processing requires a frozen resource admission.')
  const memory = detailFrameMemoryPlan(
    { width, height },
    frozen.admission,
    retainOutput,
    data.buffer.byteLength,
  )
  if (!memory.cpuAccepted)
    throw new Error('Detail frame processing exceeds the frozen managed image budgets.')
  if (frozen.backend === 'gpu' && !memory.gpuAccepted)
    throw new Error('Detail frame GPU processing exceeds the frozen managed image budgets.')
  const strips = (async function* () {
    if (hdr) {
      const digest = createHash('sha256')
      for (let y = 0; y < height; y += DETAIL_BAND_ROWS) {
        await setImmediate()
        signal.throwIfAborted()
        const bytes = new Uint8Array(
          data.buffer,
          data.byteOffset + y * width * 16,
          Math.min(DETAIL_BAND_ROWS, height - y) * width * 16,
        )
        if (
          createHash('sha256').update(bytes).digest('hex') !==
          hdr.strips[y / DETAIL_BAND_ROWS].sha256
        )
          throw new Error('Damaged detail source HDR strip.')
        digest.update(bytes)
      }
      if (digest.digest('hex') !== hdr.sha256) throw new Error('Damaged detail source HDR frame.')
    }
    yield* detailBands(
      { width, height },
      { kind: 'frame', data, retainOutput },
      { ...frozen, ...frozen.admission! },
      signal,
      diagnostics,
      makeGpu,
    )
  })()
  return { ...base, memory, strips }
}

/** Preserve authored linear pixels and display transform; primaries are explicit, never inferred. */
export function detailFrameReader(
  frame: WorkingFrame,
  job: DetailFrameJob,
  signal: AbortSignal,
  makeGpu?: () => SpatialDetailGpu,
): DetailFrameReader {
  return reader(frame, job, signal, false, makeGpu)
}

/** Active output drops stale native handles/identity and rehashes any HDR descriptor. */
export async function detailWorkingFrame(
  frame: WorkingFrame,
  job: DetailFrameJob,
  signal: AbortSignal,
  makeGpu?: () => SpatialDetailGpu,
) {
  const prepared = reader(frame, job, signal, true, makeGpu)
  if (!prepared.active) return { ...prepared, frame }
  const data = new Float32Array(prepared.width * prepared.height * 4),
    digest = prepared.sourceHdr ? createHash('sha256') : undefined,
    hashes: HdrWorkingAsset['strips'] = []
  let offset = 0
  for await (const band of prepared.strips) {
    signal.throwIfAborted()
    data.set(band, offset)
    offset += band.length
    if (digest) {
      const bytes = new Uint8Array(band.buffer, band.byteOffset, band.byteLength)
      digest.update(bytes)
      hashes.push({
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  signal.throwIfAborted()
  if (offset !== data.length) throw new Error('Incomplete detail working frame.')
  const hdr =
    prepared.sourceHdr && digest
      ? { ...prepared.sourceHdr, sha256: digest.digest('hex'), strips: hashes }
      : undefined
  if (hdr) delete hdr.url
  const result: WorkingFrame = {
    data,
    width: prepared.width,
    height: prepared.height,
    transform: prepared.transform,
    ...(hdr ? { hdr } : {}),
  }
  return { ...prepared, frame: result }
}
