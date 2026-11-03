import { expect, test } from '@playwright/test'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { exportRenditions } from '../src/main/export/renditions'
import { exportResizePolicy } from '../src/main/export/resize-policy'
import { defaultExportOptions } from '../src/shared/export'
import { compileResizeGpu } from '../src/shared/export-resize-gpu'
import { cropAdmission } from './crop-frame.helpers'
import { detailExportFixture } from './detail-export.helpers'
import { fromHalf } from './export-reference'
import { exportRenditionsReference } from './export-rendering-reference'
import { syntheticExportSource } from './export.helpers'

test('tiny HDR enlargement retains GPU rendition agreement and propagates GPU initialization failure', async () => {
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
    process.env.IRODORI_EXPORT_BACKEND = 'auto'
    const cpuJob = await job('cpu'),
      cpu = await exportRenditionsReference(cpuJob)
    process.env.IRODORI_EXPORT_BACKEND = 'gpu'
    const gpuJob = await job('gpu'),
      gpu = await exportRenditions(gpuJob)
    expect(gpu.diagnostics.renderer).toBe('gpu')
    expect(gpu.diagnostics.rendererFallback).toBeUndefined()
    expect(gpu.geometry).toEqual({ width: 13, height: 10 })
    expect(gpu.diagnostics.resize).toMatchObject({ enlarged: true, renderer: 'gpu' })
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
    const failure = new Error('Injected enlargement rendition GPU failure.'),
      refusedJob = await job('refused')
    let attempts = 0
    await expect(
      exportRenditions(refusedJob, async () => {
        attempts++
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(attempts).toBe(1)
    expect(await readFile(source.path)).toEqual(original)
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = previous
  }
})

test('default and automatic raster downscales use bounded GPU resize and refuse zero VRAM without publication', async () => {
  const previous = process.env.IRODORI_EXPORT_BACKEND,
    f = await detailExportFixture(),
    source = {
      ...f.source,
      processing: {
        ...f.source.processing,
        noiseReduction: undefined,
        detailSharpening: undefined,
      },
    },
    options = {
      ...f.exportJob.options,
      size: { mode: 'longest' as const, edge: 9 },
    },
    plan = compileResizeGpu(f.frame.width, f.frame.height, 9, 8, 3)
  let renditionGpuCalls = 0
  const makeRenditionGpu = async () => {
    renditionGpuCalls++
    throw new Error('Raster rendition must retain its distinct source domain.')
  }
  try {
    for (const mode of [undefined, 'auto'] as const) {
      if (mode === undefined) delete process.env.IRODORI_EXPORT_BACKEND
      else process.env.IRODORI_EXPORT_BACKEND = mode
      const admission = cropAdmission(),
        directory = await f.directory(`downscale-${mode ?? 'default'}`)
      Object.assign(admission.policy.vram, { effectiveBytes: 64 * 1024 ** 2 })
      const job = {
          source,
          options,
          directory,
          hdr: false,
          resizePolicy: { ...exportResizePolicy },
          resizeAdmission: admission,
        },
        result = await exportRenditions(job, makeRenditionGpu),
        resize = result.diagnostics.resize!,
        memory = result.diagnostics.memory!.resizeGpu
      expect(result.geometry).toEqual({ width: 9, height: 8 })
      expect(result.rgb.length).toBe(9 * 8 * 3)
      expect(new Set(result.rgb).size).toBeGreaterThan(3)
      expect(result.half).toBeUndefined()
      expect(result.diagnostics.renderer).toBe('cpu')
      expect(result.diagnostics.rendererFallback).toBeUndefined()
      expect(renditionGpuCalls).toBe(0)
      expect(resize).toMatchObject({
        renderer: 'gpu',
        enlarged: false,
        input: { width: f.frame.width, height: f.frame.height },
        output: { width: 9, height: 8 },
      })
      expect(resize.adapter).toBeTruthy()
      expect(resize.adapter).not.toMatch(/llvmpipe|swiftshader|software/i)
      expect(resize.gpuMemoryBytes).toBeGreaterThan(0)
      expect(resize.gpuMemoryBytes!).toBeLessThanOrEqual(memory.bytes.vramBytes)
      expect(resize.peakCachedRows).toBeGreaterThan(0)
      expect(resize.peakCachedRows!).toBeLessThanOrEqual(plan.maxRows)
      expect(memory.accepted).toBe(true)
      expect(await readFile(f.original)).toEqual(f.originalBytes)
      test.info().annotations.push({
        type: 'gpu-resize',
        description: JSON.stringify({
          mode: mode ?? 'default',
          adapter: resize.adapter,
          gpuMemoryBytes: resize.gpuMemoryBytes,
          peakCachedRows: resize.peakCachedRows,
        }),
      })

      const refused = structuredClone(admission),
        refusedDirectory = await f.directory(`zero-vram-${mode ?? 'default'}`)
      Object.assign(refused.policy.vram, { effectiveBytes: 0 })
      Object.assign(refused.reservation, { vramBytes: 0 })
      await expect(
        exportRenditions(
          { ...job, directory: refusedDirectory, resizeAdmission: refused },
          makeRenditionGpu,
        ),
      ).rejects.toThrow('frozen managed image budgets')
      expect(renditionGpuCalls).toBe(0)
      expect(await readdir(refusedDirectory)).toEqual([])
      expect(await readFile(f.original)).toEqual(f.originalBytes)
    }
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = previous
    await f.close()
  }
})
