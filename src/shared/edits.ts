import {
  asShot,
  validateWhiteBalance,
  type WhiteBalance,
  type WhiteBalanceProfile,
} from './white-balance'
import { neutralAdjustments, type AdjustmentParameters } from './adjustments'
import { automaticLensSettings, correctionKinds, type LensSettings } from './lens'
import type { ProcessingIdentity } from './hdr'

export const SETTINGS_VERSION = 7
export interface EditSettings extends AdjustmentParameters {
  version: 7
  processing: ProcessingIdentity
  whiteBalance: WhiteBalance
  lens: LensSettings
}
export interface EditPatch extends Partial<AdjustmentParameters> {
  lens?: Partial<LensSettings>
}
export interface EditState {
  referenceWhiteBalance?: boolean
  hdrEligible?: boolean
  whiteBalanceProfile?: WhiteBalanceProfile
  photoId: string
  revision: number
  settings: EditSettings
  canUndo: boolean
  canRedo: boolean
}
export interface EditSnapshot {
  settings: EditSettings
  createdAt: string
}
export interface EditHistory extends EditState {
  cursor: number
  snapshots: EditSnapshot[]
}
export function initialSettings(lens = automaticLensSettings): EditSettings {
  return {
    version: SETTINGS_VERSION,
    processing: 'display-referred-v1',
    ...neutralAdjustments,
    whiteBalance: asShot,
    lens: { ...lens },
  }
}
export function validatePatch(value: unknown): asserts value is EditPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid edit patch.')
  const patch = value as EditPatch
  if (
    Object.keys(patch).some(
      (key) =>
        ![
          'exposureEv',
          'contrast',
          'highlights',
          'shadows',
          'whites',
          'blacks',
          'whiteBalance',
          'lens',
        ].includes(key),
    )
  )
    throw new Error('Unknown adjustment.')
  if ('whiteBalance' in patch) validateWhiteBalance(patch.whiteBalance)
  if (
    'exposureEv' in patch &&
    (typeof patch.exposureEv !== 'number' ||
      !Number.isFinite(patch.exposureEv) ||
      patch.exposureEv < -5 ||
      patch.exposureEv > 5 ||
      Math.abs(patch.exposureEv * 100 - Math.round(patch.exposureEv * 100)) > 1e-8)
  )
    throw new Error('Exposure must be between -5 and +5 EV in steps of 0.01 EV.')
  if (
    'contrast' in patch &&
    (typeof patch.contrast !== 'number' ||
      !Number.isInteger(patch.contrast) ||
      patch.contrast < -100 ||
      patch.contrast > 100)
  )
    throw new Error('Contrast must be an integer between -100 and +100.')
  if (
    'highlights' in patch &&
    (typeof patch.highlights !== 'number' ||
      !Number.isInteger(patch.highlights) ||
      patch.highlights < -100 ||
      patch.highlights > 100)
  )
    throw new Error('Highlights must be an integer between -100 and +100.')
  for (const key of ['shadows', 'whites', 'blacks'] as const) {
    const value = patch[key]
    if (
      key in patch &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < -100 || value > 100)
    )
      throw new Error(
        `${key[0].toUpperCase() + key.slice(1)} must be an integer between -100 and +100.`,
      )
  }
  if (
    'lens' in patch &&
    (!patch.lens ||
      typeof patch.lens !== 'object' ||
      Array.isArray(patch.lens) ||
      Object.entries(patch.lens).some(
        ([key, enabled]) =>
          !correctionKinds.includes(key as (typeof correctionKinds)[number]) ||
          typeof enabled !== 'boolean',
      ))
  )
    throw new Error('Invalid lens correction setting.')
}
