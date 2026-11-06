import type { EditPatch } from './edits'
import type { EditTransferGroup } from './edit-transfer-controls'

/** Shared field ownership for persisted definitions and the agent-facing input schema. */
export const presetGroupKeys = {
  light: ['exposureEv', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  curves: ['curves'],
  color: ['saturation', 'vibrance'],
  mixer: ['colorMixer'],
  grading: ['colorGrading'],
  noise: ['noiseReduction'],
  sharpening: ['detailSharpening'],
  crop: ['crop'],
  'white-balance': ['whiteBalance'],
  lens: ['lens'],
} as const satisfies Record<EditTransferGroup, readonly (keyof EditPatch)[]>
