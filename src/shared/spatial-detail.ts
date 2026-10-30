import { RGB_TO_XYZ, type ColorPrimaries } from './color-model'
import { frameByteLength, MAX_FRAME_BYTES } from './preview-frame'

export const NOISE_REDUCTION_VERSION = 'linear-asinh-opponent-nlm7-patch3-h048-v1'
export const DETAIL_SHARPENING_VERSION = 'linear-asinh-luminance-gaussian-protected-3pct-v1'
export const SPATIAL_DETAIL_VERSION = `${NOISE_REDUCTION_VERSION}_${DETAIL_SHARPENING_VERSION}`
/** Prepared reference WB and lens correction precede this native-grid stage. */
export const SPATIAL_DETAIL_STAGE = 'prepared-native-reference-before-geometry-wb-v1'
export const DETAIL_REFERENCE = 0.18
export const NOISE_SEARCH_RADIUS = 3
export const NOISE_PATCH_RADIUS = 1
export const NOISE_HALO = NOISE_SEARCH_RADIUS + NOISE_PATCH_RADIUS
export const DETAIL_TILE_EDGE = 256
export const DETAIL_MAX_SHARPEN_RADIUS = 3
export const DETAIL_MAX_SHARPEN_SUPPORT = 9
export const DETAIL_MAX_STAGE_EDGE = DETAIL_TILE_EDGE + 2 * DETAIL_MAX_SHARPEN_SUPPORT
export const DETAIL_MAX_WINDOW_EDGE = DETAIL_MAX_STAGE_EDGE + 2 * NOISE_HALO
export const NOISE_SPATIAL_WEIGHTS = Object.freeze(
  Array.from({ length: 49 }, (_, i) => {
    const x = (i % 7) - 3,
      y = Math.floor(i / 7) - 3
    return Math.exp(-(x * x + y * y) / 8)
  }),
)

export interface NoiseReductionSettings {
  readonly version: 1
  readonly luminance: number
  readonly chroma: number
}
export interface DetailSharpeningSettings {
  readonly version: 1
  readonly amount: number
  /** Gaussian sigma in prepared source pixels. */
  readonly radius: number
  readonly threshold: number
}
export const neutralNoiseReduction: NoiseReductionSettings = Object.freeze({
  version: 1,
  luminance: 0,
  chroma: 0,
})
export const neutralDetailSharpening: DetailSharpeningSettings = Object.freeze({
  version: 1,
  amount: 0,
  radius: 1,
  threshold: 50,
})
export interface DetailSize {
  readonly width: number
  readonly height: number
}
export interface DetailRectangle extends DetailSize {
  readonly left: number
  readonly top: number
}
export interface DetailSourceWindow extends DetailRectangle {
  readonly data: Float32Array
}

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key))
const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
export function validateNoiseReduction(value: unknown): asserts value is NoiseReductionSettings {
  if (
    !exact(value, ['version', 'luminance', 'chroma']) ||
    value.version !== 1 ||
    !amount(value.luminance) ||
    !amount(value.chroma)
  )
    throw new Error('Invalid noise reduction settings.')
}
export function validateDetailSharpening(
  value: unknown,
): asserts value is DetailSharpeningSettings {
  if (
    !exact(value, ['version', 'amount', 'radius', 'threshold']) ||
    value.version !== 1 ||
    !amount(value.amount) ||
    !amount(value.threshold) ||
    typeof value.radius !== 'number' ||
    !Number.isFinite(value.radius) ||
    value.radius < 0.5 ||
    value.radius > DETAIL_MAX_SHARPEN_RADIUS ||
    Math.abs(value.radius * 10 - Math.round(value.radius * 10)) > 1e-8
  )
    throw new Error('Invalid detail sharpening settings.')
}

export interface CompiledNoiseReduction {
  readonly settings: NoiseReductionSettings
  readonly active: boolean
  readonly luminance: boolean
  readonly chroma: boolean
  readonly inverseLuminanceBandwidth2: number
  readonly inverseChromaBandwidth2: number
  readonly spatial: readonly number[]
}
export interface CompiledDetailSharpening {
  readonly settings: DetailSharpeningSettings
  readonly active: boolean
  readonly support: number
  readonly gain: number
  readonly threshold2: number
  readonly gaussian: readonly number[]
}
export function compileNoiseReduction(settings: NoiseReductionSettings): CompiledNoiseReduction {
  validateNoiseReduction(settings)
  const hL = 0.048 * (settings.luminance / 100) ** 2,
    hC = 0.16 * (settings.chroma / 100) ** 2
  return Object.freeze({
    settings: Object.freeze({ ...settings }),
    active: hL > 0 || hC > 0,
    luminance: hL > 0,
    chroma: hC > 0,
    inverseLuminanceBandwidth2: hL ? 1 / hL ** 2 : 0,
    inverseChromaBandwidth2: hC ? 1 / hC ** 2 : 0,
    spatial: NOISE_SPATIAL_WEIGHTS,
  })
}
export function compileDetailSharpening(
  settings: DetailSharpeningSettings,
): CompiledDetailSharpening {
  validateDetailSharpening(settings)
  const support = Math.ceil(3 * settings.radius)
  return Object.freeze({
    settings: Object.freeze({ ...settings }),
    active: settings.amount > 0,
    support,
    gain: settings.amount / 100,
    threshold2: ((0.08 * settings.threshold) / 100) ** 2,
    gaussian: Object.freeze(
      Array.from({ length: 2 * support + 1 }, (_, i) =>
        Math.exp(-((i - support) ** 2) / (2 * settings.radius ** 2)),
      ),
    ),
  })
}
export function detailLuminance(primaries: ColorPrimaries): readonly [number, number, number] {
  if (!Object.hasOwn(RGB_TO_XYZ, primaries))
    throw new Error('Unsupported detail processing primaries.')
  return RGB_TO_XYZ[primaries][1]
}
export function detailSourceBounds(
  image: DetailSize,
  tile: DetailRectangle,
  halo: number,
): DetailRectangle {
  if (frameByteLength(image.width, image.height) * 4 > MAX_FRAME_BYTES)
    throw new Error('Detail source exceeds the floating-point image limit.')
  if (
    ![tile.left, tile.top, tile.width, tile.height, halo].every(Number.isSafeInteger) ||
    tile.left < 0 ||
    tile.top < 0 ||
    tile.width < 1 ||
    tile.height < 1 ||
    halo < 0 ||
    halo > NOISE_HALO + DETAIL_MAX_SHARPEN_SUPPORT ||
    tile.width > DETAIL_MAX_STAGE_EDGE ||
    tile.height > DETAIL_MAX_STAGE_EDGE ||
    tile.left + tile.width > image.width ||
    tile.top + tile.height > image.height
  )
    throw new Error('Invalid detail processing tile.')
  const left = Math.max(0, tile.left - halo),
    top = Math.max(0, tile.top - halo)
  return {
    left,
    top,
    width: Math.min(image.width, tile.left + tile.width + halo) - left,
    height: Math.min(image.height, tile.top + tile.height + halo) - top,
  }
}

/** Validate bounded input before feature/output allocations. Callers own source leases and admission. */
export function validateDetailLayout(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailRectangle,
  halo: number,
): void {
  const required = detailSourceBounds(image, tile, halo)
  if (
    ![source.left, source.top, source.width, source.height].every(Number.isSafeInteger) ||
    source.left < 0 ||
    source.top < 0 ||
    source.width < 1 ||
    source.height < 1 ||
    source.width > DETAIL_MAX_WINDOW_EDGE ||
    source.height > DETAIL_MAX_WINDOW_EDGE ||
    source.left + source.width > image.width ||
    source.top + source.height > image.height ||
    source.left > required.left ||
    source.top > required.top ||
    source.left + source.width < required.left + required.width ||
    source.top + source.height < required.top + required.height
  )
    throw new Error('Incomplete or unbounded detail source window.')
}
export function validateDetailWindow(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  halo: number,
): void {
  validateDetailLayout(image, tile, source, halo)
  if (
    !(source.data instanceof Float32Array) ||
    !(source.data.buffer instanceof ArrayBuffer) ||
    source.data.length !== source.width * source.height * 4
  )
    throw new Error('Incomplete or unbounded detail source window.')
  for (let i = 0; i < source.data.length; i++)
    if (
      !Number.isFinite(source.data[i]) ||
      (i % 4 === 3 && (source.data[i] < 0 || source.data[i] > 1))
    )
      throw new Error('Invalid detail source pixels.')
}

/** Stable inverse-coordinate difference; exact zero does not reconstruct unchanged channels. */
export function detailCoordinateDelta(value: number, scale: number, delta: number): number {
  if (delta === 0) return 0
  const half = Math.sinh(delta / 2)
  return value * 2 * half * half + Math.hypot(value, scale) * Math.sinh(delta)
}
export interface DetailFeatures extends DetailRectangle {
  readonly data: Float64Array
  readonly luminance: readonly [number, number, number]
}
function prepareDetailFeatures(
  source: DetailSourceWindow,
  primaries: ColorPrimaries,
  opponents = true,
): DetailFeatures {
  const luminance = detailLuminance(primaries),
    data = new Float64Array(source.data.length)
  for (let i = 0; i < data.length; i += 4) {
    const y =
        source.data[i] * luminance[0] +
        source.data[i + 1] * luminance[1] +
        source.data[i + 2] * luminance[2],
      scale = Math.hypot(y, DETAIL_REFERENCE)
    data[i] = Math.asinh(y / DETAIL_REFERENCE)
    if (opponents) {
      data[i + 1] = Math.asinh((source.data[i] - y) / scale)
      data[i + 2] = Math.asinh((source.data[i + 2] - y) / scale)
    }
    data[i + 3] = source.data[i + 3]
  }
  return { ...source, data, luminance }
}
type Destination = Float32Array | Float64Array
function destination(
  tile: DetailRectangle,
  source: DetailSourceWindow,
  output?: Destination,
): Destination {
  if (
    output &&
    (output.length !== tile.width * tile.height * 4 || output.buffer === source.data.buffer)
  )
    throw new Error('Invalid detail tile destination.')
  return output ?? new Float32Array(tile.width * tile.height * 4)
}
function copyPixel(source: Float32Array, at: number, output: Destination, target: number): void {
  for (let c = 0; c < 4; c++) output[target + c] = source[at + c]
}

export function denoiseDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  parameters: CompiledNoiseReduction,
  primaries: ColorPrimaries,
  output: Float64Array,
): Float64Array
export function denoiseDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  parameters: CompiledNoiseReduction,
  primaries: ColorPrimaries,
  output?: Float32Array,
): Float32Array
export function denoiseDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  parameters: CompiledNoiseReduction,
  primaries: ColorPrimaries,
  output?: Destination,
): Destination {
  validateDetailWindow(image, tile, source, parameters.active ? NOISE_HALO : 0)
  const luminance = detailLuminance(primaries),
    result = destination(tile, source, output),
    features = parameters.active ? prepareDetailFeatures(source, primaries).data : undefined,
    index = (x: number, y: number) =>
      ((Math.max(0, Math.min(image.height - 1, y)) - source.top) * source.width +
        Math.max(0, Math.min(image.width - 1, x)) -
        source.left) *
      4
  for (let y = 0; y < tile.height; y++)
    for (let x = 0; x < tile.width; x++) {
      const gx = tile.left + x,
        gy = tile.top + y,
        center = index(gx, gy),
        target = (y * tile.width + x) * 4
      if (!features || source.data[center + 3] === 0) {
        copyPixel(source.data, center, result, target)
        continue
      }
      let sumL = 0,
        sumA = 0,
        sumB = 0,
        weightL = 0,
        weightC = 0
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const neighbor = index(gx + dx, gy + dy),
            alpha = features[neighbor + 3]
          if (alpha === 0) continue
          let distanceL = 0,
            distanceC = 0,
            coverage = 0
          for (let py = -1; py <= 1; py++)
            for (let px = -1; px <= 1; px++) {
              const p = index(gx + px, gy + py),
                q = index(gx + dx + px, gy + dy + py),
                a = features[p + 3] * features[q + 3]
              if (a === 0) continue
              const dl = features[p] - features[q],
                da = features[p + 1] - features[q + 1],
                db = features[p + 2] - features[q + 2]
              coverage += a
              distanceL += a * dl * dl
              distanceC += a * (da * da + db * db)
            }
          if (coverage === 0) continue
          distanceL /= coverage
          distanceC /= coverage
          const spatial = parameters.spatial[(dy + 3) * 7 + dx + 3] * alpha,
            wl = parameters.luminance
              ? spatial *
                Math.exp(
                  -distanceL * parameters.inverseLuminanceBandwidth2 - distanceC / (0.12 * 0.12),
                )
              : 0,
            wc = parameters.chroma
              ? spatial *
                Math.exp(
                  -distanceL / (0.08 * 0.08) - distanceC * parameters.inverseChromaBandwidth2,
                )
              : 0
          weightL += wl
          weightC += wc
          sumL += wl * (features[neighbor] - features[center])
          sumA += wc * (features[neighbor + 1] - features[center + 1])
          sumB += wc * (features[neighbor + 2] - features[center + 2])
        }
      const red = source.data[center],
        green = source.data[center + 1],
        blue = source.data[center + 2],
        enteringY = red * luminance[0] + green * luminance[1] + blue * luminance[2],
        scale = Math.hypot(enteringY, DETAIL_REFERENCE),
        dl = parameters.luminance
          ? detailCoordinateDelta(enteringY, DETAIL_REFERENCE, sumL / weightL)
          : 0,
        da = parameters.chroma ? detailCoordinateDelta(red - enteringY, scale, sumA / weightC) : 0,
        db = parameters.chroma ? detailCoordinateDelta(blue - enteringY, scale, sumB / weightC) : 0
      if (dl === 0 && da === 0 && db === 0) {
        copyPixel(source.data, center, result, target)
        continue
      }
      result[target] = red + dl + da
      result[target + 1] = green + dl - (luminance[0] * da + luminance[2] * db) / luminance[1]
      result[target + 2] = blue + dl + db
      result[target + 3] = source.data[center + 3]
      if (
        !Number.isFinite(result[target]) ||
        !Number.isFinite(result[target + 1]) ||
        !Number.isFinite(result[target + 2])
      )
        throw new Error('Detail filtering exceeds the finite pixel range.')
    }
  return result
}

export function sharpenDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  parameters: CompiledDetailSharpening,
  primaries: ColorPrimaries,
  output: Float64Array,
): Float64Array
export function sharpenDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  parameters: CompiledDetailSharpening,
  primaries: ColorPrimaries,
  output?: Float32Array,
): Float32Array
export function sharpenDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  parameters: CompiledDetailSharpening,
  primaries: ColorPrimaries,
  output?: Destination,
): Destination {
  validateDetailWindow(image, tile, source, parameters.active ? parameters.support : 0)
  const luminance = detailLuminance(primaries),
    result = destination(tile, source, output),
    features = parameters.active ? prepareDetailFeatures(source, primaries, false).data : undefined,
    index = (x: number, y: number) =>
      ((Math.max(0, Math.min(image.height - 1, y)) - source.top) * source.width +
        Math.max(0, Math.min(image.width - 1, x)) -
        source.left) *
      4
  for (let y = 0; y < tile.height; y++)
    for (let x = 0; x < tile.width; x++) {
      const gx = tile.left + x,
        gy = tile.top + y,
        center = index(gx, gy),
        target = (y * tile.width + x) * 4
      if (!features || source.data[center + 3] === 0) {
        copyPixel(source.data, center, result, target)
        continue
      }
      const enteringY =
          source.data[center] * luminance[0] +
          source.data[center + 1] * luminance[1] +
          source.data[center + 2] * luminance[2],
        support = parameters.support
      let difference = 0,
        total = 0,
        low = enteringY,
        high = enteringY
      for (let dy = -support; dy <= support; dy++)
        for (let dx = -support; dx <= support; dx++) {
          const at = index(gx + dx, gy + dy),
            alpha = features[at + 3]
          if (alpha === 0) continue
          const weight =
              parameters.gaussian[dx + support] * parameters.gaussian[dy + support] * alpha,
            yy =
              source.data[at] * luminance[0] +
              source.data[at + 1] * luminance[1] +
              source.data[at + 2] * luminance[2]
          difference += weight * (features[center] - features[at])
          total += weight
          low = Math.min(low, yy)
          high = Math.max(high, yy)
        }
      const d = difference / total,
        protectedAmount = d === 0 ? 0 : (d * d) / (d * d + parameters.threshold2),
        proposed =
          enteringY +
          detailCoordinateDelta(enteringY, DETAIL_REFERENCE, parameters.gain * d * protectedAmount),
        limit = (high - low) * 0.03,
        delta = Math.max(low - limit, Math.min(high + limit, proposed)) - enteringY
      if (delta === 0) {
        copyPixel(source.data, center, result, target)
        continue
      }
      result[target] = source.data[center] + delta
      result[target + 1] = source.data[center + 1] + delta
      result[target + 2] = source.data[center + 2] + delta
      result[target + 3] = source.data[center + 3]
      if (
        !Number.isFinite(result[target]) ||
        !Number.isFinite(result[target + 1]) ||
        !Number.isFinite(result[target + 2])
      )
        throw new Error('Detail sharpening exceeds the finite pixel range.')
    }
  return result
}

export function spatialDetailSourceBounds(
  image: DetailSize,
  tile: DetailRectangle,
  noise: CompiledNoiseReduction,
  sharpening: CompiledDetailSharpening,
): DetailRectangle {
  if (tile.width > DETAIL_TILE_EDGE || tile.height > DETAIL_TILE_EDGE)
    throw new Error('Invalid combined detail tile.')
  return detailSourceBounds(
    image,
    tile,
    (noise.active ? NOISE_HALO : 0) + (sharpening.active ? sharpening.support : 0),
  )
}

/** Publish Float32 between operators; padding is computed in native coordinates, never tile coordinates. */
export function spatialDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  noise: CompiledNoiseReduction,
  sharpening: CompiledDetailSharpening,
  primaries: ColorPrimaries,
  output?: Float32Array,
): Float32Array {
  if (
    output &&
    (output.length !== tile.width * tile.height * 4 || output.buffer === source.data.buffer)
  )
    throw new Error('Invalid combined detail destination.')
  spatialDetailSourceBounds(image, tile, noise, sharpening)
  validateDetailWindow(
    image,
    tile,
    source,
    (noise.active ? NOISE_HALO : 0) + (sharpening.active ? sharpening.support : 0),
  )
  if (!noise.active) return sharpenDetailTile(image, tile, source, sharpening, primaries, output)
  if (!sharpening.active) return denoiseDetailTile(image, tile, source, noise, primaries, output)
  const padded = detailSourceBounds(image, tile, sharpening.support),
    data = denoiseDetailTile(image, padded, source, noise, primaries)
  return sharpenDetailTile(image, tile, { ...padded, data }, sharpening, primaries, output)
}
