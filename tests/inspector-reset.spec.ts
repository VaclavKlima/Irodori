import { test, expect } from '@playwright/test'
import { inspectorReset } from '../src/shared/inspector-reset'
import { initialSettings, mergeEditPatch, type EditState } from '../src/shared/edits'
import type { LensState } from '../src/shared/lens'

test('group resets preserve unrelated edits, unsupported white balance and fixed lens corrections', () => {
  const state: EditState = {
    photoId: 'photo',
    revision: 2,
    canUndo: true,
    canRedo: false,
    settings: {
      ...initialSettings(),
      exposureEv: 1,
      saturation: 20,
      lens: { distortion: false, vignetting: false, chromaticAberration: false },
    },
  }
  const color = mergeEditPatch(state.settings, inspectorReset('color', state))
  expect(color.saturation).toBe(0)
  expect(color.exposureEv).toBe(1)
  expect(color.lens).toEqual(state.settings.lens)
  expect(inspectorReset('color', state)).not.toHaveProperty('whiteBalance')
  const lens: LensState = {
    photoId: 'photo',
    revision: 2,
    settings: state.settings.lens,
    profile: {
      provider: 'test',
      version: '1',
      label: 'Verified distortion only',
      identity: 'test',
      distortion: { radii: [0, 1], values: [1, 1] },
      unavailable: { vignetting: 'Unavailable', chromaticAberration: 'Unavailable' },
    },
  }
  expect(inspectorReset('geometry', state, lens).lens).toEqual({ distortion: true })
  expect(inspectorReset('geometry', state, { ...lens, fixed: true })).not.toHaveProperty('lens')
  expect(
    mergeEditPatch(state.settings, inspectorReset('geometry', state, { ...lens, fixed: true }))
      .lens,
  ).toEqual(state.settings.lens)
})
