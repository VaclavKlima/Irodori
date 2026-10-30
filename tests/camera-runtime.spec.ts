import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  packRuntimeArchive,
  sha256,
  unpackRuntimeArchive,
  type ArchiveFile,
} from '../scripts/camera/archive'
import {
  assertRuntimeBinary,
  installRuntime,
  installationPath,
  resolveRuntime,
  runtimePlatform,
  verifyRuntime,
  type RuntimeDistribution,
  type RuntimeManifest,
} from '../scripts/camera/runtime'
import {
  acceptanceAlternate,
  acceptanceOptions,
  acceptanceSettings,
  selectAcceptanceCamera,
} from '../scripts/camera/acceptance-options'
import { createCameraProvider } from '../scripts/camera/provider'
import { GphotoProvider } from '../src/main/camera-control/gphoto'

function candidate(version = '1.0.0') {
  const platform = runtimePlatform()
  const binary = Buffer.alloc(64)
  if (platform === 'darwin-arm64') {
    binary.writeUInt32LE(0xfeedfacf, 0)
    binary.writeUInt32LE(0x0100000c, 4)
  } else {
    binary.write('7f454c46', 0, 'hex')
    binary[4] = 2
    binary[5] = 1
    binary.writeUInt16LE(62, 18)
  }
  const executable = platform === 'darwin-arm64' ? 'bin/image-capture' : 'bin/gphoto2'
  const files: ArchiveFile[] = [
    { path: executable, mode: 0o755, bytes: binary },
    { path: 'NOTICE.txt', mode: 0o644, bytes: Buffer.from(`runtime ${version}`) },
  ]
  const modules =
    platform === 'linux-x64'
      ? { cameras: 'lib/libgphoto2/2.5.34', ports: 'lib/libgphoto2_port/0.12.2' }
      : undefined
  if (modules)
    for (const directory of Object.values(modules))
      files.push({ path: `${directory}/module.so`, mode: 0o755, bytes: binary })
  const archive = packRuntimeArchive(files)
  const distribution: RuntimeDistribution = {
    version,
    platform,
    url: 'https://github.com/VaclavKlima/Irodori/releases/download/camera-runtime-v1.0.0/test.tar.gz',
    archive: 'test.tar.gz',
    bytes: archive.length,
    sha256: sha256(archive),
    executable,
    modules,
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      bytes: file.bytes.length,
      sha256: sha256(file.bytes),
    })),
  }
  const manifest = {
    schema: 1,
    release: `camera-runtime-v${version}`,
    platforms: { [platform]: distribution },
  } as RuntimeManifest
  return { platform, archive, distribution, manifest, files }
}

async function temporary() {
  return mkdtemp(join(tmpdir(), 'irodori runtime test '))
}

test('setup verifies every file, publishes atomically, reuses offline and preserves capture artifacts', async () => {
  const root = await temporary(),
    c = candidate()
  try {
    await mkdir(join(root, 'artifacts/camera/sessions'), { recursive: true })
    await writeFile(join(root, 'artifacts/camera/sessions/retained.json'), 'private journal')
    let downloads = 0
    const options = {
      root,
      manifest: c.manifest,
      download: async () => {
        downloads++
        return c.archive
      },
    }
    const installed = await installRuntime(options)
    expect(installed).toEqual({ directory: installationPath(root, c.distribution), reused: false })
    await verifyRuntime(installed.directory, c.distribution)
    expect((await lstat(join(installed.directory, c.distribution.executable))).mode & 0o777).toBe(
      0o755,
    )
    expect(
      await installRuntime({
        ...options,
        download: async () => {
          throw new Error('must be offline')
        },
      }),
    ).toMatchObject({ reused: true })
    expect(downloads).toBe(1)
    expect(await readdir(resolve(installed.directory, '..'))).toEqual([
      installed.directory.split('/').at(-1),
    ])
    expect(await readFile(join(root, 'artifacts/camera/sessions/retained.json'), 'utf8')).toBe(
      'private journal',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit archives use the same pinned checksums even when a valid runtime is already installed', async () => {
  const root = await temporary(),
    c = candidate()
  try {
    const path = join(root, 'candidate.tar.gz')
    await writeFile(path, c.archive)
    await installRuntime({ root, manifest: c.manifest, archive: path })
    await writeFile(path, Buffer.from('tampered'))
    await expect(installRuntime({ root, manifest: c.manifest, archive: path })).rejects.toThrow(
      'checksum/size mismatch',
    )
    await verifyRuntime(installationPath(root, c.distribution), c.distribution)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed downloads, mismatched file hashes and interrupted staging preserve a working prior runtime', async () => {
  const root = await temporary(),
    old = candidate(),
    next = candidate('1.0.1')
  try {
    await installRuntime({ root, manifest: old.manifest, download: async () => old.archive })
    for (const download of [
      async () => {
        throw new Error('interrupted download')
      },
      async () => Buffer.from('truncated'),
    ])
      await expect(installRuntime({ root, manifest: next.manifest, download })).rejects.toThrow()
    const corrupt = structuredClone(next.manifest)
    corrupt.platforms[next.platform].files[0].sha256 = '0'.repeat(64)
    await expect(
      installRuntime({ root, manifest: corrupt, download: async () => next.archive }),
    ).rejects.toThrow('file integrity')
    await expect(
      installRuntime({
        root,
        manifest: next.manifest,
        download: async () => next.archive,
        beforePublish: async () => {
          throw new Error('interrupted staging')
        },
      }),
    ).rejects.toThrow('interrupted staging')
    await verifyRuntime(installationPath(root, old.distribution), old.distribution)
    expect(
      (await readdir(join(root, 'artifacts/camera/runtime', old.platform))).some((name) =>
        name.startsWith('.install-'),
      ),
    ).toBe(false)
    const local = join(root, 'next.tar.gz')
    await writeFile(local, next.archive)
    const script = `import { installRuntime } from ${JSON.stringify(new URL('../scripts/camera/runtime.ts', import.meta.url).href)};
await installRuntime({root:${JSON.stringify(root)},manifest:${JSON.stringify(next.manifest)},archive:${JSON.stringify(local)},beforePublish:async()=>process.exit(99)});`
    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' }),
    ).toThrow()
    await verifyRuntime(installationPath(root, old.distribution), old.distribution)
    await installRuntime({ root, manifest: next.manifest, archive: local })
    await verifyRuntime(installationPath(root, next.distribution), next.distribution)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime validation rejects corruption, unexpected files, modes and symlinks, then setup repairs', async () => {
  const root = await temporary(),
    c = candidate()
  const options = { root, manifest: c.manifest, download: async () => c.archive }
  try {
    const { directory } = await installRuntime(options)
    const path = join(directory, c.distribution.executable)
    await writeFile(path, Buffer.alloc(64))
    await expect(verifyRuntime(directory, c.distribution)).rejects.toThrow('integrity')
    await installRuntime(options)
    await chmod(path, 0o644)
    await expect(verifyRuntime(directory, c.distribution)).rejects.toThrow('size/mode')
    await installRuntime(options)
    await writeFile(join(directory, 'extra'), 'untrusted')
    await expect(verifyRuntime(directory, c.distribution)).rejects.toThrow('unexpected')
    await installRuntime(options)
    await rm(path)
    await symlink(join(directory, 'NOTICE.txt'), path)
    await expect(verifyRuntime(directory, c.distribution)).rejects.toThrow('links/special')
    await installRuntime(options)
    await verifyRuntime(directory, c.distribution)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function alteredArchive(edit: (tar: Buffer) => void) {
  const tar = gunzipSync(candidate().archive)
  edit(tar)
  tar.fill(32, 148, 156)
  tar.write(
    tar
      .subarray(0, 512)
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(7, '0') + '\0',
    148,
  )
  return gzipSync(tar)
}

test('archive extraction rejects traversal, absolute paths, links, special entries, duplicate names and malformed headers', () => {
  for (const path of ['../escape', '/absolute', 'bin/../../escape', 'bin\\escape', './bin/file']) {
    const archive = alteredArchive((tar) => {
      tar.fill(0, 0, 100)
      tar.write(path, 0)
    })
    expect(() => unpackRuntimeArchive(archive)).toThrow('Unsafe')
  }
  for (const type of ['1', '2', '3', '4', '5', '6', 'x', 'g', 'L', 'K'])
    expect(() =>
      unpackRuntimeArchive(
        alteredArchive((tar) => {
          tar[156] = type.charCodeAt(0)
        }),
      ),
    ).toThrow('regular files')
  const c = candidate()
  expect(() => unpackRuntimeArchive(packRuntimeArchive([c.files[0], c.files[0]]))).toThrow(
    'Duplicate',
  )
  expect(() => unpackRuntimeArchive(c.archive.subarray(0, -10))).toThrow()
  expect(() => unpackRuntimeArchive(gzipSync(gunzipSync(c.archive).subarray(0, -1024)))).toThrow(
    'Incomplete',
  )
  const badHeader = gunzipSync(c.archive)
  badHeader[0] ^= 1
  expect(() => unpackRuntimeArchive(gzipSync(badHeader))).toThrow('header/checksum')
  expect(() =>
    unpackRuntimeArchive(
      alteredArchive((tar) => {
        tar.write('0004755\0', 100)
      }),
    ),
  ).toThrow('size/mode')
})

test('setup rejects unsupported and mismatched platforms and binaries before publishing', async () => {
  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
    ['freebsd', 'x64'],
  ] as const)
    expect(() => runtimePlatform(platform, arch)).toThrow('Unsupported')
  const c = candidate(),
    root = await temporary()
  try {
    const other = c.platform === 'darwin-arm64' ? 'linux-x64' : 'darwin-arm64'
    c.distribution.platform = other
    await expect(
      installRuntime({
        root,
        manifest: c.manifest,
        platform: c.platform,
        download: async () => c.archive,
      }),
    ).rejects.toThrow('mismatched')
    expect(() => assertRuntimeBinary(c.files[0].bytes, other)).toThrow('binary')
    expect(() => assertRuntimeBinary(Buffer.from('#!/bin/sh\n'), c.platform)).toThrow('binary')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolution uses verified absolute executables and private Linux module paths in checkouts with spaces', async () => {
  const root = await temporary(),
    c = candidate()
  try {
    await mkdir(join(root, 'assets/app/camera-runtime'), { recursive: true })
    await writeFile(
      join(root, 'assets/app/camera-runtime/manifest.json'),
      JSON.stringify(c.manifest),
    )
    await installRuntime({ root, manifest: c.manifest, download: async () => c.archive })
    const runtime = await resolveRuntime(root)
    expect(runtime.executable).toBe(
      join(installationPath(root, c.distribution), c.distribution.executable),
    )
    if (c.platform === 'linux-x64')
      expect(runtime.env).toEqual({
        LD_LIBRARY_PATH: join(installationPath(root, c.distribution), 'lib'),
        CAMLIBS: join(installationPath(root, c.distribution), c.distribution.modules!.cameras),
        IOLIBS: join(installationPath(root, c.distribution), c.distribution.modules!.ports),
      })
    await rm(join(installationPath(root, c.distribution), c.distribution.executable))
    const provider = await createCameraProvider(root)
    expect(await provider.discover()).toMatchObject({
      cameras: [],
      diagnostics: [{ available: false, message: expect.stringContaining('npm run camera:setup') }],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('private gphoto loader paths preserve isolated configuration and exclude ambient loader variables', async () => {
  const root = await temporary()
  const requests: { executable: string; env: NodeJS.ProcessEnv }[] = []
  try {
    const env = {
      LD_LIBRARY_PATH: join(root, 'lib'),
      CAMLIBS: join(root, 'cameras'),
      IOLIBS: join(root, 'ports'),
    }
    const executable = join(root, 'bin/gphoto2')
    const provider = new GphotoProvider(
      root,
      async (request) => {
        requests.push(request)
        return { stdout: '', stderr: '' }
      },
      executable,
      undefined,
      env,
    )
    await provider.discover()
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.executable).toBe(executable)
      expect(request.env).toMatchObject({
        ...env,
        LANG: 'C',
        LC_ALL: 'C',
        XDG_CONFIG_HOME: join(root, 'backend-config'),
      })
      expect(Object.keys(request.env).sort()).toEqual(
        [
          'PATH',
          'LANG',
          'LC_ALL',
          'XDG_CONFIG_HOME',
          'LD_LIBRARY_PATH',
          'CAMLIBS',
          'IOLIBS',
        ].sort(),
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acceptance requires mutually exclusive explicit selectors and never chooses the first camera', () => {
  expect(acceptanceOptions([])).toEqual({ mode: 'discover', selector: undefined })
  for (const mode of ['inspect', 'controls', 'run']) {
    expect(acceptanceOptions([`--${mode}`, '--camera-id', 'second'])).toMatchObject({
      mode,
      selector: { kind: 'camera-id', value: 'second' },
    })
    expect(acceptanceOptions([`--${mode}`, '--serial', 'serial'])).toMatchObject({
      mode,
      selector: { kind: 'serial', value: 'serial' },
    })
    expect(() => acceptanceOptions([`--${mode}`])).toThrow('Never select')
  }
  for (const args of [
    ['--run', '--serial'],
    ['--inspect', '--run', '--serial', 'x'],
    ['--controls', '--inspect', '--serial', 'x'],
    ['--run', '--camera-id', '--serial'],
    ['--serial', 'x', '--camera-id', 'y'],
    ['--serial', 'x', '--serial', 'x'],
    ['--wat'],
  ])
    expect(() => acceptanceOptions(args)).toThrow()
  const cameras = [{ id: 'first' }, { id: 'second' }]
  expect(selectAcceptanceCamera(cameras, { kind: 'camera-id', value: 'second' })).toBe(cameras[1])
  expect(() => selectAcceptanceCamera(cameras, { kind: 'serial', value: 'missing' })).toThrow(
    'absent or ambiguous',
  )
  expect(() =>
    selectAcceptanceCamera([...cameras, cameras[1]], { kind: 'camera-id', value: 'second' }),
  ).toThrow('ambiguous')
})

test('acceptance recipes resolve actual native and gphoto choices and preserve matching read-only settings', () => {
  expect(
    acceptanceAlternate({
      id: 'aperture',
      value: 'f/4',
      choices: ['f/1.8', 'f/2.8', 'f/4', 'f/4.5', 'f/11'],
    }),
  ).toBe('f/4.5')
  expect(
    acceptanceAlternate({ id: 'aperture', value: 'f/11', choices: ['f/1.8', 'f/10', 'f/11'] }),
  ).toBe('f/10')
  expect(
    acceptanceSettings(
      [
        { id: 'exposureMode', value: 'P', writable: true, choices: ['P', 'M'] },
        { id: 'driveMode', value: 'Single Shot', writable: false, choices: ['Single Shot'] },
        {
          id: 'format',
          value: 'JPEG Fine',
          writable: true,
          choices: ['JPEG Fine', 'RAW+JPEG (Fine)'],
        },
      ],
      {
        exposureMode: ['Manual', 'M'],
        driveMode: ['Single', 'Single Shot'],
        format: ['RAW+JPEG', 'RAW+JPEG (Fine)'],
      },
    ),
  ).toEqual({ exposureMode: 'M', format: 'RAW+JPEG (Fine)' })
  expect(() =>
    acceptanceSettings([{ id: 'driveMode', value: 'Continuous', writable: false, choices: [] }], {
      driveMode: ['Single'],
    }),
  ).toThrow('physical setup')
  expect(() => acceptanceSettings([], { iso: ['100'] })).toThrow('advertised iso')
})
