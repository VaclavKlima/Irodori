import { randomUUID } from 'node:crypto'
import type { CatalogCommands } from './catalog/contracts'
import { transferCompatibility } from '../shared/edit-transfer'
import { SETTINGS_VERSION, type EditSettings } from '../shared/edits'
import type { ProcessingMetadata } from '../shared/lens'
import {
  exactPresetFields,
  presetName,
  presetValues,
  validatePresetDefinition,
  validatePresetGroups,
  validatePresetRevision,
  type PresetCompatibility,
  type PresetDefinition,
  type PresetInput,
  type CreatePresetRequest,
  type UpdatePresetRequest,
  type PresetRevisionRequest,
} from '../shared/presets'
import { validateExportPhotoIds } from '../shared/export'
import { PresetReadStore } from './preset-store'
import { DEFAULT_PRESET_APPEARANCE, mergePresetAppearance } from '../shared/preset-appearance'

export class Presets {
  constructor(
    readonly store: PresetReadStore,
    private writer: CatalogCommands,
    private capture: (
      id: string,
    ) => Promise<{ settings: EditSettings; metadata: ProcessingMetadata }>,
    private changed: () => void,
  ) {}
  private async definition(input: PresetInput): Promise<PresetDefinition> {
    if (
      !input ||
      !(input.mode === 'photo'
        ? exactPresetFields(input, ['mode', 'photoId', 'groups'])
        : input.mode === 'explicit' &&
          exactPresetFields(
            input,
            ['mode', 'settingsVersion', 'groups', 'values'],
            ['referencePhotoId'],
          ))
    )
      throw new Error(
        'Invalid preset source. Use source.mode "photo" with photoId and groups, or source.mode "explicit" with settingsVersion: 17, groups and values. Explicit camera-dependent groups also require referencePhotoId.',
      )
    if (
      input.mode === 'explicit' &&
      ![12, 13, 14, 15, 16, SETTINGS_VERSION].includes(input.settingsVersion)
    )
      throw new Error('This preset settings format is unsupported.')
    validatePresetGroups(input.groups)
    let compatibility: PresetCompatibility = { lensKinds: [] }
    const camera = input.groups.some((g) => g === 'white-balance' || g === 'lens'),
      photoId = input.mode === 'photo' ? input.photoId : input.referencePhotoId
    if (camera && !photoId)
      throw new Error('Camera-dependent presets require a verified reference photo.')
    let captured: Awaited<ReturnType<Presets['capture']>> | undefined
    if (photoId !== undefined) {
      validateExportPhotoIds([photoId])
      captured = await this.capture(photoId)
      const source = transferCompatibility(captured.metadata)
      if (input.groups.some((group) => !source.groups.includes(group)))
        throw new Error('These edit groups are unavailable in the reference photograph.')
      compatibility = {
        lensKinds: input.groups.includes('lens') ? source.lensKinds : [],
        ...(input.groups.includes('white-balance')
          ? { whiteBalanceIdentity: source.whiteBalanceIdentity }
          : {}),
      }
    }
    const definition: PresetDefinition = {
      version: 1,
      settingsVersion: SETTINGS_VERSION,
      groups: [...input.groups],
      values:
        input.mode === 'photo'
          ? presetValues(captured!.settings, input.groups, compatibility)
          : structuredClone(input.values),
      compatibility,
    }
    validatePresetDefinition(definition)
    return definition
  }
  async create(request: CreatePresetRequest) {
    request = structuredClone(request)
    if (!exactPresetFields(request, ['name', 'source'], ['appearance']))
      throw new Error('Invalid new preset request.')
    const name = presetName(request.name),
      appearance = mergePresetAppearance(DEFAULT_PRESET_APPEARANCE, request.appearance),
      definition = await this.definition(request.source),
      now = new Date().toISOString()
    const preset = await this.writer.command({
      operation: 'preset.create',
      payload: {
        preset: {
          kind: 'preset',
          id: randomUUID(),
          name,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          appearance,
          definition,
        },
      },
    })
    this.changed()
    return preset
  }
  async update(request: UpdatePresetRequest) {
    request = structuredClone(request)
    if (
      !exactPresetFields(
        request,
        ['presetId', 'expectedPresetRevision'],
        ['name', 'source', 'appearance'],
      ) ||
      (request.name === undefined &&
        request.source === undefined &&
        request.appearance === undefined)
    )
      throw new Error('Choose a new name, icon, color or replacement preset settings.')
    validatePresetRevision(request.expectedPresetRevision)
    const before = this.store.get(request.presetId)
    if (before.revision !== request.expectedPresetRevision)
      throw new Error('Preset revision conflict. Refresh the preset before trying again.')
    const preset = {
      ...before,
      name: request.name === undefined ? before.name : presetName(request.name),
      appearance: mergePresetAppearance(before.appearance, request.appearance),
      definition:
        request.source === undefined ? before.definition : await this.definition(request.source),
      revision: before.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    const result = await this.writer.command({
      operation: 'preset.update',
      payload: { preset, expectedPresetRevision: request.expectedPresetRevision },
    })
    this.changed()
    return result
  }
  async delete(request: PresetRevisionRequest) {
    request = structuredClone(request)
    if (!exactPresetFields(request, ['presetId', 'expectedPresetRevision']))
      throw new Error('Invalid preset deletion.')
    await this.writer.command({ operation: 'preset.delete', payload: request })
    this.changed()
  }
}
