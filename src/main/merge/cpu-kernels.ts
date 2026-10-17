import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { REC2020_LUMA, SRGB_TO_2020 } from '../../shared/hdr'
import type { RawSource } from '../gpu/raw-source'
import type { LinearFrame } from '../processing/contracts'
import type { CorrectionPlan } from '../processing/lens-correction'

export const MERGE_KERNEL_HEAP_LIMIT = 128 * 1024 ** 2
const PAGE_BYTES = 65536
const INITIAL_HEAP_BYTES = 2 * 1024 ** 2
const CONFIG_SLOTS = 32
const KERNEL_ABI = 2
// Must match the Float64 slot order in kernels/prepare.c.
enum P {
  Width,
  Height,
  RawWidth,
  RawHeight,
  Flip,
  PlanWidth,
  PlanHeight,
  PlanLeft,
  PlanTop,
  Cx,
  Cy,
  Radius,
  Input,
  Output,
  Luma,
  Mask,
  Lut,
  Matrix,
  Gains,
  RoiLeft,
  RoiTop,
  RoiWidth,
  RoiHeight,
  GainKeys,
  GainValues,
  Capacity,
  HasMask,
  GainCacheEntries,
}
export interface CpuKernelMeasurement {
  backend: 'wasm-simd' | 'scalar'
  heapBytes: number
  copyMs: number
  processingMs: number
  gainCacheEntries?: 2048 | 32768
}
interface KernelExports {
  memory: WebAssembly.Memory
  __heap_base: WebAssembly.Global
  luma_kernel_version(): number
  luma_camera_strip(config: number, top: number, rows: number): number
  luma_prepare_strip(config: number, top: number, rows: number): number
}
let activeHeapBytes = 0,
  peakHeapBytes = 0,
  compiled: Promise<WebAssembly.Module | undefined> | undefined

/** Peak logical ownership, including failed initializations, for worker diagnostics. */
export function getMergeKernelHeapBytes() {
  return peakHeapBytes
}

/** Missing, damaged and unsupported optional kernels retain the scalar implementation. */
export async function readMergeKernel(directory: string): Promise<WebAssembly.Module | undefined> {
  try {
    const bytes = await readFile(join(directory, 'luma-merge-kernels.wasm')),
      manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
        version?: number
        sha256?: string
      }
    if (
      manifest.version !== KERNEL_ABI ||
      manifest.sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      return
    return await WebAssembly.compile(new Uint8Array(bytes))
  } catch {
    return
  }
}

/** Both the bundled worker and source host resolve assets beside their module. */
export function mergeKernelDirectory(moduleDirectory = import.meta.dirname) {
  for (const directory of [
    join(moduleDirectory, 'merge-kernels'),
    resolve(moduleDirectory, '../merge-kernels'),
  ])
    if (existsSync(directory)) return directory
  return resolve(moduleDirectory, '../../../vendor/merge-kernels')
}

async function defaultModule() {
  return (compiled ??= readMergeKernel(mergeKernelDirectory()))
}

class Arena {
  readonly exports: KernelExports
  private cursor: number
  private owned: number
  private closed = false
  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as KernelExports
    const e = this.exports
    if (
      !(e.memory instanceof WebAssembly.Memory) ||
      !(e.__heap_base instanceof WebAssembly.Global) ||
      typeof e.luma_kernel_version !== 'function' ||
      e.luma_kernel_version() !== KERNEL_ABI ||
      typeof e.luma_camera_strip !== 'function' ||
      typeof e.luma_prepare_strip !== 'function'
    )
      throw new Error('Invalid merge CPU kernel.')
    this.cursor = Number(e.__heap_base.value)
    this.owned = e.memory.buffer.byteLength
    if (
      !Number.isSafeInteger(this.cursor) ||
      this.cursor < 0 ||
      activeHeapBytes + this.owned > MERGE_KERNEL_HEAP_LIMIT
    )
      throw new Error('Merge CPU kernel heap limit exceeded.')
    activeHeapBytes += this.owned
    peakHeapBytes = Math.max(peakHeapBytes, activeHeapBytes)
  }
  allocate(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid kernel allocation.')
    const at = Math.ceil(this.cursor / 16) * 16
    this.cursor = at + bytes
    if (this.cursor > MERGE_KERNEL_HEAP_LIMIT)
      throw new Error('Merge CPU kernel capacity exceeded.')
    return at
  }
  seal() {
    const required = Math.ceil(this.cursor / PAGE_BYTES) * PAGE_BYTES,
      extra = Math.max(0, required - this.owned)
    if (activeHeapBytes + extra > MERGE_KERNEL_HEAP_LIMIT)
      throw new Error('Merge CPU kernel heap limit exceeded.')
    if (extra) this.exports.memory.grow(extra / PAGE_BYTES)
    this.owned += extra
    activeHeapBytes += extra
    peakHeapBytes = Math.max(peakHeapBytes, activeHeapBytes)
  }
  get heapBytes() {
    return this.owned
  }
  assertOpen() {
    if (this.closed) throw new Error('Merge CPU kernel is closed.')
  }
  f32(at: number, length: number) {
    return new Float32Array(this.exports.memory.buffer, at, length)
  }
  f64(at: number, length: number) {
    return new Float64Array(this.exports.memory.buffer, at, length)
  }
  u8(at: number, length: number) {
    return new Uint8Array(this.exports.memory.buffer, at, length)
  }
  i32(at: number, length: number) {
    return new Int32Array(this.exports.memory.buffer, at, length)
  }
  close() {
    if (!this.closed) {
      this.closed = true
      activeHeapBytes -= this.owned
    }
  }
}

async function arena(module?: WebAssembly.Module) {
  if (!module && process.env.LUMA_MERGE_CPU_KERNEL === 'scalar') return
  try {
    const code = module ?? (await defaultModule())
    // The pinned module starts at 2 MiB. Check before instantiating, so even the
    // temporary second arena cannot cross the aggregate logical ownership cap.
    if (!code || activeHeapBytes + INITIAL_HEAP_BYTES > MERGE_KERNEL_HEAP_LIMIT) return
    // Keep the cap check and initial ownership synchronous once compilation is
    // complete, including when independent callers await the same module.
    return new Arena(new WebAssembly.Instance(code, { env: { hypot: Math.hypot } }))
  } catch {
    return
  }
}

function geometry(raw: { width: number; height: number; flip: number }, plan: CorrectionPlan) {
  const width = raw.flip & 4 ? plan.height : plan.width,
    height = raw.flip & 4 ? plan.width : plan.height,
    cx = (raw.width - 1) / 2,
    cy = (raw.height - 1) / 2,
    radius = Math.hypot(cx, cy)
  if (
    ![raw.width, raw.height, width, height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    raw.width * raw.height > 24_000_000 ||
    width * height > 24_000_000 ||
    !Number.isInteger(raw.flip) ||
    raw.flip < 0 ||
    raw.flip > 7 ||
    ![plan.left, plan.top].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    plan.left + plan.width > raw.width ||
    plan.top + plan.height > raw.height ||
    !(radius > 0) ||
    plan.lut.length !== 4096 * 4 ||
    !plan.lut.every(Number.isFinite)
  )
    throw new Error('Unsupported merge CPU kernel geometry.')
  return { width, height, cx, cy, radius, capacity: width * Math.min(64, height) }
}

function configure(
  memory: Arena,
  at: number,
  raw: { width: number; height: number; flip: number },
  plan: CorrectionPlan,
) {
  const g = geometry(raw, plan),
    p = memory.f64(at, CONFIG_SLOTS)
  p.set([
    g.width,
    g.height,
    raw.width,
    raw.height,
    raw.flip,
    plan.width,
    plan.height,
    plan.left,
    plan.top,
    g.cx,
    g.cy,
    g.radius,
  ])
  p[P.Capacity] = g.capacity
  return p
}

export async function createCameraKernel(
  raw: RawSource,
  plan: CorrectionPlan,
  inverse: number[],
  measurement: CpuKernelMeasurement,
  module?: WebAssembly.Module,
) {
  const memory = await arena(module)
  if (!memory) return
  try {
    if (inverse.length !== 9 || !inverse.every(Number.isFinite))
      throw new Error('Invalid merge CPU kernel matrix.')
    const g = geometry(raw, plan),
      configAt = memory.allocate(CONFIG_SLOTS * 8),
      inputAt = memory.allocate(g.capacity * 16),
      outputAt = memory.allocate(g.capacity * 16),
      masksAt = memory.allocate(
        raw.normalization!.sourceSaturation!.saturatedSites ? raw.width * raw.height * 3 : 0,
      ),
      matrixAt = memory.allocate(9 * 8),
      lutAt = memory.allocate(plan.lut.byteLength)
    memory.seal()
    const p = configure(memory, configAt, raw, plan),
      masks = (p[P.HasMask] = Number(!!raw.normalization!.sourceSaturation!.saturatedSites))
    p[P.Input] = inputAt
    p[P.Output] = outputAt
    p[P.Mask] = masksAt
    p[P.Matrix] = matrixAt
    p[P.Lut] = lutAt
    memory.f64(matrixAt, 9).set(inverse)
    memory.f32(lutAt, plan.lut.length).set(plan.lut)
    measurement.backend = 'wasm-simd'
    measurement.heapBytes = Math.max(measurement.heapBytes, memory.heapBytes)
    return {
      masks: masks
        ? [0, 1, 2].map((c) =>
            memory.u8(masksAt + c * raw.width * raw.height, raw.width * raw.height),
          )
        : undefined,
      close: () => memory.close(),
      convert(top: number, rgba: Float32Array) {
        memory.assertOpen()
        if (rgba.length % (g.width * 4) || rgba.length > g.capacity * 4)
          throw new Error('Invalid merge CPU kernel strip.')
        const copying = performance.now()
        memory.f32(inputAt, rgba.length).set(rgba)
        measurement.copyMs += performance.now() - copying
        const processing = performance.now(),
          status = memory.exports.luma_camera_strip(configAt, top, rgba.length / 4 / g.width)
        measurement.processingMs += performance.now() - processing
        if (status) throw new Error('Merge CPU camera kernel failed.')
        return memory.f32(outputAt, rgba.length)
      },
    }
  } catch {
    memory.close()
    return
  }
}

interface Region {
  left: number
  top: number
  width: number
  height: number
}
/** Conservative bounds use all channel scales; the kernel still checks every tap. */
function sourceRegions(frame: LinearFrame, plan: CorrectionPlan) {
  const g = geometry(frame, plan)
  let minimum = Infinity,
    maximum = -Infinity
  for (let i = 0; i < plan.lut.length; i++)
    if (i % 4 !== 3) {
      minimum = Math.min(minimum, plan.lut[i])
      maximum = Math.max(maximum, plan.lut[i])
    }
  if (!(minimum > 0) || maximum > 8) throw new Error('Unsupported kernel lens range.')
  const regions: Region[] = [],
    clamp = (n: number, limit: number) => Math.max(0, Math.min(limit - 1, n))
  for (let top = 0; top < g.height; top += 64) {
    const rows = Math.min(64, g.height - top)
    let x0 = frame.flip & 4 ? top : 0,
      x1 = frame.flip & 4 ? top + rows - 1 : g.width - 1,
      y0 = frame.flip & 4 ? 0 : top,
      y1 = frame.flip & 4 ? g.width - 1 : top + rows - 1
    if (frame.flip & 1) [x0, x1] = [plan.width - 1 - x1, plan.width - 1 - x0]
    if (frame.flip & 2) [y0, y1] = [plan.height - 1 - y1, plan.height - 1 - y0]
    const qx0 = x0 + plan.left - g.cx,
      qx1 = x1 + plan.left - g.cx,
      qy0 = y0 + plan.top - g.cy,
      qy1 = y1 + plan.top - g.cy,
      xs = [qx0 * minimum, qx0 * maximum, qx1 * minimum, qx1 * maximum],
      ys = [qy0 * minimum, qy0 * maximum, qy1 * minimum, qy1 * maximum],
      left = clamp(Math.floor(g.cx + Math.min(...xs)) - 2, frame.width),
      right = clamp(Math.floor(g.cx + Math.max(...xs)) + 3, frame.width),
      first = clamp(Math.floor(g.cy + Math.min(...ys)) - 2, frame.height),
      last = clamp(Math.floor(g.cy + Math.max(...ys)) + 3, frame.height)
    regions.push({ left, top: first, width: right - left + 1, height: last - first + 1 })
  }
  return regions
}

export async function createPreparationKernel(
  frame: LinearFrame,
  plan: CorrectionPlan,
  saturated: Uint8Array,
  gains: number[],
  measurement: CpuKernelMeasurement,
  module?: WebAssembly.Module,
) {
  const memory = await arena(module)
  if (!memory) return
  try {
    const gainCacheEntries = Number(process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES ?? 32768)
    if (gainCacheEntries !== 2048 && gainCacheEntries !== 32768)
      throw new Error('Unsupported merge gain cache capacity.')
    if (
      frame.data.length !== frame.width * frame.height * 4 ||
      saturated.length !== frame.width * frame.height ||
      frame.matrix.length !== 12 ||
      !frame.matrix.every(Number.isFinite) ||
      gains.length !== 3 ||
      ![...gains, ...(frame.normalization?.gains ?? [])].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      frame.normalization?.gains.length !== 4
    )
      throw new Error('Invalid merge CPU preparation input.')
    const g = geometry(frame, plan),
      regions = sourceRegions(frame, plan),
      inputPixels = Math.max(...regions.map((r) => r.width * r.height))
    // Keep storage bounded to strips: a second complete camera frame is forbidden.
    if (inputPixels >= frame.width * frame.height && frame.width * frame.height > g.capacity * 4)
      throw new Error('Merge CPU kernel would duplicate the source frame.')
    const configAt = memory.allocate(CONFIG_SLOTS * 8),
      inputAt = memory.allocate(inputPixels * 16),
      outputAt = memory.allocate(g.capacity * 16),
      lumaAt = memory.allocate(g.capacity * 8),
      maskAt = memory.allocate(saturated.byteLength),
      lutAt = memory.allocate(plan.lut.byteLength),
      matrixAt = memory.allocate(24 * 8),
      gainsAt = memory.allocate(8 * 8),
      keysAt = memory.allocate(gainCacheEntries * 4),
      valuesAt = memory.allocate(gainCacheEntries * 8)
    memory.seal()
    const p = configure(memory, configAt, frame, plan)
    p[P.Input] = inputAt
    p[P.Output] = outputAt
    p[P.Luma] = lumaAt
    p[P.Mask] = maskAt
    p[P.Lut] = lutAt
    p[P.Matrix] = matrixAt
    p[P.Gains] = gainsAt
    p[P.GainKeys] = keysAt
    p[P.GainValues] = valuesAt
    p[P.GainCacheEntries] = gainCacheEntries
    memory.u8(maskAt, saturated.length).set(saturated)
    memory.f32(lutAt, plan.lut.length).set(plan.lut)
    memory.f64(matrixAt, 24).set([...frame.matrix, ...SRGB_TO_2020, ...REC2020_LUMA])
    const normal = frame.normalization!
    memory
      .f64(gainsAt, 8)
      .set([Math.max(...normal.gains), Math.min(...gains), ...normal.gains.slice(0, 3), ...gains])
    memory.i32(keysAt, gainCacheEntries).fill(-1)
    measurement.backend = 'wasm-simd'
    measurement.heapBytes = Math.max(measurement.heapBytes, memory.heapBytes)
    measurement.gainCacheEntries = gainCacheEntries
    return {
      close: () => memory.close(),
      convert(top: number, rows: number) {
        memory.assertOpen()
        if (top % 64 || rows !== Math.min(64, g.height - top))
          throw new Error('Invalid preparation kernel strip.')
        const region = regions[top / 64]
        if (!region) throw new Error('Invalid preparation kernel position.')
        const copying = performance.now(),
          input = memory.f32(inputAt, region.width * region.height * 4)
        for (let y = 0; y < region.height; y++) {
          const first = ((region.top + y) * frame.width + region.left) * 4
          input.set(frame.data.subarray(first, first + region.width * 4), y * region.width * 4)
        }
        p[P.RoiLeft] = region.left
        p[P.RoiTop] = region.top
        p[P.RoiWidth] = region.width
        p[P.RoiHeight] = region.height
        measurement.copyMs += performance.now() - copying
        const processing = performance.now(),
          status = memory.exports.luma_prepare_strip(configAt, top, rows)
        measurement.processingMs += performance.now() - processing
        if (status) throw new Error('Merge CPU preparation kernel failed.')
        return {
          pixels: memory.f32(outputAt, g.width * rows * 4),
          luma: memory.f64(lumaAt, g.width * rows),
        }
      },
    }
  } catch {
    memory.close()
    return
  }
}
