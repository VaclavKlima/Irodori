import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, win32 } from 'node:path'
import type { ImportDevice } from '../shared/import-devices'

export interface DeviceRoot {
  path: string
  identity: string
  filesystemDevice: string
  filesystemIdentity: string
  nestedMounts: string[]
  /** Format identity, independent of this mount and its reader; absent when uncertain. */
  volumeIdentity?: string
}

export interface DeviceSource {
  deviceId: string
  displayName: string
  roots: DeviceRoot[]
}

export class DeviceUnavailableError extends Error {
  constructor(message = 'The device disconnected or changed. Choose the device again to restart.') {
    super(message)
    this.name = 'DeviceUnavailableError'
  }
}

export type DeviceCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<string>

export interface DeviceRootInspection {
  path: string
  filesystemDevice: string
  filesystemIdentity: string
}

interface ImportDevicesOptions {
  platform?: NodeJS.Platform
  runCommand?: DeviceCommandRunner
  inspectRoot?: (path: string) => Promise<DeviceRootInspection>
  readMounts?: () => Promise<string[]>
}

interface MountedVolume {
  path: string
  identity: string
  name: string
  volumeIdentity?: string
}

interface DiscoveredDevice {
  identity: string
  name: string
  capacityBytes: number | null
  volumes: MountedVolume[]
}

interface Discovery {
  devices: DiscoveredDevice[]
  mounts: string[]
}

interface DeviceEntry {
  summary: ImportDevice
  source: DeviceSource
}

/** Only commands owned by main are executed; no device text is interpreted by a shell. */
const runDeviceCommand: DeviceCommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', windowsHide: true })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    const timeout = setTimeout(() => {
      failure = new Error('Device discovery timed out. Refresh to try again.')
      child.kill('SIGKILL')
    }, 8_000)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) {
        failure = new Error('Device discovery returned too much data.')
        child.kill('SIGKILL')
      } else output.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.length < 8) errors.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new Error(Buffer.concat(errors).toString('utf8').trim() || 'Device discovery failed.'),
        )
      else resolve(Buffer.concat(output).toString('utf8'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })

async function inspectMountedRoot(path: string): Promise<DeviceRootInspection> {
  const canonical = await realpath(path)
  const information = await stat(canonical, { bigint: true })
  if (!information.isDirectory()) throw new Error('The volume is not a directory.')
  await access(canonical, constants.R_OK | constants.X_OK)
  return {
    path: canonical,
    filesystemDevice: information.dev.toString(),
    filesystemIdentity: `${information.dev}:${information.ino}`,
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function stableVolumeIdentity(
  filesystem: string,
  formatId: string,
  partitionId: string,
  size: number | null,
): string | undefined {
  const format = formatId.trim().toLowerCase()
  if (!filesystem.trim() || !format || /^[0\W]+$/.test(format) || !size) return undefined
  const partition = partitionId.trim().toLowerCase()
  return digest(
    JSON.stringify([
      'camera-volume-v1',
      filesystem.trim().toLowerCase(),
      format,
      /^[0\W]+$/.test(partition) ? '' : partition,
      size,
    ]),
  )
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Device discovery returned invalid data.')
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Device discovery returned invalid data.')
  return value
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function capacity(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(string(value))
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function pathApi(path: string) {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') ? win32 : posix
}

export function pathWithin(root: string, path: string): boolean {
  const api = pathApi(root)
  if (!api.isAbsolute(root) || !api.isAbsolute(path)) return false
  const relative = api.relative(root, path)
  return (
    relative === '' ||
    (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative))
  )
}

/** The caller must also reject symlinks and verify the opened file's filesystem identity. */
export function assertDevicePathContained(source: DeviceSource, path: string): void {
  if (
    !source.roots.some(
      (root) =>
        pathWithin(root.path, path) && !root.nestedMounts.some((mount) => pathWithin(mount, path)),
    )
  )
    throw new DeviceUnavailableError('The photo is outside the selected device volume.')
}

function linuxDiscovery(output: string): Discovery {
  const data = record(JSON.parse(output))
  if (!Array.isArray(data.blockdevices)) throw new Error('Device discovery returned invalid data.')
  const disks = array(data.blockdevices).map(record)
  const mounts: string[] = []
  const descendants = (node: Record<string, unknown>): Record<string, unknown>[] => [
    node,
    ...array(node.children).flatMap((child) => descendants(record(child))),
  ]
  const mountPaths = (node: Record<string, unknown>) => {
    const values = node.mountpoints === undefined ? [node.mountpoint] : array(node.mountpoints)
    return values.map(string).filter((path) => isAbsolute(path))
  }
  for (const disk of disks) for (const node of descendants(disk)) mounts.push(...mountPaths(node))
  const devices: DiscoveredDevice[] = []
  for (const disk of disks) {
    if (string(disk.type) !== 'disk') continue
    if (!enabled(disk.rm) && string(disk.tran).toLowerCase() !== 'usb') continue
    const nodes = descendants(disk)
    if (
      nodes.some((node) =>
        mountPaths(node).some((path) =>
          [
            '/',
            '/boot',
            '/boot/efi',
            '/sysroot',
            '/var',
            '/var/home',
            '/home',
            '/etc',
            '/usr',
          ].includes(path),
        ),
      )
    )
      continue
    const physicalIdentity = [
      string(disk.wwn),
      string(disk.serial),
      string(disk.path) || string(disk.name),
      string(disk['maj:min']),
    ].join('|')
    const volumes = nodes.flatMap((node) =>
      mountPaths(node).map((path) => ({
        path,
        name: string(node.label),
        volumeIdentity: stableVolumeIdentity(
          string(node.fstype),
          string(node.uuid),
          string(node.partuuid),
          capacity(node.size),
        ),
        identity: digest(
          [
            physicalIdentity,
            string(node.uuid),
            string(node.partuuid),
            string(node['maj:min']),
            path,
          ].join('|'),
        ),
      })),
    )
    devices.push({
      identity: physicalIdentity,
      name: volumes.find((volume) => volume.name)?.name || string(disk.model) || string(disk.name),
      capacityBytes: capacity(disk.size),
      volumes,
    })
  }
  return { devices, mounts }
}

// Fixed PowerShell code emits storage facts only. Get-Disk includes external fixed USB disks.
const windowsDeviceScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$allMounts = @()
$formattedVolumes = @(Get-CimInstance Win32_Volume)
$items = @(Get-Disk | ForEach-Object {
  $disk = $_
  $partitions = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue)
  $volumes = @($partitions | ForEach-Object {
    $partition = $_
    $volume = $partition | Get-Volume -ErrorAction SilentlyContinue
    if ($null -ne $volume) {
      $paths = @($partition.AccessPaths | Where-Object { $_ -and $_ -notlike '\\\\?\\*' })
      $script:allMounts += $paths
      $formatted = $formattedVolumes | Where-Object { $_.DeviceID -eq $volume.UniqueId } | Select-Object -First 1
      $formatSerial = if ($null -ne $formatted.SerialNumber) { '{0:X8}' -f [uint32]$formatted.SerialNumber } else { '' }
      [pscustomobject]@{ paths = $paths; identity = $volume.UniqueId; serial = $volume.ObjectId; name = $volume.FileSystemLabel; driveType = [string]$volume.DriveType; filesystem = [string]$volume.FileSystem; formatSerial = $formatSerial; partitionId = [string]$partition.Guid; size = $volume.Size }
    }
  })
  [pscustomobject]@{ identity = $disk.UniqueId; serial = $disk.SerialNumber; number = $disk.Number; name = $disk.FriendlyName; size = $disk.Size; busType = [string]$disk.BusType; isSystem = $disk.IsSystem; isBoot = $disk.IsBoot; volumes = $volumes }
})
[pscustomobject]@{ devices = $items; mounts = @($allMounts) } | ConvertTo-Json -Depth 8 -Compress
`

function windowsDiscovery(output: string): Discovery {
  const data = record(JSON.parse(output.replace(/^\uFEFF/, '')))
  if (!Array.isArray(data.devices)) throw new Error('Device discovery returned invalid data.')
  const devices: DiscoveredDevice[] = []
  for (const value of array(data.devices)) {
    const disk = record(value)
    const volumes = array(disk.volumes).map(record)
    const bus = string(disk.busType).toLowerCase()
    if (enabled(disk.isSystem) || enabled(disk.isBoot)) continue
    if (['file backed virtual', 'virtual', 'spaces'].includes(bus)) continue
    if (
      !['usb', 'sd', 'mmc'].includes(bus) &&
      !volumes.some((volume) => string(volume.driveType).toLowerCase() === 'removable')
    )
      continue
    const physicalIdentity = [
      string(disk.identity),
      string(disk.serial),
      String(disk.number ?? ''),
    ].join('|')
    devices.push({
      identity: physicalIdentity,
      name: volumes.map((volume) => string(volume.name)).find(Boolean) || string(disk.name),
      capacityBytes: capacity(disk.size),
      volumes: volumes.flatMap((volume) =>
        array(volume.paths)
          .map(string)
          .filter((path) => win32.isAbsolute(path))
          .map((path) => ({
            path,
            name: string(volume.name),
            volumeIdentity: stableVolumeIdentity(
              string(volume.filesystem),
              string(volume.formatSerial),
              string(volume.partitionId),
              capacity(volume.size),
            ),
            identity: digest(
              [
                physicalIdentity,
                string(volume.identity),
                string(volume.serial),
                path.toLowerCase(),
              ].join('|'),
            ),
          })),
      ),
    })
  }
  return {
    devices,
    mounts: array(data.mounts)
      .map(string)
      .filter((path) => win32.isAbsolute(path)),
  }
}

async function macDiscovery(run: DeviceCommandRunner): Promise<Discovery> {
  const plist = async (args: string[]) => {
    const output = await run('/usr/sbin/diskutil', args)
    return record(
      JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], output)),
    )
  }
  const [physical, all] = await Promise.all([
    plist(['list', '-plist', 'physical']),
    plist(['list', '-plist']),
  ])
  if (!Array.isArray(physical.AllDisksAndPartitions) || !Array.isArray(all.AllDisksAndPartitions))
    throw new Error('Device discovery returned invalid data.')
  const allDisks = array(all.AllDisksAndPartitions).map(record)
  const flatten = (node: Record<string, unknown>): Record<string, unknown>[] => [
    node,
    ...[...array(node.Partitions), ...array(node.APFSVolumes)].flatMap((child) =>
      flatten(record(child)),
    ),
  ]
  const mounts = allDisks
    .flatMap(flatten)
    .map((node) => string(node.MountPoint))
    .filter((path) => isAbsolute(path))
  const devices: DiscoveredDevice[] = []
  for (const value of array(physical.AllDisksAndPartitions)) {
    const disk = record(value)
    const identifier = string(disk.DeviceIdentifier)
    if (!/^disk\d+$/.test(identifier)) continue
    const information = await plist(['info', '-plist', identifier])
    if (
      string(information.VirtualOrPhysical).toLowerCase() === 'virtual' ||
      (!enabled(information.RemovableMedia) && information.Internal !== false)
    )
      continue
    const physicalIdentity = [
      identifier,
      string(information.MediaUUID),
      string(information.DiskUUID),
      string(information.IORegistryEntryName),
      String(information.TotalSize ?? ''),
    ].join('|')
    const nodes = flatten(disk)
    const partitionIds = nodes.map((node) => string(node.DeviceIdentifier))
    for (const synthesized of allDisks) {
      const stores = array(synthesized.APFSPhysicalStores).map(record)
      if (stores.some((store) => partitionIds.includes(string(store.DeviceIdentifier))))
        nodes.push(...flatten(synthesized))
    }
    const volumes: MountedVolume[] = []
    for (const node of nodes) {
      const nodeId = string(node.DeviceIdentifier)
      if (!/^disk\d+(?:s\d+)*$/.test(nodeId)) continue
      const info = nodeId === identifier ? information : await plist(['info', '-plist', nodeId])
      const path = string(info.MountPoint) || string(node.MountPoint)
      if (!isAbsolute(path)) continue
      mounts.push(path)
      volumes.push({
        path,
        name: string(info.VolumeName) || string(node.VolumeName),
        volumeIdentity: stableVolumeIdentity(
          string(info.FileSystemType),
          string(info.VolumeUUID),
          string(info.DiskUUID),
          capacity(info.TotalSize),
        ),
        identity: digest(
          [physicalIdentity, string(info.VolumeUUID), string(info.DiskUUID), nodeId, path].join(
            '|',
          ),
        ),
      })
    }
    if (volumes.some((volume) => volume.path === '/')) continue
    devices.push({
      identity: physicalIdentity,
      name:
        volumes.find((volume) => volume.name)?.name || string(information.MediaName) || identifier,
      capacityBytes: capacity(information.TotalSize) ?? capacity(disk.Size),
      volumes,
    })
  }
  return { devices, mounts }
}

export class ImportDevices {
  private readonly platform: NodeJS.Platform
  private readonly run: DeviceCommandRunner
  private readonly inspect: (path: string) => Promise<DeviceRootInspection>
  private readonly readMounts: () => Promise<string[]>
  private entries = new Map<string, DeviceEntry>()
  private listing: Promise<ImportDevice[]> | null = null
  private listedAt = -Infinity

  constructor(options: ImportDevicesOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.run = options.runCommand ?? runDeviceCommand
    this.inspect = options.inspectRoot ?? inspectMountedRoot
    this.readMounts =
      options.readMounts ??
      (async () => {
        if (this.platform !== 'linux') return []
        // lsblk cannot see nested tmpfs/network/bind mounts; mountinfo supplies those boundaries.
        const output = await readFile('/proc/self/mountinfo', 'utf8')
        return output
          .split('\n')
          .filter(Boolean)
          .map((line) =>
            (line.split(' ')[4] ?? '').replace(/\\([0-7]{3})/g, (_match, octal: string) =>
              String.fromCharCode(parseInt(octal, 8)),
            ),
          )
          .filter((path) => isAbsolute(path))
      })
  }

  list(force = true): Promise<ImportDevice[]> {
    if (this.listing)
      return this.listing.then((devices) => devices.map((device) => ({ ...device })))
    if (!force && performance.now() - this.listedAt < 3000)
      return Promise.resolve([...this.entries.values()].map(({ summary }) => ({ ...summary })))
    this.listedAt = performance.now()
    const listing = this.discover().finally(() => {
      if (this.listing === listing) this.listing = null
    })
    this.listing = listing
    return listing.then((devices) => devices.map((device) => ({ ...device })))
  }

  private async discover(): Promise<ImportDevice[]> {
    let discovery: Discovery
    if (this.platform === 'linux')
      discovery = linuxDiscovery(
        await this.run('lsblk', [
          '--json',
          '--bytes',
          '--paths',
          '--output',
          'NAME,PATH,TYPE,SIZE,RM,TRAN,MODEL,SERIAL,WWN,FSTYPE,UUID,PARTUUID,LABEL,MAJ:MIN,MOUNTPOINTS',
        ]),
      )
    else if (this.platform === 'darwin') discovery = await macDiscovery(this.run)
    else if (this.platform === 'win32')
      discovery = windowsDiscovery(
        await this.run('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          windowsDeviceScript,
        ]),
      )
    else throw new Error('Mounted device discovery is unavailable on this platform.')
    discovery.mounts.push(...(await this.readMounts()))
    const identityMounts = new Map<string, Set<string>>()
    for (const device of discovery.devices)
      for (const volume of device.volumes) {
        if (!volume.volumeIdentity) continue
        const mounts = identityMounts.get(volume.volumeIdentity) ?? new Set<string>()
        mounts.add(volume.identity)
        identityMounts.set(volume.volumeIdentity, mounts)
      }
    const next = new Map<string, DeviceEntry>()
    for (const device of discovery.devices) {
      const id = digest(
        `${this.platform}|${device.identity}|${device.volumes
          .map((volume) => volume.identity)
          .sort()
          .join('|')}`,
      )
      const roots: DeviceRoot[] = []
      for (const volume of device.volumes) {
        try {
          const inspection = await this.inspect(volume.path)
          if (
            roots.some((root) => root.identity === volume.identity || root.path === inspection.path)
          )
            continue
          roots.push({
            ...inspection,
            identity: volume.identity,
            volumeIdentity:
              volume.volumeIdentity && identityMounts.get(volume.volumeIdentity)?.size === 1
                ? volume.volumeIdentity
                : undefined,
            nestedMounts: [
              ...new Set(
                discovery.mounts
                  .filter((mount) => mount !== volume.path && pathWithin(volume.path, mount))
                  .map((mount) =>
                    pathApi(volume.path).resolve(
                      inspection.path,
                      pathApi(volume.path).relative(volume.path, mount),
                    ),
                  ),
              ),
            ],
          })
        } catch {
          // A known device with an unmounted/unreadable volume remains visible and unavailable.
        }
      }
      const summary: ImportDevice = {
        id,
        name: device.name,
        capacityBytes: device.capacityBytes,
        available: roots.length > 0,
        volumeCount: roots.length,
      }
      next.set(id, { summary, source: { deviceId: id, displayName: device.name, roots } })
    }
    this.entries = next
    return [...next.values()]
      .map((entry) => entry.summary)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  async resolve(id: string): Promise<DeviceSource> {
    await this.list()
    const entry = this.entries.get(id)
    if (!entry?.summary.available) throw new DeviceUnavailableError()
    return structuredClone(entry.source)
  }

  async validate(source: DeviceSource, refresh = true, force = true): Promise<void> {
    if (refresh) await this.list(force)
    const current = this.entries.get(source.deviceId)?.source
    if (
      !current ||
      current.roots.length !== source.roots.length ||
      source.roots.some((root) => {
        const fresh = current.roots.find((item) => item.identity === root.identity)
        return (
          !fresh ||
          fresh.path !== root.path ||
          fresh.filesystemIdentity !== root.filesystemIdentity ||
          fresh.filesystemDevice !== root.filesystemDevice ||
          fresh.volumeIdentity !== root.volumeIdentity ||
          fresh.nestedMounts.length !== root.nestedMounts.length ||
          fresh.nestedMounts.some((mount) => !root.nestedMounts.includes(mount))
        )
      })
    )
      throw new DeviceUnavailableError()
  }

  async photoRoots(source: DeviceSource, searchEntireDevice: boolean): Promise<string[]> {
    await this.validate(source, true, true)
    const paths: string[] = []
    for (const root of source.roots) {
      if (searchEntireDevice) {
        paths.push(root.path)
        continue
      }
      let folders
      try {
        folders = (await readdir(root.path, { withFileTypes: true })).filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            !root.nestedMounts.includes(join(root.path, entry.name)),
        )
      } catch {
        throw new DeviceUnavailableError(
          'The device volume is unavailable. Choose the device again to restart.',
        )
      }
      const dcim = folders.filter((entry) => /^dcim$/i.test(entry.name))
      const recognized = dcim.length
        ? dcim
        : folders.filter((entry) => /^(?:photos?|pictures?|images?)$/i.test(entry.name))
      paths.push(
        ...(recognized.length
          ? recognized.map((entry) => join(root.path, entry.name))
          : [root.path]),
      )
    }
    return paths
  }
}
