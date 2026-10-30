/** D65 linear RGB ↔ Oklab, with signed channels and no gamut or brightness clipping.
 * Matrices: W3C CSS Color 4, 2026-10-22, sample conversion code.
 * See docs/features/professional-editing-processing.md for provenance and limits.
 */
export const COLOR_MODEL_VERSION = 'oklab-d65-css20261022-v1'
export type ColorPrimaries = 'srgb' | 'rec2020'
export type ColorTriple = readonly [number, number, number]
type Matrix = readonly [ColorTriple, ColorTriple, ColorTriple]

export const RGB_TO_XYZ: Readonly<Record<ColorPrimaries, Matrix>> = {
  srgb: [
    [506752 / 1228815, 87881 / 245763, 12673 / 70218],
    [87098 / 409605, 175762 / 245763, 12673 / 175545],
    [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
  ],
  rec2020: [
    [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
    [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
    [0, 19567812 / 697040785, 295819943 / 278816314],
  ],
}
export const XYZ_TO_RGB: Readonly<Record<ColorPrimaries, Matrix>> = {
  srgb: [
    [12831 / 3959, -329 / 214, -1974 / 3959],
    [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
    [705 / 12673, -2585 / 12673, 705 / 667],
  ],
  rec2020: [
    [30757411 / 17917100, -6372589 / 17917100, -4539589 / 17917100],
    [-19765991 / 29648200, 47925759 / 29648200, 467509 / 29648200],
    [792561 / 44930125, -1921689 / 44930125, 42328811 / 44930125],
  ],
}
const xyzToLms: Matrix = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
]
const lmsToLab: Matrix = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
]
const labToLms: Matrix = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
]
const lmsToXyz: Matrix = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
]

function dot(a: ColorTriple, b: ColorTriple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function transform(matrix: Matrix, value: ColorTriple): [number, number, number] {
  return [dot(matrix[0], value), dot(matrix[1], value), dot(matrix[2], value)]
}

export function workingToOklab(rgb: ColorTriple, primaries: ColorPrimaries): ColorTriple {
  const lms = transform(xyzToLms, workingToXyz(rgb, primaries))
  return transform(lmsToLab, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])])
}

export function oklabToWorking(lab: ColorTriple, primaries: ColorPrimaries): ColorTriple {
  const lms = transform(labToLms, lab)
  return xyzToWorking(transform(lmsToXyz, [lms[0] ** 3, lms[1] ** 3, lms[2] ** 3]), primaries)
}

export function workingToXyz(rgb: ColorTriple, primaries: ColorPrimaries): ColorTriple {
  return transform(RGB_TO_XYZ[primaries], rgb)
}

export function xyzToWorking(xyz: ColorTriple, primaries: ColorPrimaries): ColorTriple {
  return transform(XYZ_TO_RGB[primaries], xyz)
}
