import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { LinearFrame } from '../src/main/processing/contracts'
import { correctionPlan, type CorrectionPlan } from '../src/main/processing/lens-correction'
import { unavailableProfile } from '../src/main/processing/metadata'
import type { CpuKernelMeasurement } from '../src/main/merge/cpu-kernels'
import type { Plane } from '../src/main/merge/math'
import {
  createGpuReferenceFallback,
  gpuReferenceFallbackBytes,
} from '../src/main/merge/gpu-reference-fallback'
import { REC2020_LUMA, SRGB_TO_2020 } from '../src/shared/hdr'
import { automaticLensSettings, type LensProfile } from '../src/shared/lens'
import { GPU_REFERENCE_PREPARATION, MERGE_LIMITS } from '../src/shared/merge'

type Converter = Awaited<ReturnType<typeof createGpuReferenceFallback>>
type Options = NonNullable<Parameters<typeof createGpuReferenceFallback>[8]>
interface Fixture {
  frame: LinearFrame
  plan: CorrectionPlan
  saturated: Uint8Array<ArrayBuffer>
  gains: number[]
  width: number
  height: number
}
interface Reference {
  rgba: Float32Array<ArrayBuffer>
  luma: Float64Array<ArrayBuffer>
  plane: Plane
}

const minimumSignal = MERGE_LIMITS.readNoise * 3
const lens: LensProfile = {
  provider: 'independent-gpu-reference-test',
  version: '1',
  label: 'Fractional reference-fallback fixture',
  identity: 'independent-gpu-reference-lens-v1',
  distortion: { radii: [0, 0.5, 1], values: [1, 1.025, 1.075] },
  vignetting: { radii: [0, 0.5, 1], values: [1, 1.2, 1.7] },
  chromaticAberration: {
    red: { radii: [0, 0.5, 1], values: [1, 0.997, 0.993] },
    blue: { radii: [0, 0.5, 1], values: [1, 1.004, 1.011] },
  },
  unavailable: {},
}
const digest = (values: ArrayBufferView) =>
  createHash('sha256')
    .update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
    .digest('hex')

function fixture(flip = 0, corrected = false): Fixture {
  const nativeWidth = 97,
    nativeHeight = 149,
    data = new Float32Array(nativeWidth * nativeHeight * 4),
    saturated = new Uint8Array(nativeWidth * nativeHeight)
  for (let y = 0; y < nativeHeight; y++)
    for (let x = 0; x < nativeWidth; x++) {
      const at = (y * nativeWidth + x) * 4
      data[at] = x < 7 && y < 13 ? -0.125 : 0.02 + ((x * 11 + y * 7) % 83) / 29
      data[at + 1] = 0.04 + (y / nativeHeight) * 1.4
      data[at + 2] = x > nativeWidth - 6 ? -0.0625 : 0.03 + (x / nativeWidth) * 1.8
      // Source padding does not determine reference-fallback validity.
      data[at + 3] = (x + y) % 5 ? 0.25 : 0
    }
  // This is the already dilated union, including sites attributable to each CFA channel.
  for (const [cx, cy] of [
    [0, 0],
    [1, 1],
    [48, 63],
    [49, 64],
    [nativeWidth - 1, nativeHeight - 1],
  ])
    for (let y = Math.max(0, cy - 2); y <= Math.min(nativeHeight - 1, cy + 2); y++)
      for (let x = Math.max(0, cx - 2); x <= Math.min(nativeWidth - 1, cx + 2); x++)
        saturated[y * nativeWidth + x] = 1
  const frame: LinearFrame = {
      width: nativeWidth,
      height: nativeHeight,
      flip,
      data,
      matrix: [1.8, -0.6, -0.2, 0, -0.1, 1.2, -0.1, 0, -0.1, -0.6, 1.7, 0],
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 4095,
        gains: [2, 1, 1.5, 1],
        restoreGain: 2,
        referenceWhite: 1,
        sourceSaturation: {
          thresholds: [3800, 3700, 3900, 3600],
          saturatedSites: 5,
          totalSites: nativeWidth * nativeHeight,
        },
      },
    },
    plan = correctionPlan(
      nativeWidth,
      nativeHeight,
      corrected ? lens : unavailableProfile,
      automaticLensSettings,
    )
  return {
    frame,
    plan,
    saturated,
    gains: [1.75, 1, 1.375, 1],
    width: flip & 4 ? plan.height : plan.width,
    height: flip & 4 ? plan.width : plan.height,
  }
}

function lookup(lut: Float32Array, radius: number, channel: number) {
  const last = lut.length / 4 - 1,
    position = Math.max(0, Math.min(last, radius * last)),
    first = Math.min(last - 1, Math.floor(position)),
    fraction = position - first
  return lut[first * 4 + channel] * (1 - fraction) + lut[(first + 1) * 4 + channel] * fraction
}

/** Build source-to-cell overlaps independently of the maintained flattened tables. */
function footprints(native: number, reduced: number) {
  const cells = Array.from({ length: native }, () => [] as [number, number][]),
    scale = native / reduced
  for (let cell = 0; cell < reduced; cell++)
    for (
      let source = Math.floor(cell * scale);
      source < Math.min(native, Math.ceil((cell + 1) * scale));
      source++
    ) {
      const weight = Math.min(source + 1, (cell + 1) * scale) - Math.max(source, cell * scale)
      if (weight > 1e-10) cells[source].push([cell, weight])
    }
  return cells
}

/** The legacy fallback recipe rounds luma sums to Float32 after every ordered update. */
function reduce(
  width: number,
  height: number,
  rgba: Float32Array,
  luma: Float64Array,
  reduced: { width: number; height: number },
): Plane {
  const xs = footprints(width, reduced.width),
    ys = footprints(height, reduced.height),
    totals = new Float64Array(reduced.width * reduced.height),
    counts = new Float64Array(totals.length),
    sums = new Float32Array(totals.length)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x
      for (const [px, wx] of xs[x])
        for (const [py, wy] of ys[y]) {
          const at = py * reduced.width + px,
            weight = wx * wy
          totals[at] += weight
          if (rgba[pixel * 4 + 3] && luma[pixel] > minimumSignal) {
            counts[at] += weight
            sums[at] += luma[pixel] * weight
          }
        }
    }
  const mask = Uint8Array.from(counts, (count, i) =>
      count > 0 && Math.abs(count - totals[i]) < 1e-8 ? 255 : 0,
    ),
    data = Float32Array.from(sums, (sum, i) => (mask[i] ? sum / counts[i] : 0))
  return { width: reduced.width, height: reduced.height, data, mask }
}

/** Original Float64 RGB and pre-Float32 luminance, with no production geometry or conversion. */
function reference(data: Fixture, reduced = { width: 11, height: 7 }): Reference {
  const { frame, plan, saturated, gains, width, height } = data,
    rgba = new Float32Array(width * height * 4),
    luma = new Float64Array(width * height),
    cx = (frame.width - 1) / 2,
    cy = (frame.height - 1) / 2,
    radius = Math.hypot(cx, cy),
    maximumGain = Math.max(...frame.normalization!.gains),
    minimumGain = Math.min(...gains)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sx = frame.flip & 4 ? y : x,
        sy = frame.flip & 4 ? x : y
      if (frame.flip & 1) sx = plan.width - 1 - sx
      if (frame.flip & 2) sy = plan.height - 1 - sy
      const qx = sx + plan.left - cx,
        qy = sy + plan.top - cy,
        r = Math.hypot(qx, qy) / radius,
        camera = [0, 0, 0],
        rgb = [0, 0, 0]
      let clipped = false
      for (let c = 0; c < 3; c++) {
        const scale = lookup(plan.lut, r, c),
          px = cx + qx * scale,
          py = cy + qy * scale,
          ix = Math.floor(px),
          iy = Math.floor(py),
          dx = px - ix,
          dy = py - iy
        let value = 0
        for (let yy = 0; yy < 2; yy++)
          for (let xx = 0; xx < 2; xx++) {
            const tx = Math.max(0, Math.min(frame.width - 1, ix + xx)),
              ty = Math.max(0, Math.min(frame.height - 1, iy + yy)),
              weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy),
              gain = lookup(plan.lut, Math.hypot(tx - cx, ty - cy) / radius, 3)
            value += frame.data[(ty * frame.width + tx) * 4 + c] * weight * gain
            if (weight > 0 && saturated[ty * frame.width + tx]) clipped = true
          }
        camera[c] =
          (((value * maximumGain) / frame.normalization!.gains[c]) * gains[c]) / minimumGain
      }
      const red =
          frame.matrix[0] * camera[0] + frame.matrix[1] * camera[1] + frame.matrix[2] * camera[2],
        green =
          frame.matrix[4] * camera[0] + frame.matrix[5] * camera[1] + frame.matrix[6] * camera[2],
        blue =
          frame.matrix[8] * camera[0] + frame.matrix[9] * camera[1] + frame.matrix[10] * camera[2],
        pixel = y * width + x
      for (let c = 0; c < 3; c++) {
        rgb[c] =
          SRGB_TO_2020[c * 3] * red +
          SRGB_TO_2020[c * 3 + 1] * green +
          SRGB_TO_2020[c * 3 + 2] * blue
        rgba[pixel * 4 + c] = rgb[c]
      }
      rgba[pixel * 4 + 3] = Number(!clipped)
      luma[pixel] = Math.max(
        0,
        rgb[0] * REC2020_LUMA[0] + rgb[1] * REC2020_LUMA[1] + rgb[2] * REC2020_LUMA[2],
      )
    }
  return { rgba, luma, plane: reduce(width, height, rgba, luma, reduced) }
}

function assertSamples(
  expected: Float32Array | Float64Array,
  actual: Float32Array | Float64Array,
  alpha = false,
) {
  expect(actual.length).toBe(expected.length)
  let maximumRatio = 0,
    alphaMismatches = 0,
    nonfinite = 0
  for (let i = 0; i < expected.length; i++) {
    if (alpha && i % 4 === 3) {
      alphaMismatches += Number(actual[i] !== expected[i])
      continue
    }
    if (!Number.isFinite(actual[i])) nonfinite++
    else
      maximumRatio = Math.max(
        maximumRatio,
        Math.abs(actual[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i])),
      )
  }
  expect(nonfinite).toBe(0)
  expect(alphaMismatches).toBe(0)
  expect(maximumRatio).toBeLessThanOrEqual(1)
}

let retainedGpu: GPU | undefined
async function hardware() {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter({ powerPreference: 'high-performance' })
  test.skip(
    !adapter || adapter.info.isFallbackAdapter,
    'Native hardware Dawn is required for reference fallback agreement.',
  )
  const device = await adapter!.requestDevice({
    requiredLimits: {
      maxBufferSize: Math.min(1024 ** 3, adapter!.limits.maxBufferSize),
      maxStorageBufferBindingSize: Math.min(1024 ** 3, adapter!.limits.maxStorageBufferBindingSize),
    },
  })
  return {
    device,
    close() {
      device.destroy()
      retainedGpu = undefined
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

/** Native resources reach Dawn unchanged; only ownership and injected host failures are observed. */
function trackedDevice(
  actual: GPUDevice,
  options: {
    failAllocationAt?: number
    failedMap?: boolean
    failedMapAt?: number
    truncatedReadback?: boolean
    limits?: Partial<Record<keyof GPUSupportedLimits, number>>
  } = {},
) {
  const resources: {
    resource: GPUBuffer | GPUTexture
    destroyed: number
    bytes: number
    mappedAtDestroy: boolean
  }[] = []
  let deviceDestroys = 0,
    mapCalls = 0
  const own = <T extends GPUBuffer | GPUTexture>(resource: T, bytes: number) => {
    const entry = { resource, destroyed: 0, bytes, mappedAtDestroy: false },
      destroy = resource.destroy.bind(resource)
    resources.push(entry)
    Object.defineProperty(resource, 'destroy', {
      value: () => {
        entry.destroyed++
        entry.mappedAtDestroy ||= 'mapState' in resource && resource.mapState !== 'unmapped'
        destroy()
      },
    })
    return resource
  }
  const limits = new Proxy(actual.limits, {
    get(target, key) {
      if (key in (options.limits ?? {})) return options.limits![key as keyof GPUSupportedLimits]
      return Reflect.get(target, key, target)
    },
  })
  const device = new Proxy(actual, {
    get(target, key) {
      if (key === 'limits') return limits
      if (key === 'destroy')
        return () => {
          deviceDestroys++
          actual.destroy()
        }
      if (key === 'createBuffer')
        return (descriptor: GPUBufferDescriptor) => {
          if (options.failAllocationAt === resources.length + 1)
            throw new Error('Injected reference GPU allocation failure.')
          const buffer = own(actual.createBuffer(descriptor), Number(descriptor.size))
          if (descriptor.usage & GPUBufferUsage.MAP_READ) {
            if (options.failedMap || options.failedMapAt) {
              const map = buffer.mapAsync.bind(buffer)
              Object.defineProperty(buffer, 'mapAsync', {
                value: (...args: Parameters<GPUBuffer['mapAsync']>) => {
                  mapCalls++
                  if (options.failedMap || mapCalls === options.failedMapAt)
                    return Promise.reject(new Error('Injected reference GPU map failure.'))
                  return map(...args)
                },
              })
            }
            if (options.truncatedReadback) {
              const mapped = buffer.getMappedRange.bind(buffer)
              Object.defineProperty(buffer, 'getMappedRange', {
                value: (...args: Parameters<GPUBuffer['getMappedRange']>) => {
                  const range = mapped(...args)
                  return range.slice(0, range.byteLength - 4)
                },
              })
            }
          }
          return buffer
        }
      if (key === 'createTexture')
        return (descriptor: GPUTextureDescriptor) => {
          if (options.failAllocationAt === resources.length + 1)
            throw new Error('Injected reference GPU allocation failure.')
          const texture = actual.createTexture(descriptor)
          return own(
            texture,
            texture.width *
              texture.height *
              texture.depthOrArrayLayers *
              (descriptor.format === 'r32float' || descriptor.format === 'r32uint' ? 4 : 16),
          )
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    device,
    resources,
    assertReleased() {
      for (const resource of resources) {
        expect(resource.destroyed).toBe(1)
        expect(resource.mappedAtDestroy).toBe(false)
      }
      expect(deviceDestroys).toBe(0)
    },
  }
}

function createConverter(
  data: Fixture,
  device: GPUDevice,
  options?: Options,
  reduced = { width: 11, height: 7 },
  measurement?: CpuKernelMeasurement,
) {
  return createGpuReferenceFallback(
    device,
    data.frame,
    data.plan,
    data.saturated,
    data.gains,
    reduced,
    async () => {},
    measurement,
    options,
  )
}

async function convertAll(converter: Converter, rows = 64) {
  const rgba = new Float32Array(converter.width * converter.height * 4),
    luma = new Float64Array(converter.width * converter.height)
  for (let top = 0; top < converter.height; top += rows) {
    const part = await converter.convert(top, Math.min(rows, converter.height - top))
    rgba.set(part.rgba, top * converter.width * 4)
    luma.set(part.luma, top * converter.width)
    converter.reduction?.add(top, part.rgba, part.luma)
  }
  return { rgba, luma, plane: converter.reduction?.finish()[0] }
}

function assertReference(actual: Awaited<ReturnType<typeof convertAll>>, expected: Reference) {
  assertSamples(expected.rgba, actual.rgba, true)
  assertSamples(expected.luma, actual.luma)
  expect(actual.plane).toBeDefined()
  expect(actual.plane!.mask).toEqual(expected.plane.mask)
  assertSamples(expected.plane.data, actual.plane!.data)
}

for (const corrected of [false, true])
  for (let flip = 0; flip < 8; flip++)
    test(`GPU reference fallback agrees with original CPU RGB and luma for orientation ${flip}, lens ${corrected ? 'on' : 'off'}`, async () => {
      test.setTimeout(120000)
      const context = await hardware(),
        tracked = trackedDevice(context.device),
        data = fixture(flip, corrected),
        expected = reference(data),
        measurement: CpuKernelMeasurement = {
          backend: 'scalar',
          heapBytes: 0,
          copyMs: 0,
          processingMs: 0,
        },
        before = {
          frame: digest(data.frame.data),
          mask: digest(data.saturated),
          lut: digest(data.plan.lut),
          matrix: [...data.frame.matrix],
          gains: [...data.gains],
        }
      let converter: Converter | undefined
      try {
        expect(expected.rgba.some((value, i) => i % 4 !== 3 && value < 0)).toBe(true)
        expect(expected.rgba.some((value, i) => i % 4 === 3 && value === 0)).toBe(true)
        expect(expected.plane.mask!.some((value) => value === 255)).toBe(true)
        converter = await createConverter(
          data,
          tracked.device,
          undefined,
          { width: 11, height: 7 },
          measurement,
        )
        expect([converter.width, converter.height]).toEqual([data.width, data.height])
        const rows = flip % 2 ? 23 : 64
        assertReference(await convertAll(converter, rows), expected)
        expect(converter.metrics.backend).toBe('gpu')
        expect(converter.metrics.policy).toBe(GPU_REFERENCE_PREPARATION)
        expect(measurement.heapBytes).toBeLessThanOrEqual(128 * 1024 ** 2)
        expect(converter.metrics.batches).toBe(Math.ceil(data.height / rows))
        expect(converter.metrics.inputBytes).toBe(data.frame.data.byteLength)
        expect(converter.metrics.geometryBytes).toBe(data.width * data.height * 72)
        expect(converter.metrics.outputBytes).toBe(data.width * data.height * 32)
        expect(converter.metrics.allocatedGpuBytes).toBe(
          gpuReferenceFallbackBytes(data.frame.width, data.frame.height, data.width, data.height),
        )
        expect(tracked.resources.reduce((bytes, resource) => bytes + resource.bytes, 0)).toBe(
          converter.metrics.allocatedGpuBytes,
        )
        expect(converter.metrics.allocatedGpuBytes).toBeLessThanOrEqual(1024 ** 3)
        await converter.close()
        await converter.close()
        await expect(converter.convert(0, 1)).rejects.toThrow(/closed/i)
        tracked.assertReleased()
        expect(digest(data.frame.data)).toBe(before.frame)
        expect(digest(data.saturated)).toBe(before.mask)
        expect(digest(data.plan.lut)).toBe(before.lut)
        expect(data.frame.matrix).toEqual(before.matrix)
        expect(data.gains).toEqual(before.gains)
        await context.device.queue.onSubmittedWorkDone()
      } finally {
        await converter?.close()
        context.close()
      }
    })

test('GPU reference geometry prefetch preserves borrowed validity and discards nonmatching requests', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(0, false),
    expected = reference(data),
    before = { frame: digest(data.frame.data), mask: digest(data.saturated) }
  let sequential: Converter | undefined, interrupted: Converter | undefined
  try {
    expect(data.height).toBe(149)
    for (const [x, y] of [
      [48, 63],
      [49, 64],
    ])
      expect(expected.rgba[(y * data.width + x) * 4 + 3]).toBe(0)
    for (const y of [63, 64]) expect(expected.rgba[(y * data.width + 60) * 4 + 3]).toBe(1)
    sequential = await createConverter(data, tracked.device)
    assertReference(await convertAll(sequential, 64), expected)
    expect(sequential.metrics.prefetchedStrips).toBeGreaterThan(0)
    expect(sequential.metrics.prefetchedStrips).toBe(1)
    expect(sequential.metrics.discardedPrefetches).toBe(0)
    expect(sequential.metrics.batches).toBe(3)
    expect(sequential.metrics.geometryBytes).toBe(data.width * data.height * 72)
    expect(sequential.metrics.outputBytes).toBe(data.width * data.height * 32)
    await sequential.close()

    const firstResource = tracked.resources.length,
      rgba = new Float32Array(expected.rgba.length),
      luma = new Float64Array(expected.luma.length)
    interrupted = await createConverter(data, tracked.device)
    const preserve = (top: number, part: Awaited<ReturnType<Converter['convert']>>) => {
      const first = top * data.width,
        last = first + part.luma.length
      assertSamples(expected.rgba.subarray(first * 4, last * 4), part.rgba, true)
      assertSamples(expected.luma.subarray(first, last), part.luma)
      // Both output views expire on the next convert; copy before the deliberate probe.
      rgba.set(part.rgba, first * 4)
      luma.set(part.luma, first)
      interrupted!.reduction!.add(top, part.rgba, part.luma)
    }
    preserve(0, await interrupted.convert(0, 64))
    expect(interrupted.metrics.prefetchedStrips).toBe(1)
    expect(interrupted.metrics.discardedPrefetches).toBe(0)
    const probe = await interrupted.convert(65, 17),
      first = 65 * data.width,
      last = 82 * data.width
    assertSamples(expected.rgba.subarray(first * 4, last * 4), probe.rgba, true)
    assertSamples(expected.luma.subarray(first, last), probe.luma)
    expect(interrupted.metrics.discardedPrefetches).toBe(1)
    // Restore the ordered consumer stream after discarding the borrowed 64-row prefetch.
    preserve(64, await interrupted.convert(64, 64))
    preserve(128, await interrupted.convert(128, 21))
    assertReference({ rgba, luma, plane: interrupted.reduction!.finish()[0] }, expected)
    expect(interrupted.metrics.batches).toBe(4)
    expect(interrupted.metrics.prefetchedStrips).toBe(1)
    expect(interrupted.metrics.discardedPrefetches).toBe(1)
    expect(interrupted.metrics.prefetchedStrips).toBeLessThan(interrupted.metrics.batches)
    expect(interrupted.metrics.inputBytes).toBe(data.frame.data.byteLength)
    expect(interrupted.metrics.geometryBytes).toBe(data.width * (data.height + 17) * 72)
    expect(interrupted.metrics.outputBytes).toBe(data.width * (data.height + 17) * 32)
    expect(interrupted.metrics.allocatedGpuBytes).toBe(
      gpuReferenceFallbackBytes(data.frame.width, data.frame.height, data.width, data.height),
    )
    expect(
      tracked.resources.slice(firstResource).reduce((bytes, resource) => bytes + resource.bytes, 0),
    ).toBe(interrupted.metrics.allocatedGpuBytes)
    await interrupted.close()
    await interrupted.close()
    await expect(interrupted.convert(64, 1)).rejects.toThrow(/closed/i)
    tracked.assertReleased()
    expect(digest(data.frame.data)).toBe(before.frame)
    expect(digest(data.saturated)).toBe(before.mask)
    await context.device.queue.onSubmittedWorkDone()
  } finally {
    await interrupted?.close()
    await sequential?.close()
    context.close()
  }
})

test('GPU reference fallback retains exact union validity from every channel footprint', async () => {
  const context = await hardware(),
    data = fixture(6, false),
    scales = [0.8, 1, 1.2]
  for (let i = 0; i < data.plan.lut.length; i += 4) data.plan.lut.set([...scales, 1], i)
  const x = 7,
    y = 11,
    cx = (data.frame.width - 1) / 2,
    cy = (data.frame.height - 1) / 2
  let sx = data.frame.flip & 4 ? y : x,
    sy = data.frame.flip & 4 ? x : y
  if (data.frame.flip & 1) sx = data.plan.width - 1 - sx
  if (data.frame.flip & 2) sy = data.plan.height - 1 - sy
  const taps = scales.map((scale) => {
    const px = cx + (sx + data.plan.left - cx) * scale,
      py = cy + (sy + data.plan.top - cy) * scale,
      ix = Math.floor(px),
      iy = Math.floor(py),
      dx = px - ix,
      dy = py - iy,
      result = new Set<number>()
    for (let yy = 0; yy < 2; yy++)
      for (let xx = 0; xx < 2; xx++)
        if ((xx ? dx : 1 - dx) * (yy ? dy : 1 - dy) > 0) {
          const tx = Math.max(0, Math.min(data.frame.width - 1, ix + xx)),
            ty = Math.max(0, Math.min(data.frame.height - 1, iy + yy))
          result.add(ty * data.frame.width + tx)
        }
    return result
  })
  try {
    for (let channel = 0; channel < 3; channel++) {
      const unique = [...taps[channel]].find((site) =>
        taps.every((other, c) => c === channel || !other.has(site)),
      )
      expect(unique).toBeDefined()
      data.saturated.fill(0)
      data.saturated[unique!] = 1
      const tracked = trackedDevice(context.device),
        expected = reference(data)
      let converter: Converter | undefined
      try {
        expect(expected.rgba[(y * data.width + x) * 4 + 3]).toBe(0)
        converter = await createConverter(data, tracked.device)
        assertReference(await convertAll(converter), expected)
        await converter.close()
        tracked.assertReleased()
      } finally {
        await converter?.close()
      }
    }
  } finally {
    context.close()
  }
})

for (const offset of [-1e-15, 1e-15])
  test(`GPU reference fallback preserves the pre-Float32 luma threshold ${offset < 0 ? 'below' : 'above'} read noise`, async () => {
    const context = await hardware(),
      tracked = trackedDevice(context.device),
      data = fixture(0, false)
    data.saturated.fill(0)
    for (let i = 0; i < data.frame.data.length; i += 4) {
      data.frame.data[i] = 0.001
      data.frame.data[i + 1] = 0.7
      data.frame.data[i + 2] = -0.2
    }
    data.frame.matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
    data.frame.normalization!.gains = [1, 1, 1, 1]
    data.gains = [(minimumSignal + offset) / data.frame.data[0], 1, 1, 1]
    const expected = reference(data),
      roundedLuma =
        expected.rgba[0] * REC2020_LUMA[0] +
        expected.rgba[1] * REC2020_LUMA[1] +
        expected.rgba[2] * REC2020_LUMA[2]
    let converter: Converter | undefined
    try {
      expect(expected.luma.every((value) => value > minimumSignal === offset > 0)).toBe(true)
      expect(expected.plane.mask!.every((value) => value === (offset > 0 ? 255 : 0))).toBe(true)
      if (offset > 0) expect(roundedLuma).toBeLessThanOrEqual(minimumSignal)
      converter = await createConverter(data, tracked.device)
      const actual = await convertAll(converter, 31)
      assertReference(actual, expected)
      expect(actual.luma.every((value) => value > minimumSignal === offset > 0)).toBe(true)
      expect(converter.metrics.thresholdRepairs).toBeGreaterThan(0)
      await converter.close()
      tracked.assertReleased()
    } finally {
      await converter?.close()
      context.close()
    }
  })

test('GPU reference fallback repairs cancellation-sensitive color matrices without losing signed samples', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(3, false)
  data.saturated.fill(0)
  data.frame.normalization!.gains = [1, 1, 1, 1]
  data.gains = [1, 1, 1, 1]
  data.frame.matrix = [1_000_000.5, -1_000_000, 0, 0, 1_000_000, -999_999.75, 0, 0, 0, 0, 1, 0]
  for (let i = 0; i < data.frame.data.length; i += 4) {
    data.frame.data[i] = data.frame.data[i + 1] = 0.125 + ((i / 4) % 7) / 16
    data.frame.data[i + 2] = -0.0625
  }
  const expected = reference(data)
  let converter: Converter | undefined
  try {
    expect(expected.rgba.some((value, i) => i % 4 !== 3 && value < 0)).toBe(true)
    converter = await createConverter(data, tracked.device)
    assertReference(await convertAll(converter), expected)
    expect(converter.metrics.conditionRepairs).toBeGreaterThan(0)
    await converter.close()
    tracked.assertReleased()
  } finally {
    await converter?.close()
    context.close()
  }
})

test('GPU reference fallback includes the fourth CFA gain in canonical normalization extrema', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(5, true)
  data.frame.normalization!.gains[3] = 3.25
  data.gains[3] = 0.625
  const expected = reference(data)
  let converter: Converter | undefined
  try {
    converter = await createConverter(data, tracked.device)
    assertReference(await convertAll(converter, 29), expected)
    await converter.close()
    tracked.assertReleased()
  } finally {
    await converter?.close()
    context.close()
  }
})

test('GPU reference fallback keeps native alpha and fractional reductions with the scalar geometry planner', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(5, true),
    previous = process.env.LUMA_MERGE_CPU_KERNEL,
    measurement: CpuKernelMeasurement = {
      backend: 'scalar',
      heapBytes: 0,
      copyMs: 0,
      processingMs: 0,
    }
  let converter: Converter | undefined
  try {
    process.env.LUMA_MERGE_CPU_KERNEL = 'scalar'
    converter = await createConverter(
      data,
      tracked.device,
      undefined,
      { width: 11, height: 7 },
      measurement,
    )
    assertReference(await convertAll(converter, 17), reference(data))
    expect(measurement.backend).toBe('scalar')
    expect(measurement.heapBytes).toBe(0)
    await converter.close()
    tracked.assertReleased()
  } finally {
    try {
      await converter?.close()
    } finally {
      if (previous === undefined) delete process.env.LUMA_MERGE_CPU_KERNEL
      else process.env.LUMA_MERGE_CPU_KERNEL = previous
      context.close()
    }
  }
})

for (const phase of [
  'allocated',
  'uploaded-source',
  'uploaded-geometry',
  'submitted',
  'readback',
] as const)
  test(`GPU reference fallback cancellation at ${phase} preserves its reason and releases only owned resources`, async () => {
    const context = await hardware(),
      tracked = trackedDevice(context.device),
      data = fixture(7, true),
      before = digest(data.frame.data),
      controller = new AbortController(),
      reason = new Error(`Reference cancelled at ${phase}.`)
    let converter: Converter | undefined,
      reached = 0
    try {
      await expect(
        (async () => {
          converter = await createConverter(data, tracked.device, {
            signal: controller.signal,
            hooks: {
              checkpoint(event) {
                if (event.phase !== phase || reached) return
                reached++
                controller.abort(reason)
              },
            },
          })
          await convertAll(converter)
        })(),
      ).rejects.toBe(reason)
      expect(reached).toBe(1)
      await converter?.close()
      await converter?.close()
      tracked.assertReleased()
      expect(digest(data.frame.data)).toBe(before)
      await context.device.queue.onSubmittedWorkDone()
    } finally {
      await converter?.close()
      context.close()
    }
  })

for (const fault of [
  'map failure',
  'truncated readback',
  'nonfinite high value',
  'nonfinite low value',
  'invalid repair flag',
  'invalid error bound',
] as const)
  test(`GPU reference fallback rejects ${fault}, drains readback, and leaves original CPU input intact`, async () => {
    const context = await hardware(),
      tracked = trackedDevice(context.device, {
        failedMapAt: fault === 'map failure' ? 2 : undefined,
        truncatedReadback: fault === 'truncated readback',
      }),
      data = fixture(0, true),
      before = digest(data.frame.data),
      expected = reference(data)
    let converter: Converter | undefined,
      corruptions = 0
    try {
      converter = await createConverter(data, tracked.device, {
        hooks: {
          readback(top, values) {
            if (top !== 64) return
            if (fault === 'nonfinite high value') {
              values[0] = Infinity
              corruptions++
            }
            if (fault === 'nonfinite low value') {
              values[4] = NaN
              corruptions++
            }
            if (fault === 'invalid repair flag') {
              values[3] = 2
              corruptions++
            }
            if (fault === 'invalid error bound') {
              values[7] = -1
              corruptions++
            }
          },
        },
      })
      await expect(convertAll(converter)).rejects.toThrow()
      await expect(converter.convert(0, 1)).rejects.toThrow()
      await converter.close()
      await converter.close()
      if (fault !== 'map failure' && fault !== 'truncated readback') expect(corruptions).toBe(1)
      tracked.assertReleased()
      expect(digest(data.frame.data)).toBe(before)
      expect(reference(data)).toEqual(expected)
      await context.device.queue.onSubmittedWorkDone()
    } finally {
      await converter?.close()
      context.close()
    }
  })

test('GPU reference device loss after a completed strip rejects further output and drains all owned resources', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(0, true),
    before = digest(data.frame.data),
    expected = reference(data)
  let converter: Converter | undefined, lost: GPUDeviceLostInfo | undefined
  try {
    converter = await createConverter(data, tracked.device, {
      hooks: {
        async checkpoint(event) {
          if (event.phase !== 'submitted' || event.top !== 64) return
          context.device.destroy()
          lost = await context.device.lost
        },
      },
    })
    const first = await converter.convert(0, 64)
    assertSamples(expected.rgba.subarray(0, data.width * 64 * 4), first.rgba, true)
    assertSamples(expected.luma.subarray(0, data.width * 64), first.luma)
    await expect(converter.convert(64, Math.min(64, data.height - 64))).rejects.toThrow(
      /device lost/i,
    )
    await converter.close()
    expect(lost?.reason).toBe('destroyed')
    tracked.assertReleased()
    expect(digest(data.frame.data)).toBe(before)
    expect(reference(data)).toEqual(expected)
  } finally {
    await converter?.close()
    context.close()
  }
})

test('concurrent GPU reference conversion is rejected without corrupting the admitted strip', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(0, false),
    expected = reference(data),
    entered = deferred<void>(),
    resume = deferred<void>()
  let converter: Converter | undefined
  try {
    converter = await createConverter(data, tracked.device, {
      hooks: {
        async checkpoint(event) {
          if (event.phase === 'submitted' && event.top === 0) {
            entered.resolve()
            await resume.promise
          }
        },
      },
    })
    const first = converter.convert(0, 64)
    void first.catch(() => undefined)
    await entered.promise
    await expect(converter.convert(0, 64)).rejects.toThrow(/concurrent/i)
    resume.resolve()
    const firstStrip = await first
    assertSamples(expected.rgba.subarray(0, data.width * 64 * 4), firstStrip.rgba, true)
    assertSamples(expected.luma.subarray(0, data.width * 64), firstStrip.luma)
    for (let top = 64; top < data.height; top += 64) {
      const rows = Math.min(64, data.height - top),
        part = await converter.convert(top, rows)
      assertSamples(
        expected.rgba.subarray(top * data.width * 4, (top + rows) * data.width * 4),
        part.rgba,
        true,
      )
      assertSamples(expected.luma.subarray(top * data.width, (top + rows) * data.width), part.luma)
    }
    await converter.close()
    tracked.assertReleased()
  } finally {
    resume.resolve()
    await converter?.close()
    context.close()
  }
})

test('closing an active GPU reference conversion waits for submitted work before destroying resources', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(),
    entered = deferred<void>(),
    resume = deferred<void>()
  let converter: Converter | undefined
  try {
    converter = await createConverter(data, tracked.device, {
      hooks: {
        async checkpoint(event) {
          if (event.phase === 'submitted' && event.top === 0) {
            entered.resolve()
            await resume.promise
          }
        },
      },
    })
    const active = converter.convert(0, 64)
    void active.catch(() => undefined)
    await entered.promise
    const closing = converter.close()
    expect(tracked.resources.length).toBeGreaterThan(0)
    expect(tracked.resources.every((resource) => resource.destroyed === 0)).toBe(true)
    resume.resolve()
    await expect(active).rejects.toThrow(/closed/i)
    await closing
    await converter.close()
    tracked.assertReleased()
    await context.device.queue.onSubmittedWorkDone()
  } finally {
    resume.resolve()
    await converter?.close()
    context.close()
  }
})

test('GPU reference preflight enforces the available memory and caller cancellation before allocation', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    data = fixture(5, true),
    bytes = gpuReferenceFallbackBytes(data.frame.width, data.frame.height, data.width, data.height)
  try {
    await expect(
      createConverter(data, tracked.device, { availableBytes: bytes - 1 }),
    ).rejects.toThrow(/memory budget/i)
    expect(tracked.resources).toEqual([])
    const controller = new AbortController(),
      reason = new Error('Reference cancelled before setup.')
    controller.abort(reason)
    await expect(createConverter(data, tracked.device, { signal: controller.signal })).rejects.toBe(
      reason,
    )
    expect(tracked.resources).toEqual([])
    expect(() => gpuReferenceFallbackBytes(0, 1, 1, 1)).toThrow()
    expect(() => gpuReferenceFallbackBytes(Number.MAX_SAFE_INTEGER, 2, 1, 1)).toThrow()
    const oversized = {
      ...data,
      frame: { ...data.frame, flip: 0 },
      plan: { ...data.plan, width: 24_000_000, height: 1 },
    }
    expect(
      gpuReferenceFallbackBytes(data.frame.width, data.frame.height, 24_000_000, 1),
    ).toBeGreaterThan(1024 ** 3)
    await expect(
      createConverter(oversized, tracked.device, { availableBytes: 4 * 1024 ** 3 }),
    ).rejects.toThrow(/memory budget/i)
    expect(tracked.resources).toEqual([])
    tracked.assertReleased()
  } finally {
    context.close()
  }
})

test('GPU reference setup enforces native device limits before creating resources', async () => {
  const context = await hardware(),
    data = fixture(0, true)
  try {
    for (const limits of [
      { maxBufferSize: 128 },
      { maxStorageBufferBindingSize: 128 },
      { maxUniformBufferBindingSize: 32 },
      { maxTextureDimension2D: 32 },
      { maxTextureArrayLayers: 1 },
      { maxComputeWorkgroupsPerDimension: 1 },
      { maxComputeInvocationsPerWorkgroup: 1 },
      { maxComputeWorkgroupSizeX: 1 },
    ]) {
      const tracked = trackedDevice(context.device, { limits })
      await expect(createConverter(data, tracked.device)).rejects.toThrow(/device limits/i)
      expect(tracked.resources).toEqual([])
      tracked.assertReleased()
    }
  } finally {
    context.close()
  }
})

for (const failAllocationAt of [1, 3, 5])
  test(`GPU reference partial setup releases preceding resources when allocation ${failAllocationAt} fails`, async () => {
    const context = await hardware(),
      tracked = trackedDevice(context.device, { failAllocationAt }),
      data = fixture(7, true),
      before = digest(data.frame.data)
    try {
      await expect(createConverter(data, tracked.device)).rejects.toThrow(
        'Injected reference GPU allocation failure.',
      )
      expect(tracked.resources.length).toBe(failAllocationAt - 1)
      tracked.assertReleased()
      expect(digest(data.frame.data)).toBe(before)
      await context.device.queue.onSubmittedWorkDone()
    } finally {
      context.close()
    }
  })
