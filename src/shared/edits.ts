import { editTransferCapabilities } from './edit-transfer-controls'
import {
  asShot,
  validateWhiteBalance,
  type WhiteBalance,
  type WhiteBalanceProfile,
} from './white-balance'
import { neutralAdjustments, type AdjustmentParameters } from './adjustments'
import { automaticLensSettings, correctionKinds, type LensSettings } from './lens'
import type { ProcessingIdentity } from './hdr'
import { identityCrop, validateCrop, type CropSettings } from './crop'
import {
  mergeColorMixer,
  neutralColorMixer,
  validateColorMixer,
  validateColorMixerPatch,
  type ColorMixerPatch,
  type ColorMixerSettings,
} from './color-mixer'
import {
  mergeColorGrading,
  neutralColorGrading,
  validateColorGrading,
  validateColorGradingPatch,
  type ColorGradingPatch,
  type ColorGradingSettings,
} from './color-grading'
import { creativeColorCapabilities } from './creative-color-controls'
import {
  neutralNoiseReduction,
  neutralDetailSharpening,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from './spatial-detail'
import {
  mergeNoiseReduction,
  mergeDetailSharpening,
  validateNoiseReductionPatch,
  validateDetailSharpeningPatch,
  type NoiseReductionPatch,
  type DetailSharpeningPatch,
  detailCapabilities,
} from './detail-controls'

export const SETTINGS_VERSION = 11
export const editCapabilities = {
  settingsVersion: SETTINGS_VERSION,
  editTransfer: editTransferCapabilities,
  ...creativeColorCapabilities,
  ...detailCapabilities,
}
export type EditCapabilities = typeof editCapabilities
export type EditFlushScope = { kind: 'all' } | { kind: 'photos'; photoIds: string[] }

export interface EditSettings extends AdjustmentParameters {
  version: 11
  noiseReduction: NoiseReductionSettings
  detailSharpening: DetailSharpeningSettings
  colorMixer: ColorMixerSettings
  colorGrading: ColorGradingSettings
  crop: CropSettings
  processing: ProcessingIdentity
  whiteBalance: WhiteBalance
  lens: LensSettings
}
export interface EditPatch extends Partial<
  Omit<AdjustmentParameters, 'colorMixer' | 'colorGrading'>
> {
  colorMixer?: ColorMixerPatch
  colorGrading?: ColorGradingPatch
  noiseReduction?: NoiseReductionPatch
  detailSharpening?: DetailSharpeningPatch
  crop?: CropSettings
  lens?: Partial<LensSettings>
}
export interface EditState {
  hdrJpeg?: import('./lens').ProcessingMetadata['hdrJpeg']
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
    crop: { ...identityCrop },
    noiseReduction: { ...neutralNoiseReduction },
    detailSharpening: { ...neutralDetailSharpening },
    processing: 'display-referred-v1',
    ...neutralAdjustments,
    whiteBalance: asShot,
    colorMixer: structuredClone(neutralColorMixer),
    colorGrading: structuredClone(neutralColorGrading),
    lens: { ...lens },
  }
}
export function validatePatch(value: unknown): asserts value is EditPatch {
  validateFields(value, 'patch')
}
/** Processing requests require complete groups, while the edit API accepts partial changes. */
export function validateProcessingPatch(
  value: unknown,
): asserts value is Partial<AdjustmentParameters> {
  validateFields(value, 'full')
}
export function mergeEditPatch(base: EditSettings, patch: EditPatch): EditSettings {
  validatePatch(patch)
  return structuredClone({
    ...base,
    ...patch,
    noiseReduction: patch.noiseReduction
      ? mergeNoiseReduction(base.noiseReduction, patch.noiseReduction)
      : base.noiseReduction,
    detailSharpening: patch.detailSharpening
      ? mergeDetailSharpening(base.detailSharpening, patch.detailSharpening)
      : base.detailSharpening,
    lens: { ...base.lens, ...patch.lens },
    colorMixer: patch.colorMixer
      ? mergeColorMixer(base.colorMixer, patch.colorMixer)
      : base.colorMixer,
    colorGrading: patch.colorGrading
      ? mergeColorGrading(base.colorGrading, patch.colorGrading)
      : base.colorGrading,
  })
}
function validateFields(value: unknown, creative: 'patch' | 'full'): asserts value is EditPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid edit patch.')
  const patch = value as EditPatch
  if (
    Object.keys(patch).some(
      (key) =>
        ![
          ...(creative === 'patch' ? ['noiseReduction', 'detailSharpening'] : []),
          'exposureEv',
          'contrast',
          'highlights',
          'shadows',
          'whites',
          'blacks',
          'saturation',
          'vibrance',
          'whiteBalance',
          'lens',
          'crop',
          'colorMixer',
          'colorGrading',
        ].includes(key),
    )
  )
    throw new Error('Unknown adjustment.')
  if ('noiseReduction' in patch) validateNoiseReductionPatch(patch.noiseReduction)
  if ('detailSharpening' in patch) validateDetailSharpeningPatch(patch.detailSharpening)
  if ('colorMixer' in patch) {
    if (creative === 'full') validateColorMixer(patch.colorMixer)
    else validateColorMixerPatch(patch.colorMixer)
  }
  if ('colorGrading' in patch) {
    if (creative === 'full') validateColorGrading(patch.colorGrading)
    else validateColorGradingPatch(patch.colorGrading)
  }
  if ('crop' in patch) validateCrop(patch.crop)
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
  for (const key of ['shadows', 'whites', 'blacks', 'saturation', 'vibrance'] as const) {
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
