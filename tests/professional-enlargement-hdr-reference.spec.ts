import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { halfFloat, loadUltraHdr, verifyUltraHdrBundle } from '../src/main/export/codec'
import { readGainJpeg } from './export-reference'
import { acceptanceHash } from './professional-editing-acceptance.helpers'
import { jpegReferencePrerequisite } from './jpeg-ycbcr-reference.helpers'
import {
  decodeFullsizeHdrFile,
  inspectFullsizeHdrJpeg,
  writeFullsizeRgb8File,
} from './professional-enlargement-hdr.helpers'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const width = 13,
  height = 129,
  headroom = 3.75

function prerequisite() {
  const value = jpegReferencePrerequisite()
  test.skip(!value.available, value.available ? '' : value.reason)
  if (!value.available) throw new Error(value.reason)
  return value
}

/** Original synthetic chart: asymmetric channels/axes and a final one-row stripe. */
async function chartInput() {
  const half = new Uint16Array(width * height * 4),
    primary = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const fx = x / (width - 1),
        fy = y / (height - 1),
        index = y * width + x,
        hdr = [0.5 + 2.5 * fx + 0.75 * fy, 0.35 + 0.8 * fx + 1.8 * fy, 0.2 + 1.1 * fx + 0.45 * fy],
        sdr = [
          0.08 + 0.32 * fx + 0.05 * fy,
          0.12 + 0.12 * fx + 0.36 * fy,
          0.04 + 0.24 * fx + 0.15 * fy,
        ]
      for (let channel = 0; channel < 3; channel++) {
        half[index * 4 + channel] = halfFloat(hdr[channel])
        const value = sdr[channel],
          encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
        primary[index * 3 + channel] = Math.round(encoded * 255)
      }
      half[index * 4 + 3] = halfFloat(1)
    }
  const sdr = await sharp(primary, { raw: { width, height, channels: 3 } })
    .withIccProfile('srgb')
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4', progressive: false })
    .toBuffer()
  return { half, sdr }
}

async function chartJpeg() {
  const { half, sdr } = await chartInput(),
    halfBytes = new Uint8Array(half.buffer, half.byteOffset, half.byteLength),
    before = { half: sha(halfBytes), sdr: sha(sdr) },
    codec = await loadUltraHdr(),
    jpeg = codec.encode(halfBytes, width, height, sdr, 100, headroom)
  expect(sha(halfBytes)).toBe(before.half)
  expect(sha(sdr)).toBe(before.sdr)
  expect(codec.memory()).toBeLessThanOrEqual(2 * 1024 ** 3)
  return { jpeg, sdr, inputHashes: before }
}

interface Comparison {
  headroom: number
  comparisons: number
  nonfiniteActual: number
  nonfiniteExpected: number
  nonopaquePixels: number
  maximumError: number
  largestReadBytes: number
  worst: { x: number; y: number; channel: number }
  decoder: {
    width: number
    height: number
    stride: number
    bytes: number
    sha256: string
    inputSha256: string
    maximumRowsPerWrite: number
    largestWriteBytes: number
    heapBytes: number
    nodeExecutableSha256: string
    moduleSha256: string
    wasmSha256: string
    moduleAfterSha256: string
    wasmAfterSha256: string
    bundleManifestSha256: string
    bundleManifestAfterSha256: string
  }
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('the actual HDR decoder file child and independent inspector cover every channel across 64-row boundaries', async ({}, info) => {
  test.setTimeout(900000)
  const current = prerequisite(),
    { jpeg, inputHashes } = await chartJpeg(),
    path = info.outputPath('asymmetric-hdr.jpg'),
    parent = info.outputPath('oracle-files')
  await writeFile(path, jpeg, { flag: 'wx' })
  const parsed = readGainJpeg(jpeg),
    fullHeadroom = Math.max(1.01, 2 ** parsed.metadata.alternateHeadroom),
    inspected = await inspectFullsizeHdrJpeg(path, width, height, {
      parentDirectory: parent,
      prerequisite: current,
    }),
    comparisons = inspected.report.comparisons as Comparison[],
    bundle = await verifyUltraHdrBundle()
  expect(fullHeadroom).toBeCloseTo(headroom, 5)
  expect(inspected).toMatchObject({
    hdr: true,
    width,
    height,
    sha256: sha(jpeg),
    channelComparisons: 10_062,
    report: {
      status: 'passed',
      ordinaryPrimary: {
        ordinaryWriter: {
          protocol: 'irodori-test-rgb8-file-v1',
          mode: 'color',
          inputSha256: sha(jpeg),
          bytes: width * height * 3,
          maximumPlaneBytes: 33_554_432 * 3,
          maximumRowsPerWrite: 64,
          largestWriteBytes: width * 64 * 3,
          tool: { sharpNativeAddonSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
        primaryWriter: {
          protocol: 'irodori-test-rgb8-file-v1',
          mode: 'color',
          inputSha256: sha(parsed.primary),
          bytes: width * height * 3,
          largestWriteBytes: width * 64 * 3,
        },
      },
      oracle: {
        absoluteBoundExclusive: 0.02,
        declaredHeadrooms: [1, fullHeadroom],
        base: {
          inputSha256: sha(parsed.primary),
          samplesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          provenance: {
            version: '3.2.0',
            idct: 'accurate-integer-jdct-islow',
            librarySha256: current.librarySha256,
            readerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            pythonSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        gain: {
          inputSha256: sha(parsed.gain),
          samplesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          provenance: { layout: 'interleaved-rgb8', idct: 'accurate-integer-jdct-islow' },
          rgb8CrossCheck: {
            protocol: 'irodori-test-rgb8-file-v1',
            mode: 'gain',
            inputSha256: sha(parsed.gain),
            bytes: width * height * 3,
            largestWriteBytes: width * 64 * 3,
          },
        },
      },
      cleanup: { failures: [] },
    },
  })
  expect(comparisons).toHaveLength(2)
  expect(comparisons.map((value) => value.headroom)).toEqual([1, fullHeadroom])
  for (const value of comparisons) {
    expect(value.comparisons).toBe(5_031)
    expect(value.nonfiniteActual).toBe(0)
    expect(value.nonfiniteExpected).toBe(0)
    expect(value.nonopaquePixels).toBe(0)
    expect(value.maximumError).toBeLessThan(0.02)
    expect(value.worst.x).toBeGreaterThanOrEqual(0)
    expect(value.worst.x).toBeLessThan(width)
    expect(value.worst.y).toBeGreaterThanOrEqual(0)
    expect(value.worst.y).toBeLessThan(height)
    expect(value.worst.channel).toBeGreaterThanOrEqual(0)
    expect(value.worst.channel).toBeLessThan(3)
    expect(value.decoder).toMatchObject({
      width,
      height,
      inputSha256: sha(jpeg),
      maximumRowsPerWrite: 64,
      moduleSha256: await acceptanceHash(join(bundle, 'irodori-ultrahdr.mjs')),
      wasmSha256: await acceptanceHash(join(bundle, 'irodori-ultrahdr.wasm')),
      bundleManifestSha256: await acceptanceHash(join(bundle, 'SHA256SUMS')),
      nodeExecutableSha256: await acceptanceHash(process.execPath),
    })
    expect(value.decoder.moduleAfterSha256).toBe(value.decoder.moduleSha256)
    expect(value.decoder.wasmAfterSha256).toBe(value.decoder.wasmSha256)
    expect(value.decoder.bundleManifestAfterSha256).toBe(value.decoder.bundleManifestSha256)
    expect(value.decoder.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(value.decoder.bytes).toBe(value.decoder.stride * height * 8)
    expect(value.decoder.heapBytes).toBeLessThanOrEqual(2 * 1024 ** 3)
    expect(value.largestReadBytes).toBe(value.decoder.stride * 64 * 8)
    expect(value.decoder.largestWriteBytes).toBe(value.decoder.stride * 64 * 8)
  }
  const retained = JSON.parse(
    await readFile(join(parent, 'fullsize-hdr-inspection.json'), 'utf8'),
  ) as {
    status: string
    cleanup: { privateDirectory: string; failures: string[] }
  }
  expect(retained.status).toBe('passed')
  expect(retained.cleanup.failures).toEqual([])
  await expect(stat(retained.cleanup.privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(parent)).toEqual(['fullsize-hdr-inspection.json'])
  expect(await acceptanceHash(path)).toBe(sha(jpeg))
  await writeFile(
    info.outputPath('generated-inputs.json'),
    JSON.stringify({ width, height, headroom, inputHashes, jpegSha256: sha(jpeg) }, null, 2) + '\n',
  )
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('the isolated RGB8 writer preserves an existing output and retires before returning its failure', async ({}, info) => {
  test.setTimeout(240000)
  const { sdr } = await chartInput(),
    directory = info.outputPath('exclusive-rgb8-child'),
    inputPath = join(directory, 'input.jpg'),
    outputPath = join(directory, 'preserved.rgb8'),
    manifestPath = join(directory, 'not-created.json'),
    sentinel = Buffer.from('Preserve this existing RGB8 output.')
  await mkdir(directory)
  await writeFile(inputPath, sdr, { flag: 'wx', mode: 0o600 })
  await writeFile(outputPath, sentinel, { flag: 'wx', mode: 0o600 })
  await expect(
    writeFullsizeRgb8File({ inputPath, outputPath, manifestPath, mode: 'color', width, height }),
  ).rejects.toThrow('EEXIST')
  expect(await readFile(outputPath)).toEqual(sentinel)
  expect(await acceptanceHash(inputPath)).toBe(sha(sdr))
  await expect(stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readdir(directory)).sort()).toEqual(['input.jpg', 'preserved.rgb8'])
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('an ordinary JPEG fails explicit gain-map validation and leaves only its failed report', async ({}, info) => {
  const current = prerequisite(),
    { sdr } = await chartInput(),
    path = info.outputPath('ordinary.jpg'),
    parent = info.outputPath('failed-oracle-files')
  await writeFile(path, sdr, { flag: 'wx' })
  await expect(
    inspectFullsizeHdrJpeg(path, width, height, { parentDirectory: parent, prerequisite: current }),
  ).rejects.toThrow('Missing gain-map JPEG.')
  const report = JSON.parse(
    await readFile(join(parent, 'fullsize-hdr-inspection.json'), 'utf8'),
  ) as {
    status: string
    error: string
    comparisons: unknown[]
    cleanup: { privateDirectory: string; failures: string[] }
  }
  expect(report.status).toBe('failed')
  expect(report.error).toContain('Missing gain-map JPEG.')
  expect(report.comparisons).toEqual([])
  expect(report.cleanup.failures).toEqual([])
  await expect(stat(report.cleanup.privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(parent)).toEqual(['fullsize-hdr-inspection.json'])
  expect(await acceptanceHash(path)).toBe(sha(sdr))
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('the actual HDR decoder refuses an existing output after decoding and preserves that foreign file', async ({}, info) => {
  test.setTimeout(240000)
  const { jpeg } = await chartJpeg(),
    directory = info.outputPath('exclusive-child'),
    inputPath = join(directory, 'input.jpg'),
    outputPath = join(directory, 'preserved.rgba16'),
    manifestPath = join(directory, 'not-created.json'),
    sentinel = Buffer.from('Preserve this existing test-owned output.'),
    bundle = await verifyUltraHdrBundle()
  await mkdir(directory)
  await writeFile(inputPath, jpeg, { flag: 'wx', mode: 0o600 })
  await writeFile(outputPath, sentinel, { flag: 'wx', mode: 0o600 })
  await expect(
    decodeFullsizeHdrFile({ bundle, inputPath, outputPath, manifestPath, headroom: 1 }),
  ).rejects.toThrow('EEXIST')
  expect(await readFile(outputPath)).toEqual(sentinel)
  expect(await acceptanceHash(inputPath)).toBe(sha(jpeg))
  await expect(stat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readdir(directory)).sort()).toEqual(['input.jpg', 'preserved.rgba16'])
})
