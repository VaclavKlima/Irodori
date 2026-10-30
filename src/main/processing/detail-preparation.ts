import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  SPATIAL_DETAIL_VERSION,
  SPATIAL_DETAIL_STAGE,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../../shared/spatial-detail'
import {
  detailMemoryPlan,
  detailStreamMemoryPlan,
  type DetailAdmission,
  type DetailStreamMemoryPlan,
} from '../../shared/detail-resources'
import { frameByteLength, MAX_FRAME_BYTES } from '../../shared/preview-frame'
import { validateHdrSource, type HdrWorkingAsset } from '../../shared/hdr'
import { createSpatialDetailGpu, type SpatialDetailGpu } from '../gpu/spatial-detail'
import { detailBands, type DetailBackend, type DetailBandDiagnostics } from './detail-bands'
import { readHdrStrips } from './hdr-processing'
import { writeHdrStrip } from './write-hdr-strip'
import { DETAIL_PREPARATION_VERSION, detailPreparationKey } from './detail-identity'

export { DETAIL_PREPARATION_VERSION } from './detail-identity'
export interface DetailPreparationJob extends DetailAdmission {
  readonly asset: HdrWorkingAsset
  /** Validated upstream preparation identity, including lens/reference WB policy. */
  readonly sourceIdentity: string
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
  readonly backend: DetailBackend
}
export interface DetailPreparationResult extends DetailBandDiagnostics {
  readonly path: string
  readonly asset: HdrWorkingAsset
  readonly reused: boolean
  readonly key: string
  readonly version: typeof DETAIL_PREPARATION_VERSION
  readonly operatorVersion: typeof SPATIAL_DETAIL_VERSION
  readonly stage: typeof SPATIAL_DETAIL_STAGE
  readonly sourceIdentity: string
  readonly sourceSha256: string
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
  /** Identity returns the previously validated, already admitted source. */
  readonly memory?: DetailStreamMemoryPlan
}
export interface DetailPreparationProgress {
  readonly completedRows: number
  readonly totalRows: number
}

function validateAsset(asset: HdrWorkingAsset): void {
  validateHdrSource(asset?.source)
  if (
    asset.kind !== 'hdr-working-v1' ||
    asset.source.processing !== 'hdr-v1' ||
    asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
    asset.byteLength > MAX_FRAME_BYTES ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Array.isArray(asset.strips) ||
    asset.strips.length !== Math.ceil(asset.height / 64) ||
    asset.strips.some(
      (strip, index) =>
        strip.byteLength !== Math.min(64, asset.height - index * 64) * asset.width * 16 ||
        !/^[a-f0-9]{64}$/.test(strip.sha256),
    )
  )
    throw new Error('Invalid detail working asset.')
}

/**
 * Worker-only derived asset preparation. The caller holds the validated source
 * lease until this operation, output cleanup and GPU retirement have completed.
 * Identity reuses that source; active work never materializes a full float frame.
 */
export async function prepareDetailWorkingAsset(
  sourcePath: string,
  job: DetailPreparationJob,
  outputPath: string,
  signal: AbortSignal,
  progress?: (value: DetailPreparationProgress) => void | Promise<void>,
  makeGpu: () => SpatialDetailGpu = createSpatialDetailGpu,
): Promise<DetailPreparationResult> {
  signal.throwIfAborted()
  const frozen = structuredClone(job),
    { asset } = frozen,
    noise = compileNoiseReduction(frozen.noiseReduction),
    sharp = compileDetailSharpening(frozen.detailSharpening),
    active = noise.active || sharp.active
  validateAsset(asset)
  if (!/^[a-f0-9]{64}$/.test(frozen.sourceIdentity))
    throw new Error('Invalid detail source identity.')
  if (!['auto', 'cpu', 'gpu'].includes(frozen.backend))
    throw new Error('Invalid detail processing backend.')
  // Validate the frozen policy even on reuse; no new image allocation is admitted.
  detailMemoryPlan(frozen, false)
  const diagnostics: DetailBandDiagnostics = {
      backend: active ? 'cpu' : 'identity',
      cpuTiles: 0,
      gpuTiles: 0,
      precisionRecoveryTiles: 0,
      maxSourceStrips: 0,
    },
    identity = {
      version: DETAIL_PREPARATION_VERSION,
      operatorVersion: SPATIAL_DETAIL_VERSION,
      stage: SPATIAL_DETAIL_STAGE,
      sourceIdentity: frozen.sourceIdentity,
      sourceSha256: asset.sha256,
      noiseReduction: frozen.noiseReduction,
      detailSharpening: frozen.detailSharpening,
    } as const
  if (!active)
    return {
      ...identity,
      ...diagnostics,
      path: sourcePath,
      asset,
      reused: true,
      key: frozen.sourceIdentity,
    }
  const memory = detailStreamMemoryPlan(asset, frozen, true)
  if (!memory.cpuAccepted)
    throw new Error('Detail preparation exceeds the frozen managed image budgets.')
  if (frozen.backend === 'gpu' && !memory.gpuAccepted)
    throw new Error('Detail GPU preparation exceeds the frozen managed image budgets.')
  const key = detailPreparationKey(
      frozen.sourceIdentity,
      asset,
      frozen.noiseReduction,
      frozen.detailSharpening,
    ),
    file = await open(outputPath, 'wx')
  let complete = false
  try {
    signal.throwIfAborted()
    const digest = createHash('sha256'),
      strips: HdrWorkingAsset['strips'] = []
    let y = 0
    for await (const band of detailBands(
      asset,
      { kind: 'strips', values: readHdrStrips(sourcePath, asset) },
      { ...frozen, primaries: 'rec2020' },
      signal,
      diagnostics,
      makeGpu,
    )) {
      const bytes = new Uint8Array(band.buffer, band.byteOffset, band.byteLength)
      await writeHdrStrip(file, bytes, y * asset.width * 16, signal)
      digest.update(bytes)
      strips.push({
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      y += band.length / (asset.width * 4)
      await progress?.({ completedRows: y, totalRows: asset.height })
    }
    signal.throwIfAborted()
    if (y !== asset.height) throw new Error('Incomplete detail working pixels.')
    const resultAsset: HdrWorkingAsset = { ...asset, sha256: digest.digest('hex'), strips }
    delete resultAsset.url
    await file.close()
    signal.throwIfAborted()
    complete = true
    return {
      ...identity,
      ...diagnostics,
      path: outputPath,
      asset: resultAsset,
      reused: false,
      key,
      memory,
    }
  } finally {
    if (!complete) {
      await file.close().catch(() => undefined)
      await rm(outputPath, { force: true })
    }
  }
}
