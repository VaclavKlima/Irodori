import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import {
  DEFAULT_RESOURCE_SETTINGS,
  validateResourceSettings,
  type ResourceMemoryObservation,
  type ResourceSettings,
  type UnknownGpuCapacityReason,
} from '../shared/resource-policy'

const SETTINGS_FILE = 'resource-settings.json'
const SETTINGS_LIMIT = 4096
const CARD_LIMIT = 32
const PCI_ADDRESS = /^[a-f\d]{4}:[a-f\d]{2}:[a-f\d]{2}\.[a-f\d]$/i
const PCI_ID = /^(?:0x)?([a-f\d]{4})$/i

async function readBounded(path: string, maximumBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error('Expected a regular settings/counter file.')
    const data = Buffer.alloc(maximumBytes + 1)
    let length = 0
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maximumBytes) throw new Error('Resource observation exceeded its text limit.')
    return data.subarray(0, length).toString('utf8')
  } finally {
    await file.close()
  }
}

function unsignedBytes(text: string, multiplier = 1n) {
  if (!/^\d+$/.test(text)) throw new Error('Invalid unsigned resource counter.')
  const value = BigInt(text) * multiplier
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Resource counter is not exact.')
  return Number(value)
}

function pciId(value: string) {
  const match = PCI_ID.exec(value)
  return match && match[1] !== '0000' ? `0x${match[1].toLowerCase()}` : null
}

export interface ResourceHardwareIO {
  platform: string
  totalMemory: () => number
  now: () => string
  readText: (path: string, maximumBytes: number) => Promise<string>
  readDirectory: (path: string) => Promise<string[]>
  realpath: (path: string) => Promise<string>
}

const hardwareIO: ResourceHardwareIO = {
  platform: process.platform,
  totalMemory: totalmem,
  now: () => new Date().toISOString(),
  readText: readBounded,
  readDirectory: readdir,
  realpath,
}

export interface ResourceHardwareIssue {
  scope: 'ram-available' | 'gpu-inventory' | 'gpu-identity' | 'gpu-total' | 'gpu-used'
  reason: 'unavailable' | 'malformed' | 'limit-exceeded'
  adapterId?: string
}

export interface ResourceGpuObservation {
  adapterId: string
  vendorId: string | null
  deviceId: string | null
  /** Driver-reported VRAM, not a physical residency or allocation guarantee. */
  totalBytes: number | null
  usedBytes: number | null
}

export interface ResourceHardwareSnapshot {
  observedAt: string
  platform: string
  ram: { totalBytes: number; availableBytes: number | null }
  gpus: ResourceGpuObservation[]
  inventoryComplete: boolean
  issues: ResourceHardwareIssue[]
}

/** Fixed read-only OS paths only; call at photo/job boundaries, never during input. */
export async function observeResourceHardware(io: ResourceHardwareIO = hardwareIO) {
  const totalBytes = io.totalMemory()
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
    throw new Error('The operating system did not provide a valid total RAM capacity.')
  const result: ResourceHardwareSnapshot = {
    observedAt: io.now(),
    platform: io.platform,
    ram: { totalBytes, availableBytes: null },
    gpus: [],
    inventoryComplete: false,
    issues: [],
  }
  if (io.platform !== 'linux') {
    result.issues.push(
      { scope: 'ram-available', reason: 'unavailable' },
      { scope: 'gpu-inventory', reason: 'unavailable' },
    )
    return result
  }
  try {
    const text = await io.readText('/proc/meminfo', 65536),
      fields = text.split('\n').filter((line) => line.startsWith('MemAvailable:'))
    if (fields.length !== 1) throw new Error('Missing or duplicated MemAvailable.')
    const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/.exec(fields[0])
    if (!match) throw new Error('Invalid MemAvailable units.')
    const available = unsignedBytes(match[1], 1024n)
    if (available > totalBytes) throw new Error('Available RAM exceeds reported total.')
    result.ram.availableBytes = available
  } catch (error) {
    result.issues.push({
      scope: 'ram-available',
      reason: (error as NodeJS.ErrnoException)?.code ? 'unavailable' : 'malformed',
    })
  }
  const devices = new Set<string>()
  try {
    const cards = (await io.readDirectory('/sys/class/drm'))
      .filter((name) => /^card(?:0|[1-9]\d*)$/.test(name))
      .sort()
    if (cards.length > CARD_LIMIT) {
      result.issues.push({ scope: 'gpu-inventory', reason: 'limit-exceeded' })
    }
    result.inventoryComplete = cards.length > 0 && cards.length <= CARD_LIMIT
    for (const card of cards.slice(0, CARD_LIMIT)) {
      try {
        const address = basename(await io.realpath(`/sys/class/drm/${card}/device`))
        if (!PCI_ADDRESS.test(address)) throw new Error('DRM card is not a verified PCI device.')
        devices.add(address.toLowerCase())
      } catch {
        result.inventoryComplete = false
        result.issues.push({ scope: 'gpu-identity', reason: 'unavailable' })
      }
    }
    if (!cards.length) result.issues.push({ scope: 'gpu-inventory', reason: 'unavailable' })
  } catch {
    result.issues.push({ scope: 'gpu-inventory', reason: 'unavailable' })
  }
  for (const adapterId of [...devices].sort()) {
    const base = `/sys/bus/pci/devices/${adapterId}`,
      gpu: ResourceGpuObservation = {
        adapterId,
        vendorId: null,
        deviceId: null,
        totalBytes: null,
        usedBytes: null,
      }
    for (const field of ['vendorId', 'deviceId'] as const) {
      try {
        const value = pciId(
          (await io.readText(`${base}/${field === 'vendorId' ? 'vendor' : 'device'}`, 128)).trim(),
        )
        if (!value) throw new Error('Invalid PCI identity.')
        gpu[field] = value
      } catch {
        result.inventoryComplete = false
        result.issues.push({ scope: 'gpu-identity', reason: 'unavailable', adapterId })
      }
    }
    for (const field of ['totalBytes', 'usedBytes'] as const) {
      const scope = field === 'totalBytes' ? 'gpu-total' : 'gpu-used'
      try {
        const value = unsignedBytes(
          (
            await io.readText(
              `${base}/mem_info_vram_${field === 'totalBytes' ? 'total' : 'used'}`,
              128,
            )
          ).trim(),
        )
        if (field === 'totalBytes' && !value) throw new Error('VRAM capacity is unavailable.')
        gpu[field] = value
      } catch (error) {
        result.issues.push({
          scope,
          reason: (error as NodeJS.ErrnoException)?.code ? 'unavailable' : 'malformed',
          adapterId,
        })
      }
    }
    if (gpu.totalBytes !== null && gpu.usedBytes !== null && gpu.usedBytes > gpu.totalBytes) {
      gpu.usedBytes = null
      result.issues.push({ scope: 'gpu-used', reason: 'malformed', adapterId })
    }
    result.gpus.push(gpu)
  }
  return result
}

export interface WebGpuAdapterIdentity {
  vendor: string
  architecture: string
  device: string
  description: string
}

/** Advisory adapter strings must prove a unique PCI pair; architecture/name never select capacity. */
export function matchResourceAdapter(
  hardware: ResourceHardwareSnapshot,
  identity: WebGpuAdapterIdentity | null,
): ResourceMemoryObservation {
  const unknown = (reason: UnknownGpuCapacityReason): ResourceMemoryObservation => ({
    ram: { ...hardware.ram },
    gpu: { status: 'unknown', reason },
  })
  if (
    !identity ||
    [identity.vendor, identity.architecture, identity.device, identity.description].some(
      (value) => typeof value !== 'string' || value.length > 256,
    )
  )
    return unknown('adapter-unverified')
  const vendors: Record<string, string> = { amd: '0x1002', intel: '0x8086', nvidia: '0x10de' },
    vendor = pciId(identity.vendor.trim()) ?? vendors[identity.vendor.trim().toLowerCase()],
    device = pciId(identity.device.trim())
  if (!vendor || !device) return unknown('adapter-unverified')
  if (!hardware.inventoryComplete) return unknown('unavailable')
  const matches = hardware.gpus.filter((gpu) => gpu.vendorId === vendor && gpu.deviceId === device)
  if (!matches.length) return unknown('adapter-mismatch')
  if (matches.length !== 1) return unknown('ambiguous-adapter')
  const gpu = matches[0]
  if (gpu.totalBytes === null) return unknown('unavailable')
  return {
    ram: { ...hardware.ram },
    gpu: {
      status: 'matched',
      adapterId: gpu.adapterId,
      totalBytes: gpu.totalBytes,
      availableBytes: gpu.usedBytes === null ? null : gpu.totalBytes - gpu.usedBytes,
    },
  }
}

export interface ResourceSettingsFiles {
  read: (path: string, maximumBytes: number) => Promise<string>
  prepareDirectory: (path: string) => Promise<void>
  /** Own/clean a partially written new file; an exclusive-create failure owns nothing. */
  writeExclusive: (path: string, contents: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
}

const settingsFiles: ResourceSettingsFiles = {
  read: readBounded,
  prepareDirectory: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 })
  },
  writeExclusive: async (path, contents) => {
    const file = await open(path, 'wx', 0o600)
    try {
      try {
        await file.writeFile(contents, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
    } catch (error) {
      await unlink(path).catch(() => undefined)
      throw error
    }
  },
  rename,
  remove: unlink,
}

export interface ResourceSettingsState {
  settings: Readonly<ResourceSettings>
  revision: number
  status: 'default' | 'loaded' | 'recovered'
  issue: 'invalid-settings' | 'read-unavailable' | null
}

/** The constructor receives trusted app.getPath('userData'), never a renderer-selected path. */
export class ResourceSettingsStore {
  private current: ResourceSettingsState = {
    settings: DEFAULT_RESOURCE_SETTINGS,
    revision: 0,
    status: 'default',
    issue: null,
  }
  private opening?: Promise<void>
  private tail: Promise<void> = Promise.resolve()
  private readonly path: string

  constructor(
    private readonly userData: string,
    private readonly files = settingsFiles,
  ) {
    if (!isAbsolute(userData))
      throw new Error('Resource settings require a trusted absolute profile path.')
    this.path = join(userData, SETTINGS_FILE)
  }

  get(): ResourceSettingsState {
    return Object.freeze({ ...this.current, settings: Object.freeze({ ...this.current.settings }) })
  }

  open() {
    this.opening ??= (async () => {
      try {
        const text = await this.files.read(this.path, SETTINGS_LIMIT)
        try {
          this.current = {
            settings: validateResourceSettings(JSON.parse(text)),
            revision: 0,
            status: 'loaded',
            issue: null,
          }
        } catch {
          this.current = { ...this.current, status: 'recovered', issue: 'invalid-settings' }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT')
          this.current = { ...this.current, status: 'recovered', issue: 'read-unavailable' }
      }
      // Damaged/unreadable files are preserved. An explicit valid save is the only repair.
    })()
    return this.opening.then(() => this.get())
  }

  save(value: unknown): Promise<ResourceSettingsState> {
    // Capture validated values before enqueueing; caller mutation cannot change a queued write.
    let settings: Readonly<ResourceSettings>
    try {
      settings = validateResourceSettings(value)
    } catch (error) {
      return Promise.reject(error)
    }
    const work = this.tail.then(async () => {
      await this.open()
      const temporary = join(this.userData, `.${SETTINGS_FILE}.${randomUUID()}.tmp`)
      let written = false
      try {
        await this.files.prepareDirectory(this.userData)
        await this.files.writeExclusive(temporary, `${JSON.stringify(settings)}\n`)
        written = true
        await this.files.rename(temporary, this.path)
      } catch (cause) {
        if (written) await this.files.remove(temporary).catch(() => undefined)
        throw new Error('Resource settings could not be saved; previous settings remain active.', {
          cause,
        })
      }
      this.current = {
        settings,
        revision: this.current.revision + 1,
        status: 'loaded',
        issue: null,
      }
      return this.get()
    })
    this.tail = work.then(
      () => undefined,
      () => undefined,
    )
    return work
  }

  async drain() {
    await this.tail
  }
}
