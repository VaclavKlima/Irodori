/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import { encodeExportHdr, nativeEncoderPath } from '../src/main/export/encoder'
import { loadUltraHdr, verifyUltraHdrBundle } from '../src/main/export/codec'
import { exportShader } from '../src/main/export/gpu'
import { jpegIdentity, validatePrimary } from '../src/main/export/jpeg'
import { prepareExportWorkingSource } from '../src/main/export/preparation'
import { exportRenditions } from '../src/main/export/renditions'
import type { ExportRenderJob } from '../src/main/export/types'
import { PreviewProcess } from '../src/main/preview-process'
import { neutralAdjustments } from '../src/shared/adjustments'
import { DISPLAY_RENDERING_VERSION } from '../src/shared/display-rendering'
import {
  defaultExportOptions,
  EXPORT_CODEC_VERSION,
  EXPORT_RENDERING_VERSION,
} from '../src/shared/export'
import { automaticLensSettings } from '../src/shared/lens'
import { fromHalf, readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (pixels: Uint16Array) =>
  Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
async function fileEvidence(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return { path, byteLength: (await stat(path)).size, sha256: hash.digest('hex') }
}

test('Linux full-size Sony native and WASM codecs reconstruct identical frozen input at all retained headrooms', async ({}, info) => {
  test.skip(process.platform !== 'linux' || process.arch !== 'x64', 'Linux x64 codec parity only.')
  test.setTimeout(600000)
  const bundle = resolve('out/main/ultrahdr')
  await verifyUltraHdrBundle(bundle)
  const executable = await nativeEncoderPath(bundle)
  test.skip(!executable, 'A checksummed Linux native codec candidate is required.')

  const directory = info.outputPath('fullsize-codec-parity')
  const nativeDirectory = join(directory, 'native')
  const wasmDirectory = join(directory, 'wasm')
  const renditionDirectory = join(directory, 'rendition')
  for (const path of [nativeDirectory, wasmDirectory, renditionDirectory])
    await mkdir(path, { recursive: true })
  const reportPath = join(directory, 'parity.json')
  const report: Record<string, unknown> = {
    status: 'running',
    phase: 'source',
    scope:
      'One original-size Sony source preparation and one GPU rendition; one explicit native and one explicit WASM encode consume identical binary16 HDR, SDR JPEG, quality and exact content headroom. No throughput or migration acceptance claim.',
    expectedGeometry: { width: 5422, height: 3622 },
    encoderCallsPlanned: { native: 1, wasm: 1 },
    decodeHeadrooms: [1, 2, 4],
    versions: {
      display: DISPLAY_RENDERING_VERSION,
      rendering: EXPORT_RENDERING_VERSION,
      codec: EXPORT_CODEC_VERSION,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      previewBackend: process.env.IRODORI_PREVIEW_BACKEND ?? 'auto',
    },
    memoryLimitations:
      'Native peak RSS and WASM linear-heap capacity retain their separate existing 2 GiB limits. Decoder copies and this test process are not a combined application-memory measurement.',
  }
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  await save()
  const decoder = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const abort = new AbortController()
  const originalPath = resolve('tests/fixtures/sony-zv1.ARW')
  const expectedSourceSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
  try {
    report.sources = await Promise.all(
      [
        originalPath,
        'tests/export-native-fullsize.spec.ts',
        'src/main/export/encoder.ts',
        'src/main/export/renditions.ts',
        'src/main/export/gpu.ts',
        'src/shared/aces-wgsl.ts',
        'src/shared/aces-precision-wgsl.ts',
        'src/shared/aces-data.ts',
        'package-lock.json',
        'out/main/preview-worker.js',
        join(bundle, 'SHA256SUMS'),
        join(bundle, 'irodori-ultrahdr.mjs'),
        join(bundle, 'irodori-ultrahdr.wasm'),
        executable!,
        join(dirname(executable!), 'SHA256SUMS'),
      ].map(fileEvidence),
    )
    const sourceIdentity = await fileEvidence(originalPath)
    expect(sourceIdentity.sha256).toBe(expectedSourceSha256)
    const metadata = await decoder.inspect(originalPath, abort.signal)
    expect(metadata.hdrEligible).toBe(true)
    const processing = {
      processing: 'hdr-v1' as const,
      metadata,
      settings: { ...automaticLensSettings },
      revision: 7,
      adjustments: {
        ...neutralAdjustments,
        exposureEv: 0.25,
        contrast: 10,
        highlights: -25,
        shadows: 20,
        whites: -15,
        blacks: 5,
        whiteBalance: { mode: 'custom' as const, kelvin: 5800, tint: 8 },
      },
    }
    const sourceStat = await stat(originalPath)
    const job: ExportRenderJob = {
      source: {
        photo: {
          id: expectedSourceSha256,
          filename: 'sony-zv1.ARW',
          format: 'ARW',
          width: 5496,
          height: 3672,
          bytes: sourceStat.size,
          importedAt: '',
          previewSource: 'decoded',
          previewUrl: '',
          thumbnailUrl: '',
        },
        path: originalPath,
        hdr: true,
        processing,
        identity: {
          dev: sourceStat.dev,
          ino: sourceStat.ino,
          size: sourceStat.size,
          mtimeMs: sourceStat.mtimeMs,
          ctimeMs: sourceStat.ctimeMs,
        },
      },
      options: { ...defaultExportOptions, quality: 100, metadata: 'none' },
      directory: renditionDirectory,
      preparationDirectory: join(directory, 'preparation'),
      hdr: true,
    }
    const prepared = await prepareExportWorkingSource(job, abort.signal, async (path) => {
      try {
        return await decoder.renderFull(originalPath, path, abort.signal, {
          ...processing,
          workingOnly: true,
        })
      } finally {
        await decoder.close(true)
      }
    })
    job.source.processing.workingAsset = prepared.asset
    report.preparation = { ...prepared, processing }
    await save()
    expect({ width: prepared.asset.width, height: prepared.asset.height }).toEqual({
      width: 5422,
      height: 3622,
    })

    report.phase = 'rendition'
    const previousBackend = process.env.IRODORI_EXPORT_BACKEND
    let rendition: Awaited<ReturnType<typeof exportRenditions>>
    try {
      process.env.IRODORI_EXPORT_BACKEND = 'gpu'
      rendition = await exportRenditions(job)
    } finally {
      if (previousBackend === undefined) delete process.env.IRODORI_EXPORT_BACKEND
      else process.env.IRODORI_EXPORT_BACKEND = previousBackend
    }
    expect(rendition.diagnostics.renderer).toBe('gpu')
    expect(rendition.diagnostics.rendererFallback).toBeUndefined()
    expect(rendition.geometry).toEqual({ width: 5422, height: 3622 })
    expect(rendition.half).toBeDefined()
    const half = rendition.half!
    const { width, height } = rendition.geometry
    expect(half.byteLength).toBe(width * height * 8)
    const quality = 100
    const sdr = await sharp(rendition.rgb, { raw: { width, height, channels: 3 } })
      .withIccProfile('srgb')
      .jpeg({ quality, chromaSubsampling: '4:4:4', progressive: false, optimiseCoding: true })
      .toBuffer()
    const frozen = {
      width,
      height,
      quality,
      headroom: rendition.contentHeadroom,
      half: { byteLength: half.byteLength, sha256: sha(bytesOf(half)) },
      sdr: { byteLength: sdr.byteLength, sha256: sha(sdr), identity: jpegIdentity(sdr) },
      transfer: 'binary16 display-linear Rec.2020 RGBA; opaque alpha; SDR JPEG sRGB',
    }
    report.frozenInputs = frozen
    report.rendition = {
      diagnostics: rendition.diagnostics,
      shaderSha256: {
        packedImmediate: sha(exportShader(true, true)),
        packedDeferred: sha(exportShader(true, true, 64, true)),
      },
    }
    await save()

    report.phase = 'native-encode'
    const native = await encodeExportHdr(
      half,
      width,
      height,
      sdr,
      quality,
      frozen.headroom,
      nativeDirectory,
      'native',
      bundle,
    )
    expect(native.backend).toBe('native')
    expect(native.memory.peakBytes).toBeLessThanOrEqual(2 * 1024 ** 3)
    expect(sha(bytesOf(half))).toBe(frozen.half.sha256)
    expect(sha(sdr)).toBe(frozen.sdr.sha256)
    const nativeInputs = {
      half: await fileEvidence(join(nativeDirectory, 'encoder.rgba16')),
      sdr: await fileEvidence(join(nativeDirectory, 'sdr.jpg')),
    }
    expect(nativeInputs.half.sha256).toBe(frozen.half.sha256)
    expect(nativeInputs.sdr.sha256).toBe(frozen.sdr.sha256)
    report.native = {
      backend: native.backend,
      memory: native.memory,
      output: await fileEvidence(native.path!),
      inputs: nativeInputs,
    }
    await save()

    report.phase = 'wasm-encode'
    const wasm = await encodeExportHdr(
      half,
      width,
      height,
      sdr,
      quality,
      frozen.headroom,
      wasmDirectory,
      'wasm',
      bundle,
    )
    expect(wasm.backend).toBe('wasm')
    expect(wasm.memory.peakBytes).toBeLessThanOrEqual(2 * 1024 ** 3)
    expect(sha(bytesOf(half))).toBe(frozen.half.sha256)
    expect(sha(sdr)).toBe(frozen.sdr.sha256)
    const wasmPath = join(wasmDirectory, 'output.jpg')
    await writeFile(wasmPath, wasm.output, { flag: 'wx' })
    report.wasm = {
      backend: wasm.backend,
      memory: wasm.memory,
      output: await fileEvidence(wasmPath),
      inputs: frozen,
    }
    report.encodedBytesIdentical = native.output.equals(wasm.output)
    await save()

    const primary = await sharp(sdr).removeAlpha().raw().toBuffer()
    const parsed = [native.output, wasm.output].map(readGainJpeg)
    const gain: Buffer[] = []
    for (const [index, output] of [native.output, wasm.output].entries()) {
      expect(() => validatePrimary(output, sdr)).not.toThrow()
      const ordinary = await sharp(output).removeAlpha().raw().toBuffer()
      expect.soft(ordinary.equals(primary), `encoder ${index}: complete SDR primary`).toBe(true)
      const decoded = await sharp(parsed[index].gain, { ignoreIcc: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect(decoded.info).toMatchObject({ width, height, channels: 3 })
      gain.push(decoded.data)
    }
    report.primary = { byteLength: primary.byteLength, sha256: sha(primary) }
    report.gainMaps = parsed.map((value, index) => ({
      metadata: value.metadata,
      jpegSha256: sha(value.gain),
      decodedSha256: sha(gain[index]),
    }))
    const codec = await loadUltraHdr(bundle)
    const comparisons: Record<string, unknown>[] = []
    report.comparisons = comparisons
    for (const headroom of [1, 2, 4]) {
      report.phase = `decode-headroom-${headroom}`
      const actual = codec.inspect(native.output, headroom)
      const expected = codec.inspect(wasm.output, headroom)
      expect(actual.pixels).toBeDefined()
      expect(expected.pixels).toBeDefined()
      expect.soft(actual.info, `headroom ${headroom}: metadata`).toEqual(expected.info)
      expect.soft(actual.stride, `headroom ${headroom}: stride`).toBe(expected.stride)
      expect.soft(actual.gamut, `headroom ${headroom}: gamut`).toBe(expected.gamut)
      expect(actual.info[18]).toBe(width)
      expect(actual.info[19]).toBe(height)
      const nativeBytes = bytesOf(actual.pixels!)
      const wasmBytes = bytesOf(expected.pixels!)
      const identical = nativeBytes.equals(wasmBytes)
      let mismatchedWords = 0
      const firstMismatches = []
      if (!identical) {
        for (
          let index = 0;
          index < Math.max(actual.pixels!.length, expected.pixels!.length);
          index++
        )
          if (actual.pixels![index] !== expected.pixels![index]) {
            mismatchedWords++
            if (firstMismatches.length < 12)
              firstMismatches.push({
                index,
                native: actual.pixels![index] ?? null,
                wasm: expected.pixels![index] ?? null,
              })
          }
      }
      const independent = [actual, expected].map((decoded, backend) => {
        let maximumError = 0
        let worst: unknown
        let components = 0
        let nonFiniteComponents = 0
        for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9])
          for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            const x = Math.round((width - 1) * fx)
            const y = Math.round((height - 1) * fy)
            const pixel = y * width + x
            const base = to2020([0, 1, 2].map((c) => srgbLinear(primary[pixel * 3 + c] / 255)))
            const map = [0, 1, 2].map((c) => gain[backend][pixel * 3 + c] / 255)
            const reference = reconstruct(base, map, parsed[backend].metadata, headroom)
            for (let channel = 0; channel < 3; channel++) {
              const value = fromHalf(decoded.pixels![(y * decoded.stride! + x) * 4 + channel])
              const difference = Math.abs(value - reference[channel])
              components++
              if (!Number.isFinite(difference)) nonFiniteComponents++
              if (!Number.isFinite(difference) || difference > maximumError) {
                maximumError = difference
                worst = { x, y, channel, actual: value, reference: reference[channel] }
              }
            }
          }
        return {
          backend: backend === 0 ? 'native' : 'wasm',
          components,
          nonFiniteComponents,
          maximumError,
          worst,
        }
      })
      comparisons.push({
        headroom,
        info: actual.info,
        stride: actual.stride,
        gamut: actual.gamut,
        native: { byteLength: nativeBytes.byteLength, sha256: sha(nativeBytes) },
        wasm: { byteLength: wasmBytes.byteLength, sha256: sha(wasmBytes) },
        identical,
        mismatchedWords,
        firstMismatches,
        independent,
      })
      await save()
      expect
        .soft(identical, `headroom ${headroom}: complete reconstructed binary16 image`)
        .toBe(true)
      for (const value of independent) {
        expect.soft(value.nonFiniteComponents, `${value.backend} finite reconstruction`).toBe(0)
        expect
          .soft(
            value.maximumError,
            `headroom ${headroom}: ${value.backend} independent reconstruction`,
          )
          .toBeLessThan(0.02)
      }
    }
    report.status = info.errors.length ? 'failed' : 'passed'
    report.phase = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    abort.abort()
    await decoder.close(true)
    report.sourceAfter = await fileEvidence(originalPath)
    expect.soft((report.sourceAfter as { sha256: string }).sha256).toBe(expectedSourceSha256)
    report.errors = info.errors.map((error) => error.message?.slice(0, 2000))
    if (info.errors.length) report.status = 'failed'
    await save()
    await rm(join(directory, 'preparation'), { recursive: true, force: true })
  }
})
