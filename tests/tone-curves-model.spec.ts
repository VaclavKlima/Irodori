import { test, expect } from '@playwright/test'
import {
  initialSettings,
  mergeEditPatch,
  validatePatch,
  validateProcessingPatch,
} from '../src/shared/edits'
import { identityToneCurves, preparedToneCurves, sameToneCurves } from '../src/shared/tone-curves'
import {
  snapshotAdjustments,
  sameAdjustments,
  neutralAdjustments,
  srgbTransform,
} from '../src/shared/adjustments'
import {
  curveGraphRange,
  curveGraphPosition,
  curveGraphValue,
  moveCurvePoint,
  targetCurvePoint,
} from '../src/shared/curve-graph'
import { curveToneArea, sampledCurveTone, validateCurveToneRequest } from '../src/shared/curve-tone'
import { inspectorReset } from '../src/shared/inspector-reset'
import { copiedEdits, transferPatch, defaultEditTransferGroups } from '../src/shared/edit-transfer'
import { processingMetadata } from '../src/main/processing/metadata'
import { EditGestureCommits } from '../src/renderer/src/hooks/edit-gesture-commit'
import { exportGpuAllocation } from '../src/shared/export-resources'
import { TONE_CURVE_PARAMETER_BYTES } from '../src/shared/tone-curves-gpu'

const red = [
  { input: -1, output: -0.5 },
  { input: 0, output: 0.02 },
  { input: 0.18, output: 0.25 },
  { input: 16, output: 20 },
]
test('atomic curve patches, frozen snapshots, copy groups and resets preserve unrelated edits', () => {
  const base = initialSettings(),
    result = mergeEditPatch(base, { curves: { red }, contrast: 12 })
  expect(result.version).toBe(12)
  expect(result.curves.green).toEqual(base.curves.green)
  expect(base.curves).toEqual(identityToneCurves)
  expect(sameAdjustments(base, result)).toBe(false)
  const snapshot = snapshotAdjustments(result),
    compiled = preparedToneCurves(snapshot.curves)
  expect(preparedToneCurves(snapshot.curves)).toBe(compiled)
  expect(preparedToneCurves(structuredClone(snapshot.curves))).toBe(compiled)
  expect(sameToneCurves(structuredClone(result.curves), snapshot.curves)).toBe(true)
  red[0].output = -0.4
  expect(snapshot.curves!.red[0].output).toBe(-0.5)
  red[0].output = -0.5
  expect(() => validateProcessingPatch({ curves: result.curves })).not.toThrow()
  expect(() => validateProcessingPatch({ curves: { red } })).toThrow('Unsupported')
  for (const invalid of [
    { version: 2, red },
    { unknown: red },
    { red: [] },
    {
      red: [
        { input: 0, output: 0 },
        { input: 0.00009, output: 1 },
      ],
    },
  ])
    expect(() => validatePatch({ curves: invalid })).toThrow()
  const state = { photoId: 'a', revision: 1, canUndo: true, canRedo: false, settings: result }
  expect(mergeEditPatch(result, inspectorReset('light', state))).toMatchObject({
    curves: identityToneCurves,
    contrast: 0,
  })
  const source = copiedEdits(
    { id: 'clipboard', photoId: 'a', filename: 'source', revision: 1, copiedAt: '2026-11-04' },
    result,
    processingMetadata({}, []),
  )
  expect(defaultEditTransferGroups).toContain('curves')
  expect(transferPatch(source, ['curves'])).toEqual({
    curves: {
      master: result.curves.master,
      red: result.curves.red,
      green: result.curves.green,
      blue: result.curves.blue,
    },
  })
  expect(transferPatch(source, ['light'])).not.toHaveProperty('curves')
  expect(
    exportGpuAllocation(64, false, true, false, 0, 1e8, false, true).baseBytes -
      exportGpuAllocation(64, false, true, false).baseBytes,
  ).toBe(TONE_CURVE_PARAMETER_BYTES)
})

test('graph views remain invertible, cover off-plot points and constrain only point inputs', () => {
  for (const view of ['standard', 'hdr', 'fit'] as const) {
    const range = curveGraphRange(view, red)
    for (const v of [-16, -0.01, 0, 0.18, 1, 16, 64])
      expect(Math.abs(curveGraphValue(curveGraphPosition(v, range), range) - v)).toBeLessThan(1e-10)
  }
  expect(curveGraphRange('fit', red)).toEqual({ min: -1, max: 20 })
  expect(moveCurvePoint(red, 1, { input: 2, output: -2 })[1]).toEqual({ input: 0.1799, output: -2 })
  expect(moveCurvePoint(red, 0, { input: -16 })[0].input).toBe(-16)
  const range = curveGraphRange('standard', identityToneCurves.red)
  expect(targetCurvePoint(identityToneCurves.red, 0.999, range, 240)).toMatchObject({
    index: 1,
    added: false,
  })
  const target = targetCurvePoint(identityToneCurves.red, 0.2, range, 240)
  expect(target).toMatchObject({ index: 1, added: true })
  expect(target.points[1].output).toBe(0.2)
  expect(() =>
    targetCurvePoint(
      Array.from({ length: 16 }, (_, i) => ({ input: i, output: i })),
      0.3,
      range,
      240,
    ),
  ).toThrow('16 points')
})

test('tone samples use Light before Master and RGB after Master, ignoring alpha and downstream color', () => {
  const p = initialSettings(),
    pixels = new Float32Array([0.18, 0.18, 0.18, 1, 50, 50, 50, 0])
  const sample = sampledCurveTone(
    pixels,
    { ...p, exposureEv: 1, saturation: -100 },
    srgbTransform,
    true,
    'master',
  )
  expect(sample.visibleSamples).toBe(1)
  expect(sample.input).toBeCloseTo(0.36, 7)
  const modified = mergeEditPatch(p, {
    curves: {
      master: [
        { input: 0, output: 0 },
        { input: 1, output: 2 },
      ],
      red: [
        { input: 0, output: 0 },
        { input: 1, output: 3 },
      ],
    },
    saturation: -100,
  })
  const master = sampledCurveTone(pixels, modified, srgbTransform, true, 'master'),
    channel = sampledCurveTone(pixels, modified, srgbTransform, true, 'red')
  expect(master.input).toBeCloseTo(0.18, 7)
  expect(master.output).toBeCloseTo(0.36, 7)
  expect(channel.input).toBeCloseTo(0.36, 7)
  expect(channel.output).toBeCloseTo(1.08, 7)
  expect(
    sampledCurveTone(pixels, neutralAdjustments, srgbTransform, false, 'green').input,
  ).toBeCloseTo(0.18, 7)
  expect(() =>
    sampledCurveTone(new Float32Array([1, 1, 1, 0]), p, srgbTransform, true, 'master'),
  ).toThrow('transparent')
  expect(() =>
    sampledCurveTone(new Float32Array([100, 100, 100, 1]), p, srgbTransform, true, 'red'),
  ).toThrow('outside')
  expect(curveToneArea({ channel: 'red', x: 0, y: 1 }, 97, 131)).toEqual({
    x: 0,
    y: 128,
    width: 3,
    height: 3,
  })
  expect(curveToneArea({ channel: 'master', x: 0.5, y: 63.5 / 131 }, 97, 131)).toEqual({
    x: 46,
    y: 61,
    width: 5,
    height: 5,
  })
  for (const value of [
    { channel: 'cyan', x: 0, y: 0 },
    { channel: 'red', x: NaN, y: 0 },
    { channel: 'blue', x: 0, y: 2 },
  ])
    expect(() => validateCurveToneRequest(value)).toThrow()
})

test('gesture handoff captures curves and refuses another revision with different points', () => {
  const commits = new EditGestureCommits(),
    scope = { photoId: 'a', enabled: true },
    settings = initialSettings()
  commits.enter(scope)
  const state = { photoId: 'a', revision: 0, canUndo: false, canRedo: false, settings }
  const next = mergeEditPatch(settings, { curves: { red } })
  const commit = commits.begin(scope, state, 0, next)!
  expect(commit.parameters.curves).toEqual(next.curves)
  expect(Object.isFrozen(commit.parameters.curves!.red[0])).toBe(true)
  commits.observe({ ...state, revision: 1, settings: mergeEditPatch(settings, { exposureEv: 1 }) })
  expect(commits.snapshot).toBeNull()
})
