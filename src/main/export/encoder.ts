import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadUltraHdr, verifyUltraHdrBundle } from './codec'
import {
  exportHdrEncodePlan,
  requireExportAllocation,
  ExportResourceError,
  type ExportAdmission,
} from '../../shared/export-resources'

const execute = promisify(execFile)

function validateEncoderMode(mode: string) {
  if (!['auto', 'native', 'wasm'].includes(mode)) throw new Error('Invalid export encoder backend.')
}

const nativeRequired = (mode: string) =>
  mode === 'native' || (mode === 'auto' && process.platform === 'linux' && process.arch === 'x64')

export async function nativeEncoderPath(directory?: string): Promise<string | undefined> {
  const target =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'darwin-arm64'
      : process.platform === 'linux' && process.arch === 'x64'
        ? 'linux-x64'
        : undefined
  if (!target) return undefined
  directory ??= await verifyUltraHdrBundle()
  directory = directory.replace('app.asar/', 'app.asar.unpacked/')
  const root = join(directory, 'native', target),
    path = join(root, 'irodori-ultrahdr')
  if (!existsSync(root)) return undefined
  const manifest = (await readFile(join(root, 'SHA256SUMS'), 'utf8')).trim()
  const match = /^([a-f0-9]{64}) {2}irodori-ultrahdr$/.exec(manifest)
  if (
    !match ||
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex') !== match[1]
  )
    throw new Error('Bundled native Ultra HDR checksum mismatch.')
  await access(path, constants.X_OK)
  return path
}

/** Main-process availability and acceptance use the same selected-backend contract. */
export async function verifyExportEncoder(
  directory?: string,
  mode = process.env.IRODORI_EXPORT_ENCODER ?? 'auto',
): Promise<void> {
  validateEncoderMode(mode)
  const bundle = await verifyUltraHdrBundle(directory?.replace('app.asar/', 'app.asar.unpacked/'))
  if (mode === 'wasm') return
  try {
    if (await nativeEncoderPath(bundle)) return
    if (nativeRequired(mode))
      throw new Error('No bundled native HDR encoder is available on this platform.')
  } catch (error) {
    if (nativeRequired(mode)) throw error
    // Other platforms retain their existing validated WASM recovery policy.
  }
}

export async function encodeExportHdr(
  half: Uint16Array,
  width: number,
  height: number,
  sdr: Buffer,
  quality: number,
  headroom: number,
  directory: string,
  mode = process.env.IRODORI_EXPORT_ENCODER ?? 'auto',
  bundle?: string,
  admission?: ExportAdmission,
) {
  if (process.versions.electron) throw new Error('HDR export requires the isolated Node worker.')
  validateEncoderMode(mode)
  bundle = bundle?.replace('app.asar/', 'app.asar.unpacked/')
  let fallback: string | undefined
  let primaryWritten = false
  if (mode !== 'wasm') {
    try {
      const executable = await nativeEncoderPath(bundle)
      if (!executable)
        throw new Error('No bundled native HDR encoder is available on this platform.')
      const plan = admission
        ? exportHdrEncodePlan(width, height, sdr.byteLength, 'native', admission)
        : undefined
      if (plan) requireExportAllocation(plan)
      const pixels = width * height
      if (
        !Number.isSafeInteger(pixels) ||
        pixels < 1 ||
        width < 1 ||
        height < 1 ||
        width > 32768 ||
        height > 32768 ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        pixels * 16 > 512 * 1024 ** 2 ||
        half.byteLength !== pixels * 8 ||
        pixels * 56 + sdr.byteLength * 3 + 128 * 1024 ** 2 > 2 * 1024 ** 3 ||
        !Number.isInteger(quality) ||
        quality < 1 ||
        quality > 100 ||
        !Number.isFinite(headroom) ||
        headroom < 1 ||
        headroom > 10
      )
        throw new Error('HDR JPEG exceeds the supported encoder allocation limit.')
      const hdrPath = join(directory, 'encoder.rgba16'),
        sdrPath = join(directory, 'sdr.jpg'),
        outputPath = join(directory, 'encoder-output.jpg')
      await writeFile(hdrPath, Buffer.from(half.buffer, half.byteOffset, half.byteLength), {
        flag: 'wx',
      })
      await writeFile(sdrPath, sdr, { flag: 'wx' })
      primaryWritten = true
      const { stdout } = await execute(
        executable,
        [
          String(width),
          String(height),
          String(quality),
          String(headroom),
          hdrPath,
          sdrPath,
          outputPath,
        ],
        { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true },
      )
      const info = JSON.parse(stdout) as {
        width: number
        height: number
        peakBytes: number
        implementation?: string
      }
      if (
        info.width !== width ||
        info.height !== height ||
        !Number.isSafeInteger(info.peakBytes) ||
        info.peakBytes < 1 ||
        info.peakBytes > 2 * 1024 ** 3 ||
        (process.platform === 'linux' && info.implementation !== 'rust-ultrahdr-v1')
      )
        throw new Error('Invalid native HDR JPEG rendition geometry.')
      if (plan && (await stat(outputPath)).size > plan.outputLimitBytes)
        throw new ExportResourceError('The HDR JPEG exceeded its admitted output storage.')
      return {
        admission: plan,
        output: await readFile(outputPath),
        path: outputPath,
        primaryWritten,
        backend: 'native' as const,
        memory: { kind: 'process-rss' as const, peakBytes: info.peakBytes },
      }
    } catch (error) {
      if (nativeRequired(mode) || error instanceof ExportResourceError) throw error
      fallback = error instanceof Error ? error.message : String(error)
    }
  }
  const plan = admission
    ? exportHdrEncodePlan(width, height, sdr.byteLength, 'wasm', admission)
    : undefined
  if (plan) requireExportAllocation(plan)
  const codec = await loadUltraHdr(bundle)
  const output = codec.encode(
    new Uint8Array(half.buffer, half.byteOffset, half.byteLength),
    width,
    height,
    sdr,
    quality,
    headroom,
    plan?.outputLimitBytes,
  )
  const inspected = codec.inspect(output)
  if (
    inspected.info[18] !== width ||
    inspected.info[19] !== height ||
    inspected.info[20] !== width ||
    inspected.info[21] !== height
  )
    throw new Error('Invalid HDR JPEG rendition geometry.')
  return {
    admission: plan,
    output,
    path: undefined,
    primaryWritten,
    backend: 'wasm' as const,
    fallback,
    memory: { kind: 'wasm-heap' as const, peakBytes: codec.memory() },
  }
}
