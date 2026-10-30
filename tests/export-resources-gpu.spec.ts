import { expect, test } from '@playwright/test'
import { createExportGpu } from '../src/main/export/gpu'
import { exportGpuAllocation, exportSdrEncodePlan } from '../src/shared/export-resources'
import { neutralAdjustments } from '../src/shared/adjustments'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { exportRenditions } from '../src/main/export/renditions'
import { detailExportFixture } from './detail-export.helpers'
import { fromHalf } from './export-reference'

test('the tiny GPU owner obeys exact allocation limits, streams without retained HDR, and drains one active request on close', async () => {
  const capacity = 16,
    plan = exportGpuAllocation(capacity, true, true, false, capacity),
    streamed = await createExportGpu(
      capacity,
      neutralAdjustments,
      undefined,
      true,
      true,
      64,
      capacity,
      plan.baseBytes,
    )
  try {
    expect(streamed.hdrDeferred).toBe(false)
    expect(streamed.peakBytes).toBe(plan.baseBytes)
  } finally {
    await streamed.close()
  }
  await expect(
    createExportGpu(capacity, neutralAdjustments, undefined, true, true, 64, 0, plan.baseBytes - 1),
  ).rejects.toThrow('managed image budgets')
  const retained = await createExportGpu(
      capacity,
      neutralAdjustments,
      undefined,
      true,
      true,
      64,
      capacity,
      plan.totalBytes,
    ),
    pixels = new Float32Array(
      Array.from({ length: capacity }, (_, i) => [0.2 + i / 100, 0.3, 1.5, 1]).flat(),
    )
  expect(retained.hdrDeferred).toBe(true)
  expect(retained.peakBytes).toBe(plan.totalBytes)
  const work = retained.render(pixels)
  await expect(retained.render(pixels)).rejects.toThrow('busy')
  const closing = retained.close()
  expect(retained.close()).toBe(closing)
  await expect(retained.render(pixels)).rejects.toThrow('closed')
  expect((await work).data.length).toBe(capacity * 4)
  await closing
})

test('constrained real exports reuse retained filtering, stream within available VRAM and recover completely below the tile limit', async () => {
  const previous = process.env.IRODORI_EXPORT_BACKEND,
    f = await detailExportFixture(true)
  try {
    process.env.IRODORI_EXPORT_BACKEND = 'cpu'
    const reference = await exportRenditions(f.exportJob),
      memory = reference.diagnostics.memory!,
      filteredPath = join(f.exportJob.preparationDirectory!, 'detail-working.f32'),
      filtered = await readFile(filteredPath),
      admission = structuredClone(f.exportJob.detailAdmission!)
    Object.assign(admission.policy.vram, {
      effectiveBytes: admission.reservation.vramBytes + memory.gpuBuffers.baseBytes,
    })
    const job = {
      ...f.exportJob,
      directory: await f.directory('limited-vram'),
      cropAdmission: admission,
      detailAdmission: admission,
    }
    let allocations = 0
    const makeGpu: typeof createExportGpu = async (...args) => {
      allocations++
      expect(args[7]).toBe(memory.gpuBuffers.baseBytes)
      const converter = await createExportGpu(...args)
      expect(converter.hdrDeferred).toBe(false)
      expect(converter.peakBytes).toBe(memory.gpuBuffers.baseBytes)
      return converter
    }
    process.env.IRODORI_EXPORT_BACKEND = 'auto'
    const streamed = await exportRenditions(job, makeGpu)
    expect(streamed.diagnostics).toMatchObject({
      renderer: 'gpu',
      gpuPeakBytes: memory.gpuBuffers.baseBytes,
      detail: { working: { preparation: 'retained' } },
    })
    expect(allocations).toBe(1)
    expect(streamed.diagnostics.rendererFallback).toBeUndefined()
    Object.assign(admission.policy.vram, {
      effectiveBytes: admission.policy.vram.effectiveBytes - 1,
    })
    const recovered = await exportRenditions(
      { ...job, directory: await f.directory('below-tile-limit') },
      makeGpu,
    )
    expect(allocations).toBe(1)
    expect(recovered.diagnostics).toMatchObject({
      renderer: 'cpu',
      rendererFallback: 'GPU export exceeds the frozen managed image budgets.',
      detail: { working: { preparation: 'retained' } },
    })
    for (const result of [streamed, recovered]) {
      let codeError = 0,
        halfError = 0
      for (let i = 0; i < result.rgb.length; i++)
        codeError = Math.max(codeError, Math.abs(result.rgb[i] - reference.rgb[i]))
      for (let i = 0; i < result.half!.length; i++)
        halfError = Math.max(
          halfError,
          Math.abs(fromHalf(result.half![i]) - fromHalf(reference.half![i])),
        )
      expect(codeError).toBeLessThanOrEqual(1)
      expect(halfError).toBeLessThanOrEqual(0.004)
    }
    process.env.IRODORI_EXPORT_BACKEND = 'gpu'
    const directory = await f.directory('forced-gpu-refusal')
    await expect(exportRenditions({ ...job, directory }, makeGpu)).rejects.toThrow('budgets')
    expect(allocations).toBe(1)
    expect(await readdir(directory)).toEqual([])
    expect(await readFile(filteredPath)).toEqual(filtered)
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = previous
    await f.close()
  }
})

test('a tight RAM budget defers early SDR encoding until the real GPU has retired without changing rendition pixels', async () => {
  const previous = process.env.IRODORI_EXPORT_BACKEND,
    f = await detailExportFixture(true)
  try {
    process.env.IRODORI_EXPORT_BACKEND = 'cpu'
    const reference = await exportRenditions(f.exportJob),
      memory = reference.diagnostics.memory!,
      admission = structuredClone(f.exportJob.detailAdmission!),
      retired = {
        ...admission,
        reservation: {
          ramBytes: admission.reservation.ramBytes + memory.outputs,
          vramBytes: admission.reservation.vramBytes,
        },
      },
      encoding = exportSdrEncodePlan(f.frame.width, f.frame.height, retired)
    Object.assign(admission.policy.ram, { effectiveBytes: encoding.total.ramBytes })
    let closed = false,
      earlyCalls = 0
    const makeGpu: typeof createExportGpu = async (...args) => {
      const converter = await createExportGpu(...args)
      expect(converter.hdrDeferred).toBe(true)
      return {
        ...converter,
        close: async () => {
          await converter.close()
          closed = true
        },
      }
    }
    process.env.IRODORI_EXPORT_BACKEND = 'gpu'
    const limited = await exportRenditions(
      {
        ...f.exportJob,
        directory: await f.directory('limited-encoding'),
        cropAdmission: admission,
        detailAdmission: admission,
      },
      makeGpu,
      async () => {
        earlyCalls++
        return Buffer.from('unexpected concurrent encoder')
      },
    )
    expect(limited.diagnostics.renderer).toBe('gpu')
    expect(limited.diagnostics.detail!.working!.preparation).toBe('retained')
    expect(limited.earlyPrimary).toBeUndefined()
    expect(earlyCalls).toBe(0)
    expect(closed).toBe(true)
    expect(exportSdrEncodePlan(f.frame.width, f.frame.height, retired).accepted).toBe(true)
    const encode = (rgb: Buffer) =>
        sharp(rgb, { raw: { width: f.frame.width, height: f.frame.height, channels: 3 } })
          .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
          .toBuffer(),
      encoded = await encode(limited.rgb)
    expect(encoded.byteLength).toBeLessThanOrEqual(encoding.outputLimitBytes)
    closed = false
    const normal = await exportRenditions(
      { ...f.exportJob, directory: await f.directory('concurrent-encoding') },
      makeGpu,
      async (rgb, _geometry, concurrent) => {
        earlyCalls++
        expect(closed).toBe(false)
        expect(concurrent!.vramBytes).toBeGreaterThan(admission.reservation.vramBytes)
        return encode(rgb)
      },
    )
    expect(earlyCalls).toBe(1)
    expect(closed).toBe(true)
    expect(await normal.earlyPrimary).toEqual(encoded)
    expect(normal.rgb).toEqual(limited.rgb)
    expect(normal.half).toEqual(limited.half)
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = previous
    await f.close()
  }
})
