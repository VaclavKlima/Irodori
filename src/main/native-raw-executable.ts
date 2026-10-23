import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export type NativeRawExecutable =
  | { status: 'ready'; path: string; sha256: string; validationMs: number }
  | { status: 'unavailable'; reason: string; validationMs: number }

const BINARY_LIMIT = 128 * 1024 ** 2
const IMPLEMENTATION = 'luma-owned-sony-arw2-rows-v1'

async function checkedFile(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > maximum)
      throw new Error('The bundled native RAW source contains an invalid file.')
    return { file, info }
  } catch (error) {
    await file.close()
    throw error
  }
}

async function read(file: FileHandle, bytes: Buffer, position: number) {
  let filled = 0
  while (filled < bytes.length) {
    const part = await file.read(bytes, filled, bytes.length - filled, position + filled)
    if (!part.bytesRead) throw new Error('The bundled native RAW source is truncated.')
    filled += part.bytesRead
  }
}

async function smallFile(path: string, maximum: number) {
  const { file, info } = await checkedFile(path, maximum)
  try {
    const bytes = Buffer.alloc(info.size)
    await read(file, bytes, 0)
    const extra = Buffer.alloc(1)
    if ((await file.read(extra, 0, 1, bytes.length)).bytesRead)
      throw new Error('The native RAW manifest grew during validation.')
    const final = await file.stat()
    if (
      final.mtimeMs !== info.mtimeMs ||
      final.ctimeMs !== info.ctimeMs ||
      final.size !== info.size
    )
      throw new Error('The native RAW manifest changed during validation.')
    return bytes
  } finally {
    await file.close()
  }
}

/** Only the trusted bundled runtime root is accepted. There is no environment,
 * working-directory or renderer-provided executable fallback. Unavailable assets
 * permit the caller's explicit WASM path; native protocol failures are separate. */
export async function prepareNativeRawExecutable(
  trustedRuntimeRoot = import.meta.dirname,
): Promise<NativeRawExecutable> {
  const started = performance.now()
  const unavailable = (reason: string): NativeRawExecutable => ({
    status: 'unavailable',
    reason,
    validationMs: performance.now() - started,
  })
  if (process.platform !== 'linux' || process.arch !== 'x64')
    return unavailable('Native RAW source is not bundled for this platform.')
  if (!isAbsolute(trustedRuntimeRoot))
    return unavailable('Expected an absolute trusted runtime root.')
  try {
    const root = join(
      trustedRuntimeRoot.replace(/\/app\.asar(?=\/|$)/, '/app.asar.unpacked'),
      'native-raw/linux-x64',
    )
    const path = join(root, 'luma-raw')
    const sums = await smallFile(join(root, 'SHA256SUMS'), 256)
    const match = /^([a-f0-9]{64}) {2}luma-raw\n$/.exec(sums.toString('utf8'))
    if (!match) throw new Error('Invalid bundled native RAW checksum manifest.')
    const sha256 = match[1]
    const manifest = JSON.parse(
      (await smallFile(join(root, 'build-manifest.json'), 1024 ** 2)).toString('utf8'),
    )
    if (
      manifest.implementation !== IMPLEMENTATION ||
      manifest.status !== 'built-unverified' ||
      manifest.platform !== 'linux' ||
      manifest.arch !== 'x64' ||
      manifest.entry !== '--owned-rows-v1' ||
      manifest.maximumTotalThreads !== 8 ||
      manifest.binarySha256 !== sha256
    )
      throw new Error('The native RAW build manifest does not match the owned entry.')
    const binary = await checkedFile(path, BINARY_LIMIT)
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
        final.ctimeMs !== binary.info.ctimeMs ||
        hash.digest('hex') !== sha256
      )
        throw new Error('Bundled native RAW source checksum mismatch.')
    } finally {
      await binary.file.close()
    }
    await access(path, constants.X_OK)
    return { status: 'ready', path, sha256, validationMs: performance.now() - started }
  } catch (error) {
    return unavailable(String(error).slice(0, 1024))
  }
}
