import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkingFrame } from '../../shared/adjustments'
import type { DetailAdmission } from '../../shared/detail-resources'
import { detailFrameMemoryPlan, detailStreamMemoryPlan } from '../../shared/detail-resources'
import { detailWorkingFrame } from '../processing/detail-frame'
import { prepareDetailWorkingAsset } from '../processing/detail-preparation'
import { readRasterWorking } from '../processing/detail-preview'
import {
  detailLineageKey,
  resolveDetailSettings,
  type DetailSourceLineage,
} from '../processing/detail-identity'
import { validatePreparedPreviewLineage } from '../prepared-preview-lineage'
import { validateWorkingAsset, workingSourceIdentity, type WorkingAsset } from '../working-assets'
import { writeHdrStrip } from '../processing/write-hdr-strip'
import { exportInputMemoryPlan, requireExportAllocation } from '../../shared/export-resources'
import { matchesExportWorkingAsset } from './detail-policy'
import type { ExportDetailStageDiagnostics, ExportRenderJob } from './types'

interface RetainedDetail {
  version: 1
  key: string
  lineage: DetailSourceLineage
  asset: Omit<WorkingAsset, 'path'>
  diagnostics: ExportDetailStageDiagnostics
}
export interface DetailExportStage {
  asset?: WorkingAsset
  frame?: WorkingFrame
  diagnostics: ExportDetailStageDiagnostics
}

/** Runs in the isolated export worker. Completed variants share its existing preparation lifetime. */
export async function prepareExportDetailStage(
  job: ExportRenderJob,
  stage: 'working' | 'primary',
  source: WorkingAsset | WorkingFrame,
  admission: DetailAdmission,
  signal: AbortSignal,
): Promise<DetailExportStage> {
  signal.throwIfAborted()
  const controls = resolveDetailSettings(job.source.processing),
    fileSource = 'path' in source ? source : undefined,
    frameSource = 'data' in source ? source : undefined,
    lease = stage === 'working' || !job.source.hdr ? job.workingAsset : job.primaryWorkingAsset
  if (!controls.active) throw new Error('Neutral detail must bypass export preparation.')
  if (
    fileSource &&
    lease?.detailSource &&
    lease.asset.sha256 === fileSource.sha256 &&
    matchesExportWorkingAsset(job.source, lease, stage === 'primary')
  ) {
    validatePreparedPreviewLineage(
      { width: fileSource.width, height: fileSource.height, linear: fileSource },
      lease.identity,
      { detailSource: lease.detailSource },
    )
    if (!fileSource.hdr)
      requireExportAllocation(exportInputMemoryPlan(fileSource.width, fileSource.height, admission))
    return {
      asset: fileSource.hdr ? fileSource : undefined,
      frame: fileSource.hdr ? undefined : await readRasterWorking(fileSource, signal),
      diagnostics: {
        key: lease.identity,
        preparation: 'preview-cache',
        sourceIdentity: lease.detailSource.sourceIdentity,
        sourceSha256: lease.detailSource.asset.sha256,
      },
    }
  }
  if (fileSource && !fileSource.hdr) throw new Error('Missing HDR detail export descriptor.')
  const memory = fileSource
    ? detailStreamMemoryPlan(fileSource, admission, true)
    : detailFrameMemoryPlan(frameSource!, admission, true, frameSource!.data.buffer.byteLength)
  if (!memory.cpuAccepted)
    throw new Error('Detail export exceeds the frozen managed image budgets.')
  const sourceSha256 =
      fileSource?.sha256 ??
      createHash('sha256')
        .update(
          new Uint8Array(
            frameSource!.data.buffer,
            frameSource!.data.byteOffset,
            frameSource!.data.byteLength,
          ),
        )
        .digest('hex'),
    lineage: DetailSourceLineage = {
      sourceIdentity: workingSourceIdentity(
        job.source.photo.id,
        job.source.processing,
        stage === 'working',
      ),
      asset: {
        width: source.width,
        height: source.height,
        sha256: sourceSha256,
        ...(fileSource
          ? { source: fileSource.hdr!.source, whiteBalance: fileSource.hdr!.whiteBalance }
          : { transform: frameSource!.transform }),
      },
      noiseReduction: controls.noiseReduction,
      detailSharpening: controls.detailSharpening,
    },
    key = detailLineageKey(lineage),
    directory = job.preparationDirectory ?? job.directory,
    path = join(directory, `detail-${stage}.f32`),
    marker = join(directory, `detail-${stage}.json`)
  await mkdir(directory, { recursive: true })
  try {
    const entry = JSON.parse(await readFile(marker, 'utf8')) as RetainedDetail
    if (entry.version !== 1 || entry.key !== key || detailLineageKey(entry.lineage) !== key)
      throw new Error('Retained detail export identity changed.')
    const asset = { ...entry.asset, path }
    validatePreparedPreviewLineage(
      { width: asset.width, height: asset.height, linear: asset },
      key,
      { detailSource: entry.lineage },
    )
    let frame: WorkingFrame | undefined
    if (asset.hdr) await validateWorkingAsset(asset, signal)
    else frame = await readRasterWorking(asset, signal)
    return {
      asset: asset.hdr ? asset : undefined,
      frame,
      diagnostics: { ...entry.diagnostics, key, preparation: 'retained' },
    }
  } catch {
    signal.throwIfAborted()
    await rm(marker, { force: true })
    await rm(path, { force: true })
  }
  let completed = false
  try {
    const mode = (process.env.IRODORI_EXPORT_BACKEND ?? 'auto') as 'auto' | 'cpu' | 'gpu'
    let asset: WorkingAsset,
      frame: WorkingFrame | undefined,
      work: NonNullable<ExportDetailStageDiagnostics['work']>
    if (fileSource) {
      const result = await prepareDetailWorkingAsset(
        fileSource.path,
        {
          ...admission,
          asset: fileSource.hdr!,
          sourceIdentity: lineage.sourceIdentity,
          noiseReduction: controls.noiseReduction,
          detailSharpening: controls.detailSharpening,
          backend: mode,
        },
        path,
        signal,
      )
      if (result.key !== key) throw new Error('The detail export source identity changed.')
      asset = { ...fileSource, path, hdr: result.asset, sha256: result.asset.sha256 }
      work = {
        backend: result.backend,
        cpuTiles: result.cpuTiles,
        gpuTiles: result.gpuTiles,
        precisionRecoveryTiles: result.precisionRecoveryTiles,
        maxSourceStrips: result.maxSourceStrips,
        adapter: result.adapter,
        fallback: result.fallback,
      }
    } else {
      const result = await detailWorkingFrame(
        frameSource!,
        {
          noiseReduction: controls.noiseReduction,
          detailSharpening: controls.detailSharpening,
          primaries: 'srgb',
          admission,
          backend: mode,
        },
        signal,
      )
      frame = result.frame
      const bytes = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
        output = await open(path, 'wx')
      try {
        await writeHdrStrip(output, bytes, 0, signal)
      } finally {
        await output.close()
      }
      asset = {
        path,
        width: frame.width,
        height: frame.height,
        transform: frame.transform,
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      work = { ...result.diagnostics }
    }
    signal.throwIfAborted()
    validatePreparedPreviewLineage(
      { width: asset.width, height: asset.height, linear: asset },
      key,
      { detailSource: lineage },
    )
    const diagnostics: ExportDetailStageDiagnostics = {
        key,
        preparation: 'filtered',
        sourceIdentity: lineage.sourceIdentity,
        sourceSha256,
        work,
      },
      descriptor: Omit<WorkingAsset, 'path'> = {
        width: asset.width,
        height: asset.height,
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        transform: asset.transform,
        ...(asset.hdr ? { hdr: asset.hdr } : {}),
      }
    await writeFile(
      marker,
      JSON.stringify({
        version: 1,
        key,
        lineage,
        asset: descriptor,
        diagnostics,
      } satisfies RetainedDetail),
      { flag: 'wx' },
    )
    signal.throwIfAborted()
    completed = true
    return { asset: asset.hdr ? asset : undefined, frame, diagnostics }
  } finally {
    if (!completed) {
      await rm(marker, { force: true })
      await rm(path, { force: true })
    }
  }
}
