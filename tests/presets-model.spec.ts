import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_PRESET_APPEARANCE,
  mergePresetAppearance,
  presetColors,
  presetIcons,
  validatePresetAppearance,
} from '../src/shared/preset-appearance'
import { initialSettings, mergeEditPatch } from '../src/shared/edits'
import {
  defaultEditTransferGroups,
  transferredSettings,
  transferUnavailable,
} from '../src/shared/edit-transfer'
import {
  presetName,
  presetValues,
  validatePresetDefinition,
  validateEditingPreset,
  type EditingPreset,
  type PresetDefinition,
} from '../src/shared/presets'
import { processingMetadata } from '../src/main/processing/metadata'
import { profile } from './white-balance-picker.helpers'

function definition(): PresetDefinition {
  const compatibility = { lensKinds: [] }
  return {
    version: 1,
    settingsVersion: 12,
    groups: [...defaultEditTransferGroups],
    values: presetValues(
      mergeEditPatch(initialSettings(), {
        exposureEv: 1.25,
        saturation: 20,
        colorMixer: { ranges: { red: { hue: 5 } } },
      }),
      defaultEditTransferGroups,
      compatibility,
    ),
    compatibility,
  }
}
function preset(d = definition()): EditingPreset {
  return {
    kind: 'preset',
    id: randomUUID(),
    name: 'Woodland',
    revision: 1,
    createdAt: '2026-11-06T00:00:00Z',
    updatedAt: '2026-11-06T00:00:00Z',
    appearance: { ...DEFAULT_PRESET_APPEARANCE },
    definition: d,
  }
}

test('preset groups replace complete values and preserve excluded settings and processing identity', () => {
  const p = preset(),
    destination = mergeEditPatch(initialSettings(), {
      exposureEv: -2,
      vibrance: -30,
      crop: { ...initialSettings().crop, quarterTurns: 1 },
      colorMixer: { ranges: { blue: { hue: 25 } } },
    })
  destination.processing = 'hdr-v1'
  validateEditingPreset(p)
  const result = transferredSettings(destination, p, p.definition.groups)
  expect(result).toMatchObject({
    exposureEv: 1.25,
    saturation: 20,
    vibrance: 0,
    processing: 'hdr-v1',
    crop: destination.crop,
    lens: destination.lens,
    whiteBalance: destination.whiteBalance,
  })
  expect(result.colorMixer.ranges.blue.hue).toBe(0)
  expect(result.curves).toEqual(initialSettings().curves)
  p.definition.values.exposureEv = 3
  expect(result.exposureEv).toBe(1.25)
})

test('preset markers use stable named choices and partial updates retain omitted fields', () => {
  expect(presetIcons).toHaveLength(25)
  expect(new Set(presetIcons.map((icon) => icon.id)).size).toBe(25)
  expect(new Set(presetColors.map((color) => color.id)).size).toBe(9)
  expect(mergePresetAppearance(DEFAULT_PRESET_APPEARANCE, { icon: 'sunset' })).toEqual({
    icon: 'sunset',
    color: 'neutral',
  })
  expect(mergePresetAppearance({ icon: 'sunset', color: 'amber' }, { color: 'violet' })).toEqual({
    icon: 'sunset',
    color: 'violet',
  })
  for (const value of [
    null,
    [],
    {},
    { icon: 'upload.svg' },
    { color: '#ff0000' },
    { icon: 'sunset', path: '/private' },
  ])
    expect(() => validatePresetAppearance(value, true)).toThrow('supported preset icon and color')
  expect(() => validatePresetAppearance({ icon: 'sunset' })).toThrow()
  expect(() => validatePresetAppearance({ icon: 'sunset', color: 'amber' })).not.toThrow()
  const legacy = { ...preset() } as Partial<EditingPreset>
  delete legacy.appearance
  expect(() => validateEditingPreset(legacy)).toThrow()
  expect(() => validateEditingPreset(legacy, true)).not.toThrow()
  legacy.appearance = { icon: 'future' as 'general', color: 'neutral' }
  expect(() => validateEditingPreset(legacy, true)).toThrow()
})

test('every named icon color stays legible on neutral row, hover and selection surfaces', () => {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/../g)!
      .map((channel) => {
        const v = parseInt(channel, 16) / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  for (const color of presetColors)
    for (const background of ['#202020', '#303030', '#3c3c3c'])
      expect(
        (luminance(color.hex) + 0.05) / (luminance(background) + 0.05),
        `${color.id} on ${background}`,
      ).toBeGreaterThanOrEqual(3)
  const sprite = readFileSync('assets/app/icons/presets/scenarios.svg')
  const manifest = JSON.parse(readFileSync('assets/app/icons/presets/manifest.json', 'utf8'))
  expect(createHash('sha256').update(sprite).digest('hex')).toBe(manifest.sha256)
  for (const id of ['high-noise', 'soft-look']) expect(sprite.toString()).toContain(`id="${id}"`)
  expect(sprite.toString()).not.toMatch(/<script|<image|(?:href|src)=["'](?:https?:|file:)/)
})

for (const [group, field] of [
  ['light', 'blacks'],
  ['color', 'vibrance'],
  ['curves', 'blue'],
  ['mixer', 'blue'],
  ['grading', 'balance'],
  ['noise', 'chroma'],
  ['sharpening', 'radius'],
] as const) {
  test(`explicit ${group} rejects incomplete values instead of default filling`, () => {
    const d = definition(),
      v = d.values
    if (group === 'light' || group === 'color') delete v[field]
    else if (group === 'curves') delete (v.curves as Record<string, unknown>)[field]
    else if (group === 'mixer') delete (v.colorMixer!.ranges as Record<string, unknown>)[field]
    else if (group === 'grading') delete (v.colorGrading as Record<string, unknown>)[field]
    else if (group === 'noise') delete (v.noiseReduction as Record<string, unknown>)[field]
    else delete (v.detailSharpening as Record<string, unknown>)[field]
    expect(() => validatePresetDefinition(d)).toThrow()
  })
}

test('preset validation refuses unknown/excluded settings, versions, groups, paths and calibration facts', () => {
  for (const alter of [
    (d: PresetDefinition) => {
      d.values.crop = initialSettings().crop
    },
    (d: PresetDefinition) => {
      Object.assign(d, { settingsVersion: 13 })
    },
    (d: PresetDefinition) => {
      Object.assign(d, { version: 2 })
    },
    (d: PresetDefinition) => {
      d.groups.push('light')
    },
    (d: PresetDefinition) => {
      Object.assign(d.compatibility, { path: '/private/source.arw' })
    },
    (d: PresetDefinition) => {
      Object.assign(d.compatibility, { asShotGains: [1, 1, 1] })
    },
  ]) {
    const d = definition()
    alter(d)
    expect(() => validatePresetDefinition(d)).toThrow()
  }
  for (const name of ['', '  ', 'a\nb', 'x'.repeat(101)]) expect(() => presetName(name)).toThrow()
  expect(presetName('  Woodland  ')).toBe('Woodland')
})

test('camera compatibility stores identity and supported choices, independently of source metadata', () => {
  const p = preset({
    version: 1,
    settingsVersion: 12,
    groups: ['white-balance', 'lens'],
    values: {
      whiteBalance: { mode: 'custom', kelvin: 6000, tint: 12 },
      lens: { distortion: false },
    },
    compatibility: { whiteBalanceIdentity: profile.identity, lensKinds: ['distortion'] },
  })
  validateEditingPreset(p)
  const metadata = processingMetadata({}, [])
  metadata.whiteBalance = profile
  metadata.lensProfile.distortion = { radii: [0, 1], values: [1, 1.1] }
  expect(transferUnavailable(p, p.definition.groups, metadata)).toBeUndefined()
  expect(transferUnavailable(p, p.definition.groups, processingMetadata({}, []))).toContain(
    'verified',
  )
  expect(
    transferUnavailable(p, ['white-balance'], {
      ...metadata,
      whiteBalance: { ...profile, identity: 'other' },
    }),
  ).toContain('verified')
  p.definition.values.lens = {}
  expect(() => validateEditingPreset(p)).toThrow()
})
