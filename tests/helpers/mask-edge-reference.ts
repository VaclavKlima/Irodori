import type { ResolvedMask } from '../../src/shared/masks'
import { referenceCoverage } from './mask-reference'

/** Independent Float64 spatial oracle; one 2D convolution instead of GPU separable passes. */
export function referenceMaskEdges(
  mask: ResolvedMask,
  width: number,
  height: number,
  base?: Uint8Array,
) {
  const sample = (data: Float64Array, x: number, y: number) =>
    data[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]
  const composed = new Float64Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = base
        ? base[y * width + x] / 255
        : referenceCoverage(
            { ...mask, strokes: [], inverted: false },
            (x + 0.5) / width,
            (y + 0.5) / height,
            width,
            height,
          )
      for (const stroke of mask.strokes) {
        const amount = referenceCoverage(
          {
            ...mask,
            inverted: false,
            base: undefined,
            gradient: undefined,
            strokes: [{ ...stroke, mode: 'add' }],
          },
          (x + 0.5) / width,
          (y + 0.5) / height,
          width,
          height,
        )
        value = stroke.mode === 'add' ? Math.max(value, amount) : value * (1 - amount)
      }
      composed[y * width + x] = mask.inverted ? 1 - value : value
    }
  const shifted = new Float64Array(composed.length)
  const radius = Math.abs(mask.edge.shiftPx)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = mask.edge.shiftPx >= 0 ? 0 : 1
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue
          const at = sample(composed, x + dx, y + dy)
          value = mask.edge.shiftPx >= 0 ? Math.max(value, at) : Math.min(value, at)
        }
      shifted[y * width + x] = value
    }
  const feather = mask.edge.featherPx,
    support = Math.ceil(feather),
    sigma = feather / 3
  const result = new Uint8Array(composed.length)
  let total = 0
  const taps: { x: number; y: number; weight: number }[] = []
  for (let y = -support; y <= support; y++)
    for (let x = -support; x <= support; x++) {
      const weight = feather ? Math.exp(-(x * x + y * y) / (2 * sigma * sigma)) : 1
      taps.push({ x, y, weight })
      total += weight
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0
      for (const tap of taps) value += (sample(shifted, x + tap.x, y + tap.y) * tap.weight) / total
      result[y * width + x] = Math.floor(Math.max(0, Math.min(1, value)) * 255 + 0.5)
    }
  return result
}
