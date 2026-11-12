import { expect, test } from '@playwright/test'
import { agentTools } from '../src/main/agent/policy'
import {
  editingGuidanceTopics,
  getEditingGuidance,
  validateEditingGuidanceRequest,
} from '../src/shared/agent-guidance'
import { SETTINGS_VERSION, validatePatch } from '../src/shared/edits'
import { validateExportOptions } from '../src/shared/export'
import { validateInspectionOptions } from '../src/shared/inspection'
import { validateMaskPreviewRequest } from '../src/shared/mask-preview'
import { maskCapabilities, validateMaskMutation } from '../src/shared/masks'
import { PRESET_DEFINITION_VERSION, validatePresetDefinition } from '../src/shared/presets'
import { validateWhiteBalanceSample } from '../src/shared/white-balance-picker'
import { prepareMaskMutation } from '../src/main/mask-store'

test('every editing topic has an isolated typed reference with supported tools and examples', () => {
  expect(new Set(editingGuidanceTopics).size).toBe(editingGuidanceTopics.length)
  for (const topic of editingGuidanceTopics) {
    const reference = getEditingGuidance({ topic })
    expect(reference.version).toBe(1)
    expect(reference.topic).toBe(topic)
    expect(reference.purpose.length).toBeGreaterThan(0)
    expect(reference.workflow.length).toBeGreaterThan(0)
    expect(reference.limitations.length).toBeGreaterThan(0)
    expect(reference.examples.length).toBeGreaterThan(0)
    expect(reference.relatedTools.length).toBeGreaterThan(0)
    for (const tool of reference.relatedTools) expect(agentTools).toContain(tool)
    for (const example of reference.examples) {
      expect(reference.relatedTools).toContain(example.tool)
      expect(example.note).toContain('current requestId')
    }
    reference.workflow.push('Caller-owned mutation')
    reference.examples[0].args.photoId = 'Caller-owned mutation'
    const next = getEditingGuidance({ topic })
    expect(next.workflow).not.toContain('Caller-owned mutation')
    expect(next.examples[0].args.photoId).not.toBe('Caller-owned mutation')
  }
})

test('editing guidance rejects absent, unknown and extra fields without accessing photo state', () => {
  for (const value of [undefined, null, [], 'tone', {}, { topic: 'tone', photoId: 'a' }])
    expect(() => validateEditingGuidanceRequest(value)).toThrow('exactly one field: topic')
  for (const topic of ['', 'Tone', 'shell', 'mask', 1, null, {}, ['tone']])
    expect(() => getEditingGuidance({ topic })).toThrow('topic must be one of')
  expect(validateEditingGuidanceRequest({ topic: 'mask-brush' })).toEqual({ topic: 'mask-brush' })
})

test('operator examples satisfy the same underlying mutation, sampling and proof contracts', () => {
  let checked = 0
  for (const topic of editingGuidanceTopics) {
    for (const { tool, args } of getEditingGuidance({ topic }).examples) {
      if (tool === 'irodori_update_edits') {
        validatePatch(args.patch)
        checked++
      } else if (tool === 'irodori_mutate_masks') {
        validateMaskMutation(args.maskMutation)
        checked++
      } else if (tool === 'irodori_propose_white_balance') {
        validateWhiteBalanceSample(args.sample)
        checked++
      } else if (tool === 'irodori_get_mask_preview') {
        validateMaskPreviewRequest(args)
        checked++
      } else if (tool === 'irodori_get_photo_preview') {
        validateInspectionOptions(args.inspection)
        checked++
      } else if (tool === 'irodori_get_output_proof') {
        expect(validateExportOptions(args.options).output).toBe('sdr')
        checked++
      } else if (tool === 'irodori_create_preset') {
        const request = args.presetRequest as {
          source: { settingsVersion: number; groups: string[]; values: unknown }
        }
        expect(request.source.settingsVersion).toBe(SETTINGS_VERSION)
        validatePresetDefinition({
          version: PRESET_DEFINITION_VERSION,
          settingsVersion: request.source.settingsVersion,
          groups: request.source.groups,
          values: request.source.values,
          compatibility: { lensKinds: [] },
        })
        checked++
      }
    }
  }
  expect(checked).toBeGreaterThanOrEqual(9)
})

test('specialist guidance preserves source/color, proofing and preset authorization semantics', () => {
  const color = getEditingGuidance({ topic: 'color' }).workflow.join('\n')
  expect(color).toContain('color:{temperature,tint,saturation}')
  expect(color).toContain(`${maskCapabilities.color.min} to ${maskCapabilities.color.max}`)
  expect(color).toContain('Positive temperature warms; positive tint adds magenta')
  expect(color).toContain('not Kelvin or camera white balance')
  expect(color).toContain('Global white balance is unchanged')
  const range = getEditingGuidance({ topic: 'mask-range' }).workflow.join('\n')
  expect(range).toContain('neutral canonical source before creative edits')
  expect(range).toContain('brightness-normalized Oklab a/L,b/L')
  expect(range).toContain('CURRENT CROPPED OUTPUT')
  expect(range).toContain('upper:null')
  expect(range).toContain('replacePrimary:true')
  const proof = getEditingGuidance({ topic: 'export' }).workflow.join('\n')
  expect(proof).toContain('use Standard as the starting point')
  expect(proof).toContain('absent sharpening remains Off')
  expect(proof).toContain('Do not change saved detailSharpening for an export-only request')
  expect(proof).toContain('no destination and change no photo history or Last custom preferences')
  const presets = getEditingGuidance({ topic: 'presets' }).workflow.join('\n')
  expect(presets).toContain('Deleting a preset needs an explicit user instruction')
  expect(presets).toContain('Otherwise name it, ask and wait')
  expect(presets).toContain(`settingsVersion:${SETTINGS_VERSION}`)
})

test('mask guidance demonstrates an executable create/update batch and rejects the observed guessed creation shapes', () => {
  for (const topic of ['mask-brush', 'mask-range', 'mask-compound'] as const) {
    const workflow = getEditingGuidance({ topic }).workflow.join('\n')
    expect(workflow).toContain('kind:"create"')
    expect(workflow).toContain('kind:"update"')
    expect(workflow).toContain('both can share one operations batch and Undo step')
    expect(workflow).toContain('id, not maskId')
    expect(workflow).toContain('op/type discriminators and a nested mask object are invalid')
  }
  const reference = getEditingGuidance({ topic: 'mask-compound' })
  const sample = reference.examples.find(({ args }) => {
    const mutation = args.maskMutation as { operations?: { kind: string }[] } | undefined
    return mutation?.operations?.[0]?.kind === 'create'
  })!
  expect(sample.note).toContain('not a photo recipe')
  const mutation = sample.args.maskMutation
  validateMaskMutation(mutation)
  const [created, updated] = mutation.operations
  expect(created.kind).toBe('create')
  expect(updated.kind).toBe('update')
  if (created.kind !== 'create' || updated.kind !== 'update')
    throw new Error('Invalid mask example.')
  expect(updated.id).toBe(created.id)
  const applied = prepareMaskMutation([], mutation)
  expect(applied.stack).toHaveLength(1)
  expect(applied.stack[0].gradient).toEqual(created.gradient)
  expect(applied.stack[0].light).toMatchObject(updated.light!)
  const withoutKind = Object.fromEntries(Object.entries(created).filter(([key]) => key !== 'kind'))
  const withoutId = Object.fromEntries(Object.entries(created).filter(([key]) => key !== 'id'))
  for (const operation of [
    { ...withoutKind, op: 'create' },
    { ...withoutKind, type: 'create' },
    { ...created, inverted: true },
    { ...created, light: updated.light },
    { ...created, color: { saturation: 0 } },
    { ...withoutId, maskId: created.id },
    { kind: 'create', mask: created },
  ])
    expect(() => validateMaskMutation({ operations: [operation] })).toThrow()
  const object = getEditingGuidance({ topic: 'mask-object' })
  expect(object.relatedTools).toContain('irodori_mutate_masks')
  expect(object.workflow.join('\n')).toContain('After acceptance')
  expect(object.workflow.join('\n')).toContain('kind:"update"')
})
