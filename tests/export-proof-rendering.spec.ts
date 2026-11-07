/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { ExportProcess } from '../src/main/export/process'
import { identity } from '../src/main/export/files'
import type { ExportSource } from '../src/main/export/types'
import { PreviewProcess } from '../src/main/preview-process'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { automaticLensSettings } from '../src/shared/lens'
import { identityCrop } from '../src/shared/crop'
import type { ExportOptions } from '../src/shared/export'
import { proofFixture } from './export-proof.helpers'
import { sha } from './export.helpers'
import { cropAdmission } from './crop-frame.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { readGainJpeg, srgbLinear, to2020, reconstruct } from './export-reference'
import { syntheticMerge } from './merge.helpers'

async function sourceFor(path: string, raw = false): Promise<ExportSource> {
  const decoder = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const metadata = await decoder.inspect(path, new AbortController().signal)
  await decoder.close(true)
  const dimensions = raw ? { width: 5472, height: 3648 } : await sharp(path).metadata()
  const bytes = await readFile(path)
  return {
    path,
    hdr: !!metadata.hdrEligible || metadata.hdrJpeg?.state === 'supported',
    identity: identity(await lstat(path)),
    photo: {
      id: sha(bytes),
      filename: raw ? 'sony-zv1.ARW' : 'Photograph.jpg',
      format: raw ? 'ARW' : 'JPEG',
      width: dimensions.width!,
      height: dimensions.height!,
      bytes: bytes.length,
      importedAt: new Date().toISOString(),
      previewSource: 'decoded',
      previewUrl: '',
      thumbnailUrl: '',
    },
    processing: {
      metadata,
      processing: raw || metadata.hdrJpeg?.state === 'supported' ? 'hdr-v1' : 'display-referred-v1',
      settings: automaticLensSettings,
      revision: 3,
      adjustments: { ...neutralAdjustments, exposureEv: 0.4, contrast: 12, saturation: 7 },
    },
  }
}

async function compare(
  source: ExportSource,
  options: ExportOptions,
  root: string,
  samples = false,
) {
  const f = await proofFixture({ source, real: true })
  try {
    const proof = await f.proofs.request('dialog', { ...f.request(), options })
    const primary = f.proofs.acquire(new URL(proof.primary.url))!
    const actual = await readFile(primary.path)
    primary.release()
    const directory = join(root, crypto.randomUUID())
    await mkdir(directory, { recursive: true })
    const admission = cropAdmission()
    const result = await new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    ).render(
      {
        source,
        options,
        hdr: proof.output === 'hdr',
        directory,
        cropPolicy: proof.pipeline.crop,
        detailPolicy: proof.pipeline.detail,
        resizePolicy: proof.pipeline.resize,
        outputSharpeningPolicy: proof.pipeline.outputSharpening,
        cropAdmission: admission,
        detailAdmission: admission,
        resizeAdmission: admission,
        outputSharpeningAdmission: admission,
      },
      new AbortController().signal,
    )
    expect(result.diagnostics?.renderer).toBe('gpu')
    if (options.outputSharpening && options.outputSharpening !== 'off')
      expect(result.diagnostics?.outputSharpening).toMatchObject({
        mode: options.outputSharpening,
        width: proof.width,
        height: proof.height,
      })
    test.info().annotations.push({
      type: 'adapter',
      description:
        result.diagnostics?.adapter ??
        result.diagnostics?.resize?.adapter ??
        'See export diagnostics',
    })
    const expected = await sharp(result.path)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([proof.width, proof.height]).toEqual([expected.info.width, expected.info.height])
    expect(actual.length).toBe(expected.data.length)
    let maxSdr = 0
    for (let i = 0; i < actual.length; i++)
      maxSdr = Math.max(maxSdr, Math.abs(actual[i] - expected.data[i]))
    expect(maxSdr).toBeLessThanOrEqual(2)
    let maxHdr: number | null = null
    if (samples) {
      const leased = f.proofs.acquire(new URL(proof.linear!.url!))!,
        bytes = await readFile(leased.path)
      leased.release()
      const float = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      const parsed = readGainJpeg(await readFile(result.path))
      const primaryRgb = await sharp(parsed.primary).removeAlpha().raw().toBuffer()
      const gain = await sharp(parsed.gain, { ignoreIcc: true }).removeAlpha().raw().toBuffer()
      expect(gain.length).toBe(proof.width * proof.height * 3)
      let maximum = 0
      for (const fy of [0.25, 0.5, 0.75])
        for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const index = Math.floor(proof.height * fy) * proof.width + Math.floor(proof.width * fx)
          const expectedHdr = reconstruct(
            to2020([0, 1, 2].map((c) => srgbLinear(primaryRgb[index * 3 + c] / 255))),
            [0, 1, 2].map((c) => gain[index * 3 + c] / 255),
            parsed.metadata,
            100,
          )
          for (let c = 0; c < 3; c++)
            maximum = Math.max(maximum, Math.abs(float[index * 4 + c] - expectedHdr[c]))
          expect(float[index * 4 + 3]).toBe(1)
        }
      expect(maximum).toBeLessThan(0.02)
      maxHdr = maximum
    }
    await test.info().attach(`proof-agreement-${proof.identity.slice(0, 12)}`, {
      contentType: 'application/json',
      body: JSON.stringify({
        photoId: source.photo.id,
        revision: source.processing.revision,
        quality: proof.quality,
        output: proof.output,
        dimensions: { width: proof.width, height: proof.height },
        resizeMethod: proof.resizeMethod,
        pipeline: proof.pipeline,
        adapter: result.diagnostics?.adapter,
        maxSdrCodeDifference: maxSdr,
        maxHdrLinearError: maxHdr,
      }),
    })
    await f.proofs.release('dialog', proof.id)
    return proof
  } finally {
    await f.close()
  }
}

test('committed raster proof agrees with independent exports through crop, quality, original/reduction/fit/enlargement', async ({}, info) => {
  test.setTimeout(120000)
  const source = await sourceFor(resolve('tests/fixtures/photos/alpine-lake.jpg'))
  source.processing.crop = { ...identityCrop, quarterTurns: 1, width: 0.8, height: 0.6 }
  const { defaultExportOptions } = await import('../src/shared/export')
  const keys = new Set<string>()
  for (const [quality, size] of [
    [100, { mode: 'original' }],
    [80, { mode: 'longest', edge: 120 }],
    [37, { mode: 'fit', width: 100, height: 90 }],
    [90, { mode: 'longest', edge: 2000, allowEnlargement: true, method: 'lanczos3' }],
  ] as [number, ExportOptions['size']][]) {
    const proof = await compare(
      source,
      { ...defaultExportOptions, output: 'sdr', quality, size },
      info.outputPath('raster'),
    )
    keys.add(proof.identity)
    expect(proof.resizeMethod).toBe(size.mode === 'original' ? 'original' : 'lanczos3')
  }
  expect(keys.size).toBe(4)
})

test('authored HDR JPEG keeps the independent SDR primary and HDR reconstruction without repeated edits, orientation or scene tone mapping', async ({}, info) => {
  test.setTimeout(120000)
  const directory = info.outputPath('authored')
  await mkdir(directory, { recursive: true })
  const input = await hdrJpegFixture(directory, 6),
    source = await sourceFor(input.path)
  source.photo.width = input.height
  source.photo.height = input.width
  source.processing.adjustments = neutralAdjustments
  const { defaultExportOptions } = await import('../src/shared/export')
  for (const size of [
    { mode: 'original' },
    { mode: 'longest', edge: 401, method: 'lanczos3', allowEnlargement: true },
  ] as ExportOptions['size'][]) {
    const proof = await compare(
      source,
      { ...defaultExportOptions, output: 'hdr', metadata: 'none', size, quality: 100 },
      directory,
      true,
    )
    expect(proof.height).toBeGreaterThan(proof.width)
  }
})

test('real Sony RAW original-size SDR proof and bounded HDR enlargement preserve frozen processing', async ({}, info) => {
  test.setTimeout(240000)
  const source = await sourceFor(resolve('tests/fixtures/sony-zv1.ARW'), true)
  const { defaultExportOptions } = await import('../src/shared/export')
  const proof = await compare(
    source,
    { ...defaultExportOptions, output: 'sdr', metadata: 'none' },
    info.outputPath('raw'),
  )
  expect(proof).toMatchObject({ width: 5422, height: 3622, resizeMethod: 'original' })
  source.processing.crop = { ...identityCrop, width: 0.04, height: 0.04 }
  await compare(
    source,
    {
      ...defaultExportOptions,
      output: 'hdr',
      quality: 90,
      metadata: 'none',
      size: { mode: 'longest', edge: 272, method: 'lanczos3', allowEnlargement: true },
    },
    info.outputPath('raw'),
  )
})

test('existing v4 merge fixture follows the same proof/export stages', async ({}, info) => {
  test.setTimeout(120000)
  const merge = await syntheticMerge([0.5, 1, 2], { width: 160, height: 96 })
  try {
    const source = await sourceFor(resolve('tests/fixtures/photos/alpine-lake.jpg'))
    const path = join(merge.output, 'linear.f32'),
      asset = merge.result.asset
    source.path = path
    source.hdr = true
    source.identity = identity(await lstat(path))
    source.photo = {
      ...source.photo,
      id: asset.sha256,
      filename: 'Merge.irodori',
      assetKind: 'derived',
      width: asset.width,
      height: asset.height,
    }
    source.processing = {
      ...source.processing,
      processing: 'hdr-v1',
      metadata: {
        ...source.processing.metadata,
        mergeMaster: { asset, recipe: merge.result.recipe },
      },
      workingAsset: { ...asset, path, hdr: asset, transform: srgbTransform },
    }
    const { defaultExportOptions } = await import('../src/shared/export')
    await compare(
      source,
      {
        ...defaultExportOptions,
        output: 'hdr',
        metadata: 'none',
        size: { mode: 'longest', edge: 200, allowEnlargement: true, method: 'lanczos3' },
      },
      info.outputPath('merge'),
    )
  } finally {
    await merge.close()
  }
})

test('active output sharpening agrees across authored HDR, bounded Sony RAW and v4 merge proofs', async ({}, info) => {
  test.setTimeout(240000)
  const directory = info.outputPath('active-source-domains')
  await mkdir(directory, { recursive: true })
  const { defaultExportOptions } = await import('../src/shared/export'),
    authoredInput = await hdrJpegFixture(directory, 6),
    authored = await sourceFor(authoredInput.path),
    rawPath = resolve('tests/fixtures/sony-zv1.ARW'),
    rawHash = sha(await readFile(rawPath)),
    raw = await sourceFor(rawPath, true),
    options: ExportOptions = {
      ...defaultExportOptions,
      output: 'hdr',
      outputSharpening: 'standard',
      quality: 100,
      metadata: 'none',
      size: { mode: 'longest', edge: 201 },
    }
  authored.photo.width = authoredInput.height
  authored.photo.height = authoredInput.width
  authored.processing.adjustments = neutralAdjustments
  await compare(authored, options, directory, true)
  expect(await readFile(authoredInput.path)).toEqual(authoredInput.bytes)
  raw.processing.crop = { ...identityCrop, width: 0.04, height: 0.04 }
  await compare(raw, options, directory, true)
  expect(sha(await readFile(rawPath))).toBe(rawHash)

  const merge = await syntheticMerge([0.5, 1, 2], { width: 160, height: 96 })
  try {
    const path = join(merge.output, 'linear.f32'),
      bytes = await readFile(path),
      asset = merge.result.asset,
      source: ExportSource = {
        ...raw,
        path,
        identity: identity(await lstat(path)),
        photo: {
          ...raw.photo,
          id: asset.sha256,
          filename: 'Merge.irodori',
          assetKind: 'derived',
          width: asset.width,
          height: asset.height,
        },
        processing: {
          metadata: {
            ...raw.processing.metadata,
            mergeMaster: { asset, recipe: merge.result.recipe },
          },
          processing: 'hdr-v1',
          settings: automaticLensSettings,
          adjustments: neutralAdjustments,
          revision: 3,
          workingAsset: { ...asset, path, hdr: asset, transform: srgbTransform },
        },
      }
    await compare(
      source,
      {
        ...options,
        outputSharpening: 'high',
        size: { mode: 'longest', edge: 200, allowEnlargement: true, method: 'lanczos3' },
      },
      directory,
      true,
    )
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await merge.close()
  }
})
