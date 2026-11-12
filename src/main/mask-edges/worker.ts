import { createHash } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import { endianness } from 'node:os'
import sharp from 'sharp'
import { maskCapabilities } from '../../shared/masks'
import { RawGpuRenderer } from '../gpu/raw-renderer'
import { prepareMaskEdgeCoverage } from './gpu'
import { prepareMaskRangeBase } from '../mask-ranges/gpu'
import { renderMaskPreviewGpu } from './preview-gpu'
import { INSPECTION_IMAGE_LIMIT, INSPECTION_PAIR_LIMIT } from '../../shared/inspection'
import type {
  MaskEdgeResult,
  MaskEdgeWorkerReply,
  MaskEdgeWorkerRequest,
  MaskPreviewWorkerResult,
} from './types'

let owner: RawGpuRenderer | undefined
let busy = false
async function preview(request: MaskEdgeWorkerRequest): Promise<MaskPreviewWorkerResult> {
  if (process.versions.electron || endianness() !== 'LE' || !request.inspection)
    throw new Error('Mask inspection requires the isolated little-endian Node GPU worker.')
  const inspection = request.inspection
  if (
    !request.key ||
    request.key.length > 1024 ||
    !['coverage', 'overlay', 'pair'].includes(inspection.view)
  )
    throw new Error('Mask inspection requires a frozen preview identity and view.')
  let photo: Buffer | undefined
  if (inspection.view !== 'coverage') {
    if (!inspection.photoPath) throw new Error('Mask overlay requires the current SDR photograph.')
    const decoded = await sharp(inspection.photoPath, {
      limitInputPixels: request.width * request.height,
    })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (
      decoded.info.width !== request.width ||
      decoded.info.height !== request.height ||
      decoded.info.channels !== 4
    )
      throw new Error('Mask overlay photograph dimensions changed.')
    photo = decoded.data
  }
  owner ??= new RawGpuRenderer()
  const { device, adapter } = await owner.mergeDevice()
  const pixels = await renderMaskPreviewGpu(
    device,
    {
      mask: request.mask,
      geometry: inspection.geometry,
      grid: inspection.grid,
      bounds: inspection.bounds,
      width: request.width,
      height: request.height,
      coverage: inspection.view !== 'overlay',
      ...(photo ? { photo } : {}),
    },
    new AbortController().signal,
  )
  if (owner.failure) throw new Error(owner.failure)
  const members: MaskPreviewWorkerResult['members'] = []
  let total = 0
  for (const label of ['coverage', 'overlay'] as const) {
    const raw = pixels[label]
    if (!raw) continue
    const path = `${request.outputPath}.${label}.png`,
      temporary = `${path}.tmp`
    try {
      let encoder = sharp(raw, {
        raw: { width: request.width, height: request.height, channels: 4 },
      })
      encoder = label === 'coverage' ? encoder.extractChannel(0) : encoder.removeAlpha()
      await encoder.png().toFile(temporary)
      const encoded = await readFile(temporary)
      total += encoded.byteLength
      if (encoded.byteLength > INSPECTION_IMAGE_LIMIT || total > INSPECTION_PAIR_LIMIT)
        throw new Error(
          'Mask preview exceeds the image delivery limit. Reduce resolutionPercent or choose a smaller region.',
        )
      await rename(temporary, path)
      members.push({
        label,
        path,
        key: request.key,
        width: request.width,
        height: request.height,
        encodedBytes: encoded.byteLength,
        hash: createHash('sha256').update(encoded).digest('hex'),
      })
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  return { key: request.key, adapter, members }
}
async function prepare(request: MaskEdgeWorkerRequest): Promise<MaskEdgeResult> {
  if (process.versions.electron || endianness() !== 'LE')
    throw new Error('Mask edges require the isolated little-endian Node GPU worker.')
  if (typeof request.key !== 'string' || !request.key || request.key.length > 1024)
    throw new Error('Mask edges require a frozen coverage identity.')
  owner ??= new RawGpuRenderer()
  const { device } = await owner.mergeDevice()
  const coverage = request.range
    ? await prepareMaskRangeBase(
        device,
        request.range.source,
        request.range.parameters,
        new AbortController().signal,
      )
    : await prepareMaskEdgeCoverage(
        device,
        request.mask,
        request.width,
        request.height,
        new AbortController().signal,
      )
  if (owner.failure) throw new Error(owner.failure)
  const temporary = `${request.outputPath}.tmp`
  try {
    await sharp(coverage, { raw: { width: request.width, height: request.height, channels: 1 } })
      .toColourspace('b-w')
      .png()
      .toFile(temporary)
    const encoded = await readFile(temporary)
    if (encoded.byteLength > maskCapabilities.maxBaseEncodedBytes)
      throw new Error(
        'Prepared mask coverage exceeds the 8 MiB encoded limit. Simplify the mask or reduce its edge settings.',
      )
    await rename(temporary, request.outputPath)
    return {
      key: request.key,
      path: request.outputPath,
      hash: createHash('sha256').update(encoded).digest('hex'),
      width: request.width,
      height: request.height,
      encodedBytes: encoded.byteLength,
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

process.on('message', (request: MaskEdgeWorkerRequest) => {
  void (async () => {
    if (busy) throw new Error('The mask edge worker is busy.')
    busy = true
    try {
      process.send?.(
        request.inspection
          ? ({ id: request.id, preview: await preview(request) } satisfies MaskEdgeWorkerReply)
          : ({ id: request.id, result: await prepare(request) } satisfies MaskEdgeWorkerReply),
      )
    } finally {
      busy = false
    }
  })().catch((error: unknown) => {
    process.send?.({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies MaskEdgeWorkerReply)
    owner?.close()
    owner = undefined
    process.exit(1)
  })
})
process.on('disconnect', () => {
  owner?.close()
  process.exit(0)
})
