import { expect, test } from '@playwright/test'
import {
  exportGpuAllocation,
  exportRenderMemoryPlan,
  exportResizeBytes,
  exportResizeGpuAllocation,
  exportInputMemoryPlan,
  exportSdrEncodePlan,
  exportHdrEncodePlan,
  requireExportAllocation,
  EXPORT_GPU_LIMIT_BYTES,
  EXPORT_ENCODER_LIMIT_BYTES,
} from '../src/shared/export-resources'
import { detailFrameJob } from './detail-frame.helpers'
import { compileResizeGpu } from '../src/shared/export-resize-gpu'
import { outputSharpeningMemoryPlan } from '../src/main/export/output-sharpening'

const admission = () => structuredClone(detailFrameJob().admission!)
const layout = {
  width: 5500,
  height: 3672,
  outWidth: 5500,
  outHeight: 3672,
  hdr: true,
  sourceHdr: true,
  gpuAllowed: true,
  creative: true,
  inputBytes: 0,
}

test('GPU admission distinguishes exact tile storage from optional retained HDR at the existing one-GiB ceiling', () => {
  const unconstrained = exportGpuAllocation(5500 * 64, true, true, true, 5500 * 3672),
    streamed = exportGpuAllocation(
      5500 * 64,
      true,
      true,
      true,
      5500 * 3672,
      unconstrained.baseBytes,
    )
  expect(unconstrained.deferredBytes).toBe(5500 * 3672 * 20)
  expect(streamed).toMatchObject({
    accepted: true,
    deferredBytes: 0,
    totalBytes: unconstrained.baseBytes,
  })
  expect(
    exportGpuAllocation(5500 * 64, true, true, true, 0, unconstrained.baseBytes - 1).accepted,
  ).toBe(false)
  expect(
    exportGpuAllocation(5500 * 64, true, true, true, 0, Number.MAX_SAFE_INTEGER).limitBytes,
  ).toBe(EXPORT_GPU_LIMIT_BYTES)
  expect(exportGpuAllocation(5500 * 64, true, true, false).baseBytes).toBeLessThan(
    unconstrained.baseBytes,
  )
})

test('render phases include other owners and retained inputs without summing retired GPU and resize work', () => {
  const a = admission(),
    full = exportRenderMemoryPlan(layout, a),
    inputBytes = 2 * layout.width * layout.height * 16,
    paired = exportRenderMemoryPlan({ ...layout, inputBytes, gpuAllowed: false }, a)
  expect(paired.cpu.total.ramBytes - full.cpu.total.ramBytes).toBe(inputBytes)
  expect(paired.gpuAccepted).toBe(false)
  expect(full.outputs).toBe(layout.width * layout.height * 11)
  const tight = admission()
  Object.assign(tight.policy.vram, {
    effectiveBytes: tight.reservation.vramBytes + full.gpuBuffers.baseBytes,
  })
  const streamed = exportRenderMemoryPlan(layout, tight)
  expect(streamed.gpuAccepted).toBe(true)
  expect(streamed.gpuBuffers.deferredBytes).toBe(0)
  Object.assign(tight.policy.vram, { effectiveBytes: tight.reservation.vramBytes })
  expect(exportRenderMemoryPlan(layout, tight)).toMatchObject({
    gpuAccepted: false,
    cpu: { accepted: true },
  })
  Object.assign(tight.policy.ram, { effectiveBytes: full.cpu.total.ramBytes - 1 })
  expect(() => requireExportAllocation(exportRenderMemoryPlan(layout, tight).cpu)).toThrow(
    'frozen managed image budgets',
  )
  const resized = exportRenderMemoryPlan({ ...layout, outWidth: 1, outHeight: 1 }, a)
  expect(resized.resizeBytes).toBe(exportResizeBytes(layout.width, layout.height, 1, 1, 6))
  expect(resized.cpu.total.ramBytes).toBe(
    a.reservation.ramBytes +
      resized.retainedBytes +
      Math.max(resized.cpuWorkBytes, resized.resizeBytes),
  )
})

test('SDR encoding may fit after rendering retires even when concurrent encoding is refused', () => {
  const a = admission(),
    render = exportRenderMemoryPlan(layout, a),
    retired = {
      ...a,
      reservation: {
        ramBytes: a.reservation.ramBytes + render.outputs,
        vramBytes: a.reservation.vramBytes,
      },
    },
    sdr = exportSdrEncodePlan(layout.width, layout.height, retired),
    concurrent = {
      ...a,
      reservation: {
        ramBytes: retired.reservation.ramBytes + render.gpuWorkBytes,
        vramBytes: render.gpu.total.vramBytes,
      },
    }
  Object.assign(a.policy.ram, { effectiveBytes: sdr.total.ramBytes })
  expect(
    exportSdrEncodePlan(layout.width, layout.height, { ...retired, policy: a.policy }).accepted,
  ).toBe(true)
  expect(
    exportSdrEncodePlan(layout.width, layout.height, { ...concurrent, policy: a.policy }).accepted,
  ).toBe(false)
  expect(sdr.outputLimitBytes).toBeLessThanOrEqual(256 * 1024 ** 2)
})

test('native output sharpening uses linear renditions and a separately admitted bounded GPU phase', () => {
  const a = admission(),
    ordinary = exportRenderMemoryPlan(layout, a),
    active = exportRenderMemoryPlan({ ...layout, outputSharpening: true }, a),
    filter = outputSharpeningMemoryPlan(layout.width, layout.height, 6, a, active.retainedBytes)
  expect(ordinary.gpuBuffers.deferredBytes).toBeGreaterThan(0)
  expect(active.gpuBuffers.deferredBytes).toBe(0)
  expect(active.gpuBuffers.stride).toBe(6)
  expect(active.resizeBytes).toBe(0)
  expect(filter.memory.ramBytes).toBeGreaterThan(active.retainedBytes)
  expect(filter.memory.vramBytes).toBeGreaterThan(0)
  const tight = admission()
  Object.assign(tight.policy.vram, {
    effectiveBytes: tight.reservation.vramBytes + filter.memory.vramBytes - 1,
  })
  expect(() =>
    outputSharpeningMemoryPlan(layout.width, layout.height, 6, tight, active.retainedBytes),
  ).toThrow('Output sharpening exceeds')
  Object.assign(tight.policy.vram, {
    effectiveBytes: tight.reservation.vramBytes + filter.memory.vramBytes,
  })
  Object.assign(tight.policy.ram, {
    effectiveBytes: tight.reservation.ramBytes + filter.memory.ramBytes - 1,
  })
  expect(() =>
    outputSharpeningMemoryPlan(layout.width, layout.height, 6, tight, active.retainedBytes),
  ).toThrow('Output sharpening exceeds')
  Object.assign(tight.policy.ram, {
    effectiveBytes: tight.reservation.ramBytes + filter.memory.ramBytes,
  })
  expect(
    outputSharpeningMemoryPlan(layout.width, layout.height, 6, tight, active.retainedBytes).memory,
  ).toEqual(filter.memory)
})

test('GPU resize reserves a separate phase and refuses either frozen memory budget before allocation', () => {
  const a = admission(),
    dimensions = [17, 11, 34, 22, 6] as const,
    resize = exportResizeGpuAllocation(...dimensions, a),
    actual = compileResizeGpu(...dimensions),
    render = exportRenderMemoryPlan({ ...layout, outWidth: 6875, outHeight: 4590 }, a)
  expect(resize.accepted).toBe(true)
  expect(resize.bytes.ramBytes).toBeGreaterThanOrEqual(actual.hostBytes)
  expect(resize.bytes.vramBytes).toBeGreaterThanOrEqual(actual.gpuBytes)
  expect(render.resizeGpu.total.vramBytes).toBe(
    a.reservation.vramBytes + render.resizeGpu.bytes.vramBytes,
  )
  expect(render.resizeGpu.total.ramBytes).toBe(
    a.reservation.ramBytes + render.retainedBytes + render.resizeGpu.bytes.ramBytes,
  )
  const tight = admission()
  Object.assign(tight.policy.vram, { effectiveBytes: resize.total.vramBytes - 1 })
  expect(() => requireExportAllocation(exportResizeGpuAllocation(...dimensions, tight))).toThrow(
    'budgets',
  )
  Object.assign(tight.policy.vram, { effectiveBytes: resize.total.vramBytes })
  Object.assign(tight.policy.ram, { effectiveBytes: resize.total.ramBytes - 1 })
  expect(() => requireExportAllocation(exportResizeGpuAllocation(...dimensions, tight))).toThrow(
    'budgets',
  )
  Object.assign(tight.policy.ram, { effectiveBytes: resize.total.ramBytes })
  expect(exportResizeGpuAllocation(...dimensions, tight).accepted).toBe(true)
})

test('encoder admission retains codec limits and accounts for native versus simultaneous WASM output storage', () => {
  const a = admission(),
    native = exportHdrEncodePlan(5500, 3672, 1024 * 1024, 'native', a),
    wasm = exportHdrEncodePlan(5500, 3672, 1024 * 1024, 'wasm', a)
  expect(native.codecBytes).toBe(5500 * 3672 * 56 + 3 * 1024 * 1024 + 128 * 1024 ** 2)
  expect(native.codecBytes).toBeLessThan(EXPORT_ENCODER_LIMIT_BYTES)
  expect(wasm.total.ramBytes).toBeGreaterThan(native.total.ramBytes)
  const tight = admission()
  Object.assign(tight.policy.ram, { effectiveBytes: native.total.ramBytes })
  expect(exportHdrEncodePlan(5500, 3672, 1024 * 1024, 'native', tight).accepted).toBe(true)
  Object.assign(tight.policy.ram, { effectiveBytes: native.total.ramBytes - 1 })
  expect(exportHdrEncodePlan(5500, 3672, 1024 * 1024, 'native', tight).accepted).toBe(false)
})

test('input, domain, overflow and policy checks precede managed export allocations', () => {
  const a = admission(),
    input = exportInputMemoryPlan(5500, 3672, a)
  Object.assign(a.policy.ram, { effectiveBytes: input.total.ramBytes - 1 })
  expect(() => requireExportAllocation(exportInputMemoryPlan(5500, 3672, a))).toThrow('budgets')
  for (const value of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER])
    expect(() => exportRenderMemoryPlan({ ...layout, inputBytes: value }, a)).toThrow()
  for (const size of [
    { width: 0, height: 1 },
    { width: 32768, height: 32768 },
  ])
    expect(() => exportInputMemoryPlan(size.width, size.height, a)).toThrow()
  expect(() => exportGpuAllocation(0, true, true, false)).toThrow()
  expect(() => exportHdrEncodePlan(8, 8, 0, 'native', a)).toThrow()
  Object.assign(a.policy, { scope: 'invalid-scope' })
  expect(() => exportRenderMemoryPlan(layout, a)).toThrow('resource policy')
})
