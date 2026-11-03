import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exportRenditions } from '../src/main/export/renditions'
import { detailExportFixture } from './detail-export.helpers'
import { fromHalf } from './export-reference'
import { exportRenditionsReference } from './export-rendering-reference'

test('tiny raster, scene-HDR and paired authored exports retain GPU filtering and existing quantized output agreement', async () => {
  const previous = process.env.IRODORI_EXPORT_BACKEND
  try {
    for (const [hdr, authored] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      const f = await detailExportFixture(hdr, authored)
      try {
        process.env.IRODORI_EXPORT_BACKEND = 'gpu'
        const cpu = await exportRenditionsReference(f.exportJob),
          gpuPreparation = await f.directory('gpu-preparation')
        process.env.IRODORI_EXPORT_BACKEND = 'gpu'
        const gpu = await exportRenditions({
          ...f.exportJob,
          directory: await f.directory('gpu-export'),
          preparationDirectory: gpuPreparation,
        })
        let maximumCode = 0,
          maximumHalf = 0
        for (let i = 0; i < cpu.rgb.length; i++)
          maximumCode = Math.max(maximumCode, Math.abs(cpu.rgb[i] - gpu.rgb[i]))
        if (cpu.half)
          for (let i = 0; i < cpu.half.length; i++)
            maximumHalf = Math.max(
              maximumHalf,
              Math.abs(fromHalf(cpu.half[i]) - fromHalf(gpu.half![i])),
            )
        expect(maximumCode).toBeLessThanOrEqual(1)
        expect(maximumHalf).toBeLessThanOrEqual(0.004)
        expect(gpu.diagnostics.renderer).toBe('gpu')
        expect(gpu.diagnostics.rendererFallback).toBeUndefined()
        for (const stage of hdr
          ? authored
            ? (['working', 'primary'] as const)
            : (['working'] as const)
          : (['primary'] as const)) {
          const expectedBytes = await readFile(
              join(f.exportJob.preparationDirectory!, `detail-${stage}.f32`),
            ),
            actualBytes = await readFile(join(gpuPreparation, `detail-${stage}.f32`)),
            expected = new Float32Array(
              expectedBytes.buffer,
              expectedBytes.byteOffset,
              expectedBytes.byteLength / 4,
            ),
            actual = new Float32Array(
              actualBytes.buffer,
              actualBytes.byteOffset,
              actualBytes.byteLength / 4,
            )
          let ratio = 0,
            alphaExact = true
          for (let i = 0; i < expected.length; i++) {
            if (i % 4 === 3) alphaExact &&= Object.is(expected[i], actual[i])
            else
              ratio = Math.max(
                ratio,
                Math.abs(actual[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i])),
              )
          }
          expect(ratio).toBeLessThanOrEqual(1)
          expect(alphaExact).toBe(true)
          expect(gpu.diagnostics.detail![stage]!.work).toMatchObject({
            backend: 'gpu',
            gpuTiles: 1,
          })
          expect(gpu.diagnostics.detail![stage]!.key).toBe(cpu.diagnostics.detail![stage]!.key)
        }
        if (hdr && !authored) {
          process.env.IRODORI_EXPORT_BACKEND = 'auto'
          const failure = new Error('Injected final GPU conversion unavailability.'),
            preparedPath = join(gpuPreparation, 'detail-working.f32'),
            preparedMarker = join(gpuPreparation, 'detail-working.json'),
            preparedBytes = await readFile(preparedPath),
            markerBytes = await readFile(preparedMarker),
            upstreamBytes = await f.originalWorkingBytes()
          let attempts = 0
          await expect(
            exportRenditions(
              {
                ...f.exportJob,
                directory: await f.directory('gpu-refusal'),
                preparationDirectory: gpuPreparation,
              },
              async () => {
                attempts++
                throw failure
              },
            ),
          ).rejects.toBe(failure)
          expect(attempts).toBe(1)
          expect(await readFile(preparedPath)).toEqual(preparedBytes)
          expect(await readFile(preparedMarker)).toEqual(markerBytes)
          expect(await f.originalWorkingBytes()).toEqual(upstreamBytes)
          const retried = await exportRenditions({
            ...f.exportJob,
            directory: await f.directory('gpu-retry'),
            preparationDirectory: gpuPreparation,
          })
          expect(retried.diagnostics.renderer).toBe('gpu')
          expect(retried.diagnostics.rendererFallback).toBeUndefined()
          expect(retried.diagnostics.detail!.working!.preparation).toBe('retained')
          expect(await readFile(preparedPath)).toEqual(preparedBytes)
          let retryCode = 0,
            retryHalf = 0
          for (let i = 0; i < gpu.rgb.length; i++)
            retryCode = Math.max(retryCode, Math.abs(gpu.rgb[i] - retried.rgb[i]))
          for (let i = 0; i < gpu.half!.length; i++)
            retryHalf = Math.max(
              retryHalf,
              Math.abs(fromHalf(gpu.half![i]) - fromHalf(retried.half![i])),
            )
          expect(retryCode).toBeLessThanOrEqual(1)
          expect(retryHalf).toBeLessThanOrEqual(0.004)
        }
        expect(await readFile(f.original)).toEqual(f.originalBytes)
      } finally {
        await f.close()
      }
    }
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = previous
  }
})
