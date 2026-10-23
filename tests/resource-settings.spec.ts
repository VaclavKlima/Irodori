import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  matchResourceAdapter,
  observeResourceHardware,
  ResourceSettingsStore,
  type ResourceHardwareIO,
  type ResourceSettingsFiles,
  type WebGpuAdapterIdentity,
} from '../src/main/resource-settings'
import { DEFAULT_RESOURCE_SETTINGS } from '../src/shared/resource-policy'

const GiB = 1024 ** 3,
  profile = '/isolated-test-profile',
  settingsPath = join(profile, 'resource-settings.json'),
  exactAdapter: WebGpuAdapterIdentity = {
    vendor: 'amd',
    architecture: 'rdna-3',
    device: '0x744c',
    description: '',
  }

function unavailable() {
  return Object.assign(new Error('Unavailable fake fixed resource.'), { code: 'ENOENT' })
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function hardware() {
  const text = new Map<string, string>([
      ['/proc/meminfo', 'MemTotal: 33554432 kB\nMemFree: 128 kB\nMemAvailable: 22020096 kB\n'],
    ]),
    links = new Map<string, string>(),
    cards = ['card0', 'card1', 'renderD128', 'card0-DP-2'],
    reads: string[] = []
  const add = (card: string, address: string, device: string, total: number, used: number) => {
    links.set(`/sys/class/drm/${card}/device`, `/sys/devices/pci0000:00/${address}`)
    const base = `/sys/bus/pci/devices/${address}`
    text.set(`${base}/vendor`, '0x1002\n')
    text.set(`${base}/device`, `${device}\n`)
    text.set(`${base}/mem_info_vram_total`, `${total}\n`)
    text.set(`${base}/mem_info_vram_used`, `${used}\n`)
  }
  add('card0', '0000:03:00.0', '0x744c', 24 * GiB, 2 * GiB)
  add('card1', '0000:0e:00.0', '0x164e', 512 * 1024 ** 2, 64 * 1024 ** 2)
  const io: ResourceHardwareIO = {
    platform: 'linux',
    totalMemory: () => 32 * GiB,
    now: () => '2026-10-19T13:00:00.000Z',
    readDirectory: async (path) => {
      expect(path).toBe('/sys/class/drm')
      return [...cards]
    },
    realpath: async (path) => {
      reads.push(path)
      const value = links.get(path)
      if (value === undefined) throw unavailable()
      return value
    },
    readText: async (path, maximumBytes) => {
      reads.push(path)
      const value = text.get(path)
      if (value === undefined) throw unavailable()
      if (Buffer.byteLength(value) > maximumBytes) throw new Error('Fake bounded read exceeded.')
      return value
    },
  }
  return { io, text, links, cards, reads, add }
}

test('fixed hardware observation uses MemAvailable, deduplicates PCI aliases and ignores connector/render entries', async () => {
  const fake = hardware()
  fake.cards.push('card2')
  fake.links.set('/sys/class/drm/card2/device', fake.links.get('/sys/class/drm/card0/device')!)
  const observed = await observeResourceHardware(fake.io)
  expect(observed.ram).toEqual({ totalBytes: 32 * GiB, availableBytes: 21 * GiB })
  expect(observed.inventoryComplete).toBe(true)
  expect(observed.gpus).toHaveLength(2)
  expect(observed.issues).toEqual([])
  expect(
    fake.reads.filter((path) => path.endsWith('/0000:03:00.0/mem_info_vram_total')),
  ).toHaveLength(1)
  expect(
    fake.reads.some((path) => path.includes('renderD128') || path.includes('card0-DP-2')),
  ).toBe(false)
  expect(matchResourceAdapter(observed, exactAdapter).gpu).toEqual({
    status: 'matched',
    adapterId: '0000:03:00.0',
    totalBytes: 24 * GiB,
    availableBytes: 22 * GiB,
  })
})

test('actual host-style AMD identity with hidden device ID cannot select the larger of two AMD GPUs', async () => {
  const observed = await observeResourceHardware(hardware().io)
  expect(
    matchResourceAdapter(observed, {
      vendor: 'amd',
      architecture: 'rdna-3',
      device: '',
      description: '',
    }).gpu,
  ).toEqual({ status: 'unknown', reason: 'adapter-unverified' })
  expect(matchResourceAdapter(observed, { ...exactAdapter, vendor: 'nvidia' }).gpu).toEqual({
    status: 'unknown',
    reason: 'adapter-mismatch',
  })
  expect(
    matchResourceAdapter(observed, {
      ...exactAdapter,
      device: '',
      description: 'AMD Radeon RX 7900 XTX',
    }).gpu,
  ).toEqual({ status: 'unknown', reason: 'adapter-unverified' })
})

test('identical PCI vendor/device on two adapters remains ambiguous; partial inventory cannot prove uniqueness', async () => {
  const fake = hardware()
  fake.text.set('/sys/bus/pci/devices/0000:0e:00.0/device', '0x744c\n')
  const observed = await observeResourceHardware(fake.io)
  expect(matchResourceAdapter(observed, exactAdapter).gpu).toEqual({
    status: 'unknown',
    reason: 'ambiguous-adapter',
  })
  fake.links.delete('/sys/class/drm/card1/device')
  const partial = await observeResourceHardware(fake.io)
  expect(partial.gpus).toHaveLength(1)
  expect(partial.inventoryComplete).toBe(false)
  expect(matchResourceAdapter(partial, exactAdapter).gpu).toEqual({
    status: 'unknown',
    reason: 'unavailable',
  })
})

for (const value of [
  'MemAvailable: -1 kB\n',
  'MemAvailable: 1 MB\n',
  'MemAvailable: NaN kB\n',
  'MemAvailable: 9007199254740992 kB\n',
  'MemAvailable: 999999999 kB\n',
  'MemAvailable: 1 kB\nMemAvailable: 2 kB\n',
  'MemFree: 123456 kB\n',
])
  test(`malformed or absent MemAvailable stays unknown: ${JSON.stringify(value)}`, async () => {
    const fake = hardware()
    fake.text.set('/proc/meminfo', value)
    const observed = await observeResourceHardware(fake.io)
    expect(observed.ram).toEqual({ totalBytes: 32 * GiB, availableBytes: null })
    expect(observed.issues).toContainEqual({ scope: 'ram-available', reason: 'malformed' })
  })

test('zero available RAM is real zero, but missing VRAM observations never become zero capacities', async () => {
  const fake = hardware(),
    base = '/sys/bus/pci/devices/0000:03:00.0'
  fake.text.set('/proc/meminfo', 'MemAvailable: 0 kB\n')
  fake.text.delete(`${base}/mem_info_vram_used`)
  const observed = await observeResourceHardware(fake.io)
  expect(observed.ram.availableBytes).toBe(0)
  expect(observed.gpus[0].usedBytes).toBeNull()
  expect(matchResourceAdapter(observed, exactAdapter).gpu).toEqual({
    status: 'matched',
    adapterId: '0000:03:00.0',
    totalBytes: 24 * GiB,
    availableBytes: null,
  })
  fake.text.set(`${base}/mem_info_vram_total`, '0\n')
  expect(matchResourceAdapter(await observeResourceHardware(fake.io), exactAdapter).gpu).toEqual({
    status: 'unknown',
    reason: 'unavailable',
  })
})

test('oversized or inconsistent GPU counters and invalid PCI identities are explicit unknowns', async () => {
  const fake = hardware(),
    base = '/sys/bus/pci/devices/0000:03:00.0'
  fake.text.set(`${base}/mem_info_vram_used`, `${25 * GiB}\n`)
  let observed = await observeResourceHardware(fake.io)
  expect(observed.gpus[0].usedBytes).toBeNull()
  expect(observed.issues).toContainEqual({
    scope: 'gpu-used',
    reason: 'malformed',
    adapterId: '0000:03:00.0',
  })
  fake.text.set(`${base}/mem_info_vram_total`, '9007199254740992\n')
  observed = await observeResourceHardware(fake.io)
  expect(observed.gpus[0].totalBytes).toBeNull()
  fake.links.set('/sys/class/drm/card0/device', '/arbitrary/location/not-a-pci-device')
  observed = await observeResourceHardware(fake.io)
  expect(observed.inventoryComplete).toBe(false)
  expect(fake.reads.some((path) => path.startsWith('/arbitrary'))).toBe(false)
})

test('non-Linux or invalid total RAM never fabricates Linux hardware observations', async () => {
  const fake = hardware()
  fake.io.platform = 'unsupported'
  const observed = await observeResourceHardware(fake.io)
  expect(observed.ram.availableBytes).toBeNull()
  expect(observed.gpus).toEqual([])
  expect(fake.reads).toEqual([])
  fake.io.totalMemory = () => NaN
  await expect(observeResourceHardware(fake.io)).rejects.toThrow('valid total RAM')
})

test('a bounded partial GPU inventory never becomes proof of a unique adapter', async () => {
  const fake = hardware()
  fake.cards.length = 0
  for (let index = 0; index < 33; index++) {
    const card = `card${index}`
    fake.cards.push(card)
    fake.links.set(`/sys/class/drm/${card}/device`, '/sys/devices/pci0000:00/0000:03:00.0')
  }
  const observed = await observeResourceHardware(fake.io)
  expect(observed.inventoryComplete).toBe(false)
  expect(observed.issues).toContainEqual({ scope: 'gpu-inventory', reason: 'limit-exceeded' })
  expect(fake.reads.filter((path) => path.startsWith('/sys/class/drm/'))).toHaveLength(32)
  expect(matchResourceAdapter(observed, exactAdapter).gpu).toEqual({
    status: 'unknown',
    reason: 'unavailable',
  })
})

function fileSystem() {
  const files = new Map<string, string>(),
    calls: { operation: string; path: string }[] = []
  let renameGate: ReturnType<typeof gate> | undefined,
    renameEntered = gate(),
    failCreate = false,
    failWrite = false,
    failRename = false
  const io: ResourceSettingsFiles = {
    read: async (path, maximumBytes) => {
      calls.push({ operation: 'read', path })
      const text = files.get(path)
      if (text === undefined) throw unavailable()
      if (Buffer.byteLength(text) > maximumBytes) throw new Error('Bounded settings read exceeded.')
      return text
    },
    prepareDirectory: async (path) => {
      calls.push({ operation: 'prepare', path })
    },
    writeExclusive: async (path, contents) => {
      calls.push({ operation: 'write', path })
      if (failCreate) {
        failCreate = false
        throw new Error('Injected exclusive create failure.')
      }
      if (files.has(path)) throw new Error('Exclusive temporary exists.')
      files.set(path, contents)
      if (failWrite) {
        failWrite = false
        await io.remove(path)
        throw new Error('Injected partial write.')
      }
    },
    rename: async (from, to) => {
      calls.push({ operation: 'rename', path: to })
      renameEntered.release()
      await renameGate?.promise
      if (failRename) {
        failRename = false
        throw new Error('Injected rename failure.')
      }
      if (!files.has(from)) throw unavailable()
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    remove: async (path) => {
      calls.push({ operation: 'remove', path })
      files.delete(path)
    },
  }
  return {
    io,
    files,
    calls,
    holdRename: () => {
      renameGate = gate()
      renameEntered = gate()
      return {
        entered: renameEntered.promise,
        release: () => {
          renameGate!.release()
          renameGate = undefined
        },
      }
    },
    failWrite: () => {
      failWrite = true
    },
    failCreate: () => {
      failCreate = true
    },
    failRename: () => {
      failRename = true
    },
  }
}

test('missing preferences use Auto without writes; valid saved preferences survive reopening', async () => {
  const fake = fileSystem(),
    store = new ResourceSettingsStore(profile, fake.io)
  expect(await store.open()).toEqual({
    settings: DEFAULT_RESOURCE_SETTINGS,
    revision: 0,
    status: 'default',
    issue: null,
  })
  expect(fake.calls.map((call) => call.operation)).toEqual(['read'])
  const settings = { version: 1, ramMiB: 4096, vramMiB: null }
  await store.save(settings)
  expect((await store.open()).settings).toEqual(settings)
  const reopened = new ResourceSettingsStore(profile, fake.io)
  expect(await reopened.open()).toEqual({ settings, revision: 0, status: 'loaded', issue: null })
  expect([...fake.files.keys()]).toEqual([settingsPath])
})

for (const text of [
  '{broken',
  '{"version":2,"ramMiB":2048,"vramMiB":null}',
  '{"version":1,"ramMiB":0,"vramMiB":null}',
])
  test(`damaged preferences are preserved and explicitly recover to Auto: ${text}`, async () => {
    const fake = fileSystem()
    fake.files.set(settingsPath, text)
    const store = new ResourceSettingsStore(profile, fake.io)
    expect(await store.open()).toEqual({
      settings: DEFAULT_RESOURCE_SETTINGS,
      revision: 0,
      status: 'recovered',
      issue: 'invalid-settings',
    })
    expect(fake.files.get(settingsPath)).toBe(text)
    expect(fake.calls.map((call) => call.operation)).toEqual(['read'])
    await store.save({ version: 1, ramMiB: null, vramMiB: 3072 })
    expect(store.get().status).toBe('loaded')
    expect(store.get().issue).toBeNull()
  })

test('invalid IPC-style settings reject before any file access or queue mutation', async () => {
  const fake = fileSystem(),
    store = new ResourceSettingsStore(profile, fake.io)
  await expect(store.save({ version: 1, ramMiB: '2048', vramMiB: null })).rejects.toThrow()
  await expect(
    store.save({ version: 1, ramMiB: null, vramMiB: null, path: '/user/file' }),
  ).rejects.toThrow()
  expect(fake.calls).toEqual([])
  expect(store.get().settings).toEqual(DEFAULT_RESOURCE_SETTINGS)
})

test('unreadable preferences are explicit Auto and never trigger an automatic rewrite', async () => {
  const fake = fileSystem()
  fake.io.read = async () => {
    throw Object.assign(new Error('Permission denied.'), { code: 'EACCES' })
  }
  const store = new ResourceSettingsStore(profile, fake.io)
  expect(await store.open()).toEqual({
    settings: DEFAULT_RESOURCE_SETTINGS,
    revision: 0,
    status: 'recovered',
    issue: 'read-unavailable',
  })
  expect(fake.calls).toEqual([])
})

test('failed exclusive create never removes a temporary file this write did not own', async () => {
  const fake = fileSystem(),
    store = new ResourceSettingsStore(profile, fake.io)
  fake.failCreate()
  await expect(store.save({ version: 1, ramMiB: 2048, vramMiB: null })).rejects.toThrow()
  expect(fake.calls.filter((call) => call.operation === 'remove')).toEqual([])
  expect(store.get().settings).toEqual(DEFAULT_RESOURCE_SETTINGS)
})

test('settings remain unchanged until atomic rename succeeds; queued writes preserve order and captured values', async () => {
  const fake = fileSystem(),
    store = new ResourceSettingsStore(profile, fake.io),
    held = fake.holdRename()
  const first = store.save({ version: 1, ramMiB: 2048, vramMiB: null })
  await held.entered
  expect(store.get().settings).toEqual(DEFAULT_RESOURCE_SETTINGS)
  expect(fake.files.has(settingsPath)).toBe(false)
  const later = { version: 1, ramMiB: 8192, vramMiB: 4096 },
    second = store.save(later)
  later.ramMiB = 1
  expect(fake.calls.filter((call) => call.operation === 'write')).toHaveLength(1)
  held.release()
  expect((await first).settings.ramMiB).toBe(2048)
  expect((await second).settings.ramMiB).toBe(8192)
  await store.drain()
  expect(store.get().revision).toBe(2)
  expect(JSON.parse(fake.files.get(settingsPath)!)).toEqual({
    version: 1,
    ramMiB: 8192,
    vramMiB: 4096,
  })
})

for (const failure of ['write', 'rename'] as const)
  test(`failed ${failure} preserves previous disk/memory state, cleans only its temporary, and does not poison the queue`, async () => {
    const fake = fileSystem(),
      store = new ResourceSettingsStore(profile, fake.io)
    const original = { version: 1, ramMiB: 2048, vramMiB: null }
    await store.save(original)
    if (failure === 'write') fake.failWrite()
    else fake.failRename()
    await expect(store.save({ version: 1, ramMiB: 4096, vramMiB: 4096 })).rejects.toThrow(
      'previous settings remain active',
    )
    expect(store.get()).toMatchObject({ settings: original, revision: 1 })
    expect(JSON.parse(fake.files.get(settingsPath)!)).toEqual(original)
    expect([...fake.files.keys()]).toEqual([settingsPath])
    const removals = fake.calls.filter((call) => call.operation === 'remove')
    expect(removals).toHaveLength(1)
    expect(removals[0].path).toMatch(/\/\.resource-settings\.json\.[a-f\d-]+\.tmp$/)
    expect(removals[0].path).not.toBe(settingsPath)
    await store.save({ version: 1, ramMiB: null, vramMiB: null })
    expect(store.get()).toMatchObject({ settings: DEFAULT_RESOURCE_SETTINGS, revision: 2 })
  })
