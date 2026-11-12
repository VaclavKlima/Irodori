import { expect, test } from '@playwright/test'
import {
  maskPreviewMemoryPlan,
  resolveMaskPreview,
  validateMaskPreviewRequest,
  type MaskPreviewRequest,
} from '../src/shared/mask-preview'
import { inspectionHdrCapability, type PreviewContext } from '../src/shared/inspection'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { gradientMask } from './helpers/mask-gradients'
import { cropAdmission } from './crop-frame.helpers'

const request: MaskPreviewRequest = {
  photoId: 'a'.repeat(64),
  expectedRevision: 3,
  maskId: '00000000-0000-0000-0000-000000000001',
}
const context: PreviewContext = {
  photoId: request.photoId,
  revision: 3,
  width: 2400,
  height: 1600,
  gridIdentity: 'grid',
  geometry: identityMaskGeometry(2400, 1600),
  coordinateSpace: 'oriented-lens-corrected-cropped-photo',
  sourceDynamicRange: 'hdr',
  formats: ['jpeg', 'png'],
  hdr: inspectionHdrCapability,
  limits: { imageBytes: 8 * 1024 ** 2, pairBytes: 16 * 1024 ** 2 },
}
test('mask preview is existing-root read-only, PNG-only and defaults to a matched 1024-fit pair', () => {
  expect(validateMaskPreviewRequest(request)).toEqual(request)
  expect(resolveMaskPreview(request, context)).toMatchObject({
    width: 1024,
    height: 683,
    labels: ['coverage', 'overlay'],
    encoding: { format: 'png', lossless: true },
  })
  for (const value of [
    { ...request, photoId: '../photo' },
    { ...request, maskId: 'component' },
    { ...request, expectedRevision: -1 },
    { ...request, expectedRevision: 1.5 },
    { ...request, view: 'before' },
    { ...request, mutation: {} },
    { ...request, inspection: { hdr: true } },
    { ...request, inspection: { comparison: 'before' } },
    { ...request, inspection: { encoding: { format: 'jpeg' } } },
    { ...request, inspection: { resolutionPercent: 101 } },
    { ...request, inspection: { resolutionPercent: 0 } },
  ])
    expect(() => validateMaskPreviewRequest(value)).toThrow()
  expect(
    resolveMaskPreview({ ...request, view: 'coverage' }, { ...context, width: 80, height: 60 }),
  ).toMatchObject({ width: 80, height: 60, labels: ['coverage'] })
})
test('regions bind the photo grid and preserve native bounds at explicit percentages', () => {
  const region = {
    units: 'normalized' as const,
    gridIdentity: 'grid',
    x: 0.1,
    y: 0.2,
    width: 0.25,
    height: 0.5,
  }
  expect(
    resolveMaskPreview(
      { ...request, view: 'overlay', inspection: { region, resolutionPercent: 50 } },
      context,
    ),
  ).toMatchObject({
    photoBounds: { x: 240, y: 320, width: 600, height: 800 },
    width: 300,
    height: 400,
    labels: ['overlay'],
  })
  expect(() =>
    resolveMaskPreview(
      { ...request, inspection: { region: { ...region, gridIdentity: 'old' } } },
      context,
    ),
  ).toThrow('grid changed')
  expect(() =>
    resolveMaskPreview({ ...request, inspection: { region: { ...region, x: 0.9 } } }, context),
  ).toThrow('outside')
})
test('resource preflight includes existing owners, encoded delivery and bounded GPU strips', () => {
  const mask = gradientMask({ kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })
  const admission = cropAdmission()
  const plan = maskPreviewMemoryPlan(request, context, mask, admission)
  expect(plan.accepted).toBe(true)
  expect(plan.ramBytes - admission.reservation.ramBytes).toBe(plan.ownRam)
  expect(plan.vramBytes - admission.reservation.vramBytes).toBe(plan.ownGpu)
  const low = structuredClone(admission)
  Object.assign(low.policy.ram, { effectiveBytes: plan.ramBytes - 1 })
  expect(maskPreviewMemoryPlan(request, context, mask, low).accepted).toBe(false)
  expect(() =>
    maskPreviewMemoryPlan(request, { ...context, geometry: undefined }, mask, admission),
  ).toThrow('geometry')
})
