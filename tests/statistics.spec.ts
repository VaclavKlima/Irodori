import { AnalysisQueue } from '../src/renderer/src/preview/analysis-queue'
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { scanSdrDiagnostics } from '../src/main/processing/sdr-diagnostics'
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
test('regional SDR statistics preserve isolated clipping across strips before OR reduction', async () => {
  const width = 6,
    height = 130,
    data = Buffer.alloc(width * height * 4)
  const set = (x: number, y: number, rgba: number[]) => data.set(rgba, (y * width + x) * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, [80, 90, 100, 255])
  set(1, 63, [0, 0, 0, 255])
  set(2, 64, [255, 20, 30, 1])
  set(4, 65, [10, 255, 15, 255])
  set(3, 64, [0, 0, 255, 0])
  set(2, 66, [0, 0, 0, 0])
  set(0, 64, [0, 0, 0, 255])
  set(5, 65, [255, 255, 255, 255])
  set(4, 67, [255, 255, 255, 255])
  const path = test.info().outputPath('frame.rgba'),
    frame = { width, height, sha256: createHash('sha256').update(data).digest('hex') },
    job = { bounds: { x: 1, y: 63, width: 4, height: 4 }, size: { width: 2, height: 2 } }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  const result = await scanSdrDiagnostics(path, frame, job)
  expect(result).toMatchObject({ visiblePixels: 14, shadowClipped: 1, highlightClipped: 2 })
  expect(result.rgb.map((bins) => bins.reduce((sum, bin) => sum + bin, 0))).toEqual([14, 14, 14])
  expect([result.rgb[0][80], result.rgb[1][90], result.rgb[2][100]]).toEqual([11, 11, 11])
  expect(Array.from(result.mask)).toEqual([3, 0, 0, 2])
  set(0, 129, [0, 0, 0, 255])
  await writeFile(path, data)
  await expect(scanSdrDiagnostics(path, frame, job)).rejects.toThrow('Damaged statistics frame.')
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
