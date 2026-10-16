import type { ImageSpec, Json, Region } from './contract.ts'

export interface Geometry {
  orientation: 0 | 90 | 180 | 270
  lensK1: number
  crop: Region
}
export function geometry(value: Json | undefined, source: ImageSpec, output: ImageSpec): Geometry {
  const g = value as unknown as Geometry
  const width = g?.orientation === 90 || g?.orientation === 270 ? source.height : source.width
  const height = g?.orientation === 90 || g?.orientation === 270 ? source.width : source.height
  if (
    !g ||
    ![0, 90, 180, 270].includes(g.orientation) ||
    !Number.isFinite(g.lensK1) ||
    Math.abs(g.lensK1) > 0.3 ||
    !g.crop ||
    !Object.values(g.crop).every(Number.isSafeInteger) ||
    g.crop.x < 0 ||
    g.crop.y < 0 ||
    g.crop.width < 1 ||
    g.crop.height < 1 ||
    g.crop.x + g.crop.width > width ||
    g.crop.y + g.crop.height > height ||
    output.width !== g.crop.width ||
    output.height !== g.crop.height
  )
    throw new Error('Invalid explicit geometry transform.')
  return g
}
/** Pixel centers: crop -> inverse orientation -> inverse radial lens sampling. */
export function outputToSource(x: number, y: number, source: ImageSpec, g: Geometry) {
  x += g.crop.x
  y += g.crop.y
  const w = source.width,
    h = source.height
  if (g.orientation === 90) [x, y] = [y, h - 1 - x]
  else if (g.orientation === 180) [x, y] = [w - 1 - x, h - 1 - y]
  else if (g.orientation === 270) [x, y] = [w - 1 - y, x]
  const cx = (w - 1) / 2,
    cy = (h - 1) / 2,
    radius = Math.hypot(w, h) / 2
  const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / radius ** 2
  return [cx + (x - cx) * (1 + g.lensK1 * r2), cy + (y - cy) * (1 + g.lensK1 * r2)] as const
}
