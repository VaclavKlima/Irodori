import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { loadUltraHdr } from '../export/codec'
import { neutralAdjustments, srgbTransform } from '../../shared/adjustments'
import {
  HDR_JPEG_SOURCE_VERSION,
  SRGB_TO_2020,
  matrixRgb,
  validateHdrSource,
  type HdrWorkingAsset,
} from '../../shared/hdr'
import { frameByteLength } from '../../shared/preview-frame'
import type { ProcessingMetadata, ProcessingOptions } from '../../shared/lens'
import type { FullPreviewResult } from '../preview-types'

const namespace = Buffer.from('urn:iso:std:iso:ts:21496:-1\0')
const limit = 256 * 1024 ** 2
let codec: ReturnType<typeof loadUltraHdr> | undefined
const decoder = () =>
  (codec ??= loadUltraHdr().catch((error) => {
    codec = undefined
    throw error
  }))

/** Recognition is based on a container marker, never on the filename or EXIF camera name. */
export function hasIsoGainMap(bytes: Buffer) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return false
  for (let p = 2; p + 4 <= bytes.length;) {
    if (bytes[p] !== 255) return false
    const marker = bytes[p + 1]
    if (marker === 218 || marker === 217) return false
    const length = bytes.readUInt16BE(p + 2)
    if (length < 2 || p + length + 2 > bytes.length) return false
    if (marker === 226 && bytes.subarray(p + 4, p + 4 + namespace.length).equals(namespace))
      return true
    p += length + 2
  }
  return false
}

async function readJpeg(path: string) {
  if ((await stat(path)).size > limit) throw new Error('HDR JPEG exceeds the 256 MiB input limit.')
  const bytes = await readFile(path)
  if (bytes.byteLength > limit) throw new Error('HDR JPEG exceeds the 256 MiB input limit.')
  return bytes
}

export async function inspectHdrJpeg(path: string): Promise<ProcessingMetadata['hdrJpeg']> {
  if (!['.jpg', '.jpeg'].includes(extname(path).toLowerCase())) return undefined
  // A bounded prefix suffices for normal JPEG metadata. Large ordinary JPEGs do
  // not allocate a codec heap merely to establish SDR interpretation.
  const file = await open(path, 'r')
  const prefix = Buffer.alloc(1024 * 1024)
  let found: boolean
  try {
    const result = await file.read(prefix)
    found = hasIsoGainMap(prefix.subarray(0, result.bytesRead))
  } finally {
    await file.close()
  }
  if (!found) return undefined
  try {
    const info = (await decoder()).inspect(await readJpeg(path)).info
    if (
      frameByteLength(info[18], info[19]) * 4 > 512 * 1024 ** 2 ||
      info[20] < 1 ||
      info[21] < 1 ||
      info[20] > info[18] ||
      info[21] > info[19] ||
      !info.slice(0, 17).every(Number.isFinite) ||
      info[15] !== 1 ||
      !Number.isFinite(info[16]) ||
      info[16] < 1 ||
      info[16] > 10.0001
    )
      throw new Error('Unsupported HDR gain-map dimensions or headroom.')
    return { version: 1, state: 'supported', headroom: info[16] }
  } catch (error) {
    return {
      version: 1,
      state: 'sdr-only',
      reason: `HDR gain map unavailable; displaying SDR: ${String(error).slice(0, 240)}`,
    }
  }
}

function fromHalf(value: number) {
  const sign = value & 0x8000 ? -1 : 1,
    exponent = (value >> 10) & 31,
    mantissa = value & 1023
  return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24)
}
const p3To2020 = [
  0.753833, 0.198597, 0.04757, 0.045744, 0.941777, 0.012479, -0.00121, 0.017602, 0.983609,
]

/** Decode the complete authored HDR rendition, independent of monitor headroom. */
export async function renderHdrJpeg(
  path: string,
  output: string,
  options: ProcessingOptions,
): Promise<FullPreviewResult> {
  const bytes = await readJpeg(path)
  const result = (await decoder()).inspect(bytes, 100)
  const [nativeWidth, nativeHeight] = result.info.slice(18, 20)
  const orientation = options.metadata.orientation ?? 1
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8)
    throw new Error('Invalid JPEG orientation.')
  const width = orientation >= 5 ? nativeHeight : nativeWidth,
    height = orientation >= 5 ? nativeWidth : nativeHeight
  const byteLength = frameByteLength(width, height) * 4
  if (
    byteLength > 512 * 1024 ** 2 ||
    !result.pixels ||
    !result.stride ||
    ![0, 1, 2].includes(result.gamut!)
  )
    throw new Error('Unsupported HDR JPEG decoder output.')
  const digest = createHash('sha256'),
    strips: HdrWorkingAsset['strips'] = []
  const file = await open(join(output, 'linear.f32'), 'wx')
  try {
    for (let top = 0; top < height; top += 64) {
      const data = new Float32Array(width * Math.min(64, height - top) * 4)
      for (let y = top; y < Math.min(top + 64, height); y++)
        for (let x = 0; x < width; x++) {
          const sx =
            orientation === 2 || orientation === 3
              ? nativeWidth - 1 - x
              : orientation === 5 || orientation === 6
                ? y
                : orientation === 7 || orientation === 8
                  ? nativeWidth - 1 - y
                  : x
          const sy =
            orientation === 3 || orientation === 4
              ? nativeHeight - 1 - y
              : orientation === 6 || orientation === 7
                ? nativeHeight - 1 - x
                : orientation === 5 || orientation === 8
                  ? x
                  : y
          const index = (sy * result.stride + sx) * 4
          let rgb = [0, 1, 2].map((c) => fromHalf(result.pixels![index + c])) as [
            number,
            number,
            number,
          ]
          if (result.gamut === 0) rgb = matrixRgb(SRGB_TO_2020, rgb)
          else if (result.gamut === 1) rgb = matrixRgb(p3To2020, rgb)
          if (!rgb.every((v) => Number.isFinite(v) && Math.abs(v) <= 100))
            throw new Error('Invalid HDR JPEG pixels.')
          data.set([...rgb, 1], ((y - top) * width + x) * 4)
        }
      const strip = Buffer.from(data.buffer)
      digest.update(strip)
      strips.push({
        byteLength: strip.byteLength,
        sha256: createHash('sha256').update(strip).digest('hex'),
      })
      await file.writeFile(strip)
    }
  } finally {
    await file.close()
  }
  const asset: HdrWorkingAsset = {
    kind: 'hdr-working-v1',
    width,
    height,
    byteLength,
    sha256: digest.digest('hex'),
    strips,
    source: {
      version: HDR_JPEG_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      orientation: 'applied-once',
      decoder: 'libultrahdr-2.0.2',
      display: { encoding: 'iso-21496-1-jpeg', headroom: result.info[16], referenceWhiteNits: 203 },
      normalization: { referenceWhite: 1, sourceSaturation: null },
    },
  }
  validateHdrSource(asset.source)
  return {
    width,
    height,
    byteLength: 0,
    format: 'hdr-working',
    sha256: asset.sha256,
    placeholderBytes: 0,
    linear: { byteLength, sha256: asset.sha256, transform: srgbTransform, hdr: asset },
    adjustments: options.adjustments ?? neutralAdjustments,
    settingsRevision: options.revision,
    renderId: `${HDR_JPEG_SOURCE_VERSION}-${asset.sha256}`,
  }
}
