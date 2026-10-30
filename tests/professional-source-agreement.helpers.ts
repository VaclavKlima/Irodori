import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { createSpatialDetailGpu } from '../src/main/gpu/spatial-detail'
import {
  prepareDetailWorkingAsset,
  type DetailPreparationJob,
  type DetailPreparationResult,
} from '../src/main/processing/detail-preparation'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import type { HdrWorkingAsset } from '../src/shared/hdr'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import { DETAIL_BAND_ROWS } from '../src/shared/detail-resources'
import { DETAIL_TILE_EDGE, SPATIAL_DETAIL_STAGE } from '../src/shared/spatial-detail'

export async function sourceAgreementHash(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}

export const sourceAgreementIdentity = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function sourceAgreementJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

/** Selected implementation/runtime provenance, separate from retained pixel hashes. */
export async function sourceAgreementCodeHashes(root: string) {
  const paths = [
    'package-lock.json',
    'src/main/preview-process.ts',
    'src/main/preview-engine.ts',
    'src/main/native-raw-executable.ts',
    'src/main/processing/detail-preparation.ts',
    'src/main/processing/detail-bands.ts',
    'src/main/processing/detail-identity.ts',
    'src/main/processing/hdr-processing.ts',
    'src/main/gpu/spatial-detail.ts',
    'src/shared/spatial-detail.ts',
    'src/shared/spatial-detail-wgsl.ts',
    'src/shared/compensated-scalar-wgsl.ts',
    'src/shared/color-model.ts',
    'src/shared/preview-frame.ts',
    'src/shared/detail-resources.ts',
    'src/shared/resource-policy.ts',
    'src/shared/hdr.ts',
    'tests/professional-source-agreement.helpers.ts',
    'tests/professional-source-agreement.spec.ts',
    'node_modules/webgpu/index.js',
    'node_modules/webgpu/package.json',
  ]
  const nodePlatform = process.platform === 'win32' ? 'win' : process.platform,
    dawnPlatform =
      process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`
  paths.push(
    `node_modules/node-${nodePlatform}-${process.arch}/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
  )
  const collect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile()) paths.push(path)
    }
  }
  await collect('out/main')
  await collect(`node_modules/webgpu/dist/${dawnPlatform}`)
  return Promise.all(
    paths.sort().map(async (path) => ({
      path,
      sha256: await sourceAgreementHash(join(root, path)),
    })),
  )
}

/** Compare all native-width strips; no ROI, resampling or display quantization. */
async function compareFullSource(
  sourcePath: string,
  source: HdrWorkingAsset,
  cpu: DetailPreparationResult,
  gpu: DetailPreparationResult,
) {
  const original = readHdrStrips(sourcePath, source),
    actual = readHdrStrips(gpu.path, gpu.asset)
  let pixels = 0,
    strips = 0,
    rgbMismatches = 0,
    alphaMismatches = 0,
    transparentMismatches = 0,
    nonFinite = 0,
    maximumRatio = 0,
    maximumAbsoluteError = 0,
    maximumAt: {
      x: number
      y: number
      channel: number
      expected: number
      actual: number
    } | null = null
  try {
    for await (const expected of readHdrStrips(cpu.path, cpu.asset)) {
      const [sourceStrip, gpuStrip] = await Promise.all([original.next(), actual.next()])
      if (sourceStrip.done || gpuStrip.done) throw new Error('Incomplete agreement source strips.')
      const input = sourceStrip.value,
        output = gpuStrip.value
      if (input.length !== expected.length || output.length !== expected.length)
        throw new Error('Mismatching agreement strip dimensions.')
      const sourceWords = new Uint32Array(input.buffer, input.byteOffset, input.length),
        cpuWords = new Uint32Array(expected.buffer, expected.byteOffset, expected.length),
        gpuWords = new Uint32Array(output.buffer, output.byteOffset, output.length)
      for (let i = 0; i < expected.length; i += 4) {
        if (cpuWords[i + 3] !== sourceWords[i + 3] || gpuWords[i + 3] !== sourceWords[i + 3])
          alphaMismatches++
        for (let channel = 0; channel < 3; channel++) {
          const reference = expected[i + channel],
            value = output[i + channel],
            error = Math.abs(value - reference),
            ratio = error / (2e-6 + 2e-5 * Math.abs(reference))
          if (!Number.isFinite(reference) || !Number.isFinite(value)) nonFinite++
          if (ratio > 1) rgbMismatches++
          if (ratio > maximumRatio) {
            maximumRatio = ratio
            const pixel = pixels + i / 4
            maximumAt = {
              x: pixel % source.width,
              y: Math.floor(pixel / source.width),
              channel,
              expected: reference,
              actual: value,
            }
          }
          maximumAbsoluteError = Math.max(maximumAbsoluteError, error)
          if (
            input[i + 3] === 0 &&
            (cpuWords[i + channel] !== sourceWords[i + channel] ||
              gpuWords[i + channel] !== sourceWords[i + channel])
          )
            transparentMismatches++
        }
      }
      pixels += expected.length / 4
      strips++
    }
    // Exhaust both independent readers to verify their whole-file hashes too.
    const tails = await Promise.all([original.next(), actual.next()])
    if (tails.some((tail) => !tail.done)) throw new Error('Unexpected agreement source strips.')
  } finally {
    await Promise.all([original.return(undefined), actual.return(undefined)])
  }
  return {
    pixels,
    rgbChannels: pixels * 3,
    strips,
    rows: pixels / source.width,
    rgbMismatches,
    alphaMismatches,
    transparentMismatches,
    nonFinite,
    maximumRatio,
    maximumAbsoluteError,
    maximumAt,
    bounds: { absolute: 2e-6, relative: 2e-5, alpha: 'bit-exact to source' },
  }
}

/** The CPU and GPU run their distinct production implementations on one immutable source. */
export async function verifyFullSourceDetail(
  root: string,
  sourcePath: string,
  asset: HdrWorkingAsset,
  sourceIdentity: string,
  signal: AbortSignal,
) {
  await mkdir(root, { recursive: true })
  const gpu = createSpatialDetailGpu(),
    job: DetailPreparationJob = {
      asset: structuredClone(asset),
      sourceIdentity,
      noiseReduction: { version: 1, luminance: 35, chroma: 45 },
      detailSharpening: { version: 1, amount: 40, radius: 1.2, threshold: 50 },
      backend: 'cpu',
      policy: resolveResourcePolicy(
        { version: 1, ramMiB: 2048, vramMiB: 2048 },
        {
          // No portable MemAvailable observation is claimed by this test.
          ram: { totalBytes: totalmem(), availableBytes: null },
          gpu: { status: 'unknown', reason: 'adapter-unverified' },
        },
        1,
      ),
      // The producer has exited; disk-backed strips have no retained frame owner.
      reservation: { ramBytes: 0, vramBytes: 0 },
    },
    frozen = JSON.stringify(job),
    started = performance.now()
  let cpu: DetailPreparationResult | undefined, result: DetailPreparationResult | undefined
  try {
    expect(await sourceAgreementHash(sourcePath)).toBe(asset.sha256)
    expect(asset.strips.length).toBe(Math.ceil(asset.height / DETAIL_BAND_ROWS))
    expect(asset.strips.length).toBeGreaterThan(3)
    await sourceAgreementJson(join(root, 'job.json'), job)
    const prepare = async (backend: 'cpu' | 'gpu') =>
      prepareDetailWorkingAsset(
        sourcePath,
        { ...job, backend },
        join(root, `${backend}.f32`),
        signal,
        (progress) =>
          sourceAgreementJson(join(root, 'progress.json'), {
            backend,
            ...progress,
            elapsedMs: performance.now() - started,
          }),
        () => gpu,
      )
    cpu = await prepare('cpu')
    await sourceAgreementJson(join(root, 'cpu.json'), cpu)
    result = await prepare('gpu')
    await sourceAgreementJson(join(root, 'gpu.json'), result)
    const metrics = await compareFullSource(sourcePath, asset, cpu, result),
      sourceAfter = await sourceAgreementHash(sourcePath),
      finalGpuAllocatedBytes = gpu.allocatedBytes,
      expectedTiles = Math.ceil(asset.width / DETAIL_TILE_EDGE) * asset.strips.length
    await sourceAgreementJson(join(root, 'agreement.json'), {
      source: {
        path: sourcePath,
        asset,
        sourceIdentity,
        sha256After: sourceAfter,
      },
      cpu,
      gpu: result,
      metrics,
      finalGpuAllocatedBytes,
      expectedTiles,
      elapsedMs: performance.now() - started,
      scope:
        'Whole native linear Rec.2020 source; active noise reduction and detail sharpening only.',
    })
    expect(JSON.stringify(job)).toBe(frozen)
    expect(sourceAfter).toBe(asset.sha256)
    expect(cpu.key).toBe(result.key)
    for (const value of [cpu, result]) {
      expect(value.reused).toBe(false)
      expect(value.stage).toBe(SPATIAL_DETAIL_STAGE)
      expect(value.maxSourceStrips).toBe(3)
      expect(value.asset.width).toBe(asset.width)
      expect(value.asset.height).toBe(asset.height)
      expect(value.asset.byteLength).toBe(asset.byteLength)
      expect(value.asset.source).toEqual(asset.source)
      expect(value.asset.whiteBalance).toEqual(asset.whiteBalance)
      expect(value.asset.sha256).not.toBe(asset.sha256)
    }
    expect(cpu).toMatchObject({
      backend: 'cpu',
      cpuTiles: expectedTiles,
      gpuTiles: 0,
    })
    expect(result).toMatchObject({
      backend: 'gpu',
      gpuTiles: expectedTiles,
      cpuTiles: 0,
      precisionRecoveryTiles: 0,
    })
    expect(result.adapter).toBeTruthy()
    expect(finalGpuAllocatedBytes).toBe(0)
    expect(metrics.pixels).toBe(asset.width * asset.height)
    expect(metrics.rows).toBe(asset.height)
    expect(metrics.strips).toBe(asset.strips.length)
    expect(metrics.rgbMismatches).toBe(0)
    expect(metrics.alphaMismatches).toBe(0)
    expect(metrics.transparentMismatches).toBe(0)
    expect(metrics.nonFinite).toBe(0)
    expect(metrics.maximumRatio).toBeLessThanOrEqual(1)
    return { cpu, gpu: result, metrics }
  } finally {
    try {
      await sourceAgreementJson(join(root, 'retirement.json'), {
        beforeCloseBytes: gpu.allocatedBytes,
        cpuCompleted: !!cpu,
        gpuCompleted: !!result,
        elapsedMs: performance.now() - started,
      })
    } finally {
      await gpu.close()
    }
  }
}
