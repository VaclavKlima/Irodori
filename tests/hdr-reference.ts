// Independent Float64 reference: scalar luminance operators and XYZ primary conversion.
// D65 matrices from CSS Color 4 sample conversion code; no production math imports.
import type { AdjustmentParameters } from '../src/shared/adjustments'
const weights = [0.2627002120112671, 0.6779980715188708, 0.059301716469862]
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0)
export function referenceAdjust(input: number[], p: AdjustmentParameters) {
  let rgb = input.map((v) => v * Math.pow(2, p.exposureEv))
  const scale = (next: (y: number) => number) => {
    const y = dot(weights, rgb)
    if (y > 0) rgb = rgb.map((v) => (v * next(y)) / y)
  }
  scale((y) =>
    y >= 1
      ? y
      : y <= 0.18
        ? 0.18 * Math.pow(y / 0.18, Math.pow(2, p.contrast / 100))
        : 1 - 0.82 * Math.pow((1 - y) / 0.82, Math.pow(2, p.contrast / 100)),
  )
  scale((y) =>
    y <= 0.18 ? y : y + (p.highlights / 100) * (y - 0.18 - (0.82 * (y - 0.18)) / (y + 0.64)),
  )
  scale((y) =>
    y >= 0.18 ? y : y * Math.pow(2, ((2 * p.shadows) / 100) * Math.pow(1 - y / 0.18, 2)),
  )
  scale((y) => {
    const t = Math.min(1, Math.max(0, (y - 0.18) / 0.82))
    return y * Math.pow(2, (p.whites / 100) * (3 * t * t - 2 * t * t * t))
  })
  const y = dot(weights, rgb),
    d = ((0.04 * p.blacks) / 100) * Math.pow(Math.max(0, 1 - y / 0.18), 3)
  if (y >= 0 && p.blacks > 0) rgb = rgb.map((v) => v + d)
  else if (y > 0 && p.blacks < 0) rgb = rgb.map((v) => (v * Math.max(0, y + d)) / y)
  return rgb
}
