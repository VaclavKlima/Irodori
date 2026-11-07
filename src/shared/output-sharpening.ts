import type { ExportOptions } from './export'
import { DETAIL_SHARPENING_VERSION, type DetailSharpeningSettings } from './spatial-detail'

export const OUTPUT_SHARPENING_MODES = ['off', 'low', 'standard', 'high'] as const
export type OutputSharpeningMode = (typeof OUTPUT_SHARPENING_MODES)[number]
export const outputSharpeningLabels: Readonly<Record<OutputSharpeningMode, string>> = {
  off: 'Off',
  low: 'Low',
  standard: 'Standard',
  high: 'High',
}
export const OUTPUT_SHARPENING_VERSION = `${DETAIL_SHARPENING_VERSION}-output-25-50-75-r1-t50-v1`
export const OUTPUT_SHARPENING_STAGE = 'output-linear-after-resize-before-encoding-v1'
export const outputSharpeningCapabilities = {
  modes: OUTPUT_SHARPENING_MODES,
  defaultMode: 'off',
  filter: OUTPUT_SHARPENING_VERSION,
  stage: OUTPUT_SHARPENING_STAGE,
} as const

/** Legacy export options intentionally retain their unsharpened pixels. */
export function outputSharpeningMode(
  options: Pick<ExportOptions, 'outputSharpening'>,
): OutputSharpeningMode {
  const mode = options.outputSharpening === undefined ? 'off' : options.outputSharpening
  if (!OUTPUT_SHARPENING_MODES.includes(mode)) throw new Error('Invalid output sharpening setting.')
  return mode
}

/** Radius is Gaussian sigma in final output pixels, independent of preview zoom. */
export function resolveOutputSharpening(
  options: Pick<ExportOptions, 'outputSharpening'>,
): DetailSharpeningSettings {
  return {
    version: 1,
    amount: { off: 0, low: 25, standard: 50, high: 75 }[outputSharpeningMode(options)],
    radius: 1,
    threshold: 50,
  }
}
