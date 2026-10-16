import {
  contrastModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
  blacksModule,
  type AdjustmentParameters,
} from '../../shared/adjustments'

export function rasterLinear(rgb: number[], a: AdjustmentParameters) {
  const value = rgb.map((v) => Math.max(0, v * 2 ** a.exposureEv))
  const y = value[0] * 0.2126 + value[1] * 0.7152 + value[2] * 0.0722
  let scale = y > 0 && y < 1 ? contrastModule.cpu(y, a.contrast) / y : 1
  for (const [amount, module] of [
    [a.highlights, highlightsModule],
    [a.shadows, shadowsModule],
    [a.whites, whitesModule],
  ] as const) {
    const current = y * scale
    if (amount !== 0 && current > 0) scale *= module.cpu(current, amount) / current
  }
  let pedestal = 0
  if (a.blacks > 0) pedestal = 0.04 * (a.blacks / 100) * Math.max(1 - (y * scale) / 0.18, 0) ** 3
  else if (a.blacks < 0 && y * scale > 0)
    scale *= blacksModule.cpu(y * scale, a.blacks) / (y * scale)
  return value.map((v) => Math.max(0, Math.min(1, v * scale + pedestal)))
}
