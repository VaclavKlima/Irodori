import { mapCropAffine, type CropGeometry } from './crop'
import { catmullRom } from './reconstruction'

export const CROP_FILTER_VERSION = 'linear-catmull-rom-alpha-linear-v1'
export const CROP_COVERAGE_FLOOR = 2 ** -20
export const CROP_TILE_EDGE = 256
export interface CropRectangle {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}
/** Pixels are linear, straight-alpha and already validated by the source reader. */
export interface CropSourceWindow extends CropRectangle {
  readonly data: Float32Array
}
function validateTile(geometry: CropGeometry, tile: CropRectangle): void {
  if (
    ![tile.left, tile.top, tile.width, tile.height].every(Number.isSafeInteger) ||
    tile.left < 0 ||
    tile.top < 0 ||
    tile.width < 1 ||
    tile.height < 1 ||
    tile.width > CROP_TILE_EDGE ||
    tile.height > CROP_TILE_EDGE ||
    tile.left + tile.width > geometry.width ||
    tile.top + tile.height > geometry.height
  )
    throw new Error('Invalid crop processing tile.')
}

/** Native input rectangle, including cubic support and one integer-index guard pixel. */
export function cropTileSourceBounds(geometry: CropGeometry, tile: CropRectangle): CropRectangle {
  validateTile(geometry, tile)
  const points = [
    [tile.left, tile.top],
    [tile.left + tile.width - 1, tile.top],
    [tile.left, tile.top + tile.height - 1],
    [tile.left + tile.width - 1, tile.top + tile.height - 1],
  ].map(([x, y]) => mapCropAffine(geometry.outputToSource, { x: x + 0.5, y: y + 0.5 }))
  const before = geometry.pixelAligned ? 0 : 2,
    after = geometry.pixelAligned ? 0 : 3,
    left = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - 0.5) - before),
    top = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - 0.5) - before),
    right = Math.min(
      geometry.source.width,
      Math.floor(Math.max(...points.map((p) => p.x)) - 0.5) + after + 1,
    ),
    bottom = Math.min(
      geometry.source.height,
      Math.floor(Math.max(...points.map((p) => p.y)) - 0.5) + after + 1,
    )
  return { left, top, width: right - left, height: bottom - top }
}

export function validateCropWindow(
  geometry: CropGeometry,
  tile: CropRectangle,
  source: CropSourceWindow,
): void {
  const required = cropTileSourceBounds(geometry, tile)
  if (
    ![source.left, source.top, source.width, source.height].every(Number.isSafeInteger) ||
    source.left < 0 ||
    source.top < 0 ||
    source.width < 1 ||
    source.height < 1 ||
    source.left + source.width > geometry.source.width ||
    source.top + source.height > geometry.source.height ||
    source.data.length !== source.width * source.height * 4 ||
    source.left > required.left ||
    source.top > required.top ||
    source.left + source.width < required.left + required.width ||
    source.top + source.height < required.top + required.height
  )
    throw new Error('Incomplete crop source window.')
}

/** Float64 CPU reference/worker kernel; no allocation inside the per-pixel loop. */
export function resampleCropTile(
  geometry: CropGeometry,
  tile: CropRectangle,
  source: CropSourceWindow,
  destination: Float64Array,
): Float64Array
export function resampleCropTile(
  geometry: CropGeometry,
  tile: CropRectangle,
  source: CropSourceWindow,
  destination?: Float32Array,
): Float32Array
export function resampleCropTile(
  geometry: CropGeometry,
  tile: CropRectangle,
  source: CropSourceWindow,
  destination?: Float32Array | Float64Array,
): Float32Array | Float64Array {
  validateCropWindow(geometry, tile, source)
  const output = destination ?? new Float32Array(tile.width * tile.height * 4)
  if (output.length !== tile.width * tile.height * 4 || output.buffer === source.data.buffer)
    throw new Error('Invalid crop tile destination.')
  const sourceBits = new Uint32Array(
      source.data.buffer,
      source.data.byteOffset,
      source.data.length,
    ),
    outputBits =
      output instanceof Float32Array
        ? new Uint32Array(output.buffer, output.byteOffset, output.length)
        : undefined,
    columns = new Int32Array(4),
    rows = new Int32Array(4),
    wx = new Float64Array(4),
    wy = new Float64Array(4),
    [a, b, c, d, originX, originY] = geometry.outputToSource
  for (let y = 0; y < tile.height; y++)
    for (let x = 0; x < tile.width; x++) {
      const sx = a * (tile.left + x + 0.5) + b * (tile.top + y + 0.5) + originX - 0.5,
        sy = c * (tile.left + x + 0.5) + d * (tile.top + y + 0.5) + originY - 0.5,
        ix = Math.floor(sx),
        iy = Math.floor(sy),
        target = (y * tile.width + x) * 4
      if (geometry.pixelAligned) {
        const index = ((iy - source.top) * source.width + ix - source.left) * 4
        for (let channel = 0; channel < 4; channel++) {
          if (outputBits) outputBits[target + channel] = sourceBits[index + channel]
          else output[target + channel] = source.data[index + channel]
        }
        continue
      }
      for (let i = 0; i < 4; i++) {
        columns[i] = Math.max(0, Math.min(geometry.source.width - 1, ix + i - 1)) - source.left
        rows[i] = Math.max(0, Math.min(geometry.source.height - 1, iy + i - 1)) - source.top
        wx[i] = catmullRom(sx - (ix + i - 1))
        wy[i] = catmullRom(sy - (iy + i - 1))
      }
      let opaque = true,
        red = 0,
        green = 0,
        blue = 0
      for (let row = 0; row < 4; row++)
        for (let column = 0; column < 4; column++) {
          const index = (rows[row] * source.width + columns[column]) * 4,
            weight = wx[column] * wy[row]
          opaque &&= source.data[index + 3] === 1
          red += source.data[index] * weight
          green += source.data[index + 1] * weight
          blue += source.data[index + 2] * weight
        }
      let alpha = 1
      if (!opaque) {
        red = 0
        green = 0
        blue = 0
        alpha = 0
        const fx = sx - ix,
          fy = sy - iy
        for (let row = 0; row < 2; row++)
          for (let column = 0; column < 2; column++) {
            const index = (rows[row + 1] * source.width + columns[column + 1]) * 4,
              weight = (row ? fy : 1 - fy) * (column ? fx : 1 - fx) * source.data[index + 3]
            alpha += weight
            red += source.data[index] * weight
            green += source.data[index + 1] * weight
            blue += source.data[index + 2] * weight
          }
        if (Math.fround(alpha) <= CROP_COVERAGE_FLOOR) {
          output.fill(0, target, target + 4)
          continue
        }
        red /= alpha
        green /= alpha
        blue /= alpha
      }
      output[target] = red
      output[target + 1] = green
      output[target + 2] = blue
      output[target + 3] = Math.max(0, Math.min(1, alpha))
      if (
        !Number.isFinite(output[target]) ||
        !Number.isFinite(output[target + 1]) ||
        !Number.isFinite(output[target + 2])
      )
        throw new Error('The crop produced nonfinite working pixels.')
    }
  return output
}
