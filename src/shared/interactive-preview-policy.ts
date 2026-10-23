import type { RenderingTarget } from './display-rendering'

/** Gesture feedback combines SDR matrix correction with the unchanged HDR shader. */
export const ACES_INTERACTIVE_PREVIEW_VERSION = 'aces2-f32-interactive-v3-sdr4-hdr1' as const
export const ACES_SDR_INTERACTIVE_PREVIEW_VERSION = 'aces2-f32-interactive-v4' as const
export const ACES_HDR_INTERACTIVE_PREVIEW_VERSION = 'aces2-f32-interactive-v1' as const

export type AcesInteractivePreviewPolicy =
  typeof ACES_SDR_INTERACTIVE_PREVIEW_VERSION | typeof ACES_HDR_INTERACTIVE_PREVIEW_VERSION
export type AcesPreviewPolicy = 'reference' | AcesInteractivePreviewPolicy

/** Select only from the confirmed semantic target; settled rendering remains canonical. */
export function selectInteractivePreviewPolicy(
  selector: unknown,
  mode: RenderingTarget['mode'],
): AcesPreviewPolicy {
  if (selector !== 'f32') return 'reference'
  return mode === 'sdr'
    ? ACES_SDR_INTERACTIVE_PREVIEW_VERSION
    : ACES_HDR_INTERACTIVE_PREVIEW_VERSION
}
