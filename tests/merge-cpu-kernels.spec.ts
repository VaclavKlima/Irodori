import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createCameraKernel,
  createCameraValidityKernel,
  createFallbackGeometryKernel,
  createAreaReducer,
  createMaskRepairKernel,
  createPreparationKernel,
  createSensorClippingMask,
  getMergeKernelHeapBytes,
  MERGE_KERNEL_HEAP_LIMIT,
  mergeKernelDirectory,
  readMergeKernel,
  type CpuKernelMeasurement,
} from '../src/main/merge/cpu-kernels'
import type { LinearFrame } from '../src/main/processing/contracts'
import type { RawSource } from '../src/main/gpu/raw-source'
import {
  cameraRegistrationInverse,
  cameraRegistrationWriter,
  createCameraValidityProvider,
} from '../src/main/merge/camera-registration'
import { correctionPlan, type CorrectionPlan } from '../src/main/processing/lens-correction'
import { automaticLensSettings, type LensProfile } from '../src/shared/lens'
import { REC2020_LUMINANCE, SRGB_TO_2020 } from '../src/shared/hdr'
import { MERGE_LIMITS } from '../src/shared/merge'
import { areaContributions, flattenedAreaContributions } from '../src/main/merge/area'
import {
  createFallbackGeometryProvider,
  fallbackGeometryCoordinate,
  FALLBACK_GEOMETRY_CHANNEL_WORDS,
  FALLBACK_GEOMETRY_PIXEL_WORDS,
} from '../src/main/merge/fallback-geometry'

const repository = resolve(import.meta.dirname, '..'),
  vendor = join(repository, 'vendor/merge-kernels'),
  lens: LensProfile = {
    provider: 'test',
    version: '1',
    label: 'Exact kernel non-identity lens',
    identity: 'exact-kernel-distortion-ca-vignette-1',
    distortion: { radii: [0, 0.5, 1], values: [1, 1.02, 1.06] },
    vignetting: { radii: [0, 0.5, 1], values: [1, 1.2, 1.6] },
    chromaticAberration: {
      red: { radii: [0, 0.5, 1], values: [1, 0.998, 0.995] },
      blue: { radii: [0, 0.5, 1], values: [1, 1.003, 1.008] },
    },
    unavailable: {},
  }
const bytes = (array: Float32Array | Float64Array | Uint8Array) =>
  Buffer.from(array.buffer, array.byteOffset, array.byteLength)
const measurement = (): CpuKernelMeasurement => ({
  backend: 'scalar',
  heapBytes: 0,
  copyMs: 0,
  processingMs: 0,
})

function fixture(flip: number, width = 139, height = 71) {
  const normalization = {
      black: [0, 0, 0, 0],
      maximum: 4095,
      gains: [2, 1, 1.5, 1],
      restoreGain: 2,
      referenceWhite: 1,
      sourceSaturation: {
        thresholds: [3800, 3800, 3800, 3800],
        saturatedSites: 1,
        totalSites: width * height,
      },
    },
    frame: LinearFrame = {
      width,
      height,
      flip,
      normalization,
      matrix: [1.8, -0.6, -0.2, 0, -0.1, 1.2, -0.1, 0, -0.1, -0.6, 1.7, 0],
      data: Float32Array.from({ length: width * height * 4 }, (_, i) => {
        if (i % 4 === 3) return 1
        if (i % 113 === 0) return i % 2 ? -1e20 : 1e20
        return ((i * 97) % 1009) / 509 - 0.2
      }),
    },
    raw: RawSource = {
      ...frame,
      pixels: new Uint16Array((width + 5) * (height + 2)),
      rawWidth: width + 5,
      left: 2,
      top: 1,
      cfa: [0, 1, 3, 2],
      black: normalization.black,
      scale: [1, 1, 1, 1],
    },
    plan = correctionPlan(width, height, lens, automaticLensSettings)
  return { frame, raw, plan }
}

// This deliberately uncached reference keeps the former scalar tap loop and
// row-wise matrix expressions independent of the compiled implementation.
function radial(lut: Float32Array, radius: number, channel: number) {
  const position = Math.max(0, Math.min(4095, radius * 4095)),
    i = Math.min(4094, Math.floor(position)),
    f = position - i
  return lut[i * 4 + channel] * (1 - f) + lut[(i + 1) * 4 + channel] * f
}
function geometry(frame: LinearFrame, plan: CorrectionPlan, x: number, y: number) {
  const cx = (frame.width - 1) / 2,
    cy = (frame.height - 1) / 2
  let sx = frame.flip & 4 ? y : x,
    sy = frame.flip & 4 ? x : y
  if (frame.flip & 1) sx = plan.width - 1 - sx
  if (frame.flip & 2) sy = plan.height - 1 - sy
  const qx = sx + plan.left - cx,
    qy = sy + plan.top - cy
  return { cx, cy, qx, qy, radius: Math.hypot(qx, qy) / Math.hypot(cx, cy) }
}
function taps(frame: LinearFrame, plan: CorrectionPlan, x: number, y: number, channel: number) {
  const g = geometry(frame, plan, x, y),
    scale = radial(plan.lut, g.radius, channel),
    px = g.cx + g.qx * scale,
    py = g.cy + g.qy * scale,
    ix = Math.floor(px),
    iy = Math.floor(py),
    dx = px - ix,
    dy = py - iy,
    result: { x: number; y: number; weight: number }[] = []
  for (let yy = 0; yy < 2; yy++)
    for (let xx = 0; xx < 2; xx++)
      result.push({
        x: Math.max(0, Math.min(frame.width - 1, ix + xx)),
        y: Math.max(0, Math.min(frame.height - 1, iy + yy)),
        weight: (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy),
      })
  return result
}

// The frozen full-plane algorithm is intentionally independent of the bounded
// row implementation. Its Float32 luminance assignment occurs after every update.
function referenceReduction(
  pixels: Float32Array,
  luminance: Float64Array | undefined,
  width: number,
  height: number,
  pw: number,
  ph: number,
  doubleLuminance = false,
) {
  const channels = luminance ? 1 : 3,
    xs = areaContributions(width, pw),
    ys = areaContributions(height, ph),
    totals = new Float64Array(pw * ph),
    counts = Array.from({ length: channels }, () => new Float64Array(pw * ph)),
    sums = Array.from({ length: channels }, () =>
      luminance && !doubleLuminance ? new Float32Array(pw * ph) : new Float64Array(pw * ph),
    )
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        valid = pixels[i * 4 + 3]
      for (const [px, wx] of xs[x])
        for (const [py, wy] of ys[y]) {
          const p = py * pw + px,
            weight = wx * wy
          totals[p] += weight
          for (let c = 0; c < channels; c++) {
            const value = luminance ? luminance[i] : pixels[i * 4 + c]
            if ((luminance ? valid : valid & (1 << c)) && value > MERGE_LIMITS.readNoise * 3) {
              sums[c][p] += value * weight
              counts[c][p] += weight
            }
          }
        }
    }
  return sums.map((sum, c) => {
    const data = new Float32Array(pw * ph),
      mask = new Uint8Array(pw * ph)
    for (let p = 0; p < data.length; p++) {
      mask[p] = counts[c][p] > 0 && Math.abs(counts[c][p] - totals[p]) < 1e-8 ? 255 : 0
      data[p] = mask[p] ? sum[p] / counts[c][p] : 0
    }
    return { width: pw, height: ph, data, mask }
  })
}

function referenceSensorMasks(raw: RawSource) {
  const canonical = new Uint8Array(raw.width * raw.height),
    channels = Array.from({ length: 3 }, () => new Uint8Array(raw.width * raw.height)),
    thresholds = raw.normalization!.sourceSaturation!.thresholds
  for (let y = 0; y < raw.height; y++)
    for (let x = 0; x < raw.width; x++) {
      const c = raw.cfa[(y & 1) * 2 + (x & 1)],
        channel = c === 3 ? 1 : c
      if (raw.pixels[(y + raw.top) * raw.rawWidth + raw.left + x] < thresholds[c]) continue
      for (let yy = Math.max(0, y - 2); yy < Math.min(raw.height, y + 3); yy++)
        for (let xx = Math.max(0, x - 2); xx < Math.min(raw.width, x + 3); xx++) {
          canonical[yy * raw.width + xx] = 1
          channels[channel][yy * raw.width + xx] = 1
        }
    }
  return { canonical, channels }
}

function referenceRepair(
  pixels: Float32Array,
  top: number,
  frame: LinearFrame,
  plan: CorrectionPlan,
  saturated: Uint8Array,
  alpha: Uint32Array,
) {
  const width = frame.flip & 4 ? plan.height : plan.width,
    rows = pixels.length / 4 / width,
    original = Uint8Array.from({ length: width * rows }, (_, i) => pixels[i * 4 + 3]),
    changed: number[] = []
  for (let k = 0; k < original.length; k++) {
    const i = top * width + k
    alpha[i >>> 5] |= original[k] << (i & 31)
  }
  for (let row = 0; row < rows; row++)
    for (let x = 0; x < width; x++) {
      const k = row * width + x,
        a = original[k]
      if (
        row > 0 &&
        row < rows - 1 &&
        a === original[k - width] &&
        a === original[k + width] &&
        (x === 0 || a === original[k - 1]) &&
        (x === width - 1 || a === original[k + 1])
      )
        continue
      const clipped = [0, 1, 2].some((c) =>
          taps(frame, plan, x, top + row, c).some(
            (tap) => tap.weight > 0 && saturated[tap.y * frame.width + tap.x],
          ),
        ),
        i = top * width + k
      pixels[k * 4 + 3] = Number(!clipped)
      if (clipped) alpha[i >>> 5] &= ~(1 << (i & 31))
      else alpha[i >>> 5] |= 1 << (i & 31)
      if (clipped && a) changed.push(i)
    }
  return changed
}

function referenceFallbackGeometry(
  frame: LinearFrame,
  plan: CorrectionPlan,
  saturated: Uint8Array,
  top: number,
  rows: number,
) {
  const width = frame.flip & 4 ? plan.height : plan.width,
    geometryWords = new Uint32Array(width * rows * FALLBACK_GEOMETRY_PIXEL_WORDS),
    integers = new Int32Array(geometryWords.buffer),
    fractions = new Float32Array(geometryWords.buffer),
    alpha = new Uint8Array(width * rows)
  for (let row = 0; row < rows; row++)
    for (let x = 0; x < width; x++) {
      const g = geometry(frame, plan, x, top + row),
        pixel = row * width + x
      let clipped = false
      for (let c = 0; c < 3; c++) {
        const scale = radial(plan.lut, g.radius, c),
          px = g.cx + g.qx * scale,
          py = g.cy + g.qy * scale,
          ix = Math.floor(px),
          iy = Math.floor(py),
          dx = px - ix,
          dy = py - iy,
          at = pixel * FALLBACK_GEOMETRY_PIXEL_WORDS + c * FALLBACK_GEOMETRY_CHANNEL_WORDS
        integers[at] = ix
        integers[at + 1] = iy
        fractions[at + 2] = dx
        fractions[at + 3] = dx - Math.fround(dx)
        fractions[at + 4] = dy
        fractions[at + 5] = dy - Math.fround(dy)
        if (
          taps(frame, plan, x, top + row, c).some(
            (tap) => tap.weight > 0 && saturated[tap.y * frame.width + tap.x],
          )
        )
          clipped = true
      }
      alpha[pixel] = Number(!clipped)
    }
  return { geometry: geometryWords, alpha }
}

test('optional SIMD assets verify checksums and resolve beside the packaged worker', async () => {
  expect(mergeKernelDirectory(join(repository, 'src/main/merge'))).toBe(vendor)
  const directory = await mkdtemp(join(tmpdir(), 'irodori-merge-kernel-assets-'))
  try {
    expect(await readMergeKernel(directory)).toBeUndefined()
    const binary = await readFile(join(vendor, 'irodori-merge-kernels.wasm')),
      manifest = await readFile(join(vendor, 'manifest.json'), 'utf8')
    const relocated = join(directory, 'app/main/merge-kernels'),
      chunks = join(directory, 'app/main/chunks')
    await mkdir(relocated, { recursive: true })
    await mkdir(chunks)
    await writeFile(join(relocated, 'irodori-merge-kernels.wasm'), binary)
    await writeFile(join(relocated, 'manifest.json'), manifest)
    expect(mergeKernelDirectory(join(directory, 'app/main'))).toBe(relocated)
    expect(await readMergeKernel(mergeKernelDirectory(join(directory, 'app/main')))).toBeDefined()
    expect(mergeKernelDirectory(chunks)).toBe(relocated)
    expect(await readMergeKernel(mergeKernelDirectory(chunks))).toBeDefined()
    await writeFile(join(directory, 'irodori-merge-kernels.wasm'), binary)
    await writeFile(join(directory, 'manifest.json'), manifest)
    expect(await readMergeKernel(directory)).toBeDefined()
    const current = JSON.parse(manifest) as { version: number; sha256: string }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...current, version: 1 }))
    expect(await readMergeKernel(directory)).toBeUndefined()
    await writeFile(join(directory, 'manifest.json'), manifest)
    const corrupted = Buffer.from(binary)
    corrupted[corrupted.length - 1] ^= 1
    await writeFile(join(directory, 'irodori-merge-kernels.wasm'), corrupted)
    expect(await readMergeKernel(directory)).toBeUndefined()
    const invalid = new Uint8Array([0])
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ version: 5, sha256: createHash('sha256').update(invalid).digest('hex') }),
    )
    // A checksum alone does not make malformed or unsupported bytecode usable.
    await writeFile(join(directory, 'irodori-merge-kernels.wasm'), invalid)
    expect(await readMergeKernel(directory)).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SIMD camera rows and channel validity exactly match Float64 for every orientation', async () => {
  const module = await readMergeKernel(vendor)
  expect(module).toBeDefined()
  const inverse = [1.625, -0.375, -0.25, -0.25, 1.375, -0.125, -0.125, -0.5, 1.625]
  for (const flip of [0, 1, 2, 3, 4, 5, 6, 7])
    for (const clipped of [false, true]) {
      const { frame, raw, plan } = fixture(flip)
      raw.normalization!.sourceSaturation!.saturatedSites = Number(clipped)
      const work = measurement(),
        kernel = await createCameraKernel(raw, plan, inverse, work, module),
        width = flip & 4 ? plan.height : plan.width,
        height = flip & 4 ? plan.width : plan.height,
        input = Float32Array.from({ length: width * height * 4 }, (_, i) =>
          i % 4 === 3 ? 1 : [-3.4e38, 3.4e38, -1e-30, 0, 0.125, 0.75, 7][i % 7],
        )
      expect(kernel).toBeDefined()
      try {
        if (clipped)
          for (let c = 0; c < 3; c++)
            for (let y = 0; y < raw.height; y++)
              for (let x = 0; x < raw.width; x++)
                kernel!.masks![c][y * raw.width + x] = Number((x * 3 + y * 7 + c * 11) % 29 < 3)
        const masks = kernel!.masks?.map((m) => m.slice()),
          expected = new Float32Array(input.length)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4
            let valid = 7
            for (let c = 0; c < 3; c++) {
              expected[at + c] =
                inverse[c * 3] * input[at] +
                inverse[c * 3 + 1] * input[at + 1] +
                inverse[c * 3 + 2] * input[at + 2]
              if (
                masks &&
                taps(frame, plan, x, y, c).some(
                  (tap) => tap.weight > 0 && masks[c][tap.y * raw.width + tap.x],
                )
              )
                valid &= ~(1 << c)
            }
            expected[at + 3] = valid
          }
        for (let top = 0; top < height; top += 64) {
          const first = top * width * 4,
            last = Math.min(top + 64, height) * width * 4,
            output = kernel!.convert(top, input.subarray(first, last))
          expect(bytes(output).equals(bytes(expected.subarray(first, last)))).toBe(true)
        }
        if (masks) for (let c = 0; c < 3; c++) expect(kernel!.masks![c]).toEqual(masks[c])
        expect(work.backend).toBe('wasm-simd')
        expect(work.heapBytes).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
        expect(() => kernel!.convert(height, input.subarray(0, width * 4))).toThrow()
        expect(() => kernel!.convert(0, new Float32Array(width * 4).fill(NaN))).toThrow()
      } finally {
        kernel!.close()
        kernel!.close()
      }
      expect(() => kernel!.convert(0, input.subarray(0, width * 4))).toThrow('closed')
    }
})

test('SIMD preparation preserves native Float32 and unquantized Float64 luminance exactly', async () => {
  const module = await readMergeKernel(vendor),
    originalCacheEntries = process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES
  expect(module).toBeDefined()
  try {
    for (const flip of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const { frame, plan } = fixture(flip, flip === 5 ? 331 : 139, flip === 5 ? 139 : 71),
        original = Buffer.from(bytes(frame.data)),
        width = flip & 4 ? plan.height : plan.width,
        height = flip & 4 ? plan.width : plan.height,
        saturated = Uint8Array.from({ length: frame.width * frame.height }, (_, i) =>
          Number(i % 41 === 0),
        ),
        originalSaturation = saturated.slice(),
        gains = [1.75, 1, 1.25],
        expected = new Float32Array(width * height * 4),
        luminance = new Float64Array(width * height),
        coordinates = new Set<number>()
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          let clipped = false
          const camera = [0, 0, 0]
          for (let c = 0; c < 3; c++) {
            let value = 0
            for (const tap of taps(frame, plan, x, y, c)) {
              const at = tap.y * frame.width + tap.x,
                cx = (frame.width - 1) / 2,
                cy = (frame.height - 1) / 2,
                gain = radial(plan.lut, Math.hypot(tap.x - cx, tap.y - cy) / Math.hypot(cx, cy), 3)
              coordinates.add(at)
              value += frame.data[at * 4 + c] * tap.weight * gain
              if (tap.weight > 0 && saturated[at]) clipped = true
            }
            camera[c] =
              (((value * Math.max(...frame.normalization!.gains)) / frame.normalization!.gains[c]) *
                gains[c]) /
              Math.min(...gains)
          }
          const srgb = [0, 1, 2].map(
              (c) =>
                frame.matrix[c * 4] * camera[0] +
                frame.matrix[c * 4 + 1] * camera[1] +
                frame.matrix[c * 4 + 2] * camera[2],
            ),
            rgb = [0, 1, 2].map(
              (c) =>
                SRGB_TO_2020[c * 3] * srgb[0] +
                SRGB_TO_2020[c * 3 + 1] * srgb[1] +
                SRGB_TO_2020[c * 3 + 2] * srgb[2],
            ),
            at = y * width + x
          expected.set([...rgb, Number(!clipped)], at * 4)
          luminance[at] = Math.max(
            0,
            rgb[0] * REC2020_LUMINANCE[0] +
              rgb[1] * REC2020_LUMINANCE[1] +
              rgb[2] * REC2020_LUMINANCE[2],
          )
        }
      expect(coordinates.size).toBeGreaterThan(2048)
      expect(expected.some((v, i) => i % 4 === 3 && v === 0)).toBe(true)
      expect(expected.some((v, i) => i % 4 === 3 && v === 1)).toBe(true)
      for (const entries of [2048, 32768] as const) {
        process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES = String(entries)
        const work = measurement(),
          kernel = await createPreparationKernel(frame, plan, saturated, gains, work, module)
        expect(kernel).toBeDefined()
        try {
          // The larger portrait fixture necessarily exercises replacement at
          // either capacity, rather than only filling an otherwise empty cache.
          if (flip === 5) expect(coordinates.size).toBeGreaterThan(entries)
          for (let top = 0; top < height; top += 64) {
            const rows = Math.min(64, height - top),
              result = kernel!.convert(top, rows),
              first = top * width,
              last = (top + rows) * width
            expect(bytes(result.pixels).equals(bytes(expected.subarray(first * 4, last * 4)))).toBe(
              true,
            )
            expect(bytes(result.luminance).equals(bytes(luminance.subarray(first, last)))).toBe(
              true,
            )
          }
          expect(work.backend).toBe('wasm-simd')
          expect(work.gainCacheEntries).toBe(entries)
          expect(work.heapBytes).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
          expect(() => kernel!.convert(1, 64)).toThrow('Invalid')
        } finally {
          kernel!.close()
        }
      }
      expect(bytes(frame.data).equals(original)).toBe(true)
      expect(saturated).toEqual(originalSaturation)
    }
    expect(getMergeKernelHeapBytes()).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
  } finally {
    if (originalCacheEntries === undefined) delete process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES
    else process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES = originalCacheEntries
  }
})

test('gain cache capacity defaults to 32768 and rejects unsupported allocations', async () => {
  const module = await readMergeKernel(vendor),
    { frame, plan } = fixture(5),
    saturated = new Uint8Array(frame.width * frame.height),
    original = process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES
  expect(module).toBeDefined()
  const instance = new WebAssembly.Instance(module!, { env: { hypot: Math.hypot } }),
    kernelExports = instance.exports as unknown as {
      memory: WebAssembly.Memory
      __heap_base: WebAssembly.Global
      irodori_kernel_version(): number
      irodori_prepare_strip(config: number, top: number, rows: number): number
    },
    configAt = Number(kernelExports.__heap_base.value),
    config = new Float64Array(kernelExports.memory.buffer, configAt, 32)
  expect(kernelExports.irodori_kernel_version()).toBe(5)
  // ABI5 validates slot27 before any strip pointer can be read. An invalid
  // capacity must never index the caller's smaller allocation with a larger mask.
  for (const invalid of [0, 2049, 16384, 32767, 65536, NaN]) {
    config[27] = invalid
    expect(kernelExports.irodori_prepare_strip(configAt, 0, 1)).toBe(4)
  }
  for (const entries of [2048, 32768]) {
    config[27] = entries
    expect(kernelExports.irodori_prepare_strip(configAt, 0, 1)).toBe(3)
  }
  try {
    delete process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES
    const work = measurement(),
      kernel = await createPreparationKernel(frame, plan, saturated, [1, 1, 1], work, module)
    expect(kernel).toBeDefined()
    kernel!.close()
    expect(work.gainCacheEntries).toBe(32768)
    for (const invalid of ['0', '2049', '16384', '32767', '65536', 'NaN']) {
      process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES = invalid
      const fallback = measurement()
      expect(
        await createPreparationKernel(frame, plan, saturated, [1, 1, 1], fallback, module),
      ).toBeUndefined()
      expect(fallback.backend).toBe('scalar')
      expect(fallback.gainCacheEntries).toBeUndefined()
    }
  } finally {
    if (original === undefined) delete process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES
    else process.env.IRODORI_MERGE_GAIN_CACHE_ENTRIES = original
  }
})

test('scalar controls and unsupported input retain the existing preparation path', async () => {
  const module = await readMergeKernel(vendor),
    { frame, raw, plan } = fixture(5),
    original = process.env.IRODORI_MERGE_CPU_KERNEL
  expect(module).toBeDefined()
  try {
    process.env.IRODORI_MERGE_CPU_KERNEL = 'scalar'
    expect(await createCameraKernel(raw, plan, Array(9).fill(0), measurement())).toBeUndefined()
    expect(
      await createPreparationKernel(
        frame,
        plan,
        new Uint8Array(frame.width * frame.height),
        [1, 1, 1],
        measurement(),
      ),
    ).toBeUndefined()
  } finally {
    if (original === undefined) delete process.env.IRODORI_MERGE_CPU_KERNEL
    else process.env.IRODORI_MERGE_CPU_KERNEL = original
  }
  expect(await createCameraKernel(raw, plan, [NaN], measurement(), module)).toBeUndefined()
  expect(
    await createPreparationKernel(frame, plan, new Uint8Array(1), [1, 1, 1], measurement(), module),
  ).toBeUndefined()
  expect(
    await createCameraKernel(
      raw,
      { ...plan, left: raw.width },
      Array(9).fill(0),
      measurement(),
      module,
    ),
  ).toBeUndefined()
})

test('camera writer accelerates 256-row GPU chunks with exact scalar bytes, hashes and planes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-camera-kernel-chunks-')),
    original = process.env.IRODORI_MERGE_CPU_KERNEL
  let index = 0
  try {
    for (const clipped of [false, true]) {
      const { raw, plan } = fixture(5, 331, 93),
        width = plan.height,
        height = plan.width,
        rgba = Float32Array.from({ length: width * height * 4 }, (_, i) =>
          i % 4 === 3 ? 1 : (i % 31) / 17 - 0.2,
        ),
        originalPixels = Buffer.from(bytes(rgba))
      raw.normalization!.sourceSaturation!.saturatedSites = Number(clipped)
      if (clipped) raw.pixels[(11 + raw.top) * raw.rawWidth + 16 + raw.left] = 4000
      expect(height).toBeGreaterThan(256)
      expect(height % 64).toBeGreaterThan(0)
      const runs = []
      for (const [backend, rows] of [
        ['scalar', 256],
        ['wasm', 64],
        ['wasm', 128],
        ['wasm', 256],
      ] as const) {
        process.env.IRODORI_MERGE_CPU_KERNEL = backend
        const work = measurement(),
          writer = await cameraRegistrationWriter(directory, index++, raw, plan, 7, 11, work)
        try {
          for (let top = 0; top < height; top += rows) {
            const strip = rgba.subarray(top * width * 4, Math.min(top + rows, height) * width * 4)
            await writer.write(top, bytes(strip))
          }
          const result = await writer.finish(),
            native = await readFile(result.path)
          runs.push({ result, native, work })
          expect(native.byteLength).toBe(rgba.byteLength)
          expect(result.strips).toEqual(
            Array.from({ length: Math.ceil(height / 64) }, (_, strip) =>
              createHash('sha256')
                .update(native.subarray(strip * 64 * width * 16, (strip + 1) * 64 * width * 16))
                .digest('hex'),
            ),
          )
          expect(work.backend).toBe(backend === 'wasm' ? 'wasm-simd' : 'scalar')
          if (backend === 'wasm') {
            expect(work.copyMs).toBeGreaterThan(0)
            expect(work.processingMs).toBeGreaterThan(0)
            expect(work.heapBytes).toBeGreaterThan(0)
            expect(work.heapBytes).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
          }
        } finally {
          await writer.close()
        }
      }
      for (const run of runs.slice(1)) {
        expect(run.native.equals(runs[0].native)).toBe(true)
        expect(run.result.strips).toEqual(runs[0].result.strips)
        expect(run.result.planes).toEqual(runs[0].result.planes)
        expect(run.work.heapBytes).toBe(runs[1].work.heapBytes)
      }
      const native = new Float32Array(
        runs[0].native.buffer,
        runs[0].native.byteOffset,
        runs[0].native.length / 4,
      )
      expect(native.some((value, i) => i % 4 === 3 && value !== 7)).toBe(clipped)
      expect(bytes(rgba).equals(originalPixels)).toBe(true)
    }
  } finally {
    if (original === undefined) delete process.env.IRODORI_MERGE_CPU_KERNEL
    else process.env.IRODORI_MERGE_CPU_KERNEL = original
    await rm(directory, { recursive: true, force: true })
  }
})

test('simultaneous kernel arenas respect the aggregate cap and release ownership', async () => {
  const module = await readMergeKernel(vendor),
    { raw, plan } = fixture(5),
    inverse = [1, 0, 0, 0, 1, 0, 0, 0, 1],
    held: NonNullable<Awaited<ReturnType<typeof createCameraKernel>>>[] = []
  expect(module).toBeDefined()
  try {
    // Exercise simultaneous initialization at the cap, including callers that
    // await the same compiled module. No arena grows after its views are borrowed.
    const attempts = await Promise.all(
      Array.from({ length: 70 }, () =>
        createCameraKernel(raw, plan, inverse, measurement(), module),
      ),
    )
    for (const kernel of attempts) if (kernel) held.push(kernel)
    expect(held.length).toBeGreaterThan(0)
    expect(held.length).toBeLessThan(attempts.length)
    expect(getMergeKernelHeapBytes()).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
    const width = plan.height,
      strip = Float32Array.from({ length: width * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0.125))
    expect(held[0].convert(0, strip)[0]).toBe(0.125)
  } finally {
    for (const kernel of held) kernel.close()
  }
  const reopened = await createCameraKernel(raw, plan, inverse, measurement(), module)
  expect(reopened).toBeDefined()
  reopened!.close()
})

test('flattened footprints retain exact weights, order and final contributing rows', () => {
  for (const [native, reduced] of [
    [139, 7],
    [331, 139],
    [71, 71],
    [17, 1],
  ]) {
    const expected = areaContributions(native, reduced),
      flat = flattenedAreaContributions(native, reduced)
    for (let i = 0; i < native; i++) {
      const actual: [number, number][] = []
      for (let k = flat.offsets[i]; k < flat.offsets[i + 1]; k++)
        actual.push([flat.targets[k], flat.weights[k]])
      expect(actual).toEqual(expected[i])
    }
    for (let target = 0; target < reduced; target++) {
      let last = -1
      for (let i = 0; i < expected.length; i++)
        if (expected[i].some(([p]) => p === target)) last = i
      expect(flat.last[target]).toBe(last)
    }
  }
})

test('compiled camera and luminance reducers preserve ordered Float64 and per-update Float32 bytes', async () => {
  const module = await readMergeKernel(vendor),
    inverse = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  expect(module).toBeDefined()
  for (const flip of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const { raw, frame, plan } = fixture(flip, 139, 71),
      width = flip & 4 ? plan.height : plan.width,
      height = flip & 4 ? plan.width : plan.height,
      reduced = { width: 7, height: 11 },
      saturated = Uint8Array.from({ length: frame.width * frame.height }, (_, i) =>
        Number(i % 101 === 0),
      ),
      input = Float32Array.from({ length: width * height * 4 }, (_, i) =>
        i % 4 === 3
          ? 1
          : [0, -1, Math.fround(MERGE_LIMITS.readNoise * 3), 0.0044999993, 0.0045000007, 1e8, 7][
              i % 7
            ],
      ),
      camera = await createCameraKernel(raw, plan, inverse, measurement(), module, reduced),
      preparation = await createPreparationKernel(
        frame,
        plan,
        saturated,
        [1.75, 1, 1.25],
        measurement(),
        module,
        reduced,
      )
    expect(camera?.reduction).toBeDefined()
    expect(preparation?.reduction).toBeDefined()
    const cameraPixels = new Float32Array(input.length),
      preparedPixels = new Float32Array(input.length),
      luminance = new Float64Array(width * height)
    try {
      for (let c = 0; c < 3; c++)
        for (let i = 0; i < raw.width * raw.height; i++)
          camera!.masks![c][i] = Number((i + c * 11) % 127 === 0)
      for (let top = 0; top < height; top += 64) {
        const rows = Math.min(64, height - top),
          output = camera!.convert(top, input.subarray(top * width * 4, (top + rows) * width * 4)),
          prepared = preparation!.convert(top, rows)
        cameraPixels.set(output, top * width * 4)
        preparedPixels.set(prepared.pixels, top * width * 4)
        luminance.set(prepared.luminance, top * width)
        camera!.reduction!.add(top, output)
        preparation!.reduction!.add(top, prepared.pixels, prepared.luminance)
      }
      expect(camera!.reduction!.finish()).toEqual(
        referenceReduction(cameraPixels, undefined, width, height, reduced.width, reduced.height),
      )
      expect(preparation!.reduction!.finish()).toEqual(
        referenceReduction(preparedPixels, luminance, width, height, reduced.width, reduced.height),
      )
    } finally {
      camera?.close()
      preparation?.close()
    }
  }
  const width = 29,
    height = 139,
    reduced = { width: 6, height: 5 },
    pixels = Float32Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0.5)),
    luminance = Float64Array.from({ length: width * height }, (_, i) => 1e8 + (i % 17)),
    scalar = createAreaReducer(width, height, reduced, 'luminance')
  for (let top = 0; top < height; top += 64) {
    const last = Math.min(height, top + 64) * width
    scalar.add(
      top,
      pixels.subarray(top * width * 4, last * 4),
      luminance.subarray(top * width, last),
    )
  }
  const exact = referenceReduction(pixels, luminance, width, height, reduced.width, reduced.height),
    double = referenceReduction(
      pixels,
      luminance,
      width,
      height,
      reduced.width,
      reduced.height,
      true,
    )
  expect(scalar.finish()).toEqual(exact)
  expect(bytes(exact[0].data).equals(bytes(double[0].data))).toBe(false)
  expect(() =>
    scalar.add(height, pixels.subarray(0, width * 4), luminance.subarray(0, width)),
  ).toThrow('Invalid')
  expect(() => createAreaReducer(width, height, { width: width + 1, height }, 'luminance')).toThrow(
    'geometry',
  )
})

test('late reducer status, traps and malformed emissions restore live rows before scalar replay', async () => {
  const module = await readMergeKernel(vendor),
    Instance = WebAssembly.Instance
  expect(module).toBeDefined()
  for (const failure of ['status', 'trap', 'emission'] as const)
    for (const mode of ['camera', 'luminance'] as const) {
      const { raw, frame, plan } = fixture(0, 139, 331),
        width = plan.width,
        height = plan.height,
        reduced = { width: 7, height: 11 },
        pixels = Float32Array.from({ length: width * height * 4 }, (_, i) =>
          i % 4 === 3 ? (mode === 'camera' ? 7 : 1) : (i % 31) / 17 + 0.02,
        ),
        luminance =
          mode === 'luminance'
            ? Float64Array.from({ length: width * height }, (_, i) => 1e8 + (i % 17))
            : undefined
      raw.normalization!.sourceSaturation!.saturatedSites = 0
      let calls = 0,
        kernel:
          | Awaited<ReturnType<typeof createCameraKernel>>
          | Awaited<ReturnType<typeof createPreparationKernel>>
      try {
        WebAssembly.Instance = function (code: WebAssembly.Module, imports?: WebAssembly.Imports) {
          const instance = new Instance(code, imports),
            original = instance.exports.irodori_reduce_strip as (
              config: number,
              top: number,
              rows: number,
            ) => number,
            exports = {
              ...instance.exports,
              irodori_reduce_strip(configAt: number, top: number, rows: number) {
                const status = original(configAt, top, rows)
                if (++calls !== 2) return status
                if (failure === 'trap')
                  throw new WebAssembly.RuntimeError('Injected late reduction trap.')
                if (failure === 'emission') {
                  const memory = instance.exports.memory as WebAssembly.Memory,
                    config = new Float64Array(memory.buffer, configAt, 48)
                  expect(config[21]).toBeGreaterThan(0)
                  new Int32Array(memory.buffer, config[20], config[22])[config[21] - 1] = height
                  return status
                }
                return 5
              },
            }
          return new Proxy(instance, {
            get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
          })
        } as unknown as typeof WebAssembly.Instance
        kernel =
          mode === 'camera'
            ? await createCameraKernel(
                raw,
                plan,
                [1, 0, 0, 0, 1, 0, 0, 0, 1],
                measurement(),
                module,
                reduced,
              )
            : await createPreparationKernel(
                frame,
                plan,
                new Uint8Array(raw.width * raw.height),
                [1, 1, 1],
                measurement(),
                module,
                reduced,
              )
      } finally {
        WebAssembly.Instance = Instance
      }
      expect(kernel?.reduction).toBeDefined()
      try {
        expect(() => kernel!.reduction!.finish()).toThrow('Incomplete')
        for (let top = 0; top < height; top += 64)
          kernel!.reduction!.add(
            top,
            pixels.subarray(top * width * 4, Math.min(top + 64, height) * width * 4),
            luminance?.subarray(top * width, Math.min(top + 64, height) * width),
          )
        expect(kernel!.reduction!.finish()).toEqual(
          referenceReduction(pixels, luminance, width, height, reduced.width, reduced.height),
        )
        expect(calls).toBe(2)
      } finally {
        kernel?.close()
      }
    }
})

test('compiled sensor masks and canonical repair retain threshold, orientation and producer boundaries', async () => {
  const module = await readMergeKernel(vendor)
  expect(module).toBeDefined()
  for (const flip of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const { raw, frame, plan } = fixture(flip, 331, 139)
    raw.normalization!.sourceSaturation!.thresholds = [3800, 3799, 3801, 3798]
    for (let y = 0; y < raw.height; y++)
      for (let x = 0; x < raw.width; x++) {
        const c = raw.cfa[(y & 1) * 2 + (x & 1)],
          at = (y + raw.top) * raw.rawWidth + raw.left + x
        raw.pixels[at] =
          raw.normalization!.sourceSaturation!.thresholds[c] + ((x * 7 + y * 11) % 101 < 3 ? 0 : -1)
      }
    const original = raw.pixels.slice(),
      expected = referenceSensorMasks(raw),
      canonical = await createSensorClippingMask(raw, measurement(), module),
      camera = await createCameraKernel(
        raw,
        plan,
        [1, 0, 0, 0, 1, 0, 0, 0, 1],
        measurement(),
        module,
      ),
      repair = await createMaskRepairKernel(raw, plan, expected.canonical, measurement(), module),
      width = flip & 4 ? plan.height : plan.width,
      height = flip & 4 ? plan.width : plan.height
    expect(canonical).toEqual(expected.canonical)
    expect(camera).toBeDefined()
    expect(repair).toBeDefined()
    try {
      expect(camera!.populateMasks()).toEqual(expected.channels)
      for (const batch of [64, 128, 256]) {
        const alpha = new Uint32Array(Math.ceil((width * height) / 32)),
          expectedAlpha = new Uint32Array(alpha.length)
        for (let top = 0; top < height; top += batch) {
          const rows = Math.min(batch, height - top),
            pixels = Float32Array.from({ length: width * rows * 4 }, (_, i) =>
              i % 4 === 3
                ? Number((Math.floor(i / 4 / width) + top) % 97 > 45)
                : (i % 31) / 17 - 0.2,
            ),
            scalar = pixels.slice(),
            changed = referenceRepair(scalar, top, frame, plan, expected.canonical, expectedAlpha)
          expect(repair!.repair(top, pixels, alpha)).toEqual(changed)
          expect(bytes(pixels).equals(bytes(scalar))).toBe(true)
          expect(alpha).toEqual(expectedAlpha)
        }
      }
      expect(raw.pixels).toEqual(original)
      expect(() =>
        repair!.repair(
          height,
          new Float32Array(width * 4),
          new Uint32Array(Math.ceil((width * height) / 32)),
        ),
      ).toThrow('Invalid')
    } finally {
      camera?.close()
      repair?.close()
    }
  }
  const { raw } = fixture(0)
  raw.normalization!.sourceSaturation!.saturatedSites = 0
  expect(await createSensorClippingMask(raw, measurement(), module)).toEqual(
    new Uint8Array(raw.width * raw.height),
  )
})

test('reduction allocation pressure retains compiled conversion and bounded scalar rows', async () => {
  const module = await readMergeKernel(vendor),
    small = fixture(0),
    large = fixture(0, 1500, 1000),
    inverse = [1, 0, 0, 0, 1, 0, 0, 0, 1],
    held: NonNullable<Awaited<ReturnType<typeof createCameraKernel>>>[] = [],
    Instance = WebAssembly.Instance
  expect(module).toBeDefined()
  small.raw.normalization!.sourceSaturation!.saturatedSites = 0
  large.raw.normalization!.sourceSaturation!.saturatedSites = 0
  let candidate: Awaited<ReturnType<typeof createCameraKernel>>,
    reductions = 0
  try {
    const attempts = await Promise.all(
      Array.from({ length: 62 }, () =>
        createCameraKernel(small.raw, small.plan, inverse, measurement(), module),
      ),
    )
    for (const kernel of attempts) if (kernel) held.push(kernel)
    expect(held).toHaveLength(62)
    const work = measurement()
    try {
      WebAssembly.Instance = function (code: WebAssembly.Module, imports?: WebAssembly.Imports) {
        const instance = new Instance(code, imports),
          original = instance.exports.irodori_reduce_strip as (...args: number[]) => number,
          exports = {
            ...instance.exports,
            irodori_reduce_strip(...args: number[]) {
              reductions++
              return original(...args)
            },
          }
        return new Proxy(instance, {
          get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
        })
      } as unknown as typeof WebAssembly.Instance
      candidate = await createCameraKernel(large.raw, large.plan, inverse, work, module, {
        width: large.plan.width,
        height: large.plan.height,
      })
    } finally {
      WebAssembly.Instance = Instance
    }
    expect(candidate?.reduction).toBeDefined()
    expect(work.backend).toBe('wasm-simd')
    expect(work.heapBytes).toBeLessThanOrEqual(4 * 1024 ** 2)
    const maskWork = measurement()
    expect(
      await createMaskRepairKernel(
        large.raw,
        large.plan,
        new Uint8Array(large.raw.width * large.raw.height),
        maskWork,
        module,
      ),
    ).toBeUndefined()
    expect(maskWork.backend).toBe('scalar')
    // Conversion keeps its arena while additional mask work declines admission.
    const sensor = {
      ...large.raw,
      height: 1500,
      pixels: new Uint16Array(large.raw.rawWidth * 1502),
      normalization: {
        ...large.raw.normalization!,
        sourceSaturation: { ...large.raw.normalization!.sourceSaturation!, saturatedSites: 1 },
      },
    }
    expect(await createSensorClippingMask(sensor, measurement(), module)).toBeUndefined()
    expect(
      await createCameraKernel(
        sensor,
        { ...large.plan, height: 1500, top: 0 },
        inverse,
        measurement(),
        module,
      ),
    ).toBeUndefined()
    const width = large.plan.width,
      height = large.plan.height,
      input = Float32Array.from({ length: width * 64 * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0.125))
    for (let top = 0; top < height; top += 64) {
      const output = candidate!.convert(
        top,
        input.subarray(0, Math.min(64, height - top) * width * 4),
      )
      candidate!.reduction!.add(top, output)
    }
    for (const plane of candidate!.reduction!.finish()) {
      expect(plane.data.every((value) => value === 0.125)).toBe(true)
      expect(plane.mask!.every((value) => value === 255)).toBe(true)
    }
    expect(reductions).toBe(0)
    expect(getMergeKernelHeapBytes()).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
  } finally {
    WebAssembly.Instance = Instance
    candidate?.close()
    for (const kernel of held) kernel.close()
  }
})

test('failed canonical repair publishes no partial RGB, alpha or changed positions', async () => {
  const module = await readMergeKernel(vendor),
    { raw, frame, plan } = fixture(5, 331, 139),
    width = plan.height,
    height = plan.width,
    saturated = Uint8Array.from({ length: raw.width * raw.height }, (_, i) => Number(i % 37 === 0)),
    Instance = WebAssembly.Instance
  expect(module).toBeDefined()
  let repair: Awaited<ReturnType<typeof createMaskRepairKernel>>
  try {
    WebAssembly.Instance = function (code: WebAssembly.Module, imports?: WebAssembly.Imports) {
      const instance = new Instance(code, imports),
        original = instance.exports.irodori_repair_mask as (...args: number[]) => number,
        exports = {
          ...instance.exports,
          irodori_repair_mask(...args: number[]) {
            original(...args)
            return 5
          },
        }
      return new Proxy(instance, {
        get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
      })
    } as unknown as typeof WebAssembly.Instance
    repair = await createMaskRepairKernel(raw, plan, saturated, measurement(), module)
  } finally {
    WebAssembly.Instance = Instance
  }
  expect(repair).toBeDefined()
  try {
    const rows = Math.min(256, height),
      pixels = Float32Array.from({ length: rows * width * 4 }, (_, i) =>
        i % 4 === 3 ? 1 : (i % 17) / 11,
      ),
      original = pixels.slice(),
      alpha = new Uint32Array(Math.ceil((width * height) / 32)),
      expectedAlpha = alpha.slice(),
      scalar = pixels.slice()
    expect(() => repair!.repair(0, pixels, alpha)).toThrow('failed')
    expect(pixels).toEqual(original)
    expect(alpha).toEqual(expectedAlpha)
    const changed = referenceRepair(scalar, 0, frame, plan, saturated, expectedAlpha)
    expect(changed.length).toBeGreaterThan(0)
    expect(bytes(scalar).equals(bytes(original))).toBe(false)
  } finally {
    repair?.close()
  }
})

test('camera validity strips retain exact channel masks without RGB projection for every orientation', async () => {
  const module = await readMergeKernel(vendor),
    previous = process.env.IRODORI_MERGE_CPU_KERNEL,
    Instance = WebAssembly.Instance
  expect(module).toBeDefined()
  try {
    for (const flip of [0, 1, 2, 3, 4, 5, 6, 7])
      for (const clipped of [false, true]) {
        const { raw, frame, plan } = fixture(flip, 331, 139),
          width = flip & 4 ? plan.height : plan.width,
          height = flip & 4 ? plan.width : plan.height
        raw.normalization!.sourceSaturation!.saturatedSites = Number(clipped)
        raw.normalization!.sourceSaturation!.thresholds = [3800, 3799, 3801, 3798]
        for (let y = 0; y < raw.height; y++)
          for (let x = 0; x < raw.width; x++) {
            const channel = raw.cfa[(y & 1) * 2 + (x & 1)]
            raw.pixels[(y + raw.top) * raw.rawWidth + raw.left + x] =
              raw.normalization!.sourceSaturation!.thresholds[channel] +
              (clipped && (x * 7 + y * 11) % 127 < 3 ? 0 : -1)
          }
        const original = raw.pixels.slice(),
          channels = referenceSensorMasks(raw).channels,
          expected = new Uint8Array(width * height),
          // Validity must never inspect the matrix or project native RGB.
          maskRaw = { ...raw, matrix: Array(12).fill(NaN) },
          work = measurement(),
          kernel = await createCameraValidityKernel(maskRaw, plan, work, module)
        expect(kernel).toBeDefined()
        try {
          expect(kernel!.populateMasks()).toEqual(clipped ? channels : undefined)
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              let valid = 7
              for (let c = 0; c < 3; c++)
                if (
                  clipped &&
                  taps(frame, plan, x, y, c).some(
                    (tap) => tap.weight > 0 && channels[c][tap.y * raw.width + tap.x],
                  )
                )
                  valid &= ~(1 << c)
              expected[y * width + x] = valid
            }
          for (let top = 0; top < height; top += 64) {
            const rows = Math.min(64, height - top)
            expect(kernel!.read(top, rows)).toEqual(
              expected.subarray(top * width, (top + rows) * width),
            )
          }
          expect(work.backend).toBe('wasm-simd')
          expect(work.heapBytes).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
        } finally {
          kernel?.close()
        }
        let validityCalls = 0,
          projectionCalls = 0
        for (const backend of ['scalar', 'wasm']) {
          process.env.IRODORI_MERGE_CPU_KERNEL = backend
          let provider: Awaited<ReturnType<typeof createCameraValidityProvider>>
          try {
            WebAssembly.Instance = function (
              code: WebAssembly.Module,
              imports?: WebAssembly.Imports,
            ) {
              const instance = new Instance(code, imports),
                validity = instance.exports.irodori_camera_validity_strip as (
                  ...args: number[]
                ) => number,
                exports = {
                  ...instance.exports,
                  irodori_camera_validity_strip(...args: number[]) {
                    validityCalls++
                    return validity(...args)
                  },
                  irodori_camera_strip() {
                    projectionCalls++
                    throw new Error('Validity must not project RGB.')
                  },
                }
              return new Proxy(instance, {
                get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
              })
            } as unknown as typeof WebAssembly.Instance
            provider = await createCameraValidityProvider(maskRaw, plan)
          } finally {
            WebAssembly.Instance = Instance
          }
          try {
            expect([provider!.width, provider!.height]).toEqual([width, height])
            for (let top = 0; top < height; top += 64) {
              const rows = Math.min(64, height - top)
              expect(provider!.read(top, rows)).toEqual(
                expected.subarray(top * width, (top + rows) * width),
              )
            }
            expect(provider!.read(1, 5)).toEqual(expected.subarray(width, 6 * width))
            const borrowed = provider!.read(0, 1)
            expect(provider!.read(1, 1).buffer).toBe(borrowed.buffer)
            for (const [top, rows] of [
              [-1, 1],
              [0, 0],
              [0, 65],
              [height, 1],
              [1.5, 1],
            ])
              expect(() => provider!.read(top, rows)).toThrow('Invalid')
          } finally {
            provider!.close()
            provider!.close()
          }
          expect(() => provider!.read(0, 1)).toThrow('closed')
        }
        expect(validityCalls).toBeGreaterThan(0)
        expect(projectionCalls).toBe(0)
        expect(raw.pixels).toEqual(original)
        expect(() => cameraRegistrationInverse(maskRaw)).toThrow('invertible')
      }
  } finally {
    WebAssembly.Instance = Instance
    if (previous === undefined) delete process.env.IRODORI_MERGE_CPU_KERNEL
    else process.env.IRODORI_MERGE_CPU_KERNEL = previous
  }
})

test('late mask-only failures replay exact validity and rebuild partial sensor masks transactionally', async () => {
  const module = await readMergeKernel(vendor),
    previous = process.env.IRODORI_MERGE_CPU_KERNEL,
    Instance = WebAssembly.Instance
  expect(module).toBeDefined()
  process.env.IRODORI_MERGE_CPU_KERNEL = 'wasm'
  try {
    for (const stage of ['sensor', 'validity'] as const)
      for (const failure of ['status', 'trap'] as const) {
        const { raw, frame, plan } = fixture(5, 331, 139),
          width = plan.height,
          height = plan.width
        for (let y = 0; y < raw.height; y++)
          for (let x = 0; x < raw.width; x++)
            raw.pixels[(y + raw.top) * raw.rawWidth + raw.left + x] =
              (x * 7 + y * 11) % 101 < 3 ? 3800 : 3799
        const channels = referenceSensorMasks(raw).channels,
          work = measurement(),
          actual = new Uint8Array(width * height),
          expected = new Uint8Array(width * height)
        let sensorCalls = 0,
          validityCalls = 0,
          provider: Awaited<ReturnType<typeof createCameraValidityProvider>>
        const fail = () => {
          if (failure === 'trap') throw new WebAssembly.RuntimeError('Injected late mask trap.')
          return 5
        }
        try {
          WebAssembly.Instance = function (
            code: WebAssembly.Module,
            imports?: WebAssembly.Imports,
          ) {
            const instance = new Instance(code, imports),
              sensor = instance.exports.irodori_sensor_mask as (...args: number[]) => number,
              validity = instance.exports.irodori_camera_validity_strip as (
                ...args: number[]
              ) => number,
              exports = {
                ...instance.exports,
                irodori_sensor_mask(...args: number[]) {
                  const status = sensor(...args)
                  sensorCalls++
                  return stage === 'sensor' && sensorCalls === 2 ? fail() : status
                },
                irodori_camera_validity_strip(...args: number[]) {
                  const status = validity(...args)
                  validityCalls++
                  if (stage === 'validity' && validityCalls === 2) {
                    const memory = instance.exports.memory as WebAssembly.Memory,
                      config = new Float64Array(memory.buffer, args[0], 48)
                    new Uint8Array(memory.buffer, config[13], width * args[2]).fill(0)
                    return fail()
                  }
                  return status
                },
              }
            return new Proxy(instance, {
              get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
            })
          } as unknown as typeof WebAssembly.Instance
          provider = await createCameraValidityProvider(raw, plan, work)
        } finally {
          WebAssembly.Instance = Instance
        }
        try {
          for (let top = 0; top < height; top += 64)
            actual.set(provider!.read(top, Math.min(64, height - top)), top * width)
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              let valid = 7
              for (let c = 0; c < 3; c++)
                if (
                  taps(frame, plan, x, y, c).some(
                    (tap) => tap.weight > 0 && channels[c][tap.y * raw.width + tap.x],
                  )
                )
                  valid &= ~(1 << c)
              expected[y * width + x] = valid
            }
          expect(actual).toEqual(expected)
          if (stage === 'validity') {
            expect(validityCalls).toBe(2)
            expect(work.backend).toBe('scalar')
          } else {
            expect(sensorCalls).toBe(2)
            expect(validityCalls).toBe(Math.ceil(height / 64))
          }
        } finally {
          provider!.close()
        }
      }
  } finally {
    WebAssembly.Instance = Instance
    if (previous === undefined) delete process.env.IRODORI_MERGE_CPU_KERNEL
    else process.env.IRODORI_MERGE_CPU_KERNEL = previous
  }
})

test('fallback geometry preserves Float64 tap selection and union alpha without RGB or neighbor gain work', async () => {
  const module = await readMergeKernel(vendor),
    previous = process.env.IRODORI_MERGE_CPU_KERNEL,
    Instance = WebAssembly.Instance
  expect(module).toBeDefined()
  try {
    for (const flip of [0, 1, 2, 3, 4, 5, 6, 7])
      for (const corrected of [false, true]) {
        const data = fixture(flip),
          frame = data.frame,
          plan = corrected
            ? data.plan
            : {
                ...data.plan,
                left: 0,
                top: 0,
                width: frame.width,
                height: frame.height,
                lut: Float32Array.from({ length: 4096 * 4 }, () => 1),
              },
          width = flip & 4 ? plan.height : plan.width,
          height = flip & 4 ? plan.width : plan.height,
          saturated = Uint8Array.from({ length: frame.width * frame.height }, (_, i) =>
            Number(i % 113 === 0),
          ),
          original = saturated.slice(),
          minimal = { width: frame.width, height: frame.height, flip },
          reduced = { width: 7, height: 11 },
          fullRgba = new Float32Array(width * height * 4),
          fullLuminance = Float64Array.from({ length: width * height }, (_, i) => 1e8 + (i % 17))
        let plannerCalls = 0,
          hypotCalls = 0,
          provider: Awaited<ReturnType<typeof createFallbackGeometryProvider>>
        try {
          WebAssembly.Instance = function (
            code: WebAssembly.Module,
            imports?: WebAssembly.Imports,
          ) {
            const instance = new Instance(code, {
                ...imports,
                env: {
                  ...imports?.env,
                  hypot: (x: number, y: number) => {
                    hypotCalls++
                    return Math.hypot(x, y)
                  },
                },
              }),
              planner = instance.exports.irodori_fallback_geometry_strip as (
                ...args: number[]
              ) => number,
              exports = {
                ...instance.exports,
                irodori_fallback_geometry_strip(...args: number[]) {
                  plannerCalls++
                  return planner(...args)
                },
              }
            return new Proxy(instance, {
              get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
            })
          } as unknown as typeof WebAssembly.Instance
          provider = await createFallbackGeometryProvider(
            minimal,
            plan,
            saturated,
            measurement(),
            module,
            reduced,
          )
        } finally {
          WebAssembly.Instance = Instance
        }
        try {
          expect(provider!.reduction).toBeDefined()
          for (let top = 0; top < height; top += 64) {
            const rows = Math.min(64, height - top),
              expected = referenceFallbackGeometry(frame, plan, saturated, top, rows),
              result = provider!.read(top, rows)
            expect(result.geometry).toEqual(expected.geometry)
            expect(result.alpha).toEqual(expected.alpha)
            const floats = new Float32Array(
                result.geometry.buffer,
                result.geometry.byteOffset,
                result.geometry.length,
              ),
              integers = new Int32Array(
                result.geometry.buffer,
                result.geometry.byteOffset,
                result.geometry.length,
              )
            for (const [x, y] of [
              [0, top],
              [width - 1, top + rows - 1],
            ])
              for (let c = 0; c < 3; c++) {
                const exact = provider!.coordinate(x, y, c),
                  at =
                    ((y - top) * width + x) * FALLBACK_GEOMETRY_PIXEL_WORDS +
                    c * FALLBACK_GEOMETRY_CHANNEL_WORDS
                expect(exact).toEqual(fallbackGeometryCoordinate(minimal, plan, x, y, c))
                expect([integers[at], integers[at + 1]]).toEqual([exact.ix, exact.iy])
                expect(Math.abs(floats[at + 2] + floats[at + 3] - exact.dx)).toBeLessThanOrEqual(
                  2 ** -48,
                )
                expect(Math.abs(floats[at + 4] + floats[at + 5] - exact.dy)).toBeLessThanOrEqual(
                  2 ** -48,
                )
              }
            const rgba = new Float32Array(width * rows * 4)
            for (let i = 0; i < result.alpha.length; i++) rgba[i * 4 + 3] = result.alpha[i]
            fullRgba.set(rgba, top * width * 4)
            provider!.reduction!.add(
              top,
              rgba,
              fullLuminance.subarray(top * width, (top + rows) * width),
            )
          }
          expect(plannerCalls).toBe(Math.ceil(height / 64))
          expect(hypotCalls).toBe(width * height)
          expect(provider!.reduction!.finish()).toEqual(
            referenceReduction(
              fullRgba,
              fullLuminance,
              width,
              height,
              reduced.width,
              reduced.height,
            ),
          )
          for (const [top, rows] of [
            [-1, 1],
            [0, 0],
            [0, 65],
            [height, 1],
            [1.5, 1],
          ])
            expect(() => provider!.read(top, rows)).toThrow('Invalid')
        } finally {
          provider!.close()
          provider!.close()
        }
        expect(() => provider!.read(0, 1)).toThrow('closed')
        expect(() => provider!.coordinate(0, 0, 0)).toThrow('closed')
        process.env.IRODORI_MERGE_CPU_KERNEL = 'scalar'
        const scalar = await createFallbackGeometryProvider(minimal, plan, saturated)
        try {
          for (let top = 0; top < height; top += 64) {
            const rows = Math.min(64, height - top),
              result = scalar.read(top, rows),
              expected = referenceFallbackGeometry(frame, plan, saturated, top, rows)
            expect(result.geometry).toEqual(expected.geometry)
            expect(result.alpha).toEqual(expected.alpha)
          }
        } finally {
          scalar.close()
        }
        expect(saturated).toEqual(original)
      }
  } finally {
    WebAssembly.Instance = Instance
    if (previous === undefined) delete process.env.IRODORI_MERGE_CPU_KERNEL
    else process.env.IRODORI_MERGE_CPU_KERNEL = previous
  }
})

test('fallback geometry late failures and aborts publish only complete independently replayed strips', async () => {
  const module = await readMergeKernel(vendor),
    Instance = WebAssembly.Instance,
    { frame, plan } = fixture(5),
    minimal = { width: frame.width, height: frame.height, flip: frame.flip },
    saturated = Uint8Array.from({ length: frame.width * frame.height }, (_, i) =>
      Number(i % 41 === 0),
    ),
    width = plan.height,
    height = plan.width
  expect(module).toBeDefined()
  for (const failure of ['status', 'trap', 'abort'] as const) {
    const abort = new AbortController(),
      work = measurement()
    let calls = 0,
      hypots = 0,
      provider: Awaited<ReturnType<typeof createFallbackGeometryProvider>>
    try {
      WebAssembly.Instance = function (code: WebAssembly.Module, imports?: WebAssembly.Imports) {
        const instance = new Instance(code, {
            ...imports,
            env: {
              ...imports?.env,
              hypot: (x: number, y: number) => {
                if (failure === 'abort' && ++hypots === 3)
                  abort.abort(new Error('Cancelled fallback geometry.'))
                return Math.hypot(x, y)
              },
            },
          }),
          planner = instance.exports.irodori_fallback_geometry_strip as (
            ...args: number[]
          ) => number,
          exports = {
            ...instance.exports,
            irodori_fallback_geometry_strip(...args: number[]) {
              const result = planner(...args)
              calls++
              if (failure !== 'abort' && calls === 2) {
                const memory = instance.exports.memory as WebAssembly.Memory,
                  config = new Float64Array(memory.buffer, args[0], 48)
                new Uint32Array(
                  memory.buffer,
                  config[13],
                  width * args[2] * FALLBACK_GEOMETRY_PIXEL_WORDS,
                ).fill(0)
                new Uint8Array(memory.buffer, config[33], width * args[2]).fill(0)
                if (failure === 'trap')
                  throw new WebAssembly.RuntimeError('Injected partial geometry trap.')
                return 5
              }
              return result
            },
          }
        return new Proxy(instance, {
          get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
        })
      } as unknown as typeof WebAssembly.Instance
      provider = await createFallbackGeometryProvider(minimal, plan, saturated, work, module)
    } finally {
      WebAssembly.Instance = Instance
    }
    try {
      if (failure === 'abort') {
        expect(() => provider!.read(0, 64, abort.signal)).toThrow('Cancelled fallback geometry')
        expect(hypots).toBeGreaterThan(3)
        expect(work.backend).toBe('wasm-simd')
      }
      let backing: ArrayBuffer | undefined
      for (let top = 0; top < height; top += 64) {
        const rows = Math.min(64, height - top),
          output = provider!.read(top, rows),
          expected = referenceFallbackGeometry(frame, plan, saturated, top, rows)
        backing ??= output.geometry.buffer
        expect(output.geometry.buffer).toBe(backing)
        expect(output.geometry).toEqual(expected.geometry)
        expect(output.alpha).toEqual(expected.alpha)
      }
      if (failure !== 'abort') {
        expect(calls).toBe(2)
        expect(work.backend).toBe('scalar')
      }
      const before = provider!.read(0, 1),
        frozen = before.geometry.slice(),
        cancelled = AbortSignal.abort(new Error('Already cancelled geometry.'))
      expect(() => provider!.read(0, 1, cancelled)).toThrow('Already cancelled geometry')
      expect(before.geometry).toEqual(frozen)
    } finally {
      provider!.close()
    }
  }
})

test('fallback geometry allocation preflight preserves compiled planning when optional luminance reduction misses', async () => {
  const module = await readMergeKernel(vendor),
    Instance = WebAssembly.Instance,
    small = fixture(0),
    large = fixture(0, 700, 100),
    held: NonNullable<Awaited<ReturnType<typeof createCameraKernel>>>[] = [],
    minimal = { width: large.frame.width, height: large.frame.height, flip: large.frame.flip },
    width = large.plan.width,
    height = large.plan.height,
    saturated = new Uint8Array(minimal.width * minimal.height),
    work = measurement(),
    reduced = { width: 7, height: 11 }
  expect(module).toBeDefined()
  small.raw.normalization!.sourceSaturation!.saturatedSites = 0
  let provider: Awaited<ReturnType<typeof createFallbackGeometryProvider>> | undefined,
    plannerCalls = 0,
    reductionCalls = 0
  try {
    for (let i = 0; i < 62; i++) {
      const kernel = await createCameraKernel(
        small.raw,
        small.plan,
        [1, 0, 0, 0, 1, 0, 0, 0, 1],
        measurement(),
        module,
      )
      expect(kernel).toBeDefined()
      held.push(kernel!)
    }
    try {
      WebAssembly.Instance = function (code: WebAssembly.Module, imports?: WebAssembly.Imports) {
        const instance = new Instance(code, imports),
          planner = instance.exports.irodori_fallback_geometry_strip as (
            ...args: number[]
          ) => number,
          reduce = instance.exports.irodori_reduce_strip as (...args: number[]) => number,
          exports = {
            ...instance.exports,
            irodori_fallback_geometry_strip(...args: number[]) {
              plannerCalls++
              return planner(...args)
            },
            irodori_reduce_strip(...args: number[]) {
              reductionCalls++
              return reduce(...args)
            },
          }
        return new Proxy(instance, {
          get: (target, key) => (key === 'exports' ? exports : Reflect.get(target, key)),
        })
      } as unknown as typeof WebAssembly.Instance
      provider = await createFallbackGeometryProvider(
        minimal,
        large.plan,
        saturated,
        work,
        module,
        reduced,
      )
    } finally {
      WebAssembly.Instance = Instance
    }
    expect(work.backend).toBe('wasm-simd')
    expect(work.heapBytes).toBeLessThanOrEqual(4 * 1024 ** 2)
    expect(provider.reduction).toBeDefined()
    const rgba = Float32Array.from({ length: width * height * 4 }, (_, i) =>
        i % 4 === 3 ? 1 : 0.125,
      ),
      luminance = Float64Array.from({ length: width * height }, (_, i) => 1e8 + (i % 17))
    for (let top = 0; top < height; top += 64) {
      const rows = Math.min(64, height - top),
        output = provider.read(top, rows)
      expect(output.alpha.every((value) => value === 1)).toBe(true)
      provider.reduction!.add(
        top,
        rgba.subarray(top * width * 4, (top + rows) * width * 4),
        luminance.subarray(top * width, (top + rows) * width),
      )
    }
    expect(provider.reduction!.finish()).toEqual(
      referenceReduction(rgba, luminance, width, height, reduced.width, reduced.height),
    )
    expect(plannerCalls).toBe(Math.ceil(height / 64))
    expect(reductionCalls).toBe(0)
    expect(getMergeKernelHeapBytes()).toBeLessThanOrEqual(MERGE_KERNEL_HEAP_LIMIT)
    // An additional planner cannot be admitted while the retained arenas own the cap.
    expect(
      await createFallbackGeometryKernel(minimal, large.plan, saturated, measurement(), module),
    ).toBeUndefined()
    expect(() => provider!.coordinate(-1, 0, 0)).toThrow('Invalid')
    expect(() => provider!.coordinate(0, 0, 3)).toThrow('Invalid')
  } finally {
    WebAssembly.Instance = Instance
    provider?.close()
    for (const kernel of held) kernel.close()
  }
})
