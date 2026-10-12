import type { MergeTransform } from '../../shared/merge'

/** Exact center membership for exposure validation, before conservative dilation. */
export function excludedCenters(
  transform: MergeTransform,
  width: number,
  height: number,
  nativeWidth: number,
  nativeHeight: number,
) {
  const result = new Uint8Array(width * height),
    xs = Float64Array.from({ length: width }, (_, x) => ((x + 0.5) * nativeWidth) / width - 0.5),
    ys = Float64Array.from({ length: height }, (_, y) => ((y + 0.5) * nativeHeight) / height - 0.5)
  const lower = (coordinates: Float64Array, value: number) => {
    let lo = 0,
      hi = coordinates.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (coordinates[mid] < value) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  for (const box of transform.diagnostics?.movingRegions ?? []) {
    const left = lower(xs, box.left),
      right = lower(xs, box.left + box.width),
      first = lower(ys, box.top),
      last = lower(ys, box.top + box.height)
    for (let y = first; y < last; y++) result.fill(1, y * width + left, y * width + right)
  }
  return result
}

/** Registration uncertainty excludes only its source, in frozen reference coordinates. */
export function excludedBand(
  transform: MergeTransform,
  width: number,
  height: number,
  nativeWidth: number,
  nativeHeight: number,
  top: number,
  rows: number,
) {
  const result = new Uint8Array(width * rows),
    sx = width / nativeWidth,
    sy = height / nativeHeight
  for (const box of transform.diagnostics?.movingRegions ?? []) {
    const left = Math.max(0, Math.floor(box.left * sx)),
      right = Math.min(width, Math.ceil((box.left + box.width) * sx)),
      first = Math.max(top, Math.floor(box.top * sy)),
      last = Math.min(top + rows, Math.ceil((box.top + box.height) * sy))
    for (let y = first; y < last; y++)
      result.fill(1, (y - top) * width + left, (y - top) * width + right)
  }
  return result
}

/** Conservative confidence taper inside verified source support. Excluded
 * pixels remain excluded; the halo makes separate bands reproduce one field.
 * Legacy calls retain their exact binary masks and allocation sizes.
 */
export function sourceExclusionBand(
  transform: MergeTransform,
  width: number,
  height: number,
  nativeWidth: number,
  nativeHeight: number,
  top: number,
  rows: number,
  featherPixels = 0,
) {
  if (!featherPixels)
    return excludedBand(transform, width, height, nativeWidth, nativeHeight, top, rows)
  const radius = Math.max(
      1,
      Math.min(
        254,
        Math.ceil(featherPixels * Math.min(width / nativeWidth, height / nativeHeight)),
      ),
    ),
    first = Math.max(0, top - radius),
    last = Math.min(height, top + rows + radius),
    mask = excludedBand(transform, width, height, nativeWidth, nativeHeight, first, last - first),
    result = taperExclusions(mask, width, last - first, radius)
  return result.subarray((top - first) * width, (top - first + rows) * width)
}

/** Reference fallback tapers only outside rejected pixels, which remain exact. */
export function taperExclusions(mask: Uint8Array, width: number, height: number, radius: number) {
  const distance = new Uint8Array(mask.length).fill(radius)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      distance[i] = mask[i]
        ? 0
        : Math.min(
            distance[i],
            x ? distance[i - 1] + 1 : radius,
            y ? distance[i - width] + 1 : radius,
          )
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      distance[i] = Math.min(
        distance[i],
        x + 1 < width ? distance[i + 1] + 1 : radius,
        y + 1 < height ? distance[i + width] + 1 : radius,
      )
    }
  const result = new Uint8Array(mask.length)
  for (let i = 0; i < result.length; i++) {
    const d = distance[i] / radius,
      confidence = d * d * (3 - 2 * d)
    result[i] = mask[i] ? 255 : 255 - Math.max(1, Math.round(confidence * 255))
  }
  return result
}

/** Four byte confidences per word; sensor clipping keeps its separate bit mask. */
export function packedExclusionConfidence(mask: Uint8Array) {
  const words = new Uint32Array(Math.ceil(mask.length / 4))
  for (let i = 0; i < mask.length; i++) words[i >>> 2] |= mask[i] << ((i & 3) * 8)
  return words
}
