import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareNativeRawExecutable,
  type NativeRawExecutable,
} from '../src/main/native-raw-executable'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// Non-runnable file data crosses the resolver's 64 KiB hash-read boundary.
const data = Buffer.alloc(64 * 1024 + 17)
for (let index = 0; index < data.length; index++) data[index] = index % 251
data.set([0x7f, 0x45, 0x4c, 0x46])

async function scratch(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'luma-raw-executable-'))
  try {
    await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function bundle(runtime: string) {
  const directory = join(runtime, 'native-raw/linux-x64'),
    executable = join(directory, 'luma-raw'),
    sums = join(directory, 'SHA256SUMS'),
    manifest = join(directory, 'build-manifest.json')
  const proof = {
    implementation: 'luma-owned-sony-arw2-rows-v1',
    status: 'built-unverified',
    platform: 'linux',
    arch: 'x64',
    entry: '--owned-rows-v1',
    maximumTotalThreads: 8,
    binarySha256: hash(data),
  }
  await mkdir(directory, { recursive: true })
  await writeFile(executable, data, { flag: 'wx', mode: 0o755 })
  await chmod(executable, 0o755)
  await writeFile(sums, `${hash(data)}  luma-raw\n`, { flag: 'wx', mode: 0o600 })
  await writeFile(manifest, JSON.stringify(proof), { flag: 'wx', mode: 0o600 })
  return { directory, executable, sums, manifest, proof }
}

function unavailable(value: NativeRawExecutable, reason?: RegExp) {
  expect(value.status).toBe('unavailable')
  if (value.status !== 'unavailable')
    throw new Error('An invalid bundle exposed an executable path.')
  expect(Number.isFinite(value.validationMs) && value.validationMs >= 0).toBe(true)
  expect(value).not.toHaveProperty('path')
  if (reason) expect(value.reason).toMatch(reason)
  return value
}

test('the real platform or missing trusted assets returns explicit unavailable without an executable', async () => {
  await scratch(async (directory) => {
    const result = await prepareNativeRawExecutable(directory)
    unavailable(
      result,
      process.platform === 'linux' && process.arch === 'x64'
        ? /ENOENT/
        : /not bundled for this platform/,
    )
  })
})

test.describe('Linux x64 trusted native RAW assets', () => {
  test.beforeEach(() => {
    test.skip(
      process.platform !== 'linux' || process.arch !== 'x64',
      'Real Linux x64 file-resolution contract; no process.platform emulation.',
    )
  })

  test('vendor and built-main roots validate their own regular bundle files without running them', async () => {
    await scratch(async (directory) => {
      for (const relative of ['vendor', 'out/main']) {
        const runtime = join(directory, relative),
          fixture = await bundle(runtime)
        const result = await prepareNativeRawExecutable(runtime)
        expect(result.status).toBe('ready')
        if (result.status !== 'ready') throw new Error(result.reason)
        expect(result.path).toBe(fixture.executable)
        expect(result.sha256).toBe(hash(data))
        expect(Number.isFinite(result.validationMs) && result.validationMs >= 0).toBe(true)
      }
    })
  })

  test('only the literal app.asar component maps to its unpacked assets', async () => {
    await scratch(async (directory) => {
      const packed = join(directory, 'resources/app.asar/out/main'),
        unpacked = join(directory, 'resources/app.asar.unpacked/out/main'),
        actual = await bundle(unpacked)
      await bundle(packed)
      expect(await prepareNativeRawExecutable(packed)).toMatchObject({
        status: 'ready',
        path: actual.executable,
      })
      expect(await prepareNativeRawExecutable(unpacked)).toMatchObject({
        status: 'ready',
        path: actual.executable,
      })
      const ordinary = join(directory, 'resources/app.asar-copy/out/main'),
        separate = await bundle(ordinary)
      expect(await prepareNativeRawExecutable(ordinary)).toMatchObject({
        status: 'ready',
        path: separate.executable,
      })
    })
  })

  test('a changed byte in the second hash read invalidates a previously valid bundle', async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory)
      expect((await prepareNativeRawExecutable(directory)).status).toBe('ready')
      const changed = Buffer.from(data)
      changed[65536] ^= 1
      await writeFile(fixture.executable, changed)
      unavailable(await prepareNativeRawExecutable(directory), /checksum mismatch/)
      await writeFile(fixture.sums, `${hash(changed)}  luma-raw\n`)
      await writeFile(
        fixture.manifest,
        JSON.stringify({ ...fixture.proof, binarySha256: hash(changed) }),
      )
      expect(await prepareNativeRawExecutable(directory)).toMatchObject({
        status: 'ready',
        sha256: hash(changed),
      })
    })
  })

  for (const missing of ['executable', 'sums', 'manifest'] as const)
    test(`missing ${missing} permits only explicit unavailable fallback`, async () => {
      await scratch(async (directory) => {
        const fixture = await bundle(directory)
        await rm(fixture[missing])
        unavailable(await prepareNativeRawExecutable(directory), /ENOENT/)
      })
    })

  for (const [name, text] of [
    ['wrong filename', `${hash(data)}  other-helper\n`],
    ['wrong delimiter', `${hash(data)} luma-raw\n`],
    ['multiple records', `${hash(data)}  luma-raw\n${hash(data)}  other\n`],
    ['uppercase digest', `${'A'.repeat(64)}  luma-raw\n`],
    ['missing terminal newline', `${hash(data)}  luma-raw`],
  ] as const)
    test(`checksum ${name} cannot authorize the bundle`, async () => {
      await scratch(async (directory) => {
        const fixture = await bundle(directory)
        await writeFile(fixture.sums, text)
        unavailable(await prepareNativeRawExecutable(directory), /checksum manifest/)
      })
    })

  for (const [key, wrong] of [
    ['implementation', 'luma-parallel-sony-arw2-rows-v1'],
    ['status', 'building'],
    ['platform', 'darwin'],
    ['arch', 'arm64'],
    ['entry', '--rows-v1'],
    ['maximumTotalThreads', 9],
    ['binarySha256', '0'.repeat(64)],
  ] as const)
    test(`a mismatched owned-entry ${key} cannot authorize even checksummed bytes`, async () => {
      await scratch(async (directory) => {
        const fixture = await bundle(directory)
        await writeFile(fixture.manifest, JSON.stringify({ ...fixture.proof, [key]: wrong }))
        unavailable(await prepareNativeRawExecutable(directory), /build manifest/)
      })
    })

  test('malformed build JSON is unavailable and exposes no executable', async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory)
      await writeFile(fixture.manifest, '{not-json')
      unavailable(await prepareNativeRawExecutable(directory))
    })
  })

  test('a matching forged checksum and build record still cannot replace actual byte validation', async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory),
        wrong = '0'.repeat(64)
      await writeFile(fixture.sums, `${wrong}  luma-raw\n`)
      await writeFile(fixture.manifest, JSON.stringify({ ...fixture.proof, binarySha256: wrong }))
      unavailable(await prepareNativeRawExecutable(directory), /checksum mismatch/)
    })
  })

  for (const linked of ['executable', 'sums', 'manifest'] as const)
    test(`a final-component ${linked} symlink is rejected before its target authorizes anything`, async () => {
      await scratch(async (directory) => {
        const fixture = await bundle(directory),
          target = join(directory, `real-${linked}`)
        await rename(fixture[linked], target)
        await symlink(target, fixture[linked])
        unavailable(await prepareNativeRawExecutable(directory), /ELOOP/)
      })
    })

  for (const invalid of ['executable', 'sums', 'manifest'] as const)
    test(`a ${invalid} directory is not a regular bundle file`, async () => {
      await scratch(async (directory) => {
        const fixture = await bundle(directory)
        await rm(fixture[invalid])
        await mkdir(fixture[invalid])
        unavailable(await prepareNativeRawExecutable(directory), /invalid file/)
      })
    })

  for (const [member, maximum] of [
    ['executable', 128 * 1024 ** 2],
    ['sums', 256],
    ['manifest', 1024 ** 2],
  ] as const)
    test(`an oversized sparse ${member} is rejected by metadata before allocation or hashing`, async () => {
      await scratch(async (directory) => {
        const fixture = await bundle(directory),
          file = await open(fixture[member], 'r+')
        try {
          await file.truncate(maximum + 1)
        } finally {
          await file.close()
        }
        unavailable(await prepareNativeRawExecutable(directory), /invalid file/)
      })
    })

  for (const empty of ['executable', 'sums', 'manifest'] as const)
    test(`an empty ${empty} is unavailable`, async () => {
      await scratch(async (directory) => {
        const fixture = await bundle(directory)
        await writeFile(fixture[empty], '')
        unavailable(await prepareNativeRawExecutable(directory), /invalid file/)
      })
    })

  test('a correctly checksummed nonexecutable regular file is unavailable without execution', async () => {
    await scratch(async (directory) => {
      const fixture = await bundle(directory)
      await chmod(fixture.executable, 0o600)
      unavailable(await prepareNativeRawExecutable(directory), /EACCES/)
    })
  })

  test('working-directory decoys cannot replace a missing trusted root or authorize a relative root', async () => {
    await scratch(async (directory) => {
      const previous = process.cwd(),
        cwd = join(directory, 'cwd'),
        missing = join(directory, 'trusted-empty')
      for (const path of [cwd, join(cwd, 'vendor'), join(cwd, 'out/main')]) await bundle(path)
      await mkdir(missing)
      try {
        process.chdir(cwd)
        unavailable(await prepareNativeRawExecutable(missing), /ENOENT/)
        unavailable(await prepareNativeRawExecutable('vendor'), /absolute trusted runtime root/)
      } finally {
        process.chdir(previous)
      }
    })
  })
})
