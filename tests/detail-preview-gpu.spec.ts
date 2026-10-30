import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PreviewEngine } from '../src/main/preview-engine'
import { prepareDetailPreview } from '../src/main/processing/detail-preview'
import { detailPreviewFixture } from './detail-preview.helpers'

test('tiny prepared raster, scene-HDR and authored-HDR proofs retain CPU agreement across GPU filtering and output choices', async () => {
  for (const [hdr, authored] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const f = await detailPreviewFixture(hdr, authored),
      engine = new PreviewEngine(undefined, 'auto')
    try {
      const cpuDirectory = await f.directory('cpu'),
        gpuDirectory = await f.directory('gpu'),
        cpu = await prepareDetailPreview(
          cpuDirectory,
          f.job,
          new AbortController().signal,
          (options, backend) => engine.renderPreparedFull(cpuDirectory, options, backend),
        ),
        gpu = await prepareDetailPreview(
          gpuDirectory,
          { ...f.job, backend: 'gpu' },
          new AbortController().signal,
          (options, backend) => engine.renderPreparedFull(gpuDirectory, options, backend),
        ),
        expected = await readFile(join(cpuDirectory, 'full.rgba')),
        actual = await readFile(join(gpuDirectory, 'full.rgba')),
        expectedLinearBytes = await readFile(join(cpuDirectory, 'linear.f32')),
        actualLinearBytes = await readFile(join(gpuDirectory, 'linear.f32')),
        expectedLinear = new Float32Array(
          expectedLinearBytes.buffer,
          expectedLinearBytes.byteOffset,
          expectedLinearBytes.length / 4,
        ),
        actualLinear = new Float32Array(
          actualLinearBytes.buffer,
          actualLinearBytes.byteOffset,
          actualLinearBytes.length / 4,
        )
      let maximumCodeDifference = 0,
        maximumLinearRatio = 0,
        alphaExact = true
      for (let i = 0; i < actual.length; i++) {
        maximumCodeDifference = Math.max(maximumCodeDifference, Math.abs(actual[i] - expected[i]))
        if (i % 4 === 3) alphaExact &&= actual[i] === expected[i]
      }
      for (let i = 0; i < actualLinear.length; i++) {
        if (i % 4 === 3) alphaExact &&= Object.is(actualLinear[i], expectedLinear[i])
        else
          maximumLinearRatio = Math.max(
            maximumLinearRatio,
            Math.abs(actualLinear[i] - expectedLinear[i]) /
              (2e-6 + 2e-5 * Math.abs(expectedLinear[i])),
          )
      }
      expect(maximumCodeDifference).toBeLessThanOrEqual(1)
      expect(maximumLinearRatio).toBeLessThanOrEqual(1)
      expect(alphaExact).toBe(true)
      expect(gpu.detail!.backend).toBe('gpu')
      expect(gpu.detail!.gpuTiles).toBe(1)
      expect(gpu.detail!.adapter).toBeTruthy()
      expect(gpu.detail!.key).toBe(cpu.detail!.key)
      expect(gpu.detail!.proofBackendRequest).toBe(hdr && !authored ? 'gpu' : 'cpu')
      expect(gpu.diagnostics?.fallback).toBeUndefined()
      expect(gpu.settingsRevision).toBe(cpu.settingsRevision)
      expect(await readFile(f.original)).toEqual(f.originalBytes)
    } finally {
      await engine.close()
      await f.close()
    }
  }
})
