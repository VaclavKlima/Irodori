export interface Size {
  width: number
  height: number
}
export interface View {
  fit: boolean
  scale: number
  x: number
  y: number
}
export const ZOOM_STOPS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32]
export const INITIAL_VIEW: View = { fit: true, scale: 1, x: 0, y: 0 }

export function fitScale(image: Size, viewport: Size): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  return Math.min(1, viewport.width / image.width, viewport.height / image.height)
}
export function minimumScale(image: Size, viewport: Size): number {
  return Math.min(0.1, fitScale(image, viewport))
}
/** Preserve the normalized source point at the viewport center when dimensions become authoritative. */
export function replaceDimensions(view: View, before: Size, after: Size, viewport: Size): View {
  return constrain(
    {
      ...view,
      x: before.width ? (view.x * after.width) / before.width : 0,
      y: before.height ? (view.y * after.height) / before.height : 0,
    },
    after,
    viewport,
  )
}
export function constrain(view: View, image: Size, viewport: Size): View {
  if (view.fit) return { fit: true, scale: fitScale(image, viewport), x: 0, y: 0 }
  const scale = Math.max(minimumScale(image, viewport), Math.min(32, view.scale))
  const limitX = Math.max(0, (image.width * scale - viewport.width) / 2)
  const limitY = Math.max(0, (image.height * scale - viewport.height) / 2)
  return {
    fit: false,
    scale,
    x: limitX ? Math.max(-limitX, Math.min(limitX, view.x)) : 0,
    y: limitY ? Math.max(-limitY, Math.min(limitY, view.y)) : 0,
  }
}
/** Pointer coordinates are relative to the viewport center, matching translation coordinates. */
export function zoomAt(
  view: View,
  scale: number,
  point: { x: number; y: number },
  image: Size,
  viewport: Size,
): View {
  const nextScale = Math.max(minimumScale(image, viewport), Math.min(32, scale))
  const ratio = nextScale / view.scale
  return constrain(
    {
      fit: false,
      scale: nextScale,
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
    },
    image,
    viewport,
  )
}
export function stepScale(scale: number, direction: -1 | 1, minimum: number): number {
  return direction > 0
    ? (ZOOM_STOPS.find((stop) => stop > scale + 0.00001) ?? 32)
    : ([...ZOOM_STOPS].reverse().find((stop) => stop < scale - 0.00001) ?? minimum)
}
export function wheelScale(
  scale: number,
  delta: number,
  mode: number,
  viewportHeight: number,
): number {
  return scale * Math.exp(-wheelPixels(delta, mode, viewportHeight) / 100)
}
export function wheelPixels(delta: number, mode: number, viewportExtent: number): number {
  return delta * (mode === 1 ? 16 : mode === 2 ? viewportExtent : 1)
}
export function wheelView(
  view: View,
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey'>,
  point: { x: number; y: number },
  image: Size,
  viewport: Size,
): View {
  if (event.ctrlKey)
    return event.deltaY
      ? zoomAt(
          view,
          wheelScale(view.scale, event.deltaY, event.deltaMode, viewport.height),
          point,
          image,
          viewport,
        )
      : view
  if (view.fit || (!event.deltaX && !event.deltaY)) return view
  return constrain(
    {
      ...view,
      x: view.x - wheelPixels(event.deltaX, event.deltaMode, viewport.width),
      y: view.y - wheelPixels(event.deltaY, event.deltaMode, viewport.height),
    },
    image,
    viewport,
  )
}
