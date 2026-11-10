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

/**
 * Inverse pull mapping for photo-registered guides, in cropped-output pixel edges.
 * Refuse folds or singular transforms rather than displaying a misplaced handle.
 */
export function maskOutputPoint(
  point: { x: number; y: number },
  geometry: MaskGeometry,
): { x: number; y: number } | null {
  if (![point.x, point.y].every((n) => Number.isFinite(n) && n >= -1 && n <= 2)) return null
  let x = point.x * geometry.canonicalWidth,
    y = point.y * geometry.canonicalHeight
  if (geometry.flip & 4) [x, y] = [y, x]
  if (geometry.flip & 1) x = geometry.sourceWidth - x
  if (geometry.flip & 2) y = geometry.sourceHeight - y
  const c = geometry.correction
  const width = c?.width ?? geometry.sourceWidth,
    height = c?.height ?? geometry.sourceHeight
  if (c) {
    const cx = (geometry.sourceWidth - 1) / 2,
      cy = (geometry.sourceHeight - 1) / 2,
      radius = Math.hypot(cx, cy),
      qx = x - 0.5 - cx,
      qy = y - 0.5 - cy,
      target = Math.hypot(qx, qy)
    if (c.distortion.length !== 4096 || radius <= 0) return null
    // The radial function is piecewise quadratic. Check its derivative at both
    // ends of each segment: a positive table alone does not exclude a lens fold.
    for (let i = 0; i < 4095; i++) {
      const a = c.distortion[i],
        b = c.distortion[i + 1],
        delta = b - a
      if (![a, b].every(Number.isFinite) || Math.min(a + i * delta, b + (i + 1) * delta) <= 1e-6)
        return null
    }
    const scaleAt = (distance: number) => {
      const position = Math.min(4095, (distance / radius) * 4095),
        i = Math.min(4094, Math.floor(position)),
        fraction = position - i
      return c.distortion[i] * (1 - fraction) + c.distortion[i + 1] * fraction
    }
    let low = 0,
      high = Math.max(radius, target / c.distortion[4095]),
      distance = 0
    if (
      !Number.isFinite(high) ||
      high > 8 * Math.hypot(geometry.sourceWidth, geometry.sourceHeight)
    )
      return null
    for (let step = 0; step < 48; step++) {
      distance = (low + high) / 2
      if (distance * scaleAt(distance) < target) low = distance
      else high = distance
    }
    const factor = target ? distance / target : 0
    x = cx + qx * factor + 0.5 - c.left
    y = cy + qy * factor + 0.5 - c.top
  }
  if (geometry.flip & 1) x = width - x
  if (geometry.flip & 2) y = height - y
  if (geometry.flip & 4) [x, y] = [y, x]
  if (geometry.crop) {
    const m = geometry.crop.outputToSource,
      determinant = m[0] * m[3] - m[1] * m[2],
      px = x - m[4],
      py = y - m[5]
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null
    ;[x, y] = [(m[3] * px - m[1] * py) / determinant, (m[0] * py - m[2] * px) / determinant]
  }
  if (![x, y].every(Number.isFinite)) return null
  const check = maskCanonicalPoint({ x, y }, geometry)
  if (
    Math.hypot(
      (check.x - point.x) * geometry.canonicalWidth,
      (check.y - point.y) * geometry.canonicalHeight,
    ) > 1e-4
  )
    return null
  return { x, y }
}
