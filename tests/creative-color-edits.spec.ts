import { expect, test } from '@playwright/test'
import {
  initialSettings,
  mergeEditPatch,
  validatePatch,
  validateProcessingPatch,
  type EditPatch,
} from '../src/shared/edits'
import { neutralColorMixer } from '../src/shared/color-mixer'
import { neutralColorGrading } from '../src/shared/color-grading'
import { supportsEditingSettings } from '../src/main/catalog/editing-migration'

test('partial creative edits retain other controls, create complete owned groups and reset atomically', () => {
  const base = initialSettings(),
    patch: EditPatch = {
      exposureEv: 0.75,
      colorMixer: { ranges: { red: { saturation: -30 }, aqua: { hue: 20, luminance: 15 } } },
      colorGrading: {
        tones: { shadows: { hue: 234.5, saturation: 25 }, highlights: { luminance: -20 } },
        balance: 12,
      },
    },
    next = mergeEditPatch(base, patch)
  expect(next.colorMixer.ranges.red).toEqual({ hue: 0, saturation: -30, luminance: 0 })
  expect(next.colorMixer.ranges.aqua).toEqual({ hue: 20, saturation: 0, luminance: 15 })
  expect(next.colorMixer.ranges.blue).toEqual({ hue: 0, saturation: 0, luminance: 0 })
  expect(next.colorGrading).toMatchObject({
    tones: {
      shadows: { hue: 234.5, saturation: 25, luminance: 0 },
      midtones: { hue: 0, saturation: 0, luminance: 0 },
      highlights: { hue: 0, saturation: 0, luminance: -20 },
    },
    blending: 50,
    balance: 12,
  })
  const changed = mergeEditPatch(next, {
    colorGrading: { tones: { shadows: { hue: 120 } } },
    colorMixer: { ranges: { red: { hue: -10 } } },
  })
  expect(changed.colorGrading.tones.shadows).toEqual({ hue: 120, saturation: 25, luminance: 0 })
  expect(changed.colorGrading.tones.highlights.luminance).toBe(-20)
  expect(changed.colorMixer.ranges.red).toEqual({ hue: -10, saturation: -30, luminance: 0 })
  expect(changed.colorMixer.ranges.aqua).toEqual(next.colorMixer.ranges.aqua)
  Object.assign(patch.colorGrading!.tones!.shadows!, { hue: 99 })
  Object.assign(next.colorMixer.ranges.aqua, { hue: 90 })
  expect(changed.colorMixer.ranges.aqua.hue).toBe(20)
  expect(next.colorGrading.tones.shadows.hue).toBe(234.5)
  expect(base.colorMixer).toEqual(neutralColorMixer)
  const reset = mergeEditPatch(changed, {
    colorMixer: neutralColorMixer,
    colorGrading: neutralColorGrading,
  })
  expect(reset).toMatchObject({
    exposureEv: 0.75,
    colorMixer: neutralColorMixer,
    colorGrading: neutralColorGrading,
  })
})

test('sparse no-ops and reordered complete groups produce the same persisted document', () => {
  const base = mergeEditPatch(initialSettings(), {
    colorMixer: { ranges: { blue: { hue: -30 } } },
    colorGrading: { tones: { midtones: { hue: 32.5 } }, blending: 65 },
  })
  const reordered = {
    version: 1 as const,
    ranges: Object.fromEntries(Object.entries(base.colorMixer.ranges).reverse()),
  }
  for (const patch of [
    {},
    { colorMixer: {} },
    { colorMixer: { ranges: { red: {} } } },
    { colorGrading: { tones: { midtones: { hue: 32.5 } } } },
    { colorMixer: reordered },
  ] as EditPatch[])
    expect(JSON.stringify(mergeEditPatch(base, patch))).toBe(JSON.stringify(base))
})

test('public patches reject unsupported versions, unknown fields and malformed nested groups', () => {
  const invalid = [
    { colorMixer: undefined },
    { colorMixer: null },
    { colorMixer: [] },
    { colorMixer: { version: 2 } },
    { colorMixer: { ranges: null } },
    { colorMixer: { ranges: { cyan: { hue: 20 } } } },
    { colorMixer: { ranges: { red: null } } },
    { colorMixer: { ranges: { red: { hue: undefined } } } },
    { colorMixer: { ranges: { red: { hue: 101 } } } },
    { colorMixer: { ranges: { red: { saturation: -101 } } } },
    { colorMixer: { ranges: { red: { luminance: 0.1 } } } },
    { colorMixer: { ranges: { red: { hidden: true } } } },
    { colorMixer: { unknown: 1 } },
    { colorGrading: undefined },
    { colorGrading: null },
    { colorGrading: { version: 2 } },
    { colorGrading: { tones: [] } },
    { colorGrading: { tones: { global: { hue: 5 } } } },
    { colorGrading: { tones: { midtones: null } } },
    { colorGrading: { tones: { midtones: { hue: 360 } } } },
    { colorGrading: { tones: { midtones: { hue: -0.1 } } } },
    { colorGrading: { tones: { midtones: { hue: 1.01 } } } },
    { colorGrading: { tones: { midtones: { saturation: -1 } } } },
    { colorGrading: { tones: { midtones: { luminance: NaN } } } },
    { colorGrading: { tones: { midtones: { unknown: 1 } } } },
    { colorGrading: { blending: 101 } },
    { colorGrading: { balance: Infinity } },
    { colorGrading: { blending: undefined } },
    { colorGrading: { unknown: 1 } },
  ]
  for (const patch of invalid) expect(() => validatePatch(patch), JSON.stringify(patch)).toThrow()
  for (const patch of [
    { colorMixer: { ranges: { red: { hue: -100, saturation: 100, luminance: 0 } } } },
    {
      colorGrading: {
        tones: { midtones: { hue: 359.9, saturation: 100, luminance: -100 } },
        blending: 0,
        balance: 100,
      },
    },
  ])
    expect(() => validatePatch(patch)).not.toThrow()
})

test('processing and persisted current settings require full groups, and older versions reject authored group data', () => {
  const base = initialSettings()
  expect(() =>
    validateProcessingPatch({ colorMixer: base.colorMixer, colorGrading: base.colorGrading }),
  ).not.toThrow()
  expect(() => validateProcessingPatch({ colorMixer: { ranges: { red: { hue: 0 } } } })).toThrow()
  expect(() =>
    validateProcessingPatch({ colorGrading: { tones: { shadows: { hue: 120 } } } }),
  ).toThrow()
  expect(supportsEditingSettings(base as unknown as Record<string, unknown>, 21)).toBe(true)
  for (const settings of [
    { ...base, colorMixer: {} },
    { ...base, colorGrading: {} },
    { ...base, colorMixer: undefined },
    { ...base, colorGrading: undefined },
  ])
    expect(supportsEditingSettings(settings as Record<string, unknown>, 21)).toBe(false)
  for (const version of [7, 8, 9]) expect(supportsEditingSettings({ ...base, version })).toBe(false)
})
