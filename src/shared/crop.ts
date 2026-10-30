/** Geometry uses the already oriented, lens-corrected native working image. */
export const CROP_GEOMETRY_VERSION = 'native-center-quarter-straighten-v1'
export interface CropSettings {
  readonly version: 1
  /** Clockwise quarter turns after source orientation. */
  readonly quarterTurns: 0 | 1 | 2 | 3
  /** Clockwise degrees, around the crop center. */
  readonly angle: number
  /** Center and extents relative to the quarter-turned, unstraightened source. */
  readonly centerX: number
  readonly centerY: number
  readonly width: number
  readonly height: number
  /** Authoring constraint; null permits a free aspect ratio. */
  readonly aspectRatio: number | null
}
export const identityCrop: CropSettings = Object.freeze({
  version: 1,
  quarterTurns: 0,
  angle: 0,
  centerX: 0.5,
  centerY: 0.5,
  width: 1,
  height: 1,
  aspectRatio: null,
})
/** Persisted full-frame authoring state needs no geometry preparation. */
export function isUncropped(crop: CropSettings): boolean {
  validateCrop(crop)
  return (
    crop.quarterTurns === 0 &&
    crop.angle === 0 &&
    crop.centerX === 0.5 &&
    crop.centerY === 0.5 &&
    crop.width === 1 &&
    crop.height === 1
  )
}
/** Authoring-only aspect locks do not invalidate a prepared view. */
export function sameCropFraming(a: CropSettings, b: CropSettings): boolean {
  return (
    a.version === b.version &&
    a.quarterTurns === b.quarterTurns &&
    a.angle === b.angle &&
    a.centerX === b.centerX &&
    a.centerY === b.centerY &&
    a.width === b.width &&
    a.height === b.height
  )
}
export interface CropSize {
  readonly width: number
  readonly height: number
}
export interface PhotoCropContext {
  readonly photoId: string
  readonly revision: number
  readonly source: CropSize
  readonly settings: CropSettings
  readonly geometry: CropGeometry
  readonly renderingIdentity: string
}
export interface CropPoint {
  readonly x: number
  readonly y: number
}
/** [xx, xy, yx, yy, offsetX, offsetY], in native pixel-edge coordinates. */
export type CropAffine = readonly [number, number, number, number, number, number]
export interface CropGeometry extends CropSize {
  readonly source: CropSize
  readonly outputToSource: CropAffine
  readonly sourceToOutput: CropAffine
  readonly corners: readonly [CropPoint, CropPoint, CropPoint, CropPoint]
  /** Identity includes non-pixel authoring state such as a full-frame aspect lock. */
  readonly identity: boolean
  /** A grid permutation or integer crop can copy pixels without interpolation. */
  readonly pixelAligned: boolean
}

export const CROP_EDGE_EPSILON = 1e-9
function validateSize(size: CropSize): void {
  if (
    !size ||
    ![size.width, size.height].every((v) => Number.isSafeInteger(v) && v >= 1 && v <= 32768)
  )
    throw new Error('Crop source dimensions must be integers from 1 to 32768.')
}
export function validateCrop(value: unknown): asserts value is CropSettings {
  const crop = value as CropSettings | null
  if (
    !crop ||
    typeof crop !== 'object' ||
    Array.isArray(crop) ||
    Object.keys(crop).sort().join(',') !==
      'angle,aspectRatio,centerX,centerY,height,quarterTurns,version,width' ||
    crop.version !== 1 ||
    !Number.isInteger(crop.quarterTurns) ||
    crop.quarterTurns < 0 ||
    crop.quarterTurns > 3 ||
    typeof crop.angle !== 'number' ||
    !Number.isFinite(crop.angle) ||
    crop.angle < -45 ||
    crop.angle > 45 ||
    Math.abs(crop.angle * 100 - Math.round(crop.angle * 100)) > 1e-8 ||
    ![crop.centerX, crop.centerY].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1,
    ) ||
    ![crop.width, crop.height].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1,
    ) ||
    (crop.aspectRatio !== null &&
      (typeof crop.aspectRatio !== 'number' ||
        !Number.isFinite(crop.aspectRatio) ||
        crop.aspectRatio < 1 / 32768 ||
        crop.aspectRatio > 32768))
  )
    throw new Error('Invalid crop settings.')
}

export function quarterTurnedSize(
  source: CropSize,
  quarterTurns: CropSettings['quarterTurns'],
): CropSize {
  validateSize(source)
  if (!Number.isInteger(quarterTurns) || quarterTurns < 0 || quarterTurns > 3)
    throw new Error('Invalid crop rotation.')
  return quarterTurns % 2
    ? { width: source.height, height: source.width }
    : { width: source.width, height: source.height }
}
export function mapCropAffine(matrix: CropAffine, point: CropPoint): CropPoint {
  return {
    x: matrix[0] * point.x + matrix[1] * point.y + matrix[4],
    y: matrix[2] * point.x + matrix[3] * point.y + matrix[5],
  }
}
function inverse(matrix: CropAffine): CropAffine {
  const [a, b, c, d, x, y] = matrix,
    determinant = a * d - b * c
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (b * y - d * x) / determinant,
    (c * x - a * y) / determinant,
  ]
}
/** JSON/IPC have a single zero; geometric coefficients do not encode pixel sign bits. */
function canonicalAffine(matrix: CropAffine): CropAffine {
  const zero = (value: number) => (value === 0 ? 0 : value)
  return [
    zero(matrix[0]),
    zero(matrix[1]),
    zero(matrix[2]),
    zero(matrix[3]),
    zero(matrix[4]),
    zero(matrix[5]),
  ]
}
/** Remove representation noise only at integral source edges, never quantize a real fraction. */
const stableEdge = (value: number) =>
  Math.abs(value - Math.round(value)) <= CROP_EDGE_EPSILON ? Math.round(value) : value

/** Validates photo-dependent bounds as well as the versioned, dimension-independent contract. */
export function cropGeometry(source: CropSize, crop: CropSettings): CropGeometry {
  validateCrop(crop)
  const turned = quarterTurnedSize(source, crop.quarterTurns),
    rawWidth = crop.width * turned.width,
    rawHeight = crop.height * turned.height
  if (
    crop.aspectRatio !== null &&
    Math.abs(rawWidth / rawHeight - crop.aspectRatio) > 1e-10 * crop.aspectRatio
  )
    throw new Error('The crop does not match its locked aspect ratio.')
  // Output pixels remain one native source unit apart; this never adds hidden scaling.
  const width = Math.floor(stableEdge(rawWidth)),
    height = Math.floor(stableEdge(rawHeight))
  if (width < 1 || height < 1)
    throw new Error('A crop must retain at least one native pixel per axis.')
  const radians = (crop.angle * Math.PI) / 180,
    cosine = Math.cos(radians),
    sine = Math.sin(radians),
    x = crop.centerX * turned.width - (cosine * width + sine * height) / 2,
    y = crop.centerY * turned.height - (-sine * width + cosine * height) / 2
  let matrix: CropAffine
  switch (crop.quarterTurns) {
    case 0:
      matrix = [cosine, sine, -sine, cosine, x, y]
      break
    case 1:
      matrix = [-sine, cosine, -cosine, -sine, y, source.height - x]
      break
    case 2:
      matrix = [-cosine, -sine, sine, -cosine, source.width - x, source.height - y]
      break
    case 3:
      matrix = [sine, -cosine, cosine, sine, source.width - y, x]
      break
  }
  matrix = canonicalAffine([
    matrix[0],
    matrix[1],
    matrix[2],
    matrix[3],
    stableEdge(matrix[4]),
    stableEdge(matrix[5]),
  ])
  const corners = [
    mapCropAffine(matrix, { x: 0, y: 0 }),
    mapCropAffine(matrix, { x: width, y: 0 }),
    mapCropAffine(matrix, { x: width, y: height }),
    mapCropAffine(matrix, { x: 0, y: height }),
  ] as const
  if (
    corners.some(
      (point) =>
        point.x < -CROP_EDGE_EPSILON ||
        point.y < -CROP_EDGE_EPSILON ||
        point.x > source.width + CROP_EDGE_EPSILON ||
        point.y > source.height + CROP_EDGE_EPSILON,
    )
  )
    throw new Error('The crop extends outside the photograph. Fit it before applying.')
  return {
    width,
    height,
    source: { width: source.width, height: source.height },
    outputToSource: matrix,
    sourceToOutput: canonicalAffine(inverse(matrix)),
    corners,
    identity:
      crop.quarterTurns === 0 &&
      crop.angle === 0 &&
      width === source.width &&
      height === source.height &&
      matrix[4] === 0 &&
      matrix[5] === 0,
    pixelAligned: crop.angle === 0 && Number.isInteger(matrix[4]) && Number.isInteger(matrix[5]),
  }
}

/** Largest uniform shrink at the requested center; it never expands or moves the crop. */
export function fitCrop(source: CropSize, crop: CropSettings): CropSettings {
  validateCrop(crop)
  const turned = quarterTurnedSize(source, crop.quarterTurns)
  let width = crop.width * turned.width,
    height = crop.height * turned.height
  if (crop.aspectRatio !== null) {
    if (width / height > crop.aspectRatio) width = height * crop.aspectRatio
    else height = width / crop.aspectRatio
  }
  const radians = (crop.angle * Math.PI) / 180,
    cosine = Math.cos(radians),
    sine = Math.abs(Math.sin(radians)),
    extentX = (cosine * width + sine * height) / 2,
    extentY = (sine * width + cosine * height) / 2,
    availableX = Math.min(crop.centerX, 1 - crop.centerX) * turned.width,
    availableY = Math.min(crop.centerY, 1 - crop.centerY) * turned.height,
    scale = Math.min(1, availableX / extentX, availableY / extentY),
    next = {
      ...crop,
      width: (width * scale) / turned.width,
      height: (height * scale) / turned.height,
    }
  cropGeometry(source, next)
  return next
}

/** A quarter-turn command rotates the current framing as well as the photograph. */
export function rotateCrop(crop: CropSettings, direction: -1 | 1): CropSettings {
  validateCrop(crop)
  if (direction !== -1 && direction !== 1) throw new Error('Invalid crop rotation.')
  return {
    ...crop,
    quarterTurns: ((crop.quarterTurns + direction + 4) % 4) as CropSettings['quarterTurns'],
    centerX: direction === 1 ? 1 - crop.centerY : crop.centerY,
    centerY: direction === 1 ? crop.centerX : 1 - crop.centerX,
    width: crop.height,
    height: crop.width,
    aspectRatio: crop.aspectRatio === null ? null : 1 / crop.aspectRatio,
  }
}

/** Normalized crop coordinate to the original working frame, before creative edits. */
export function cropPointToSource(geometry: CropGeometry, point: CropPoint): CropPoint | null {
  if (![point.x, point.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return null
  const pixel = mapCropAffine(geometry.outputToSource, {
    x: point.x * geometry.width,
    y: point.y * geometry.height,
  })
  return {
    x: Math.max(0, Math.min(1, pixel.x / geometry.source.width)),
    y: Math.max(0, Math.min(1, pixel.y / geometry.source.height)),
  }
}

/** Native source geometry, including a picker ROI, can be projected without screen sampling. */
export function sourcePointToCrop(geometry: CropGeometry, point: CropPoint): CropPoint | null {
  if (![point.x, point.y].every(Number.isFinite)) return null
  const pixel = mapCropAffine(geometry.sourceToOutput, {
    x: point.x * geometry.source.width,
    y: point.y * geometry.source.height,
  })
  return { x: pixel.x / geometry.width, y: pixel.y / geometry.height }
}
