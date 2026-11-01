import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import sharp from 'sharp'
import { verifyUltraHdrBundle } from '../src/main/export/codec'
import { acceptanceHash } from './professional-editing-acceptance.helpers'
import { fromHalf, readGainJpeg, reconstruct } from './export-reference'
import { referenceBase2020 } from './jpeg-ycbcr-model.helpers'
import {
  openFullsizeJpegReference,
  type FullsizeJpegReference,
} from './jpeg-ycbcr-fullsize-reference.helpers'
import type { JpegReferencePrerequisite } from './jpeg-ycbcr-reference.helpers'

const decoderPath = fileURLToPath(new URL('./hdr-fullsize-decoder.mjs', import.meta.url))
const rgbWriterPath = fileURLToPath(new URL('./jpeg-fullsize-rgb8-writer.mjs', import.meta.url))
const nodeRequire = createRequire(import.meta.url)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function runFileChild(scriptPath: string, args: string[], signal?: AbortSignal) {
  signal?.throwIfAborted()
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let failure: unknown,
    diagnostics = ''
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )
  child.on('error', (error) => {
    failure ??= error
  })
  const stop = (error: unknown) => {
    failure ??= error
    child.kill('SIGKILL')
  }
  const abort = () => stop(signal?.reason ?? new Error('Full-size file inspection aborted.'))
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop(new Error('Full-size file child timed out.')), 180000)
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString()
    if (Buffer.byteLength(diagnostics) > 16384) {
      diagnostics = diagnostics.slice(0, 16384)
      stop(new Error('Full-size file child diagnostics exceeded 16 KiB.'))
    }
  })
  try {
    if (signal?.aborted) abort()
    const result = await closed
    if (failure !== undefined) throw failure
    if (result.code !== 0)
      throw new Error(
        `Full-size file child failed (${result.code ?? result.signal}): ${diagnostics}`,
      )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** Test-only existing decoder entry; waits for child closure on success and failure. */
export function decodeFullsizeHdrFile(options: {
  bundle: string
  inputPath: string
  outputPath: string
  manifestPath: string
  headroom: number
  signal?: AbortSignal
}) {
  return runFileChild(
    decoderPath,
    [
      options.bundle,
      options.inputPath,
      options.outputPath,
      options.manifestPath,
      String(options.headroom),
    ],
    options.signal,
  )
}

interface Rgb8ToolIdentity {
  nodeExecutable: string
  nodeExecutableSha256: string
  sharpVersion: string
  sharpVersions: typeof sharp.versions
  sharpEntrypoint: string
  sharpEntrypointSha256: string
  sharpNativeAddon: string
  sharpNativeAddonSha256: string
}

async function rgb8ToolIdentity(nodeExecutableSha256?: string): Promise<Rgb8ToolIdentity> {
  const nativePaths = Object.keys(nodeRequire.cache).filter((path) => {
    const name = basename(path)
    return name.endsWith('.node') && (name === 'sharp.node' || name.startsWith('sharp-'))
  })
  if (nativePaths.length !== 1) throw new Error('Cannot identify the one loaded Sharp addon.')
  const sharpEntrypoint = fileURLToPath(import.meta.resolve('sharp')),
    sharpNativeAddon = nativePaths[0]
  return {
    nodeExecutable: process.execPath,
    nodeExecutableSha256: nodeExecutableSha256 ?? (await acceptanceHash(process.execPath)),
    sharpVersion: sharp.versions.sharp,
    sharpVersions: sharp.versions,
    sharpEntrypoint,
    sharpEntrypointSha256: await acceptanceHash(sharpEntrypoint),
    sharpNativeAddon,
    sharpNativeAddonSha256: await acceptanceHash(sharpNativeAddon),
  }
}

interface Rgb8File {
  protocol: string
  mode: 'color' | 'gain'
  width: number
  height: number
  channels: number
  layout: string
  bytes: number
  sha256: string
  inputBytes: number
  inputSha256: string
  inputAfterSha256: string
  maximumPlaneBytes: number
  maximumRowsPerWrite: number
  largestWriteBytes: number
  tool: Rgb8ToolIdentity
  entrypointAfterSha256: string
  nativeAddonAfterSha256: string
}

/** Decode one RGB8 plane outside the parent; strict private-file transport only. */
export async function writeFullsizeRgb8File(options: {
  inputPath: string
  outputPath: string
  manifestPath: string
  mode: 'color' | 'gain'
  width: number
  height: number
  signal?: AbortSignal
  expectedTool?: Rgb8ToolIdentity
}): Promise<Rgb8File> {
  const inputBytes = (await stat(options.inputPath)).size
  if (inputBytes < 1 || inputBytes > 128 * 1024 ** 2)
    throw new Error('RGB8 file transport input exceeds its 128 MiB bound.')
  const inputSha256 = await acceptanceHash(options.inputPath),
    expectedTool = options.expectedTool ?? (await rgb8ToolIdentity())
  await runFileChild(
    rgbWriterPath,
    [
      options.inputPath,
      options.outputPath,
      options.manifestPath,
      options.mode,
      String(options.width),
      String(options.height),
    ],
    options.signal,
  )
  expect((await stat(options.manifestPath)).size).toBeLessThanOrEqual(16384)
  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as Rgb8File
  expect(manifest).toMatchObject({
    protocol: 'irodori-test-rgb8-file-v1',
    mode: options.mode,
    width: options.width,
    height: options.height,
    channels: 3,
    layout: 'interleaved-rgb8',
    bytes: options.width * options.height * 3,
    inputBytes,
    inputSha256,
    inputAfterSha256: inputSha256,
    maximumPlaneBytes: 33_554_432 * 3,
    maximumRowsPerWrite: 64,
    tool: expectedTool,
    entrypointAfterSha256: expectedTool.sharpEntrypointSha256,
    nativeAddonAfterSha256: expectedTool.sharpNativeAddonSha256,
  })
  expect(manifest.largestWriteBytes).toBeLessThanOrEqual(16 * 1024 ** 2)
  expect((await stat(options.outputPath)).size).toBe(manifest.bytes)
  expect(await acceptanceHash(options.outputPath)).toBe(manifest.sha256)
  expect(await acceptanceHash(options.inputPath)).toBe(inputSha256)
  return manifest
}

interface DecodedFile {
  protocol: string
  width: number
  height: number
  stride: number
  gamut: number
  headroom: number
  info: number[]
  bytes: number
  sha256: string
  inputBytes: number
  inputSha256: string
  heapBytes: number
  maximumRowsPerWrite: number
  largestWriteBytes: number
  node: string
  nodeExecutable: string
  nodeExecutableSha256: string
  moduleSha256: string
  wasmSha256: string
  moduleAfterSha256: string
  wasmAfterSha256: string
  bundleManifestSha256: string
  bundleManifestAfterSha256: string
  layout: string
}

interface ComponentObservation {
  x: number
  y: number
  channel: number
  expected: number | string
  actual: number | string
  error: number | string
}

/** Complete raw-YCbCr/Float64 ISO comparison; no parent full-frame HDR copy. */
export async function inspectFullsizeHdrJpeg(
  path: string,
  width: number,
  height: number,
  options: {
    parentDirectory: string
    prerequisite: JpegReferencePrerequisite
    signal?: AbortSignal
  },
) {
  await mkdir(options.parentDirectory, { recursive: true })
  const privateDirectory = await mkdtemp(join(options.parentDirectory, 'hdr-oracle-'))
  const report: {
    status: 'running' | 'passed' | 'failed'
    input?: unknown
    ordinaryPrimary?: unknown
    oracle?: unknown
    comparisons: unknown[]
    error?: string
    cleanup?: unknown
  } = { status: 'running', comparisons: [] }
  let base: FullsizeJpegReference | undefined,
    gain: FullsizeJpegReference | undefined,
    primaryFailure: unknown,
    cleanupFailure: unknown,
    result:
      | {
          sha256: string
          hdr: true
          width: number
          height: number
          channelComparisons: number
          report: typeof report
        }
      | undefined
  const save = () =>
    writeFile(
      join(options.parentDirectory, 'fullsize-hdr-inspection.json'),
      JSON.stringify(report, null, 2) + '\n',
    )
  try {
    options.signal?.throwIfAborted()
    const size = (await stat(path)).size
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThanOrEqual(128 * 1024 ** 2)
    const bytes = await readFile(path),
      inputSha256 = sha(bytes),
      metadata = await sharp(bytes).metadata(),
      parsed = readGainJpeg(bytes),
      inputPath = join(privateDirectory, 'input.jpg'),
      bundle = await verifyUltraHdrBundle()
    const decoderIdentity = {
      nodeExecutable: process.execPath,
      nodeExecutableSha256: await acceptanceHash(process.execPath),
      moduleSha256: await acceptanceHash(join(bundle, 'irodori-ultrahdr.mjs')),
      wasmSha256: await acceptanceHash(join(bundle, 'irodori-ultrahdr.wasm')),
      bundleManifestSha256: await acceptanceHash(join(bundle, 'SHA256SUMS')),
    }
    const rgbWriterIdentity = await rgb8ToolIdentity(decoderIdentity.nodeExecutableSha256)
    expect(bytes.length).toBe(size)
    expect(metadata).toMatchObject({
      format: 'jpeg',
      width,
      height,
      isProgressive: false,
    })
    // The HDR container reader omits this field; inspect the packaged JPEG itself.
    expect(await sharp(parsed.primary).metadata()).toMatchObject({
      format: 'jpeg',
      width,
      height,
      chromaSubsampling: '4:4:4',
      isProgressive: false,
    })
    expect(metadata.icc).toBeDefined()
    expect(parsed.metadata.useBase).toBe(false)
    expect(parsed.metadata.baseHeadroom).toBe(0)
    expect(parsed.metadata.alternateHeadroom).toBeGreaterThan(0)
    const fullHeadroom = Math.max(1.01, 2 ** parsed.metadata.alternateHeadroom)
    expect(fullHeadroom).toBeLessThanOrEqual(10.0001)
    await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600 })
    report.input = {
      path,
      bytes: size,
      sha256: inputSha256,
      width,
      height,
      primaryJpegSha256: sha(parsed.primary),
      gainJpegSha256: sha(parsed.gain),
      metadata: parsed.metadata,
      decoderScriptSha256: await acceptanceHash(decoderPath),
      decoderIdentity,
      rgbWriterScriptSha256: await acceptanceHash(rgbWriterPath),
      rgbWriterIdentity,
    }
    await save()

    // Ordinary RGB8 is checked only for primary compatibility, never as the HDR oracle base.
    const ordinaryPath = join(privateDirectory, 'ordinary.rgb8'),
      primaryPath = join(privateDirectory, 'primary.rgb8'),
      primaryJpegPath = join(privateDirectory, 'primary.jpg'),
      ordinaryManifestPath = join(privateDirectory, 'ordinary-rgb8.json'),
      primaryManifestPath = join(privateDirectory, 'primary-rgb8.json')
    await writeFile(primaryJpegPath, parsed.primary, { flag: 'wx', mode: 0o600 })
    const ordinaryWriter = await writeFullsizeRgb8File({
        inputPath,
        outputPath: ordinaryPath,
        manifestPath: ordinaryManifestPath,
        mode: 'color',
        width,
        height,
        signal: options.signal,
        expectedTool: rgbWriterIdentity,
      }),
      primaryWriter = await writeFullsizeRgb8File({
        inputPath: primaryJpegPath,
        outputPath: primaryPath,
        manifestPath: primaryManifestPath,
        mode: 'color',
        width,
        height,
        signal: options.signal,
        expectedTool: rgbWriterIdentity,
      })
    expect((await stat(ordinaryPath)).size).toBe(width * height * 3)
    expect((await stat(primaryPath)).size).toBe(width * height * 3)
    const ordinarySha256 = await acceptanceHash(ordinaryPath),
      primarySha256 = await acceptanceHash(primaryPath)
    expect(ordinarySha256).toBe(primarySha256)
    report.ordinaryPrimary = {
      bytes: width * height * 3,
      ordinarySha256,
      primarySha256,
      ordinaryWriter,
      primaryWriter,
    }
    await rm(ordinaryPath)
    await rm(primaryPath)
    await rm(primaryJpegPath)
    await rm(ordinaryManifestPath)
    await rm(primaryManifestPath)
    base = await openFullsizeJpegReference(parsed.primary, 'base-ycbcr', {
      prerequisite: options.prerequisite,
      parentDirectory: privateDirectory,
      signal: options.signal,
    })
    gain = await openFullsizeJpegReference(parsed.gain, 'gain-rgb', {
      prerequisite: options.prerequisite,
      parentDirectory: privateDirectory,
      signal: options.signal,
    })
    expect(base.provenance.sampling).toBe('4:4:4')
    expect(gain.provenance.sampling).toBe('4:4:4')
    expect([base.width, base.height, gain.width, gain.height]).toEqual([
      width,
      height,
      width,
      height,
    ])
    expect(base.inputSha256).toBe(sha(parsed.primary))
    expect(gain.inputSha256).toBe(sha(parsed.gain))
    const gainRgbPath = join(privateDirectory, 'gain.rgb8'),
      gainJpegPath = join(privateDirectory, 'gain.jpg'),
      gainManifestPath = join(privateDirectory, 'gain-rgb8.json')
    await writeFile(gainJpegPath, parsed.gain, { flag: 'wx', mode: 0o600 })
    const gainWriter = await writeFullsizeRgb8File({
      inputPath: gainJpegPath,
      outputPath: gainRgbPath,
      manifestPath: gainManifestPath,
      mode: 'gain',
      width,
      height,
      signal: options.signal,
      expectedTool: rgbWriterIdentity,
    })
    expect((await stat(gainRgbPath)).size).toBe(width * height * 3)
    expect(await acceptanceHash(gainRgbPath)).toBe(gain.samplesSha256)
    await rm(gainRgbPath)
    await rm(gainJpegPath)
    await rm(gainManifestPath)
    report.oracle = {
      policy: 'raw-ycbcr-base-rgb8-gain-v1-fullsize-file-transport',
      base: {
        inputSha256: base.inputSha256,
        samplesSha256: base.samplesSha256,
        provenance: base.provenance,
      },
      gain: {
        inputSha256: gain.inputSha256,
        samplesSha256: gain.samplesSha256,
        provenance: gain.provenance,
        rgb8CrossCheck: gainWriter,
      },
      absoluteBoundExclusive: 0.02,
      declaredHeadrooms: [1, fullHeadroom],
    }
    await save()
    const rowsPerRead = Math.min(64, base.maxRowsPerRead, gain.maxRowsPerRead)
    expect(rowsPerRead).toBeGreaterThan(0)
    let totalComparisons = 0
    for (const [ordinal, headroom] of [1, fullHeadroom].entries()) {
      options.signal?.throwIfAborted()
      const decodedPath = join(privateDirectory, `decoded-${ordinal}.rgba16`),
        manifestPath = join(privateDirectory, `decoded-${ordinal}.json`)
      // Wait for this exact child's close even after abort/error before removing owned files.
      await decodeFullsizeHdrFile({
        bundle,
        inputPath,
        outputPath: decodedPath,
        manifestPath,
        headroom,
        signal: options.signal,
      })
      expect((await stat(manifestPath)).size).toBeLessThanOrEqual(16384)
      const decoded = JSON.parse(await readFile(manifestPath, 'utf8')) as DecodedFile
      expect(decoded).toMatchObject({
        protocol: 'irodori-test-hdr-rgba16-file-v1',
        width,
        height,
        gamut: 2,
        headroom,
        inputBytes: size,
        inputSha256,
        maximumRowsPerWrite: 64,
        layout: 'little-endian-binary16-interleaved-rgba-with-stride',
        ...decoderIdentity,
        moduleAfterSha256: decoderIdentity.moduleSha256,
        wasmAfterSha256: decoderIdentity.wasmSha256,
        bundleManifestAfterSha256: decoderIdentity.bundleManifestSha256,
      })
      expect(Number.isSafeInteger(decoded.stride)).toBe(true)
      expect(decoded.stride).toBeGreaterThanOrEqual(width)
      expect(decoded.bytes).toBe(decoded.stride * height * 8)
      expect(decoded.bytes).toBeLessThanOrEqual(512 * 1024 ** 2)
      expect(decoded.heapBytes).toBeLessThanOrEqual(2 * 1024 ** 3)
      expect(decoded.largestWriteBytes).toBeLessThanOrEqual(16 * 1024 ** 2)
      expect((await stat(decodedPath)).size).toBe(decoded.bytes)
      expect(await acceptanceHash(decodedPath)).toBe(decoded.sha256)
      for (const digest of [
        decoded.sha256,
        decoded.nodeExecutableSha256,
        decoded.moduleSha256,
        decoded.wasmSha256,
      ])
        expect(digest).toMatch(/^[a-f0-9]{64}$/)
      const file = await open(decodedPath, 'r')
      let comparisons = 0,
        nonfiniteActual = 0,
        nonfiniteExpected = 0,
        nonopaquePixels = 0,
        maximumError = 0,
        largestReadBytes = 0
      let worst: ComponentObservation | undefined
      try {
        for (let top = 0; top < height; top += rowsPerRead) {
          options.signal?.throwIfAborted()
          const count = Math.min(rowsPerRead, height - top),
            baseRows = await base.readRows(top, count),
            gainRows = await gain.readRows(top, count),
            actualBytes = count * decoded.stride * 8
          expect(actualBytes).toBeLessThanOrEqual(16 * 1024 ** 2)
          const actual = Buffer.alloc(actualBytes)
          let read = 0
          while (read < actual.length) {
            const result = await file.read(
              actual,
              read,
              actual.length - read,
              top * decoded.stride * 8 + read,
            )
            if (!result.bytesRead) throw new Error('Incomplete full-size decoded HDR stripe.')
            read += result.bytesRead
          }
          largestReadBytes = Math.max(largestReadBytes, read)
          for (let y = 0; y < count; y++)
            for (let x = 0; x < width; x++) {
              const gainOffset = (y * width + x) * 3,
                actualOffset = (y * decoded.stride + x) * 8,
                reference = reconstruct(
                  referenceBase2020(baseRows, x, y),
                  [0, 1, 2].map((channel) => gainRows.pixels[gainOffset + channel] / 255),
                  parsed.metadata,
                  headroom,
                )
              if (actual.readUInt16LE(actualOffset + 6) !== 0x3c00) nonopaquePixels++
              for (let channel = 0; channel < 3; channel++) {
                const word = actual.readUInt16LE(actualOffset + channel * 2),
                  finiteWord = (word & 0x7c00) !== 0x7c00,
                  value = finiteWord ? fromHalf(word) : NaN,
                  expected = reference[channel],
                  finiteExpected = Number.isFinite(expected),
                  error = finiteWord && finiteExpected ? Math.abs(value - expected) : Infinity
                comparisons++
                if (!finiteWord) nonfiniteActual++
                if (!finiteExpected) nonfiniteExpected++
                if (error > maximumError || worst === undefined) {
                  maximumError = error
                  worst = {
                    x,
                    y: top + y,
                    channel,
                    actual: finiteWord ? value : `nonfinite-binary16-${word.toString(16)}`,
                    expected: finiteExpected ? expected : String(expected),
                    error: Number.isFinite(error) ? error : String(error),
                  }
                }
              }
            }
        }
      } finally {
        await file.close()
      }
      const comparison = {
        headroom,
        decoder: decoded,
        comparisons,
        nonfiniteActual,
        nonfiniteExpected,
        nonopaquePixels,
        maximumError: Number.isFinite(maximumError) ? maximumError : String(maximumError),
        worst,
        largestReadBytes,
      }
      report.comparisons.push(comparison)
      await save()
      expect(comparisons).toBe(width * height * 3)
      expect(nonfiniteActual).toBe(0)
      expect(nonfiniteExpected).toBe(0)
      expect(nonopaquePixels).toBe(0)
      expect(maximumError, JSON.stringify(comparison)).toBeLessThan(0.02)
      totalComparisons += comparisons
      await rm(decodedPath)
      await rm(manifestPath)
    }
    expect(totalComparisons).toBe(width * height * 3 * 2)
    expect(await acceptanceHash(path)).toBe(inputSha256)
    report.status = 'passed'
    result = {
      sha256: inputSha256,
      hdr: true,
      width,
      height,
      channelComparisons: totalComparisons,
      report,
    }
  } catch (error) {
    primaryFailure = error
    report.status = 'failed'
    report.error = String(error)
    throw error
  } finally {
    const failures: string[] = []
    for (const reference of [base, gain])
      try {
        await reference?.close()
      } catch (error) {
        failures.push(String(error))
        cleanupFailure ??= error
      }
    try {
      await rm(privateDirectory, { recursive: true, force: true })
    } catch (error) {
      failures.push(String(error))
      cleanupFailure ??= error
    }
    report.cleanup = { privateDirectory, failures }
    if (primaryFailure === undefined && cleanupFailure !== undefined) report.status = 'failed'
    try {
      await save()
    } catch (error) {
      if (primaryFailure === undefined) cleanupFailure ??= error
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
  if (!result) throw new Error('Full-size HDR inspection did not produce a result.')
  return result
}
