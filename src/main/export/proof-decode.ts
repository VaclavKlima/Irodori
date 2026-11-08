import { createHash } from 'node:crypto'
import { lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { LinearAsset } from '../../shared/contracts'
import { AGENT_PREVIEW_LIMIT } from '../../shared/agent'
import {
  exportProofDecodePlan,
  requireExportAllocation,
  type ExportAdmission,
} from '../../shared/export-resources'
import { frameByteLength } from '../../shared/preview-frame'
import { neutralAdjustments } from '../../shared/adjustments'
import { noLensSettings } from '../../shared/lens'
import { processingMetadata } from '../processing/metadata'
import { renderHdrJpeg } from '../processing/hdr-jpeg'
import { encodeInspectionTransfer, type InspectionTransfer } from './inspection-transfer'

export interface OutputProofDecodeJob {
  width: number
  height: number
  hdr: boolean
  admission: ExportAdmission
  inspection?: InspectionTransfer
}
export interface OutputProofDecoded {
  width: number
  height: number
  byteLength: number
  sha256: string
  linear?: LinearAsset
  overview: { width: number; height: number; byteLength: number; sha256: string }
  inspection?: Awaited<ReturnType<typeof encodeInspectionTransfer>>
}

/** Runs only in the bundled Node decoder, after the exporter has exited. */
export async function decodeOutputProof(
  path: string,
  output: string,
  job: OutputProofDecodeJob,
): Promise<OutputProofDecoded> {
  sharp.cache(false)
  sharp.concurrency(1)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid output preview JPEG.')
  requireExportAllocation(
    exportProofDecodePlan(job.width, job.height, job.hdr, info.size, job.admission),
  )
  const tags = await sharp(path).metadata()
  if (
    tags.format !== 'jpeg' ||
    tags.width !== job.width ||
    tags.height !== job.height ||
    (tags.orientation ?? 1) !== 1
  )
    throw new Error('Output preview JPEG dimensions or orientation changed.')
  // libjpeg reads the independent primary, never a reconstruction or another scene rendition.
  const primary = await sharp(path)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const byteLength = frameByteLength(job.width, job.height)
  if (primary.info.channels !== 4 || primary.data.byteLength !== byteLength)
    throw new Error('Invalid decoded output preview primary.')
  await writeFile(join(output, 'primary.rgba'), primary.data, { flag: 'wx' })
  let linear: LinearAsset | undefined
  if (job.hdr) {
    const frame = await renderHdrJpeg(path, output, {
      metadata: { ...processingMetadata({}, []), orientation: 1 },
      settings: noLensSettings,
      revision: 0,
      adjustments: neutralAdjustments,
    })
    if (frame.width !== job.width || frame.height !== job.height || !frame.linear?.hdr)
      throw new Error('Invalid decoded output preview HDR content.')
    linear = frame.linear
  }
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  if (job.inspection) {
    const inspection = await encodeInspectionTransfer(
      primary.data,
      job,
      job.inspection,
      output,
      job.admission,
    )
    return {
      width: job.width,
      height: job.height,
      byteLength,
      sha256: hash(primary.data),
      linear,
      inspection,
      overview: { width: 1, height: 1, byteLength: 0, sha256: '' },
    }
  }
  let geometry = { width: 0, height: 0 }
  let overview: Buffer = Buffer.alloc(0)
  // Only the overview shrinks to meet its payload limit. The actual JPEG and
  // full-resolution decoded planes retain the requested dimensions and quality.
  for (const edge of [1024, 768, 512, 256]) {
    const scale = Math.min(1, edge / Math.max(job.width, job.height))
    geometry = {
      width: Math.max(1, Math.round(job.width * scale)),
      height: Math.max(1, Math.round(job.height * scale)),
    }
    overview = await sharp(primary.data, {
      raw: { width: job.width, height: job.height, channels: 4 },
    })
      .resize({ ...geometry, kernel: 'lanczos3' })
      .removeAlpha()
      .withIccProfile('srgb')
      .jpeg({ quality: 80, chromaSubsampling: '4:4:4' })
      .toBuffer()
    if (overview.byteLength <= AGENT_PREVIEW_LIMIT) break
  }
  if (overview.byteLength > AGENT_PREVIEW_LIMIT)
    throw new Error('Output preview overview exceeds its 1 MiB limit.')
  await writeFile(join(output, 'overview.jpg'), overview, { flag: 'wx' })
  return {
    width: job.width,
    height: job.height,
    byteLength,
    sha256: hash(primary.data),
    linear,
    overview: { ...geometry, byteLength: overview.byteLength, sha256: hash(overview) },
  }
}
