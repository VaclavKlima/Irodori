import { RGB_TO_XYZ, XYZ_TO_RGB, type ColorPrimaries, type ColorTriple } from './color-model'
import { D65_XYZ, cieLabF } from './color-intensity'

export const LAB_EPSILON = 216 / 24389
export interface CreativeLabValue {
  readonly y: number
  readonly a: number
  readonly b: number
}
const delta = 6 / 29,
  slope = 24389 / (27 * 116),
  inverseSlope = (116 * 27) / 24389

/** Stable differences preserve tiny signed colors without subtracting the Lab toe offset. */
export function labDifference(x: number, y: number): number {
  if (x === y) return 0
  if (x <= LAB_EPSILON && y <= LAB_EPSILON) return (x - y) * slope
  if (x > LAB_EPSILON && y > LAB_EPSILON) {
    const a = Math.cbrt(x),
      b = Math.cbrt(y)
    return (x - y) / (a * a + a * b + b * b)
  }
  if (x > LAB_EPSILON) {
    const a = Math.cbrt(x)
    return (x - LAB_EPSILON) / (a * a + a * delta + delta * delta) + (LAB_EPSILON - y) * slope
  }
  return -labDifference(y, x)
}

export function labInverseDelta(value: number, change: number): number {
  if (change === 0) return 0
  const next = value + change
  if (value > delta && next > delta) return change * (next * next + next * value + value * value)
  if (value <= delta && next <= delta) return change * inverseSlope
  if (value <= delta)
    return (
      (delta - value) * inverseSlope + (next - delta) * (next * next + next * delta + delta * delta)
    )
  return (
    (delta - value) * (delta * delta + delta * value + value * value) +
    (next - delta) * inverseSlope
  )
}

export function labLightness(y: number): number {
  return y <= LAB_EPSILON ? (24389 / 27) * y : 116 * Math.cbrt(y) - 16
}
export function labLightnessRatio(y: number, nextY: number, gain: number): number {
  if (gain === 1) return 1
  if (y <= LAB_EPSILON && nextY <= LAB_EPSILON) return gain
  return labLightness(nextY) / labLightness(y)
}

const dot = (row: ColorTriple, rgb: ColorTriple) =>
  row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]
export function creativeLab(rgb: ColorTriple, primaries: ColorPrimaries) {
  if (rgb[0] === rgb[1] && rgb[1] === rgb[2])
    return {
      xyz: [D65_XYZ[0] * rgb[0], rgb[0], D65_XYZ[2] * rgb[0]] as ColorTriple,
      l: labLightness(rgb[0]),
      a: 0,
      b: 0,
    }
  const matrix = RGB_TO_XYZ[primaries],
    xyz: ColorTriple = [dot(matrix[0], rgb), dot(matrix[1], rgb), dot(matrix[2], rgb)]
  return {
    xyz,
    l: labLightness(xyz[1]),
    a: 500 * labDifference(xyz[0] / D65_XYZ[0], xyz[1]),
    b: 200 * labDifference(xyz[1], xyz[2] / D65_XYZ[2]),
  }
}

/** Delta reconstruction avoids a lossy round trip for a small point adjustment. */
export function creativeLabResult(
  rgb: ColorTriple,
  primaries: ColorPrimaries,
  original: ReturnType<typeof creativeLab>,
  y: number,
  a: number,
  b: number,
): ColorTriple {
  if (y === original.xyz[1] && a === original.a && b === original.b) return rgb
  if (a === 0 && b === 0) return [y, y, y]
  const changeF = labDifference(y, original.xyz[1]),
    dx =
      D65_XYZ[0] *
      labInverseDelta(cieLabF(original.xyz[0] / D65_XYZ[0]), changeF + (a - original.a) / 500),
    dy = y - original.xyz[1],
    dz =
      D65_XYZ[2] *
      labInverseDelta(cieLabF(original.xyz[2] / D65_XYZ[2]), changeF - (b - original.b) / 200),
    change: ColorTriple = [dx, dy, dz],
    inverse = XYZ_TO_RGB[primaries]
  return [
    rgb[0] + dot(inverse[0], change),
    rgb[1] + dot(inverse[1], change),
    rgb[2] + dot(inverse[2], change),
  ]
}

export const colorSmoothstep = (x: number) => {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}
