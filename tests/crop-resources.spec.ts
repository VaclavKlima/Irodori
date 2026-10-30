import { expect, test } from '@playwright/test'
import { cropGeometry, fitCrop, identityCrop } from '../src/shared/crop'
import { CROP_COMPUTE_BYTES, cropMemoryPlan } from '../src/shared/crop-resources'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'

const policy = () =>
  structuredClone(
    resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      {
        ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'unavailable' },
      },
      7,
    ),
  )
test('crop admission accounts source/destination, tile staging and existing/retiring owners', () => {
  const size = { width: 5496, height: 3672 },
    geometry = cropGeometry(size, fitCrop(size, { ...identityCrop, angle: 12.34 })),
    reservation = { ramBytes: 400 * 1024 ** 2, vramBytes: 800 * 1024 ** 2 },
    context = { policy: policy(), reservation },
    plan = cropMemoryPlan(geometry, context)
  expect(plan.cpuAccepted).toBe(true)
  expect(plan.gpuAccepted).toBe(true)
  expect(plan.cpu.ramBytes).toBeGreaterThan(reservation.ramBytes + size.width * size.height * 16)
  expect(plan.cpu.vramBytes).toBe(reservation.vramBytes)
  expect(plan.gpu.ramBytes).toBeGreaterThan(plan.cpu.ramBytes)
  expect(plan.gpu.vramBytes - reservation.vramBytes).toBe(CROP_COMPUTE_BYTES)
  const changed = policy()
  Object.assign(changed.ram, { effectiveBytes: plan.cpu.ramBytes - 1 })
  const refused = cropMemoryPlan(geometry, { ...context, policy: changed })
  expect(refused.cpuAccepted).toBe(false)
  expect(refused.gpuAccepted).toBe(false)
  Object.assign(changed.ram, { effectiveBytes: plan.gpu.ramBytes })
  Object.assign(changed.vram, { effectiveBytes: plan.gpu.vramBytes - 1 })
  const cpu = cropMemoryPlan(geometry, { ...context, policy: changed })
  expect(cpu.cpuAccepted).toBe(true)
  expect(cpu.gpuAccepted).toBe(false)
})
test('identity adds no allocation and integer selection needs only its destination and source strip', () => {
  const size = { width: 5496, height: 3672 },
    reservation = { ramBytes: 123, vramBytes: 456 },
    context = { policy: policy(), reservation },
    identity = cropMemoryPlan(cropGeometry(size, identityCrop), context),
    crop = cropMemoryPlan(cropGeometry(size, { ...identityCrop, width: 0.5, height: 0.5 }), context)
  expect(identity.cpu).toEqual(reservation)
  expect(identity.gpu).toEqual(reservation)
  expect(crop.integer).toBe(true)
  expect(crop.cpu.ramBytes).toBe(reservation.ramBytes + 2748 * 1836 * 16 + 5496 * 64 * 16)
  expect(crop.gpu).toEqual(crop.cpu)
})
test('malformed reservations, budgets and over-limit images cannot bypass admission', () => {
  const geometry = cropGeometry({ width: 7, height: 5 }, identityCrop),
    context = { policy: policy(), reservation: { ramBytes: 0, vramBytes: 0 } }
  expect(() =>
    cropMemoryPlan(geometry, { ...context, reservation: { ramBytes: -1, vramBytes: 0 } }),
  ).toThrow('reservation')
  Object.assign(context.policy.ram, { effectiveBytes: NaN })
  expect(() => cropMemoryPlan(geometry, context)).toThrow('accounting')
  expect(() =>
    cropMemoryPlan(cropGeometry({ width: 32768, height: 32768 }, identityCrop), {
      policy: policy(),
      reservation: { ramBytes: 0, vramBytes: 0 },
    }),
  ).toThrow('image memory limit')
})
