import type { MaskGradient, MaskPoint } from '../../../shared/masks'
import {
  maskCanonicalPoint,
  maskOutputPoint,
  type MaskGeometry,
  maskOutputSize,
} from '../../../shared/mask-geometry'
export type GradientHandle = 'start' | 'end' | 'move' | 'radiusX' | 'radiusY' | 'rotate'
export function gradientFromDrag(
  kind: MaskGradient['kind'],
  start: MaskPoint,
  end: MaskPoint,
): MaskGradient {
  return kind === 'linear'
    ? { kind, start, end }
    : {
        kind,
        center: start,
        radiusX: Math.abs(end.x - start.x),
        radiusY: Math.abs(end.y - start.y),
        rotation: 0,
        feather: 50,
      }
}
/** Defaults use the cropped output extent, independent of the current view. */
export function centeredGradient(kind: MaskGradient['kind'], geometry: MaskGeometry): MaskGradient {
  const { width, height } = maskOutputSize(geometry)
  const point = (x: number, y: number) =>
    maskCanonicalPoint({ x: x * width, y: y * height }, geometry)
  if (kind === 'linear') return { kind, start: point(0.5, 0.25), end: point(0.5, 0.75) }
  const center = point(0.5, 0.5),
    x = point(0.75, 0.5),
    y = point(0.5, 0.75),
    w = geometry.canonicalWidth,
    h = geometry.canonicalHeight
  return {
    kind,
    center,
    radiusX: Math.hypot((x.x - center.x) * w, (x.y - center.y) * h) / w,
    radiusY: Math.hypot((y.x - center.x) * w, (y.y - center.y) * h) / h,
    rotation: (Math.atan2((x.y - center.y) * h, (x.x - center.x) * w) * 180) / Math.PI,
    feather: 50,
  }
}
export function gradientHandlePoint(
  g: MaskGradient,
  handle: GradientHandle,
  width: number,
  height: number,
): MaskPoint {
  if (g.kind === 'linear')
    return handle === 'start'
      ? g.start
      : handle === 'end'
        ? g.end
        : { x: (g.start.x + g.end.x) / 2, y: (g.start.y + g.end.y) / 2 }
  const a = (g.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a)
  if (handle === 'move') return g.center
  const x = handle === 'radiusY' ? 0 : g.radiusX * width * (handle === 'rotate' ? 1.25 : 1),
    y = handle === 'radiusY' ? g.radiusY * height : 0
  return { x: g.center.x + (x * c - y * s) / width, y: g.center.y + (x * s + y * c) / height }
}
export function moveGradientHandle(
  g: MaskGradient,
  handle: GradientHandle,
  origin: MaskPoint,
  point: MaskPoint,
  width: number,
  height: number,
): MaskGradient {
  const dx = point.x - origin.x,
    dy = point.y - origin.y
  if (g.kind === 'linear') {
    if (handle === 'move')
      return {
        ...g,
        start: { x: g.start.x + dx, y: g.start.y + dy },
        end: { x: g.end.x + dx, y: g.end.y + dy },
      }
    return { ...g, [handle]: point }
  }
  if (handle === 'move') return { ...g, center: { x: g.center.x + dx, y: g.center.y + dy } }
  const x = (point.x - g.center.x) * width,
    y = (point.y - g.center.y) * height,
    a = (g.rotation * Math.PI) / 180
  if (handle === 'rotate') return { ...g, rotation: (Math.atan2(y, x) * 180) / Math.PI }
  return handle === 'radiusX'
    ? { ...g, radiusX: Math.abs(x * Math.cos(a) + y * Math.sin(a)) / width }
    : { ...g, radiusY: Math.abs(-x * Math.sin(a) + y * Math.cos(a)) / height }
}

/** Clip guides to the supported source domain without moving their geometry.
 * A guide can leave and re-enter that domain; keep those pieces separate. */
function boundedGuide(line: readonly MaskPoint[]): MaskPoint[][] {
  const pieces: MaskPoint[][] = []
  let current: MaskPoint[] = []
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1],
      b = line[i]
    let low = 0,
      high = 1
    for (const axis of ['x', 'y'] as const) {
      const delta = b[axis] - a[axis]
      if (!Number.isFinite(delta)) {
        high = -1
        break
      }
      if (delta === 0) {
        if (a[axis] < -1 || a[axis] > 2) {
          high = -1
          break
        }
      } else {
        const start = (-1 - a[axis]) / delta,
          end = (2 - a[axis]) / delta
        low = Math.max(low, Math.min(start, end))
        high = Math.min(high, Math.max(start, end))
      }
    }
    if (low > high) {
      if (current.length) pieces.push(current)
      current = []
      continue
    }
    const at = (t: number): MaskPoint => ({
        // Rounding at a computed clipping intersection must remain in the domain.
        x: Math.max(-1, Math.min(2, a.x + (b.x - a.x) * t)),
        y: Math.max(-1, Math.min(2, a.y + (b.y - a.y) * t)),
      }),
      start = at(low),
      end = at(high),
      previous = current.at(-1)
    if (!previous || Math.hypot(previous.x - start.x, previous.y - start.y) > 1e-10) {
      if (current.length) pieces.push(current)
      current = [start]
    }
    current.push(end)
  }
  if (current.length) pieces.push(current)
  return pieces
}
/** Sample source-space guides before projecting, including nonlinear lens registration. */
export function gradientGuide(g: MaskGradient, geometry: MaskGeometry): MaskPoint[][] | null {
  const w = geometry.canonicalWidth,
    h = geometry.canonicalHeight,
    lines: MaskPoint[][] = []
  if (g.kind === 'linear') {
    lines.push(
      Array.from({ length: 65 }, (_, i) => ({
        x: g.start.x + ((g.end.x - g.start.x) * i) / 64,
        y: g.start.y + ((g.end.y - g.start.y) * i) / 64,
      })),
    )
    const dx = (g.end.x - g.start.x) * w,
      dy = (g.end.y - g.start.y) * h,
      n = Math.hypot(dx, dy),
      extent = Math.hypot(w, h)
    for (const p of [g.start, g.end])
      lines.push(
        Array.from({ length: 65 }, (_, i) => ({
          x: p.x - ((dy / n) * extent * (i / 64 - 0.5)) / w,
          y: p.y + ((dx / n) * extent * (i / 64 - 0.5)) / h,
        })),
      )
  } else {
    for (const scale of [1, 1 - g.feather / 100])
      lines.push(
        Array.from({ length: 129 }, (_, i) => {
          const t = (i / 128) * Math.PI * 2,
            a = (g.rotation * Math.PI) / 180,
            x = Math.cos(t) * g.radiusX * w * scale,
            y = Math.sin(t) * g.radiusY * h * scale
          return {
            x: g.center.x + (x * Math.cos(a) - y * Math.sin(a)) / w,
            y: g.center.y + (x * Math.sin(a) + y * Math.cos(a)) / h,
          }
        }),
      )
    lines.push([g.center, gradientHandlePoint(g, 'rotate', w, h)])
  }
  const projected = lines
    .flatMap(boundedGuide)
    .map((line) => line.map((p) => maskOutputPoint(p, geometry)))
  return projected.some((line) => line.some((p) => !p)) ? null : (projected as MaskPoint[][])
}
