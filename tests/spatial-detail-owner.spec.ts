import { expect, test } from '@playwright/test'
import { createSpatialDetailGpu, type DetailGpuJob } from '../src/main/gpu/spatial-detail'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import { DETAIL_GPU_BYTES, detailMemoryPlan } from '../src/shared/detail-resources'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  neutralNoiseReduction,
  neutralDetailSharpening,
  spatialDetailTile,
  spatialDetailSourceBounds,
} from '../src/shared/spatial-detail'
import { detailWindow } from './spatial-detail.helpers'

function job(width = 23, height = 17): DetailGpuJob {
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [0.01 + x * 0.003, 0.02 + y * 0.002, 0.1 + Math.sin(x * y) * 0.01, (x + y) % 13 ? 1 : 0],
        (y * width + x) * 4,
      )
  return {
    image: { width, height },
    tile: { left: 0, top: 0, width, height },
    source: { left: 0, top: 0, width, height, data },
    noiseReduction: { version: 1, luminance: 50, chroma: 50 },
    detailSharpening: { version: 1, amount: 50, radius: 1, threshold: 50 },
    primaries: 'rec2020',
    admission: {
      policy: resolveResourcePolicy(
        { version: 1, ramMiB: 2048, vramMiB: 2048 },
        {
          ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
          gpu: { status: 'unknown', reason: 'adapter-unverified' },
        },
        1,
      ),
      reservation: { ramBytes: 0, vramBytes: 0 },
    },
  }
}
function expected(j: DetailGpuJob) {
  return spatialDetailTile(
    j.image,
    j.tile,
    j.source,
    compileNoiseReduction(j.noiseReduction),
    compileDetailSharpening(j.detailSharpening),
    j.primaries,
  )
}
function agree(actual: Float32Array, reference: Float32Array) {
  expect(actual.length).toBe(reference.length)
  let maximum = 0
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) expect(Object.is(actual[i], reference[i])).toBe(true)
    else
      maximum = Math.max(
        maximum,
        Math.abs(actual[i] - reference[i]) / (2e-6 + 2e-5 * Math.abs(reference[i])),
      )
  }
  expect(maximum).toBeLessThanOrEqual(1)
}

test('detail owner lazily prepares programs, keeps the combined intermediate on GPU, reuses bounded buffers and has exact tile seams', async () => {
  const owner = createSpatialDetailGpu(),
    j = job(),
    signal = new AbortController().signal
  try {
    const neutral = {
      ...j,
      noiseReduction: neutralNoiseReduction,
      detailSharpening: neutralDetailSharpening,
    }
    agree(await owner.render(neutral, signal), j.source.data)
    expect(owner.adapter).toBeUndefined()
    expect(owner.allocatedBytes).toBe(0)
    expect(owner.programCount).toBe(0)
    const onlyNoise = { ...j, detailSharpening: neutralDetailSharpening }
    agree(await owner.render(onlyNoise, signal), expected(onlyNoise))
    expect(owner.programCount).toBe(2)
    expect(owner.allocatedBytes).toBe(DETAIL_GPU_BYTES)
    const full = await owner.render(j, signal)
    agree(full, expected(j))
    expect(owner.programCount).toBe(3)
    const n = compileNoiseReduction(j.noiseReduction),
      s = compileDetailSharpening(j.detailSharpening),
      tiled = new Float32Array(full.length)
    for (let top = 0; top < j.image.height; top += 5)
      for (let left = 0; left < j.image.width; left += 7) {
        const tile = {
            left,
            top,
            width: Math.min(7, j.image.width - left),
            height: Math.min(5, j.image.height - top),
          },
          bounds = spatialDetailSourceBounds(j.image, tile, n, s),
          result = await owner.render(
            { ...j, tile, source: detailWindow(j.image, j.source.data, bounds) },
            signal,
          )
        for (let y = 0; y < tile.height; y++)
          tiled.set(
            result.subarray(y * tile.width * 4, (y + 1) * tile.width * 4),
            ((top + y) * j.image.width + left) * 4,
          )
        expect(owner.allocatedBytes).toBe(DETAIL_GPU_BYTES)
      }
    expect(new Uint32Array(tiled.buffer)).toEqual(new Uint32Array(full.buffer))
    expect(owner.programCount).toBe(3)
    expect(owner.precisionRecoveryTiles).toBe(0)
    const tight = structuredClone(neutral),
      plan = detailMemoryPlan(j.admission, true)
    Object.assign(tight.admission.policy.vram, { effectiveBytes: plan.gpu.vramBytes - 1 })
    await expect(owner.render(tight, signal)).rejects.toThrow('retained detail GPU buffers')
    expect(owner.allocatedBytes).toBe(DETAIL_GPU_BYTES)
  } finally {
    await owner.close()
  }
  expect(owner.allocatedBytes).toBe(0)
  await expect(owner.render(j, signal)).rejects.toThrow('unavailable')
})

test('frozen detail jobs survive caller mutation and close waits for the owned in-flight computation', async () => {
  const raw = new RawGpuRenderer()
  let entered!: () => void,
    resume!: () => void,
    closes = 0
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (resume = r)),
    owner = createSpatialDetailGpu(() => ({
      mergeDevice: async () => {
        entered()
        await gate
        return raw.mergeDevice()
      },
      close: () => {
        closes++
        raw.close()
      },
    })),
    j = job(9, 9),
    reference = expected(j)
  const work = owner.render(j, new AbortController().signal)
  try {
    await started
    j.source.data.fill(16)
    Object.assign(j.noiseReduction, { luminance: 0, chroma: 0 })
    Object.assign(j.detailSharpening, { amount: 0 })
    Object.assign(j.tile, { width: 1, height: 1 })
    await expect(owner.render(job(9, 9), new AbortController().signal)).rejects.toThrow('busy')
    let closed = false
    const closing = owner.close().then(() => (closed = true))
    await Promise.resolve()
    expect(closed).toBe(false)
    resume()
    agree(await work, reference)
    await closing
    expect(closes).toBe(1)
    expect(owner.allocatedBytes).toBe(0)
    expect(owner.close()).toBe(owner.close())
  } finally {
    resume()
    await work.catch(() => undefined)
    await owner.close()
  }
})

test('detail cancellation, budget rejection and tiny-alpha precision recovery preserve ownership without initializing unused GPU work', async () => {
  let creations = 0
  const owner = createSpatialDetailGpu(() => {
      creations++
      throw new Error('Unexpected GPU setup')
    }),
    j = job(9, 9)
  try {
    const tight = structuredClone(j),
      memory = detailMemoryPlan(tight.admission, true)
    Object.assign(tight.admission.policy.vram, { effectiveBytes: memory.gpu.vramBytes - 1 })
    await expect(owner.render(tight, new AbortController().signal)).rejects.toThrow('budgets')
    const abort = new AbortController()
    abort.abort(new Error('Cancelled detail test'))
    await expect(owner.render(j, abort.signal)).rejects.toThrow('Cancelled detail test')
    await expect(
      owner.render({ ...j, primaries: 'p3' as never }, new AbortController().signal),
    ).rejects.toThrow('primaries')
    await expect(
      owner.render(
        { ...j, detailSharpening: { ...j.detailSharpening, radius: 4 } },
        new AbortController().signal,
      ),
    ).rejects.toThrow('sharpening settings')
    for (let i = 3; i < j.source.data.length; i += 4) j.source.data[i] = 2 ** -80
    const result = await owner.render(j, new AbortController().signal)
    agree(result, expected(j))
    expect(result).not.toEqual(j.source.data)
    expect(creations).toBe(0)
    expect(owner.programCount).toBe(0)
    expect(owner.allocatedBytes).toBe(0)
    expect(owner.precisionRecoveryTiles).toBe(1)
  } finally {
    await owner.close()
  }
})

test('cancellation during device preparation allocates no image buffers and close retires the acquired device', async () => {
  const raw = new RawGpuRenderer(),
    abort = new AbortController()
  let entered!: () => void,
    resume!: () => void,
    closes = 0
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (resume = r)),
    owner = createSpatialDetailGpu(() => ({
      mergeDevice: async () => {
        const context = await raw.mergeDevice()
        entered()
        await gate
        return context
      },
      close: () => {
        closes++
        raw.close()
      },
    }))
  const work = owner.render(job(9, 9), abort.signal),
    rejected = expect(work).rejects.toThrow('Cancelled during device setup')
  try {
    await started
    abort.abort(new Error('Cancelled during device setup'))
    resume()
    await rejected
    expect(owner.allocatedBytes).toBe(0)
    expect(owner.programCount).toBe(0)
  } finally {
    resume()
    await work.catch(() => undefined)
    await owner.close()
  }
  expect(closes).toBe(1)
})
