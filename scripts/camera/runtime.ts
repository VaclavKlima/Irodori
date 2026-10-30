import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { release } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  archiveLimit,
  expandedLimit,
  safeRuntimePath,
  sha256,
  unpackRuntimeArchive,
} from './archive.ts'

export const checkoutRoot = fileURLToPath(new URL('../../', import.meta.url))
export type RuntimePlatform = 'darwin-arm64' | 'linux-x64'
export interface RuntimeFile {
  path: string
  bytes: number
  mode: number
  sha256: string
}
export interface RuntimeDistribution {
  version: string
  platform: RuntimePlatform
  url: string
  archive: string
  bytes: number
  sha256: string
  executable: string
  files: RuntimeFile[]
  modules?: { cameras: string; ports: string }
}
export interface RuntimeManifest {
  schema: 1
  release: string
  platforms: Record<RuntimePlatform, RuntimeDistribution>
}

export function runtimePlatform(platform = process.platform, arch = process.arch): RuntimePlatform {
  const key = `${platform}-${arch}`
  if (key !== 'darwin-arm64' && key !== 'linux-x64')
    throw new Error(
      `Unsupported camera runtime ${key}. Supported: Apple Silicon macOS 14+ and glibc Linux x64.`,
    )
  return key
}

export function assertRuntimeHost(platform: RuntimePlatform) {
  if (runtimePlatform() !== platform)
    throw new Error('Camera runtime platform does not match this host.')
  if (platform === 'darwin-arm64' && Number(release().split('.')[0]) < 23)
    throw new Error('The camera runtime requires macOS 14 or newer.')
  if (platform === 'linux-x64') {
    const { header } = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    const [major, minor] = (header.glibcVersionRuntime ?? '0.0').split('.').map(Number)
    if (major < 2 || (major === 2 && minor < 35))
      throw new Error(
        'The camera runtime requires glibc 2.35+ (Bazzite/Fedora or Ubuntu 22.04+); musl is unsupported.',
      )
  }
}

export async function readRuntimeManifest(root = checkoutRoot): Promise<RuntimeManifest> {
  const manifest: RuntimeManifest = JSON.parse(
    await readFile(join(root, 'assets/app/camera-runtime/manifest.json'), 'utf8'),
  )
  if (manifest.schema !== 1 || !/^camera-runtime-v\d+\.\d+\.\d+$/.test(manifest.release))
    throw new Error('Invalid camera runtime manifest.')
  return manifest
}

function validateDistribution(distribution: RuntimeDistribution, platform: RuntimePlatform) {
  if (
    distribution.platform !== platform ||
    !/^\d+\.\d+\.\d+$/.test(distribution.version) ||
    !/^[a-f0-9]{64}$/.test(distribution.sha256) ||
    distribution.bytes < 1 ||
    distribution.bytes > archiveLimit ||
    !Array.isArray(distribution.files) ||
    distribution.files.length < 1 ||
    distribution.files.length > 1024
  )
    throw new Error('Invalid or mismatched camera runtime distribution.')
  let total = 0
  const paths = new Set<string>()
  for (const file of distribution.files) {
    safeRuntimePath(file.path)
    if (
      paths.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      ![0o644, 0o755].includes(file.mode) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid camera runtime file index.')
    paths.add(file.path)
    total += file.bytes
  }
  if (
    total > expandedLimit ||
    !distribution.files.some((file) => file.path === distribution.executable && file.mode === 0o755)
  )
    throw new Error('Invalid camera runtime executable or size.')
  if (platform === 'linux-x64') {
    if (!distribution.modules) throw new Error('Missing private gphoto2 modules.')
    for (const path of Object.values(distribution.modules)) {
      safeRuntimePath(path)
      if (
        !distribution.files.some(
          (file) => file.path.startsWith(`${path}/`) && file.path.endsWith('.so'),
        )
      )
        throw new Error('Missing private gphoto2 module files.')
    }
  }
}

export function assertRuntimeBinary(bytes: Buffer, platform: RuntimePlatform) {
  const valid =
    platform === 'darwin-arm64'
      ? bytes.length >= 32 &&
        bytes.readUInt32LE(0) === 0xfeedfacf &&
        bytes.readUInt32LE(4) === 0x0100000c
      : bytes.length >= 64 &&
        bytes.subarray(0, 4).toString('hex') === '7f454c46' &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        bytes.readUInt16LE(18) === 62
  if (!valid) throw new Error(`Camera executable is not a ${platform} binary.`)
}

export function installationPath(root: string, distribution: RuntimeDistribution) {
  return join(
    root,
    'artifacts/camera/runtime',
    distribution.platform,
    `${distribution.version}-${distribution.sha256}`,
  )
}

export async function verifyRuntime(directory: string, distribution: RuntimeDistribution) {
  validateDistribution(distribution, distribution.platform)
  const found: string[] = []
  async function walk(path: string, relative = '') {
    if (!(await lstat(path)).isDirectory())
      throw new Error('Runtime directory is not a real directory.')
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(path, entry.name), name)
      else if (entry.isFile()) found.push(name)
      else throw new Error(`Runtime links/special files are forbidden: ${name}`)
    }
  }
  await walk(directory)
  if (
    found.sort().join('\n') !==
    distribution.files
      .map((file) => file.path)
      .sort()
      .join('\n')
  )
    throw new Error('Installed camera runtime has missing or unexpected files.')
  for (const file of distribution.files) {
    const path = join(directory, file.path)
    const info = await lstat(path)
    if (!info.isFile() || info.size !== file.bytes || (info.mode & 0o7777) !== file.mode)
      throw new Error(`Camera runtime size/mode mismatch: ${file.path}`)
    const bytes = await readFile(path)
    if (sha256(bytes) !== file.sha256)
      throw new Error(`Camera runtime integrity mismatch: ${file.path}`)
    if (file.path === distribution.executable) assertRuntimeBinary(bytes, distribution.platform)
  }
}

export async function downloadRuntime(url: string): Promise<Buffer> {
  const location = new URL(url)
  if (
    location.protocol !== 'https:' ||
    location.hostname !== 'github.com' ||
    !location.pathname.startsWith('/VaclavKlima/Irodori/releases/download/camera-runtime-v')
  )
    throw new Error('Camera runtime downloads must use the dedicated GitHub release.')
  const response = await fetch(location, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body)
    throw new Error(`Camera runtime download failed: HTTP ${response.status}`)
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > archiveLimit) throw new Error('Camera runtime download exceeds limit.')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

export async function installRuntime(options: {
  root?: string
  manifest?: RuntimeManifest
  platform?: RuntimePlatform
  archive?: string
  download?: typeof downloadRuntime
  beforePublish?: () => Promise<void>
}) {
  const root = options.root ?? checkoutRoot
  const platform = options.platform ?? runtimePlatform()
  const manifest = options.manifest ?? (await readRuntimeManifest(root))
  const distribution = manifest.platforms[platform]
  validateDistribution(distribution, platform)
  const destination = installationPath(root, distribution)
  // An explicit candidate must always be checked, even if the installation exists.
  const local = options.archive ? await readBoundedArchive(resolve(options.archive)) : undefined
  const validateArchive = (bytes: Buffer) => {
    if (bytes.length !== distribution.bytes || sha256(bytes) !== distribution.sha256)
      throw new Error('Camera runtime archive checksum/size mismatch; working runtime preserved.')
    return bytes
  }
  if (local) validateArchive(local)
  try {
    await verifyRuntime(destination, distribution)
    return { directory: destination, reused: true }
  } catch {
    /* Install only after every candidate file has been verified. */
  }
  const archive = validateArchive(
    local ?? (await (options.download ?? downloadRuntime)(distribution.url)),
  )
  const files = unpackRuntimeArchive(archive)
  if (files.length !== distribution.files.length) throw new Error('Runtime archive index mismatch.')
  for (const file of files) {
    const expected = distribution.files.find((record) => record.path === file.path)
    if (
      !expected ||
      expected.bytes !== file.bytes.length ||
      expected.mode !== file.mode ||
      expected.sha256 !== sha256(file.bytes)
    )
      throw new Error(`Runtime archive file integrity mismatch: ${file.path}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(join(dirname(destination), '.install-'))
  const backup = `${staging}-previous`
  let previous = false
  try {
    for (const file of files) {
      const path = join(staging, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.bytes, { flag: 'wx', mode: file.mode })
      await chmod(path, file.mode)
    }
    await verifyRuntime(staging, distribution)
    await options.beforePublish?.()
    // Another setup can finish while this one is downloading/staging.
    try {
      await verifyRuntime(destination, distribution)
      return { directory: destination, reused: true }
    } catch {
      /* An invalid installation can only be replaced by a verified one. */
    }
    try {
      await rename(destination, backup)
      previous = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(staging, destination)
    } catch (error) {
      if (previous) await rename(backup, destination)
      throw error
    }
    if (previous) await rm(backup, { recursive: true, force: true })
    return { directory: destination, reused: false }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function readBoundedArchive(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.size < 1 || info.size > archiveLimit)
    throw new Error('Invalid bounded runtime archive.')
  return readFile(path)
}

export async function resolveRuntime(root = checkoutRoot) {
  const platform = runtimePlatform()
  assertRuntimeHost(platform)
  const manifest = await readRuntimeManifest(root)
  const distribution = manifest.platforms[platform]
  validateDistribution(distribution, platform)
  const directory = installationPath(root, distribution)
  await verifyRuntime(directory, distribution)
  return {
    executable: join(directory, distribution.executable),
    env:
      platform === 'linux-x64'
        ? {
            LD_LIBRARY_PATH: join(directory, 'lib'),
            CAMLIBS: join(directory, distribution.modules!.cameras),
            IOLIBS: join(directory, distribution.modules!.ports),
          }
        : {},
  }
}
