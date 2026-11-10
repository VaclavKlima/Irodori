import { BRADFORD_ROW, INVERSE_BRADFORD_ROW } from './chromatic-adaptation'
import { D65_XYZ } from './color-intensity'
import { RGB_TO_XYZ, XYZ_TO_RGB, type ColorPrimaries } from './color-model'
import { locusUv, multiplyVector, whiteBalanceNormal } from './white-balance'
import { validateMaskColor, type MaskColor } from './masks'

export const MASK_COLOR_VERSION = 'relative-d65-bradford-half-mired-ucs-lab-v1'
const anchorKelvin = 6500
const anchorUv = locusUv(anchorKelvin)
const denominator = D65_XYZ[0] + 15 + 3 * D65_XYZ[2]
const d65Uv = [(4 * D65_XYZ[0]) / denominator, 6 / denominator]
const transpose = (matrix: number[][]) =>
  Array.from({ length: 9 }, (_, index) => matrix[index % 3][Math.floor(index / 3)])
const bradford = transpose(BRADFORD_ROW)
const inverseBradford = transpose(INVERSE_BRADFORD_ROW)
const sourceCone = multiplyVector(bradford, [...D65_XYZ])
const product = (a: readonly number[], b: readonly number[]) =>
  Array.from({ length: 9 }, (_, index) =>
    [0, 1, 2].reduce(
      (sum, k) => sum + a[Math.floor(index / 3) * 3 + k] * b[k * 3 + (index % 3)],
      0,
    ),
  )

/** Relative creative balance, independent of camera gains, global WB and monitor headroom. */
export function maskColorWhite(color: MaskColor): number[] | null {
  validateMaskColor(color)
  if (color.temperature === 0 && color.tint === 0) return null
  const kelvin = 1e6 / (1e6 / anchorKelvin + 0.5 * color.temperature)
  const locus = locusUv(kelvin)
  const normal = whiteBalanceNormal(kelvin)
  const u = d65Uv[0] + locus[0] - anchorUv[0] - normal[0] * color.tint * 0.0001
  const v = d65Uv[1] + locus[1] - anchorUv[1] - normal[1] * color.tint * 0.0001
  const white = [(3 * u) / (2 * v), 1, (4 - u - 10 * v) / (2 * v)]
  if (v <= 0 || white.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error('The local color balance white point is unsupported.')
  return white
}

/** Only bounded 3×3 coefficient preparation runs on CPU; image color executes on GPU. */
export function maskColorBalanceMatrices(
  color: MaskColor,
): Readonly<Record<ColorPrimaries, readonly number[]>> | null {
  const white = maskColorWhite(color)
  if (!white) return null
  const destinationCone = multiplyVector(bradford, white)
  if (destinationCone.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error('The local color balance cone response is unsupported.')
  const diagonal = Array.from({ length: 9 }, (_, index) =>
    index % 4 === 0 ? destinationCone[index / 4] / sourceCone[index / 4] : 0,
  )
  const adaptation = product(product(inverseBradford, diagonal), bradford)
  const prepare = (primaries: ColorPrimaries) =>
    product(product(XYZ_TO_RGB[primaries].flat(), adaptation), RGB_TO_XYZ[primaries].flat())
  const matrices = { srgb: prepare('srgb'), rec2020: prepare('rec2020') }
  if (Object.values(matrices).some((matrix) => !matrix.every(Number.isFinite)))
    throw new Error('The local color balance matrix is not finite.')
  return matrices
}

export function maskColorBalanceGain(color: MaskColor): number {
  const matrices = maskColorBalanceMatrices(color)
  if (!matrices) return 1
  return Math.max(
    1,
    ...Object.values(matrices).flatMap((matrix) =>
      [0, 1, 2].map((row) =>
        matrix.slice(row * 3, row * 3 + 3).reduce((sum, value) => sum + Math.abs(value), 0),
      ),
    ),
  )
}
