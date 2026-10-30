import type { CropGeometry } from '../../shared/crop'

/**
 * Selects exact native pixels into a caller-owned, admitted destination allocation.
 * Source strips are already authenticated/validated by the existing working reader.
 * Arbitrary-angle filtering is a separate path; it cannot silently use this copier.
 */
export function copyIntegerCropStrip(
  strip: Float32Array,
  top: number,
  geometry: CropGeometry,
  destination: Float32Array,
): number {
  const width = geometry.source.width,
    rows = strip.length / (width * 4)
  if (
    !geometry.pixelAligned ||
    !Number.isSafeInteger(top) ||
    top < 0 ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 64 ||
    top + rows > geometry.source.height ||
    destination.length !== geometry.width * geometry.height * 4 ||
    destination.buffer === strip.buffer
  )
    throw new Error('Invalid integer-crop strip or destination.')
  const from = new Uint32Array(strip.buffer, strip.byteOffset, strip.length),
    to = new Uint32Array(destination.buffer, destination.byteOffset, destination.length),
    minX = Math.min(...geometry.corners.map((p) => p.x)),
    maxX = Math.max(...geometry.corners.map((p) => p.x)),
    minY = Math.min(...geometry.corners.map((p) => p.y)),
    maxY = Math.max(...geometry.corners.map((p) => p.y)),
    left = Math.max(0, minX),
    right = Math.min(width, maxX),
    start = Math.max(top, minY),
    end = Math.min(top + rows, maxY),
    [a, b, c, d, offsetX, offsetY] = geometry.sourceToOutput,
    step = (a + c * geometry.width) * 4
  let copied = 0
  for (let y = start; y < end; y++) {
    const outX = a * (left + 0.5) + b * (y + 0.5) + offsetX - 0.5,
      outY = c * (left + 0.5) + d * (y + 0.5) + offsetY - 0.5
    let target = (outY * geometry.width + outX) * 4,
      input = ((y - top) * width + left) * 4
    // The ordinary integer crop can copy a whole row without a per-pixel loop.
    if (step === 4) {
      to.set(from.subarray(input, input + (right - left) * 4), target)
      copied += right - left
    } else
      for (let x = left; x < right; x++, input += 4, target += step) {
        to[target] = from[input]
        to[target + 1] = from[input + 1]
        to[target + 2] = from[input + 2]
        to[target + 3] = from[input + 3]
        copied++
      }
  }
  return copied
}
