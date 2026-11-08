import type { PresentedPreviewGeometry, Size } from './geometry'

import type { SelectionPoint } from '../../../shared/object-selection'
export { selectionCanonicalBox, selectionCanonicalPoint } from '../../../shared/object-selection'
export type { SelectionPoint, SelectionRectangle } from '../../../shared/object-selection'

/** Hit testing uses submitted presentation geometry, never a requested zoom/pan. */
export function selectionDisplayPoint(
  point: SelectionPoint,
  geometry: PresentedPreviewGeometry,
  viewport: Size,
  clamp = false,
): SelectionPoint | null {
  if (!viewport.width || !viewport.height || geometry.view.scale <= 0) return null
  let x =
      ((point.x * geometry.viewport.width) / viewport.width -
        geometry.viewport.width / 2 -
        geometry.view.x) /
        geometry.view.scale +
      geometry.image.width / 2,
    y =
      ((point.y * geometry.viewport.height) / viewport.height -
        geometry.viewport.height / 2 -
        geometry.view.y) /
        geometry.view.scale +
      geometry.image.height / 2
  if (![x, y].every(Number.isFinite)) return null
  if (clamp) {
    x = Math.max(0, Math.min(geometry.image.width, x))
    y = Math.max(0, Math.min(geometry.image.height, y))
  }
  if (x < 0 || y < 0 || x > geometry.image.width || y > geometry.image.height) return null
  return { x, y }
}

export function selectionScreenPoint(
  point: SelectionPoint,
  geometry: PresentedPreviewGeometry,
  viewport: Size,
): SelectionPoint {
  return {
    x:
      ((geometry.viewport.width / 2 +
        geometry.view.x +
        (point.x - geometry.image.width / 2) * geometry.view.scale) *
        viewport.width) /
      geometry.viewport.width,
    y:
      ((geometry.viewport.height / 2 +
        geometry.view.y +
        (point.y - geometry.image.height / 2) * geometry.view.scale) *
        viewport.height) /
      geometry.viewport.height,
  }
}
