import { expect, test } from '@playwright/test'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { exportRenditions } from '../src/main/export/renditions'
import { ExportProcess } from '../src/main/export/process'
import { exportCropPolicy } from '../src/main/export/crop-policy'
import { rasterLinear } from '../src/main/export/raster'
import { cropWorkingFrame } from '../src/main/processing/crop-frame'
import { workingSourceIdentity } from '../src/main/working-assets'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { cropGeometry, fitCrop, identityCrop } from '../src/shared/crop'
import { defaultExportOptions, exportGeometry } from '../src/shared/export'
import {
  HDR_JPEG_SOURCE_VERSION,
  SDR_TARGET,
  adjustHdr,
  encodeHdr,
  outputHdr,
} from '../src/shared/hdr'
import type { ExportRenderJob, ExportSource } from '../src/main/export/types'
import { cropAdmission } from './crop-frame.helpers'
import { sha, syntheticExportSource } from './export.helpers'

const priorBackend = process.env.IRODORI_EXPORT_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_EXPORT_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (priorBackend === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = priorBackend
})

async function rasterSource(directory: string, opaque = false): Promise<ExportSource> {
  const width = 97,
    height = 131,
    data = Buffer.alloc(width * height * 4),
    source = await syntheticExportSource(directory, height, width, () => [1.2, 0.7, 4])
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [20 + (x % 53), 30 + (y % 71), 50 + ((x + y) % 97), !opaque && x < 31 ? 128 : 255],
        (y * width + x) * 4,
      )
  const path = join(directory, 'authored.png')
  await sharp(data, { raw: { width, height, channels: 4 } })
    .withMetadata({ orientation: 6 })
    .png()
    .toFile(path)
  return {
    ...source,
    path,
    hdr: false,
    photo: {
      ...source.photo,
      assetKind: undefined,
      filename: 'authored.png',
      width: 999,
      height: 777,
    },
    processing: {
      ...source.processing,
      workingAsset: undefined,
      adjustments: {
        ...neutralAdjustments,
        exposureEv: 0.25,
        contrast: 20,
        saturation: 35,
        vibrance: -20,
      },
    },
  }
}

async function inputFrame(path: string) {
  const { data, info } = await sharp(path)
    .autoOrient()
    .toColourspace('scrgb')
    .ensureAlpha()
    .raw({ depth: 'float' })
    .toBuffer({ resolveWithObject: true })
  return {
    data: new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4),
    width: info.width,
    height: info.height,
    transform: srgbTransform,
  }
}

test('oriented authored-raster export crops linear pixels before grading and alpha flattening', async () => {
  const root = test.info().outputPath('raster')
  await mkdir(root)
  const source = await rasterSource(root),
    before = await readFile(source.path),
    input = await inputFrame(source.path)
  expect([input.width, input.height]).toEqual([131, 97])
  for (const settings of [
    { ...identityCrop, quarterTurns: 1 as const },
    fitCrop(input, { ...identityCrop, angle: -12.34, width: 0.8, height: 0.8 }),
  ]) {
    const directory = join(root, `crop-${settings.angle}`)
    await mkdir(directory)
    source.processing.crop = settings
    const rendered = await exportRenditions({
        source,
        directory,
        hdr: false,
        options: defaultExportOptions,
        cropPolicy: { ...exportCropPolicy },
        cropAdmission: cropAdmission(),
      }),
      expected = await cropWorkingFrame(
        input,
        { settings, admission: cropAdmission(), backend: 'cpu' },
        new AbortController().signal,
      )
    expect(rendered.geometry).toEqual({
      width: expected.frame.width,
      height: expected.frame.height,
    })
    expect(rendered.diagnostics.crop!.primary!.backend).toBe(settings.angle ? 'cpu' : 'copy')
    const rgba = expected.frame.data,
      bytes = Buffer.alloc((rgba.length / 4) * 3)
    for (let i = 0; i < rgba.length; i += 4) {
      const value = rasterLinear(
        [rgba[i], rgba[i + 1], rgba[i + 2]],
        source.processing.adjustments!,
      )
      for (let c = 0; c < 3; c++)
        bytes[(i / 4) * 3 + c] = Math.round(
          255 *
            encodeHdr(
              Math.max(0, Math.min(1, Math.fround(value[c] * rgba[i + 3] + 1 - rgba[i + 3]))),
            ),
        )
    }
    expect(rendered.rgb).toEqual(bytes)
    expect(rendered.half).toBeUndefined()
  }
  expect(await readFile(source.path)).toEqual(before)
})

test('HDR export uses cropped native geometry for fit sizing and preserves its base asset identity', async () => {
  const directory = test.info().outputPath('hdr')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 131, 97, (x, y) => [x / 41, y / 31, 4]),
    before = await readFile(source.path),
    settings = fitCrop(source.processing.workingAsset!, {
      ...identityCrop,
      quarterTurns: 1,
      angle: 9.87,
      width: 0.8,
      height: 0.7,
    }),
    baseKey = workingSourceIdentity(source.photo.id, source.processing),
    size = { mode: 'fit' as const, width: 31, height: 23 },
    crop = cropGeometry(source.processing.workingAsset!, settings)
  source.processing.crop = settings
  const rendered = await exportRenditions({
    source,
    directory,
    hdr: true,
    options: { ...defaultExportOptions, size },
    cropPolicy: { ...exportCropPolicy },
    cropAdmission: cropAdmission(),
  })
  expect(rendered.geometry).toEqual(exportGeometry(crop.width, crop.height, size))
  expect(rendered.diagnostics.crop!.working!.backend).toBe('cpu')
  expect(rendered.diagnostics.crop!.geometry).toEqual(crop)
  expect(rendered.half!.length).toBe(rendered.geometry.width * rendered.geometry.height * 4)
  expect(workingSourceIdentity(source.photo.id, source.processing)).toBe(baseKey)
  expect(await readFile(source.path)).toEqual(before)
  expect(source.processing.workingAsset!.hdr!.width).toBe(131)
})

test('paired authored HDR and SDR-primary exports share geometry while retaining distinct pixel semantics', async () => {
  const root = test.info().outputPath('paired')
  await mkdir(root)
  const raster = await rasterSource(root, true),
    input = await inputFrame(raster.path),
    settings = fitCrop(input, { ...identityCrop, angle: 12.34, width: 0.8, height: 0.8 }),
    paired: ExportSource = {
      ...raster,
      hdr: true,
      processing: { ...raster.processing },
    }
  // A synthetic authored pair tests the adapter; actual gain-map decode remains separate.
  const working = await syntheticExportSource(root, input.width, input.height, () => [1.2, 0.7, 4])
  paired.processing.workingAsset = working.processing.workingAsset!
  paired.processing.workingAsset.hdr!.source = {
    version: HDR_JPEG_SOURCE_VERSION,
    processing: 'hdr-v1',
    colorSpace: 'rec2020',
    whitePoint: 'D65',
    transfer: 'linear',
    alpha: 'straight',
    orientation: 'applied-once',
    decoder: 'synthetic-authored-pair',
    normalization: { referenceWhite: 1, sourceSaturation: null },
    display: { encoding: 'iso-21496-1-jpeg', headroom: 4, referenceWhiteNits: 203 },
  }
  raster.processing.crop = settings
  paired.processing.crop = settings
  const aDir = join(root, 'raster'),
    bDir = join(root, 'paired')
  await mkdir(aDir)
  await mkdir(bDir)
  const plain = await exportRenditions({
      source: raster,
      directory: aDir,
      hdr: false,
      options: defaultExportOptions,
      cropPolicy: { ...exportCropPolicy },
      cropAdmission: cropAdmission(),
    }),
    result = await exportRenditions({
      source: paired,
      directory: bDir,
      hdr: true,
      options: defaultExportOptions,
      cropPolicy: { ...exportCropPolicy },
      cropAdmission: cropAdmission(),
    })
  expect(result.geometry).toEqual(plain.geometry)
  expect(result.diagnostics.crop!.working!.backend).toBe('cpu')
  expect(result.diagnostics.crop!.primary!.backend).toBe('cpu')
  // The red HDR input exceeds 1 and stays distinct from its authored SDR primary.
  expect(new Set(result.half).size).toBeGreaterThan(2)
  expect(result.half![2]).toBeGreaterThan(0x3c00)
  expect(result.rgb).toEqual(plain.rgb)
  expect(result.rgb.length).toBe(plain.rgb.length)
})

test('isolated export freezes crop/admission and reuses the uncropped source without decoding again', async () => {
  const directory = test.info().outputPath('worker')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 97, 73, () => [0.18, 0.5, 4]),
    before = await readFile(source.path),
    asset = source.processing.workingAsset!,
    crop = { ...identityCrop, quarterTurns: 1 as const },
    job: ExportRenderJob = {
      source,
      directory,
      hdr: false,
      cropPolicy: { ...exportCropPolicy },
      cropAdmission: cropAdmission(),
      options: { ...defaultExportOptions, metadata: 'none', quality: 100 },
      workingAsset: {
        identity: workingSourceIdentity(source.photo.id, source.processing),
        asset,
        backend: 'cpu',
      },
    }
  source.processing.crop = crop
  const exporter = new ExportProcess(
      resolve('out/main/export-worker.js'),
      join(directory, 'decoder-must-not-launch.js'),
    ),
    pending = exporter.render(job, new AbortController().signal)
  source.processing.crop = { ...identityCrop }
  job.cropPolicy!.filter = 'changed-after-worker-acceptance'
  Object.assign(job.cropAdmission!.policy.ram, { effectiveBytes: 0 })
  const result = await pending
  expect(result.diagnostics!.sourcePreparation).toBe('preview-cache')
  expect(result.diagnostics!.crop!.geometry).toEqual(cropGeometry(asset, crop))
  expect(await sharp(result.path).metadata()).toMatchObject({
    width: 73,
    height: 97,
    format: 'jpeg',
  })
  const decoded = await sharp(result.path).removeAlpha().raw().toBuffer(),
    expected = outputHdr(adjustHdr([0.18, 0.5, 4], neutralAdjustments), SDR_TARGET).rgb
  for (let c = 0; c < 3; c++)
    expect(
      Math.abs(decoded[(48 * 73 + 36) * 3 + c] / 255 - encodeHdr(expected[c])),
    ).toBeLessThanOrEqual(0.03)
  expect(await readFile(source.path)).toEqual(before)
  await expect(stat(join(directory, 'linear.f32'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('identity geometry preserves the established HDR/SDR bytes without a crop working file', async () => {
  const root = test.info().outputPath('identity')
  await mkdir(root)
  const source = await syntheticExportSource(root, 17, 13, (x, y) => [x / 31, y / 29, 4]),
    a = join(root, 'implicit'),
    b = join(root, 'explicit')
  await mkdir(a)
  await mkdir(b)
  const original = await exportRenditions({
    source,
    directory: a,
    hdr: true,
    options: defaultExportOptions,
  })
  source.processing.crop = { ...identityCrop, aspectRatio: 17 / 13 }
  const explicit = await exportRenditions({
    source,
    directory: b,
    hdr: true,
    options: defaultExportOptions,
  })
  expect(explicit.rgb).toEqual(original.rgb)
  expect(explicit.half).toEqual(original.half)
  expect(explicit.diagnostics.crop).toBeUndefined()
  await expect(stat(join(b, 'crop-working.f32'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('crop export rejects absent or insufficient admission without publishing output', async () => {
  const directory = test.info().outputPath('denied')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 97, 73, () => [0.18, 0.5, 4]),
    before = await readFile(source.path),
    job: ExportRenderJob = {
      source,
      directory,
      hdr: false,
      options: defaultExportOptions,
      cropPolicy: { ...exportCropPolicy },
    }
  source.processing.crop = fitCrop(source.processing.workingAsset!, {
    ...identityCrop,
    angle: 12.34,
  })
  await expect(exportRenditions(job)).rejects.toThrow('resource admission')
  job.cropAdmission = cropAdmission()
  Object.assign(job.cropAdmission.policy.ram, { effectiveBytes: 1 })
  await expect(exportRenditions(job)).rejects.toThrow('managed image budgets')
  await expect(stat(join(directory, 'output.jpg'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(directory, 'crop-working.f32'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(source.path)).toEqual(before)
  expect(sha(before)).toBe(source.processing.workingAsset!.sha256)
})

test('missing or unsupported crop policy fails before source decoding or output creation', async () => {
  const directory = test.info().outputPath('policy')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 17, 13, () => [0.18, 0.5, 4])
  source.processing.crop = { ...identityCrop, quarterTurns: 1 }
  source.path = join(directory, 'must-not-read-source')
  const exporter = new ExportProcess(
    join(directory, 'must-not-launch-worker'),
    join(directory, 'must-not-launch-decoder'),
  )
  for (const cropPolicy of [
    undefined,
    { ...exportCropPolicy, geometry: 'future' },
    { ...exportCropPolicy, filter: 'future' },
  ]) {
    const job: ExportRenderJob = {
      source,
      directory,
      hdr: false,
      options: defaultExportOptions,
      cropPolicy,
      cropAdmission: cropAdmission(),
    }
    await expect(exportRenditions(job)).rejects.toThrow(/crop export.*policy/i)
    await expect(exporter.render(job, new AbortController().signal)).rejects.toThrow(
      /crop export.*policy/i,
    )
  }
  await expect(stat(join(directory, 'output.jpg'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(directory, 'crop-working.f32'))).rejects.toMatchObject({ code: 'ENOENT' })
})
