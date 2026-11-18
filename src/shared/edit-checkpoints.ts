import { initialSettings, SETTINGS_VERSION, validatePatch, type EditSettings } from './edits'
import { correctionKinds } from './lens'
import { validateMaskStack } from './masks'
import { validateToneCurves } from './tone-curves'
import { validateColorMixer } from './color-mixer'
import { validateColorGrading } from './color-grading'
import { validateNoiseReduction, validateDetailSharpening } from './spatial-detail'

export const EDIT_CHECKPOINT_STORE_VERSION = 1
export interface EditCheckpoint {
  version: 1
  kind: 'checkpoint'
  id: string
  photoId: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
  capturedFromRevision: number
  settings: EditSettings
}
export type EditCheckpointSummary = Omit<EditCheckpoint, 'settings' | 'version' | 'kind'>
export interface EditCheckpointQuery {
  search?: string
  offset?: number
  expectedStoreRevision?: number
  anchorId?: string
}
export interface EditCheckpointPage {
  checkpoints: EditCheckpointSummary[]
  total: number
  storeRevision: number
  anchorIndex: number | null
}
export interface CreateEditCheckpointRequest {
  photoId: string
  name: string
  expectedRevision: number
}
export interface EditCheckpointRevisionRequest {
  photoId: string
  checkpointId: string
  expectedCheckpointRevision: number
}
export interface RenameEditCheckpointRequest extends EditCheckpointRevisionRequest {
  name: string
}
export interface RestoreEditCheckpointRequest extends EditCheckpointRevisionRequest {
  expectedRevision: number
}
export type EditComparisonSource =
  | { kind: 'checkpoint'; checkpointId: string; expectedCheckpointRevision: number }
  | { kind: 'current'; expectedRevision: number }
export interface FrozenEditComparisonSource {
  photoId: string
  source: EditComparisonSource
  settings: EditSettings
  capturedFromRevision: number
  identity: string
  sourceIdentity: string
  label: string
}
export function exactCheckpointFields(
  value: object,
  required: string[],
  optional?: string[],
): boolean
export function exactCheckpointFields(
  value: unknown,
  required: string[],
  optional?: string[],
): value is Record<string, unknown>
export function exactCheckpointFields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
}
export function validateCheckpointPhotoId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Invalid checkpoint photograph ID.')
}
export function validateCheckpointId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    throw new Error('Invalid edit checkpoint ID.')
}
export function validateCheckpointRevision(value: unknown, minimum = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error('Invalid edit checkpoint revision.')
}
export function editCheckpointName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a version name.')
  const name = value.trim()
  if (!name || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new Error('Use a version name of 1–100 characters without control characters.')
  return name
}
export const editCheckpointNameKey = (name: string) => name.normalize('NFKC').toLowerCase()

/** Checkpoints preserve complete authored settings, including immutable mask references. */
export function validateCheckpointSettings(value: unknown): asserts value is EditSettings {
  if (
    !exactCheckpointFields(value, Object.keys(initialSettings())) ||
    value.version !== SETTINGS_VERSION ||
    !['hdr-v1', 'display-referred-v1'].includes(String(value.processing))
  )
    throw new Error('This checkpoint settings format is unsupported.')
  const patch = Object.fromEntries(
    Object.entries(value).filter(([key]) => !['version', 'processing', 'maskStack'].includes(key)),
  )
  validatePatch(patch)
  validateMaskStack(value.maskStack)
  validateToneCurves(value.curves)
  validateColorMixer(value.colorMixer)
  validateColorGrading(value.colorGrading)
  validateNoiseReduction(value.noiseReduction)
  validateDetailSharpening(value.detailSharpening)
  if (!exactCheckpointFields(value.lens, [...correctionKinds]))
    throw new Error('A checkpoint requires complete lens settings.')
}
export function validateEditCheckpoint(
  value: unknown,
  settingsValidator: (settings: unknown) => void = validateCheckpointSettings,
): asserts value is EditCheckpoint {
  if (
    !exactCheckpointFields(value, [
      'version',
      'kind',
      'id',
      'photoId',
      'name',
      'revision',
      'createdAt',
      'updatedAt',
      'capturedFromRevision',
      'settings',
    ]) ||
    value.version !== 1 ||
    value.kind !== 'checkpoint'
  )
    throw new Error('This edit checkpoint format is unsupported.')
  validateCheckpointId(value.id)
  validateCheckpointPhotoId(value.photoId)
  validateCheckpointRevision(value.revision)
  validateCheckpointRevision(value.capturedFromRevision, 0)
  if (
    editCheckpointName(value.name) !== value.name ||
    ![value.createdAt, value.updatedAt].every(
      (time) => typeof time === 'string' && Number.isFinite(Date.parse(time)),
    )
  )
    throw new Error('Invalid stored edit checkpoint metadata.')
  settingsValidator(value.settings)
}
export function validateEditComparisonSource(
  value: unknown,
): asserts value is EditComparisonSource {
  if (exactCheckpointFields(value, ['kind', 'expectedRevision']) && value.kind === 'current') {
    validateCheckpointRevision(value.expectedRevision, 0)
    return
  }
  if (
    exactCheckpointFields(value, ['kind', 'checkpointId', 'expectedCheckpointRevision']) &&
    value.kind === 'checkpoint'
  ) {
    validateCheckpointId(value.checkpointId)
    validateCheckpointRevision(value.expectedCheckpointRevision)
    return
  }
  throw new Error('Choose an explicit saved version or a confirmed Current revision.')
}
