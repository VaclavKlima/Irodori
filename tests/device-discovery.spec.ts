import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertDevicePathContained,
  DeviceUnavailableError,
  ImportDevices,
  pathWithin,
  type DeviceCommandRunner,
  type DeviceRootInspection,
} from '../src/main/import-devices'

const mounted = (path: string, overrides: Record<string, unknown> = {}) => ({
  name: '/dev/sdb1',
  type: 'part',
  uuid: 'CAMERA-1234',
  fstype: 'exfat',
  size: 128_000_000_000,
  label: 'Camera card',
  'maj:min': '8:17',
  mountpoints: [path],
  ...overrides,
})

const disk = (path: string, overrides: Record<string, unknown> = {}) => ({
  name: '/dev/sdb',
  path: '/dev/sdb',
  type: 'disk',
  size: 128_000_000_000,
  rm: true,
  tran: 'usb',
  model: 'Actual card reader',
  serial: 'READER-001',
  'maj:min': '8:16',
  children: [mounted(path)],
  ...overrides,
})

const inspection = async (path: string): Promise<DeviceRootInspection> => ({
  path,
  filesystemDevice: '2065',
  filesystemIdentity: '2065:1',
})

function linuxService(
  devices: () => unknown[],
  options: {
    runCommand?: DeviceCommandRunner
    inspectRoot?: (path: string) => Promise<DeviceRootInspection>
    readMounts?: () => Promise<string[]>
  } = {},
) {
  return new ImportDevices({
    platform: 'linux',
    runCommand: async () => JSON.stringify({ blockdevices: devices() }),
    inspectRoot: inspection,
    readMounts: async () => [],
    ...options,
  })
}

test('Linux discovers removable media and fixed external USB disks with genuine names and capacity', async () => {
  const service = linuxService(() => [
    disk('/media/card'),
    disk('/media/external', {
      name: '/dev/sdc',
      path: '/dev/sdc',
      serial: 'EXTERNAL-002',
      rm: false,
      size: '2000000000000',
      children: [mounted('/media/external', { label: '', uuid: 'EXTERNAL', 'maj:min': '8:33' })],
    }),
    disk('/media/internal', {
      name: '/dev/nvme0n1',
      path: '/dev/nvme0n1',
      rm: false,
      tran: 'nvme',
    }),
    disk('/media/image', { name: '/dev/loop0', type: 'loop' }),
    disk('/sysroot', { serial: 'SYSTEM-USB', children: [mounted('/sysroot')] }),
  ])
  const devices = await service.list()
  expect(devices).toHaveLength(2)
  expect(devices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'Camera card',
        capacityBytes: 128_000_000_000,
        available: true,
        volumeCount: 1,
      }),
      expect.objectContaining({
        name: 'Actual card reader',
        capacityBytes: 2_000_000_000_000,
        available: true,
      }),
    ]),
  )
  expect(devices.every((device) => /^[a-f0-9]{64}$/.test(device.id))).toBe(true)
  expect(JSON.stringify(devices)).not.toContain('/media')
  expect(await service.list()).toEqual(devices)
})

test('empty and unreadable mounted devices remain visible with accurate availability', async () => {
  const service = linuxService(
    () => [
      disk('/media/card', { children: [] }),
      disk('/media/blocked', {
        name: '/dev/sdc',
        path: '/dev/sdc',
        serial: 'BLOCKED',
        children: [mounted('/media/blocked', { label: 'Blocked card' })],
      }),
    ],
    {
      inspectRoot: async () => {
        throw new Error('Permission denied')
      },
    },
  )
  const devices = await service.list()
  expect(devices).toHaveLength(2)
  expect(devices.every((device) => !device.available && device.volumeCount === 0)).toBe(true)
  await expect(service.resolve(devices[0].id)).rejects.toBeInstanceOf(DeviceUnavailableError)
})

test('replacement volumes cannot reuse a selected device ID or source at the same mount path', async () => {
  let uuid = 'ORIGINAL-CARD'
  const service = linuxService(() => [
    disk('/media/card', { children: [mounted('/media/card', { uuid })] }),
  ])
  const first = (await service.list())[0]
  const source = await service.resolve(first.id)
  uuid = 'REPLACEMENT-CARD'
  const replacement = (await service.list())[0]
  expect(replacement.id).not.toBe(first.id)
  await expect(service.resolve(first.id)).rejects.toBeInstanceOf(DeviceUnavailableError)
  await expect(service.validate(source)).rejects.toBeInstanceOf(DeviceUnavailableError)
})

test('validation detects vanished devices, remounted roots and new nested mounts', async () => {
  let connected = true,
    rootIdentity = '2065:1'
  let mounts: string[] = []
  const service = linuxService(() => (connected ? [disk('/media/card')] : []), {
    inspectRoot: async (path) => ({
      ...(await inspection(path)),
      filesystemIdentity: rootIdentity,
    }),
    readMounts: async () => mounts,
  })
  const source = await service.resolve((await service.list())[0].id)
  rootIdentity = '999:1'
  await expect(service.validate(source)).rejects.toBeInstanceOf(DeviceUnavailableError)
  rootIdentity = '2065:1'
  mounts = ['/media/card/nested']
  await expect(service.validate(source)).rejects.toBeInstanceOf(DeviceUnavailableError)
  mounts = []
  connected = false
  await expect(service.validate(source)).rejects.toBeInstanceOf(DeviceUnavailableError)
})

test('Linux stable recognition survives reader and mount changes while reformats and ambiguity disable metadata reuse', async () => {
  let mount = '/media/card',
    reader = 'reader-1',
    uuid = 'ABCD-1234',
    ambiguous = false
  const service = linuxService(() => [
    disk(mount, { serial: reader, children: [mounted(mount, { uuid })] }),
    ...(ambiguous
      ? [
          disk('/media/other', {
            serial: 'other-reader',
            path: '/dev/sdc',
            children: [mounted('/media/other', { uuid })],
          }),
        ]
      : []),
  ])
  const first = await service.resolve((await service.list())[0].id)
  expect(first.roots[0].volumeIdentity).toMatch(/^[a-f0-9]{64}$/)
  mount = '/media/reinserted'
  reader = 'reader-2'
  const next = await service.resolve((await service.list())[0].id)
  expect(next.deviceId).not.toBe(first.deviceId)
  expect(next.roots[0].volumeIdentity).toBe(first.roots[0].volumeIdentity)
  uuid = 'REFORMATTED'
  const formatted = await service.resolve((await service.list())[0].id)
  expect(formatted.roots[0].volumeIdentity).not.toBe(first.roots[0].volumeIdentity)
  ambiguous = true
  for (const summary of await service.list())
    expect((await service.resolve(summary.id)).roots[0].volumeIdentity).toBeUndefined()
  ambiguous = false
  uuid = '0000-0000'
  expect(
    (await service.resolve((await service.list())[0].id)).roots[0].volumeIdentity,
  ).toBeUndefined()
})

test('review discovery is coalesced for three seconds and boundary checks force fresh discovery', async () => {
  let calls = 0
  const service = linuxService(() => [], {
    runCommand: async () => {
      calls++
      return JSON.stringify({ blockdevices: [disk('/media/card')] })
    },
  })
  const source = await service.resolve((await service.list())[0].id)
  const before = calls
  for (let index = 0; index < 20; index++) {
    await service.list(false)
    await service.validate(source, true, false)
  }
  expect(calls).toBe(before)
  await service.validate(source, true, true)
  expect(calls).toBe(before + 1)
})

test('command failures are retryable discovery errors and never confirm disconnection', async () => {
  let fail = false
  const service = linuxService(() => [], {
    runCommand: async () => {
      if (fail) throw new Error('lsblk temporarily failed')
      return JSON.stringify({ blockdevices: [disk('/media/card')] })
    },
  })
  const source = await service.resolve((await service.list())[0].id)
  fail = true
  let failure: unknown
  try {
    await service.validate(source)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect(failure).not.toBeInstanceOf(DeviceUnavailableError)
  fail = false
  await expect(service.validate(source)).resolves.toBeUndefined()
  expect((await service.resolve(source.deviceId)).roots).toEqual(source.roots)
})

test('overlapping device refreshes share one command and callers receive independent snapshots', async () => {
  let release!: (value: string) => void
  let calls = 0
  const gate = new Promise<string>((resolve) => {
    release = resolve
  })
  const service = linuxService(() => [], {
    runCommand: async () => {
      calls++
      return gate
    },
  })
  const first = service.list(),
    second = service.list()
  release(JSON.stringify({ blockdevices: [disk('/media/card')] }))
  const [a, b] = await Promise.all([first, second])
  expect(calls).toBe(1)
  a[0].name = 'Changed by caller'
  expect(b[0].name).toBe('Camera card')
})

test('containment rejects sibling prefixes, traversal and nested mounted filesystems on every platform', async () => {
  const service = linuxService(
    () => [
      disk('/media/card'),
      disk('/media/card/mounted', {
        name: '/dev/sdc',
        path: '/dev/sdc',
        rm: false,
        tran: 'sata',
        children: [mounted('/media/card/mounted')],
      }),
    ],
    { readMounts: async () => ['/media/card/network folder'] },
  )
  const source = await service.resolve((await service.list())[0].id)
  expect(source.roots[0].nestedMounts).toEqual([
    '/media/card/mounted',
    '/media/card/network folder',
  ])
  expect(() =>
    assertDevicePathContained(source, '/media/card/DCIM/100SONY/image.ARW'),
  ).not.toThrow()
  for (const path of [
    '/media/card-other/file.jpg',
    '/media/card/../file.jpg',
    '/media/card/mounted/file.jpg',
    '/media/card/network folder/file.jpg',
  ])
    expect(() => assertDevicePathContained(source, path)).toThrow(DeviceUnavailableError)
  expect(pathWithin('E:\\', 'e:\\DCIM\\100SONY\\image.ARW')).toBe(true)
  expect(pathWithin('E:\\photos', 'E:\\photos-old\\image.ARW')).toBe(false)
  expect(pathWithin('E:\\photos', 'E:\\photos\\..\\private\\image.ARW')).toBe(false)
  expect(pathWithin('/media/card', 'relative.jpg')).toBe(false)
})

test('photo roots prefer case-insensitive DCIM, preserve empty folders, then recognize general photo folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-device-roots-'))
  try {
    await mkdir(join(root, 'dcIm', '100SONY'), { recursive: true })
    await mkdir(join(root, 'Photos'))
    const service = linuxService(() => [disk(root)])
    const source = await service.resolve((await service.list())[0].id)
    expect(await service.photoRoots(source, false)).toEqual([join(root, 'dcIm')])
    expect(await service.photoRoots(source, true)).toEqual([root])
    await rm(join(root, 'dcIm'), { recursive: true })
    await mkdir(join(root, 'Images'))
    expect((await service.photoRoots(source, false)).sort()).toEqual([
      join(root, 'Images'),
      join(root, 'Photos'),
    ])
    await rm(join(root, 'Images'), { recursive: true })
    await rm(join(root, 'Photos'), { recursive: true })
    expect(await service.photoRoots(source, false)).toEqual([root])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('photo roots exclude symlinks and mounted DCIM folders and choose separately for each volume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-device-volume-'))
  try {
    const first = join(root, 'first'),
      second = join(root, 'second'),
      outside = join(root, 'outside')
    await Promise.all([mkdir(first), mkdir(second), mkdir(outside)])
    await symlink(outside, join(first, 'DCIM'))
    await mkdir(join(first, 'Pictures'))
    await mkdir(join(second, 'DCIM'))
    const service = linuxService(
      () => [
        disk(first, {
          children: [mounted(first), mounted(second, { uuid: 'SECOND', 'maj:min': '8:18' })],
        }),
      ],
      { readMounts: async () => [join(second, 'DCIM')] },
    )
    const source = await service.resolve((await service.list())[0].id)
    expect(await service.photoRoots(source, false)).toEqual([join(first, 'Pictures'), second])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows accepts USB fixed drives, SD and removable media while excluding virtual and system disks', async () => {
  const volume = {
    paths: ['E:\\'],
    identity: 'VOLUME-USB',
    serial: 'VOL1',
    name: 'External photos',
    driveType: 'Fixed',
    filesystem: 'exfat',
    formatSerial: 'ABCD1234',
    partitionId: 'partition-guid',
    size: 128_000_000_000,
  }
  const base = {
    identity: 'DISK-USB',
    serial: 'PHYSICAL1',
    number: 1,
    name: 'Real external drive',
    size: 2_000_000_000_000,
    busType: 'USB',
    isSystem: false,
    isBoot: false,
    volumes: [volume],
  }
  const commands: { command: string; args: string[] }[] = []
  const service = new ImportDevices({
    platform: 'win32',
    inspectRoot: inspection,
    runCommand: async (command, args) => {
      commands.push({ command, args })
      return JSON.stringify({
        devices: [
          base,
          {
            ...base,
            identity: 'SD',
            number: 2,
            busType: 'SD',
            volumes: [
              {
                ...volume,
                identity: 'SD-VOL',
                formatSerial: 'ABCD2345',
                paths: ['F:\\'],
                name: 'SD card',
                driveType: 'Removable',
              },
            ],
          },
          {
            ...base,
            identity: 'REMOVABLE',
            number: 3,
            busType: 'SCSI',
            volumes: [
              {
                ...volume,
                identity: 'REM-VOL',
                formatSerial: 'ABCD3456',
                paths: ['G:\\'],
                name: 'Camera',
                driveType: 'Removable',
              },
            ],
          },
          { ...base, identity: 'VIRTUAL', number: 4, busType: 'File Backed Virtual' },
          { ...base, identity: 'SYSTEM', number: 0, isSystem: true },
          { ...base, identity: 'INTERNAL', number: 5, busType: 'NVMe' },
        ],
        mounts: ['E:\\', 'F:\\', 'G:\\', 'E:\\mounted\\'],
      })
    },
  })
  const devices = await service.list()
  expect(devices.map((device) => device.name)).toEqual(['Camera', 'External photos', 'SD card'])
  expect(commands[0].command).toBe('powershell.exe')
  expect(commands[0].args.slice(0, 4)).toEqual([
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
  ])
  expect(commands[0].args[4]).toContain('Get-Disk')
  const source = await service.resolve(
    devices.find((device) => device.name === 'External photos')!.id,
  )
  expect(source.roots[0].nestedMounts).toEqual(['E:\\mounted'])
  expect(source.roots[0].volumeIdentity).toMatch(/^[a-f0-9]{64}$/)
  expect(commands[0].args[4]).toContain('Win32_Volume')
})

test('macOS includes mounted external physical and APFS volumes without internal disks or disk images', async () => {
  const external = {
    DeviceIdentifier: 'disk2',
    Size: 128_000_000_000,
    Partitions: [{ DeviceIdentifier: 'disk2s1' }],
  }
  const apfs = {
    DeviceIdentifier: 'disk3',
    Size: 2_000_000_000_000,
    Partitions: [{ DeviceIdentifier: 'disk3s2' }],
  }
  const internal = { DeviceIdentifier: 'disk0' },
    image = { DeviceIdentifier: 'disk4' }
  const all = {
    AllDisksAndPartitions: [
      external,
      apfs,
      internal,
      image,
      {
        DeviceIdentifier: 'disk5',
        APFSPhysicalStores: [{ DeviceIdentifier: 'disk3s2' }],
        APFSVolumes: [{ DeviceIdentifier: 'disk5s1', MountPoint: '/Volumes/External' }],
      },
    ],
  }
  const information: Record<string, unknown> = {
    disk0: { Internal: true, VirtualOrPhysical: 'Physical' },
    disk2: {
      Internal: false,
      VirtualOrPhysical: 'Physical',
      MediaName: 'SD reader',
      MediaUUID: 'CARD-MEDIA',
      TotalSize: 128_000_000_000,
    },
    disk2s1: {
      MountPoint: '/Volumes/Card',
      VolumeUUID: 'CARD-VOLUME',
      VolumeName: 'Camera card',
      FileSystemType: 'exfat',
      TotalSize: 128_000_000_000,
    },
    disk3: {
      Internal: false,
      VirtualOrPhysical: 'Physical',
      MediaName: 'External disk',
      MediaUUID: 'DISK-MEDIA',
      TotalSize: 2_000_000_000_000,
    },
    disk3s2: {},
    disk5: {},
    disk5s1: {
      MountPoint: '/Volumes/External',
      VolumeUUID: 'APFS-VOLUME',
      VolumeName: 'External photos',
    },
    disk4: { Internal: false, VirtualOrPhysical: 'Virtual', MediaName: 'Disk image' },
  }
  const service = new ImportDevices({
    platform: 'darwin',
    inspectRoot: inspection,
    runCommand: async (command, args, input) => {
      if (command === '/usr/bin/plutil') {
        expect(args).toEqual(['-convert', 'json', '-o', '-', '-'])
        return input!
      }
      expect(command).toBe('/usr/sbin/diskutil')
      if (args[0] === 'list')
        return JSON.stringify(
          args.includes('physical')
            ? { AllDisksAndPartitions: [external, apfs, internal, image] }
            : all,
        )
      return JSON.stringify(information[args[2]])
    },
  })
  const devices = await service.list()
  expect(devices.map((device) => device.name)).toEqual(['Camera card', 'External photos'])
  expect(devices.map((device) => device.capacityBytes)).toEqual([
    128_000_000_000, 2_000_000_000_000,
  ])
  expect((await service.resolve(devices[1].id)).roots[0].path).toBe('/Volumes/External')
  expect((await service.resolve(devices[0].id)).roots[0].volumeIdentity).toMatch(/^[a-f0-9]{64}$/)
})

test('malformed adapter output fails discovery instead of clearing known devices', async () => {
  let output = JSON.stringify({ blockdevices: [disk('/media/card')] })
  const service = linuxService(() => [], { runCommand: async () => output })
  const source = await service.resolve((await service.list())[0].id)
  output = '{}'
  await expect(service.list()).rejects.toThrow('invalid data')
  output = JSON.stringify({ blockdevices: [disk('/media/card')] })
  await expect(service.validate(source)).resolves.toBeUndefined()
})

test('fresh completed listings can validate a review without starting a second discovery command', async () => {
  let calls = 0,
    connected = true
  const service = linuxService(() => [], {
    runCommand: async () => {
      calls++
      return JSON.stringify({ blockdevices: connected ? [disk('/media/card')] : [] })
    },
  })
  const source = await service.resolve((await service.list())[0].id)
  const before = calls
  await service.validate(source, false)
  expect(calls).toBe(before)
  connected = false
  await service.list()
  await expect(service.validate(source, false)).rejects.toBeInstanceOf(DeviceUnavailableError)
  expect(calls).toBe(before + 1)
})

test('mount boundaries stay valid when the OS mount path resolves to a canonical directory alias', async () => {
  const service = linuxService(() => [disk('/media/card')], {
    inspectRoot: async () => ({ ...(await inspection('/actual/card')) }),
    readMounts: async () => ['/media/card/nested', '/media/card/network folder'],
  })
  const source = await service.resolve((await service.list())[0].id)
  expect(source.roots[0].path).toBe('/actual/card')
  expect(source.roots[0].nestedMounts).toEqual([
    '/actual/card/nested',
    '/actual/card/network folder',
  ])
  expect(() => assertDevicePathContained(source, '/actual/card/DCIM/photo.jpg')).not.toThrow()
  expect(() => assertDevicePathContained(source, '/actual/card/nested/photo.jpg')).toThrow(
    DeviceUnavailableError,
  )
})
