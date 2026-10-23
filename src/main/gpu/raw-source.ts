import type { WhiteBalanceProfile } from '../../shared/white-balance'
import type { DisplayTransform } from '../../shared/adjustments'
// LibRaw 0.22.1 processing policy adapted under CDDL-1.0. See third_party/libraw.
import { cameraProfile } from '../processing/cameras'

/** Sensor getters shared by live LibRaw and validated native snapshots. */
export interface RawSensorReader {
  getIParams(): { normalized_make: string; normalized_model: string }
  getColors(): number
  getIsFoveon(): boolean
  getPixelAspect(): number
  getCblack(index: number): number
  getRawImage(): Uint16Array<ArrayBuffer> | null
  color(row: number, column: number): number
  getBlackLevel(index: number): number
  getCamMul(index: number): number
  getRgbCam(row: number, column: number): number
  getActiveWidth(): number
  getActiveHeight(): number
  getRawWidth(): number
  getLeftMargin(): number
  getTopMargin(): number
  getColorMaximum(): number
  getBlack(): number
  getLinearMax(index: number): number
  getFlip(): number
}

export interface RawSource {
  normalization?: import('../../shared/hdr').HdrNormalization
  whiteBalance?: WhiteBalanceProfile
  pixels: Uint16Array<ArrayBuffer>
  width: number
  height: number
  rawWidth: number
  left: number
  top: number
  flip: number
  cfa: number[]
  black: number[]
  scale: number[]
  matrix: number[]
}

/** Only enable camera models whose Bayer output has been compared against LibRaw. */
export function readGpuSource(decoder: RawSensorReader, hdr = false): RawSource | null {
  const camera = decoder.getIParams()
  const profile = cameraProfile(camera.normalized_make, camera.normalized_model)
  if (
    !profile?.gpu ||
    decoder.getColors() !== profile.gpu.colors ||
    decoder.getIsFoveon() ||
    decoder.getPixelAspect() !== profile.gpu.pixelAspect ||
    decoder.getCblack(4) !== 0 ||
    decoder.getCblack(5) !== 0
  )
    return null
  const pixels = decoder.getRawImage()
  if (!pixels) return null
  const cfa = [decoder.color(0, 0), decoder.color(0, 1), decoder.color(1, 0), decoder.color(1, 1)]
  if (cfa.join() !== profile.gpu.cfa.join()) return null
  const black = [0, 1, 2, 3].map((c) => decoder.getBlackLevel(c))
  const wb = [0, 1, 2, 3].map((c) => decoder.getCamMul(c))
  const matrix = [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => decoder.getRgbCam(r, c)))
  if (
    ![...black, ...wb, ...matrix].every(Number.isFinite) ||
    wb.some((v) => v <= 0) ||
    wb[1] !== wb[3]
  )
    return null
  const width = decoder.getActiveWidth(),
    height = decoder.getActiveHeight()
  const rawWidth = decoder.getRawWidth(),
    left = decoder.getLeftMargin(),
    top = decoder.getTopMargin()
  if (left + width > rawWidth || (top + height) * rawWidth > pixels.length) return null
  // LibRaw's default maximum adjustment uses the observed, black-subtracted maximum
  // when it is close enough to the nominal sensor saturation level.
  let observed = 0
  // HDR and merge normalization always use sensor white, independently of scene maxima.
  if (!hdr)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const c = cfa[(y % 2) * 2 + (x % 2)]
        observed = Math.max(observed, pixels[(y + top) * rawWidth + left + x] - black[c])
      }
  const nominal = decoder.getColorMaximum() - decoder.getBlack()
  const maximum = !hdr && observed > nominal * 0.75 && observed < nominal ? observed : nominal
  const saturation = maximum
  if (saturation <= 0) return null
  const minimumWb = hdr ? Math.max(...wb) : Math.min(...wb)
  const scale = wb.map((v) =>
    Math.fround(Math.fround(Math.fround(v / minimumWb) * 65535) / saturation),
  )
  const thresholds = [0, 1, 2, 3].map((c) => decoder.getLinearMax(c))
  const known = thresholds.every((v, c) => Number.isFinite(v) && v > black[c])
  let saturatedSites = 0
  if (hdr && known)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (pixels[(y + top) * rawWidth + left + x] >= thresholds[cfa[(y % 2) * 2 + (x % 2)]])
          saturatedSites++
  return {
    normalization: hdr
      ? {
          black,
          maximum,
          gains: wb,
          restoreGain: Math.max(...wb) / Math.min(...wb),
          referenceWhite: 1,
          sourceSaturation: known
            ? { thresholds, saturatedSites, totalSites: width * height }
            : null,
        }
      : undefined,
    pixels,
    width,
    height,
    rawWidth,
    left,
    top,
    flip: decoder.getFlip(),
    cfa,
    black,
    scale,
    matrix,
  }
}

/** LibRaw's SDR display curve, including its histogram-based automatic brightness. */
export function displayTransform(histogram: Uint32Array, pixels: number): DisplayTransform {
  let white = 32
  const percentile = Math.trunc(pixels * 0.01)
  for (let c = 0; c < 3; c++) {
    let total = 0,
      value = 8191
    for (; value > 32; value--) if ((total += histogram[c * 8192 + value]) > percentile) break
    white = Math.max(white, value)
  }
  const power = 1 / 2.4,
    slope = 12.92
  const bounds = [0, 1]
  let toe = 0
  for (let i = 0; i < 48; i++) {
    toe = (bounds[0] + bounds[1]) / 2
    bounds[Number((Math.pow(toe / slope, -power) - 1) / power - 1 / toe > -1)] = toe
  }
  const threshold = toe / slope,
    offset = toe * (1 / power - 1)
  return { white: (white * 8) / 65535, threshold, offset, quantize: true }
}
export function displayCurve(histogram: Uint32Array, pixels: number): Uint32Array<ArrayBuffer> {
  const { white, threshold, offset } = displayTransform(histogram, pixels)
  const power = 1 / 2.4,
    slope = 12.92
  const curve = new Uint32Array(65536)
  for (let i = 0; i < curve.length; i++) {
    const r = i / (white * 65535)
    curve[i] =
      r >= 1
        ? 255
        : Math.trunc(
            65536 * (r < threshold ? r * slope : Math.pow(r, power) * (1 + offset) - offset),
          ) >> 8
  }
  return curve
}
