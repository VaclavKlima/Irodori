import { mergeEditPatch, validatePatch, type EditPatch, type EditSettings } from './edits'
import { correctionKinds, type ProcessingMetadata } from './lens'

import { editTransferGroups, type EditTransferGroup } from './edit-transfer-controls'
export {
  editTransferGroups,
  defaultEditTransferGroups,
  editTransferCapabilities,
  type EditTransferGroup,
} from './edit-transfer-controls'

export interface EditClipboard {
  id: string
  photoId: string
  filename: string
  revision: number
  copiedAt: string
  groups: EditTransferGroup[]
}
/** Main-owned snapshot; the renderer receives only EditClipboard metadata. */
export interface CopiedEdits {
  version: 1
  clipboard: EditClipboard
  settings: EditSettings
  whiteBalanceIdentity?: string
  lensKinds: (typeof correctionKinds)[number][]
}
export interface PasteEditsRequest {
  clipboardId: string
  photoIds: string[]
  groups: EditTransferGroup[]
}
export interface EditPasteTarget {
  photoId: string
  filename: string
  revision: number
  unavailable?: string
}
export interface EditPastePreparation {
  id: string
  source: EditClipboard
  groups: EditTransferGroup[]
  targets: EditPasteTarget[]
}
export type EditApplicationOutcome =
  | 'applied'
  | 'unchanged'
  | 'conflict'
  | 'unavailable'
  | 'failed'
  | 'pending'
  | 'cancelled'
  | 'interrupted'
export interface EditApplicationResult extends EditPasteTarget {
  ordinal: number
  outcome: EditApplicationOutcome
  message?: string
  resultingRevision?: number
}
export interface EditApplicationPage {
  results: EditApplicationResult[]
  total: number
}

export function validateTransferGroups(value: unknown): asserts value is EditTransferGroup[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > editTransferGroups.length ||
    new Set(value).size !== value.length ||
    value.some((id) => !editTransferGroups.some((group) => group.id === id))
  )
    throw new Error('Choose one or more distinct edit groups.')
}
export function copiedEdits(
  clipboard: Omit<EditClipboard, 'groups'>,
  settings: EditSettings,
  metadata: ProcessingMetadata,
): CopiedEdits {
  const whiteBalanceIdentity =
    !metadata.mergeMaster && !metadata.hdrJpeg ? metadata.whiteBalance?.identity : undefined
  const lensKinds = metadata.mergeMaster
    ? []
    : correctionKinds.filter((kind) => !!metadata.lensProfile[kind])
  return structuredClone({
    version: 1,
    clipboard: {
      ...clipboard,
      groups: editTransferGroups
        .filter((group) =>
          group.id === 'white-balance'
            ? !!whiteBalanceIdentity
            : group.id === 'lens'
              ? !!lensKinds.length
              : true,
        )
        .map((group) => group.id),
    },
    settings,
    whiteBalanceIdentity,
    lensKinds,
  })
}
/** Copy complete selected groups; never copy a processing identity or camera calibration. */
export function transferPatch(source: CopiedEdits, groups: EditTransferGroup[]): EditPatch {
  validateTransferGroups(groups)
  if (source.version !== 1 || groups.some((group) => !source.clipboard.groups.includes(group)))
    throw new Error('These edit groups are unavailable in the copied photograph.')
  const s = source.settings,
    patch: EditPatch = {}
  for (const group of groups) {
    switch (group) {
      case 'light':
        for (const key of [
          'exposureEv',
          'contrast',
          'highlights',
          'shadows',
          'whites',
          'blacks',
        ] as const)
          patch[key] = s[key]
        break
      case 'color':
        patch.saturation = s.saturation
        patch.vibrance = s.vibrance
        break
      case 'mixer':
        patch.colorMixer = s.colorMixer
        break
      case 'grading':
        patch.colorGrading = s.colorGrading
        break
      case 'noise':
        patch.noiseReduction = s.noiseReduction
        break
      case 'sharpening':
        patch.detailSharpening = s.detailSharpening
        break
      case 'crop':
        patch.crop = s.crop
        break
      case 'white-balance':
        patch.whiteBalance = s.whiteBalance
        break
      case 'lens':
        patch.lens = Object.fromEntries(source.lensKinds.map((kind) => [kind, s.lens[kind]]))
        break
    }
  }
  validatePatch(patch)
  return structuredClone(patch)
}
export function transferUnavailable(
  source: CopiedEdits,
  groups: EditTransferGroup[],
  metadata: ProcessingMetadata,
): string | undefined {
  if (
    groups.includes('white-balance') &&
    (metadata.mergeMaster ||
      metadata.hdrJpeg ||
      !metadata.whiteBalance ||
      metadata.whiteBalance.identity !== source.whiteBalanceIdentity)
  )
    return 'White balance requires a compatible verified single-RAW camera profile.'
  if (
    groups.includes('lens') &&
    (metadata.mergeMaster || source.lensKinds.some((kind) => !metadata.lensProfile[kind]))
  )
    return 'The copied lens corrections are unavailable for this photograph.'
  return undefined
}
export function transferredSettings(
  before: EditSettings,
  source: CopiedEdits,
  groups: EditTransferGroup[],
): EditSettings {
  return mergeEditPatch(before, transferPatch(source, groups))
}
