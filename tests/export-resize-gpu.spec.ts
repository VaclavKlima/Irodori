import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { compileResizeGpu } from '../src/shared/export-resize-gpu'
import { createResizeGpu } from '../src/main/gpu/export-resize'
import { exportResizeGpuAllocation } from '../src/shared/export-resources'
import { cropAdmission } from './crop-frame.helpers'
import reference from './fixtures/export-resize-reference.json' with { type: 'json' }

test.beforeAll(async () => {
  expect(reference.generatorSha256).toBe(
    '1af35d37fd141a9b374d9d93e1d3b85905dc94cf57fe773af9f33725a4334214',
  )
  expect(
    createHash('sha256')
      .update(await readFile('scripts/research/export-resize-reference.py'))
      .digest('hex'),
  ).toBe(reference.generatorSha256)
  expect(reference.tolerance).toEqual({ absolute: 2e-6, relative: 2e-5 })
  expect(reference.cases.map((c) => c.name)).toEqual([
    'fractional-signed-hdr-pair',
    'one-pixel-width',
    'one-pixel-height',
    'legacy-reduction',
    'identity',
    'one-axis-identity',
    'constant',
  ])
})

for (const c of reference.cases) {
  test(`bounded GPU resize matches the frozen Decimal80 ${c.name} vector`, async () => {
    const plan = compileResizeGpu(
        c.width,
        c.height,
        c.outWidth,
        c.outHeight,
        c.channels as 1 | 3 | 6,
      ),
      source = new Float32Array(c.input),
      originalWords = new Uint32Array(source.buffer).slice(),
      rowLength = c.width * c.channels,
      rows: Float32Array[] = [],
      owner = plan.identity
        ? createResizeGpu(plan, undefined, () => {
            throw new Error('Identity resize must not initialize a GPU.')
          })
        : createResizeGpu(plan)
    for (let i = 0; i < source.length; i++) expect(Object.is(source[i], c.input[i])).toBe(true)
    expect(source.length).toBe(c.width * c.height * c.channels)
    expect(c.expected.length).toBe(c.outWidth * c.outHeight * c.channels)
    if (!plan.identity) {
      const admission = exportResizeGpuAllocation(
        c.width,
        c.height,
        c.outWidth,
        c.outHeight,
        c.channels,
        cropAdmission(),
      )
      expect(admission.accepted).toBe(true)
      expect(plan.gpuBytes).toBeLessThanOrEqual(admission.bytes.vramBytes)
      expect(plan.hostBytes).toBeLessThanOrEqual(admission.bytes.ramBytes)
    }
    expect(owner.adapter).toBeUndefined()
    expect(owner.allocatedBytes).toBe(0)
    try {
      await owner.run(
        async (index, signal) => {
          signal.throwIfAborted()
          expect(Number.isInteger(index) && index >= 0 && index < c.height).toBe(true)
          return source.slice(index * rowLength, (index + 1) * rowLength)
        },
        (data, y) => {
          expect(y).toBe(rows.length)
          expect(data).toBeInstanceOf(Float32Array)
          expect(data.length).toBe(c.outWidth * c.channels)
          expect(Array.from(data).every(Number.isFinite)).toBe(true)
          expect(owner.allocatedBytes).toBeLessThanOrEqual(plan.gpuBytes)
          rows.push(data.slice())
        },
        new AbortController().signal,
      )
      expect(rows.length).toBe(c.outHeight)
      const actual = new Float32Array(rows.flatMap((row) => Array.from(row)))
      let maximumToleranceRatio = 0
      for (let i = 0; i < actual.length; i++)
        maximumToleranceRatio = Math.max(
          maximumToleranceRatio,
          Math.abs(actual[i] - c.expected[i]) / (2e-6 + 2e-5 * Math.abs(c.expected[i])),
        )
      expect(maximumToleranceRatio).toBeLessThanOrEqual(1)
      if (plan.identity) {
        expect(new Uint32Array(actual.buffer)).toEqual(originalWords)
        expect(owner.adapter).toBeUndefined()
        expect(owner.allocatedBytes).toBe(0)
      } else {
        expect(owner.adapter).toBeTruthy()
        expect(owner.adapter).not.toMatch(/llvmpipe|swiftshader|software/i)
        test.info().annotations.push({ type: 'gpu-adapter', description: owner.adapter! })
      }
      if (c.name === 'constant')
        expect(Math.max(...actual.map((value) => Math.abs(value - source[0])))).toBeLessThan(2e-7)
      expect(owner.peakCachedRows).toBeLessThanOrEqual(plan.maxRows)
      expect(new Uint32Array(source.buffer)).toEqual(originalWords)
    } finally {
      await owner.close()
    }
    expect(owner.allocatedBytes).toBe(0)
  })
}

test('scalar GPU reduction retains the symmetric half-value used by legacy callers', async () => {
  const owner = createResizeGpu(compileResizeGpu(2, 1, 1, 1, 1)),
    source = new Float32Array([0, 1]),
    rows: number[] = []
  try {
    await owner.run(
      async () => source.slice(),
      (data, y) => {
        expect(y).toBe(0)
        expect(data.length).toBe(1)
        rows.push(data[0])
      },
      new AbortController().signal,
    )
    expect(rows).toHaveLength(1)
    expect(Math.abs(rows[0] - 0.5)).toBeLessThanOrEqual(2e-6 + 2e-5 * 0.5)
    expect(owner.adapter).toBeTruthy()
    expect(owner.peakCachedRows).toBeLessThanOrEqual(1)
    expect(Array.from(source)).toEqual([0, 1])
    test.info().annotations.push({ type: 'gpu-adapter', description: owner.adapter! })
  } finally {
    await owner.close()
  }
  expect(owner.allocatedBytes).toBe(0)
})

test('GPU resize preserves exact per-channel signed HDR constants without clipping', async () => {
  const plan = compileResizeGpu(2, 2, 7, 5, 6),
    pixel = new Float32Array([-1, 0, 0.18, 1, 8, 16]),
    source = new Float32Array(2 * 2 * 6),
    expected = new Float32Array(7 * 6),
    owner = createResizeGpu(plan)
  for (let i = 0; i < 4; i++) source.set(pixel, i * 6)
  for (let x = 0; x < 7; x++) expected.set(pixel, x * 6)
  const originalWords = new Uint32Array(source.buffer).slice(),
    expectedWords = new Uint32Array(expected.buffer)
  let rows = 0
  try {
    await owner.run(
      async (index) => source.slice(index * 12, (index + 1) * 12),
      (data, y) => {
        expect(y).toBe(rows++)
        expect(data.length).toBe(expected.length)
        expect(new Uint32Array(data.buffer, data.byteOffset, data.length)).toEqual(expectedWords)
      },
      new AbortController().signal,
    )
    expect(rows).toBe(5)
    expect(owner.adapter).toBeTruthy()
    expect(owner.peakCachedRows).toBeLessThanOrEqual(plan.maxRows)
    expect(new Uint32Array(source.buffer)).toEqual(originalWords)
    test.info().annotations.push({ type: 'gpu-adapter', description: owner.adapter! })
  } finally {
    await owner.close()
  }
  expect(owner.allocatedBytes).toBe(0)
})

test('hostile cross-axis GPU resize refuses its row-cache budget before device setup or source reads', async () => {
  const plan = compileResizeGpu(1, 32768, 32768, 1, 6),
    budget = 1024 ** 3
  expect(plan.gpuBytes).toBeGreaterThan(budget)
  let owner: ReturnType<typeof createResizeGpu> | undefined,
    creations = 0,
    reads = 0,
    writes = 0
  try {
    await expect(
      (async () => {
        owner = createResizeGpu(plan, budget, () => {
          creations++
          throw new Error('Unexpected hostile resize GPU setup.')
        })
        await owner.run(
          async () => {
            reads++
            return new Float32Array(6)
          },
          () => {
            writes++
          },
          new AbortController().signal,
        )
      })(),
    ).rejects.toThrow('admitted GPU storage budget')
    expect({ creations, reads, writes }).toEqual({ creations: 0, reads: 0, writes: 0 })
  } finally {
    await owner?.close()
  }
  expect(owner?.allocatedBytes ?? 0).toBe(0)
})

test('GPU resize refuses pre-aborted work and insufficient budget before reading or device setup', async () => {
  const plan = compileResizeGpu(5, 4, 9, 7, 6),
    controller = new AbortController(),
    reason = new Error('Cancelled before GPU resize setup.')
  let creations = 0,
    reads = 0,
    writes = 0
  const makeRenderer = () => {
      creations++
      throw new Error('Unexpected GPU resize setup.')
    },
    readRow = async () => {
      reads++
      throw new Error('Unexpected GPU resize source read.')
    },
    onRow = () => {
      writes++
    },
    aborted = createResizeGpu(plan, undefined, makeRenderer)
  controller.abort(reason)
  try {
    await expect(aborted.run(readRow, onRow, controller.signal)).rejects.toBe(reason)
  } finally {
    await aborted.close()
  }
  expect(aborted.allocatedBytes).toBe(0)
  let limited: ReturnType<typeof createResizeGpu> | undefined
  await expect(
    (async () => {
      limited = createResizeGpu(plan, plan.gpuBytes - 1, makeRenderer)
      try {
        await limited.run(readRow, onRow, new AbortController().signal)
      } finally {
        await limited.close()
      }
    })(),
  ).rejects.toThrow()
  expect(limited?.allocatedBytes ?? 0).toBe(0)
  expect({ creations, reads, writes }).toEqual({ creations: 0, reads: 0, writes: 0 })
})

test('GPU resize stops between output rows after cancellation and releases its owner', async () => {
  const c = reference.cases[0],
    plan = compileResizeGpu(c.width, c.height, c.outWidth, c.outHeight, 6),
    source = new Float32Array(c.input),
    originalWords = new Uint32Array(source.buffer).slice(),
    owner = createResizeGpu(plan),
    controller = new AbortController(),
    reason = new Error('Cancelled GPU resize after the first output row.')
  let publishedRows = 0,
    adapter: string | undefined
  try {
    await expect(
      owner.run(
        async (index, signal) => {
          signal.throwIfAborted()
          return source.slice(index * c.width * 6, (index + 1) * c.width * 6)
        },
        (data, y) => {
          expect(y).toBe(0)
          expect(data.length).toBe(c.outWidth * 6)
          adapter = owner.adapter
          publishedRows++
          controller.abort(reason)
        },
        controller.signal,
      ),
    ).rejects.toBe(reason)
    expect(publishedRows).toBe(1)
    expect(adapter).toBeTruthy()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter! })
    expect(owner.peakCachedRows).toBeLessThanOrEqual(plan.maxRows)
    expect(new Uint32Array(source.buffer)).toEqual(originalWords)
  } finally {
    await owner.close()
  }
  expect(owner.allocatedBytes).toBe(0)
})
