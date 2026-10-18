import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream, promises as filesystem } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import type { RawSource } from '../src/main/gpu/raw-source'
import {
  gpuCameraRegistrationBytes,
  gpuCameraRegistrationWriter,
} from '../src/main/merge/gpu-camera-registration'
import {
  cameraRegistrationWriter,
  type CameraRegistration,
} from '../src/main/merge/camera-registration'
import type { Plane } from '../src/main/merge/math'
import { prepareSource } from '../src/main/merge/prepare'
import { mergePreparation } from '../src/main/merge/preparation-policy'
import { PreviewEngine } from '../src/main/preview-engine'
import { correctionPlan } from '../src/main/processing/lens-correction'
import { unavailableProfile } from '../src/main/processing/metadata'
import { REC2020_TO_SRGB, SRGB_TO_2020 } from '../src/shared/hdr'
import { automaticLensSettings, type LensProfile } from '../src/shared/lens'
import {
  GPU_CAMERA_PREPARATION,
  MERGE_LIMITS,
  type MergeSettings,
  type MergeSource,
} from '../src/shared/merge'

type Writer = Awaited<ReturnType<typeof gpuCameraRegistrationWriter>>
type Options = Parameters<typeof gpuCameraRegistrationWriter>[6]
const minimumSignal = MERGE_LIMITS.readNoise * 3
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const nativeBytes = (values: Float32Array) =>
  Buffer.from(values.buffer, values.byteOffset, values.byteLength)
const lens: LensProfile = {
  provider: 'independent-gpu-preparation-test',
  version: '1',
  label: 'Fractional clipping and chromatic aberration fixture',
  identity: 'independent-gpu-preparation-lens-v1',
  distortion: { radii: [0, 0.5, 1], values: [1, 1.02, 1.06] },
  vignetting: { radii: [0, 0.5, 1], values: [1, 1.2, 1.6] },
  chromaticAberration: {
    red: { radii: [0, 0.5, 1], values: [1, 0.998, 0.995] },
    blue: { radii: [0, 0.5, 1], values: [1, 1.003, 1.008] },
  },
  unavailable: {},
}

function cameraMatrix(raw: RawSource) {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3),
      column = index % 3
    return (
      SRGB_TO_2020[row * 3] * raw.matrix[column] +
      SRGB_TO_2020[row * 3 + 1] * raw.matrix[4 + column] +
      SRGB_TO_2020[row * 3 + 2] * raw.matrix[8 + column]
    )
  })
}

/** Elimination is independent of the production cofactor inversion. */
function inverseMatrix(matrix: number[]) {
  const rows = Array.from({ length: 3 }, (_, row) => [
    ...matrix.slice(row * 3, row * 3 + 3),
    ...Array.from({ length: 3 }, (_, column) => Number(row === column)),
  ])
  for (let column = 0; column < 3; column++) {
    let pivot = column
    for (let row = column + 1; row < 3; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    if (Math.abs(rows[pivot][column]) < 1e-12) throw new Error('Singular independent fixture.')
    const previous = rows[column]
    rows[column] = rows[pivot]
    rows[pivot] = previous
    const divisor = rows[column][column]
    for (let i = 0; i < 6; i++) rows[column][i] /= divisor
    for (let row = 0; row < 3; row++) {
      if (row === column) continue
      const scale = rows[row][column]
      for (let i = 0; i < 6; i++) rows[row][i] -= scale * rows[column][i]
    }
  }
  return rows.flatMap((row) => row.slice(3))
}

function nearThreshold() {
  const words = new Uint32Array(new Float32Array([minimumSignal]).buffer),
    rounded = new Float32Array(words.buffer)[0]
  if (rounded > minimumSignal) words[0]--
  const below = new Float32Array(words.buffer)[0]
  words[0]++
  return [below, new Float32Array(words.buffer)[0]]
}

function input(flip: number, corrected: boolean, threshold = false) {
  const width = threshold ? 17 : 139,
    height = 277,
    rawWidth = width + 7,
    pixels = new Uint16Array(rawWidth * (height + 3)).fill(1200),
    raw: RawSource = {
      width,
      height,
      rawWidth,
      left: 3,
      top: 2,
      flip,
      pixels,
      cfa: [0, 1, 3, 2],
      black: [0, 0, 0, 0],
      scale: [1, 1, 1, 1],
      matrix: threshold
        ? [0, 1, 2].flatMap((row) => [...REC2020_TO_SRGB.slice(row * 3, row * 3 + 3), 0])
        : [1.8, -0.6, -0.2, 0, -0.1, 1.2, -0.1, 0, -0.1, -0.6, 1.7, 0],
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 4095,
        gains: [2, 1, 1.5, 1],
        restoreGain: 2,
        referenceWhite: 1,
        sourceSaturation: {
          thresholds: [3800, 3700, 3900, 3600],
          saturatedSites: 0,
          totalSites: width * height,
        },
      },
    }
  if (!threshold)
    for (const [x, y, offset] of [
      [0, 0, 0],
      [1, 0, 1],
      [0, 1, 0],
      [1, 1, -1],
      [68, 63, 0],
      [69, 63, 1],
      [68, 64, -1],
      [69, 64, 0],
      [width - 2, height - 2, 0],
      [width - 1, height - 1, 1],
    ]) {
      const channel = raw.cfa[(y % 2) * 2 + (x % 2)]
      pixels[(y + raw.top) * rawWidth + x + raw.left] =
        raw.normalization!.sourceSaturation!.thresholds[channel] + offset
      raw.normalization!.sourceSaturation!.saturatedSites += Number(offset >= 0)
    }
  const plan = correctionPlan(
      width,
      height,
      corrected ? lens : unavailableProfile,
      automaticLensSettings,
    ),
    outWidth = flip & 4 ? plan.height : plan.width,
    outHeight = flip & 4 ? plan.width : plan.height,
    rgba = new Float32Array(outWidth * outHeight * 4),
    matrix = cameraMatrix(raw),
    adjacent = nearThreshold()
  for (let y = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++) {
      const camera = threshold
          ? [adjacent[x % 2], adjacent[(x + y) % 2], adjacent[y % 2]]
          : [
              x < 5 && y < 9 ? -0.125 : 0.03 + (x / outWidth) * 2,
              0.04 + (y / outHeight) * 1.5,
              x > outWidth - 5 && y < 9 ? -0.0625 : 0.05 + ((x * 13 + y * 7) % 31) / 19,
            ],
        at = (y * outWidth + x) * 4
      for (let c = 0; c < 3; c++)
        rgba[at + c] =
          matrix[c * 3] * camera[0] + matrix[c * 3 + 1] * camera[1] + matrix[c * 3 + 2] * camera[2]
      // Camera evidence validity comes from sensor geometry, independently of fusion alpha.
      rgba[at + 3] = Number((x + y) % 7 > 0)
    }
  return { raw, plan, rgba, width: outWidth, height: outHeight }
}

function sourceMasks(raw: RawSource) {
  const masks = Array.from({ length: 3 }, () => new Uint8Array(raw.width * raw.height))
  for (let y = 0; y < raw.height; y++)
    for (let x = 0; x < raw.width; x++) {
      const sensorChannel = raw.cfa[(y % 2) * 2 + (x % 2)],
        code = raw.pixels[(y + raw.top) * raw.rawWidth + x + raw.left]
      if (code < raw.normalization!.sourceSaturation!.thresholds[sensorChannel]) continue
      const channel = sensorChannel === 3 ? 1 : sensorChannel
      // Dilate each clipped sensor site independently, instead of production's parity runs.
      for (let yy = Math.max(0, y - 2); yy <= Math.min(raw.height - 1, y + 2); yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(raw.width - 1, x + 2); xx++)
          masks[channel][yy * raw.width + xx] = 1
    }
  return masks
}

function lookup(lut: Float32Array, radius: number, channel: number) {
  const last = lut.length / 4 - 1,
    position = Math.max(0, Math.min(last, radius * last)),
    first = Math.min(last - 1, Math.floor(position)),
    fraction = position - first
  return lut[first * 4 + channel] * (1 - fraction) + lut[(first + 1) * 4 + channel] * fraction
}

function footprints(native: number, reduced: number) {
  const result = Array.from({ length: native }, () => [] as [number, number][]),
    scale = native / reduced
  for (let cell = 0; cell < reduced; cell++)
    for (
      let source = Math.floor(cell * scale);
      source < Math.min(native, Math.ceil((cell + 1) * scale));
      source++
    ) {
      const overlap = Math.min(source + 1, (cell + 1) * scale) - Math.max(source, cell * scale)
      if (overlap > 1e-10) result[source].push([cell, overlap])
    }
  return result
}

/** Full scalar proof with independent inversion, Bayer dilation and area-overlap tables. */
function reference(data: ReturnType<typeof input>, reducedWidth: number, reducedHeight: number) {
  const { raw, plan, width, height, rgba } = data,
    inverse = inverseMatrix(cameraMatrix(raw)),
    masks = sourceMasks(raw),
    native = new Float32Array(rgba.length),
    cx = (raw.width - 1) / 2,
    cy = (raw.height - 1) / 2,
    radius = Math.hypot(cx, cy)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sx = raw.flip & 4 ? y : x,
        sy = raw.flip & 4 ? x : y
      if (raw.flip & 1) sx = plan.width - 1 - sx
      if (raw.flip & 2) sy = plan.height - 1 - sy
      const qx = sx + plan.left - cx,
        qy = sy + plan.top - cy,
        r = Math.hypot(qx, qy) / radius,
        at = (y * width + x) * 4
      let valid = 0
      for (let c = 0; c < 3; c++) {
        native[at + c] =
          inverse[c * 3] * rgba[at] +
          inverse[c * 3 + 1] * rgba[at + 1] +
          inverse[c * 3 + 2] * rgba[at + 2]
        const scale = lookup(plan.lut, r, c),
          px = cx + qx * scale,
          py = cy + qy * scale,
          left = Math.floor(px),
          top = Math.floor(py),
          dx = px - left,
          dy = py - top
        let clipped = false
        for (let yy = 0; yy < 2; yy++)
          for (let xx = 0; xx < 2; xx++) {
            const weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy),
              index =
                Math.max(0, Math.min(raw.height - 1, top + yy)) * raw.width +
                Math.max(0, Math.min(raw.width - 1, left + xx))
            if (weight > 0 && masks[c][index]) clipped = true
          }
        if (!clipped) valid |= 1 << c
      }
      native[at + 3] = valid
    }
  const count = reducedWidth * reducedHeight,
    xs = footprints(width, reducedWidth),
    ys = footprints(height, reducedHeight),
    sums = Array.from({ length: 3 }, () => new Float64Array(count)),
    weights = Array.from({ length: 3 }, () => new Float64Array(count)),
    totals = new Float64Array(count)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (const [px, wx] of xs[x])
        for (const [py, wy] of ys[y]) {
          const at = py * reducedWidth + px,
            source = (y * width + x) * 4,
            weight = wx * wy
          totals[at] += weight
          for (let c = 0; c < 3; c++)
            if (native[source + 3] & (1 << c) && native[source + c] > minimumSignal) {
              sums[c][at] += native[source + c] * weight
              weights[c][at] += weight
            }
        }
  const planes = [0, 1, 2].map((c) => {
    const mask = Uint8Array.from(weights[c], (weight, i) =>
        weight > 0 && Math.abs(weight - totals[i]) < 1e-8 ? 255 : 0,
      ),
      values = Float32Array.from(sums[c], (sum, i) => (mask[i] ? sum / weights[c][i] : 0))
    return { width: reducedWidth, height: reducedHeight, data: values, mask }
  }) as [Plane, Plane, Plane]
  return { native, planes }
}

function assertSamples(expected: Float32Array, actual: Float32Array, channels = 4) {
  expect(actual.length).toBe(expected.length)
  let maximumRatio = 0,
    maskMismatches = 0,
    nonFinite = 0
  for (let i = 0; i < expected.length; i++) {
    if (channels === 4 && i % 4 === 3) {
      maskMismatches += Number(actual[i] !== expected[i])
      continue
    }
    if (!Number.isFinite(actual[i])) nonFinite++
    else
      maximumRatio = Math.max(
        maximumRatio,
        Math.abs(actual[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i])),
      )
  }
  expect(nonFinite).toBe(0)
  expect(maskMismatches).toBe(0)
  expect(maximumRatio).toBeLessThanOrEqual(1)
}

async function assertEvidence(
  result: CameraRegistration,
  expected: ReturnType<typeof reference>,
  width: number,
  height: number,
) {
  const bytes = await readFile(result.path)
  expect(bytes.length).toBe(width * height * 16)
  expect(result.strips.length).toBe(Math.ceil(height / 64))
  for (let top = 0; top < height; top += 64)
    expect(hash(bytes.subarray(top * width * 16, Math.min(height, top + 64) * width * 16))).toBe(
      result.strips[top / 64],
    )
  assertSamples(expected.native, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4))
  for (let c = 0; c < 3; c++) {
    expect([result.planes[c].width, result.planes[c].height]).toEqual([
      expected.planes[c].width,
      expected.planes[c].height,
    ])
    expect(result.planes[c].mask).toEqual(expected.planes[c].mask)
    assertSamples(expected.planes[c].data, result.planes[c].data, 1)
  }
}

async function writeInput(
  writer: Pick<Writer, 'write'>,
  data: ReturnType<typeof input>,
  rows: number,
  first = 0,
) {
  for (let top = first; top < data.height; top += rows) {
    const values = data.rgba.subarray(
      top * data.width * 4,
      Math.min(data.height, top + rows) * data.width * 4,
    )
    await writer.write(top, nativeBytes(values))
  }
}

async function scalarEvidence(
  directory: string,
  index: number,
  data: ReturnType<typeof input>,
  reducedWidth = 11,
  reducedHeight = 7,
) {
  const previous = process.env.LUMA_MERGE_CPU_KERNEL
  let writer: Awaited<ReturnType<typeof cameraRegistrationWriter>> | undefined
  try {
    process.env.LUMA_MERGE_CPU_KERNEL = 'scalar'
    writer = await cameraRegistrationWriter(
      directory,
      index,
      data.raw,
      data.plan,
      reducedWidth,
      reducedHeight,
    )
    await writeInput(writer, data, 64)
    return await writer.finish()
  } finally {
    try {
      await writer?.close()
    } finally {
      if (previous === undefined) delete process.env.LUMA_MERGE_CPU_KERNEL
      else process.env.LUMA_MERGE_CPU_KERNEL = previous
    }
  }
}

let retainedGpu: GPU | undefined
async function hardware() {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter({ powerPreference: 'high-performance' })
  test.skip(
    !adapter || adapter.info.isFallbackAdapter,
    'Native hardware Dawn is required for camera evidence agreement.',
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

/** Native buffers reach Dawn unchanged; this wrapper observes ownership and injects host failures. */
function trackedDevice(
  actual: GPUDevice,
  options: {
    failAllocationAt?: number
    failedMap?: boolean
    truncatedReadback?: boolean
    limits?: Partial<Record<keyof GPUSupportedLimits, number>>
  } = {},
) {
  const resources: { resource: GPUBuffer | GPUTexture; destroyed: number; bytes: number }[] = []
  let deviceDestroys = 0
  const own = <T extends GPUBuffer | GPUTexture>(resource: T, bytes: number) => {
    const entry = { resource, destroyed: 0, bytes },
      destroy = resource.destroy.bind(resource)
    resources.push(entry)
    Object.defineProperty(resource, 'destroy', {
      value: () => {
        entry.destroyed++
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
            throw new Error('Injected camera GPU allocation failure.')
          const buffer = own(actual.createBuffer(descriptor), Number(descriptor.size))
          if (descriptor.usage & GPUBufferUsage.MAP_READ) {
            if (options.failedMap)
              Object.defineProperty(buffer, 'mapAsync', {
                value: () => Promise.reject(new Error('Injected camera GPU map failure.')),
              })
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
            throw new Error('Injected camera GPU allocation failure.')
          const resource = actual.createTexture(descriptor)
          return own(
            resource,
            resource.width *
              resource.height *
              resource.depthOrArrayLayers *
              (descriptor.format === 'r32uint' ? 4 : 16),
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
      for (const resource of resources) expect(resource.destroyed).toBe(1)
      expect(deviceDestroys).toBe(0)
    },
  }
}

function createWriter(
  directory: string,
  index: number,
  data: ReturnType<typeof input>,
  device: GPUDevice,
  options: Partial<Options> = {},
  reducedWidth = 11,
  reducedHeight = 7,
) {
  return gpuCameraRegistrationWriter(
    directory,
    index,
    data.raw,
    data.plan,
    reducedWidth,
    reducedHeight,
    {
      device,
      availableBytes: 1024 ** 3,
      checkpoint: async () => {},
      ...options,
    },
  )
}

for (const corrected of [false, true])
  for (let flip = 0; flip < 8; flip++)
    test(`GPU camera evidence preserves independent native samples and fractional planes for orientation ${flip}, lens ${corrected ? 'on' : 'off'}`, async () => {
      test.setTimeout(120000)
      const context = await hardware(),
        tracked = trackedDevice(context.device),
        directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-synthetic-')),
        data = input(flip, corrected),
        before = hash(nativeBytes(data.rgba)),
        sensorBefore = hash(new Uint8Array(data.raw.pixels.buffer)),
        planBefore = structuredClone(data.plan),
        expected = reference(data, 11, 7)
      let writer: Writer | undefined
      try {
        // Validate the independent proof against the maintained scalar path, then keep it frozen.
        await assertEvidence(
          await scalarEvidence(directory, 0, data),
          expected,
          data.width,
          data.height,
        )
        expect(Array.from(expected.native).some((value, i) => i % 4 !== 3 && value < 0)).toBe(true)
        expect(expected.planes.some((plane) => plane.mask!.some((value) => value === 255))).toBe(
          true,
        )
        for (const [index, rows] of [64, 128, 256].entries()) {
          const firstResource = tracked.resources.length
          writer = await createWriter(directory, index + 1, data, tracked.device)
          await writeInput(writer, data, rows)
          const result = await writer.finish()
          await writer.close()
          await writer.close()
          await assertEvidence(result, expected, data.width, data.height)
          await expect(writer.write(data.height, Buffer.alloc(data.width * 16))).rejects.toThrow()
          expect((await stat(result.path)).size).toBe(data.rgba.byteLength)
          expect(writer.metrics.policy).toBe(GPU_CAMERA_PREPARATION)
          expect(writer.metrics.backend).toBe('gpu')
          expect(writer.metrics.allocatedGpuBytes).toBe(
            gpuCameraRegistrationBytes(data.width, data.height),
          )
          expect(
            tracked.resources
              .slice(firstResource)
              .reduce((bytes, resource) => bytes + resource.bytes, 0),
          ).toBe(writer.metrics.allocatedGpuBytes)
          expect(writer.metrics.batches).toBe(Math.ceil(data.height / 64))
          expect(writer.metrics.inputBytes).toBe(data.rgba.byteLength)
          expect(writer.metrics.outputBytes).toBe(data.rgba.byteLength)
          writer = undefined
        }
        expect(hash(nativeBytes(data.rgba))).toBe(before)
        expect(hash(new Uint8Array(data.raw.pixels.buffer))).toBe(sensorBefore)
        expect(data.plan).toEqual(planBefore)
        expect(gpuCameraRegistrationBytes(data.width, data.height)).toBeLessThanOrEqual(1024 ** 3)
        tracked.assertReleased()
        await context.device.queue.onSubmittedWorkDone()
      } finally {
        await writer?.close()
        context.close()
        await rm(directory, { recursive: true, force: true })
      }
    })

test('GPU camera threshold guards retain strict Float32 validity on both adjacent sides of read noise', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-threshold-')),
    data = input(0, false, true),
    expected = reference(data, data.width, data.height)
  let writer: Writer | undefined
  try {
    const adjacent = nearThreshold()
    expect(adjacent[0]).toBeLessThan(minimumSignal)
    expect(adjacent[1]).toBeGreaterThan(minimumSignal)
    for (const plane of expected.planes) {
      expect(plane.mask!.some((value) => value === 0)).toBe(true)
      expect(plane.mask!.some((value) => value === 255)).toBe(true)
    }
    await assertEvidence(
      await scalarEvidence(directory, 0, data, data.width, data.height),
      expected,
      data.width,
      data.height,
    )
    writer = await createWriter(directory, 1, data, tracked.device, {}, data.width, data.height)
    await writeInput(writer, data, 256)
    await assertEvidence(await writer.finish(), expected, data.width, data.height)
    expect(writer.metrics.thresholdRepairs).toBeGreaterThan(0)
    await writer.close()
    tracked.assertReleased()
  } finally {
    await writer?.close()
    context.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('GPU camera projection repairs ill-conditioned channels without weakening sample tolerance', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-condition-')),
    data = input(5, true)
  data.raw.matrix = [1, 1, 0, 0, 1, 1.0005, 0, 0, 0, 0, 1, 0]
  const matrix = cameraMatrix(data.raw)
  for (let y = 0; y < data.height; y++)
    for (let x = 0; x < data.width; x++) {
      const at = (y * data.width + x) * 4,
        camera = [0.2 + x / data.width, 0.4 + y / data.height, 0.8]
      for (let c = 0; c < 3; c++)
        data.rgba[at + c] =
          matrix[c * 3] * camera[0] + matrix[c * 3 + 1] * camera[1] + matrix[c * 3 + 2] * camera[2]
    }
  const expected = reference(data, 11, 7),
    before = hash(nativeBytes(data.rgba))
  let writer: Writer | undefined
  try {
    await assertEvidence(
      await scalarEvidence(directory, 0, data),
      expected,
      data.width,
      data.height,
    )
    writer = await createWriter(directory, 1, data, tracked.device)
    await writeInput(writer, data, 256)
    await assertEvidence(await writer.finish(), expected, data.width, data.height)
    expect(writer.metrics.conditionRepairs).toBeGreaterThan(0)
    expect(hash(nativeBytes(data.rgba))).toBe(before)
    await writer.close()
    tracked.assertReleased()
  } finally {
    await writer?.close()
    context.close()
    await rm(directory, { recursive: true, force: true })
  }
})

async function assertCpuRecovery(
  directory: string,
  data: ReturnType<typeof input>,
  baseline: CameraRegistration,
) {
  const recovered = await scalarEvidence(directory, 0, data)
  expect(await readFile(recovered.path)).toEqual(await readFile(baseline.path))
  expect(recovered.strips).toEqual(baseline.strips)
  expect(recovered.planes).toEqual(baseline.planes)
  expect((await stat(recovered.path)).size).toBe(data.rgba.byteLength)
}

for (const phase of ['allocated', 'uploaded', 'submitted', 'readback', 'before-write'] as const)
  test(`GPU camera cancellation at ${phase} removes partial evidence before complete same-path CPU recovery`, async () => {
    const context = await hardware(),
      tracked = trackedDevice(context.device),
      directory = await mkdtemp(join(tmpdir(), `luma-gpu-camera-cancel-${phase}-`)),
      data = input(7, true),
      before = hash(nativeBytes(data.rgba)),
      abort = new AbortController(),
      message = `Camera cancellation at ${phase}.`
    let writer: Writer | undefined,
      reached = false
    try {
      const baseline = await scalarEvidence(directory, 99, data),
        creating = createWriter(directory, 0, data, tracked.device, {
          signal: abort.signal,
          hooks: {
            checkpoint(event) {
              if (event.phase === phase && (phase === 'allocated' || event.top === 64)) {
                reached = true
                abort.abort(new Error(message))
              }
            },
          },
        })
      if (phase === 'allocated') await expect(creating).rejects.toThrow(message)
      else {
        writer = await creating
        await expect(writeInput(writer, data, 256)).rejects.toThrow(message)
        await expect(writer.finish()).rejects.toThrow(message)
        await writer.close()
        await writer.close()
      }
      expect(reached).toBe(true)
      expect(await readdir(directory)).not.toContain('source-0.camera.f32')
      tracked.assertReleased()
      await context.device.queue.onSubmittedWorkDone()
      await assertCpuRecovery(directory, data, baseline)
      expect(hash(nativeBytes(data.rgba))).toBe(before)
    } finally {
      await writer?.close()
      context.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

for (const fault of [
  'map rejection',
  'truncated readback',
  'non-finite readback',
  'invalid validity bits',
] as const)
  test(`GPU camera ${fault} rejects the whole evidence before complete CPU replay`, async () => {
    const context = await hardware(),
      tracked = trackedDevice(context.device, {
        failedMap: fault === 'map rejection',
        truncatedReadback: fault === 'truncated readback',
      }),
      directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-readback-')),
      data = input(0, false),
      before = hash(nativeBytes(data.rgba))
    let writer: Writer | undefined,
      corruptions = 0
    try {
      const baseline = await scalarEvidence(directory, 99, data)
      writer = await createWriter(directory, 0, data, tracked.device, {
        hooks: {
          readback(top, pixels) {
            if (top !== 64) return
            if (fault === 'non-finite readback') {
              pixels[0] = NaN
              corruptions++
            }
            if (fault === 'invalid validity bits') {
              pixels[3] = 8
              corruptions++
            }
          },
        },
      })
      await expect(writeInput(writer, data, 256)).rejects.toThrow()
      await expect(writer.finish()).rejects.toThrow()
      await writer.close()
      if (fault === 'non-finite readback' || fault === 'invalid validity bits')
        expect(corruptions).toBe(1)
      expect(await readdir(directory)).not.toContain('source-0.camera.f32')
      tracked.assertReleased()
      await context.device.queue.onSubmittedWorkDone()
      await assertCpuRecovery(directory, data, baseline)
      expect(hash(nativeBytes(data.rgba))).toBe(before)
    } finally {
      await writer?.close()
      context.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

test('GPU camera device loss after submitted work drains resources and permits complete scalar evidence recovery', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-device-loss-')),
    data = input(7, true),
    before = hash(nativeBytes(data.rgba))
  let writer: Writer | undefined, lost: GPUDeviceLostInfo | undefined
  try {
    const baseline = await scalarEvidence(directory, 99, data)
    writer = await createWriter(directory, 0, data, tracked.device, {
      hooks: {
        async checkpoint(event) {
          if (event.phase !== 'submitted' || event.top !== 64) return
          context.device.destroy()
          lost = await context.device.lost
        },
      },
    })
    await expect(writeInput(writer, data, 256)).rejects.toThrow(/device lost/i)
    await writer.close()
    expect(lost?.reason).toBe('destroyed')
    expect(await readdir(directory)).not.toContain('source-0.camera.f32')
    tracked.assertReleased()
    await assertCpuRecovery(directory, data, baseline)
    expect(hash(nativeBytes(data.rgba))).toBe(before)
  } finally {
    await writer?.close()
    context.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('GPU camera invalid and concurrent writes preserve the admitted operation and complete evidence', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-concurrent-')),
    data = input(0, false),
    entered = deferred<void>(),
    resume = deferred<void>()
  let writer: Writer | undefined
  try {
    writer = await createWriter(directory, 0, data, tracked.device, {
      hooks: {
        async checkpoint(event) {
          if (event.phase === 'submitted' && event.top === 0) {
            entered.resolve()
            await resume.promise
          }
        },
      },
    })
    const firstStrip = nativeBytes(data.rgba.subarray(0, data.width * 64 * 4))
    await expect(writer.finish()).rejects.toThrow('Incomplete GPU camera registration evidence.')
    await expect(writer.write(1, firstStrip)).rejects.toThrow()
    await expect(writer.write(0, firstStrip.subarray(1))).rejects.toThrow()
    const first = writer.write(0, firstStrip)
    void first.catch(() => undefined)
    await entered.promise
    await expect(writer.write(0, firstStrip)).rejects.toThrow(/concurrent/i)
    await expect(writer.finish()).rejects.toThrow('Incomplete GPU camera registration evidence.')
    resume.resolve()
    await first
    await writeInput(writer, data, 128, 64)
    await assertEvidence(await writer.finish(), reference(data, 11, 7), data.width, data.height)
    await writer.close()
    tracked.assertReleased()
  } finally {
    resume.resolve()
    await writer?.close()
    context.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('closing an active GPU camera writer waits for submitted work before releasing buffers and partial evidence', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device),
    directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-close-')),
    data = input(0, false),
    entered = deferred<void>(),
    resume = deferred<void>()
  let writer: Writer | undefined
  try {
    const baseline = await scalarEvidence(directory, 99, data)
    writer = await createWriter(directory, 0, data, tracked.device, {
      hooks: {
        async checkpoint(event) {
          if (event.phase === 'submitted' && event.top === 0) {
            entered.resolve()
            await resume.promise
          }
        },
      },
    })
    const writing = writer.write(0, nativeBytes(data.rgba.subarray(0, data.width * 64 * 4)))
    void writing.catch(() => undefined)
    await entered.promise
    const closing = writer.close()
    expect(tracked.resources.every((resource) => resource.destroyed === 0)).toBe(true)
    resume.resolve()
    await expect(writing).rejects.toThrow(/closed/i)
    await closing
    await writer.close()
    tracked.assertReleased()
    expect(await readdir(directory)).not.toContain('source-0.camera.f32')
    await context.device.queue.onSubmittedWorkDone()
    await assertCpuRecovery(directory, data, baseline)
  } finally {
    resume.resolve()
    await writer?.close()
    context.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('GPU camera preflight rejects memory and device limits before allocations and pre-cancelled work touches no output', async () => {
  const context = await hardware(),
    directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-limits-')),
    data = input(0, false)
  try {
    const tracked = trackedDevice(context.device),
      bytes = gpuCameraRegistrationBytes(data.width, data.height)
    await expect(
      createWriter(directory, 0, data, tracked.device, { availableBytes: bytes - 1 }),
    ).rejects.toThrow(/memory budget/i)
    expect(tracked.resources).toEqual([])
    const abort = new AbortController()
    abort.abort(new Error('Camera cancelled before allocation.'))
    await expect(
      createWriter(directory, 0, data, tracked.device, { signal: abort.signal }),
    ).rejects.toThrow('Camera cancelled before allocation.')
    expect(tracked.resources).toEqual([])
    for (const limits of [
      { maxStorageBufferBindingSize: 128 },
      { maxBufferSize: 128 },
      { maxUniformBufferBindingSize: 32 },
      { maxComputeWorkgroupsPerDimension: 1 },
      { maxComputeInvocationsPerWorkgroup: 128 },
      { maxComputeWorkgroupSizeX: 128 },
    ]) {
      const limited = trackedDevice(context.device, { limits })
      await expect(createWriter(directory, 0, data, limited.device)).rejects.toThrow(
        /device limits/i,
      )
      expect(limited.resources).toEqual([])
      limited.assertReleased()
    }
    expect(() => gpuCameraRegistrationBytes(0, 1)).toThrow()
    expect(() => gpuCameraRegistrationBytes(Number.MAX_SAFE_INTEGER, 64)).toThrow()
    expect(gpuCameraRegistrationBytes(24_000_000, 1)).toBeGreaterThan(1024 ** 3)
    const oversized = { ...data, plan: { ...data.plan, width: 24_000_000, height: 1 } }
    await expect(
      createWriter(directory, 0, oversized, tracked.device, { availableBytes: 2 * 1024 ** 3 }),
    ).rejects.toThrow(/memory budget/i)
    expect(tracked.resources).toEqual([])
    expect(await readdir(directory)).toEqual([])
    tracked.assertReleased()
  } finally {
    context.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('partially allocated GPU camera setup releases resources and leaves the CPU evidence destination available', async () => {
  const context = await hardware(),
    tracked = trackedDevice(context.device, { failAllocationAt: 3 }),
    directory = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-allocation-')),
    data = input(7, true)
  try {
    const baseline = await scalarEvidence(directory, 99, data)
    await expect(createWriter(directory, 0, data, tracked.device)).rejects.toThrow(
      'Injected camera GPU allocation failure.',
    )
    expect(tracked.resources.length).toBe(2)
    tracked.assertReleased()
    expect(await readdir(directory)).not.toContain('source-0.camera.f32')
    await context.device.queue.onSubmittedWorkDone()
    await assertCpuRecovery(directory, data, baseline)
  } finally {
    context.close()
    await rm(directory, { recursive: true, force: true })
  }
})

async function fileIdentity(path: string) {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk)
    bytes += chunk.length
  }
  return { sha256: digest.digest('hex'), bytes }
}

test('real HDR source preparation replays complete CPU camera evidence after a late GPU readback failure and preserves cancellation', async () => {
  test.setTimeout(240000)
  const root = await mkdtemp(join(tmpdir(), 'luma-gpu-camera-native-recovery-')),
    inspector = new PreviewEngine(),
    fixtureRoot = resolve('tests/fixtures/research-sony'),
    manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
      sequences: { mode: string; complete: boolean; files: string[] }[]
      files: {
        name: string
        path: string
        sha256: string
        bytes: number
        dimensions: { activeWidth: number; activeHeight: number }
      }[]
    },
    bracket = manifest.sequences.find((sequence) => sequence.mode === 'hdr')!,
    paths: string[] = [],
    sources: MergeSource[] = [],
    originals: { sha256: string; bytes: number }[] = []
  let gpu: RawGpuRenderer | undefined
  try {
    expect(bracket.complete).toBe(true)
    expect(bracket.files).toHaveLength(3)
    for (const name of bracket.files) {
      const entry = manifest.files.find((file) => file.name === name)!,
        path = resolve(fixtureRoot, entry.path),
        before = await fileIdentity(path),
        metadata = await inspector.inspect(path),
        captureMetadata = await inspector.inspectCapture(path)
      expect(path.startsWith(`${fixtureRoot}${sep}`)).toBe(true)
      expect(before).toEqual({ sha256: entry.sha256, bytes: entry.bytes })
      expect(metadata.capture).toBeTruthy()
      paths.push(path)
      originals.push(before)
      sources.push({
        photo: {
          id: entry.sha256,
          filename: name,
          width: entry.dimensions.activeWidth,
          height: entry.dimensions.activeHeight,
          bytes: entry.bytes,
          format: 'ARW',
          importedAt: '2026-10-17',
          thumbnailUrl: '',
          previewUrl: '',
          previewSource: 'decoded',
        },
        metadata,
        capture: metadata.capture!,
        captureMetadata,
        relativeEv: 0,
      })
    }
    const settings: MergeSettings = {
        mode: 'hdr',
        referenceId: sources[0].photo.id,
        autoAlign: true,
        autoCrop: true,
        deghost: true,
        strength: 50,
      },
      preparation = await mergePreparation(paths, sources, settings, async () => {}),
      controlDirectory = join(root, 'control'),
      recoveredDirectory = join(root, 'recovered'),
      cancelledDirectory = join(root, 'cancelled')
    expect(preparation).toBeTruthy()
    await Promise.all(
      [controlDirectory, recoveredDirectory, cancelledDirectory].map((directory) =>
        mkdir(directory),
      ),
    )
    gpu = new RawGpuRenderer()
    const control = await prepareSource(
      paths[0],
      controlDirectory,
      0,
      sources[0],
      sources[0],
      gpu,
      async () => {},
      preparation,
    )
    expect(control.measurement?.backend).toBe('gpu')
    expect(control.cameraRegistration).toBeTruthy()
    gpu.close()
    gpu = new RawGpuRenderer()
    let injected = false
    const recovered = await prepareSource(
      paths[0],
      recoveredDirectory,
      0,
      sources[0],
      sources[0],
      gpu,
      async () => {},
      preparation,
      GPU_CAMERA_PREPARATION,
      {
        hooks: {
          readback(top, pixels) {
            if (top !== 64) return
            injected = true
            pixels[0] = NaN
          },
        },
      },
    )
    expect(injected).toBe(true)
    expect(recovered.measurement?.backend).toBe('gpu')
    expect(recovered.cameraPreparation).toBe(GPU_CAMERA_PREPARATION)
    expect(recovered.measurement?.work?.cameraPreparation).toMatchObject({
      policy: GPU_CAMERA_PREPARATION,
      backend: 'cpu',
      batches: 1,
    })
    expect(recovered.measurement?.work?.cameraPreparation?.fallback).toContain(
      'Non-finite GPU camera evidence sample.',
    )
    expect(recovered.strips).toEqual(control.strips)
    expect(recovered.plane).toEqual(control.plane)
    expect(await fileIdentity(recovered.path)).toEqual(await fileIdentity(control.path))
    expect(recovered.cameraRegistration!.strips).toEqual(control.cameraRegistration!.strips)
    expect(await fileIdentity(recovered.cameraRegistration!.path)).toEqual(
      await fileIdentity(control.cameraRegistration!.path),
    )
    expect(recovered.cameraRegistration!.planes).toEqual(control.cameraRegistration!.planes)
    gpu.close()
    gpu = new RawGpuRenderer()
    const abort = new AbortController()
    let cancelled = false
    await expect(
      prepareSource(
        paths[0],
        cancelledDirectory,
        0,
        sources[0],
        sources[0],
        gpu,
        async () => {},
        preparation,
        GPU_CAMERA_PREPARATION,
        {
          signal: abort.signal,
          hooks: {
            checkpoint(event) {
              if (event.phase !== 'readback' || event.top !== 64) return
              cancelled = true
              abort.abort(new Error('Cancelled native camera evidence.'))
            },
          },
        },
      ),
    ).rejects.toThrow('Cancelled native camera evidence.')
    expect(cancelled).toBe(true)
    const remaining = await readdir(cancelledDirectory)
    expect(remaining).not.toContain('source-0.f32')
    expect(remaining).not.toContain('source-0.camera.f32')
    for (const backend of ['gpu', 'cpu'] as const) {
      gpu.close()
      gpu = new RawGpuRenderer()
      const directory = join(root, `cancelled-final-close-${backend}`),
        target = join(directory, 'source-0.f32'),
        controller = new AbortController(),
        reason = new Error(`Cancelled ${backend} source during final owned working-file close.`),
        originalOpen = filesystem.open,
        previousBackend = process.env.LUMA_MERGE_BACKEND,
        ownedNames = [
          'source-0.f32',
          'source-0.camera.f32',
          'source-0.sensor',
          'source-0.alpha',
          'source-0.lens',
        ]
      let interceptedOpens = 0,
        completedCloses = 0,
        filesAtClose: string[] = []
      await mkdir(directory)
      try {
        process.env.LUMA_MERGE_BACKEND = backend
        // This file runs sequentially. Intercept only one test-owned exclusive
        // output handle; every other builtin open retains its original behavior.
        filesystem.open = async (...args: Parameters<typeof filesystem.open>) => {
          const handle = await originalOpen(...args)
          if (args[0] !== target || args[1] !== 'wx') return handle
          interceptedOpens++
          const close = handle.close.bind(handle)
          handle.close = async () => {
            await close()
            completedCloses++
            filesAtClose = await readdir(directory)
            controller.abort(reason)
          }
          return handle
        }
        syncBuiltinESMExports()
        await expect(
          prepareSource(
            paths[0],
            directory,
            0,
            sources[0],
            sources[0],
            gpu,
            async () => {},
            preparation,
            GPU_CAMERA_PREPARATION,
            { signal: controller.signal },
          ),
        ).rejects.toBe(reason)
      } finally {
        filesystem.open = originalOpen
        syncBuiltinESMExports()
        if (previousBackend === undefined) delete process.env.LUMA_MERGE_BACKEND
        else process.env.LUMA_MERGE_BACKEND = previousBackend
      }
      expect(interceptedOpens).toBe(1)
      expect(completedCloses).toBe(1)
      expect(filesAtClose).toEqual(
        expect.arrayContaining(backend === 'gpu' ? ownedNames : ownedNames.slice(0, 2)),
      )
      const remaining = await readdir(directory)
      for (const name of ownedNames) expect(remaining).not.toContain(name)
    }
    for (let index = 0; index < paths.length; index++)
      expect(await fileIdentity(paths[index])).toEqual(originals[index])
  } finally {
    gpu?.close()
    await inspector.close()
    await rm(root, { recursive: true, force: true })
  }
})
