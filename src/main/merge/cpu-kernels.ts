import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { REC2020_LUMA, SRGB_TO_2020 } from '../../shared/hdr'
import { MERGE_LIMITS } from '../../shared/merge'
import type { RawSource } from '../gpu/raw-source'
import type { LinearFrame } from '../processing/contracts'
import type { CorrectionPlan } from '../processing/lens-correction'
import { flattenedAreaContributions } from './area'
import type { Plane } from './math'

export const MERGE_KERNEL_HEAP_LIMIT = 128 * 1024 ** 2
const PAGE_BYTES = 65536
const INITIAL_HEAP_BYTES = 2 * 1024 ** 2
const CONFIG_SLOTS = 48
const KERNEL_ABI = 3
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
  SensorInput,
  SensorCfa,
  SensorThresholds,
  SensorMode,
  SensorCapacity,
  Alpha,
  Changed,
  ChangeCount,
  RepairOriginal,
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
  luma_reduce_strip(config: number, top: number, rows: number): number
  luma_sensor_mask(config: number, top: number, rows: number): number
  luma_repair_mask(config: number, top: number, rows: number): number
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
      typeof e.luma_prepare_strip !== 'function' ||
      typeof e.luma_reduce_strip !== 'function' ||
      typeof e.luma_sensor_mask !== 'function' ||
      typeof e.luma_repair_mask !== 'function'
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
  checkpoint() {
    return this.cursor
  }
  restore(cursor: number) {
    this.cursor = cursor
  }
  canSeal() {
    const required = Math.ceil(this.cursor / PAGE_BYTES) * PAGE_BYTES
    return activeHeapBytes + Math.max(0, required - this.owned) <= MERGE_KERNEL_HEAP_LIMIT
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
  u16(at: number, length: number) {
    return new Uint16Array(this.exports.memory.buffer, at, length)
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

export interface AreaReductionSize {
  width: number
  height: number
}
type ReductionMode = 'camera' | 'luma'
// Must match the reduction slot order in kernels/prepare.c.
enum R {
  Width,
  Height,
  ReducedWidth,
  ReducedHeight,
  Channels,
  XOffsets,
  XTargets,
  XWeights,
  YOffsets,
  YTargets,
  YWeights,
  RowLast,
  Totals,
  Counts,
  Sums,
  RowIds,
  Input,
  Luma,
  EmitData,
  EmitMasks,
  EmitRows,
  EmitCount,
  EmitCapacity,
  Threshold,
}
interface ReductionArena {
  memory: Arena
  configAt: number
  stateAt: number
  stateBytes: number
  backupAt: number
  totalsAt: number
  countsAt: number
  sumsAt: number
  rowIdsAt: number
  inputAt: number
  lumaAt: number
  emitDataAt: number
  emitMasksAt: number
  emitRowsAt: number
  emitCapacity: number
}

/** Ordered area reduction with two live rows. Final planes never alias the arena. */
export function createAreaReducer(
  width: number,
  height: number,
  reduced: AreaReductionSize,
  mode: ReductionMode,
) {
  return areaReducer(width, height, reduced, mode)
}

function areaReducer(
  width: number,
  height: number,
  reduced: AreaReductionSize,
  mode: ReductionMode,
  owned?: ReductionArena,
  measurement?: CpuKernelMeasurement,
) {
  if (
    ![width, height, reduced.width, reduced.height].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    reduced.width > width ||
    reduced.height > height ||
    width * height > 24_000_000
  )
    throw new Error('Unsupported area reduction geometry.')
  const xs = flattenedAreaContributions(width, reduced.width),
    ys = flattenedAreaContributions(height, reduced.height),
    channels = mode === 'camera' ? 3 : 1,
    rowPixels = reduced.width * 2,
    totals = owned ? owned.memory.f64(owned.totalsAt, rowPixels) : new Float64Array(rowPixels),
    counts = owned
      ? owned.memory.f64(owned.countsAt, rowPixels * channels)
      : new Float64Array(rowPixels * channels),
    sums = owned
      ? mode === 'camera'
        ? owned.memory.f64(owned.sumsAt, rowPixels * channels)
        : owned.memory.f32(owned.sumsAt, rowPixels)
      : mode === 'camera'
        ? new Float64Array(rowPixels * channels)
        : new Float32Array(rowPixels),
    rowIds = owned ? owned.memory.i32(owned.rowIdsAt, 2) : new Int32Array(2),
    planes: Plane[] = Array.from({ length: channels }, () => ({
      width: reduced.width,
      height: reduced.height,
      data: new Float32Array(reduced.width * reduced.height),
      mask: new Uint8Array(reduced.width * reduced.height),
    }))
  rowIds.fill(-1)
  let next = 0,
    accelerated = !!owned
  const finalize = (slot: number) => {
    const py = rowIds[slot],
      row = slot * reduced.width
    for (let x = 0; x < reduced.width; x++) {
      const p = row + x,
        out = py * reduced.width + x
      for (let c = 0; c < channels; c++) {
        const at = c * rowPixels + p,
          valid = counts[at] > 0 && Math.abs(counts[at] - totals[p]) < 1e-8
        planes[c].mask![out] = valid ? 255 : 0
        planes[c].data[out] = valid ? sums[at] / counts[at] : 0
        sums[at] = 0
        counts[at] = 0
      }
      totals[p] = 0
    }
    rowIds[slot] = -1
  }
  return {
    add(top: number, pixels: Float32Array, luma?: Float64Array) {
      const rows = pixels.length / 4 / width
      if (
        top !== next ||
        !Number.isInteger(rows) ||
        rows < 1 ||
        rows > 64 ||
        top + rows > height ||
        (mode === 'luma' && luma?.length !== width * rows)
      )
        throw new Error('Invalid area reduction strip.')
      owned?.memory.assertOpen()
      if (owned && accelerated) {
        const { memory } = owned,
          copying = performance.now()
        memory.u8(owned.backupAt, owned.stateBytes).set(memory.u8(owned.stateAt, owned.stateBytes))
        if (pixels.buffer !== memory.exports.memory.buffer || pixels.byteOffset !== owned.inputAt)
          memory.f32(owned.inputAt, pixels.length).set(pixels)
        if (
          luma &&
          (luma.buffer !== memory.exports.memory.buffer || luma.byteOffset !== owned.lumaAt)
        )
          memory.f64(owned.lumaAt, luma.length).set(luma)
        if (measurement) measurement.copyMs += performance.now() - copying
        const processing = performance.now()
        try {
          if (memory.exports.luma_reduce_strip(owned.configAt, top, rows))
            throw new Error('Merge area reduction kernel failed.')
          const config = memory.f64(owned.configAt, CONFIG_SLOTS),
            emitted = config[R.EmitCount],
            data = memory.f32(owned.emitDataAt, owned.emitCapacity * reduced.width * channels),
            masks = memory.u8(owned.emitMasksAt, owned.emitCapacity * reduced.width * channels),
            rowsOut = memory.i32(owned.emitRowsAt, owned.emitCapacity)
          if (!Number.isInteger(emitted) || emitted < 0 || emitted > owned.emitCapacity)
            throw new Error('Invalid area reduction output.')
          // Validate every emitted row before publishing any of this strip.
          for (let i = 0; i < emitted; i++)
            if (rowsOut[i] < 0 || rowsOut[i] >= reduced.height)
              throw new Error('Invalid area reduction row.')
          for (let i = 0; i < emitted; i++)
            for (let c = 0; c < channels; c++) {
              const first = (i * channels + c) * reduced.width,
                last = first + reduced.width,
                at = rowsOut[i] * reduced.width
              planes[c].data.set(data.subarray(first, last), at)
              planes[c].mask!.set(masks.subarray(first, last), at)
            }
          next += rows
          return
        } catch {
          // The failed call may have finalized and cleared earlier rows. Neither
          // live state nor final planes can change before scalar replay.
          memory
            .u8(owned.stateAt, owned.stateBytes)
            .set(memory.u8(owned.backupAt, owned.stateBytes))
          accelerated = false
        } finally {
          if (measurement) measurement.processingMs += performance.now() - processing
        }
      }
      for (let row = 0; row < rows; row++) {
        const y = top + row
        for (let x = 0; x < width; x++) {
          const pixel = row * width + x,
            valid = pixels[pixel * 4 + 3]
          for (let xi = xs.offsets[x]; xi < xs.offsets[x + 1]; xi++)
            for (let yi = ys.offsets[y]; yi < ys.offsets[y + 1]; yi++) {
              const px = xs.targets[xi],
                py = ys.targets[yi],
                slot = py & 1,
                p = slot * reduced.width + px,
                weight = xs.weights[xi] * ys.weights[yi]
              if (rowIds[slot] < 0) rowIds[slot] = py
              if (rowIds[slot] !== py) throw new Error('Area reduction row capacity exceeded.')
              totals[p] += weight
              for (let c = 0; c < channels; c++) {
                const value = mode === 'camera' ? pixels[pixel * 4 + c] : luma![pixel],
                  usable = mode === 'camera' ? valid & (1 << c) : valid
                if (usable && value > MERGE_LIMITS.readNoise * 3) {
                  const at = c * rowPixels + p
                  // A Float32 luma store after each update is part of the recipe.
                  sums[at] += value * weight
                  counts[at] += weight
                }
              }
            }
        }
        for (let slot = 0; slot < 2; slot++)
          if (rowIds[slot] >= 0 && ys.last[rowIds[slot]] === y) finalize(slot)
      }
      next += rows
    },
    finish() {
      if (next !== height || rowIds.some((id) => id !== -1))
        throw new Error('Incomplete area reduction.')
      return planes
    },
  }
}

/** Optional allocations are preflighted before growth; a miss keeps conversion. */
function planAreaReducer(
  memory: Arena,
  width: number,
  height: number,
  reduced: AreaReductionSize | undefined,
  mode: ReductionMode,
  inputAt: number,
  lumaAt: number,
  measurement: CpuKernelMeasurement,
) {
  if (!reduced) return () => undefined
  const checkpoint = memory.checkpoint(),
    xs = flattenedAreaContributions(width, reduced.width),
    ys = flattenedAreaContributions(height, reduced.height),
    channels = mode === 'camera' ? 3 : 1,
    rowPixels = reduced.width * 2,
    emitCapacity = Math.min(65, reduced.height)
  try {
    if (reduced.width > width || reduced.height > height)
      throw new Error('Unsupported compiled area reduction.')
    const configAt = memory.allocate(CONFIG_SLOTS * 8),
      xOffsetsAt = memory.allocate(xs.offsets.byteLength),
      xTargetsAt = memory.allocate(xs.targets.byteLength),
      xWeightsAt = memory.allocate(xs.weights.byteLength),
      yOffsetsAt = memory.allocate(ys.offsets.byteLength),
      yTargetsAt = memory.allocate(ys.targets.byteLength),
      yWeightsAt = memory.allocate(ys.weights.byteLength),
      rowLastAt = memory.allocate(ys.last.byteLength),
      stateAt = memory.allocate(0),
      rowIdsAt = memory.allocate(2 * 4),
      totalsAt = memory.allocate(rowPixels * 8),
      countsAt = memory.allocate(rowPixels * channels * 8),
      sumsAt = memory.allocate(rowPixels * channels * (mode === 'camera' ? 8 : 4)),
      stateBytes = memory.checkpoint() - stateAt,
      backupAt = memory.allocate(stateBytes),
      emitDataAt = memory.allocate(emitCapacity * reduced.width * channels * 4),
      emitMasksAt = memory.allocate(emitCapacity * reduced.width * channels),
      emitRowsAt = memory.allocate(emitCapacity * 4)
    if (!memory.canSeal()) throw new Error('Compiled area reduction allocation limit exceeded.')
    return () => {
      const p = memory.f64(configAt, CONFIG_SLOTS)
      p.set([
        width,
        height,
        reduced.width,
        reduced.height,
        channels,
        xOffsetsAt,
        xTargetsAt,
        xWeightsAt,
        yOffsetsAt,
        yTargetsAt,
        yWeightsAt,
        rowLastAt,
        totalsAt,
        countsAt,
        sumsAt,
        rowIdsAt,
        inputAt,
        lumaAt,
        emitDataAt,
        emitMasksAt,
        emitRowsAt,
        0,
        emitCapacity,
        MERGE_LIMITS.readNoise * 3,
      ])
      memory.i32(xOffsetsAt, xs.offsets.length).set(xs.offsets)
      memory.i32(xTargetsAt, xs.targets.length).set(xs.targets)
      memory.f64(xWeightsAt, xs.weights.length).set(xs.weights)
      memory.i32(yOffsetsAt, ys.offsets.length).set(ys.offsets)
      memory.i32(yTargetsAt, ys.targets.length).set(ys.targets)
      memory.f64(yWeightsAt, ys.weights.length).set(ys.weights)
      memory.i32(rowLastAt, ys.last.length).set(ys.last)
      return areaReducer(
        width,
        height,
        reduced,
        mode,
        {
          memory,
          configAt,
          stateAt,
          stateBytes,
          backupAt,
          totalsAt,
          countsAt,
          sumsAt,
          rowIdsAt,
          inputAt,
          lumaAt,
          emitDataAt,
          emitMasksAt,
          emitRowsAt,
          emitCapacity,
        },
        measurement,
      )
    }
  } catch {
    memory.restore(checkpoint)
    return () => areaReducer(width, height, reduced, mode)
  }
}

function validSensor(raw: RawSource) {
  const thresholds = raw.normalization?.sourceSaturation?.thresholds
  return (
    [raw.width, raw.height, raw.rawWidth, raw.top, raw.left].every(Number.isSafeInteger) &&
    raw.width > 0 &&
    raw.height > 0 &&
    raw.width * raw.height <= 24_000_000 &&
    raw.left >= 0 &&
    raw.top >= 0 &&
    raw.left + raw.width <= raw.rawWidth &&
    (raw.top + raw.height) * raw.rawWidth <= raw.pixels.length &&
    raw.cfa.length === 4 &&
    raw.cfa.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 3) &&
    thresholds?.length === 4 &&
    thresholds.every(Number.isFinite)
  )
}

function configureSensor(
  memory: Arena,
  configAt: number,
  raw: RawSource,
  inputAt: number,
  cfaAt: number,
  thresholdsAt: number,
  channelMasks: boolean,
) {
  if (!validSensor(raw)) throw new Error('Invalid merge sensor mask input.')
  const p = memory.f64(configAt, CONFIG_SLOTS)
  p[P.RawWidth] = raw.width
  p[P.RawHeight] = raw.height
  p[P.SensorInput] = inputAt
  p[P.SensorCfa] = cfaAt
  p[P.SensorThresholds] = thresholdsAt
  p[P.SensorMode] = Number(channelMasks)
  p[P.SensorCapacity] = raw.width * Math.min(64, raw.height)
  memory.i32(cfaAt, 4).set(raw.cfa)
  memory.f64(thresholdsAt, 4).set(raw.normalization!.sourceSaturation!.thresholds)
}

function populateSensorMask(
  memory: Arena,
  configAt: number,
  raw: RawSource,
  inputAt: number,
  measurement: CpuKernelMeasurement,
) {
  memory.assertOpen()
  for (let top = 0; top < raw.height; top += 64) {
    const rows = Math.min(64, raw.height - top),
      input = memory.u16(inputAt, raw.width * rows),
      copying = performance.now()
    for (let row = 0; row < rows; row++) {
      const first = (raw.top + top + row) * raw.rawWidth + raw.left
      input.set(raw.pixels.subarray(first, first + raw.width), row * raw.width)
    }
    measurement.copyMs += performance.now() - copying
    const processing = performance.now(),
      status = memory.exports.luma_sensor_mask(configAt, top, rows)
    measurement.processingMs += performance.now() - processing
    if (status) throw new Error('Merge sensor mask kernel failed.')
  }
}

/** Optional compiled sensor dilation; ownership ends before decoding continues. */
export async function createSensorClippingMask(
  raw: RawSource,
  measurement: CpuKernelMeasurement,
  module?: WebAssembly.Module,
) {
  if (!validSensor(raw)) return
  if (!raw.normalization!.sourceSaturation!.saturatedSites)
    return new Uint8Array(raw.width * raw.height)
  const memory = await arena(module)
  if (!memory) return
  try {
    const configAt = memory.allocate(CONFIG_SLOTS * 8),
      inputAt = memory.allocate(raw.width * Math.min(64, raw.height) * 2),
      maskAt = memory.allocate(raw.width * raw.height),
      cfaAt = memory.allocate(4 * 4),
      thresholdsAt = memory.allocate(4 * 8)
    memory.seal()
    configureSensor(memory, configAt, raw, inputAt, cfaAt, thresholdsAt, false)
    memory.f64(configAt, CONFIG_SLOTS)[P.Mask] = maskAt
    populateSensorMask(memory, configAt, raw, inputAt, measurement)
    measurement.backend = 'wasm-simd'
    measurement.heapBytes = Math.max(measurement.heapBytes, memory.heapBytes)
    return memory.u8(maskAt, raw.width * raw.height).slice()
  } catch {
    return
  } finally {
    memory.close()
  }
}

/** Canonical double-precision repair keeps RGB and boundary selection unchanged. */
export async function createMaskRepairKernel(
  raw: RawSource,
  plan: CorrectionPlan,
  saturated: Uint8Array,
  measurement: CpuKernelMeasurement,
  module?: WebAssembly.Module,
) {
  const memory = await arena(module)
  if (!memory) return
  try {
    const g = geometry(raw, plan)
    if (saturated.length !== raw.width * raw.height)
      throw new Error('Invalid canonical mask length.')
    // Keep the producer's batch boundaries: adding 64-row boundaries would
    // change which otherwise uniform pixels receive canonical repair.
    const capacity = g.width * Math.min(256, g.height),
      configAt = memory.allocate(CONFIG_SLOTS * 8),
      inputAt = memory.allocate(capacity * 16),
      maskAt = memory.allocate(saturated.byteLength),
      lutAt = memory.allocate(plan.lut.byteLength),
      alphaWords = Math.ceil((g.width * g.height) / 32),
      alphaAt = memory.allocate(alphaWords * 4),
      changedAt = memory.allocate(capacity * 4),
      originalAt = memory.allocate(capacity)
    memory.seal()
    const p = configure(memory, configAt, raw, plan)
    p[P.Capacity] = capacity
    p[P.Input] = inputAt
    p[P.Mask] = maskAt
    p[P.Lut] = lutAt
    p[P.Alpha] = alphaAt
    p[P.Changed] = changedAt
    p[P.RepairOriginal] = originalAt
    memory.u8(maskAt, saturated.length).set(saturated)
    memory.f32(lutAt, plan.lut.length).set(plan.lut)
    measurement.backend = 'wasm-simd'
    measurement.heapBytes = Math.max(measurement.heapBytes, memory.heapBytes)
    return {
      close: () => memory.close(),
      repair(top: number, pixels: Float32Array, alpha: Uint32Array) {
        memory.assertOpen()
        const rows = pixels.length / 4 / g.width
        if (
          !Number.isInteger(top) ||
          top < 0 ||
          !Number.isInteger(rows) ||
          rows < 1 ||
          rows > 256 ||
          top + rows > g.height ||
          alpha.length !== alphaWords
        )
          throw new Error('Invalid canonical mask strip.')
        const firstWord = Math.floor((top * g.width) / 32),
          lastWord = Math.ceil(((top + rows) * g.width) / 32),
          copying = performance.now()
        memory.f32(inputAt, pixels.length).set(pixels)
        memory
          .i32(alphaAt + firstWord * 4, lastWord - firstWord)
          .set(alpha.subarray(firstWord, lastWord))
        measurement.copyMs += performance.now() - copying
        const processing = performance.now(),
          status = memory.exports.luma_repair_mask(configAt, top, rows)
        measurement.processingMs += performance.now() - processing
        if (status) throw new Error('Canonical mask repair kernel failed.')
        const count = p[P.ChangeCount]
        if (!Number.isInteger(count) || count < 0 || count > capacity)
          throw new Error('Invalid canonical mask repair output.')
        const changed = Array.from(memory.i32(changedAt, count))
        if (changed.some((at) => at < top * g.width || at >= (top + rows) * g.width))
          throw new Error('Invalid canonical mask repair position.')
        // Publish only after the complete call and its bounded output validate.
        const publishing = performance.now()
        pixels.set(memory.f32(inputAt, pixels.length))
        alpha.set(memory.i32(alphaAt + firstWord * 4, lastWord - firstWord), firstWord)
        measurement.copyMs += performance.now() - publishing
        return changed
      },
    }
  } catch {
    memory.close()
    return
  }
}

export async function createCameraKernel(
  raw: RawSource,
  plan: CorrectionPlan,
  inverse: number[],
  measurement: CpuKernelMeasurement,
  module?: WebAssembly.Module,
  reduced?: AreaReductionSize,
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
      lutAt = memory.allocate(plan.lut.byteLength),
      sensorInputAt =
        g.capacity * 16 >= raw.width * Math.min(64, raw.height) * 2
          ? inputAt
          : memory.allocate(raw.width * Math.min(64, raw.height) * 2),
      cfaAt = memory.allocate(4 * 4),
      thresholdsAt = memory.allocate(4 * 8),
      reduction = planAreaReducer(
        memory,
        g.width,
        g.height,
        reduced,
        'camera',
        outputAt,
        0,
        measurement,
      )
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
    configureSensor(memory, configAt, raw, sensorInputAt, cfaAt, thresholdsAt, true)
    measurement.backend = 'wasm-simd'
    measurement.heapBytes = Math.max(measurement.heapBytes, memory.heapBytes)
    return {
      reduction: reduction(),
      masks: masks
        ? [0, 1, 2].map((c) =>
            memory.u8(masksAt + c * raw.width * raw.height, raw.width * raw.height),
          )
        : undefined,
      populateMasks() {
        if (!masks) return
        try {
          populateSensorMask(memory, configAt, raw, sensorInputAt, measurement)
          return [0, 1, 2].map((c) =>
            memory.u8(masksAt + c * raw.width * raw.height, raw.width * raw.height),
          )
        } catch {
          // A late strip failure must not leave stale bits for scalar recovery.
          memory.u8(masksAt, raw.width * raw.height * 3).fill(0)
          return
        }
      },
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
  reduced?: AreaReductionSize,
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
      valuesAt = memory.allocate(gainCacheEntries * 8),
      reduction = planAreaReducer(
        memory,
        g.width,
        g.height,
        reduced,
        'luma',
        outputAt,
        lumaAt,
        measurement,
      )
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
      reduction: reduction(),
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
