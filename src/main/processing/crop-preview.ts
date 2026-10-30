import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CROP_GEOMETRY_VERSION, cropGeometry, type CropSettings } from '../../shared/crop'
import { CROP_FILTER_VERSION } from '../../shared/crop-filter'
import { cropFrameMemoryPlan, type CropAdmission } from '../../shared/crop-resources'
import { hdrSourceVersion } from '../../shared/hdr'
import { neutralAdjustments } from '../../shared/adjustments'
import { frameByteLength } from '../../shared/preview-frame'
import type { ProcessingOptions } from '../../shared/lens'
import { appliedCorrections } from '../../shared/lens'
import type { FullPreviewResult } from '../preview-types'
import type { WorkingAsset } from '../working-assets'
import { prepareCropWorkingAsset } from './crop-preparation'
import { cropFrameReader } from './crop-frame'
import type { CropBackend } from './crop-bands'
import { writeHdrStrip } from './write-hdr-strip'

export interface CropPreviewJob extends CropAdmission {
  readonly asset: WorkingAsset
  readonly settings: CropSettings
  readonly options: ProcessingOptions
  readonly workingOnly: boolean
  readonly backend: CropBackend
}

/** The caller owns an unpublished disposable directory and an independent uncropped source lease. */
export async function prepareCropPreview(
  output: string,
  job: CropPreviewJob,
  signal: AbortSignal,
  render: (options: ProcessingOptions) => Promise<FullPreviewResult>,
): Promise<FullPreviewResult> {
  signal.throwIfAborted()
  const frozen = structuredClone(job),
    { asset } = frozen,
    geometry = cropGeometry(asset, frozen.settings)
  if (
    asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
    asset.byteLength > 512 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    (asset.hdr &&
      (asset.hdr.width !== asset.width ||
        asset.hdr.height !== asset.height ||
        asset.hdr.byteLength !== asset.byteLength ||
        asset.hdr.sha256 !== asset.sha256))
  )
    throw new Error('Invalid crop working descriptor.')
  if (geometry.identity) throw new Error('Identity crop must reuse its uncropped cache entry.')
  if (frozen.workingOnly && !asset.hdr) throw new Error('This source has no HDR working rendition.')
  const outputPath = join(output, 'linear.f32'),
    // Charge final working-frame readback and RGBA while earlier source storage can still be live.
    finalBytes = frozen.workingOnly ? 0 : geometry.width * geometry.height * 20,
    admission = {
      policy: frozen.policy,
      reservation: {
        ramBytes: frozen.reservation.ramBytes + finalBytes,
        vramBytes: frozen.reservation.vramBytes,
      },
    }
  let working: WorkingAsset
  let backend: 'cpu' | 'gpu', fallback: string | undefined, adapter: string | undefined
  if (asset.hdr) {
    const result = await prepareCropWorkingAsset(
      asset.path,
      {
        ...admission,
        asset: asset.hdr,
        settings: frozen.settings,
        backend: frozen.backend,
      },
      outputPath,
      signal,
    )
    working = {
      path: result.path,
      width: result.asset.width,
      height: result.asset.height,
      byteLength: result.asset.byteLength,
      sha256: result.asset.sha256,
      transform: asset.transform,
      hdr: result.asset,
    }
    backend = result.backend === 'gpu' || result.backend === 'mixed' ? 'gpu' : 'cpu'
    fallback = result.fallback
    adapter = result.adapter
  } else {
    const memory = cropFrameMemoryPlan(geometry, admission)
    if (!memory.cpuAccepted)
      throw new Error('Crop preparation exceeds the frozen managed image budgets.')
    if (
      asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
      asset.byteLength > 512 * 1024 ** 2 ||
      (await stat(asset.path)).size !== asset.byteLength
    )
      throw new Error('Invalid crop working source.')
    const bytes = await readFile(asset.path)
    signal.throwIfAborted()
    if (
      bytes.byteLength !== asset.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256
    )
      throw new Error('Damaged crop working source.')
    const frame = {
        data: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
        width: asset.width,
        height: asset.height,
        transform: asset.transform,
      },
      prepared = cropFrameReader(
        frame,
        {
          settings: frozen.settings,
          admission,
          backend: frozen.backend,
        },
        signal,
      ),
      file = await open(outputPath, 'wx'),
      digest = createHash('sha256')
    try {
      let top = 0
      for await (const strip of prepared.strips) {
        const pixels = new Uint8Array(strip.buffer, strip.byteOffset, strip.byteLength)
        await writeHdrStrip(file, pixels, top * geometry.width * 16, signal)
        digest.update(pixels)
        top += strip.length / (geometry.width * 4)
      }
      if (top !== geometry.height) throw new Error('Incomplete cropped preview source.')
    } finally {
      await file.close()
      await prepared.strips.return(undefined)
    }
    working = {
      path: outputPath,
      width: geometry.width,
      height: geometry.height,
      byteLength: geometry.width * geometry.height * 16,
      sha256: digest.digest('hex'),
      transform: asset.transform,
    }
    backend =
      prepared.diagnostics.backend === 'gpu' || prepared.diagnostics.backend === 'mixed'
        ? 'gpu'
        : 'cpu'
    fallback = prepared.diagnostics.fallback
    adapter = prepared.diagnostics.adapter
  }
  signal.throwIfAborted()
  const linear = {
    byteLength: working.byteLength,
    sha256: working.sha256,
    transform: working.transform,
    ...(working.hdr ? { hdr: working.hdr } : {}),
  }
  const suffix = `${CROP_GEOMETRY_VERSION}-${geometry.pixelAligned ? 'native-copy-v1' : CROP_FILTER_VERSION}-${linear.sha256}`
  if (frozen.workingOnly)
    return {
      crop: geometry,
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
      renderId: `${hdrSourceVersion(working.hdr!.source)}-${working.sha256}-${suffix}`,
      diagnostics: { backend, adapter, fallback, timings: {} },
    }
  const result = await render({
    ...frozen.options,
    crop: undefined,
    firstSurface: undefined,
    workingOnly: false,
    prepareLinear: false,
    workingAsset: working,
  })
  signal.throwIfAborted()
  if (result.width !== working.width || result.height !== working.height)
    throw new Error('The cropped preview and working source dimensions disagree.')
  return {
    ...result,
    crop: geometry,
    linear,
    renderId: `${result.renderId}-${suffix}`,
    diagnostics: {
      ...result.diagnostics,
      backend,
      adapter,
      fallback,
      timings: result.diagnostics?.timings ?? {},
    },
  }
}
