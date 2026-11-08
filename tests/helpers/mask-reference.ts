import type { MaskLight, MaskStroke, ResolvedMask } from '../../src/shared/masks'

/** Independent scalar oracle; production mask pixels are evaluated only by GPU programs. */
export function referenceCoverage(
  mask: ResolvedMask,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.min(width, height)
  let coverage = 0
  for (const stroke of mask.strokes) {
    let distance = Infinity
    for (let i = 0; i < Math.max(1, stroke.points.length - 1); i++) {
      const a = stroke.points[i],
        b = stroke.points[Math.min(i + 1, stroke.points.length - 1)],
        ax = (a.x * width) / scale,
        ay = (a.y * height) / scale,
        bx = (b.x * width) / scale,
        by = (b.y * height) / scale,
        dx = bx - ax,
        dy = by - ay,
        squared = dx * dx + dy * dy,
        t = squared
          ? Math.max(
              0,
              Math.min(
                1,
                (((x * width) / scale - ax) * dx + ((y * height) / scale - ay) * dy) / squared,
              ),
            )
          : 0
      distance = Math.min(
        distance,
        Math.hypot((x * width) / scale - ax - t * dx, (y * height) / scale - ay - t * dy),
      )
    }
    let brush = distance <= stroke.radius ? 1 : 0
    if (stroke.feather) {
      const t = Math.max(
        0,
        Math.min(
          1,
          (distance - stroke.radius * (1 - stroke.feather)) / (stroke.radius * stroke.feather),
        ),
      )
      brush = 1 - t * t * (3 - 2 * t)
    }
    coverage = stroke.mode === 'add' ? Math.max(coverage, brush) : coverage * (1 - brush)
  }
  return mask.inverted ? 1 - coverage : coverage
}

export function referenceLight(input: number[], controls: MaskLight, scene: boolean) {
  let rgb = input.map((value) => value * 2 ** controls.exposureEv)
  const weights = scene
    ? [0.2627002120112671, 0.6779980715188708, 0.059301716469862]
    : [0.2126, 0.7152, 0.0722]
  if (!scene) rgb = rgb.map((value) => Math.max(0, value))
  const luminance = () => rgb.reduce((sum, value, i) => sum + value * weights[i], 0)
  const multiply = (factor: number) => {
    rgb = rgb.map((value) => value * factor)
  }
  let y = luminance()
  if (controls.contrast && y > 0 && y < 1) {
    const exponent = 2 ** (controls.contrast / 100),
      next = y <= 0.18 ? 0.18 * (y / 0.18) ** exponent : 1 - 0.82 * ((1 - y) / 0.82) ** exponent
    multiply(next / y)
  }
  y = luminance()
  if (controls.highlights && y > 0.18) {
    const h = controls.highlights / 100,
      d = y - 0.18
    multiply(((1 + h) * y - h * (0.18 + (0.82 * d) / (0.82 + d))) / y)
  }
  y = luminance()
  if (controls.shadows && y > 0 && y < 0.18)
    multiply(2 ** (((2 * controls.shadows) / 100) * (1 - y / 0.18) ** 2))
  y = luminance()
  if (controls.whites && y > 0.18) {
    const t = Math.max(0, Math.min(1, (y - 0.18) / 0.82))
    multiply(2 ** ((controls.whites / 100) * t * t * (3 - 2 * t)))
  }
  y = luminance()
  if (controls.blacks && y >= 0) {
    const d = ((0.04 * controls.blacks) / 100) * Math.max(1 - y / 0.18, 0) ** 3
    if (controls.blacks > 0) rgb = rgb.map((value) => value + d)
    else if (y > 0) multiply(Math.max(0, y + d) / y)
  }
  return rgb
}

export function referenceStack(
  masks: readonly ResolvedMask[],
  input: number[],
  point: { x: number; y: number },
  width: number,
  height: number,
  scene: boolean,
) {
  let rgb = [...input]
  for (const mask of [...masks].reverse()) {
    if (!mask.enabled || Object.values(mask.light).every((value) => value === 0)) continue
    const coverage = referenceCoverage(mask, point.x, point.y, width, height),
      changed = referenceLight(rgb, mask.light, scene)
    rgb = rgb.map((value, i) => value * (1 - coverage) + changed[i] * coverage)
  }
  return rgb
}

export function brush(
  mode: MaskStroke['mode'],
  radius: number,
  feather: number,
  points: number[][],
): MaskStroke {
  return { mode, radius, feather, points: points.map(([x, y]) => ({ x, y })) }
}
