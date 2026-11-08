import { test, expect } from '@playwright/test'
import { inspectionContext, neutralInspectionSource } from '../src/main/agent/inspection-source'
import {
  resolveInspection,
  resolveInspectionRegion,
  validateInspectionOptions,
  inspectionHdrCapability,
  type PreviewContext,
} from '../src/shared/inspection'
import { identityCrop } from '../src/shared/crop'
import { neutralAdjustments } from '../src/shared/adjustments'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import type { ExportSource } from '../src/main/export/types'

const context: PreviewContext = {
  photoId: 'a'.repeat(64),
  revision: 4,
  width: 403,
  height: 301,
  gridIdentity: 'grid',
  coordinateSpace: 'oriented-lens-corrected-cropped-photo',
  sourceDynamicRange: 'hdr',
  formats: ['jpeg', 'png'],
  hdr: inspectionHdrCapability,
  limits: { imageBytes: 8 * 1024 ** 2, pairBytes: 16 * 1024 ** 2 },
}

test('normalized regions resolve outward and preserve photo coordinates when mapped to enlarged export grids', () => {
  const region = {
    units: 'normalized' as const,
    gridIdentity: 'grid',
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
  }
  expect(resolveInspectionRegion(region, context)).toEqual({
    x: 40,
    y: 60,
    width: 122,
    height: 121,
  })
  const resolved = resolveInspection(
    { region, resolutionPercent: 100, encoding: { format: 'png' }, comparison: 'pair' },
    context,
    { width: 806, height: 602 },
  )
  expect(resolved).toMatchObject({
    bounds: { x: 80, y: 120, width: 244, height: 242 },
    width: 244,
    height: 242,
    encoding: { format: 'png', lossless: true },
    labels: ['before', 'after'],
  })
  expect(() => resolveInspectionRegion({ ...region, gridIdentity: 'stale' }, context)).toThrow(
    'grid changed',
  )
  expect(() => resolveInspectionRegion({ ...region, x: 0.9 }, context)).toThrow('outside')
})

test('native percentage, omitted 1024 fit and transfer quality are independent and strict HDR refuses', () => {
  const large = { ...context, width: 2400, height: 1600 }
  expect(resolveInspection({}, large)).toMatchObject({
    width: 1024,
    height: 683,
    encoding: { format: 'jpeg', quality: 80 },
  })
  expect(
    resolveInspection({ resolutionPercent: 100, encoding: { format: 'jpeg', quality: 17 } }, large),
  ).toMatchObject({ width: 2400, height: 1600, encoding: { quality: 17, lossless: false } })
  expect(
    resolveInspection({ resolutionPercent: 50, encoding: { format: 'jpeg', quality: 100 } }, large),
  ).toMatchObject({ width: 1200, height: 800, encoding: { quality: 100, lossless: false } })
  for (const value of [0, -1, 101, NaN, Infinity])
    expect(() => validateInspectionOptions({ resolutionPercent: value })).toThrow()
  expect(() => validateInspectionOptions({ encoding: { format: 'png', quality: 100 } })).toThrow()
  expect(() => resolveInspection({ hdr: true }, large)).toThrow('no client/version/model/transport')
})

test('normalized arithmetic does not add spurious edge pixels and invalid enum arrays are refused', () => {
  const grid = { ...context, width: 100, height: 100 },
    region = {
      units: 'normalized' as const,
      gridIdentity: 'grid',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    }
  expect(resolveInspectionRegion(region, grid)).toEqual({ x: 10, y: 10, width: 20, height: 20 })
  expect(
    resolveInspection({ region, resolutionPercent: 100 }, grid, { width: 300, height: 300 }),
  ).toMatchObject({
    photoBounds: { x: 10, y: 10, width: 20, height: 20 },
    bounds: { x: 30, y: 30, width: 60, height: 60 },
  })
  expect(
    resolveInspectionRegion({ ...region, x: 0.9999999999999999, width: Number.EPSILON / 2 }, grid),
  ).toMatchObject({ x: 99, width: 1 })
  expect(() => resolveInspectionRegion({ ...region, x: 1, width: Number.MIN_VALUE }, grid)).toThrow(
    'outside',
  )
  expect(() => validateInspectionOptions({ comparison: ['before'] })).toThrow('comparison')
  expect(() => validateInspectionOptions({ region: { ...region, units: ['pixels'] } })).toThrow(
    'in-bounds',
  )
})

test('equal-size rotations invalidate grids while tonal changes preserve them; Before preserves geometry and removes spatial/local edits', () => {
  const source = {
    photo: { id: context.photoId },
    identity: { size: 32 },
    hdr: false,
    processing: {
      revision: 4,
      metadata: { orientation: 1, lensProfile: { identity: 'lens' } },
      settings: { distortion: true },
      crop: identityCrop,
      adjustments: { ...neutralAdjustments, exposureEv: 2, localMasks: { version: 1, masks: [] } },
      noiseReduction: { version: 1, luminance: 40, chroma: 20 },
      detailSharpening: { version: 1, amount: 20, radius: 1, threshold: 50 },
    },
  } as unknown as ExportSource
  const first = inspectionContext(source, { width: context.width, height: context.height })
  expect(first.geometry?.crop).toBeUndefined()
  const hdrGeometry = { ...identityMaskGeometry(context.width, context.height), flip: 2 }
  expect(
    inspectionContext(source, {
      width: context.width,
      height: context.height,
      hdr: { maskGeometry: hdrGeometry },
    }).geometry?.flip,
  ).toBe(2)
  const edited = structuredClone(source)
  edited.processing.revision++
  edited.processing.adjustments!.exposureEv = -2
  expect(
    inspectionContext(edited, { width: context.width, height: context.height }).gridIdentity,
  ).toBe(first.gridIdentity)
  edited.processing.crop = { ...identityCrop, quarterTurns: 2 }
  expect(inspectionContext(edited, { width: context.width, height: context.height })).toMatchObject(
    {
      width: first.width,
      height: first.height,
    },
  )
  expect(
    inspectionContext(edited, { width: context.width, height: context.height }).gridIdentity,
  ).not.toBe(first.gridIdentity)
  for (const orientation of [2, 3]) {
    const changed = structuredClone(source)
    changed.processing.metadata.orientation = orientation
    expect(
      inspectionContext(changed, { width: context.width, height: context.height }).gridIdentity,
    ).not.toBe(first.gridIdentity)
  }
  const vignette = structuredClone(source)
  vignette.processing.settings.vignetting = !vignette.processing.settings.vignetting
  expect(
    inspectionContext(vignette, { width: context.width, height: context.height }).gridIdentity,
  ).toBe(first.gridIdentity)
  const lensToggle = structuredClone(source)
  lensToggle.processing.settings.distortion = !lensToggle.processing.settings.distortion
  expect(
    inspectionContext(lensToggle, { width: context.width, height: context.height }).gridIdentity,
  ).not.toBe(first.gridIdentity)
  const lensProfile = structuredClone(source)
  lensProfile.processing.metadata.lensProfile.identity = 'new-lens-mapping'
  expect(
    inspectionContext(lensProfile, { width: context.width, height: context.height }).gridIdentity,
  ).not.toBe(first.gridIdentity)
  const before = neutralInspectionSource(source)
  expect(before.processing.crop).toEqual(source.processing.crop)
  expect(before.processing.settings).toEqual(source.processing.settings)
  expect(before.processing.adjustments).toEqual(neutralAdjustments)
  expect(before.processing.noiseReduction?.luminance).toBe(0)
  expect(before.processing.detailSharpening?.amount).toBe(0)
  expect(source.processing.adjustments!.exposureEv).toBe(2)
})
