import { AnalysisQueue } from '../src/renderer/src/preview/analysis-queue'
import { expect, test } from '@playwright/test'
import { imageStatistics, clippingMask, sampleWorking } from '../src/shared/statistics'
import { renderAdjustments, neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
test('exact RGB bins ignore transparent pixels and classify precise SDR endpoints', () => {
  const data = new Uint8Array([0, 0, 0, 255, 255, 20, 30, 1, 254, 0, 0, 255, 0, 255, 255, 0])
  const stats = imageStatistics(data)
  expect(stats.visiblePixels).toBe(3)
  expect(stats.shadowClipped).toBe(1)
  expect(stats.highlightClipped).toBe(1)
  expect(stats.rgb.map((bins) => bins.reduce((a, b) => a + b, 0))).toEqual([3, 3, 3])
  expect(stats.rgb[0][254]).toBe(1)
  expect(clippingMask(data, 4, 1, 1).data[0]).toBe(3)
})
test('sampling is bounded, deterministic, spatially distributed and agrees with constant exact images', () => {
  const data = new Float32Array(100000 * 4)
  for (let i = 0; i < data.length; i += 4) data.set([0.1, 0.2, 0.3, 1], i)
  const sample = sampleWorking(data)
  expect(sample.length).toBe(65536 * 4)
  expect(sampleWorking(data)).toEqual(sample)
  const exact = imageStatistics(renderAdjustments(data, neutralAdjustments, srgbTransform)),
    sampled = imageStatistics(renderAdjustments(sample, neutralAdjustments, srgbTransform))
  expect(sampled.rgb.map((bins) => bins.indexOf(65536))).toEqual(
    exact.rgb.map((bins) => bins.indexOf(100000)),
  )
})

test('analysis coalesces drafts, rejects obsolete identities and immediately schedules final work', async () => {
  const sent: { generation: number; identity: string; parameters: typeof neutralAdjustments }[] = []
  let terminated = false
  let active = 0
  const queue = new AnalysisQueue(
    {
      postMessage: (message) => sent.push(message),
      terminate: () => {
        terminated = true
      },
    },
    'asset-photo-1',
    false,
    () => {
      active++
      return () => {
        active--
      }
    },
  )
  queue.update(neutralAdjustments, true)
  await expect.poll(() => sent.length).toBe(1)
  for (let exposureEv = 1; exposureEv <= 4; exposureEv++)
    queue.update({ ...neutralAdjustments, exposureEv }, false)
  expect(queue.accepts(sent[0])).toBe(false)
  queue.update({ ...neutralAdjustments, exposureEv: 5 }, true)
  queue.finished()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1].parameters.exposureEv).toBe(5)
  expect(queue.accepts(sent[1])).toBe(true)
  expect(queue.accepts({ ...sent[1], identity: 'old-photo' })).toBe(false)
  expect(active).toBe(1)
  queue.finished()
  expect(active).toBe(0)
  queue.update(neutralAdjustments, false)
  expect(active).toBe(1)
  queue.close()
  expect(active).toBe(0)
  queue.update(neutralAdjustments, true)
  expect(active).toBe(0)
  expect(terminated).toBe(true)
  expect(queue.accepts(sent[1])).toBe(false)
})
