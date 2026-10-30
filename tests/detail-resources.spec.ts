import { expect, test } from '@playwright/test'
import {
  detailMemoryPlan,
  detailStreamMemoryPlan,
  detailFrameMemoryPlan,
  detailPreviewMemoryPlan,
  detailProofMemoryPlan,
  DETAIL_BAND_ROWS,
  DETAIL_GPU_BYTES,
  DETAIL_CPU_WORK_BYTES,
  DETAIL_GPU_HOST_BYTES,
  DETAIL_TILE_BYTES,
  DETAIL_WINDOW_BYTES,
  DETAIL_STAGE_BYTES,
  DETAIL_PARAMETER_BYTES,
} from '../src/shared/detail-resources'
import { resolveResourcePolicy } from '../src/shared/resource-policy'

function detailAdmission() {
  return {
    policy: resolveResourcePolicy(
      { version: 1, ramMiB: 2048, vramMiB: 2048 },
      {
        ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'adapter-unverified' },
      },
      1,
    ),
    reservation: { ramBytes: 123, vramBytes: 456 },
  }
}
test('detail admission includes concurrent source, feature, intermediate, output and readback ownership at unchanged policy limits', () => {
  const a = detailAdmission(),
    p = detailMemoryPlan(a, true)
  expect(DETAIL_GPU_BYTES).toBe(
    2 * DETAIL_WINDOW_BYTES +
      DETAIL_STAGE_BYTES +
      2 * DETAIL_TILE_BYTES +
      2 * DETAIL_PARAMETER_BYTES,
  )
  expect(p.cpu).toEqual({ ramBytes: 123 + DETAIL_CPU_WORK_BYTES, vramBytes: 456 })
  expect(p.gpu).toEqual({
    ramBytes: 123 + DETAIL_GPU_HOST_BYTES,
    vramBytes: 456 + DETAIL_GPU_BYTES,
  })
  expect(p.cpuAccepted && p.gpuAccepted).toBe(true)
  const exact = structuredClone(a)
  Object.assign(exact.policy.ram, { effectiveBytes: p.gpu.ramBytes })
  Object.assign(exact.policy.vram, { effectiveBytes: p.gpu.vramBytes })
  expect(detailMemoryPlan(exact, true).gpuAccepted).toBe(true)
  Object.assign(exact.policy.vram, { effectiveBytes: p.gpu.vramBytes - 1 })
  expect(detailMemoryPlan(exact, true)).toMatchObject({ cpuAccepted: true, gpuAccepted: false })
  Object.assign(exact.policy.ram, { effectiveBytes: p.cpu.ramBytes - 1 })
  expect(detailMemoryPlan(exact, true)).toMatchObject({ cpuAccepted: false, gpuAccepted: false })
  expect(detailMemoryPlan(a, false)).toMatchObject({
    cpu: { ramBytes: 123 + DETAIL_TILE_BYTES, vramBytes: 456 },
    gpu: { ramBytes: 123 + DETAIL_TILE_BYTES, vramBytes: 456 },
  })
  for (const reservation of [
    { ramBytes: -1, vramBytes: 0 },
    { ramBytes: Infinity, vramBytes: 0 },
    { ramBytes: Number.MAX_SAFE_INTEGER, vramBytes: 0 },
  ])
    expect(() => detailMemoryPlan({ ...a, reservation }, true)).toThrow()
})

test('prepared proof admission separates fenced GPU phases and prefers filtering when proof pressure is high', () => {
  const image = { width: 5500, height: 3672 },
    admission = detailAdmission(),
    options = { hdr: true, authoredHdr: false, workingOnly: false, preferGpu: true },
    both = detailPreviewMemoryPlan(image, admission, options)
  expect(both.proofBackend).toBe('gpu')
  expect(both.peakGpuBytes).toBe(
    Math.max(
      both.filter.gpu.vramBytes,
      admission.reservation.vramBytes + both.proofBytes.vramBytes,
    ),
  )
  expect(both.peakGpuBytes).toBeLessThan(both.filter.gpu.vramBytes + both.proofBytes.vramBytes)
  const tight = structuredClone(admission)
  Object.assign(tight.policy.vram, {
    effectiveBytes: admission.reservation.vramBytes + DETAIL_GPU_BYTES,
  })
  const selected = detailPreviewMemoryPlan(image, tight, options)
  expect(selected.proofBackend).toBe('cpu')
  expect(selected.filter.gpuAccepted).toBe(true)
  expect(
    detailPreviewMemoryPlan(image, admission, { ...options, authoredHdr: true }).proofBackend,
  ).toBe('cpu')
  const working = detailPreviewMemoryPlan(image, admission, { ...options, workingOnly: true })
  expect(working.proofBytes).toEqual({ ramBytes: 0, vramBytes: 0 })
  const raster = detailPreviewMemoryPlan(image, admission, { ...options, hdr: false })
  expect(raster.proofBackend).toBe('cpu')
  expect(raster.filter.sourceBytes).toBe(image.width * image.height * 16)
  expect(raster.proofBytes.ramBytes).toBeGreaterThan(image.width * image.height * 24)
})

test('cached-source proof admission does not reserve retired filters and retains exact CPU/GPU budget boundaries', () => {
  const image = { width: 5500, height: 3672 },
    admission = detailAdmission(),
    options = { hdr: true, authoredHdr: false, preferGpu: true },
    gpu = detailProofMemoryPlan(image, admission, options),
    tight = structuredClone(admission)
  expect(gpu.backend).toBe('gpu')
  expect(gpu.accepted).toBe(true)
  Object.assign(tight.policy.ram, { effectiveBytes: gpu.total.ramBytes })
  Object.assign(tight.policy.vram, { effectiveBytes: gpu.total.vramBytes })
  expect(detailProofMemoryPlan(image, tight, options)).toMatchObject({
    backend: 'gpu',
    accepted: true,
  })
  expect(
    detailPreviewMemoryPlan(image, tight, { ...options, workingOnly: false }).filter.cpuAccepted,
  ).toBe(false)
  Object.assign(tight.policy.vram, { effectiveBytes: gpu.total.vramBytes - 1 })
  const cpu = detailProofMemoryPlan(image, tight, options)
  expect(cpu).toMatchObject({ backend: 'cpu', accepted: true })
  expect(cpu.bytes.vramBytes).toBe(0)
  Object.assign(tight.policy.ram, { effectiveBytes: cpu.total.ramBytes - 1 })
  expect(detailProofMemoryPlan(image, tight, options).accepted).toBe(false)
  for (const domain of [
    { hdr: false, authoredHdr: false },
    { hdr: true, authoredHdr: true },
  ]) {
    const proof = detailProofMemoryPlan(image, admission, { ...options, ...domain })
    expect(proof).toMatchObject({ backend: 'cpu', accepted: true })
    expect(proof.bytes.vramBytes).toBe(0)
  }
})

test('frame admission charges backing storage once and separately admits retained output', () => {
  const image = { width: 293, height: 193 },
    a = detailAdmission(),
    input = image.width * image.height * 16,
    backing = input + 4096,
    streamed = detailFrameMemoryPlan(image, a, false, backing),
    retained = detailFrameMemoryPlan(image, a, true, backing)
  expect(streamed.sourceBytes).toBe(backing)
  expect(streamed.retainedOutputBytes).toBe(0)
  expect(retained.retainedOutputBytes).toBe(input)
  expect(retained.cpu.ramBytes - streamed.cpu.ramBytes).toBe(input)
  expect(retained.gpu.ramBytes - streamed.gpu.ramBytes).toBe(input)
  expect(streamed.cpu.ramBytes).toBe(
    a.reservation.ramBytes +
      backing +
      streamed.outputBandBytes +
      streamed.descriptorBytes +
      DETAIL_CPU_WORK_BYTES,
  )
  const exact = structuredClone(a)
  Object.assign(exact.policy.ram, { effectiveBytes: retained.cpu.ramBytes })
  expect(detailFrameMemoryPlan(image, exact, true, backing).cpuAccepted).toBe(true)
  Object.assign(exact.policy.ram, { effectiveBytes: retained.cpu.ramBytes - 1 })
  expect(detailFrameMemoryPlan(image, exact, true, backing).cpuAccepted).toBe(false)
  expect(detailFrameMemoryPlan(image, exact, false, backing).cpuAccepted).toBe(true)
  for (const bytes of [input - 1, NaN, Infinity, 512 * 1024 ** 2 + 1])
    expect(() => detailFrameMemoryPlan(image, a, true, bytes)).toThrow()
})

test('stream admission bounds source halos and output bands independently of full-photo size', () => {
  const image = { width: 5500, height: 3672 },
    admission = detailAdmission(),
    p = detailStreamMemoryPlan(image, admission, true)
  expect(p.sourceBytes).toBe(image.width * 3 * DETAIL_BAND_ROWS * 16)
  expect(p.outputBandBytes).toBe(image.width * DETAIL_BAND_ROWS * 16)
  expect(p.cpu.ramBytes).toBe(
    admission.reservation.ramBytes +
      p.sourceBytes +
      p.outputBandBytes +
      p.descriptorBytes +
      DETAIL_CPU_WORK_BYTES,
  )
  expect(p.gpu.ramBytes).toBe(
    admission.reservation.ramBytes +
      p.sourceBytes +
      p.outputBandBytes +
      p.descriptorBytes +
      DETAIL_GPU_HOST_BYTES,
  )
  expect(p.gpu.ramBytes).toBeLessThan((image.width * image.height * 16) / 8)
  const exact = structuredClone(admission)
  Object.assign(exact.policy.ram, { effectiveBytes: p.cpu.ramBytes })
  expect(detailStreamMemoryPlan(image, exact, true).cpuAccepted).toBe(true)
  Object.assign(exact.policy.ram, { effectiveBytes: p.cpu.ramBytes - 1 })
  expect(detailStreamMemoryPlan(image, exact, true).cpuAccepted).toBe(false)
  const neutral = detailStreamMemoryPlan(image, admission, false)
  expect(neutral.sourceBytes).toBe(image.width * DETAIL_BAND_ROWS * 16)
  expect(neutral.outputBandBytes).toBe(0)
  expect(neutral.gpu.vramBytes).toBe(admission.reservation.vramBytes)
  for (const size of [
    { width: 0, height: 1 },
    { width: 32769, height: 2 },
    { width: 32768, height: 32768 },
  ])
    expect(() => detailStreamMemoryPlan(size, admission, true)).toThrow()
})
