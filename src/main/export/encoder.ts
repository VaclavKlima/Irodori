import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadUltraHdr, verifyUltraHdrBundle } from './codec'

const execute = promisify(execFile)

export async function nativeEncoderPath(directory?: string): Promise<string | undefined> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined
  directory ??= await verifyUltraHdrBundle()
  const root = join(directory, 'native', 'darwin-arm64'),
    path = join(root, 'luma-ultrahdr')
  if (!existsSync(root)) return undefined
  const manifest = (await readFile(join(root, 'SHA256SUMS'), 'utf8')).trim()
  const match = /^([a-f0-9]{64}) {2}luma-ultrahdr$/.exec(manifest)
  if (
    !match ||
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex') !== match[1]
  )
    throw new Error('Bundled native Ultra HDR checksum mismatch.')
  return path.replace('app.asar/', 'app.asar.unpacked/')
}

export async function encodeExportHdr(
  half: Uint16Array,
  width: number,
  height: number,
  sdr: Buffer,
  quality: number,
  headroom: number,
  directory: string,
  mode = process.env.LUMA_EXPORT_ENCODER ?? 'auto',
  bundle?: string,
) {
  if (process.versions.electron) throw new Error('HDR export requires the isolated Node worker.')
  if (!['auto', 'native', 'wasm'].includes(mode)) throw new Error('Invalid export encoder backend.')
  let fallback: string | undefined
  let primaryWritten = false
  if (mode !== 'wasm') {
    try {
      const executable = await nativeEncoderPath(bundle)
      if (!executable)
        throw new Error('No bundled native HDR encoder is available on this platform.')
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
      const info = JSON.parse(stdout) as { width: number; height: number; peakBytes: number }
      if (
        info.width !== width ||
        info.height !== height ||
        !Number.isSafeInteger(info.peakBytes) ||
        info.peakBytes < 1 ||
        info.peakBytes > 2 * 1024 ** 3
      )
        throw new Error('Invalid native HDR JPEG rendition geometry.')
      return {
        output: await readFile(outputPath),
        path: outputPath,
        primaryWritten,
        backend: 'native' as const,
        memory: { kind: 'process-rss' as const, peakBytes: info.peakBytes },
      }
    } catch (error) {
      if (mode === 'native') throw error
      fallback = error instanceof Error ? error.message : String(error)
    }
  }
  const codec = await loadUltraHdr(bundle)
  const output = codec.encode(
    new Uint8Array(half.buffer, half.byteOffset, half.byteLength),
    width,
    height,
    sdr,
    quality,
    headroom,
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
    output,
    path: undefined,
    primaryWritten,
    backend: 'wasm' as const,
    fallback,
    memory: { kind: 'wasm-heap' as const, peakBytes: codec.memory() },
  }
}
