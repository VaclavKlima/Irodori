import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  prepareCropWorkingAsset,
  type CropPreparationJob,
} from '../src/main/processing/crop-preparation'
import { fitCrop, identityCrop } from '../src/shared/crop'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'
import { workingAsset } from './export.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { cropFrame, cropAdmission } from './crop-frame.helpers'
import { noLensSettings } from '../src/shared/lens'
import { processingMetadata } from '../src/main/processing/metadata'
import { neutralAdjustments } from '../src/shared/adjustments'

test('the real preview worker prepares a native GPU HDR crop from a leased source without opening the RAW', async () => {
  const directory = test.info().outputPath('crop-preview'),
    frame = cropFrame(97, 131),
    bytes = Buffer.from(frame.data.buffer),
    source = join(directory, 'source.f32'),
    asset = workingAsset(bytes, frame.width, frame.height),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  await mkdir(directory)
  await writeFile(source, bytes)
  const output = join(directory, 'gpu')
  await mkdir(output)
  try {
    const settings = fitCrop(frame, { ...identityCrop, angle: 12.34, width: 0.7, height: 0.8 }),
      job = {
        ...cropAdmission(),
        asset: {
          path: source,
          width: frame.width,
          height: frame.height,
          byteLength: bytes.byteLength,
          sha256: asset.sha256,
          hdr: asset,
          transform: frame.transform,
        },
        settings,
        workingOnly: true,
        backend: 'gpu' as const,
        options: {
          metadata: processingMetadata({}, []),
          settings: noLensSettings,
          revision: 3,
          adjustments: { ...neutralAdjustments },
        },
      },
      actual = await worker.prepareCropPreview(
        join(directory, 'must-not-decode.ARW'),
        output,
        job,
        new AbortController().signal,
      ),
      expected = await prepareCropWorkingAsset(
        source,
        {
          ...cropAdmission(),
          asset,
          settings,
          backend: 'cpu',
        },
        join(directory, 'cpu.f32'),
        new AbortController().signal,
      )
    expect(actual.format).toBe('hdr-working')
    expect(actual.crop).toEqual(expected.geometry)
    expect(actual.settingsRevision).toBe(3)
    expect(actual.diagnostics?.backend).toBe('gpu')
    expect(actual.diagnostics?.adapter).toBeTruthy()
    expect(actual.linear?.hdr?.source).toEqual(asset.source)
    const gpuBytes = await readFile(join(output, 'linear.f32')),
      cpuBytes = await readFile(expected.path),
      gpu = new Float32Array(gpuBytes.buffer, gpuBytes.byteOffset, gpuBytes.byteLength / 4),
      cpu = new Float32Array(cpuBytes.buffer, cpuBytes.byteOffset, cpuBytes.byteLength / 4)
    let maximumRatio = 0
    expect(gpu.length).toBe(cpu.length)
    for (let i = 0; i < cpu.length; i++)
      maximumRatio = Math.max(
        maximumRatio,
        Math.abs(gpu[i] - cpu[i]) / (2e-6 + 2e-5 * Math.abs(cpu[i])),
      )
    expect(maximumRatio).toBeLessThanOrEqual(1)
    expect(await readFile(source)).toEqual(bytes)
  } finally {
    await worker.close(true)
  }
})

test('actual native GPU crop preparation and CPU fallback publish agreeing signed/HDR/alpha working assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-crop-gpu-'))
  try {
    const width = 97,
      height = 131,
      data = new Float32Array(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        data.set(
          [x / 23 - 1, y / 47 - 1, 16 + ((x + y) % 11), x < 48 ? 0.5 : 1],
          (y * width + x) * 4,
        )
    const bytes = Buffer.from(data.buffer),
      asset = workingAsset(bytes, width, height),
      source = join(root, 'source.f32')
    await writeFile(source, bytes)
    const job: CropPreparationJob = {
        asset,
        settings: fitCrop(asset, { ...identityCrop, angle: 12.34, width: 0.7, height: 0.8 }),
        backend: 'gpu',
        policy: resolveResourcePolicy(
          DEFAULT_RESOURCE_SETTINGS,
          {
            ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 },
            gpu: { status: 'unknown', reason: 'unavailable' },
          },
          1,
        ),
        reservation: { ramBytes: 0, vramBytes: 0 },
      },
      gpu = await prepareCropWorkingAsset(
        source,
        job,
        join(root, 'gpu.f32'),
        new AbortController().signal,
      ),
      cpu = await prepareCropWorkingAsset(
        source,
        { ...job, backend: 'cpu' },
        join(root, 'cpu.f32'),
        new AbortController().signal,
      )
    expect(gpu.backend).toBe('gpu')
    expect(gpu.gpuTiles).toBeGreaterThan(1)
    expect(gpu.cpuTiles).toBe(0)
    expect(gpu.adapter).toBeTruthy()
    expect(gpu.fallback).toBeUndefined()
    expect(cpu.backend).toBe('cpu')
    expect(gpu.geometry).toEqual(cpu.geometry)
    const actualBytes = await readFile(gpu.path),
      expectedBytes = await readFile(cpu.path),
      actual = new Float32Array(
        actualBytes.buffer,
        actualBytes.byteOffset,
        actualBytes.byteLength / 4,
      ),
      expected = new Float32Array(
        expectedBytes.buffer,
        expectedBytes.byteOffset,
        expectedBytes.byteLength / 4,
      )
    let maximumRatio = 0,
      nonfinite = 0
    for (let i = 0; i < expected.length; i++) {
      if (!Number.isFinite(actual[i])) nonfinite++
      maximumRatio = Math.max(
        maximumRatio,
        Math.abs(actual[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i])),
      )
    }
    expect(expected.length).toBeGreaterThan(20000)
    expect(nonfinite).toBe(0)
    expect(maximumRatio).toBeLessThanOrEqual(1)
    expect(await readFile(source)).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
