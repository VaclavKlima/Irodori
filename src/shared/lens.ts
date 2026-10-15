import type { WhiteBalanceProfile } from './white-balance'
import type { AdjustmentParameters } from './adjustments'
import type { DisplayTransform } from './adjustments'
import type { ProcessingIdentity, HdrWorkingAsset } from './hdr'
export const PROCESSING_METADATA_VERSION = 4
export const correctionKinds = ['distortion', 'vignetting', 'chromaticAberration'] as const
export type CorrectionKind = (typeof correctionKinds)[number]
export type LensSettings = Record<CorrectionKind, boolean>
export const automaticLensSettings: LensSettings = {
  distortion: true,
  vignetting: true,
  chromaticAberration: true,
}
export const noLensSettings: LensSettings = {
  distortion: false,
  vignetting: false,
  chromaticAberration: false,
}

/** Provider-neutral radial splines. Radius is measured in sensor half-diagonals. */
export interface RadialTable {
  radii: number[]
  values: number[]
}
export interface LensProfile {
  provider: string
  version: string
  label: string
  identity: string
  distortion?: RadialTable
  vignetting?: RadialTable
  chromaticAberration?: { red: RadialTable; blue: RadialTable }
  unavailable: Partial<Record<CorrectionKind, string>>
}
export interface ProcessingMetadata {
  hdrJpeg?:
    | { version: 1; state: 'supported'; headroom: number }
    | { version: 1; state: 'sdr-only'; reason: string }
  capturedAt?: string
  capture?: import('./merge').MergeCapture
  mergeMaster?: { asset: HdrWorkingAsset; recipe: import('./merge').MergeRecipe }
  hdrEligible?: boolean
  whiteBalance?: WhiteBalanceProfile
  version: number
  make?: string
  model?: string
  lens?: string
  focalLength?: number
  aperture?: number
  orientation?: number
  lensProfile: LensProfile
}
export interface LensState {
  fixed?: boolean
  photoId: string
  revision: number
  settings: LensSettings
  profile: LensProfile
}
export interface ProcessingOptions {
  processing?: ProcessingIdentity
  /** Main-process owned cache asset, never accepted from the renderer. */
  workingAsset?: {
    path: string
    width: number
    height: number
    byteLength: number
    sha256: string
    transform: DisplayTransform
    hdr?: HdrWorkingAsset
  }
  adjustments?: AdjustmentParameters
  prepareLinear?: boolean
  workingOnly?: boolean
  metadata: ProcessingMetadata
  settings: LensSettings
  revision: number
}
export function appliedCorrections(profile: LensProfile, settings: LensSettings): LensSettings {
  return {
    distortion: settings.distortion && !!profile.distortion,
    vignetting: settings.vignetting && !!profile.vignetting,
    chromaticAberration: settings.chromaticAberration && !!profile.chromaticAberration,
  }
}
