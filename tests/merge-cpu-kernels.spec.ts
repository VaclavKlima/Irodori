import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createCameraKernel,
  createPreparationKernel,
  getMergeKernelHeapBytes,
  MERGE_KERNEL_HEAP_LIMIT,
  mergeKernelDirectory,
  readMergeKernel,
  type CpuKernelMeasurement,
} from '../src/main/merge/cpu-kernels'
import type { LinearFrame } from '../src/main/processing/contracts'
import type { RawSource } from '../src/main/gpu/raw-source'
import { cameraRegistrationWriter } from '../src/main/merge/camera-registration'
import { correctionPlan, type CorrectionPlan } from '../src/main/processing/lens-correction'
import { automaticLensSettings, type LensProfile } from '../src/shared/lens'
import { REC2020_LUMA, SRGB_TO_2020 } from '../src/shared/hdr'

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

test('optional SIMD assets verify checksums and resolve beside the packaged worker', async () => {
  expect(mergeKernelDirectory(join(repository, 'src/main/merge'))).toBe(vendor)
  const directory = await mkdtemp(join(tmpdir(), 'luma-merge-kernel-assets-'))
  try {
    expect(await readMergeKernel(directory)).toBeUndefined()
    const binary = await readFile(join(vendor, 'luma-merge-kernels.wasm')),
      manifest = await readFile(join(vendor, 'manifest.json'), 'utf8')
    const relocated = join(directory, 'app/main/merge-kernels'),
      chunks = join(directory, 'app/main/chunks')
    await mkdir(relocated, { recursive: true })
    await mkdir(chunks)
    await writeFile(join(relocated, 'luma-merge-kernels.wasm'), binary)
    await writeFile(join(relocated, 'manifest.json'), manifest)
    expect(mergeKernelDirectory(join(directory, 'app/main'))).toBe(relocated)
    expect(await readMergeKernel(mergeKernelDirectory(join(directory, 'app/main')))).toBeDefined()
    expect(mergeKernelDirectory(chunks)).toBe(relocated)
    expect(await readMergeKernel(mergeKernelDirectory(chunks))).toBeDefined()
    await writeFile(join(directory, 'luma-merge-kernels.wasm'), binary)
    await writeFile(join(directory, 'manifest.json'), manifest)
    expect(await readMergeKernel(directory)).toBeDefined()
    const current = JSON.parse(manifest) as { version: number; sha256: string }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...current, version: 1 }))
    expect(await readMergeKernel(directory)).toBeUndefined()
    await writeFile(join(directory, 'manifest.json'), manifest)
    const corrupted = Buffer.from(binary)
    corrupted[corrupted.length - 1] ^= 1
    await writeFile(join(directory, 'luma-merge-kernels.wasm'), corrupted)
    expect(await readMergeKernel(directory)).toBeUndefined()
    const invalid = new Uint8Array([0])
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ version: 2, sha256: createHash('sha256').update(invalid).digest('hex') }),
    )
    // A checksum alone does not make malformed or unsupported bytecode usable.
    await writeFile(join(directory, 'luma-merge-kernels.wasm'), invalid)
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
    originalCacheEntries = process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES
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
        luma = new Float64Array(width * height),
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
          luma[at] = Math.max(
            0,
            rgb[0] * REC2020_LUMA[0] + rgb[1] * REC2020_LUMA[1] + rgb[2] * REC2020_LUMA[2],
          )
        }
      expect(coordinates.size).toBeGreaterThan(2048)
      expect(expected.some((v, i) => i % 4 === 3 && v === 0)).toBe(true)
      expect(expected.some((v, i) => i % 4 === 3 && v === 1)).toBe(true)
      for (const entries of [2048, 32768] as const) {
        process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES = String(entries)
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
            expect(bytes(result.luma).equals(bytes(luma.subarray(first, last)))).toBe(true)
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
    if (originalCacheEntries === undefined) delete process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES
    else process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES = originalCacheEntries
  }
})

test('gain cache capacity defaults to 32768 and rejects unsupported allocations', async () => {
  const module = await readMergeKernel(vendor),
    { frame, plan } = fixture(5),
    saturated = new Uint8Array(frame.width * frame.height),
    original = process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES
  expect(module).toBeDefined()
  const instance = new WebAssembly.Instance(module!, { env: { hypot: Math.hypot } }),
    kernelExports = instance.exports as unknown as {
      memory: WebAssembly.Memory
      __heap_base: WebAssembly.Global
      luma_kernel_version(): number
      luma_prepare_strip(config: number, top: number, rows: number): number
    },
    configAt = Number(kernelExports.__heap_base.value),
    config = new Float64Array(kernelExports.memory.buffer, configAt, 32)
  expect(kernelExports.luma_kernel_version()).toBe(2)
  // ABI2 validates slot27 before any strip pointer can be read. An invalid
  // capacity must never index the caller's smaller allocation with a larger mask.
  for (const invalid of [0, 2049, 16384, 32767, 65536, NaN]) {
    config[27] = invalid
    expect(kernelExports.luma_prepare_strip(configAt, 0, 1)).toBe(4)
  }
  for (const entries of [2048, 32768]) {
    config[27] = entries
    expect(kernelExports.luma_prepare_strip(configAt, 0, 1)).toBe(3)
  }
  try {
    delete process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES
    const work = measurement(),
      kernel = await createPreparationKernel(frame, plan, saturated, [1, 1, 1], work, module)
    expect(kernel).toBeDefined()
    kernel!.close()
    expect(work.gainCacheEntries).toBe(32768)
    for (const invalid of ['0', '2049', '16384', '32767', '65536', 'NaN']) {
      process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES = invalid
      const fallback = measurement()
      expect(
        await createPreparationKernel(frame, plan, saturated, [1, 1, 1], fallback, module),
      ).toBeUndefined()
      expect(fallback.backend).toBe('scalar')
      expect(fallback.gainCacheEntries).toBeUndefined()
    }
  } finally {
    if (original === undefined) delete process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES
    else process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES = original
  }
})

test('scalar controls and unsupported input retain the existing preparation path', async () => {
  const module = await readMergeKernel(vendor),
    { frame, raw, plan } = fixture(5),
    original = process.env.LUMA_MERGE_CPU_KERNEL
  expect(module).toBeDefined()
  try {
    process.env.LUMA_MERGE_CPU_KERNEL = 'scalar'
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
    if (original === undefined) delete process.env.LUMA_MERGE_CPU_KERNEL
    else process.env.LUMA_MERGE_CPU_KERNEL = original
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
  const directory = await mkdtemp(join(tmpdir(), 'luma-camera-kernel-chunks-')),
    original = process.env.LUMA_MERGE_CPU_KERNEL
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
        process.env.LUMA_MERGE_CPU_KERNEL = backend
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
    if (original === undefined) delete process.env.LUMA_MERGE_CPU_KERNEL
    else process.env.LUMA_MERGE_CPU_KERNEL = original
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
