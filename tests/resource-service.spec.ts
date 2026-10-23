import { expect, test } from '@playwright/test'
import { ResourceService, validateResourceAdapterIdentity } from '../src/main/resource-service'
import { DEFAULT_RESOURCE_SETTINGS } from '../src/shared/resource-policy'
import type { ResourceHardwareSnapshot, ResourceSettingsFiles } from '../src/main/resource-settings'

const GiB = 1024 ** 3,
  adapter = { vendor: 'amd', architecture: 'rdna-3', device: '0x744c', description: '' }

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function hardware(availableBytes = 16 * GiB): ResourceHardwareSnapshot {
  return {
    observedAt: '2026-10-19T14:00:00.000Z',
    platform: 'linux',
    ram: { totalBytes: 32 * GiB, availableBytes },
    inventoryComplete: true,
    issues: [],
    gpus: [
      {
        adapterId: '0000:03:00.0',
        vendorId: '0x1002',
        deviceId: '0x744c',
        totalBytes: 24 * GiB,
        usedBytes: 2 * GiB,
      },
    ],
  }
}

function observationQueue() {
  type Request = ReturnType<typeof deferred<ResourceHardwareSnapshot>>
  const queued: Request[] = [],
    waiters: ((request: Request) => void)[] = []
  let count = 0
  return {
    observe: () => {
      count++
      const request = deferred<ResourceHardwareSnapshot>(),
        waiter = waiters.shift()
      if (waiter) waiter(request)
      else queued.push(request)
      return request.promise
    },
    next: () => {
      const ready = queued.shift()
      return ready
        ? Promise.resolve(ready)
        : new Promise<Request>((resolve) => waiters.push(resolve))
    },
    get count() {
      return count
    },
  }
}

function files() {
  const values = new Map<string, string>()
  let fail = false
  const io: ResourceSettingsFiles = {
    read: async (path) => {
      const value = values.get(path)
      if (value === undefined)
        throw Object.assign(new Error('Missing isolated preference.'), { code: 'ENOENT' })
      return value
    },
    prepareDirectory: async () => undefined,
    writeExclusive: async (path, text) => {
      values.set(path, text)
    },
    rename: async (from, to) => {
      if (fail) {
        fail = false
        throw new Error('Injected rename failure.')
      }
      values.set(to, values.get(from)!)
      values.delete(from)
    },
    remove: async (path) => {
      values.delete(path)
    },
  }
  return {
    io,
    values,
    fail: () => {
      fail = true
    },
  }
}

function controller() {
  const observations = observationQueue(),
    disk = files(),
    service = new ResourceService('/isolated-resource-service', {
      files: disk.io,
      observeHardware: observations.observe,
    })
  return { service, observations, disk }
}

test('controller open only loads preferences; every UI policy is a fresh frozen hardware observation', async () => {
  const { service, observations } = controller()
  await service.open()
  expect(observations.count).toBe(0)
  const first = service.getSettings(),
    firstObservation = await observations.next()
  firstObservation.resolve(hardware())
  const initial = await first
  expect(initial).toMatchObject({
    settings: DEFAULT_RESOURCE_SETTINGS,
    revision: 0,
    status: 'default',
    issue: null,
  })
  expect(initial.policy.revision).toBe(1)
  expect(initial.policy.vram.capacityStatus).toBe('unknown')
  expect(initial.policy.ram.effectiveBytes).toBe(8 * GiB)
  const next = service.getSettings(),
    nextObservation = await observations.next()
  nextObservation.resolve(hardware(0))
  const updated = await next
  expect(updated.policy.revision).toBe(2)
  expect(updated.policy.ram.effectiveBytes).toBe(0)
  expect(initial.policy.ram.effectiveBytes).toBe(8 * GiB)
  expect(Object.isFrozen(initial)).toBe(true)
  expect(Object.isFrozen(initial.settings)).toBe(true)
  expect(Object.isFrozen(initial.policy.ram)).toBe(true)
  await service.drain()
})

test('held policy uses its detached settings while a newer save completes', async () => {
  const { service, observations } = controller()
  const old = service.getPolicy(null),
    oldObservation = await observations.next()
  const saving = service.saveSettings({ version: 1, ramMiB: 128, vramMiB: 4096 }),
    savedObservation = await observations.next()
  savedObservation.resolve(hardware())
  const saved = await saving
  expect(saved.revision).toBe(1)
  expect(saved.policy.revision).toBe(2)
  expect(saved.policy.ram).toMatchObject({
    mode: 'custom',
    requestedMiB: 128,
    effectiveBytes: 128 * 1024 ** 2,
  })
  oldObservation.resolve(hardware())
  const prior = await old
  expect(prior.revision).toBe(1)
  expect(prior.ram).toMatchObject({
    mode: 'automatic',
    requestedMiB: null,
    effectiveBytes: 8 * GiB,
  })
  expect(saved.settings.ramMiB).toBe(128)
})

test('reversed completion does not renumber snapshots or restore an old adapter proof to the UI', async () => {
  const { service, observations } = controller()
  const older = service.getPolicy(adapter),
    olderObservation = await observations.next()
  const newer = service.getPolicy(null),
    newerObservation = await observations.next()
  newerObservation.resolve(hardware())
  const second = await newer
  expect(second).toMatchObject({ revision: 2, gpuAdapterId: null })
  olderObservation.resolve(hardware())
  const first = await older
  expect(first).toMatchObject({ revision: 1, gpuAdapterId: '0000:03:00.0' })
  const ui = service.getSettings(),
    uiObservation = await observations.next()
  uiObservation.resolve(hardware())
  expect((await ui).policy).toMatchObject({ revision: 3, gpuAdapterId: null })
})

test('queued settings replies retain their own saved revision across held hardware observations', async () => {
  const { service, observations } = controller()
  const first = service.saveSettings({ version: 1, ramMiB: 128, vramMiB: null }),
    firstObservation = await observations.next()
  const second = service.saveSettings({ version: 1, ramMiB: 256, vramMiB: null }),
    secondObservation = await observations.next()
  secondObservation.resolve(hardware())
  const latest = await second
  firstObservation.resolve(hardware())
  const earlier = await first
  expect(earlier).toMatchObject({ revision: 1, settings: { ramMiB: 128 } })
  expect(earlier.policy.ram.requestedMiB).toBe(128)
  expect(latest).toMatchObject({ revision: 2, settings: { ramMiB: 256 } })
  expect(latest.policy.ram.requestedMiB).toBe(256)
  expect(earlier.policy.revision).toBeLessThan(latest.policy.revision)
})

test('adapter identity is detached before observation and UI policy uses only the last actual report', async () => {
  const { service, observations } = controller(),
    reported = { ...adapter }
  const resolving = service.getPolicy(reported),
    observation = await observations.next()
  reported.device = '0x164e'
  observation.resolve(hardware())
  expect((await resolving).gpuAdapterId).toBe('0000:03:00.0')
  const ui = service.getSettings(),
    uiObservation = await observations.next()
  uiObservation.resolve(hardware())
  expect((await ui).policy.gpuAdapterId).toBe('0000:03:00.0')
  const privateId = service.getPolicy({ ...adapter, device: '' }),
    privateObservation = await observations.next()
  privateObservation.resolve(hardware())
  expect((await privateId).vram).toMatchObject({
    capacityStatus: 'unknown',
    unknownCapacityReason: 'adapter-unverified',
  })
})

for (const value of [
  undefined,
  [],
  {},
  { ...adapter, device: 12 },
  { ...adapter, description: 'x'.repeat(257) },
  { ...adapter, path: '/user/file' },
])
  test(`invalid adapter DTO is rejected before hardware observation: ${JSON.stringify(value)}`, async () => {
    const { service, observations, disk } = controller()
    await expect(service.getPolicy(value)).rejects.toThrow('adapter identity')
    expect(observations.count).toBe(0)
    expect(disk.values.size).toBe(0)
  })

test('valid maximum-sized four-string adapter DTO is detached and null remains explicit unknown', () => {
  const value = { vendor: 'x'.repeat(256), architecture: '', device: '', description: '' }
  const checked = validateResourceAdapterIdentity(value)
  expect(checked).toEqual(value)
  expect(checked).not.toBe(value)
  expect(Object.isFrozen(checked)).toBe(true)
  expect(validateResourceAdapterIdentity(null)).toBeNull()
})

test('successful save followed by failed observation reports persistence honestly and permits retry', async () => {
  const { service, observations, disk } = controller()
  const saving = service.saveSettings({ version: 1, ramMiB: 128, vramMiB: null }),
    observation = await observations.next()
  const rejected = expect(saving).rejects.toThrow('settings were saved')
  observation.reject(new Error('Fixed RAM observation unavailable.'))
  await rejected
  expect(JSON.parse([...disk.values.values()][0]).ramMiB).toBe(128)
  const retry = service.getSettings(),
    retryObservation = await observations.next()
  retryObservation.resolve(hardware())
  expect(await retry).toMatchObject({
    revision: 1,
    settings: { ramMiB: 128 },
    policy: { revision: 2 },
  })
})

test('failed store write does not observe policy or poison the next controller save', async () => {
  const { service, observations, disk } = controller()
  disk.fail()
  await expect(service.saveSettings({ version: 1, ramMiB: 128, vramMiB: null })).rejects.toThrow(
    'previous settings remain active',
  )
  expect(observations.count).toBe(0)
  const retry = service.saveSettings({ version: 1, ramMiB: 256, vramMiB: null }),
    observation = await observations.next()
  observation.resolve(hardware())
  expect(await retry).toMatchObject({
    revision: 1,
    settings: { ramMiB: 256 },
    policy: { revision: 1 },
  })
})

test('shutdown drains pending preference publication while read-only policy observation stays separate', async () => {
  const { service, observations, disk } = controller(),
    entered = deferred<void>(),
    held = deferred<void>(),
    rename = disk.io.rename
  disk.io.rename = async (from, to) => {
    entered.resolve()
    await held.promise
    await rename(from, to)
  }
  const saving = service.saveSettings({ version: 1, ramMiB: 128, vramMiB: null })
  await entered.promise
  let drained = false
  const draining = service.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  held.resolve()
  await draining
  expect([...disk.values.keys()]).toEqual(['/isolated-resource-service/resource-settings.json'])
  expect(JSON.parse([...disk.values.values()][0]).ramMiB).toBe(128)
  const observation = await observations.next()
  observation.resolve(hardware())
  expect((await saving).revision).toBe(1)
})
