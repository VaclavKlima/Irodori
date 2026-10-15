import { test, expect } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { fromHalf, readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'
import { exportFixture, sha } from './export.helpers'
import { loadUltraHdr } from '../src/main/export/codec'
import { renderExport } from '../src/main/export/render'
import { inspectHdrJpeg, renderHdrJpeg, hasIsoGainMap } from '../src/main/processing/hdr-jpeg'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import { ExportProcess } from '../src/main/export/process'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { contentHdr, HDR_JPEG_SOURCE_VERSION } from '../src/shared/hdr'
import { defaultExportOptions } from '../src/shared/export'
import { automaticLensSettings } from '../src/shared/lens'
import { neutralAdjustments } from '../src/shared/adjustments'
import { processingMetadata } from '../src/main/processing/metadata'
import type { Photo } from '../src/shared/contracts'

test('relative SDR white and four-times-white survive ISO JPEG and independent readers', async () => {
  const info = test.info()
  const directory = info.outputPath('reference')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory),
    parsed = readGainJpeg(image.bytes)
  expect(parsed.metadata.alternateHeadroom).toBeCloseTo(Math.log2(10), 5)
  const base = await sharp(parsed.primary).raw().toBuffer()
  const gain = await sharp(parsed.gain, { ignoreIcc: true }).raw().toBuffer()
  const decoded = (await loadUltraHdr()).inspect(image.bytes, 10)
  for (let p = 1; p < 5; p++) {
    const index = 32 * image.width + p * 64 + 32
    const rgb = reconstruct(
      to2020([0, 1, 2].map((c) => srgbLinear(base[index * 3 + c] / 255))),
      [0, 1, 2].map((c) => gain[index * 3 + c] / 255),
      parsed.metadata,
      10,
    )
    for (let c = 0; c < 3; c++) {
      expect(rgb[c]).toBeCloseTo(image.patches[p][c], 1)
      expect(fromHalf(decoded.pixels![(32 * decoded.stride! + p * 64 + 32) * 4 + c])).toBeCloseTo(
        image.patches[p][c],
        1,
      )
    }
  }
})

test('import retains authored HDR without ACES and re-export retains both renditions', async () => {
  const info = test.info()
  const directory = info.outputPath('roundtrip')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory),
    engine = new PreviewEngine()
  try {
    const metadata = await engine.inspect(image.path)
    expect(metadata.hdrJpeg).toMatchObject({ state: 'supported' })
    expect(metadata.hdrJpeg?.state === 'supported' && metadata.hdrJpeg.headroom).toBeCloseTo(10, 5)
    const processing = {
      metadata,
      settings: automaticLensSettings,
      revision: 0,
      adjustments: neutralAdjustments,
      workingOnly: true,
    }
    const prepared = join(directory, 'prepared')
    await mkdir(prepared)
    const frame = await engine.renderFull(image.path, prepared, undefined, processing)
    expect(frame.format).toBe('hdr-working')
    expect(frame.linear!.hdr!.source.version).toBe(HDR_JPEG_SOURCE_VERSION)
    const strips: Float32Array[] = []
    for await (const strip of readHdrStrips(join(prepared, 'linear.f32'), frame.linear!.hdr!))
      strips.push(strip)
    const pixel = (32 * image.width + 224) * 4
    expect(
      contentHdr(
        [strips[0][pixel], strips[0][pixel + 1], strips[0][pixel + 2]],
        frame.linear!.hdr!.source,
      ).rgb[0],
    ).toBeCloseTo(4, 1)
    const exported = join(directory, 'exported')
    await mkdir(exported)
    const result = await renderExport({
      directory: exported,
      hdr: true,
      options: { ...defaultExportOptions, quality: 100, metadata: 'none' },
      source: {
        photo: { filename: 'authored-hdr.jpg' } as Photo,
        path: image.path,
        hdr: true,
        identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
        processing: {
          ...processing,
          workingAsset: {
            path: join(prepared, 'linear.f32'),
            width: frame.width,
            height: frame.height,
            ...frame.linear!,
          },
        },
      },
    })
    const output = await readFile(result.path),
      decoded = (await loadUltraHdr()).inspect(output, 10)
    expect(fromHalf(decoded.pixels![(32 * decoded.stride! + 224) * 4])).toBeCloseTo(4, 1)
    const fittingDisplay = (await loadUltraHdr()).inspect(output, 5)
    expect(fromHalf(fittingDisplay.pixels![(32 * fittingDisplay.stride! + 224) * 4])).toBeCloseTo(
      4,
      1,
    )
    const base = await sharp(output).raw().toBuffer()
    expect(base[(32 * image.width + 160) * 3]).toBeGreaterThanOrEqual(168)
    expect(base[(32 * image.width + 160) * 3]).toBeLessThanOrEqual(172)
  } finally {
    await engine.close()
  }
})

test('orientation is applied once and malformed maps retain explicit SDR fallback', async () => {
  const info = test.info()
  const directory = info.outputPath('orientation')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory, 6),
    engine = new PreviewEngine()
  try {
    const metadata = await engine.inspect(image.path)
    const prepared = join(directory, 'prepared')
    await mkdir(prepared)
    const frame = await renderHdrJpeg(image.path, prepared, {
      metadata,
      settings: automaticLensSettings,
      revision: 0,
    })
    expect([frame.width, frame.height]).toEqual([image.height, image.width])
    const data = await readFile(join(prepared, 'linear.f32'))
    expect(data.readFloatLE((224 * frame.width + 32) * 16)).toBeCloseTo(4, 1)
    const truncated = join(directory, 'broken.jpg')
    await writeFile(truncated, readGainJpeg(image.bytes).primary)
    expect(hasIsoGainMap(await readFile(truncated))).toBe(true)
    expect(await inspectHdrJpeg(truncated)).toMatchObject({
      state: 'sdr-only',
      reason: expect.stringContaining('displaying SDR'),
    })
    expect((await sharp(truncated).metadata()).width).toBe(image.width)
  } finally {
    await engine.close()
  }
})

test('existing JPEG records are recognized from bytes and preserve history', async () => {
  const info = test.info()
  const fixture = await exportFixture(0, new PreviewProcess(resolve('out/main/preview-worker.js'))),
    directory = info.outputPath('existing')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory),
    id = sha(image.bytes),
    original = join(fixture.library.root, 'originals', id)
  await mkdir(original)
  await writeFile(join(original, 'original.jpg'), image.bytes)
  const photo: Photo = {
    id,
    filename: 'authored-hdr.jpg',
    format: 'JPG',
    width: image.width,
    height: image.height,
    importedAt: new Date().toISOString(),
    bytes: image.bytes.length,
    previewSource: 'image',
    thumbnailUrl: '',
    previewUrl: '',
  }
  fixture.db
    .prepare("INSERT INTO photos VALUES (?, ?, ?, 'display-referred-v1')")
    .run(id, photo.importedAt, JSON.stringify(photo))
  fixture.db.prepare('INSERT INTO processing VALUES (?, ?)').run(
    id,
    JSON.stringify({
      metadata: { ...processingMetadata({}, []), version: 3 },
      settings: automaticLensSettings,
      revision: 0,
    }),
  )
  try {
    const history = await fixture.library.getEditHistory(id)
    expect(history.settings.processing).toBe('hdr-v1')
    expect(history.snapshots).toHaveLength(1)
    expect(history.revision).toBe(0)
    expect((await fixture.library.exports.prepare([id])).hdr).toBe(1)
    expect(sha(await readFile(join(original, 'original.jpg')))).toBe(id)
  } finally {
    await fixture.close()
  }
})

test('packaged workers decode and encode HDR JPEG outside the repository working directory', async () => {
  const directory = test.info().outputPath('packaged')
  await mkdir(directory)
  const image = await hdrJpegFixture(directory),
    engine = new PreviewEngine()
  const metadata = await engine.inspect(image.path).finally(() => engine.close())
  const exporter = new ExportProcess(
    resolve('out/main/export-worker.js'),
    resolve('out/main/preview-worker.js'),
  )
  const cwd = process.cwd(),
    codecDirectory = resolve('vendor/ultrahdr'),
    output = join(directory, 'output')
  await mkdir(output)
  try {
    process.chdir(directory)
    const result = await exporter.render(
      {
        directory: output,
        options: { ...defaultExportOptions, quality: 100, metadata: 'none' },
        hdr: true,
        source: {
          path: image.path,
          hdr: true,
          photo: { filename: 'authored-hdr.jpg' } as Photo,
          identity: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
          processing: {
            metadata,
            revision: 0,
            settings: automaticLensSettings,
            adjustments: neutralAdjustments,
          },
        },
      },
      new AbortController().signal,
    )
    const data = await readFile(result.path),
      decoded = (await loadUltraHdr(codecDirectory)).inspect(data, 10)
    expect(fromHalf(decoded.pixels![(32 * decoded.stride! + 224) * 4])).toBeCloseTo(4, 1)
  } finally {
    process.chdir(cwd)
  }
})
