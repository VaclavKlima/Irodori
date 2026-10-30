import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exportRenditions } from '../src/main/export/renditions'
import { detailExportFixture } from './detail-export.helpers'
import { fromHalf } from './export-reference'

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
        process.env.IRODORI_EXPORT_BACKEND = 'cpu'
        const cpu = await exportRenditions(f.exportJob),
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
        expect(gpu.diagnostics.renderer).toBe(hdr && !authored ? 'gpu' : 'cpu')
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
          const recovered = await exportRenditions(
            {
              ...f.exportJob,
              directory: await f.directory('cpu-recovery'),
              preparationDirectory: gpuPreparation,
            },
            async () => {
              throw new Error('Injected final GPU conversion unavailability.')
            },
          )
          expect(recovered.diagnostics).toMatchObject({
            renderer: 'cpu',
            rendererFallback: 'Injected final GPU conversion unavailability.',
          })
          expect(recovered.diagnostics.detail!.working!.preparation).toBe('retained')
          let recoveredCode = 0,
            recoveredHalf = 0
          for (let i = 0; i < gpu.rgb.length; i++)
            recoveredCode = Math.max(recoveredCode, Math.abs(gpu.rgb[i] - recovered.rgb[i]))
          for (let i = 0; i < gpu.half!.length; i++)
            recoveredHalf = Math.max(
              recoveredHalf,
              Math.abs(fromHalf(gpu.half![i]) - fromHalf(recovered.half![i])),
            )
          expect(recoveredCode).toBeLessThanOrEqual(1)
          expect(recoveredHalf).toBeLessThanOrEqual(0.004)
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
