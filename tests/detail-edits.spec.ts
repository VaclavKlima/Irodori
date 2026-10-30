import { expect, test } from '@playwright/test'
import {
  initialSettings,
  mergeEditPatch,
  validatePatch,
  validateProcessingPatch,
} from '../src/shared/edits'
import { supportsEditingSettings } from '../src/main/catalog/editing-migration'
import {
  spatialControlsActive,
  spatialControlsKey,
  detailCapabilities,
} from '../src/shared/detail-controls'
import { neutralNoiseReduction, neutralDetailSharpening } from '../src/shared/spatial-detail'

test('spatial edit groups merge sparsely, own their values and retain authored inactive settings', () => {
  const base = initialSettings(),
    patch = { noiseReduction: { luminance: 35 }, detailSharpening: { radius: 1.7 } },
    next = mergeEditPatch(base, patch),
    updated = mergeEditPatch(next, {
      noiseReduction: { chroma: 40 },
      detailSharpening: { amount: 25 },
    })
  expect(base.noiseReduction).toEqual(neutralNoiseReduction)
  expect(base.detailSharpening).toEqual(neutralDetailSharpening)
  expect(next.noiseReduction).toEqual({ version: 1, luminance: 35, chroma: 0 })
  expect(updated.noiseReduction).toEqual({ version: 1, luminance: 35, chroma: 40 })
  expect(updated.detailSharpening).toEqual({ version: 1, amount: 25, radius: 1.7, threshold: 50 })
  patch.noiseReduction.luminance = 90
  expect(next.noiseReduction.luminance).toBe(35)
  expect(spatialControlsActive(base)).toBe(false)
  const configured = mergeEditPatch(base, { detailSharpening: { radius: 2.5, threshold: 80 } })
  expect(spatialControlsActive(configured)).toBe(false)
  expect(spatialControlsKey(configured)).not.toBe(spatialControlsKey(base))
  for (const value of [
    {},
    { noiseReduction: {} },
    { detailSharpening: {} },
    { noiseReduction: { chroma: 40, luminance: 35, version: 1 as const } },
  ])
    expect(JSON.stringify(mergeEditPatch(updated, value))).toBe(JSON.stringify(updated))
})

test('spatial patches reject malformed values and cannot enter a downstream point-only request', () => {
  for (const group of ['noiseReduction', 'detailSharpening']) {
    for (const value of [null, undefined, [], { version: 2 }, { unexpected: 1 }])
      expect(() => validatePatch({ [group]: value })).toThrow()
  }
  for (const patch of [
    { noiseReduction: { luminance: -1 } },
    { noiseReduction: { chroma: 101 } },
    { noiseReduction: { luminance: 1.5 } },
    { noiseReduction: { chroma: undefined } },
    { detailSharpening: { amount: NaN } },
    { detailSharpening: { radius: 0.4 } },
    { detailSharpening: { radius: 3.1 } },
    { detailSharpening: { radius: 1.01 } },
    { detailSharpening: { threshold: Infinity } },
  ])
    expect(() => validatePatch(patch)).toThrow()
  for (const patch of [
    { noiseReduction: { luminance: 100, chroma: 100 } },
    { detailSharpening: { amount: 100, radius: 3, threshold: 0 } },
  ]) {
    expect(() => validatePatch(patch)).not.toThrow()
    expect(() => validateProcessingPatch(patch)).toThrow('Unknown adjustment')
  }
  expect(detailCapabilities.detailSharpening.parameters.radius).toMatchObject({
    min: 0.5,
    max: 3,
    unit: 'source-pixels',
  })
})

test('current settings require complete spatial groups while catalog 20 permits only the original v10 schema', () => {
  const current = initialSettings()
  expect(supportsEditingSettings(current as unknown as Record<string, unknown>, 21)).toBe(true)
  for (const change of [
    { noiseReduction: {} },
    { detailSharpening: undefined },
    { detailSharpening: { ...neutralDetailSharpening, radius: 3.5 } },
  ])
    expect(supportsEditingSettings({ ...current, ...change })).toBe(false)
  const legacy: Record<string, unknown> = { ...current, version: 10 }
  expect(supportsEditingSettings(legacy, 20)).toBe(false)
  delete legacy.noiseReduction
  delete legacy.detailSharpening
  expect(supportsEditingSettings(legacy, 20)).toBe(true)
  expect(supportsEditingSettings(legacy, 21)).toBe(false)
})
