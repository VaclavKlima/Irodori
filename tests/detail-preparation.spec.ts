import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  prepareDetailWorkingAsset,
  type DetailPreparationJob,
} from '../src/main/processing/detail-preparation'
import { PreviewProcess } from '../src/main/preview-process'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  neutralNoiseReduction,
  neutralDetailSharpening,
  spatialDetailTile,
  spatialDetailSourceBounds,
  SPATIAL_DETAIL_STAGE,
} from '../src/shared/spatial-detail'
import { DETAIL_GPU_BYTES } from '../src/shared/detail-resources'
import type { SpatialDetailGpu, DetailGpuJob } from '../src/main/gpu/spatial-detail'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import { workingAsset, sha } from './export.helpers'
import { detailWindow } from './spatial-detail.helpers'

async function fixture(width = 259, height = 131) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-detail-')),
    data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [
          x === 0 ? -0 : 0.2 + 0.015 * Math.sin(x * 0.63 + y),
          -0.01 + 0.006 * Math.cos(y * 0.91 - x),
          16 + 0.1 * Math.sin(x * 1.27 + y * 0.72),
          x === 0 ? 0 : x % 17 === 0 ? 0.5 : 1,
        ],
        (y * width + x) * 4,
      )
  const bytes = Buffer.from(data.buffer),
    asset = workingAsset(bytes, width, height),
    path = join(root, 'source.f32'),
    job: DetailPreparationJob = {
      asset,
      sourceIdentity: sha(Buffer.from('isolated native reference-WB/lens source')),
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
  await writeFile(path, bytes)
  return { root, data, bytes, path, job, close: () => rm(root, { recursive: true, force: true }) }
}

function canonicalTile(job: DetailGpuJob) {
  return spatialDetailTile(
    job.image,
    job.tile,
    job.source,
    compileNoiseReduction(job.noiseReduction),
    compileDetailSharpening(job.detailSharpening),
    job.primaries,
  )
}
function fakeGpu(
  render: SpatialDetailGpu['render'],
  close: SpatialDetailGpu['close'] = async () => {},
): SpatialDetailGpu {
  return {
    adapter: 'isolated-control-fixture',
    bytes: DETAIL_GPU_BYTES,
    allocatedBytes: DETAIL_GPU_BYTES,
    programCount: 3,
    precisionRecoveryTiles: 0,
    render,
    close,
  }
}

test('streamed combined processing and real Node dispatch retain hashes, snapshots, native seams and source bytes', async () => {
  const f = await fixture(),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const frozen = structuredClone(f.job),
      progress: number[] = [],
      output = join(f.root, 'detail.f32'),
      result = await prepareDetailWorkingAsset(
        f.path,
        f.job,
        output,
        new AbortController().signal,
        (value) => {
          progress.push(value.completedRows)
          Object.assign(f.job.noiseReduction, { luminance: 0 })
          Object.assign(f.job.asset, { sha256: '0'.repeat(64) })
        },
      )
    expect(progress).toEqual([64, 128, 131])
    expect(result).toMatchObject({
      backend: 'cpu',
      reused: false,
      cpuTiles: 6,
      gpuTiles: 0,
      maxSourceStrips: 3,
      sourceSha256: frozen.asset.sha256,
      sourceIdentity: frozen.sourceIdentity,
      stage: SPATIAL_DETAIL_STAGE,
      noiseReduction: frozen.noiseReduction,
      detailSharpening: frozen.detailSharpening,
    })
    const bytes = await readFile(output),
      expected = new Float32Array(f.data.length),
      noise = compileNoiseReduction(frozen.noiseReduction),
      sharp = compileDetailSharpening(frozen.detailSharpening)
    for (let x = 0; x < frozen.asset.width; x += 256) {
      const tile = {
          left: x,
          top: 0,
          width: Math.min(256, frozen.asset.width - x),
          height: frozen.asset.height,
        },
        bounds = spatialDetailSourceBounds(frozen.asset, tile, noise, sharp),
        pixels = spatialDetailTile(
          frozen.asset,
          tile,
          detailWindow(frozen.asset, f.data, bounds),
          noise,
          sharp,
          'rec2020',
        )
      for (let y = 0; y < tile.height; y++)
        expected.set(
          pixels.subarray(y * tile.width * 4, (y + 1) * tile.width * 4),
          (y * frozen.asset.width + x) * 4,
        )
    }
    expect(bytes.equals(Buffer.from(expected.buffer))).toBe(true)
    expect(result.asset.source).toEqual(frozen.asset.source)
    expect(result.asset.sha256).toBe(sha(bytes))
    let verified = 0
    for await (const strip of readHdrStrips(output, result.asset)) verified += strip.byteLength
    expect(verified).toBe(bytes.length)
    const dispatchJob = structuredClone(frozen),
      pending = worker.prepareDetail(
        f.path,
        join(f.root, 'worker.f32'),
        dispatchJob,
        new AbortController().signal,
      )
    Object.assign(dispatchJob.noiseReduction, { chroma: 0 })
    const dispatched = await pending
    expect(dispatched.key).toBe(result.key)
    expect(dispatched.asset).toEqual(result.asset)
    expect((await readFile(dispatched.path)).equals(bytes)).toBe(true)
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
  } finally {
    await worker.close()
    await f.close()
  }
})

test('automatic recovery drains the failed GPU owner before CPU work and preserves the same output', async () => {
  const f = await fixture(259, 3)
  try {
    const cpu = await prepareDetailWorkingAsset(
        f.path,
        f.job,
        join(f.root, 'cpu.f32'),
        new AbortController().signal,
      ),
      baseline = await readFile(cpu.path)
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
      output = join(f.root, 'recovered.f32'),
      pending = prepareDetailWorkingAsset(
        f.path,
        { ...f.job, backend: 'auto' },
        output,
        new AbortController().signal,
        undefined,
        () =>
          fakeGpu(
            async (job) => {
              if (++calls === 2) throw new Error('Synthetic GPU loss.')
              return canonicalTile(job)
            },
            async () => {
              entered()
              await hold
              retired = true
            },
          ),
      )
    await closing
    expect(retired).toBe(false)
    expect((await stat(output)).size).toBe(0)
    release()
    const result = await pending
    expect(retired).toBe(true)
    expect(result).toMatchObject({ backend: 'mixed', gpuTiles: 1, cpuTiles: 1 })
    expect(result.fallback).toContain('Synthetic GPU loss')
    expect((await readFile(result.path)).equals(baseline)).toBe(true)
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
  } finally {
    await f.close()
  }
})

test('whole-source digest failures and cancellation after a completed band remove only owned output', async () => {
  const f = await fixture(9, 131)
  try {
    const bad = structuredClone(f.job),
      output = join(f.root, 'damaged.f32')
    Object.assign(bad.asset, { sha256: '0'.repeat(64) })
    await expect(
      prepareDetailWorkingAsset(f.path, bad, output, new AbortController().signal),
    ).rejects.toThrow('Damaged HDR asset')
    await expect(stat(output)).rejects.toThrow()
    const controller = new AbortController(),
      cancelled = join(f.root, 'cancelled.f32')
    let completed = 0
    await expect(
      prepareDetailWorkingAsset(f.path, f.job, cancelled, controller.signal, async (value) => {
        completed = value.completedRows
        expect((await stat(cancelled)).size).toBeGreaterThan(0)
        controller.abort()
      }),
    ).rejects.toThrow()
    expect(completed).toBe(64)
    await expect(stat(cancelled)).rejects.toThrow()
    const existing = join(f.root, 'existing.f32'),
      original = Buffer.from('keep existing destination')
    await writeFile(existing, original)
    await expect(
      prepareDetailWorkingAsset(f.path, f.job, existing, new AbortController().signal),
    ).rejects.toThrow()
    expect(await readFile(existing)).toEqual(original)
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
  } finally {
    await f.close()
  }
})

test('admission precedes source I/O and GPU setup; identity reuses the previously validated source', async () => {
  const f = await fixture(5, 3)
  try {
    let attempted = 0
    const factory = () => {
        attempted++
        throw new Error('Unexpected device setup.')
      },
      denied = structuredClone(f.job),
      output = join(f.root, 'denied.f32')
    Object.assign(denied.policy.ram, { effectiveBytes: 1 })
    await expect(
      prepareDetailWorkingAsset(
        join(f.root, 'missing-source'),
        denied,
        output,
        new AbortController().signal,
        undefined,
        factory,
      ),
    ).rejects.toThrow('budgets')
    await expect(stat(output)).rejects.toThrow()
    const cpuOnly = structuredClone(f.job)
    Object.assign(cpuOnly.policy.vram, { effectiveBytes: 0 })
    const result = await prepareDetailWorkingAsset(
      f.path,
      { ...cpuOnly, backend: 'auto' },
      output,
      new AbortController().signal,
      undefined,
      factory,
    )
    expect(result.backend).toBe('cpu')
    expect(result.fallback).toContain('admission')
    const identity = await prepareDetailWorkingAsset(
      f.path,
      {
        ...denied,
        noiseReduction: neutralNoiseReduction,
        detailSharpening: neutralDetailSharpening,
        backend: 'gpu',
      },
      join(f.root, 'identity.f32'),
      new AbortController().signal,
      undefined,
      factory,
    )
    expect(identity).toMatchObject({
      reused: true,
      path: f.path,
      key: f.job.sourceIdentity,
      backend: 'identity',
      maxSourceStrips: 0,
    })
    expect(identity.memory).toBeUndefined()
    expect(attempted).toBe(0)
    await expect(stat(join(f.root, 'identity.f32'))).rejects.toThrow()
    const forced = join(f.root, 'forced.f32')
    await expect(
      prepareDetailWorkingAsset(
        f.path,
        { ...cpuOnly, backend: 'gpu' },
        forced,
        new AbortController().signal,
        undefined,
        factory,
      ),
    ).rejects.toThrow('budgets')
    await expect(stat(forced)).rejects.toThrow()
  } finally {
    await f.close()
  }
})

test('cache identity freezes native source provenance and active controls while ignoring bypassed controls and backend', async () => {
  const f = await fixture(5, 3)
  try {
    const base = { ...f.job, detailSharpening: neutralDetailSharpening },
      results = []
    for (const [i, job] of [
      base,
      {
        ...base,
        backend: 'auto' as const,
        detailSharpening: { ...neutralDetailSharpening, radius: 3, threshold: 0 },
      },
      { ...base, sourceIdentity: '1'.repeat(64) },
      { ...base, noiseReduction: { ...base.noiseReduction, chroma: 44 } },
    ].entries()) {
      results.push(
        await prepareDetailWorkingAsset(
          f.path,
          job,
          join(f.root, `${i}.f32`),
          new AbortController().signal,
          undefined,
          () => {
            throw new Error('Fixture CPU preference.')
          },
        ),
      )
    }
    expect(results[1].key).toBe(results[0].key)
    expect(results[2].key).not.toBe(results[0].key)
    expect(results[3].key).not.toBe(results[0].key)
    expect(results[0].noiseReduction).toEqual(base.noiseReduction)
  } finally {
    await f.close()
  }
})

test('real worker cancellation waits for derived-file cleanup and leaves the leased source unchanged', async () => {
  const f = await fixture(259, 2048),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const controller = new AbortController(),
      output = join(f.root, 'worker-cancelled.f32'),
      pending = worker.prepareDetail(f.path, output, f.job, controller.signal)
    await expect
      .poll(
        async () => {
          try {
            await stat(output)
            return true
          } catch {
            return false
          }
        },
        { intervals: [5, 10, 20], timeout: 7000 },
      )
      .toBe(true)
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    await expect(stat(output)).rejects.toThrow()
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
  } finally {
    await worker.close()
    await f.close()
  }
})

test('malformed backend pixels cannot publish a derived asset or overwrite another destination', async () => {
  const f = await fixture(5, 3)
  try {
    for (const mode of ['length', 'nonfinite', 'alpha', 'shared']) {
      const output = join(f.root, `invalid-${mode}.f32`)
      let closed = false
      await expect(
        prepareDetailWorkingAsset(
          f.path,
          { ...f.job, backend: 'gpu' },
          output,
          new AbortController().signal,
          undefined,
          () =>
            fakeGpu(
              async (job) => {
                const result = canonicalTile(job)
                if (mode === 'length') return result.subarray(0, 4)
                if (mode === 'nonfinite') result[4] = NaN
                if (mode === 'alpha') result[7] = 0.5
                if (mode === 'shared') {
                  const shared = new Float32Array(new SharedArrayBuffer(result.byteLength))
                  shared.set(result)
                  return shared
                }
                return result
              },
              async () => {
                closed = true
              },
            ),
        ),
      ).rejects.toThrow(/detail tile/)
      expect(closed).toBe(true)
      await expect(stat(output)).rejects.toThrow()
    }
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
  } finally {
    await f.close()
  }
})
