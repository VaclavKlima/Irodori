// Proposed destination: tests/native-cpu-executable.spec.ts. Draft only; never executes the data fixture.
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpuPreviewBackend, nativeCpuExecutable } from '../src/main/native-cpu-executable'

test.beforeEach(() => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'x64',
    'Linux x64 executable-resolution contract only; other platforms remain unverified.',
  )
})

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// ELF-looking data spans two real hash reads. It is not a runnable native helper.
const data = Buffer.alloc(64 * 1024 + 17)
for (let index = 0; index < data.length; index++) data[index] = index % 251
data.set([0x7f, 0x45, 0x4c, 0x46])

async function scratch(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'luma-cpu-executable-'))
  try {
    await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
async function bundle(runtime: string) {
  const directory = join(runtime, 'native-cpu-render/linux-x64'),
    executable = join(directory, 'luma-cpu-render'),
    manifest = join(directory, 'SHA256SUMS')
  await mkdir(directory, { recursive: true })
  await writeFile(executable, data, { flag: 'wx', mode: 0o755 })
  await chmod(executable, 0o755)
  await writeFile(manifest, `${hash(data)}  luma-cpu-render\n`, { flag: 'wx', mode: 0o600 })
  return { directory, executable, manifest }
}

test('trusted source preflight and built-main runtime roots resolve their own checksummed regular files', async () => {
  await scratch(async (directory) => {
    expect(cpuPreviewBackend()).toBe('native')
    for (const relative of ['vendor', 'out/main']) {
      const runtime = join(directory, relative),
        fixture = await bundle(runtime)
      expect(await nativeCpuExecutable(runtime)).toBe(fixture.executable)
    }
  })
})

test('app.asar runtime maps only the literal archive component to its unpacked main assets', async () => {
  await scratch(async (directory) => {
    const packed = join(directory, 'resources/app.asar/out/main'),
      unpacked = join(directory, 'resources/app.asar.unpacked/out/main')
    const actual = await bundle(unpacked)
    await bundle(packed) // A valid decoy must not win over the unpacked runtime.
    expect(await nativeCpuExecutable(packed)).toBe(actual.executable)
    expect(await nativeCpuExecutable(unpacked)).toBe(actual.executable)
    const ordinary = join(directory, 'resources/app.asar-copy/out/main'),
      separate = await bundle(ordinary)
    expect(await nativeCpuExecutable(ordinary)).toBe(separate.executable)
  })
})

test('changed executable bytes fail their original checksum before an executable path can escape', async () => {
  await scratch(async (directory) => {
    const fixture = await bundle(directory),
      changed = Buffer.from(data)
    changed[65536] ^= 1
    await writeFile(fixture.executable, changed)
    await expect(nativeCpuExecutable(directory)).rejects.toThrow('checksum mismatch')
  })
})

for (const missing of ['manifest', 'executable'] as const)
  test(`missing ${missing} fails closed`, async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory)
      await rm(fixture[missing])
      await expect(nativeCpuExecutable(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

const invalidManifests = [
  ['wrong filename', `${hash(data)}  other-renderer\n`, 'checksum manifest'],
  ['wrong delimiter', `${hash(data)} luma-cpu-render\n`, 'checksum manifest'],
  [
    'multiple records',
    `${hash(data)}  luma-cpu-render\n${hash(data)}  other\n`,
    'checksum manifest',
  ],
  ['uppercase digest', `${'A'.repeat(64)}  luma-cpu-render\n`, 'checksum manifest'],
  ['empty file', '', 'invalid file'],
  ['oversized file', 'x'.repeat(257), 'invalid file'],
] as const
for (const [name, text, error] of invalidManifests)
  test(`manifest ${name} is rejected`, async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory)
      await writeFile(fixture.manifest, text)
      await expect(nativeCpuExecutable(directory)).rejects.toThrow(error)
    })
  })

for (const linked of ['manifest', 'executable'] as const)
  test(`a final-component ${linked} symlink cannot bypass the regular-file owner`, async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory),
        target = join(directory, `real-${linked}`)
      await rename(fixture[linked], target)
      await symlink(target, fixture[linked])
      await expect(nativeCpuExecutable(directory)).rejects.toMatchObject({ code: 'ELOOP' })
    })
  })

for (const invalid of ['manifest', 'executable'] as const)
  test(`a ${invalid} directory is not a regular bundle file`, async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory)
      await rm(fixture[invalid])
      await mkdir(fixture[invalid])
      await expect(nativeCpuExecutable(directory)).rejects.toThrow('invalid file')
    })
  })

test('an oversized sparse executable is rejected by metadata before hashing its contents', async () => {
  await scratch(async (directory) => {
    const fixture = await bundle(directory),
      file = await open(fixture.executable, 'r+')
    try {
      await file.truncate(128 * 1024 ** 2 + 1)
    } finally {
      await file.close()
    }
    await expect(nativeCpuExecutable(directory)).rejects.toThrow('invalid file')
  })
})

test('a correctly checksummed nonexecutable regular file is rejected without attempting execution', async () => {
  await scratch(async (directory) => {
    const fixture = await bundle(directory)
    await chmod(fixture.executable, 0o600)
    await expect(nativeCpuExecutable(directory)).rejects.toMatchObject({ code: 'EACCES' })
  })
})

test('valid working-directory decoys cannot replace a missing trusted root or authorize a relative root', async () => {
  await scratch(async (directory) => {
    const previous = process.cwd(),
      cwd = join(directory, 'cwd'),
      missing = join(directory, 'trusted-empty')
    for (const path of [cwd, join(cwd, 'vendor'), join(cwd, 'out/main')]) await bundle(path)
    await mkdir(missing)
    try {
      // Tests in this file run sequentially; always restore this worker's CWD.
      process.chdir(cwd)
      await expect(nativeCpuExecutable(missing)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(nativeCpuExecutable('vendor')).rejects.toThrow('absolute trusted runtime root')
    } finally {
      process.chdir(previous)
    }
  })
})
