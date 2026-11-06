import { expect, test } from '@playwright/test'
import { defaultExportOptions, exportGeometry, type ExportOptions } from '../src/shared/export'
import {
  outputProofPixelKey,
  outputProofDisplayTarget,
  validateOutputProofRequest,
} from '../src/shared/export-proof'
import { SDR_TARGET } from '../src/shared/hdr'
import { exportProofDecodePlan } from '../src/shared/export-resources'
import { cropAdmission } from './crop-frame.helpers'
import {
  INITIAL_VIEW,
  constrain,
  replaceDimensions,
  savedView,
} from '../src/renderer/src/preview/geometry'

test('proof pixel identity ignores destination-independent naming/metadata and canonicalizes resize defaults', () => {
  const options = structuredClone(defaultExportOptions),
    key = outputProofPixelKey(options, true)
  for (const patch of [
    { metadata: 'none' },
    { names: { mode: 'sequence', prefix: 'Other-' } },
    { existing: 'skip' },
  ] as Partial<ExportOptions>[])
    expect(outputProofPixelKey({ ...options, ...patch }, true)).toBe(key)
  expect(outputProofPixelKey({ ...options, output: 'hdr' }, true)).toBe(key)
  expect(outputProofPixelKey({ ...options, output: 'sdr' }, true)).not.toBe(key)
  expect(outputProofPixelKey({ ...options, quality: 80 }, true)).not.toBe(key)
  const sized: ExportOptions = { ...options, size: { mode: 'longest', edge: 100 } }
  expect(outputProofPixelKey(sized, true)).toBe(
    outputProofPixelKey(
      {
        ...sized,
        size: { mode: 'longest', edge: 100, method: 'lanczos3', allowEnlargement: false },
      },
      true,
    ),
  )
  expect(() => outputProofPixelKey({ ...options, output: 'hdr' }, false)).toThrow('support HDR')
})

for (const [size, expected] of [
  [{ mode: 'original' }, { width: 80, height: 40 }],
  [
    { mode: 'longest', edge: 20 },
    { width: 20, height: 10 },
  ],
  [
    { mode: 'fit', width: 60, height: 10 },
    { width: 20, height: 10 },
  ],
  [
    { mode: 'longest', edge: 100 },
    { width: 80, height: 40 },
  ],
  [
    { mode: 'longest', edge: 100, allowEnlargement: true, method: 'lanczos3' },
    { width: 100, height: 50 },
  ],
] as [ExportOptions['size'], { width: number; height: number }][]) {
  test(`proof uses existing ${JSON.stringify(size)} output geometry`, () => {
    expect(exportGeometry(80, 40, size)).toEqual(expected)
    expect(outputProofPixelKey({ ...defaultExportOptions, size }, false)).toContain(
      '"output":"sdr"',
    )
  })
}

test('typed proof requests reject paths, extra fields, invalid options and request tokens', () => {
  const valid = {
    photoId: 'a'.repeat(64),
    preparationId: crypto.randomUUID(),
    token: crypto.randomUUID(),
    options: defaultExportOptions,
  }
  expect(validateOutputProofRequest(valid)).toEqual(valid)
  for (const bad of [
    { ...valid, path: '/tmp/input' },
    { ...valid, token: '../../bad' },
    { ...valid, options: { ...defaultExportOptions, quality: 101 } },
    { ...valid, photoId: null },
  ])
    expect(() => validateOutputProofRequest(bad)).toThrow()
})

test('proof decode counts both planes, JPEG heap and existing owners at the exact managed boundary', () => {
  const admission = cropAdmission(),
    plan = exportProofDecodePlan(300, 200, true, 1234, admission)
  expect(plan.accepted).toBe(true)
  Object.assign(admission.policy.ram, { effectiveBytes: plan.total.ramBytes - 1 })
  expect(exportProofDecodePlan(300, 200, true, 1234, admission).accepted).toBe(false)
  Object.assign(admission.policy.ram, { effectiveBytes: plan.total.ramBytes })
  expect(exportProofDecodePlan(300, 200, true, 1234, admission).accepted).toBe(true)
  expect(exportProofDecodePlan(300, 200, false, 1234, admission).bytes.ramBytes).toBeLessThan(
    plan.bytes.ramBytes,
  )
  expect(() => exportProofDecodePlan(300, 200, false, 256 * 1024 ** 2 + 1, admission)).toThrow(
    '256 MiB',
  )
})

test('proof local display selection preserves the saved preference and reports actual capabilities', () => {
  const display = {
    ...SDR_TARGET,
    requested: 'auto' as const,
    capabilities: { hardware: true, extended: true, p3: true, headroomStops: 2, reason: '' },
  }
  expect(outputProofDisplayTarget(display, 'hdr', 17)).toMatchObject({
    generation: 17,
    mode: 'hdr',
    peak: 4,
    colorSpace: 'display-p3',
  })
  expect(outputProofDisplayTarget(display, 'sdr', 18)).toMatchObject({ mode: 'sdr', peak: 1 })
  expect(
    outputProofDisplayTarget(
      {
        ...display,
        capabilities: { ...display.capabilities, extended: false, reason: 'Device lost' },
      },
      'hdr',
      19,
    ),
  ).toMatchObject({ mode: 'sdr', reason: 'Device lost' })
  expect(display.requested).toBe('auto')
})

test('native output pixels keep Fit bounded and retain normalized framing across output dimensions', () => {
  const viewport = { width: 100, height: 80 },
    image = { width: 400, height: 200 }
  expect(constrain(INITIAL_VIEW, { width: 20, height: 10 }, viewport).scale).toBe(1)
  const view = constrain({ fit: false, scale: 1, x: -90, y: 30 }, image, viewport)
  const resized = replaceDimensions(view, image, { width: 800, height: 400 }, viewport)
  expect(savedView('a', resized, { width: 800, height: 400 })).toEqual(savedView('a', view, image))
})
