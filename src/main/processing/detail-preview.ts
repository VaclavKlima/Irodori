import { createHash } from 'node:crypto'
import { lstat, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { frameByteLength, MAX_FRAME_BYTES } from '../../shared/preview-frame'
import { neutralAdjustments, sameAdjustments } from '../../shared/adjustments'
import { cropGeometry } from '../../shared/crop'
import { hdrSourceVersion } from '../../shared/hdr'
import { appliedCorrections, type ProcessingOptions } from '../../shared/lens'
import {
  detailPreviewMemoryPlan,
  type DetailAdmission,
  type DetailPreviewMemoryPlan,
} from '../../shared/detail-resources'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  SPATIAL_DETAIL_STAGE,
  SPATIAL_DETAIL_VERSION,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../../shared/spatial-detail'
import type { FullPreviewResult } from '../preview-types'
import type { WorkingAsset } from '../working-assets'
import { detailFrameReader, validateDetailTransform } from './detail-frame'
import { prepareDetailWorkingAsset } from './detail-preparation'
import { detailPreparationKey, DETAIL_PREPARATION_VERSION } from './detail-identity'
import { writeHdrStrip } from './write-hdr-strip'
import type { DetailBackend, DetailBandDiagnostics } from './detail-bands'

export const DETAIL_PREVIEW_VERSION = 'prepared-detail-proof-v1'
export interface DetailPreviewJob extends DetailAdmission {
  readonly asset: WorkingAsset
  readonly sourceIdentity: string
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
  readonly options: ProcessingOptions
  readonly workingOnly: boolean
  readonly backend: DetailBackend
}
export interface DetailPreviewIdentity extends DetailBandDiagnostics {
  readonly key: string
  readonly sourceIdentity: string
  readonly sourceSha256: string
  readonly version: typeof DETAIL_PREPARATION_VERSION
  readonly stage: typeof SPATIAL_DETAIL_STAGE
  readonly operatorVersion: typeof SPATIAL_DETAIL_VERSION
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
  /** Selected proof route; the renderer's diagnostics separately record fallback. */
  readonly proofBackendRequest: 'cpu' | 'gpu' | 'none'
  readonly memory: DetailPreviewMemoryPlan
}

export async function readRasterWorking(asset: WorkingAsset, signal: AbortSignal) {
  if (
    asset.hdr ||
    asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
    asset.byteLength > MAX_FRAME_BYTES ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  )
    throw new Error('Invalid detail working source descriptor.')
  validateDetailTransform(asset.transform)
  signal.throwIfAborted()
  const before = await lstat(asset.path)
  signal.throwIfAborted()
  if (!before.isFile() || before.isSymbolicLink() || before.size !== asset.byteLength)
    throw new Error('Invalid detail working source.')
  const file = await open(asset.path, 'r')
  try {
    const info = await file.stat()
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== asset.byteLength)
      throw new Error('The detail working source changed.')
    signal.throwIfAborted()
    const data = new Float32Array(asset.byteLength / 4),
      digest = createHash('sha256')
    for (let y = 0; y < asset.height; y += 64) {
      signal.throwIfAborted()
      const offset = y * asset.width * 16,
        length = Math.min(64, asset.height - y) * asset.width * 16,
        bytes = new Uint8Array(data.buffer, offset, length)
      let read = 0
      while (read < length) {
        signal.throwIfAborted()
        const value = await file.read(bytes, read, length - read, offset + read)
        if (!value.bytesRead) throw new Error('Incomplete detail working source.')
        read += value.bytesRead
      }
      digest.update(bytes)
    }
    if (digest.digest('hex') !== asset.sha256) throw new Error('Damaged detail working source.')
    return { data, width: asset.width, height: asset.height, transform: asset.transform }
  } finally {
    await file.close()
  }
}

async function validateProof(output: string, result: FullPreviewResult, signal: AbortSignal) {
  const path = join(output, 'full.rgba'),
    info = await lstat(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== result.byteLength ||
    !/^[a-f0-9]{64}$/.test(result.sha256) ||
    !result.renderId
  )
    throw new Error('Invalid detail rendered frame.')
  const file = await open(path, 'r')
  try {
    const digest = createHash('sha256')
    for await (const bytes of file.createReadStream({
      autoClose: false,
      signal,
      highWaterMark: 64 * 1024,
    }))
      digest.update(bytes)
    if (digest.digest('hex') !== result.sha256) throw new Error('Damaged detail rendered frame.')
  } finally {
    await file.close()
  }
  const placeholder = await lstat(join(output, 'placeholder.png'))
  if (
    !placeholder.isFile() ||
    placeholder.isSymbolicLink() ||
    placeholder.size !== result.placeholderBytes ||
    placeholder.size < 1
  )
    throw new Error('Invalid detail rendered placeholder.')
}

/** The caller owns an unpublished directory and holds the unfiltered source lease through cleanup. */
export async function prepareDetailPreview(
  output: string,
  job: DetailPreviewJob,
  signal: AbortSignal,
  render: (options: ProcessingOptions, backend: 'cpu' | 'gpu') => Promise<FullPreviewResult>,
): Promise<FullPreviewResult> {
  signal.throwIfAborted()
  const frozen = structuredClone(job),
    { asset } = frozen,
    noise = compileNoiseReduction(frozen.noiseReduction),
    sharp = compileDetailSharpening(frozen.detailSharpening)
  if (
    asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
    asset.byteLength > MAX_FRAME_BYTES ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !/^[a-f0-9]{64}$/.test(frozen.sourceIdentity) ||
    !['auto', 'cpu', 'gpu'].includes(frozen.backend) ||
    typeof frozen.workingOnly !== 'boolean' ||
    (asset.hdr &&
      (asset.hdr.width !== asset.width ||
        asset.hdr.height !== asset.height ||
        asset.hdr.byteLength !== asset.byteLength ||
        asset.hdr.sha256 !== asset.sha256))
  )
    throw new Error('Invalid detail preview descriptor.')
  validateDetailTransform(asset.transform)
  if (!noise.active && !sharp.active)
    throw new Error('Neutral detail must reuse its upstream cache entry.')
  if (frozen.options.crop && !cropGeometry(asset, frozen.options.crop).identity)
    throw new Error('Detail processing must precede committed crop geometry.')
  if (frozen.workingOnly && !asset.hdr) throw new Error('This source has no HDR working rendition.')
  if (Boolean(asset.hdr) !== (frozen.options.processing === 'hdr-v1'))
    throw new Error('The detail source and processing domain disagree.')
  const memory = detailPreviewMemoryPlan(asset, frozen, {
    hdr: Boolean(asset.hdr),
    authoredHdr: Boolean(asset.hdr?.source.display),
    workingOnly: frozen.workingOnly,
    preferGpu: frozen.backend !== 'cpu',
  })
  if (!memory.filter.cpuAccepted)
    throw new Error('Detail preview exceeds the frozen managed image budgets.')
  if (frozen.backend === 'gpu' && !memory.filter.gpuAccepted)
    throw new Error('Detail GPU preview exceeds the frozen managed image budgets.')
  const names = ['linear.f32', 'full.rgba', 'placeholder.png'],
    paths = names.map((name) => join(output, name))
  for (const path of paths) {
    try {
      await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error('Detail preview requires an empty unpublished output.')
  }
  signal.throwIfAborted()
  let owned = false
  try {
    let working: WorkingAsset, key: string, diagnostics: DetailBandDiagnostics
    if (asset.hdr) {
      const result = await prepareDetailWorkingAsset(
        asset.path,
        {
          ...memory.admission,
          asset: asset.hdr,
          sourceIdentity: frozen.sourceIdentity,
          noiseReduction: frozen.noiseReduction,
          detailSharpening: frozen.detailSharpening,
          backend: frozen.backend,
        },
        paths[0],
        signal,
      )
      owned = true
      working = {
        path: result.path,
        width: asset.width,
        height: asset.height,
        byteLength: result.asset.byteLength,
        sha256: result.asset.sha256,
        transform: asset.transform,
        hdr: result.asset,
      }
      key = result.key
      diagnostics = result
    } else {
      const frame = await readRasterWorking(asset, signal),
        prepared = detailFrameReader(
          frame,
          { ...frozen, admission: memory.admission, primaries: 'srgb' },
          signal,
        ),
        file = await open(paths[0], 'wx'),
        digest = createHash('sha256')
      owned = true
      try {
        let y = 0
        for await (const band of prepared.strips) {
          const bytes = new Uint8Array(band.buffer, band.byteOffset, band.byteLength)
          await writeHdrStrip(file, bytes, y * asset.width * 16, signal)
          digest.update(bytes)
          y += band.length / (asset.width * 4)
        }
        if (y !== asset.height) throw new Error('Incomplete detail preview source.')
      } finally {
        try {
          await file.close()
        } finally {
          await prepared.strips.return(undefined)
        }
      }
      working = {
        path: paths[0],
        width: asset.width,
        height: asset.height,
        byteLength: asset.byteLength,
        sha256: digest.digest('hex'),
        transform: prepared.transform,
      }
      key = detailPreparationKey(
        frozen.sourceIdentity,
        asset,
        frozen.noiseReduction,
        frozen.detailSharpening,
      )
      diagnostics = prepared.diagnostics
    }
    signal.throwIfAborted()
    const detail: DetailPreviewIdentity = {
        key,
        sourceIdentity: frozen.sourceIdentity,
        sourceSha256: asset.sha256,
        version: DETAIL_PREPARATION_VERSION,
        stage: SPATIAL_DETAIL_STAGE,
        operatorVersion: SPATIAL_DETAIL_VERSION,
        noiseReduction: frozen.noiseReduction,
        detailSharpening: frozen.detailSharpening,
        backend: diagnostics.backend,
        cpuTiles: diagnostics.cpuTiles,
        gpuTiles: diagnostics.gpuTiles,
        precisionRecoveryTiles: diagnostics.precisionRecoveryTiles,
        maxSourceStrips: diagnostics.maxSourceStrips,
        adapter: diagnostics.adapter,
        fallback: diagnostics.fallback,
        proofBackendRequest: frozen.workingOnly ? 'none' : memory.proofBackend,
        memory,
      },
      linear = {
        byteLength: working.byteLength,
        sha256: working.sha256,
        transform: working.transform,
        ...(working.hdr ? { hdr: working.hdr } : {}),
      },
      suffix = `${DETAIL_PREVIEW_VERSION}-${key}-${working.sha256}`
    if (frozen.workingOnly)
      return {
        detail,
        linear,
        width: working.width,
        height: working.height,
        format: 'hdr-working',
        byteLength: 0,
        sha256: working.sha256,
        placeholderBytes: 0,
        adjustments: frozen.options.adjustments ?? neutralAdjustments,
        settingsRevision: frozen.options.revision,
        appliedCorrections: appliedCorrections(
          frozen.options.metadata.lensProfile,
          frozen.options.settings,
        ),
        renderId: `${hdrSourceVersion(working.hdr!.source)}-${suffix}`,
        diagnostics: {
          backend: diagnostics.gpuTiles ? 'gpu' : 'cpu',
          adapter: diagnostics.adapter,
          fallback: diagnostics.fallback,
          timings: {},
        },
      }
    const rendered = await render(
      {
        ...frozen.options,
        crop: undefined,
        firstSurface: undefined,
        workingOnly: false,
        prepareLinear: false,
        workingAsset: working,
      },
      memory.proofBackend,
    )
    signal.throwIfAborted()
    if (
      rendered.width !== working.width ||
      rendered.height !== working.height ||
      rendered.format !== 'rgba8-srgb' ||
      rendered.byteLength !== frameByteLength(working.width, working.height) ||
      rendered.settingsRevision !== frozen.options.revision ||
      !sameAdjustments(
        rendered.adjustments ?? neutralAdjustments,
        frozen.options.adjustments ?? neutralAdjustments,
      )
    )
      throw new Error('The detail source and rendered preview disagree.')
    await validateProof(output, rendered, signal)
    signal.throwIfAborted()
    return { ...rendered, detail, linear, renderId: `${rendered.renderId}-${suffix}` }
  } catch (error) {
    if (owned) await Promise.all(paths.map((path) => rm(path, { force: true })))
    throw error
  }
}
