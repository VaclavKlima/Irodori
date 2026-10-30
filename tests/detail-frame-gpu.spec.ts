import { expect, test } from '@playwright/test'
import { detailWorkingFrame } from '../src/main/processing/detail-frame'
import { createSpatialDetailGpu } from '../src/main/gpu/spatial-detail'
import { detailFrame, detailFrameJob } from './detail-frame.helpers'
import { sha } from './export.helpers'

test('tiny GPU frame bands preserve both primary domains, exact coverage and equivalent precision recovery', async () => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    const frame = detailFrame(19, 131, primaries === 'rec2020', true),
      job = detailFrameJob(primaries),
      before = Buffer.from(frame.data.buffer).toString('hex'),
      gpu = createSpatialDetailGpu()
    try {
      const cpu = await detailWorkingFrame(frame, job, new AbortController().signal),
        result = await detailWorkingFrame(
          frame,
          { ...job, backend: 'gpu' },
          new AbortController().signal,
          () => gpu,
        ),
        data = result.frame.data,
        words = new Uint32Array(data.buffer, data.byteOffset, data.length),
        original = new Uint32Array(frame.data.buffer, frame.data.byteOffset, frame.data.length)
      let maximum = 0,
        alphaExact = true,
        transparentExact = true
      for (let i = 0; i < data.length; i += 4) {
        alphaExact &&= words[i + 3] === original[i + 3]
        for (let c = 0; c < 3; c++) {
          maximum = Math.max(
            maximum,
            Math.abs(data[i + c] - cpu.frame.data[i + c]) /
              (2e-6 + 2e-5 * Math.abs(cpu.frame.data[i + c])),
          )
          if (frame.data[i + 3] === 0) transparentExact &&= words[i + c] === original[i + c]
        }
      }
      expect(maximum).toBeLessThanOrEqual(1)
      expect(alphaExact && transparentExact).toBe(true)
      expect(result.diagnostics).toMatchObject({
        backend: 'mixed',
        gpuTiles: 2,
        cpuTiles: 1,
        precisionRecoveryTiles: 1,
        maxSourceStrips: 3,
      })
      expect(result.diagnostics.adapter).toBeTruthy()
      expect(gpu.allocatedBytes).toBe(0)
      expect(result.frame.cpuSource).toBeUndefined()
      expect(result.frame.identity).toBeUndefined()
      if (result.frame.hdr) {
        expect(result.frame.hdr.sha256).toBe(
          sha(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
        )
        expect(result.frame.hdr.source).toEqual(frame.hdr!.source)
        expect(result.frame.hdr.url).toBeUndefined()
      }
      expect(Buffer.from(frame.data.buffer).toString('hex')).toBe(before)
    } finally {
      await gpu.close()
    }
  }
})
