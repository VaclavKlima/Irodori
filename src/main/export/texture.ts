import { createHash } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdjustmentParameters } from '../../shared/adjustments'
import { srgbTransform } from '../../shared/adjustments'
import type { CropGeometry, CropSettings } from '../../shared/crop'
import type { DetailAdmission } from '../../shared/detail-resources'
import { hdrAdjustmentMatrix, type HdrWorkingAsset } from '../../shared/hdr'
import { cropFrameReader } from '../processing/crop-frame'
import { prepareMaskStack } from '../processing/mask-stack-preparation'
import type { PreparedMaskStackRequest } from '../processing/prepared-mask-stack'
import { validateWorkingAsset, type WorkingAsset } from '../working-assets'
import type { ExportRenderJob } from './types'

/** Native crop owners retire before any spatial Texture or final rendition owner starts. */
async function materializePrimary(
  path: string,
  base: Float32Array<ArrayBuffer>,
  size: { width: number; height: number },
  settings: CropSettings,
  adjustments: AdjustmentParameters,
  admission: DetailAdmission,
  signal: AbortSignal,
) {
  const reader = cropFrameReader(
    { data: base, ...size, transform: srgbTransform },
    { settings, backend: 'gpu', admission },
    signal,
  )
  const file = await open(path, 'wx'),
    hash = createHash('sha256')
  let complete = false
  try {
    for await (const strip of reader.strips) {
      signal.throwIfAborted()
      const bytes = Buffer.from(strip.buffer, strip.byteOffset, strip.byteLength)
      await file.writeFile(bytes)
      hash.update(bytes)
    }
    signal.throwIfAborted()
    complete = true
    return {
      asset: {
        path,
        width: reader.geometry.width,
        height: reader.geometry.height,
        byteLength: reader.geometry.width * reader.geometry.height * 16,
        sha256: hash.digest('hex'),
        transform: { ...srgbTransform },
        maskGeometry: adjustments.maskGeometry,
      } satisfies WorkingAsset,
      crop: { ...reader.diagnostics, memory: reader.memory },
    }
  } finally {
    try {
      await reader.strips.return(undefined)
    } finally {
      try {
        await file.close()
      } finally {
        if (!complete) await rm(path, { force: true })
      }
    }
  }
}
export interface ExportTextureInputs {
  readonly working?: PreparedMaskStackRequest
  readonly primary?: PreparedMaskStackRequest
  readonly rasterParent?: WorkingAsset
  readonly primaryCrop?: Awaited<ReturnType<typeof materializePrimary>>['crop']
}

/** Reuse the exact producer used by preview, independently for authored HDR and its primary. */
export async function prepareExportTextureInputs(
  job: ExportRenderJob,
  input: {
    asset?: HdrWorkingAsset
    workingPath?: string
    base?: Float32Array<ArrayBuffer>
    sourceWidth: number
    sourceHeight: number
    crop: CropGeometry
    cropSettings: CropSettings
    adjustments: AdjustmentParameters
    admission: DetailAdmission
    workingIdentity: string
    primaryIdentity: string
  },
  signal: AbortSignal,
): Promise<ExportTextureInputs> {
  const { asset, base, adjustments, admission } = input
  let rasterParent: WorkingAsset | undefined, primaryCrop: ExportTextureInputs['primaryCrop']
  if (base) {
    const result = await materializePrimary(
      join(job.directory, 'texture-parent.f32'),
      base,
      { width: input.sourceWidth, height: input.sourceHeight },
      input.cropSettings,
      adjustments,
      admission,
      signal,
    )
    rasterParent = result.asset
    primaryCrop = result.crop
  }
  const producerAdmission: DetailAdmission = {
    policy: admission.policy,
    reservation: {
      ramBytes: admission.reservation.ramBytes + (base?.buffer.byteLength ?? 0),
      vramBytes: admission.reservation.vramBytes,
    },
  }
  let working = job.preparedMaskStack,
    primary = job.primaryPreparedMaskStack
  if (asset && !working) {
    const directory = join(job.directory, 'texture-working')
    await mkdir(directory)
    const parent: WorkingAsset = {
      path: input.workingPath!,
      width: asset.width,
      height: asset.height,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
      hdr: asset,
      transform: job.source.processing.workingAsset?.transform ?? srgbTransform,
      maskGeometry: adjustments.maskGeometry,
    }
    const result = await prepareMaskStack(
      directory,
      {
        parent: { identity: input.workingIdentity, asset: parent },
        adjustments,
        domain: asset.source.display ? 'authored-hdr' : 'scene-linear',
        whiteBalance: hdrAdjustmentMatrix(adjustments, asset.whiteBalance) ?? undefined,
        admission: producerAdmission,
      },
      signal,
    )
    if (result.request) working = { ...result.request, admission }
  }
  if (rasterParent && (!asset ? !working : !primary)) {
    const directory = join(job.directory, 'texture-primary')
    await mkdir(directory)
    const result = await prepareMaskStack(
      directory,
      {
        parent: {
          identity: asset ? input.primaryIdentity : input.workingIdentity,
          asset: rasterParent,
        },
        adjustments,
        domain: 'raster',
        admission: producerAdmission,
      },
      signal,
    )
    if (result.request) {
      const request = { ...result.request, admission }
      if (asset) primary = request
      else working = request
    }
  }
  return { working, primary, rasterParent, primaryCrop }
}

/** A prepared crop stays on disk; no second full raster frame is retained for consumption. */
export async function* rasterTextureParentStrips(asset: WorkingAsset, signal: AbortSignal) {
  await validateWorkingAsset(asset, signal)
  const file = await open(asset.path, 'r'),
    hash = createHash('sha256')
  try {
    for (let y = 0; y < asset.height; y += 64) {
      const bytes = Buffer.alloc(asset.width * Math.min(64, asset.height - y) * 16)
      let offset = 0
      while (offset < bytes.byteLength) {
        signal.throwIfAborted()
        const read = await file.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          y * asset.width * 16 + offset,
        )
        if (!read.bytesRead) throw new Error('Incomplete Texture crop parent.')
        offset += read.bytesRead
      }
      hash.update(bytes)
      yield new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / 4)
    }
    if (hash.digest('hex') !== asset.sha256)
      throw new Error('Texture crop parent changed during consumption.')
  } finally {
    await file.close()
  }
}
