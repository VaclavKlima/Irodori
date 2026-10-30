import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareDetailWorkingAsset,
  type DetailPreparationJob,
} from '../src/main/processing/detail-preparation'
import { createSpatialDetailGpu } from '../src/main/gpu/spatial-detail'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { workingAsset, sha } from './export.helpers'
import { SPATIAL_DETAIL_STAGE } from '../src/shared/spatial-detail'

test('tiny real GPU strip preparation agrees with canonical CPU through native band halos and fenced retirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-detail-gpu-strips-')),
    width = 19,
    height = 131,
    data = new Float32Array(width * height * 4),
    gpu = createSpatialDetailGpu()
  try {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        data.set(
          [
            0.2 + 0.015 * Math.sin(x * 0.63 + y),
            -0.01 + 0.006 * Math.cos(y * 0.91 - x),
            16 + 0.1 * Math.sin(x * 1.27 + y * 0.72),
            x === 0 ? 0 : x % 17 === 0 ? 0.5 : 1,
          ],
          (y * width + x) * 4,
        )
    const source = Buffer.from(data.buffer),
      asset = workingAsset(source, width, height),
      sourcePath = join(root, 'source.f32'),
      job: DetailPreparationJob = {
        asset,
        sourceIdentity: sha(Buffer.from('isolated native GPU strip source')),
        noiseReduction: { version: 1, luminance: 35, chroma: 45 },
        detailSharpening: { version: 1, amount: 40, radius: 1.2, threshold: 50 },
        backend: 'cpu',
        policy: resolveResourcePolicy(
          { version: 1, ramMiB: 2048, vramMiB: 2048 },
          {
            ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
            gpu: { status: 'unknown', reason: 'adapter-unverified' },
          },
          1,
        ),
        reservation: { ramBytes: 0, vramBytes: 0 },
      }
    await writeFile(sourcePath, source)
    const cpu = await prepareDetailWorkingAsset(
        sourcePath,
        job,
        join(root, 'cpu.f32'),
        new AbortController().signal,
      ),
      result = await prepareDetailWorkingAsset(
        sourcePath,
        { ...job, backend: 'gpu' },
        join(root, 'gpu.f32'),
        new AbortController().signal,
        undefined,
        () => gpu,
      ),
      expectedBytes = await readFile(cpu.path),
      bytes = await readFile(result.path),
      expected = new Float32Array(
        expectedBytes.buffer,
        expectedBytes.byteOffset,
        expectedBytes.length / 4,
      ),
      actual = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
      actualWords = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
      sourceWords = new Uint32Array(source.buffer, source.byteOffset, source.length / 4)
    let maximumRatio = 0,
      exactAlpha = true,
      exactTransparent = true
    for (let i = 0; i < actual.length; i += 4) {
      exactAlpha &&= actualWords[i + 3] === sourceWords[i + 3]
      for (let c = 0; c < 3; c++) {
        maximumRatio = Math.max(
          maximumRatio,
          Math.abs(actual[i + c] - expected[i + c]) / (2e-6 + 2e-5 * Math.abs(expected[i + c])),
        )
        if (data[i + 3] === 0) exactTransparent &&= actualWords[i + c] === sourceWords[i + c]
      }
    }
    expect(maximumRatio).toBeLessThanOrEqual(1)
    expect(exactAlpha && exactTransparent).toBe(true)
    expect(result).toMatchObject({
      backend: 'gpu',
      gpuTiles: 3,
      cpuTiles: 0,
      precisionRecoveryTiles: 0,
      maxSourceStrips: 3,
      stage: SPATIAL_DETAIL_STAGE,
    })
    expect(result.adapter).toBeTruthy()
    expect(result.key).toBe(cpu.key)
    expect(result.asset.sha256).toBe(sha(bytes))
    let verified = 0
    for await (const strip of readHdrStrips(result.path, result.asset)) verified += strip.byteLength
    expect(verified).toBe(bytes.length)
    expect(gpu.allocatedBytes).toBe(0)
    expect((await readFile(sourcePath)).equals(source)).toBe(true)
  } finally {
    await gpu.close()
    await rm(root, { recursive: true, force: true })
  }
})
