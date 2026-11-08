import { createHash } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { encodeHdr } from '../../shared/hdr'
import {
  exportInputMemoryPlan,
  exportSdrEncodePlan,
  requireExportAllocation,
  type ExportAdmission,
} from '../../shared/export-resources'
import { resizeLinearGpu } from './resize'

export interface InspectionTransfer {
  bounds: { x: number; y: number; width: number; height: number }
  width: number
  height: number
  encoding: { format: 'jpeg' | 'png'; quality?: number }
}

/** Bundled Node only: extract from the decoded complete JPEG, then encode the transfer image. */
export async function encodeInspectionTransfer(
  primary: Buffer,
  source: { width: number; height: number },
  transfer: InspectionTransfer,
  directory: string,
  admission: ExportAdmission,
) {
  const { bounds, width, height, encoding } = transfer,
    resizing = width !== bounds.width || height !== bounds.height,
    held: ExportAdmission = {
      policy: admission.policy,
      reservation: {
        ramBytes: admission.reservation.ramBytes + primary.byteLength,
        vramBytes: admission.reservation.vramBytes,
      },
    }
  requireExportAllocation(exportInputMemoryPlan(bounds.width, bounds.height, held))
  const extract = () =>
    sharp(primary, { raw: { ...source, channels: 4 } }).extract({
      left: bounds.x,
      top: bounds.y,
      width: bounds.width,
      height: bounds.height,
    })
  let rgb: Buffer
  if (!resizing) {
    // No color conversion or filtering at native size: PNG preserves decoded JPEG pixels.
    rgb = await extract().removeAlpha().raw().toBuffer()
  } else {
    const linearPath = join(directory, 'inspection-transfer.f32')
    try {
      const linear = await extract()
        .removeAlpha()
        .toColourspace('scrgb')
        .raw({ depth: 'float' })
        .toBuffer()
      await writeFile(linearPath, linear, { flag: 'wx' })
      rgb = Buffer.alloc(width * height * 3)
      await resizeLinearGpu(
        linearPath,
        bounds.width,
        bounds.height,
        width,
        height,
        3,
        (row, y) => {
          for (let i = 0; i < row.length; i++)
            rgb[y * width * 3 + i] = Math.round(encodeHdr(Math.max(0, Math.min(1, row[i]))) * 255)
        },
        {
          policy: held.policy,
          reservation: {
            ramBytes: held.reservation.ramBytes + linear.byteLength + rgb.byteLength,
            vramBytes: held.reservation.vramBytes,
          },
        },
      )
    } finally {
      await rm(linearPath, { force: true })
    }
  }
  requireExportAllocation(exportSdrEncodePlan(width, height, held))
  let encoder = sharp(rgb, { raw: { width, height, channels: 3 } }).withIccProfile('srgb')
  encoder =
    encoding.format === 'png'
      ? encoder.png()
      : encoder.jpeg({ quality: encoding.quality, chromaSubsampling: '4:4:4' })
  const bytes = await encoder.toBuffer()
  if (bytes.byteLength > 8 * 1024 ** 2)
    throw new Error(
      'Inspection exceeds the 8 MiB image payload limit. Request a smaller region, lower resolution percentage or lower JPEG quality.',
    )
  const path = join(directory, `inspection.${encoding.format === 'png' ? 'png' : 'jpg'}`)
  await writeFile(path, bytes, { flag: 'wx' })
  return {
    width,
    height,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: encoding.format === 'png' ? ('image/png' as const) : ('image/jpeg' as const),
  }
}
