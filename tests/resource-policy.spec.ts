import { expect, test } from '@playwright/test'
import {
  DEFAULT_RESOURCE_SETTINGS,
  RESOURCE_MIB,
  RESOURCE_POLICY_VERSION,
  RESOURCE_UNKNOWN_GPU_BYTES,
  resolveResourcePolicy,
  validateResourceSettings,
  type ResourceMemoryObservation,
  type ResourceSettings,
} from '../src/shared/resource-policy'

const GiB = 1024 * RESOURCE_MIB
const machine = (): ResourceMemoryObservation => ({
  ram: { totalBytes: 32 * GiB, availableBytes: 24 * GiB },
  gpu: {
    status: 'matched',
    adapterId: 'pci:0000:03:00.0:1002:744c',
    totalBytes: 24 * GiB,
    availableBytes: 20 * GiB,
  },
})

test('Automatic resolves independent RAM and proven GPU capacity shares', () => {
  const result = resolveResourcePolicy(DEFAULT_RESOURCE_SETTINGS, machine(), 7)
  expect(result.version).toBe(RESOURCE_POLICY_VERSION)
  expect(result.scope).toBe('managed-image-resources')
  expect(result.revision).toBe(7)
  expect(result.ram.effectiveBytes).toBe(8 * GiB)
  expect(result.vram.effectiveBytes).toBe(6 * GiB)
  expect(result.ram.mode).toBe('automatic')
  expect(result.vram.basis).toBe('automatic-capacity')
  expect(result.vram.capacityStatus).toBe('known')
  expect(result.vram.fallbackBytes).toBeNull()
  expect(result.gpuAdapterId).toBe('pci:0000:03:00.0:1002:744c')
})

test('Automatic leaves current headroom without treating MemAvailable as capacity', () => {
  const memory: ResourceMemoryObservation = {
    ram: { totalBytes: 32 * GiB, availableBytes: 2 * GiB },
    gpu: { status: 'matched', adapterId: 'test', totalBytes: 24 * GiB, availableBytes: GiB },
  }
  const result = resolveResourcePolicy(DEFAULT_RESOURCE_SETTINGS, memory, 0)
  expect(result.ram.effectiveBytes).toBe(1536 * RESOURCE_MIB)
  expect(result.vram.effectiveBytes).toBe(768 * RESOURCE_MIB)
  expect(result.ram.basis).toBe('automatic-available')
  expect(result.vram.basis).toBe('automatic-available')
  expect(result.ram.capacityBytes).toBe(32 * GiB)
})

test('Automatic has no floor that invents memory on a small or exhausted machine', () => {
  for (const availableBytes of [0, 1, RESOURCE_MIB - 1, RESOURCE_MIB, 2 * RESOURCE_MIB]) {
    const result = resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      {
        ram: { totalBytes: 4 * RESOURCE_MIB, availableBytes },
        gpu: {
          status: 'matched',
          adapterId: 'tiny',
          totalBytes: 4 * RESOURCE_MIB,
          availableBytes,
        },
      },
      0,
    )
    for (const budget of [result.ram, result.vram]) {
      expect(budget.effectiveBytes).toBeLessThanOrEqual(Math.floor(availableBytes * 0.75))
      expect(budget.effectiveBytes % RESOURCE_MIB).toBe(0)
    }
  }
})

test('missing availability uses capacity and retains its unknown state', () => {
  const result = resolveResourcePolicy(
    DEFAULT_RESOURCE_SETTINGS,
    {
      ram: { totalBytes: 8 * GiB, availableBytes: null },
      gpu: { status: 'matched', adapterId: 'test', totalBytes: 4 * GiB, availableBytes: null },
    },
    1,
  )
  expect(result.ram.effectiveBytes).toBe(2 * GiB)
  expect(result.vram.effectiveBytes).toBe(GiB)
  expect(result.ram.availableBytes).toBeNull()
  expect(result.vram.availableBytes).toBeNull()
})

for (const reason of [
  'unavailable',
  'adapter-unverified',
  'adapter-mismatch',
  'ambiguous-adapter',
] as const) {
  test(`unproven GPU capacity uses an explicit conservative Automatic fallback: ${reason}`, () => {
    const result = resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      { ...machine(), gpu: { status: 'unknown', reason } },
      1,
    )
    expect(result.vram.effectiveBytes).toBe(RESOURCE_UNKNOWN_GPU_BYTES)
    expect(result.vram.fallbackBytes).toBe(RESOURCE_UNKNOWN_GPU_BYTES)
    expect(result.vram.capacityStatus).toBe('unknown')
    expect(result.vram.capacityBytes).toBeNull()
    expect(result.vram.availableBytes).toBeNull()
    expect(result.vram.unknownCapacityReason).toBe(reason)
    expect(result.vram.basis).toBe('automatic-unknown-gpu')
    expect(result.gpuAdapterId).toBeNull()
  })
}

test('custom requests survive smaller hardware and are clamped independently to physical capacity', () => {
  const settings = validateResourceSettings({ version: 1, ramMiB: 12288, vramMiB: 8192 })
  const small = resolveResourcePolicy(
    settings,
    {
      ram: { totalBytes: 8 * GiB + 100, availableBytes: RESOURCE_MIB },
      gpu: {
        status: 'matched',
        adapterId: 'smaller',
        totalBytes: 4 * GiB + 100,
        availableBytes: 0,
      },
    },
    2,
  )
  expect(small.ram.effectiveBytes).toBe(8 * GiB)
  expect(small.vram.effectiveBytes).toBe(4 * GiB)
  expect(small.ram.capacityClamped).toBe(true)
  expect(small.vram.basis).toBe('custom-physical-capacity')
  expect(settings).toEqual({ version: 1, ramMiB: 12288, vramMiB: 8192 })
  const large = resolveResourcePolicy(settings, machine(), 3)
  expect(large.ram.effectiveBytes).toBe(12 * GiB)
  expect(large.vram.effectiveBytes).toBe(8 * GiB)
  expect(large.ram.capacityClamped).toBe(false)
  expect(large.vram.basis).toBe('custom-request')
})

test('custom is honored when GPU capacity is unknown and does not claim fallback or capacity proof', () => {
  const result = resolveResourcePolicy(
    { version: 1, ramMiB: null, vramMiB: 6144 },
    { ...machine(), gpu: { status: 'unknown', reason: 'ambiguous-adapter' } },
    4,
  )
  expect(result.vram.effectiveBytes).toBe(6 * GiB)
  expect(result.vram.requestedMiB).toBe(6144)
  expect(result.vram.capacityStatus).toBe('unknown')
  expect(result.vram.unknownCapacityReason).toBe('ambiguous-adapter')
  expect(result.vram.fallbackBytes).toBeNull()
  expect(result.vram.capacityClamped).toBe(false)
})

test('captured snapshots are detached from mutable observations and later settings', () => {
  const settings = { version: 1 as const, ramMiB: 1024 as number | null, vramMiB: null }
  const observation = machine()
  const snapshot = resolveResourcePolicy(settings, observation, 8)
  settings.ramMiB = 4096
  Object.assign(observation.ram, { availableBytes: 0 })
  const next = resolveResourcePolicy(settings, observation, 9)
  expect(snapshot.ram.effectiveBytes).toBe(GiB)
  expect(snapshot.ram.availableBytes).toBe(24 * GiB)
  expect(next.ram.effectiveBytes).toBe(4 * GiB)
  expect(snapshot.revision).toBe(8)
  expect(next.revision).toBe(9)
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.ram)).toBe(true)
  expect(Object.isFrozen(snapshot.vram)).toBe(true)
  expect(Object.isFrozen(validateResourceSettings(settings))).toBe(true)
})

test('Automatic and custom remain exact safe integers at the supported numeric boundary', () => {
  const maximumMiB = Math.floor(Number.MAX_SAFE_INTEGER / RESOURCE_MIB)
  const result = resolveResourcePolicy(
    { version: 1, ramMiB: maximumMiB, vramMiB: null },
    {
      ram: { totalBytes: Number.MAX_SAFE_INTEGER, availableBytes: Number.MAX_SAFE_INTEGER },
      gpu: {
        status: 'matched',
        adapterId: 'boundary',
        totalBytes: Number.MAX_SAFE_INTEGER,
        availableBytes: Number.MAX_SAFE_INTEGER,
      },
    },
    Number.MAX_SAFE_INTEGER,
  )
  expect(result.ram.effectiveBytes).toBe(maximumMiB * RESOURCE_MIB)
  expect(Number.isSafeInteger(result.vram.effectiveBytes)).toBe(true)
  expect(result.vram.effectiveBytes % RESOURCE_MIB).toBe(0)
  expect(() =>
    validateResourceSettings({ version: 1, ramMiB: maximumMiB + 1, vramMiB: null }),
  ).toThrow()
})

test('settings reject malformed persisted values without coercion or silent defaults', () => {
  const invalid = [
    undefined,
    null,
    [],
    {},
    { ramMiB: null, vramMiB: null },
    { version: 2, ramMiB: null, vramMiB: null },
    { version: 1, ramMiB: null, vramMiB: null, extra: true },
    ...[0, -1, 1.5, '1024', false, NaN, Infinity, Number.MAX_SAFE_INTEGER].map((ramMiB) => ({
      version: 1,
      ramMiB,
      vramMiB: null,
    })),
    ...[0, -1, 1.5, '1024', false, NaN, Infinity, Number.MAX_SAFE_INTEGER].map((vramMiB) => ({
      version: 1,
      ramMiB: null,
      vramMiB,
    })),
  ]
  for (const value of invalid) expect(() => validateResourceSettings(value)).toThrow()
})

test('resolver rejects invalid observations and cannot admit capacity hidden behind unknown status', () => {
  const invalid: unknown[] = [
    { ...machine(), extra: true },
    { ...machine(), ram: { totalBytes: 0, availableBytes: 0 } },
    { ...machine(), ram: { totalBytes: GiB, availableBytes: GiB + 1 } },
    { ...machine(), ram: { totalBytes: GiB, availableBytes: -1 } },
    { ...machine(), ram: { totalBytes: GiB, availableBytes: NaN } },
    { ...machine(), ram: { totalBytes: GiB, availableBytes: 0.5 } },
    { ...machine(), gpu: { status: 'unknown', reason: 'largest-gpu' } },
    {
      ...machine(),
      gpu: { status: 'unknown', reason: 'adapter-unverified', totalBytes: 24 * GiB },
    },
    {
      ...machine(),
      gpu: { status: 'matched', adapterId: ' ', totalBytes: GiB, availableBytes: 0 },
    },
    {
      ...machine(),
      gpu: { status: 'matched', adapterId: 'bad', totalBytes: GiB, availableBytes: GiB + 1 },
    },
    {
      ...machine(),
      gpu: { status: 'matched', adapterId: 'bad', totalBytes: Infinity, availableBytes: null },
    },
  ]
  for (const observation of invalid)
    expect(() =>
      resolveResourcePolicy(DEFAULT_RESOURCE_SETTINGS, observation as ResourceMemoryObservation, 0),
    ).toThrow()
  for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => resolveResourcePolicy(DEFAULT_RESOURCE_SETTINGS, machine(), revision)).toThrow()
  expect(() =>
    resolveResourcePolicy(
      { ...DEFAULT_RESOURCE_SETTINGS, ramMiB: '2048' } as unknown as ResourceSettings,
      machine(),
      0,
    ),
  ).toThrow()
})
