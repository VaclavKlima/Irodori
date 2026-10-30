import {
  CROP_EDGE_EPSILON,
  cropGeometry,
  fitCrop,
  mapCropAffine,
  quarterTurnedSize,
  type CropPoint,
  type CropSettings,
  type CropSize,
} from './crop'

export type CropCorner = 0 | 1 | 2 | 3

function quarterPoint(source: CropSize, crop: CropSettings, point: CropPoint): CropPoint {
  switch (crop.quarterTurns) {
    case 0:
      return point
    case 1:
      return { x: source.height - point.y, y: point.x }
    case 2:
      return { x: source.width - point.x, y: source.height - point.y }
    case 3:
      return { x: point.y, y: source.width - point.x }
  }
}

/** Translate without changing framing size; native source edges constrain the center. */
export function moveCrop(source: CropSize, crop: CropSettings, delta: CropPoint): CropSettings {
  if (![delta.x, delta.y].every(Number.isFinite)) throw new Error('Invalid crop movement.')
  const geometry = cropGeometry(source, crop),
    turned = quarterTurnedSize(source, crop.quarterTurns),
    center = mapCropAffine(geometry.outputToSource, {
      x: geometry.width / 2,
      y: geometry.height / 2,
    }),
    next = quarterPoint(source, crop, { x: center.x + delta.x, y: center.y + delta.y }),
    angle = (crop.angle * Math.PI) / 180,
    cosine = Math.cos(angle),
    sine = Math.abs(Math.sin(angle)),
    halfX = (cosine * crop.width * turned.width + sine * crop.height * turned.height) / 2,
    halfY = (sine * crop.width * turned.width + cosine * crop.height * turned.height) / 2
  if (halfX > turned.width / 2 + CROP_EDGE_EPSILON || halfY > turned.height / 2 + CROP_EDGE_EPSILON)
    throw new Error('Fit framing inside the photograph before moving it.')
  const boundX = Math.min(halfX, turned.width / 2),
    boundY = Math.min(halfY, turned.height / 2)
  const result = {
    ...crop,
    centerX: Math.max(boundX, Math.min(turned.width - boundX, next.x)) / turned.width,
    centerY: Math.max(boundY, Math.min(turned.height - boundY, next.y)) / turned.height,
  }
  cropGeometry(source, result)
  return result
}

/** Numeric/aspect/angle authoring explicitly fits the displayed draft, never an export. */
export function fitCropDraft(
  source: CropSize,
  crop: CropSettings,
  patch: Partial<Pick<CropSettings, 'angle' | 'aspectRatio' | 'width' | 'height'>>,
): CropSettings {
  const next = { ...crop, ...patch },
    turned = quarterTurnedSize(source, next.quarterTurns)
  if (next.aspectRatio !== null) {
    if ('width' in patch && !('height' in patch))
      next.height = (next.width * turned.width) / (next.aspectRatio * turned.height)
    else if ('height' in patch && !('width' in patch))
      next.width = (next.height * turned.height * next.aspectRatio) / turned.width
    // Bound an oversize ratio-constrained request by a uniform shrink first.
    const scale = Math.max(1, next.width, next.height)
    next.width /= scale
    next.height /= scale
  }
  return fitCrop(source, next)
}

/** Resize around the opposite corner. Screen positions are converted to native source first. */
export function resizeCrop(
  source: CropSize,
  crop: CropSettings,
  corner: CropCorner,
  point: CropPoint,
): CropSettings {
  if (![point.x, point.y].every(Number.isFinite) || ![0, 1, 2, 3].includes(corner))
    throw new Error('Invalid crop corner.')
  const geometry = cropGeometry(source, crop),
    turned = quarterTurnedSize(source, crop.quarterTurns),
    [xx, xy, yx, yy] = geometry.outputToSource,
    center = mapCropAffine(geometry.outputToSource, {
      x: geometry.width / 2,
      y: geometry.height / 2,
    }),
    signX = corner === 1 || corner === 2 ? 1 : -1,
    signY = corner >= 2 ? 1 : -1,
    initialWidth = crop.width * turned.width,
    initialHeight = crop.height * turned.height,
    anchor = {
      x: center.x - (signX * xx * initialWidth + signY * xy * initialHeight) / 2,
      y: center.y - (signX * yx * initialWidth + signY * yy * initialHeight) / 2,
    },
    dx = point.x - anchor.x,
    dy = point.y - anchor.y
  let width = Math.max(1, Math.min(turned.width, signX * (xx * dx + yx * dy))),
    height = Math.max(1, Math.min(turned.height, signY * (xy * dx + yy * dy)))
  if (crop.aspectRatio !== null) {
    const ratio = crop.aspectRatio,
      drivenWidth =
        Math.abs(width - initialWidth) >= Math.abs((height - initialHeight) * ratio)
          ? width
          : height * ratio
    width = Math.max(
      Math.max(1, ratio),
      Math.min(Math.min(turned.width, turned.height * ratio), drivenWidth),
    )
    height = width / ratio
  }
  // All continuous corners move linearly with width/height. Stop at the first source edge.
  let amount = 1
  for (const u of [0, signX])
    for (const v of [0, signY]) {
      const start = {
          x: anchor.x + u * xx * initialWidth + v * xy * initialHeight,
          y: anchor.y + u * yx * initialWidth + v * yy * initialHeight,
        },
        end = {
          x: anchor.x + u * xx * width + v * xy * height,
          y: anchor.y + u * yx * width + v * yy * height,
        }
      for (const [axis, limit] of [
        ['x', source.width],
        ['y', source.height],
      ] as const) {
        const change = end[axis] - start[axis]
        if (change > 0) amount = Math.min(amount, (limit - start[axis]) / change)
        else if (change < 0) amount = Math.min(amount, -start[axis] / change)
      }
    }
  amount = Math.max(0, Math.min(1, amount))
  width = initialWidth + amount * (width - initialWidth)
  height = initialHeight + amount * (height - initialHeight)
  const nextCenter = quarterPoint(source, crop, {
      x: anchor.x + (signX * xx * width + signY * xy * height) / 2,
      y: anchor.y + (signX * yx * width + signY * yy * height) / 2,
    }),
    result = {
      ...crop,
      width: width / turned.width,
      height: height / turned.height,
      centerX: nextCenter.x / turned.width,
      centerY: nextCenter.y / turned.height,
    }
  cropGeometry(source, result)
  return result
}
