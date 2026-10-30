import { expect, test } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exportRenditions } from '../src/main/export/renditions'
import { exportResizePolicy } from '../src/main/export/resize-policy'
import { defaultExportOptions } from '../src/shared/export'
import { syntheticExportSource } from './export.helpers'
import { cropAdmission } from './crop-frame.helpers'
import { fromHalf } from './export-reference'

test('tiny HDR enlargement retains actual GPU rendition processing, CPU agreement and complete recovery', async () => {
  const previous = process.env.IRODORI_EXPORT_BACKEND,
    root = test.info().outputPath('gpu-enlargement')
  await mkdir(root)
  const source = await syntheticExportSource(root, 8, 6, (x, y) => [
      (x + 1) / 10,
      (y + 1) / 5,
      2 + ((x + y) % 3),
    ]),
    original = await readFile(source.path),
    admission = cropAdmission(),
    options = {
      ...defaultExportOptions,
      size: { mode: 'fit' as const, width: 13, height: 17, allowEnlargement: true },
    }
  Object.assign(admission.policy.vram, { effectiveBytes: 64 * 1024 ** 2 })
  const job = async (name: string) => {
    const directory = join(root, name)
    await mkdir(directory)
    return {
      source,
      options,
      directory,
      hdr: true,
      resizePolicy: { ...exportResizePolicy },
      resizeAdmission: admission,
    }
  }
  try {
    process.env.IRODORI_EXPORT_BACKEND = 'cpu'
    const cpuJob = await job('cpu'),
      cpu = await exportRenditions(cpuJob)
    process.env.IRODORI_EXPORT_BACKEND = 'gpu'
    const gpuJob = await job('gpu'),
      gpu = await exportRenditions(gpuJob)
    expect(gpu.diagnostics.renderer).toBe('gpu')
    expect(gpu.diagnostics.rendererFallback).toBeUndefined()
    expect(gpu.geometry).toEqual({ width: 13, height: 10 })
    expect(gpu.diagnostics.resize).toMatchObject({ enlarged: true })
    expect(gpu.diagnostics.memory!.gpu.accepted).toBe(true)
    const cpuBytes = await readFile(join(cpuJob.directory, 'rendition.f32')),
      gpuBytes = await readFile(join(gpuJob.directory, 'rendition.f32')),
      floats = (bytes: Buffer) =>
        new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      expected = floats(cpuBytes),
      actual = floats(gpuBytes)
    expect(actual.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++)
      expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(
        2e-6 + 2e-5 * Math.abs(expected[i]),
      )
    for (let i = 0; i < cpu.rgb.length; i++)
      expect(Math.abs(gpu.rgb[i] - cpu.rgb[i])).toBeLessThanOrEqual(1)
    for (let i = 0; i < cpu.half!.length; i++)
      expect(Math.abs(fromHalf(gpu.half![i]) - fromHalf(cpu.half![i]))).toBeLessThanOrEqual(0.004)
    process.env.IRODORI_EXPORT_BACKEND = 'auto'
    const recovered = await exportRenditions(await job('recovered'), async () => {
      throw new Error('Injected enlargement rendition GPU failure.')
    })
    expect(recovered.diagnostics).toMatchObject({
      renderer: 'cpu',
      rendererFallback: 'Injected enlargement rendition GPU failure.',
    })
    expect(recovered.rgb).toEqual(cpu.rgb)
    expect(recovered.half).toEqual(cpu.half)
    expect(await readFile(source.path)).toEqual(original)
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = previous
  }
})
