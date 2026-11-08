import type { CropGeometry } from './crop'

/** Path-free mapping from the displayed pixel-edge grid to an immutable source grid. */
export interface MaskGeometry {
  readonly version: 1
  readonly canonicalWidth: number
  readonly canonicalHeight: number
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly flip: number
  readonly correction?: {
    readonly width: number
    readonly height: number
    readonly left: number
    readonly top: number
    /** Green-channel radial mapping; lateral chromatic correction never moves coverage. */
    readonly distortion: readonly number[]
  }
  readonly crop?: CropGeometry
}

export interface PhotoMaskContext {
  readonly photoId: string
  readonly revision: number
  readonly geometry: MaskGeometry
  readonly width: number
  readonly height: number
  readonly renderingIdentity: string
}

export function identityMaskGeometry(width: number, height: number): MaskGeometry {
  return {
    version: 1,
    canonicalWidth: width,
    canonicalHeight: height,
    sourceWidth: width,
    sourceHeight: height,
    flip: 0,
  }
}

export function maskOutputSize(geometry: MaskGeometry) {
  if (geometry.crop) return { width: geometry.crop.width, height: geometry.crop.height }
  const width = geometry.correction?.width ?? geometry.sourceWidth
  const height = geometry.correction?.height ?? geometry.sourceHeight
  return geometry.flip & 4 ? { width: height, height: width } : { width, height }
}

export function validateMaskGeometry(value: MaskGeometry): void {
  if (
    !value ||
    value.version !== 1 ||
    ![value.canonicalWidth, value.canonicalHeight, value.sourceWidth, value.sourceHeight].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 32768,
    ) ||
    !Number.isInteger(value.flip) ||
    value.flip < 0 ||
    value.flip > 7 ||
    value.canonicalWidth !== (value.flip & 4 ? value.sourceHeight : value.sourceWidth) ||
    value.canonicalHeight !== (value.flip & 4 ? value.sourceWidth : value.sourceHeight)
  )
    throw new Error('Invalid mask source geometry.')
  const c = value.correction
  if (
    c &&
    (![c.width, c.height].every((n) => Number.isSafeInteger(n) && n > 0) ||
      ![c.left, c.top].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      c.width + 2 * c.left !== value.sourceWidth ||
      c.height + 2 * c.top !== value.sourceHeight ||
      c.distortion.length !== 4096 ||
      c.distortion.some((n) => !Number.isFinite(n) || n <= 0))
  )
    throw new Error('Invalid mask lens geometry.')
  if (value.crop) {
    const width = c?.width ?? value.sourceWidth,
      height = c?.height ?? value.sourceHeight
    if (
      value.crop.source.width !== (value.flip & 4 ? height : width) ||
      value.crop.source.height !== (value.flip & 4 ? width : height) ||
      !value.crop.outputToSource.every(Number.isFinite)
    )
      throw new Error('Invalid mask crop geometry.')
  }
}

/** Pull mapping matches the image's lens shader, using the green geometric reference. */
export function maskCanonicalPoint(
  point: { x: number; y: number },
  geometry: MaskGeometry,
): { x: number; y: number } {
  let { x, y } = point
  if (geometry.crop) {
    const m = geometry.crop.outputToSource
    ;[x, y] = [m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5]]
  }
  const c = geometry.correction
  const width = c?.width ?? geometry.sourceWidth,
    height = c?.height ?? geometry.sourceHeight
  if (geometry.flip & 4) [x, y] = [y, x]
  if (geometry.flip & 1) x = width - x
  if (geometry.flip & 2) y = height - y
  if (c) {
    const cx = (geometry.sourceWidth - 1) / 2,
      cy = (geometry.sourceHeight - 1) / 2
    const qx = x - 0.5 + c.left - cx,
      qy = y - 0.5 + c.top - cy
    const radius = Math.hypot(cx, cy)
    const position = Math.max(0, Math.min(4095, radius ? (Math.hypot(qx, qy) / radius) * 4095 : 0))
    const i = Math.min(4094, Math.floor(position)),
      fraction = position - i
    const scale = c.distortion[i] * (1 - fraction) + c.distortion[i + 1] * fraction
    x = cx + qx * scale + 0.5
    y = cy + qy * scale + 0.5
  }
  if (geometry.flip & 1) x = geometry.sourceWidth - x
  if (geometry.flip & 2) y = geometry.sourceHeight - y
  if (geometry.flip & 4) [x, y] = [y, x]
  return { x: x / geometry.canonicalWidth, y: y / geometry.canonicalHeight }
}

export function croppedMaskGeometry(geometry: MaskGeometry, crop: CropGeometry): MaskGeometry {
  return { ...geometry, crop }
}
