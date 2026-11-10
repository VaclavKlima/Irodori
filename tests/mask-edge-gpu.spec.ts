/* eslint-disable no-empty-pattern -- Playwright requires destructured fixtures when only testInfo is used. */
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { prepareMaskEdgeCoverage } from '../src/main/mask-edges/gpu'
import { MaskEdgeProcess } from '../src/main/mask-edges/process'
import { neutralMaskColor, neutralMaskLight, type ResolvedMask } from '../src/shared/masks'
import { generatedMask } from './helpers/generated-mask'
import { referenceMaskEdges } from './helpers/mask-edge-reference'

const mask = (): ResolvedMask => ({
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Coverage',
  enabled: true,
  inverted: false,
  head: null,
  light: { ...neutralMaskLight },
  color: { ...neutralMaskColor },
  edge: { featherPx: 0, shiftPx: 0 },
  strokes: [],
})
const signal = () => new AbortController().signal

function compare(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.byteLength).toBe(expected.byteLength)
  let maximum = 0
  for (let index = 0; index < actual.length; index++)
    maximum = Math.max(maximum, Math.abs(actual[index] - expected[index]))
  // Float32 GPU accumulation may cross one R8 rounding boundary; no spatial approximation is allowed.
  expect(maximum).toBeLessThanOrEqual(1)
}

test('disk morphology and Gaussian feather preserve gray brush coverage across native strip boundaries', async () => {
  const width = 35,
    height = 273
  const pixels = Uint8Array.from({ length: width * height }, (_, index) => {
    const x = index % width,
      y = Math.floor(index / width)
    return x < 7 ? 255 : x < 23 && y % 17 < 13 ? 128 : 0
  })
  const local = mask()
  local.base = generatedMask(width, height, (x, y) => pixels[y * width + x])
  local.strokes = [
    {
      mode: 'subtract',
      radius: 0.22,
      feather: 0.8,
      points: [
        { x: 0.3, y: 0.45 },
        { x: 0.7, y: 0.53 },
      ],
    },
    { mode: 'add', radius: 0.14, feather: 0.6, points: [{ x: 0.82, y: 0.48 }] },
  ]
  const owner = new RawGpuRenderer()
  try {
    const { device, adapter } = await owner.mergeDevice()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
    for (const inverted of [false, true])
      for (const edge of [
        { featherPx: 0, shiftPx: 3 },
        { featherPx: 0, shiftPx: -4 },
        { featherPx: 3.5, shiftPx: 2 },
        { featherPx: 7, shiftPx: 0 },
      ]) {
        local.inverted = inverted
        local.edge = edge
        compare(
          await prepareMaskEdgeCoverage(device, local, width, height, signal()),
          referenceMaskEdges(local, width, height, pixels),
        )
      }
    expect(owner.failure).toBeUndefined()
  } finally {
    owner.close()
  }
})

test('maximum disk radius is circular and replicated borders preserve full and empty masks', async () => {
  const owner = new RawGpuRenderer()
  try {
    const { device } = await owner.mergeDevice()
    const local = mask(),
      width = 41,
      height = 41
    local.base = generatedMask(width, height, (x, y) => (x === 20 && y === 20 ? 255 : 0))
    local.edge = { featherPx: 0, shiftPx: 16 }
    const disk = await prepareMaskEdgeCoverage(device, local, width, height, signal())
    expect(disk).toEqual(
      Uint8Array.from({ length: width * height }, (_, index) => {
        const x = (index % width) - 20,
          y = Math.floor(index / width) - 20
        return x * x + y * y <= 256 ? 255 : 0
      }),
    )
    for (const value of [0, 255])
      for (const inverted of [false, true]) {
        local.base = generatedMask(9, 5, () => value)
        local.inverted = inverted
        local.edge = { featherPx: 64, shiftPx: value ? -16 : 16 }
        expect(await prepareMaskEdgeCoverage(device, local, 9, 5, signal())).toEqual(
          new Uint8Array(45).fill(inverted ? 255 - value : value),
        )
      }
    local.edge = { featherPx: 0.5, shiftPx: 0 }
    local.inverted = false
    local.base = generatedMask(9, 5, (x) => (x < 4 ? 255 : 0))
    compare(
      await prepareMaskEdgeCoverage(device, local, 9, 5, signal()),
      referenceMaskEdges(
        local,
        9,
        5,
        Uint8Array.from({ length: 45 }, (_, index) => (index % 9 < 4 ? 255 : 0)),
      ),
    )
  } finally {
    owner.close()
  }
})

test('isolated GPU worker publishes a native grayscale PNG and cancellation/timeout retire ownership before retry', async () => {
  test.setTimeout(45000)
  const directory = await mkdtemp(join(tmpdir(), 'irodori-mask-edge-gpu-'))
  const options = { workerPath: resolve('out/main/mask-edge-worker.js'), timeoutMs: 120000 }
  const process = new MaskEdgeProcess(options)
  const local = mask()
  local.base = generatedMask(27, 19, (x, y) => (x > 3 && x < 20 && y > 2 ? 255 : 0))
  local.edge = { featherPx: 3, shiftPx: -1 }
  const path = join(directory, 'coverage.png')
  try {
    const controller = new AbortController()
    const pending = process.prepare(local, 27, 19, 'cancelled', path, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/cancel/i)
    await expect(readFile(path)).rejects.toThrow()
    options.timeoutMs = 1
    await expect(process.prepare(local, 27, 19, 'timeout', path, signal())).rejects.toThrow(
      /timed out/,
    )
    await expect(readFile(path)).rejects.toThrow()
    options.timeoutMs = 120000
    const result = await process.prepare(local, 27, 19, 'confirmed', path, signal())
    const encoded = await readFile(path)
    expect(result).toMatchObject({
      key: 'confirmed',
      width: 27,
      height: 19,
      path,
      encodedBytes: encoded.length,
    })
    expect(result.hash).toBe(createHash('sha256').update(encoded).digest('hex'))
    expect(await sharp(encoded).metadata()).toMatchObject({
      format: 'png',
      width: 27,
      height: 19,
      channels: 1,
    })
    const decoded = await sharp(encoded)
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(decoded.info).toMatchObject({ width: 27, height: 19, channels: 1 })
    compare(
      decoded.data,
      referenceMaskEdges(
        local,
        27,
        19,
        Uint8Array.from({ length: 27 * 19 }, (_, index) =>
          index % 27 > 3 && index % 27 < 20 && Math.floor(index / 27) > 2 ? 255 : 0,
        ),
      ),
    )
  } finally {
    await process.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('20 MP maximum edge settings keep native strips bounded and reproduce cold and warm coverage', async ({}, info) => {
  test.setTimeout(120000)
  // Numeric workload only: these dimensions match the committed Sony RAW, but no photo pixels are decoded here.
  const width = 5496,
    height = 3672,
    local = mask()
  local.strokes = [{ mode: 'add', radius: 0.2, feather: 0, points: [{ x: 0.5, y: 0.5 }] }]
  local.edge = { shiftPx: 16, featherPx: 64 }
  const owner = new RawGpuRenderer()
  try {
    const { device, adapter } = await owner.mergeDevice()
    const run = async () => {
      const buffers: number[] = [],
        textures: { format: GPUTextureFormat; size: number[] }[] = []
      const observed = new Proxy(device, {
        get(target, property) {
          if (property === 'createBuffer')
            return (descriptor: GPUBufferDescriptor) => {
              buffers.push(descriptor.size)
              return target.createBuffer(descriptor)
            }
          if (property === 'createTexture')
            return (descriptor: GPUTextureDescriptor) => {
              textures.push({
                format: descriptor.format,
                size: Array.from(descriptor.size as Iterable<number>),
              })
              return target.createTexture(descriptor)
            }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const started = performance.now()
      const bytes = await prepareMaskEdgeCoverage(observed, local, width, height, signal())
      const elapsedMs = performance.now() - started
      expect(bytes.byteLength).toBe(width * height)
      expect(bytes[0]).toBe(0)
      expect(bytes[width - 1]).toBe(0)
      expect(bytes[bytes.length - width]).toBe(0)
      expect(bytes[bytes.length - 1]).toBe(0)
      expect(bytes[Math.floor(height / 2) * width + Math.floor(width / 2)]).toBe(255)
      const boundary = Math.floor(height / 2) * width + Math.floor(width / 2 + height * 0.2 + 16)
      expect(bytes[boundary]).toBeGreaterThan(100)
      expect(bytes[boundary]).toBeLessThan(160)
      const explicitGpuBytes =
        buffers.reduce((sum, value) => sum + value, 0) +
        textures.reduce((sum, texture) => {
          expect(texture.format).toBe('r8unorm')
          return sum + texture.size.reduce((product, value) => product * value, 1)
        }, 0)
      expect(explicitGpuBytes).toBeLessThan(64 * 1024 ** 2)
      return {
        elapsedMs,
        explicitGpuBytes,
        buffers,
        textures,
        hash: createHash('sha256').update(bytes).digest('hex'),
      }
    }
    const cold = await run(),
      warm = await run()
    expect(warm.hash).toBe(cold.hash)
    expect(owner.failure).toBeUndefined()
    const path = info.outputPath('mask-edge-20mp-qualification.json')
    await writeFile(
      path,
      JSON.stringify(
        {
          width,
          height,
          edge: local.edge,
          adapter,
          cold,
          warm,
          scope:
            'Numeric canonical coverage preparation and managed readback; excludes process startup and PNG encoding. Explicit GPU allocations exclude opaque driver heaps. This is not photographic quality or physical RAM/VRAM measurement.',
        },
        null,
        2,
      ),
    )
    await info.attach('mask-edge-20mp-qualification', { path, contentType: 'application/json' })
  } finally {
    owner.close()
  }
})
