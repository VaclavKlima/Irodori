import { test, expect } from '@playwright/test'
import { cp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { ExifTool } from 'exiftool-vendored'
import vectors from './fixtures/export-gain-vectors.json' with { type: 'json' }
import { defaultExportOptions } from '../src/shared/export'
import { renderExport, rasterLinear } from '../src/main/export/render'
import { halfFloat, loadUltraHdr } from '../src/main/export/codec'
import { resizeLinear } from '../src/main/export/resize'
import { neutralAdjustments, renderAdjustments, srgbTransform } from '../src/shared/adjustments'
import { renderHdrContent } from '../src/shared/display-rendering'
import { adjustHdr } from '../src/shared/hdr'
import { PreviewEngine } from '../src/main/preview-engine'
import { ExportProcess } from '../src/main/export/process'
import { workingSourceIdentity, validateWorkingAsset } from '../src/main/working-assets'
import { automaticLensSettings } from '../src/shared/lens'
import { processingMetadata } from '../src/main/processing/metadata'
import type { ExportSource } from '../src/main/export/types'
import { exportFixture, sha, syntheticExportSource } from './export.helpers'
import { fromHalf, readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'

test('independent Float64 reconstruction matches licensed black-offset and partial-headroom vectors', () => {
  for (const vector of vectors.vectors) {
    const result = reconstruct(vector.base, vector.gain, vectors.metadata, vector.headroom)
    for (let c = 0; c < 3; c++) expect(result[c]).toBeCloseTo(vector.expected[c], 12)
  }
})

for (const [quality, tolerance] of [
  [100, 0.03],
  [90, 0.05],
  [80, 0.1],
])
  test(`ISO HDR JPEG quality ${quality} preserves the SDR primary and reconstructs Rec.2020 chart interiors`, async () => {
    const info = test.info()
    const directory = info.outputPath('chart')
    await mkdir(directory)
    const patches = [
      [0, 0, 0],
      [0.18, 0.18, 0.18],
      [1, 1, 1],
      [8, 0.05, 0.02],
      [0.03, 6, 0.05],
      [0.02, 0.1, 12],
    ]
    const source = await syntheticExportSource(
      directory,
      385,
      65,
      (x) => patches[Math.min(5, Math.floor(x / 64))],
    )
    const result = await renderExport({
      source,
      options: { ...defaultExportOptions, quality, metadata: 'none' },
      directory,
      hdr: true,
    })
    const bytes = await readFile(result.path),
      supplied = await readFile(join(directory, 'sdr.jpg'))
    const parsed = readGainJpeg(bytes)
    expect(bytes.includes(Buffer.from('http://ns.adobe.com/xap/1.0/'))).toBe(false)
    expect(parsed.metadata.useBase).toBe(false)
    const contentPeak = Math.max(
      1.01,
      ...patches.flatMap((patch) => renderHdrContent(patch as [number, number, number]).rgb),
    )
    expect(parsed.metadata.alternateHeadroom).toBeCloseTo(Math.log2(contentPeak), 5)
    expect(new Set(parsed.metadata.min).size + new Set(parsed.metadata.max).size).toBeGreaterThan(2)
    const ordinary = await sharp(bytes).raw().toBuffer()
    expect(ordinary.equals(await sharp(supplied).raw().toBuffer())).toBe(true)
    expect(ordinary.equals(await sharp(parsed.primary).raw().toBuffer())).toBe(true)
    const gain = await sharp(parsed.gain, { ignoreIcc: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(gain.info).toMatchObject({ width: 385, height: 65, channels: 3 })
    const codec = await loadUltraHdr()
    const inspected = codec.inspect(bytes)
    expect(inspected.info.slice(18)).toEqual([385, 65, 385, 65])
    for (const headroom of [1, 2, 10]) {
      const decoded = codec.inspect(bytes, headroom)
      for (const [p, patch] of patches.entries()) {
        const index = 32 * 385 + p * 64 + 32
        const base = to2020([0, 1, 2].map((c) => srgbLinear(ordinary[index * 3 + c] / 255)))
        const map = [0, 1, 2].map((c) => gain.data[index * 3 + c] / 255)
        const reconstructed = reconstruct(base, map, parsed.metadata, headroom)
        const expected = renderHdrContent(patch as [number, number, number]).rgb
        for (let c = 0; c < 3; c++) {
          // Codec decoding is a second reader path; the oracle independently decodes both JPEGs.
          expect(
            Math.abs(
              fromHalf(decoded.pixels![(32 * decoded.stride! + p * 64 + 32) * 4 + c]) -
                reconstructed[c],
            ),
            JSON.stringify({
              headroom,
              p,
              c,
              oracle: reconstructed[c],
              decoded: fromHalf(decoded.pixels![(32 * decoded.stride! + p * 64 + 32) * 4 + c]),
              base,
              map,
              metadata: parsed.metadata,
            }),
          ).toBeLessThan(0.02)
          if (headroom === 10)
            expect(
              Math.abs(reconstructed[c] - expected[c]) / Math.max(0.01, expected[c]),
              `patch ${p}, channel ${c}`,
            ).toBeLessThanOrEqual(tolerance)
        }
      }
    }
    expect(codec.memory()).toBeLessThanOrEqual(2 * 1024 ** 3)
  })

test('raster orientation, linear alpha flattening, profiles and implemented edits match the SDR operators', async () => {
  const info = test.info()
  const t = await exportFixture(1)
  try {
    const directory = info.outputPath('raster')
    await mkdir(directory)
    const path = join(directory, 'input.png')
    await sharp({
      create: { width: 13, height: 7, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toFile(path)
    const source: ExportSource = {
      photo: t.photos[0],
      path,
      hdr: false,
      identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
      processing: {
        metadata: processingMetadata({}, []),
        settings: automaticLensSettings,
        revision: 0,
        adjustments: neutralAdjustments,
      },
    }
    const output = await renderExport({
      source,
      options: { ...defaultExportOptions, quality: 100, metadata: 'none' },
      directory,
      hdr: false,
    })
    const image = await sharp(output.path).raw().toBuffer({ resolveWithObject: true })
    expect(image.info).toMatchObject({ width: 7, height: 13, channels: 3 })
    expect(image.data[0]).toBeGreaterThanOrEqual(186)
    expect(image.data[0]).toBeLessThanOrEqual(189)
    const metadata = await sharp(output.path).metadata()
    expect(metadata.icc).toBeTruthy()
    expect(metadata.hasAlpha).toBe(false)
    expect(metadata.isProgressive).toBe(false)
    for (const patch of [
      { exposureEv: 1 },
      { contrast: 35 },
      { highlights: -40 },
      { shadows: 70 },
      { whites: -30 },
      { blacks: 20 },
      { exposureEv: 0.5, contrast: -25, highlights: -30, shadows: 40, whites: 15, blacks: -10 },
    ]) {
      const a = { ...neutralAdjustments, ...patch },
        rgb = [0.15, 0.1, 0.04]
      const reference = renderAdjustments(new Float32Array([...rgb, 1]), a, srgbTransform)
      const rendered = rasterLinear(rgb, a).map((v) =>
        Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255),
      )
      for (let c = 0; c < 3; c++)
        expect(Math.abs(rendered[c] - reference[c])).toBeLessThanOrEqual(1)
    }
  } finally {
    await t.close()
  }
})

test('Lanczos3 resizes both renditions with identical odd geometry in linear light', async () => {
  const info = test.info()
  const directory = info.outputPath('resize')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 129, 67, () => [2, 1, 0.2])
  const a = {
    ...neutralAdjustments,
    exposureEv: 0.5,
    contrast: 20,
    highlights: -35,
    shadows: 30,
    whites: -15,
    blacks: 10,
  }
  source.processing.adjustments = a
  const result = await renderExport({
    source,
    options: { ...defaultExportOptions, size: { mode: 'fit', width: 31, height: 29 } },
    directory,
    hdr: true,
  })
  const parsed = readGainJpeg(await readFile(result.path))
  expect(await sharp(parsed.primary).metadata()).toMatchObject({ width: 31, height: 16 })
  expect(await sharp(parsed.gain).metadata()).toMatchObject({ width: 31, height: 16 })
  const expected = renderHdrContent(adjustHdr([2, 1, 0.2], a)).rgb
  const decoded = (await loadUltraHdr()).inspect(await readFile(result.path), 10)
  for (let c = 0; c < 3; c++)
    expect(
      Math.abs(fromHalf(decoded.pixels![(8 * decoded.stride! + 15) * 4 + c]) - expected[c]) /
        expected[c],
    ).toBeLessThan(0.05)
  const linearPath = join(directory, 'tiny.f32')
  await writeFile(linearPath, Buffer.from(new Float32Array([0, 1]).buffer))
  const rows: number[] = []
  await resizeLinear(linearPath, 2, 1, 1, 1, 1, (data) => rows.push(data[0]))
  expect(rows[0]).toBeCloseTo(0.5, 6)
})

test('runtime checksums reject changed code and bounded allocations fail explicitly', async () => {
  const info = test.info()
  const path = info.outputPath('codec')
  await cp(resolve('vendor/ultrahdr'), path, { recursive: true })
  await writeFile(join(path, 'irodori-ultrahdr.wasm'), 'damaged')
  await expect(loadUltraHdr(path)).rejects.toThrow('checksum')
  const codec = await loadUltraHdr()
  expect(() => codec.encode(new Uint8Array(8), 32768, 32768, new Uint8Array(0), 90)).toThrow(
    'allocation',
  )
  expect(halfFloat(100 / 203)).toBeGreaterThan(0)
  const module = new WebAssembly.Module(
    await readFile(resolve('vendor/ultrahdr/irodori-ultrahdr.wasm')),
  )
  expect(WebAssembly.Module.imports(module).some((i) => /pthread|thread_create/.test(i.name))).toBe(
    false,
  )
})

test('real Sony RAW prepares independently, retains frozen white balance/lens edits and exports HDR without preview cache input', async () => {
  const info = test.info()
  test.setTimeout(600000)
  const path = resolve('tests/fixtures/sony-zv1.ARW'),
    directory = info.outputPath('sony')
  await mkdir(directory)
  const engine = new PreviewEngine()
  const exporter = new ExportProcess(
    resolve('out/main/export-worker.js'),
    resolve('out/main/preview-worker.js'),
  )
  try {
    const metadata = await engine.inspect(path)
    expect(metadata.hdrEligible).toBe(true)
    const processing = {
      metadata,
      settings: automaticLensSettings,
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
    const source: ExportSource = {
      path,
      hdr: true,
      processing,
      identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
      photo: {
        id: sha(await readFile(path)),
        filename: 'sony-zv1.ARW',
        format: 'ARW',
        width: 5496,
        height: 3672,
        bytes: 0,
        importedAt: '',
        previewSource: 'embedded',
        previewUrl: '',
        thumbnailUrl: '',
      },
    }
    // Exercise the real decoder -> process exit -> encoder worker sequence.
    const result = await exporter.render(
      {
        source,
        options: {
          ...defaultExportOptions,
          metadata: 'camera-copyright',
          size: { mode: 'longest', edge: 97 },
        },
        directory,
        hdr: true,
      },
      new AbortController().signal,
    )
    expect((await stat(join(directory, 'linear.f32'))).size / 16).toBeGreaterThan(19000000)
    expect(await sharp(result.path).metadata()).toMatchObject({
      width: 97,
      height: 65,
      format: 'jpeg',
    })
    const parsed = readGainJpeg(await readFile(result.path))
    expect(await sharp(parsed.gain).metadata()).toMatchObject({ width: 97, height: 65 })
    expect(sha(await readFile(path))).toBe(source.photo.id)
  } finally {
    await engine.close()
    await rm(join(directory, 'linear.f32'), { force: true })
  }
})

test('the isolated exporter consumes a matching validated working asset without launching a decoder', async () => {
  const directory = test.info().outputPath('leased-working-source')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 13, 9, () => [0.18, 0.5, 4])
  source.processing.processing = 'hdr-v1'
  source.processing.adjustments = { ...neutralAdjustments, exposureEv: 0.25, highlights: -25 }
  const asset = source.processing.workingAsset!
  const signal = new AbortController().signal
  await validateWorkingAsset(asset, signal)
  const exporter = new ExportProcess(
    resolve('out/main/export-worker.js'),
    join(directory, 'decoder-must-not-launch.js'),
  )
  const result = await exporter.render(
    {
      source,
      options: { ...defaultExportOptions, metadata: 'none' },
      directory,
      hdr: true,
      workingAsset: {
        identity: workingSourceIdentity(source.photo.id, source.processing),
        asset,
        backend: 'cpu',
      },
    },
    signal,
  )
  expect(result.diagnostics?.sourcePreparation).toBe('preview-cache')
  expect(result.diagnostics?.sourceBackend).toBe('cpu')
  expect(await sharp(result.path).metadata()).toMatchObject({
    width: 13,
    height: 9,
    format: 'jpeg',
  })
  expect(readGainJpeg(await readFile(result.path)).gain.length).toBeGreaterThan(0)
  expect(source.processing.adjustments.exposureEv).toBe(0.25)
  await expect(stat(join(directory, 'linear.f32'))).rejects.toThrow('ENOENT')
})

test('the full Sony fixture dimensions fit the capped single-threaded encoder heap without downscaling', async () => {
  test.setTimeout(120000)
  const width = 5496,
    height = 3672
  const jpeg = await sharp({
    create: { width, height, channels: 3, background: { r: 130, g: 130, b: 130 } },
  })
    .withIccProfile('srgb')
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer()
  const half = new Uint16Array(width * height * 4)
  const encoded = halfFloat((2 * 100) / 203)
  for (let i = 0; i < half.length; i += 4) {
    half[i] = half[i + 1] = half[i + 2] = encoded
    half[i + 3] = halfFloat(1)
  }
  const codec = await loadUltraHdr()
  const result = codec.encode(new Uint8Array(half.buffer), width, height, jpeg, 90)
  expect(codec.inspect(result).info.slice(18)).toEqual([width, height, width, height])
  expect(codec.memory()).toBeLessThanOrEqual(2 * 1024 ** 3)
  await writeFile(
    test.info().outputPath('encoder-memory.json'),
    JSON.stringify({ width, height, heapBytes: codec.memory(), limitBytes: 2 * 1024 ** 3 }),
  )
})

test('metadata policies keep copyright and camera facts while excluding GPS, serials and private descriptions', async () => {
  const t = await exportFixture(1),
    tool = new ExifTool({ maxProcs: 1 })
  const directory = test.info().outputPath('metadata')
  await mkdir(directory)
  try {
    const path = join(directory, 'private.jpg')
    await sharp({
      create: { width: 19, height: 13, channels: 3, background: { r: 50, g: 80, b: 120 } },
    })
      .withExif({
        IFD0: {
          Make: 'Export Camera',
          Model: 'Test Model',
          Artist: 'Fixture Author',
          Copyright: 'Fixture Copyright',
          ImageDescription: '/private/internal/source-path',
        },
        IFD2: {
          LensModel: 'Test Lens',
          BodySerialNumber: 'PRIVATE-BODY',
          LensSerialNumber: 'PRIVATE-LENS',
          ExposureTime: '1/125',
          FNumber: '28/10',
          ISOSpeedRatings: '200',
          DateTimeOriginal: '2026:10:15 12:30:00',
        },
        IFD3: {
          GPSLatitude: '50/1 0/1 0/1',
          GPSLatitudeRef: 'N',
          GPSLongitude: '14/1 0/1 0/1',
          GPSLongitudeRef: 'E',
        },
      })
      .jpeg()
      .toFile(path)
    await tool.write(
      path,
      {
        BodySerialNumber: 'PRIVATE-BODY',
        LensSerialNumber: 'PRIVATE-LENS',
        GPSLatitude: 50,
        GPSLongitude: 14,
        ISO: 200,
        ExposureTime: 1 / 125,
        FNumber: 2.8,
      },
      { writeArgs: ['-overwrite_original'] },
    )
    const original = await tool.readRaw(path)
    expect(original.SerialNumber).toBe('PRIVATE-BODY')
    expect(original.GPSLatitude).toBeTruthy()
    const source: ExportSource = {
      photo: t.photos[0],
      path,
      hdr: false,
      identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
      processing: {
        metadata: processingMetadata({}, []),
        settings: automaticLensSettings,
        revision: 0,
      },
    }
    for (const policy of ['camera-copyright', 'copyright', 'none'] as const) {
      const output = join(directory, policy)
      await mkdir(output)
      const result = await renderExport({
        source,
        options: { ...defaultExportOptions, metadata: policy },
        directory: output,
        hdr: false,
      })
      const tags = await tool.readRaw(result.path)
      expect(
        Object.keys(tags).some((key) =>
          /GPS|Serial|Thumbnail|MakerNote|ImageDescription/.test(key),
        ),
      ).toBe(false)
      if (policy !== 'none') {
        expect(tags.Copyright).toBe('Fixture Copyright')
        expect(tags.Artist).toBe('Fixture Author')
      } else {
        expect(tags.Copyright).toBeUndefined()
        expect(tags.Artist).toBeUndefined()
      }
      if (policy === 'camera-copyright') {
        expect(tags.Model).toBe('Test Model')
        expect(Number(tags.ISO)).toBe(200)
        expect(tags.LensModel).toBe('Test Lens')
      } else {
        expect(tags.Model).toBeUndefined()
        expect(tags.ISO).toBeUndefined()
      }
      expect((await sharp(result.path).metadata()).icc).toBeTruthy()
    }
  } finally {
    await tool.end()
    await t.close()
  }
})
