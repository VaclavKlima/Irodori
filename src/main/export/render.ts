import { createHash } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { ExifTool } from 'exiftool-vendored'
import { exportGeometry } from '../../shared/export'
import {
  neutralAdjustments,
  contrastModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
  blacksModule,
  type AdjustmentParameters,
} from '../../shared/adjustments'
import {
  contentHdr,
  adjustHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  SDR_TARGET,
  encodeHdr,
} from '../../shared/hdr'
import { frameByteLength } from '../../shared/preview-frame'
import { readHdrStrips } from '../processing/hdr-processing'
import { halfFloat, loadUltraHdr } from './codec'
import { resizeLinear } from './resize'
import type { ExportRenderJob } from './types'

export function rasterLinear(rgb: number[], a: AdjustmentParameters) {
  const value = rgb.map((v) => Math.max(0, v * 2 ** a.exposureEv))
  const y = value[0] * 0.2126 + value[1] * 0.7152 + value[2] * 0.0722
  let scale = y > 0 && y < 1 ? contrastModule.cpu(y, a.contrast) / y : 1
  for (const [amount, module] of [
    [a.highlights, highlightsModule],
    [a.shadows, shadowsModule],
    [a.whites, whitesModule],
  ] as const) {
    const current = y * scale
    if (amount !== 0 && current > 0) scale *= module.cpu(current, amount) / current
  }
  let pedestal = 0
  if (a.blacks > 0) pedestal = 0.04 * (a.blacks / 100) * Math.max(1 - (y * scale) / 0.18, 0) ** 3
  else if (a.blacks < 0 && y * scale > 0)
    scale *= blacksModule.cpu(y * scale, a.blacks) / (y * scale)
  return value.map((v) => Math.max(0, Math.min(1, v * scale + pedestal)))
}

/** Construct a small EXIF allowlist before HDR packaging; never copy source metadata wholesale. */
async function metadata(
  job: ExportRenderJob,
): Promise<Record<string, Record<string, string>> | undefined> {
  if (job.options.metadata === 'none' || job.source.photo.assetKind === 'derived') return undefined
  const tool = new ExifTool({ maxProcs: 1 })
  try {
    const tags = (await tool.readRaw(job.source.path, {
      readArgs: [
        '-n',
        '-Copyright',
        '-Artist',
        '-Make',
        '-Model',
        '-LensModel',
        '-DateTimeOriginal',
        '-FNumber',
        '-ExposureTime',
        '-ISO',
        '-FocalLength',
      ],
    })) as Record<string, unknown>
    const ifd0: Record<string, string> = {},
      ifd2: Record<string, string> = {}
    const copy = (name: string, dest: Record<string, string>, outputName = name) => {
      const value = tags[name]
      if ((typeof value === 'string' || typeof value === 'number') && String(value).length < 2048)
        dest[outputName] = String(value)
    }
    for (const name of ['Copyright', 'Artist']) copy(name, ifd0)
    if (job.options.metadata === 'camera-copyright') {
      for (const name of ['Make', 'Model']) copy(name, ifd0)
      for (const name of [
        'LensModel',
        'DateTimeOriginal',
        'FNumber',
        'ExposureTime',
        'FocalLength',
      ])
        copy(name, ifd2)
      copy('ISO', ifd2, 'ISOSpeedRatings')
    }
    return { IFD0: ifd0, IFD2: ifd2 }
  } finally {
    await tool.end()
  }
}

export async function renderExport(job: ExportRenderJob) {
  sharp.concurrency(1)
  sharp.cache(false)
  const a = job.source.processing.adjustments ?? neutralAdjustments
  const linearPath = join(job.directory, 'rendition.f32')
  const linear = await open(linearPath, 'wx')
  const channels = job.hdr ? 6 : 3
  let width: number, height: number
  try {
    const asset = job.source.processing.workingAsset?.hdr
    if (job.source.hdr) {
      if (!asset) throw new Error('HDR working asset was not prepared.')
      width = asset.width
      height = asset.height
      const primary = asset.source.display
        ? await sharp(job.source.path)
            .autoOrient()
            .toColourspace('scrgb')
            .ensureAlpha()
            .raw({ depth: 'float' })
            .toBuffer({ resolveWithObject: true })
        : undefined
      if (primary && (primary.info.width !== width || primary.info.height !== height))
        throw new Error('HDR JPEG primary geometry mismatch.')
      const base = primary
        ? new Float32Array(
            primary.data.buffer,
            primary.data.byteOffset,
            primary.data.byteLength / 4,
          )
        : undefined
      let sourceOffset = 0
      const wb = hdrAdjustmentMatrix(a, asset.whiteBalance) ?? undefined
      for await (const strip of readHdrStrips(job.source.processing.workingAsset!.path, asset)) {
        const pixels = new Float32Array((strip.length / 4) * channels)
        for (let i = 0; i < strip.length; i += 4) {
          const adjusted = adjustHdr([strip[i], strip[i + 1], strip[i + 2]], a, wb)
          const sdr = base
            ? rasterLinear(
                [base[sourceOffset + i], base[sourceOffset + i + 1], base[sourceOffset + i + 2]],
                a,
              )
            : outputHdr(adjusted, SDR_TARGET).rgb
          const hdr = job.hdr ? contentHdr(adjusted, asset.source).rgb : undefined
          const alpha = strip[i + 3]
          for (let c = 0; c < 3; c++) {
            pixels[(i / 4) * channels + c] = sdr[c] * alpha + 1 - alpha
            if (hdr) pixels[(i / 4) * channels + 3 + c] = hdr[c] * alpha + 1 - alpha
          }
        }
        await linear.writeFile(Buffer.from(pixels.buffer))
        sourceOffset += strip.length
      }
    } else {
      const input = sharp(job.source.path, {
        limitInputPixels: (512 * 1024 ** 2) / 16,
      }).autoOrient()
      const dimensions = await input.metadata()
      if (frameByteLength(dimensions.width, dimensions.height) * 4 > 512 * 1024 ** 2)
        throw new Error('This photo exceeds the floating-point export memory limit.')
      const { data, info } = await input
        .toColourspace('scrgb')
        .ensureAlpha()
        .raw({ depth: 'float' })
        .toBuffer({ resolveWithObject: true })
      width = info.width
      height = info.height
      const floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
      for (let top = 0; top < height; top += 64) {
        const pixels = new Float32Array(width * Math.min(64, height - top) * 3)
        for (let i = 0; i < pixels.length / 3; i++) {
          const offset = (top * width + i) * 4
          const rgb = rasterLinear([floats[offset], floats[offset + 1], floats[offset + 2]], a)
          const alpha = floats[offset + 3]
          for (let c = 0; c < 3; c++) pixels[i * 3 + c] = rgb[c] * alpha + 1 - alpha
        }
        await linear.writeFile(Buffer.from(pixels.buffer))
      }
    }
  } finally {
    await linear.close()
  }
  const geometry = exportGeometry(width!, height!, job.options.size)
  const pixels = geometry.width * geometry.height
  const rgb = Buffer.alloc(pixels * 3)
  const half = job.hdr ? new Uint16Array(pixels * 4) : undefined
  let contentHeadroom = 1.01
  await resizeLinear(
    linearPath,
    width!,
    height!,
    geometry.width,
    geometry.height,
    channels,
    (data, y) => {
      for (let x = 0; x < geometry.width; x++) {
        const dest = y * geometry.width + x
        for (let c = 0; c < 3; c++) {
          rgb[dest * 3 + c] = Math.round(
            encodeHdr(Math.max(0, Math.min(1, data[x * channels + c]))) * 255,
          )
          if (half) {
            const value = Math.max(0, Math.min(10, data[x * channels + 3 + c]))
            contentHeadroom = Math.max(contentHeadroom, value)
            half[dest * 4 + c] = halfFloat(value)
          }
        }
        if (half) half[dest * 4 + 3] = halfFloat(1)
      }
    },
  )
  const exif = await metadata(job)
  let encoder = sharp(rgb, { raw: { ...geometry, channels: 3 } }).withIccProfile('srgb')
  if (exif) encoder = encoder.withExif(exif)
  const sdr = await encoder
    .jpeg({
      quality: job.options.quality,
      chromaSubsampling: '4:4:4',
      progressive: false,
      optimiseCoding: true,
    })
    .toBuffer()
  let output = sdr
  if (half) {
    const codec = await loadUltraHdr()
    output = codec.encode(
      new Uint8Array(half.buffer),
      geometry.width,
      geometry.height,
      sdr,
      job.options.quality,
      contentHeadroom,
    )
    const inspected = codec.inspect(output)
    if (
      inspected.info[18] !== geometry.width ||
      inspected.info[19] !== geometry.height ||
      inspected.info[20] !== geometry.width ||
      inspected.info[21] !== geometry.height
    )
      throw new Error('Invalid HDR JPEG rendition geometry.')
    // A second independent JPEG decoder must see the exact supplied primary pixels.
    const decoded = await sharp(output).raw().toBuffer()
    const supplied = await sharp(sdr).raw().toBuffer()
    if (!decoded.equals(supplied))
      throw new Error('HDR packaging changed the supplied SDR primary.')
  }
  const info = await sharp(output).metadata()
  if (
    info.format !== 'jpeg' ||
    info.width !== geometry.width ||
    info.height !== geometry.height ||
    !info.icc ||
    info.isProgressive
  )
    throw new Error('Invalid exported JPEG.')
  const path = join(job.directory, 'output.jpg')
  await writeFile(path, output, { flag: 'wx' })
  // Retained only inside this disposable job directory, useful to correctness tests.
  await writeFile(join(job.directory, 'sdr.jpg'), sdr, { flag: 'wx' })
  return { path, sha256: createHash('sha256').update(output).digest('hex') }
}
