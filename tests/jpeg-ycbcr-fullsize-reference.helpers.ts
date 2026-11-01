import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JPEG_REFERENCE_VERSION,
  jpegReferencePrerequisite,
  type JpegReferencePrerequisite,
  type JpegReferenceSamples,
} from './jpeg-ycbcr-reference.helpers'

export const FULLSIZE_JPEG_MAX_PIXELS = 33_554_432
export const FULLSIZE_JPEG_MAX_SIDE = 32_768
export const FULLSIZE_JPEG_MAX_INPUT_BYTES = 128 * 1024 ** 2
export const FULLSIZE_JPEG_MAX_HEADER_BYTES = 16 * 1024
export const FULLSIZE_JPEG_MAX_STRIPE_ROWS = 64
export const FULLSIZE_JPEG_MAX_STRIPE_BYTES = 16 * 1024 ** 2
const chunkBytes = 1024 * 1024
const readerPath = fileURLToPath(new URL('./jpeg-ycbcr-reference.py', import.meta.url))
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
type Mode = JpegReferenceSamples['mode']
interface PythonIdentity {
  version: string
  executable: string
  sha256: string
}
interface Header {
  protocol: 'irodori-jpeg-reference-file-v1'
  transport: 'private-binary-file'
  mode: Mode
  width: number
  height: number
  bytes: number
  sampling: '4:4:4'
  jpegColorSpace: 'YCbCr'
  layout: 'planar-y-cb-cr' | 'interleaved-rgb8'
  pythonVersion: string
  pythonExecutable: string
  pythonSha256: string
  libraryPath: string
  librarySha256: string
  readerSha256: string
  inputBytes: number
  inputSha256: string
  samplesFile: 'samples.bin'
  samplesSha256: string
  idct: 'accurate-integer-jdct-islow'
}
export interface FullsizeJpegReference {
  readonly width: number
  readonly height: number
  readonly mode: Mode
  readonly inputSha256: string
  readonly samplesSha256: string
  readonly privateDirectory: string
  readonly maxRowsPerRead: number
  readonly provenance: JpegReferenceSamples['provenance'] & {
    readonly pythonExecutable: string
    readonly pythonSha256: string
    readonly readerSha256: string
    readonly idct: 'accurate-integer-jdct-islow'
  }
  /** Planes use this stripe's local height. top retains its full-image position. */
  readRows(top: number, count: number): Promise<JpegReferenceSamples & { top: number }>
  close(): Promise<void>
}

/** Resolve only after process retirement, including abort, timeout or bounded-header refusal. */
function runHeader(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Own ordinary wrapper descendants, including inherited stdout/stderr.
        detached: true,
      }),
      stdout: Buffer[] = [],
      stderr: Buffer[] = []
    let stdoutBytes = 0,
      stderrBytes = 0,
      failure: Error | undefined,
      killTimer: NodeJS.Timeout | undefined
    const signalGroup = (name: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          failure ??= new Error('Could not retire the independent JPEG process group.', {
            cause: error,
          })
          child.kill(name)
        }
      }
    }
    const stop = (error: Error) => {
      failure ??= error
      signalGroup('SIGTERM')
      // Keep escalation alive even when the leader exits before its descendants.
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), 1000)
    }
    const aborted = () => {
      const error = new Error('Independent full-size JPEG request aborted.')
      error.name = 'AbortError'
      stop(error)
    }
    const timer = setTimeout(
      () => stop(new Error('Independent full-size JPEG reader timed out.')),
      30_000,
    )
    child.stdout.on('data', (value: Buffer) => {
      stdoutBytes += value.length
      if (stdoutBytes > FULLSIZE_JPEG_MAX_HEADER_BYTES)
        stop(new Error('Independent full-size JPEG header exceeds 16 KiB.'))
      else stdout.push(value)
    })
    child.stderr.on('data', (value: Buffer) => {
      stderrBytes += value.length
      if (stderrBytes > FULLSIZE_JPEG_MAX_HEADER_BYTES)
        stop(new Error('Independent full-size JPEG diagnostics exceed 16 KiB.'))
      else stderr.push(value)
    })
    child.once('error', (error) => {
      failure ??= error
    })
    child.once('exit', () => {
      // A successful wrapper can leave a worker holding our pipes open. Waiting
      // for close before retiring that worker would deadlock the transport.
      signalGroup('SIGKILL')
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', aborted)
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new Error(
            `Independent full-size JPEG reader failed: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        )
      else accept(Buffer.concat(stdout).toString('utf8'))
    })
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
  })
}
function headerObject(text: string): Record<string, unknown> {
  if (
    Buffer.byteLength(text, 'utf8') > FULLSIZE_JPEG_MAX_HEADER_BYTES ||
    !text.endsWith('\n') ||
    text.indexOf('\n') !== text.length - 1
  )
    throw new Error('Invalid independent full-size JPEG header framing.')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid independent full-size JPEG header object.')
  return value as Record<string, unknown>
}
async function readExact(
  file: FileHandle,
  destination: Buffer,
  offset: number,
  bytes: number,
  position: number,
  guard: () => void,
): Promise<void> {
  let copied = 0
  while (copied < bytes) {
    guard()
    const result = await file.read(
      destination,
      offset + copied,
      Math.min(chunkBytes, bytes - copied),
      position + copied,
    )
    if (result.bytesRead < 1) throw new Error('Short independent JPEG sample-file read.')
    copied += result.bytesRead
  }
  guard()
}
async function hashHandle(file: FileHandle, bytes: number, guard: () => void): Promise<string> {
  const hash = createHash('sha256'),
    scratch = Buffer.allocUnsafe(Math.min(chunkBytes, bytes))
  for (let position = 0; position < bytes; position += scratch.length) {
    const count = Math.min(scratch.length, bytes - position)
    await readExact(file, scratch, 0, count, position, guard)
    hash.update(scratch.subarray(0, count))
  }
  return hash.digest('hex')
}
async function hashFile(
  path: string,
  guard: () => void,
  maximumBytes = 256 * 1024 ** 2,
  expectedBytes?: number,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await file.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      (expectedBytes !== undefined && before.size !== BigInt(expectedBytes))
    )
      throw new Error('Independent JPEG tool/input file has invalid dimensions.')
    const result = await hashHandle(file, Number(before.size), guard),
      after = await file.stat({ bigint: true })
    if (identity(before) !== identity(after))
      throw new Error('Independent JPEG tool/input changed while hashing.')
    return result
  } finally {
    await file.close()
  }
}
function identity(info: {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

/** Private files contain independent samples only; reconstruction remains in TypeScript. */
export async function openFullsizeJpegReference(
  jpeg: Uint8Array,
  mode: Mode,
  options: {
    prerequisite?: JpegReferencePrerequisite
    parentDirectory?: string
    signal?: AbortSignal
  } = {},
): Promise<FullsizeJpegReference> {
  const signal = options.signal,
    guard = () => signal?.throwIfAborted()
  guard()
  if (
    !(jpeg instanceof Uint8Array) ||
    jpeg.byteLength < 1 ||
    jpeg.byteLength > FULLSIZE_JPEG_MAX_INPUT_BYTES ||
    !['base-ycbcr', 'gain-rgb'].includes(mode)
  )
    throw new Error('Independent full-size JPEG input exceeds its declared 128 MiB bound or mode.')
  const prerequisite = options.prerequisite ?? jpegReferencePrerequisite()
  if (!prerequisite.available) throw new Error(prerequisite.reason)
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Error('Independent full-size JPEG reference requires Linux/macOS process groups.')
  if (
    prerequisite.version !== JPEG_REFERENCE_VERSION ||
    prerequisite.source !==
      `https://github.com/libjpeg-turbo/libjpeg-turbo/tree/${JPEG_REFERENCE_VERSION}`
  )
    throw new Error('Independent full-size JPEG toolchain version differs.')
  const snapshot = Buffer.from(jpeg),
    inputSha256 = sha(snapshot),
    readerSha256 = sha(await readFile(readerPath)),
    probe = headerObject(
      await runHeader(
        prerequisite.python,
        [
          '-I',
          '-c',
          'import hashlib,json,pathlib,sys; p=pathlib.Path(sys.executable).resolve(strict=True); print(json.dumps({"version":sys.version.split()[0],"executable":str(p),"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}))',
        ],
        signal,
      ),
    )
  if (
    Object.keys(probe).sort().join(',') !== 'executable,sha256,version' ||
    typeof probe.version !== 'string' ||
    prerequisite.pythonVersion !== `Python ${probe.version}` ||
    typeof probe.executable !== 'string' ||
    typeof probe.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(probe.sha256)
  )
    throw new Error('Independent full-size JPEG Python identity differs.')
  const python = probe as unknown as PythonIdentity
  if (
    (await realpath(python.executable)) !== python.executable ||
    (await hashFile(python.executable, guard)) !== python.sha256 ||
    (await hashFile(prerequisite.libraryPath, guard)) !== prerequisite.librarySha256
  )
    throw new Error('Independent full-size JPEG executable/library hashes differ.')
  let directory: string | undefined,
    samples: FileHandle | undefined,
    closing = false,
    closed: Promise<void> | undefined,
    tail: Promise<unknown> = Promise.resolve(),
    abortListener: (() => void) | undefined
  const close = () => {
    if (!closed) {
      closing = true
      closed = (async () => {
        await tail
        if (abortListener) signal?.removeEventListener('abort', abortListener)
        let failure: unknown
        try {
          await samples?.close()
        } catch (error) {
          failure = error
        }
        try {
          if (directory) await rm(directory, { recursive: true, force: true })
        } catch (error) {
          failure = failure
            ? new AggregateError([failure, error], 'Independent JPEG cleanup failed.')
            : error
        }
        if (failure) throw failure
      })()
    }
    return closed
  }
  try {
    guard()
    const parent = resolve(options.parentDirectory ?? tmpdir())
    await mkdir(parent, { recursive: true })
    directory = await mkdtemp(join(parent, 'irodori-jpeg-reference-'))
    await chmod(directory, 0o700)
    const inputPath = join(directory, 'input.jpg'),
      samplePath = join(directory, 'samples.bin')
    await writeFile(inputPath, snapshot, { flag: 'wx', mode: 0o600, flush: true, signal })
    await chmod(inputPath, 0o600)
    guard()
    const value = headerObject(
      await runHeader(
        prerequisite.python,
        [
          '-I',
          readerPath,
          prerequisite.libraryPath,
          mode,
          '--file-transport-v1',
          inputPath,
          directory,
        ],
        signal,
      ),
    )
    const fields = [
      'protocol',
      'transport',
      'mode',
      'width',
      'height',
      'bytes',
      'sampling',
      'jpegColorSpace',
      'layout',
      'pythonVersion',
      'pythonExecutable',
      'pythonSha256',
      'libraryPath',
      'librarySha256',
      'readerSha256',
      'inputBytes',
      'inputSha256',
      'samplesFile',
      'samplesSha256',
      'idct',
    ]
    if (
      Object.keys(value).sort().join(',') !== fields.sort().join(',') ||
      value.protocol !== 'irodori-jpeg-reference-file-v1' ||
      value.transport !== 'private-binary-file' ||
      value.mode !== mode ||
      !Number.isSafeInteger(value.width) ||
      !Number.isSafeInteger(value.height) ||
      (value.width as number) < 1 ||
      (value.height as number) < 1 ||
      (value.width as number) > FULLSIZE_JPEG_MAX_SIDE ||
      (value.height as number) > FULLSIZE_JPEG_MAX_SIDE ||
      (value.width as number) * (value.height as number) > FULLSIZE_JPEG_MAX_PIXELS ||
      value.bytes !== (value.width as number) * (value.height as number) * 3 ||
      value.sampling !== '4:4:4' ||
      value.jpegColorSpace !== 'YCbCr' ||
      value.layout !== (mode === 'base-ycbcr' ? 'planar-y-cb-cr' : 'interleaved-rgb8') ||
      value.pythonVersion !== python.version ||
      value.pythonExecutable !== python.executable ||
      value.pythonSha256 !== python.sha256 ||
      value.libraryPath !== prerequisite.libraryPath ||
      value.librarySha256 !== prerequisite.librarySha256 ||
      value.readerSha256 !== readerSha256 ||
      value.inputBytes !== snapshot.length ||
      value.inputSha256 !== inputSha256 ||
      value.samplesFile !== 'samples.bin' ||
      typeof value.samplesSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.samplesSha256) ||
      value.idct !== 'accurate-integer-jdct-islow'
    )
      throw new Error(
        'Invalid independent full-size JPEG dimensions, layout, hashes or toolchain header.',
      )
    const header = value as unknown as Header,
      pathInfo = await lstat(samplePath, { bigint: true })
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || (pathInfo.mode & 0o077n) !== 0n)
      throw new Error('Independent JPEG samples are not a private regular file.')
    samples = await open(samplePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const file = samples,
      stamp = identity(await file.stat({ bigint: true }))
    const verify = async () => {
      const [actual, path] = await Promise.all([
        file.stat({ bigint: true }),
        lstat(samplePath, { bigint: true }),
      ])
      if (
        !actual.isFile() ||
        !path.isFile() ||
        path.isSymbolicLink() ||
        Number(actual.size) !== header.bytes ||
        identity(actual) !== stamp ||
        identity(path) !== stamp
      )
        throw new Error('Independent JPEG sample file identity or exact size changed.')
    }
    await verify()
    if ((await hashHandle(file, header.bytes, guard)) !== header.samplesSha256)
      throw new Error('Independent JPEG sample file hash differs.')
    await verify()
    if (
      (await hashFile(inputPath, guard, FULLSIZE_JPEG_MAX_INPUT_BYTES, snapshot.length)) !==
        inputSha256 ||
      sha(await readFile(readerPath)) !== readerSha256 ||
      (await hashFile(prerequisite.libraryPath, guard)) !== prerequisite.librarySha256 ||
      (await hashFile(python.executable, guard)) !== python.sha256
    )
      throw new Error('Independent JPEG input or toolchain changed during decoding.')
    guard()
    const provenance = Object.freeze({
      version: prerequisite.version,
      source: prerequisite.source,
      pythonVersion: header.pythonVersion,
      pythonExecutable: header.pythonExecutable,
      pythonSha256: header.pythonSha256,
      libraryPath: header.libraryPath,
      librarySha256: header.librarySha256,
      readerSha256: header.readerSha256,
      sampling: header.sampling,
      jpegColorSpace: header.jpegColorSpace,
      layout: header.layout,
      idct: header.idct,
    })
    const maxRowsPerRead = Math.min(
      FULLSIZE_JPEG_MAX_STRIPE_ROWS,
      Math.floor(FULLSIZE_JPEG_MAX_STRIPE_BYTES / (header.width * 3)),
    )
    const active = () => {
      guard()
      if (closing) throw new Error('Independent full-size JPEG reference is closed.')
    }
    abortListener = () => void close().catch(() => {})
    signal?.addEventListener('abort', abortListener, { once: true })
    guard()
    return Object.freeze({
      width: header.width,
      height: header.height,
      mode,
      inputSha256,
      samplesSha256: header.samplesSha256,
      privateDirectory: directory,
      maxRowsPerRead,
      provenance,
      async readRows(top: number, count: number) {
        const work = tail.then(async () => {
          active()
          if (
            !Number.isSafeInteger(top) ||
            !Number.isSafeInteger(count) ||
            top < 0 ||
            count < 1 ||
            count > maxRowsPerRead ||
            top + count > header.height
          )
            throw new Error('Independent JPEG stripe exceeds its declared row or byte bounds.')
          await verify()
          const planeBytes = header.width * count,
            pixels = Buffer.allocUnsafe(planeBytes * 3)
          if (mode === 'base-ycbcr')
            for (let plane = 0; plane < 3; plane++)
              await readExact(
                file,
                pixels,
                plane * planeBytes,
                planeBytes,
                plane * header.width * header.height + top * header.width,
                active,
              )
          else await readExact(file, pixels, 0, pixels.length, top * header.width * 3, active)
          await verify()
          active()
          return { top, mode, width: header.width, height: count, pixels, provenance }
        })
        tail = work.catch(() => {})
        try {
          return await work
        } catch (error) {
          try {
            await close()
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              'Independent JPEG read and cleanup failed.',
              {
                cause: cleanup,
              },
            )
          }
          throw error
        }
      },
      close,
    })
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Independent JPEG open and cleanup failed.', {
        cause: cleanup,
      })
    }
    throw error
  }
}
