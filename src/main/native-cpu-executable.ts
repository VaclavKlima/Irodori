import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const BINARY_LIMIT = 128 * 1024 ** 2

export function cpuPreviewBackend(): 'native' | 'javascript' {
  return process.platform === 'linux' && process.arch === 'x64' ? 'native' : 'javascript'
}

async function checkedFile(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > maximum)
      throw new Error('The bundled native CPU renderer contains an invalid file.')
    return { file, info }
  } catch (error) {
    await file.close()
    throw error
  }
}
async function read(file: FileHandle, bytes: Buffer, position: number) {
  let filled = 0
  while (filled < bytes.length) {
    const result = await file.read(bytes, filled, bytes.length - filled, position + filled)
    if (!result.bytesRead) throw new Error('The bundled native CPU renderer is truncated.')
    filled += result.bytesRead
  }
}

/** Runtime assets are copied beside the built main entry. Callers may supply
 * only a trusted absolute runtime root (the build preflight uses vendor/).
 * There is no working-directory or renderer-supplied path fallback. */
export async function nativeCpuExecutable(
  trustedRuntimeRoot = import.meta.dirname,
): Promise<string> {
  if (cpuPreviewBackend() !== 'native')
    throw new Error('Native CPU preview is not bundled for this platform.')
  if (!isAbsolute(trustedRuntimeRoot)) throw new Error('Expected an absolute trusted runtime root.')
  const root = join(
    trustedRuntimeRoot.replace(/\/app\.asar(?=\/|$)/, '/app.asar.unpacked'),
    'native-cpu-render/linux-x64',
  )
  const executable = join(root, 'irodori-cpu-render')
  const manifest = await checkedFile(join(root, 'SHA256SUMS'), 256)
  let expected: string
  try {
    const bytes = Buffer.alloc(manifest.info.size)
    await read(manifest.file, bytes, 0)
    const extra = Buffer.alloc(1)
    if ((await manifest.file.read(extra, 0, 1, bytes.length)).bytesRead)
      throw new Error('The bundled native CPU checksum manifest grew during validation.')
    const match = /^([a-f0-9]{64}) {2}irodori-cpu-render$/.exec(bytes.toString('utf8').trim())
    if (!match) throw new Error('Invalid bundled native CPU checksum manifest.')
    expected = match[1]
  } finally {
    await manifest.file.close()
  }
  const binary = await checkedFile(executable, BINARY_LIMIT)
  try {
    const hash = createHash('sha256'),
      storage = Buffer.alloc(64 * 1024)
    let position = 0
    while (position < binary.info.size) {
      const bytes = storage.subarray(0, Math.min(storage.length, binary.info.size - position))
      await read(binary.file, bytes, position)
      hash.update(bytes)
      position += bytes.length
    }
    const final = await binary.file.stat()
    if (
      final.size !== binary.info.size ||
      final.ino !== binary.info.ino ||
      final.dev !== binary.info.dev ||
      final.mtimeMs !== binary.info.mtimeMs ||
      hash.digest('hex') !== expected
    )
      throw new Error('Bundled native CPU renderer checksum mismatch.')
  } finally {
    await binary.file.close()
  }
  await access(executable, constants.X_OK)
  return executable
}

/** Capability discovery is privileged startup work against the same verified
 * bundled executable used for normal CPU jobs. It accepts only bounded output,
 * real stdout/stderr EOF and a successful actual child close. */
export async function nativeCpuMaskCapability(
  trustedRuntimeRoot = import.meta.dirname,
): Promise<{ arithmeticSha256: string }> {
  const executable = await nativeCpuExecutable(trustedRuntimeRoot)
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, ['--capabilities'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let problem: Error | undefined
    let size = 0,
      errors = 0,
      stdoutEnded = false,
      stderrEnded = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const chunks: Buffer[] = []
    const stop = (error: Error) => {
      problem ??= error
      if (escalation) return
      child.kill('SIGTERM')
      escalation = setTimeout(() => child.kill('SIGKILL'), 1000)
      escalation.unref()
    }
    const timeout = setTimeout(
      () => stop(new Error('Native CPU capability discovery timed out.')),
      10000,
    )
    timeout.unref()
    child.once('error', (error) => stop(error))
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) stop(new Error('Native CPU capabilities exceed the output bound.'))
      else if (!problem) chunks.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.length
      if (errors > 64 * 1024)
        stop(new Error('Native CPU capability diagnostics exceed the output bound.'))
    })
    child.stdout.once('end', () => {
      stdoutEnded = true
    })
    child.stderr.once('end', () => {
      stderrEnded = true
    })
    child.stdout.once('error', (error) => stop(error))
    child.stderr.once('error', (error) => stop(error))
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (escalation) clearTimeout(escalation)
      if (problem) return reject(problem)
      if (code !== 0 || signal !== null || !stdoutEnded || !stderrEnded || !size)
        return reject(
          new Error('Native CPU capability discovery did not finish with complete output.'),
        )
      resolve(Buffer.concat(chunks, size))
    })
  })
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes))
    throw new Error('Native CPU capabilities are not valid UTF-8.')
  const capability = JSON.parse(text)
  const mask = capability?.mask,
    arithmetic = mask?.arithmetic,
    reference = arithmetic?.reference
  const sha = /^[a-f0-9]{64}$/
  if (
    capability?.version !== 'native-cpu-capabilities-v1' ||
    capability.presentation !== 'IRODCPU3' ||
    mask?.request !== 'MASKCPU3' ||
    mask.output !== 'MASKOUT1' ||
    mask.terminal !== 'MASKDONE' ||
    mask.mode !== '--mask-v1' ||
    typeof mask.arithmeticSha256 !== 'string' ||
    !sha.test(mask.arithmeticSha256) ||
    arithmetic?.version !== 'native-hdr-mask-arithmetic-v3-electron-llvm' ||
    !reference ||
    typeof reference !== 'object' ||
    Array.isArray(reference) ||
    Object.keys(reference).sort().join(',') !== 'chromium,electron,llvmLibcRevision,v8' ||
    reference.electron !== '44.3.0' ||
    reference.v8 !== '15.2.124.19-electron.0' ||
    reference.chromium !== '152.0.7977.78' ||
    reference.llvmLibcRevision !== '3ea89f4304312567e31a8eb45e0737577e65b676' ||
    JSON.stringify(arithmetic.maskCompilerFlags) !==
      JSON.stringify(['-mno-fma', '-mno-avx', '-mno-sse4.2']) ||
    arithmetic.substitution?.count !== 1 ||
    arithmetic.substitution.before !== 'double h_rad = atan2(Aab[2], Aab[1]);' ||
    arithmetic.substitution.after !==
      'double h_rad = irodori_electron_atan2::atan2(Aab[2], Aab[1]);' ||
    arithmetic.isolation !== 'namespace and C symbol renames only'
  )
    throw new Error(
      'The bundled CPU helper does not declare the supported Electron LLVM mask arithmetic.',
    )
  // Ordinary Node service/build discovery may inspect this same bundle. When
  // running in Electron, its actual engine must match the declared reference.
  if (
    process.versions.electron &&
    (process.versions.electron !== reference.electron ||
      process.versions.v8 !== reference.v8 ||
      process.versions.chrome !== reference.chromium)
  )
    throw new Error(
      'This Electron runtime does not match the bundled native mask arithmetic reference.',
    )
  for (const name of [
    'ordinaryGeneratedSha256',
    'candidateGeneratedSha256',
    'maskGeneratedSha256',
    'normalBridgeSha256',
    'maskContextSha256',
    'llvmShimSha256',
    'upstreamManifestSha256',
    'maskBridgeSha256',
    'maskHostSha256',
    'prepareSourceSha256',
    'creativeHeaderSha256',
    'creativeAbiSha256',
    'creativeHostSha256',
  ])
    if (typeof arithmetic[name] !== 'string' || !sha.test(arithmetic[name]))
      throw new Error('The bundled mask arithmetic receipt contains an invalid source hash.')
  const sourcePins = arithmetic.upstreamSourcePins
  const sourceNames = [
    'provenance/electron-DEPS',
    'provenance/chromium-DEPS',
    'provenance/chromium-llvm-BUILD.gn',
    'provenance/chromium-llvm-README.chromium',
    'provenance/v8-ieee754.cc',
    'llvm-libc/LICENSE.TXT',
    'llvm-libc/shared/math/atan2.h',
    'llvm-libc/shared/libc_common.h',
    'llvm-libc/src/__support/math/atan2.h',
    'llvm-libc/src/__support/math/atan_utils.h',
    'llvm-libc/src/__support/FPUtil/double_double.h',
    'llvm-libc/src/__support/FPUtil/FPBits.h',
    'llvm-libc/src/__support/FPUtil/multiply_add.h',
    'llvm-libc/src/__support/FPUtil/nearest_integer.h',
  ]
  if (!sourcePins || typeof sourcePins !== 'object' || Array.isArray(sourcePins))
    throw new Error('The bundled mask upstream provenance is incomplete.')
  const names = Object.keys(sourcePins)
  if (
    names.length < sourceNames.length ||
    names.length > 256 ||
    sourceNames.some((name) => !Object.hasOwn(sourcePins, name)) ||
    names.some(
      (name) =>
        name.length > 256 ||
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) ||
        name.split('/').some((part) => part === '.' || part === '..') ||
        typeof sourcePins[name] !== 'string' ||
        !sha.test(sourcePins[name]),
    )
  )
    throw new Error('The bundled mask upstream provenance is incomplete.')
  // prepare-mask.py hashes sorted-key compact JSON. All receipt leaves are
  // ASCII strings and finite integers, so this has the same exact encoding.
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) throw new Error('Invalid mask arithmetic receipt value.')
      return encoded
    }
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    )
  }
  if (createHash('sha256').update(canonical(arithmetic)).digest('hex') !== mask.arithmeticSha256)
    throw new Error('The bundled mask arithmetic receipt does not match its capability hash.')
  return Object.freeze({ arithmeticSha256: mask.arithmeticSha256 })
}
