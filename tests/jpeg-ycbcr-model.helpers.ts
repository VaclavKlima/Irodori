import { srgbLinear, to2020 } from './export-reference'

/** Full-range ITU-R BT.601-7 JPEG YCbCr to floating sRGB; deliberately no RGB8 rounding. */
export function referenceYcbcrToSrgb(y: number, cb: number, cr: number) {
  const luma = y / 255,
    blueDifference = (cb - 128) / 255,
    redDifference = (cr - 128) / 255,
    red = luma + 1.402 * redDifference,
    green =
      luma - ((0.114 * 1.772) / 0.587) * blueDifference - ((0.299 * 1.402) / 0.587) * redDifference,
    blue = luma + 1.772 * blueDifference
  return [red, green, blue].map((value) => Math.max(0, Math.min(1, value)))
}

export function referenceBase2020(
  samples: { mode: 'base-ycbcr' | 'gain-rgb'; width: number; height: number; pixels: Uint8Array },
  x: number,
  y: number,
) {
  if (
    samples.mode !== 'base-ycbcr' ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= samples.width ||
    y < 0 ||
    y >= samples.height
  )
    throw new Error('Invalid independent JPEG base sample coordinate or mode.')
  const count = samples.width * samples.height,
    pixel = y * samples.width + x,
    rgb = referenceYcbcrToSrgb(
      samples.pixels[pixel],
      samples.pixels[count + pixel],
      samples.pixels[count * 2 + pixel],
    )
  return to2020(rgb.map(srgbLinear))
}
