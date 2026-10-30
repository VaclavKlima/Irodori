import { expect, test } from '@playwright/test'
import { neutralAdjustments, snapshotAdjustments } from '../src/shared/adjustments'
import { initialSettings } from '../src/shared/edits'
import { neutralColorMixer } from '../src/shared/color-mixer'
import { neutralColorGrading } from '../src/shared/color-grading'

test('processing snapshots retain the complete color graph while excluding history and geometry', () => {
  const settings = {
    ...initialSettings(),
    exposureEv: 1.25,
    contrast: -30,
    colorMixer: structuredClone(neutralColorMixer),
    colorGrading: structuredClone(neutralColorGrading),
  }
  Object.assign(settings.colorMixer.ranges.blue, { hue: 30, saturation: -10, luminance: 15 })
  Object.assign(settings.colorGrading.tones.shadows, { hue: 230.5, saturation: 17 })
  const captured = snapshotAdjustments(settings)
  expect(captured).toMatchObject({
    exposureEv: 1.25,
    contrast: -30,
    colorMixer: settings.colorMixer,
    colorGrading: settings.colorGrading,
  })
  expect(captured).not.toHaveProperty('version')
  expect(captured).not.toHaveProperty('processing')
  expect(captured).not.toHaveProperty('lens')
  expect(captured).not.toHaveProperty('crop')
  Object.assign(settings.colorMixer.ranges.blue, { hue: 60 })
  Object.assign(settings.colorGrading.tones.shadows, { hue: 120 })
  expect(captured.colorMixer!.ranges.blue.hue).toBe(30)
  expect(captured.colorGrading!.tones.shadows.hue).toBe(230.5)
})

test('zero-valued drafts and complete color-group replacement remain independent of base and caller mutation', () => {
  const base = {
      ...neutralAdjustments,
      exposureEv: 1,
      saturation: 50,
      whiteBalance: { mode: 'custom' as const, kelvin: 6400, tint: 7 },
      colorMixer: structuredClone(neutralColorMixer),
      colorGrading: structuredClone(neutralColorGrading),
    },
    patch = {
      exposureEv: 0,
      saturation: 0,
      colorMixer: structuredClone(neutralColorMixer),
      colorGrading: structuredClone(neutralColorGrading),
    }
  Object.assign(base.colorMixer.ranges.red, { hue: -10 })
  Object.assign(patch.colorGrading.tones.highlights, { hue: 32, saturation: 15 })
  const captured = snapshotAdjustments(base, patch)
  expect(captured.exposureEv).toBe(0)
  expect(captured.saturation).toBe(0)
  expect(captured.colorMixer).toEqual(neutralColorMixer)
  base.whiteBalance.kelvin = 8000
  Object.assign(patch.colorGrading.tones.highlights, { hue: 100 })
  expect(captured.whiteBalance).toEqual({ mode: 'custom', kelvin: 6400, tint: 7 })
  expect(captured.colorGrading!.tones.highlights.hue).toBe(32)
})

test('legacy and neutral snapshots keep the preceding parameter shape and undefined draft fields use the base', () => {
  expect(snapshotAdjustments(neutralAdjustments)).toEqual(neutralAdjustments)
  expect(JSON.stringify(snapshotAdjustments(neutralAdjustments))).toBe(
    JSON.stringify(neutralAdjustments),
  )
  const base = { ...neutralAdjustments, contrast: 12 }
  expect(snapshotAdjustments(base, { contrast: undefined, colorMixer: undefined })).toEqual(base)
  expect(snapshotAdjustments(initialSettings())).toMatchObject({
    colorMixer: neutralColorMixer,
    colorGrading: neutralColorGrading,
  })
})
