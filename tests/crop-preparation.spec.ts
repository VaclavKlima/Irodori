import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PreviewProcess } from '../src/main/preview-process'
import {
  prepareCropWorkingAsset,
  type CropPreparationJob,
} from '../src/main/processing/crop-preparation'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { fitCrop, identityCrop } from '../src/shared/crop'
import { resampleCropTile } from '../src/shared/crop-filter'
import { CROP_COMPUTE_BYTES } from '../src/shared/crop-resources'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'
import { workingAsset } from './export.helpers'
import { expectFloatReference } from './spatial-reference'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-straighten-')),
    width = 521,
    height = 193,
    data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [x / 130 - 1, y / 70 - 0.5, 16 + ((x + y) % 11), x >= 260 && x < 263 ? 0.5 : 1],
        (y * width + x) * 4,
      )
  const bytes = Buffer.from(data.buffer),
    asset = workingAsset(bytes, width, height),
    path = join(root, 'source.f32')
  await writeFile(path, bytes)
  const job: CropPreparationJob = {
    asset,
    settings: fitCrop(asset, { ...identityCrop, angle: 4.23, width: 0.9, height: 0.8 }),
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
  }
  return { root, path, bytes, data, job, close: () => rm(root, { recursive: true, force: true }) }
}

test('bounded crop preparation and the real Node worker retain frozen geometry, native tile seams, hashes and originals', async () => {
  const f = await fixture(),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const original = structuredClone(f.job),
      progress: number[] = [],
      output = join(f.root, 'crop.f32'),
      result = await prepareCropWorkingAsset(
        f.path,
        f.job,
        output,
        new AbortController().signal,
        (value) => {
          if (value.phase === 'output') progress.push(value.completed)
          if (value.phase === 'source') Object.assign(f.job.settings, { angle: 0 })
        },
      )
    expect(result.backend).toBe('gpu')
    expect(result.gpuTiles).toBeGreaterThan(3)
    expect(result.cpuTiles).toBe(0)
    expect(progress).toEqual([64, 128, result.geometry.height])
    const bytes = await readFile(output),
      pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      source = {
        left: 0,
        top: 0,
        width: original.asset.width,
        height: original.asset.height,
        data: f.data,
      }
    for (const x of [0, 255, 256, result.geometry.width - 1])
      for (const y of [0, 63, 64, 127, 128, result.geometry.height - 1]) {
        const expected = resampleCropTile(
            result.geometry,
            { left: x, top: y, width: 1, height: 1 },
            source,
          ),
          offset = (y * result.geometry.width + x) * 4
        expectFloatReference(pixels.subarray(offset, offset + 4), expected)
      }
    let read = 0
    for await (const strip of readHdrStrips(output, result.asset)) read += strip.length
    expect(read).toBe(pixels.length)
    const dispatched = await worker.prepareCrop(
      f.path,
      join(f.root, 'worker.f32'),
      original,
      new AbortController().signal,
    )
    expect(dispatched.backend).toBe('gpu')
    expect(dispatched.asset).toEqual(result.asset)
    expect(await readFile(dispatched.path)).toEqual(bytes)
    expect(await readFile(f.path)).toEqual(f.bytes)
  } finally {
    await worker.close()
    await f.close()
  }
})

test('automatic GPU loss drains before rejection without publishing a CPU replacement', async () => {
  const f = await fixture()
  try {
    let calls = 0,
      retired = false,
      release!: () => void,
      entered!: () => void
    const closing = new Promise<void>((done) => {
        entered = done
      }),
      hold = new Promise<void>((done) => {
        release = done
      }),
      output = join(f.root, 'failed.f32')
    const pending = prepareCropWorkingAsset(
      f.path,
      { ...f.job, backend: 'auto' },
      output,
      new AbortController().signal,
      undefined,
      async () => ({
        adapter: 'synthetic-device-loss',
        bytes: CROP_COMPUTE_BYTES,
        precisionRecoveryTiles: 0,
        async render(geometry, tile, source) {
          if (++calls === 2) throw new Error('Synthetic GPU loss.')
          return resampleCropTile(geometry, tile, source)
        },
        async close() {
          entered()
          await hold
          retired = true
        },
      }),
    )
    const failed = expect(pending).rejects.toThrow('Synthetic GPU loss.')
    await closing
    expect(retired).toBe(false)
    release()
    await failed
    expect(retired).toBe(true)
    expect(calls).toBe(2)
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.path)).toEqual(f.bytes)
  } finally {
    await f.close()
  }
})

test('admission refuses unavailable GPU resources before creating an owner', async () => {
  const f = await fixture()
  try {
    const denied = structuredClone(f.job),
      output = join(f.root, 'denied.f32')
    Object.assign(denied.policy.ram, { effectiveBytes: 1 })
    let attempted = 0
    const unavailable = async () => {
      attempted++
      throw new Error('Unexpected GPU initialization.')
    }
    await expect(
      prepareCropWorkingAsset(
        f.path,
        { ...denied, backend: 'auto' },
        output,
        new AbortController().signal,
        undefined,
        unavailable,
      ),
    ).rejects.toThrow('managed image budgets')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    const cpu = structuredClone(f.job)
    Object.assign(cpu.policy.vram, { effectiveBytes: 0 })
    await expect(
      prepareCropWorkingAsset(
        f.path,
        { ...cpu, backend: 'auto' },
        output,
        new AbortController().signal,
        undefined,
        unavailable,
      ),
    ).rejects.toThrow('budgets')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(attempted).toBe(0)
    expect(await readFile(f.path)).toEqual(f.bytes)
  } finally {
    await f.close()
  }
})

test('cancellation, malformed GPU output and source damage remove only owned partial files', async () => {
  const f = await fixture()
  try {
    const output = join(f.root, 'unpublished.f32'),
      abort = new AbortController()
    await expect(
      prepareCropWorkingAsset(f.path, f.job, output, abort.signal, (value) => {
        if (value.phase === 'output') abort.abort(new Error('Crop cancelled after first band.'))
      }),
    ).rejects.toThrow('Crop cancelled')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      prepareCropWorkingAsset(
        f.path,
        { ...f.job, asset: { ...f.job.asset, sha256: '0'.repeat(64) } },
        output,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Damaged HDR')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      prepareCropWorkingAsset(
        f.path,
        { ...f.job, backend: 'gpu' },
        output,
        new AbortController().signal,
        undefined,
        async () => ({
          adapter: 'synthetic-malformed-fixture',
          bytes: CROP_COMPUTE_BYTES,
          precisionRecoveryTiles: 0,
          async render(_geometry, tile) {
            return new Float32Array(tile.width * tile.height * 4).fill(NaN)
          },
          async close() {},
        }),
      ),
    ).rejects.toThrow('Invalid crop tile pixels')
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    const sentinel = Buffer.from('Existing file: preserve exactly.')
    await writeFile(output, sentinel)
    await expect(
      prepareCropWorkingAsset(f.path, f.job, output, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(output)).toEqual(sentinel)
    expect(await readFile(f.path)).toEqual(f.bytes)
  } finally {
    await f.close()
  }
})
