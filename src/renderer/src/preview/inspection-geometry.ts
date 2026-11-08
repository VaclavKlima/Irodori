import type { AgentInspectionRegion } from '../../../shared/agent'
import type { MaskGeometry } from '../../../shared/mask-geometry'
import type { PresentedPreviewGeometry, Size } from './geometry'
type InspectionRectangle = AgentInspectionRegion['region']

export interface RegionPoint {
  x: number
  y: number
}
export type RegionHandle = 'create' | 'move' | 'nw' | 'ne' | 'se' | 'sw'
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))

/** Prepared and presented assets may omit the explicit identity crop; the mappings are equivalent. */
export function inspectionGeometryMatches(
  a: MaskGeometry | undefined,
  b: MaskGeometry | undefined,
): boolean {
  const normalized = (geometry: MaskGeometry | undefined) => {
    if (!geometry) return geometry
    const { crop, ...source } = geometry
    return crop?.identity ? source : geometry
  }
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b))
}

/** Coordinates use the last submitted photograph, even when requested zoom is still pending. */
export function inspectionPoint(
  point: RegionPoint,
  geometry: PresentedPreviewGeometry,
  viewport: Size,
): RegionPoint {
  return {
    x: clamp(
      ((point.x * geometry.viewport.width) / viewport.width -
        geometry.viewport.width / 2 -
        geometry.view.x) /
        geometry.view.scale +
        geometry.image.width / 2,
      0,
      geometry.image.width,
    ),
    y: clamp(
      ((point.y * geometry.viewport.height) / viewport.height -
        geometry.viewport.height / 2 -
        geometry.view.y) /
        geometry.view.scale +
        geometry.image.height / 2,
      0,
      geometry.image.height,
    ),
  }
}

export function inspectionDrag(
  start: RegionPoint,
  point: RegionPoint,
  rectangle: InspectionRectangle,
  handle: RegionHandle,
  size: Size,
): InspectionRectangle {
  if (handle === 'move')
    return {
      ...rectangle,
      x: clamp(Math.round(rectangle.x + point.x - start.x), 0, size.width - rectangle.width),
      y: clamp(Math.round(rectangle.y + point.y - start.y), 0, size.height - rectangle.height),
    }
  const anchor =
    handle === 'create'
      ? start
      : {
          x: handle.includes('w') ? rectangle.x + rectangle.width : rectangle.x,
          y: handle.includes('n') ? rectangle.y + rectangle.height : rectangle.y,
        }
  const x = clamp(Math.floor(Math.min(anchor.x, point.x)), 0, size.width - 1),
    y = clamp(Math.floor(Math.min(anchor.y, point.y)), 0, size.height - 1)
  return {
    ...rectangle,
    x,
    y,
    width: Math.max(1, Math.min(size.width, Math.ceil(Math.max(anchor.x, point.x))) - x),
    height: Math.max(1, Math.min(size.height, Math.ceil(Math.max(anchor.y, point.y))) - y),
  }
}

export function validInspectionRectangle(rectangle: InspectionRectangle, size: Size): boolean {
  return (
    [rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isSafeInteger) &&
    rectangle.x >= 0 &&
    rectangle.y >= 0 &&
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    rectangle.x + rectangle.width <= size.width &&
    rectangle.y + rectangle.height <= size.height
  )
}
