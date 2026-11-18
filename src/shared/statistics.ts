export interface ImageStatistics {
  rgb: [number[], number[], number[]]
  visiblePixels: number
  shadowClipped: number
  highlightClipped: number
  colorSpace: 'srgb'
  dynamicRange: 'sdr'
}
export interface PhotoStatistics extends ImageStatistics {
  photoId: string
  revision: number
  renderingIdentity: string
}
export function emptyImageStatistics(): ImageStatistics {
  return {
    rgb: [Array(256).fill(0), Array(256).fill(0), Array(256).fill(0)],
    visiblePixels: 0,
    shadowClipped: 0,
    highlightClipped: 0,
    colorSpace: 'srgb',
    dynamicRange: 'sdr',
  }
}

/** Endpoints of the SDR display image, not a claim about RAW sensor saturation. */
export function sdrClippingBits(red: number, green: number, blue: number): number {
  return (
    Number(red === 0 && green === 0 && blue === 0) |
    (Number(red === 255 || green === 255 || blue === 255) << 1)
  )
}

export function addVisibleSdrPixel(
  result: ImageStatistics,
  red: number,
  green: number,
  blue: number,
): number {
  result.visiblePixels++
  result.rgb[0][red]++
  result.rgb[1][green]++
  result.rgb[2][blue]++
  const bits = sdrClippingBits(red, green, blue)
  result.shadowClipped += bits & 1
  result.highlightClipped += bits >> 1
  return bits
}

export function imageStatistics(data: Uint8Array | Uint8ClampedArray): ImageStatistics {
  const result = emptyImageStatistics()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    addVisibleSdrPixel(result, data[i], data[i + 1], data[i + 2])
  }
  return result
}
export function sampleWorking(data: Float32Array, limit = 65536): Float32Array<ArrayBuffer> {
  const pixels = data.length / 4,
    count = Math.min(pixels, limit),
    sample = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const at = Math.floor(((i + 0.5) * pixels) / count) * 4
    sample.set(data.subarray(at, at + 4), i * 4)
  }
  return sample
}
/** OR reduction preserves even single-pixel clipping in the compact mask. */
export function clippingMask(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxSide = 1024,
) {
  const scale = Math.min(1, maxSide / Math.max(width, height)),
    w = Math.max(1, Math.ceil(width * scale)),
    h = Math.max(1, Math.ceil(height * scale))
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (!data[i + 3]) continue
      const bits = sdrClippingBits(data[i], data[i + 1], data[i + 2])
      if (bits) mask[Math.floor((y * h) / height) * w + Math.floor((x * w) / width)] |= bits
    }
  return { data: mask, width: w, height: h }
}

/** One byte per source pixel plus an OR pyramid, bounded to 4/3 of the source mask. */
export function clippingPyramid(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
) {
  const levels = [clippingMask(data, width, height, Math.max(width, height))]
  while (width > 1 || height > 1) {
    const previous = levels[levels.length - 1],
      w = Math.ceil(width / 2),
      h = Math.ceil(height / 2)
    const reduced = new Uint8Array(w * h)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        reduced[Math.floor(y / 2) * w + Math.floor(x / 2)] |= previous.data[y * width + x]
    levels.push({ data: reduced, width: w, height: h })
    width = w
    height = h
  }
  return { levels }
}
