import { expect, test } from '@playwright/test'
import { cropWorkingFrame } from '../src/main/processing/crop-frame'
import { fitCrop, identityCrop } from '../src/shared/crop'
import { cropAdmission, cropFrame } from './crop-frame.helpers'

test('native GPU authored-frame adapter preserves color semantics and agrees with CPU over multiple bands', async () => {
  const frame = cropFrame(97, 131),
    before = Buffer.from(frame.data.buffer).toString('hex'),
    job = {
      settings: fitCrop(frame, { ...identityCrop, angle: 12.34, width: 0.7, height: 0.8 }),
      admission: cropAdmission(),
      backend: 'gpu' as const,
    },
    signal = new AbortController().signal,
    actual = await cropWorkingFrame(frame, job, signal),
    expected = await cropWorkingFrame(frame, { ...job, backend: 'cpu' }, signal)
  expect(actual.diagnostics.backend).toBe('gpu')
  expect(actual.diagnostics.gpuTiles).toBeGreaterThan(1)
  expect(actual.diagnostics.adapter).toBeTruthy()
  expect(actual.frame.transform).toBe(frame.transform)
  expect(actual.frame.width).toBe(expected.frame.width)
  expect(actual.frame.height).toBe(expected.frame.height)
  let maximumRatio = 0
  for (let i = 0; i < expected.frame.data.length; i++)
    maximumRatio = Math.max(
      maximumRatio,
      Math.abs(actual.frame.data[i] - expected.frame.data[i]) /
        (2e-6 + 2e-5 * Math.abs(expected.frame.data[i])),
    )
  expect(maximumRatio).toBeLessThanOrEqual(1)
  expect(Buffer.from(frame.data.buffer).toString('hex')).toBe(before)
})
