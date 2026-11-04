import {
  type AdjustmentParameters,
  type DisplayTransform,
  contrastModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
  blacksModule,
} from './adjustments'
import { adjustHdr, hdrAdjustmentMatrix } from './hdr'
import { workingToXyz, type ColorTriple } from './color-model'
import { whiteBalanceMatrix } from './white-balance'
import {
  applyToneCurves,
  curveChannels,
  evaluateToneCurve,
  identityToneCurves,
  preparedToneCurves,
  type CurveChannel,
} from './tone-curves'

export interface CurveToneRequest {
  channel: CurveChannel
  x: number
  y: number
}
export interface CurveTone {
  input: number
  output: number
  visibleSamples: number
  area: { x: number; y: number; width: number; height: number }
  width: number
  height: number
  referenceWhite: 1
}
export interface PhotoCurveTone extends CurveTone {
  photoId: string
  revision: number
  renderingIdentity: string
  channel: CurveChannel
}
export function validateCurveToneRequest(value: unknown): asserts value is CurveToneRequest {
  const v = value as CurveToneRequest | null
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== 'channel,x,y' ||
    !curveChannels.includes(v.channel) ||
    ![v.x, v.y].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
  )
    throw new Error('Choose a curve channel and normalized source coordinates between 0 and 1.')
}
export function curveToneArea(sample: CurveToneRequest, width: number, height: number) {
  validateCurveToneRequest(sample)
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('Curve sample dimensions unavailable.')
  const x = Math.min(width - 1, Math.floor(sample.x * width)),
    y = Math.min(height - 1, Math.floor(sample.y * height))
  const left = Math.max(0, x - 2),
    top = Math.max(0, y - 2)
  return {
    x: left,
    y: top,
    width: Math.min(width, x + 3) - left,
    height: Math.min(height, y + 3) - top,
  }
}

/** Only a bounded 5 × 5 sample: never a CPU image renderer or presentation fallback. */
export function sampledCurveTone(
  pixels: Float32Array,
  p: AdjustmentParameters,
  transform: DisplayTransform,
  hdr: boolean,
  channel: CurveChannel,
) {
  const primaries = hdr ? 'rec2020' : 'srgb',
    curves = preparedToneCurves(p.curves),
    master = preparedToneCurves({
      ...identityToneCurves,
      master: (p.curves ?? identityToneCurves).master,
    }),
    wb = hdr
      ? hdrAdjustmentMatrix(p, transform.whiteBalance)
      : whiteBalanceMatrix(p.whiteBalance, transform.whiteBalance),
    light = {
      ...p,
      curves: undefined,
      saturation: 0,
      vibrance: 0,
      colorMixer: undefined,
      colorGrading: undefined,
    }
  let sum = 0,
    count = 0
  if (pixels.length > 25 * 4 || pixels.length % 4) throw new Error('Invalid curve sample region.')
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] <= 0) continue
    let rgb: ColorTriple = [pixels[i], pixels[i + 1], pixels[i + 2]]
    if (![...rgb, pixels[i + 3]].every(Number.isFinite))
      throw new Error('The sampled tone is invalid.')
    if (hdr) rgb = adjustHdr([...rgb], light, wb ?? undefined)
    else {
      if (wb)
        rgb = [0, 1, 2].map(
          (row) => wb[row * 3] * rgb[0] + wb[row * 3 + 1] * rgb[1] + wb[row * 3 + 2] * rgb[2],
        ) as [number, number, number]
      rgb = rgb.map((v) => Math.max(0, v * 2 ** p.exposureEv) / transform.white) as [
        number,
        number,
        number,
      ]
      const y = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
      let scale = y > 0 && y < 1 ? contrastModule.cpu(y, p.contrast) / y : 1
      for (const [amount, operation] of [
        [p.highlights, highlightsModule.cpu],
        [p.shadows, shadowsModule.cpu],
        [p.whites, whitesModule.cpu],
      ] as const) {
        const next = y * scale
        if (amount && next > 0) scale *= operation(next, amount) / next
      }
      let pedestal = 0
      if (p.blacks > 0)
        pedestal = ((0.04 * p.blacks) / 100) * Math.max(1 - (y * scale) / 0.18, 0) ** 3
      else if (p.blacks < 0 && y * scale > 0)
        scale *= blacksModule.cpu(y * scale, p.blacks) / (y * scale)
      rgb = rgb.map((v) => v * scale + pedestal) as [number, number, number]
    }
    const input =
      channel === 'master'
        ? workingToXyz(rgb, primaries)[1]
        : applyToneCurves(rgb, master, primaries)[curveChannels.indexOf(channel) - 1]
    if (!Number.isFinite(input)) throw new Error('The sampled tone is invalid.')
    sum += input
    count++
  }
  if (!count) throw new Error('This area is transparent. Choose a visible tone.')
  const input = sum / count
  if (input < -16 || input > 64)
    throw new Error('This tone is outside the editable −1600%…6400% range. Choose another tone.')
  const output = evaluateToneCurve(curves[channel], input)
  if (!Number.isFinite(output) || output < -16 || output > 64)
    throw new Error(
      'The curve output at this tone is outside the editable range. Edit its points numerically.',
    )
  return { input, output, visibleSamples: count }
}
