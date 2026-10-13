import { expect } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PhotoLibrary } from '../src/main/library'
import { copyOriginal } from '../src/main/copy-original'
import { stableVolumeIdentity, type DeviceSource } from '../src/main/import-devices'
import { hashImportSource, inspectImportSource } from '../src/main/import-source-records'
import { sampleCameraOriginal } from '../src/main/camera-recognition'
import type { ImportVerificationMode } from '../src/shared/contracts'

export function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

export async function cameraSource(path: string, stable = true): Promise<DeviceSource> {
  path = await realpath(path)
  const info = await stat(path, { bigint: true })
  return {
    deviceId: 'reader-1',
    displayName: 'Isolated camera',
    roots: [
      {
        path,
        identity: 'mount-1',
        filesystemDevice: info.dev.toString(),
        filesystemIdentity: `${info.dev}:${info.ino}`,
        volumeIdentity: stable
          ? stableVolumeIdentity('exfat', 'ABCD-1234', '', 128_000_000_000)
          : undefined,
        nestedMounts: [],
      },
    ],
  }
}

export async function cameraSetup(
  options: {
    hash?: typeof hashImportSource
    sample?: typeof sampleCameraOriginal
    trash?: (path: string) => Promise<void>
    inspect?: typeof inspectImportSource
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'luma-camera-')))
  const card = join(root, 'card')
  await mkdir(card)
  await mkdir(join(root, 'trash'))
  const reads = {
    cardSampleBytes: 0,
    managedSampleBytes: 0,
    hashes: 0,
    copies: [] as string[],
    thumbnails: [] as string[],
  }
  const construct = () =>
    new PhotoLibrary(
      join(root, 'library'),
      {
        process: async (_path, output) => {
          await writeFile(join(output, 'thumb.jpg'), 'managed thumbnail')
          await writeFile(join(output, 'preview.jpg'), 'managed preview')
          return { metadata: { width: 16, height: 12 }, source: 'image' }
        },
        close: async () => {},
      },
      () => {},
      async (...args) => {
        reads.copies.push(args[0])
        return copyOriginal(...args)
      },
      options.trash ??
        (async (path) => {
          await rename(path, join(root, 'trash', basename(path)))
        }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        request: (inputs) => {
          reads.thumbnails.push(...inputs.map((input) => input.path))
        },
        cancel: async () => {},
      }),
      undefined,
      undefined,
      options.inspect,
      async (...args) => {
        reads.hashes++
        return (options.hash ?? hashImportSource)(...args)
      },
      async (...args) => {
        const result = await (options.sample ?? sampleCameraOriginal)(...args)
        if (args[0].startsWith(join(root, 'library'))) reads.managedSampleBytes += result.bytes
        else reads.cardSampleBytes += result.bytes
        return result
      },
    )
  let library = construct()
  await library.open()
  return {
    root,
    card,
    reads,
    get library() {
      return library
    },
    restart: async () => {
      await library.close()
      library = construct()
      await library.open()
    },
    close: async () => {
      await library.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function cameraReview(
  library: PhotoLibrary,
  paths: string[],
  source?: DeviceSource,
  mode: ImportVerificationMode = 'camera-fast',
  validate: (force?: boolean) => Promise<void> = async () => {},
) {
  const id = await library.scan(paths, true, source ? { source, validate } : undefined, true, mode)
  await expect.poll(() => library.review(id).phase).toBe('review')
  await expect.poll(() => library.review(id).verificationPending).toBe(false)
  return id
}

export async function cameraCommit(library: PhotoLibrary, id: string) {
  await library.importSelected(id)
  await expect
    .poll(() => library.listTasks().find((task) => task.id === id)?.status)
    .toMatch(/^(completed|failed|cancelled)$/)
  return library.listTasks().find((task) => task.id === id)!
}
