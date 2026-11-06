import { SETTINGS_VERSION, validatePatch, type EditPatch, type EditSettings } from './edits'
import { editTransferGroups, type EditTransferGroup } from './edit-transfer-controls'
import { correctionKinds, type CorrectionKind } from './lens'
import { validateToneCurves } from './tone-curves'
import { validateColorMixer } from './color-mixer'
import { validateColorGrading } from './color-grading'
import { validateNoiseReduction, validateDetailSharpening } from './spatial-detail'
import { presetGroupKeys } from './preset-controls'
import { validatePresetAppearance, type PresetAppearance } from './preset-appearance'
export { presetGroupKeys } from './preset-controls'

export const PRESET_STORE_VERSION = 2
export const PRESET_DEFINITION_VERSION = 1
export interface PresetCompatibility {
  whiteBalanceIdentity?: string
  lensKinds: CorrectionKind[]
}
export interface PresetDefinition {
  version: 1
  settingsVersion: typeof SETTINGS_VERSION
  groups: EditTransferGroup[]
  values: EditPatch
  compatibility: PresetCompatibility
}
export interface EditingPreset {
  kind: 'preset'
  id: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
  appearance: PresetAppearance
  definition: PresetDefinition
}
/** Accepted jobs retain historical sources without adding metadata to those snapshots. */
export type PresetSnapshot = Omit<EditingPreset, 'appearance'> & { appearance?: PresetAppearance }
export type PresetSummary = Omit<EditingPreset, 'kind' | 'definition'> & {
  groups: EditTransferGroup[]
}
export interface PresetQuery {
  search?: string
  offset?: number
  expectedStoreRevision?: number
  anchorId?: string
}
export interface PresetPage {
  presets: PresetSummary[]
  total: number
  storeRevision: number
  anchorIndex: number | null
}
export type PresetInput =
  | { mode: 'photo'; photoId: string; groups: EditTransferGroup[] }
  | {
      mode: 'explicit'
      settingsVersion: typeof SETTINGS_VERSION
      groups: EditTransferGroup[]
      values: EditPatch
      referencePhotoId?: string
    }
export interface CreatePresetRequest {
  name: string
  source: PresetInput
  appearance?: Partial<PresetAppearance>
}
export interface UpdatePresetRequest {
  presetId: string
  expectedPresetRevision: number
  name?: string
  source?: PresetInput
  appearance?: Partial<PresetAppearance>
}
export interface PresetRevisionRequest {
  presetId: string
  expectedPresetRevision: number
}
export interface PresetApplicationRequest extends PresetRevisionRequest {
  photoIds: string[]
}
export interface PresetWorkspace {
  selectedId: string | null
  search: string
  anchor: { id: string; index: number; inset: number } | null
}
export const DEFAULT_PRESET_WORKSPACE: PresetWorkspace = {
  selectedId: null,
  search: '',
  anchor: null,
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export function exactPresetFields(v: unknown, required: string[], optional: string[] = []) {
  return (
    object(v) &&
    required.every((key) => Object.hasOwn(v, key)) &&
    Object.keys(v).every((key) => required.includes(key) || optional.includes(key))
  )
}
export function validatePresetId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new Error('Invalid preset ID.')
}
export function validatePresetRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('Invalid preset revision.')
}
export function presetName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a preset name.')
  const name = value.trim()
  if (!name || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new Error('Use a preset name of 1–100 characters without control characters.')
  return name
}
export const presetNameKey = (name: string) => name.normalize('NFKC').toLowerCase()
export function validatePresetGroups(value: unknown): asserts value is EditTransferGroup[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    new Set(value).size !== value.length ||
    value.some((id) => !editTransferGroups.some((group) => group.id === id))
  )
    throw new Error('Choose one or more distinct edit groups.')
}
/** Presets store complete selected groups; partial edit patches are never default-filled. */
export function validatePresetDefinition(value: unknown): asserts value is PresetDefinition {
  if (
    !exactPresetFields(value, ['version', 'settingsVersion', 'groups', 'values', 'compatibility'])
  )
    throw new Error('Invalid preset definition.')
  const d = value as PresetDefinition
  if (d.version !== PRESET_DEFINITION_VERSION || d.settingsVersion !== SETTINGS_VERSION)
    throw new Error('This preset settings format is unsupported.')
  validatePresetGroups(d.groups)
  const keys = d.groups.flatMap((group) => [...presetGroupKeys[group]])
  if (!exactPresetFields(d.values, keys)) {
    const supplied = object(d.values) ? Object.keys(d.values) : []
    const missing = keys.filter((key) => !supplied.includes(key))
    const excluded = supplied.filter((key) => !(keys as string[]).includes(key))
    throw new Error(
      `Supply complete values for every included preset group, and no excluded settings.${missing.length ? ` Missing values: ${missing.join(', ')}.` : ''}${excluded.length ? ` Excluded values: ${excluded.join(', ')}.` : ''}`,
    )
  }
  validatePatch(d.values)
  if (d.groups.includes('curves')) validateToneCurves(d.values.curves)
  if (d.groups.includes('mixer')) validateColorMixer(d.values.colorMixer)
  if (d.groups.includes('grading')) validateColorGrading(d.values.colorGrading)
  if (d.groups.includes('noise')) validateNoiseReduction(d.values.noiseReduction)
  if (d.groups.includes('sharpening')) validateDetailSharpening(d.values.detailSharpening)
  const c = d.compatibility
  if (
    !exactPresetFields(c, ['lensKinds'], ['whiteBalanceIdentity']) ||
    !Array.isArray(c.lensKinds) ||
    new Set(c.lensKinds).size !== c.lensKinds.length ||
    c.lensKinds.some((kind) => !correctionKinds.includes(kind)) ||
    (d.groups.includes('white-balance')
      ? typeof c.whiteBalanceIdentity !== 'string' ||
        !c.whiteBalanceIdentity ||
        c.whiteBalanceIdentity.length > 500
      : c.whiteBalanceIdentity !== undefined) ||
    (d.groups.includes('lens')
      ? !c.lensKinds.length || !exactPresetFields(d.values.lens, c.lensKinds)
      : c.lensKinds.length !== 0)
  )
    throw new Error('Invalid preset camera compatibility.')
}
export function presetValues(
  settings: EditSettings,
  groups: EditTransferGroup[],
  compatibility: PresetCompatibility,
): EditPatch {
  const values = Object.fromEntries(
    groups.flatMap((group) =>
      presetGroupKeys[group].map((key) => [
        key,
        key === 'lens'
          ? Object.fromEntries(compatibility.lensKinds.map((kind) => [kind, settings.lens[kind]]))
          : settings[key],
      ]),
    ),
  )
  return structuredClone(values)
}
export function presetPatch(preset: PresetSnapshot, groups: EditTransferGroup[]): EditPatch {
  validatePresetDefinition(preset.definition)
  validatePresetGroups(groups)
  if (groups.some((group) => !preset.definition.groups.includes(group)))
    throw new Error('These settings are not included in this preset.')
  return structuredClone(
    Object.fromEntries(
      groups.flatMap((group) =>
        presetGroupKeys[group].map((key) => [key, preset.definition.values[key]]),
      ),
    ),
  )
}
export function validateEditingPreset(
  value: unknown,
  allowLegacy?: false,
): asserts value is EditingPreset
export function validateEditingPreset(
  value: unknown,
  allowLegacy: true,
): asserts value is PresetSnapshot
export function validateEditingPreset(value: unknown, allowLegacy = false) {
  if (
    !exactPresetFields(
      value,
      [
        'kind',
        'id',
        'name',
        'revision',
        'createdAt',
        'updatedAt',
        'definition',
        ...(allowLegacy ? [] : ['appearance']),
      ],
      allowLegacy ? ['appearance'] : [],
    )
  )
    throw new Error('Invalid stored preset.')
  const p = value as EditingPreset
  validatePresetId(p.id)
  validatePresetRevision(p.revision)
  if (
    p.kind !== 'preset' ||
    presetName(p.name) !== p.name ||
    ![p.createdAt, p.updatedAt].every(
      (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
    ) ||
    Date.parse(p.updatedAt) < Date.parse(p.createdAt)
  )
    throw new Error('Invalid stored preset.')
  validatePresetDefinition(p.definition)
  if (!allowLegacy || p.appearance !== undefined) validatePresetAppearance(p.appearance)
}
export function validPresetWorkspace(value: unknown): value is PresetWorkspace {
  if (!exactPresetFields(value, ['selectedId', 'search', 'anchor'])) return false
  const p = value as PresetWorkspace
  try {
    if (p.selectedId !== null) validatePresetId(p.selectedId)
    if (p.anchor !== null) {
      if (!exactPresetFields(p.anchor, ['id', 'index', 'inset'])) return false
      validatePresetId(p.anchor.id)
      if (
        !Number.isSafeInteger(p.anchor.index) ||
        p.anchor.index < 0 ||
        !Number.isFinite(p.anchor.inset) ||
        Math.abs(p.anchor.inset) > 1e9
      )
        return false
    }
    return typeof p.search === 'string' && p.search.length <= 500
  } catch {
    return false
  }
}
