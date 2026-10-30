import { CameraMutations as CameraRecognition } from '../src/main/catalog/camera-mutations'
import { expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  cameraMetadataMatches,
  cameraSampleWindows,
  cameraSourceKey,
  sampleCameraOriginal,
} from '../src/main/camera-recognition'
import { stableVolumeIdentity } from '../src/main/import-devices'
import { inspectImportSource } from '../src/main/import-source-records'
import { cameraSource } from './camera-import.helpers'

test('format identity changes on reformat, type, partition or size and rejects missing identifiers', () => {
  const first = stableVolumeIdentity('exfat', 'ABCD-1234', 'partition', 128_000)
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(stableVolumeIdentity('ExFAT', 'abcd-1234', 'PARTITION', 128_000)).toBe(first)
  for (const [filesystem, serial, partition, size] of [
    ['fat32', 'ABCD-1234', 'partition', 128_000],
    ['exfat', 'new', 'partition', 128_000],
    ['exfat', 'ABCD-1234', 'new', 128_000],
    ['exfat', 'ABCD-1234', 'partition', 256_000],
  ] as const)
    expect(stableVolumeIdentity(filesystem, serial, partition, size)).not.toBe(first)
  for (const serial of ['', '0000-0000', '{00000000-0000-0000-0000-000000000000}'])
    expect(stableVolumeIdentity('exfat', serial, '', 128_000)).toBeUndefined()
  expect(stableVolumeIdentity('', 'serial', '', 128_000)).toBeUndefined()
  expect(stableVolumeIdentity('exfat', 'serial', '', null)).toBeUndefined()
})

test('camera keys survive readers, mount paths and inodes while preserving containment', async () => {
  const first = await cameraSource(tmpdir())
  const initial = cameraSourceKey(first, join(first.roots[0].path, 'DCIM', 'photo.ARW'))
  const other = structuredClone(first)
  other.deviceId = 'reader-2'
  Object.assign(other.roots[0], {
    path: '/new-card',
    identity: 'new-mount',
    filesystemDevice: '222',
    filesystemIdentity: '222:333',
  })
  expect(cameraSourceKey(other, '/new-card/dcim/PHOTO.arw')).toEqual(initial)
  other.roots[0].nestedMounts = ['/new-card/dcim']
  expect(cameraSourceKey(other, '/new-card/DCIM/photo.ARW')).toBeDefined() // POSIX containment stays case-sensitive.
  expect(cameraSourceKey(other, '/new-card/dcim/photo.ARW')).toBeUndefined()
  expect(cameraSourceKey(other, '/new-card-other/photo.ARW')).toBeUndefined()
  other.roots[0].volumeIdentity = undefined
  expect(cameraSourceKey(other, '/new-card/photo.ARW')).toBeUndefined()
})

test('sample windows cover small files completely and merge overlaps within 256 KiB', async () => {
  for (const size of [0, 1, 65536, 262144, 262145, 300000, 400000, 1024 * 1024, 100_000_000]) {
    const windows = cameraSampleWindows(size)
    expect(windows.reduce((sum, window) => sum + window.length, 0)).toBeLessThanOrEqual(262144)
    expect(windows[0].offset).toBe(0)
    expect(windows.at(-1)!.offset + windows.at(-1)!.length).toBe(size)
    for (let index = 1; index < windows.length; index++)
      expect(windows[index].offset).toBeGreaterThan(
        windows[index - 1].offset + windows[index - 1].length,
      )
  }
  const root = await mkdtemp(join(tmpdir(), 'irodori-sample-'))
  try {
    const path = join(root, 'original.jpg')
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a)
    await writeFile(path, bytes)
    const initial = await sampleCameraOriginal(path, new AbortController().signal)
    expect(initial.bytes).toBe(262144)
    bytes[Math.floor(bytes.length / 3)] ^= 0xff
    await writeFile(path, bytes)
    expect((await sampleCameraOriginal(path, new AbortController().signal)).digest).not.toBe(
      initial.digest,
    )
    const abort = new AbortController()
    abort.abort()
    await expect(sampleCameraOriginal(path, abort.signal)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bindings distinguish full proof from samples and exclude pending removal and derived originals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-binding-'))
  const db = new DatabaseSync(':memory:')
  try {
    const path = join(root, 'file.jpg')
    await writeFile(path, 'original')
    const witness = (await inspectImportSource(path)).witness
    db.exec(
      'CREATE TABLE photos (id TEXT PRIMARY KEY, photo TEXT); CREATE TABLE removals (id TEXT PRIMARY KEY, staged TEXT)',
    )
    const records = new CameraRecognition(db)
    records.initialize()
    const id = 'a'.repeat(64),
      key = { volume: 'card', path: 'file.jpg' }
    db.prepare('INSERT INTO photos VALUES (?, ?)').run(
      id,
      JSON.stringify({ filename: 'file.jpg', bytes: 8 }),
    )
    records.record(key, witness, id, 'sample')
    expect(records.binding(key)?.proof).toBe('sample')
    expect(
      cameraMetadataMatches(records.binding(key)!, {
        ...witness,
        dev: 'new',
        ino: 'new',
        ctimeNs: 'new',
      }),
    ).toBe(true)
    for (const field of ['size', 'mtimeNs', 'birthtimeNs'] as const)
      expect(cameraMetadataMatches(records.binding(key)!, { ...witness, [field]: 'changed' })).toBe(
        false,
      )
    records.record(key, witness, id, 'full')
    expect(records.binding(key)?.proof).toBe('full')
    records.cacheSample(id, 'digest')
    db.prepare('INSERT INTO removals VALUES (?, ?)').run(id, 'removed')
    expect(records.live(id)).toBe(false)
    expect(records.candidates('FILE.JPG', 8)).toEqual([])
    db.prepare('DELETE FROM removals').run()
    db.prepare('DELETE FROM photos').run()
    expect(records.binding(key)).toBeUndefined()
    expect(records.sample(id)).toBeUndefined()
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
