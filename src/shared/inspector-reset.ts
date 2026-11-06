import type { EditPatch, EditState } from './edits'
import type { InspectorGroup } from './workspace'
import { neutralColorMixer } from './color-mixer'
import { neutralColorGrading } from './color-grading'
import { neutralNoiseReduction, neutralDetailSharpening } from './spatial-detail'
import { identityCrop } from './crop'
import { identityToneCurves } from './tone-curves'
import { automaticLensSettings, correctionKinds, type LensState } from './lens'

/** Each returned patch is committed atomically by the existing photo edit service. */
export function inspectorReset(
  group: InspectorGroup,
  state: EditState,
  lens?: LensState,
): EditPatch {
  switch (group) {
    case 'light':
      return {
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        curves: identityToneCurves,
      }
    case 'color':
      return {
        saturation: 0,
        vibrance: 0,
        colorMixer: neutralColorMixer,
        colorGrading: neutralColorGrading,
        ...(state.whiteBalanceProfile ? { whiteBalance: { mode: 'as-shot' as const } } : {}),
      }
    case 'detail':
      return { noiseReduction: neutralNoiseReduction, detailSharpening: neutralDetailSharpening }
    case 'geometry':
      return {
        crop: identityCrop,
        ...(lens && !lens.fixed
          ? {
              lens: Object.fromEntries(
                correctionKinds
                  .filter((kind) => lens.profile[kind])
                  .map((kind) => [kind, automaticLensSettings[kind]]),
              ),
            }
          : {}),
      }
    case 'info':
    case 'presets':
      return {}
  }
}
