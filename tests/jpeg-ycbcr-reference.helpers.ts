import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const JPEG_REFERENCE_VERSION = '3.2.0'
const readerPath = fileURLToPath(new URL('./jpeg-ycbcr-reference.py', import.meta.url))
const source = `https://github.com/libjpeg-turbo/libjpeg-turbo/tree/${JPEG_REFERENCE_VERSION}`

export type JpegReferencePrerequisite =
  | { available: false; reason: string }
  | {
      available: true
      python: string
      pythonVersion: string
      libraryPath: string
      librarySha256: string
      version: string
      source: string
    }

/** Required test toolchain: absence is incomplete acceptance, never a fallback oracle. */
export function jpegReferencePrerequisite(): JpegReferencePrerequisite {
  const python = process.env.IRODORI_TEST_JPEG_REFERENCE_PYTHON ?? 'python3'
  const command = (executable: string, args: string[]) =>
    spawnSync(executable, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 })
  const version = command('pkg-config', ['--modversion', 'libturbojpeg'])
  const versionText = version.stdout?.trim() ?? ''
  if (version.status !== 0 || versionText !== JPEG_REFERENCE_VERSION)
    return {
      available: false,
      reason: `Independent JPEG acceptance requires pkg-config libturbojpeg ${JPEG_REFERENCE_VERSION}; found ${versionText || version.error?.message || version.stderr?.trim() || 'no package'}. Install that pinned test prerequisite.`,
    }
  const directory = command('pkg-config', ['--variable=libdir', 'libturbojpeg'])
  const filename =
    process.platform === 'darwin'
      ? 'libturbojpeg.dylib'
      : process.platform === 'linux'
        ? 'libturbojpeg.so'
        : undefined
  if (directory.status !== 0 || !filename)
    return {
      available: false,
      reason:
        'Independent JPEG acceptance requires the declared Linux/macOS libturbojpeg shared-library toolchain; other platforms remain incomplete.',
    }
  const candidate = join(directory.stdout.trim(), filename)
  if (!existsSync(candidate))
    return {
      available: false,
      reason: `Independent JPEG acceptance cannot find the pinned shared library: ${candidate}`,
    }
  const pythonResult = command(python, ['--version'])
  const pythonVersion = `${pythonResult.stdout ?? ''}${pythonResult.stderr ?? ''}`.trim()
  if (pythonResult.status !== 0 || !/^Python 3\./.test(pythonVersion))
    return {
      available: false,
      reason: `Independent JPEG acceptance requires Python 3 ctypes; ${pythonResult.error?.message ?? pythonVersion}`,
    }
  const libraryPath = realpathSync(candidate)
  const symbols = command(python, [
    '-c',
    'import ctypes,sys; library=ctypes.CDLL(sys.argv[1]); [getattr(library,name) for name in ("tjInitDecompress","tjDestroy","tjGetErrorStr2","tjDecompressHeader3","tjBufSizeYUV2","tjDecompressToYUV2","tjDecompress2")]',
    libraryPath,
  ])
  if (symbols.status !== 0)
    return {
      available: false,
      reason: `Independent JPEG acceptance cannot load its pinned ctypes API: ${symbols.error?.message ?? symbols.stderr?.trim() ?? 'unavailable shared-library API'}`,
    }
  return {
    available: true,
    python,
    pythonVersion,
    libraryPath,
    librarySha256: createHash('sha256').update(readFileSync(libraryPath)).digest('hex'),
    version: JPEG_REFERENCE_VERSION,
    source,
  }
}

export interface JpegReferenceSamples {
  mode: 'base-ycbcr' | 'gain-rgb'
  width: number
  height: number
  pixels: Buffer
  provenance: {
    version: string
    source: string
    pythonVersion: string
    libraryPath: string
    librarySha256: string
    sampling: '4:4:4'
    jpegColorSpace: 'YCbCr'
    layout: 'planar-y-cb-cr' | 'interleaved-rgb8'
  }
}

/** Independent JPEG samples only; the transport performs no EOTF, gamut or gain math. */
export function readJpegReferenceSamples(
  jpeg: Buffer,
  mode: JpegReferenceSamples['mode'],
  prerequisite = jpegReferencePrerequisite(),
): JpegReferenceSamples {
  if (!prerequisite.available) throw new Error(prerequisite.reason)
  if (jpeg.length < 1 || jpeg.length > 16 * 1024 ** 2)
    throw new Error('Independent JPEG reference input exceeds its declared 16 MiB bound.')
  const result = spawnSync(prerequisite.python, [readerPath, prerequisite.libraryPath, mode], {
    input: jpeg,
    timeout: 30000,
    maxBuffer: 4 * 1024 ** 2,
  })
  if (result.status !== 0)
    throw new Error(
      `Independent JPEG reader failed: ${result.error?.message ?? result.stderr.toString().trim()}`,
    )
  const separator = result.stdout.indexOf(10)
  if (separator < 0 || separator > 16384) throw new Error('Invalid independent JPEG reader header.')
  const header = JSON.parse(result.stdout.subarray(0, separator).toString('utf8')) as {
    protocol: string
    mode: JpegReferenceSamples['mode']
    width: number
    height: number
    bytes: number
  } & JpegReferenceSamples['provenance']
  const pixels = result.stdout.subarray(separator + 1)
  if (
    header.protocol !== 'irodori-jpeg-reference-v1' ||
    header.mode !== mode ||
    !Number.isSafeInteger(header.width) ||
    !Number.isSafeInteger(header.height) ||
    header.width < 1 ||
    header.height < 1 ||
    header.width * header.height > 1024 ** 2 ||
    header.bytes !== header.width * header.height * 3 ||
    pixels.length !== header.bytes ||
    header.sampling !== '4:4:4' ||
    header.jpegColorSpace !== 'YCbCr' ||
    header.layout !== (mode === 'base-ycbcr' ? 'planar-y-cb-cr' : 'interleaved-rgb8') ||
    header.libraryPath !== prerequisite.libraryPath ||
    header.librarySha256 !== prerequisite.librarySha256
  )
    throw new Error('Invalid independent JPEG reader dimensions, layout or toolchain identity.')
  return {
    mode,
    width: header.width,
    height: header.height,
    pixels,
    provenance: {
      version: prerequisite.version,
      source: prerequisite.source,
      pythonVersion: header.pythonVersion,
      libraryPath: header.libraryPath,
      librarySha256: header.librarySha256,
      sampling: header.sampling,
      jpegColorSpace: header.jpegColorSpace,
      layout: header.layout,
    },
  }
}
