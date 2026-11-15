import { createHash } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { neutralAdjustments } from '../../shared/adjustments'
import { hdrAdjustmentMatrix } from '../../shared/hdr'
import { identityMaskGeometry } from '../../shared/mask-geometry'
import { appliedCorrections, type ProcessingOptions } from '../../shared/lens'
import { PREPARED_PROOF_VERSION } from '../../shared/preview-frame'
import { createPointGpu } from '../gpu/point-renderer'
import type { FullPreviewResult } from '../preview-types'
import { openPreparedMaskReader, preparedMaskParentStrips } from './prepared-mask-reader'
import type { PreparedMaskStackRequest } from './prepared-mask-stack'

/** SDR proof only: never publishes baked pixels as a reusable linear/HDR source. */
export async function renderPreparedMaskPreview(
  output: string,
  options: ProcessingOptions,
  request: PreparedMaskStackRequest,
  signal: AbortSignal,
): Promise<FullPreviewResult> {
  const started = performance.now(),
    asset = options.workingAsset
  if (!asset || options.crop || options.workingOnly || options.prepareLinear)
    throw new Error('Prepared mask preview supports explicit SDR proof consumption only.')
  const adjustments = {
    ...(options.adjustments ?? neutralAdjustments),
    maskGeometry:
      asset.maskGeometry ??
      asset.hdr?.maskGeometry ??
      identityMaskGeometry(asset.width, asset.height),
  }
  const whiteBalance = asset.hdr
    ? (hdrAdjustmentMatrix(adjustments, asset.hdr.whiteBalance) ?? undefined)
    : undefined
  const reader = await openPreparedMaskReader(
    request,
    {
      parent: { identity: request.stack.parent.identity, asset },
      adjustments,
      whiteBalance,
      domain: asset.hdr ? (asset.hdr.source.display ? 'authored-hdr' : 'scene-linear') : 'raster',
      transform: asset.transform,
    },
    signal,
    asset.width * asset.height * 12,
  )
  const path = join(output, 'full.rgba')
  let file: Awaited<ReturnType<typeof open>> | undefined
  let converter: Awaited<ReturnType<typeof createPointGpu>> | undefined
  let owned = false,
    placeholderOwned = false,
    complete = false
  try {
    file = await open(path, 'wx')
    owned = true
    converter = await createPointGpu(
      asset.width * Math.min(64, asset.height),
      adjustments,
      whiteBalance,
      false,
      true,
      64,
      0,
      reader.gpuLimitBytes,
      {
        domain: asset.hdr ? (asset.hdr.source.display ? 'authored-hdr' : 'scene-linear') : 'raster',
        preserveAlpha: true,
        transform: asset.transform,
        preparedPoint: true,
        signal,
        edgeAdmission: {
          policy: request.admission.policy,
          reservation: {
            ramBytes: request.admission.reservation.ramBytes + reader.ramBytes,
            vramBytes: request.admission.reservation.vramBytes,
          },
        },
      },
    )
    if (!converter.renderPrepared) throw new Error('Prepared point consumption is unavailable.')
    const digest = createHash('sha256')
    let offset = 0,
      strips = 0
    for await (const legacy of preparedMaskParentStrips(request, signal)) {
      const prepared = await reader.read(legacy, offset)
      const rendered = await converter.renderPrepared(
        legacy,
        prepared.pixels,
        prepared.union,
        offset,
      )
      signal.throwIfAborted()
      await file.writeFile(rendered.data)
      digest.update(rendered.data)
      offset += legacy.length / 4
      strips++
    }
    reader.finish()
    await file.close()
    file = undefined
    signal.throwIfAborted()
    const sha256 = digest.digest('hex')
    const rgba = await readFile(path)
    if (createHash('sha256').update(rgba).digest('hex') !== sha256)
      throw new Error('Prepared mask preview changed before thumbnail generation.')
    const placeholder = await sharp(rgba, {
      raw: { width: asset.width, height: asset.height, channels: 4 },
    })
      .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    const placeholderFile = await open(join(output, 'placeholder.png'), 'wx')
    placeholderOwned = true
    try {
      await placeholderFile.writeFile(placeholder)
    } finally {
      await placeholderFile.close()
    }
    signal.throwIfAborted()
    complete = true
    return {
      width: asset.width,
      height: asset.height,
      format: 'rgba8-srgb',
      byteLength: asset.width * asset.height * 4,
      sha256,
      placeholderBytes: placeholder.byteLength,
      renderId: `${PREPARED_PROOF_VERSION}-${request.stack.key}-sdr`,
      preparedProofVersion: PREPARED_PROOF_VERSION,
      preparedMaskStack: reader.identity,
      maskGeometry: adjustments.maskGeometry,
      adjustments,
      settingsRevision: options.revision,
      appliedCorrections: appliedCorrections(options.metadata.lensProfile, options.settings),
      diagnostics: {
        backend: 'gpu',
        proofBackend: 'gpu',
        proofGpuStrips: strips,
        adapter: converter.adapter,
        timings: { totalMs: performance.now() - started },
      },
    }
  } finally {
    try {
      await converter?.close()
    } finally {
      try {
        await file?.close()
      } finally {
        try {
          await reader.close()
        } finally {
          if (owned && !complete) await rm(path, { force: true })
          if (placeholderOwned && !complete)
            await rm(join(output, 'placeholder.png'), { force: true })
        }
      }
    }
  }
}
