/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PreviewProcess } from '../src/main/preview-process'
import { ExportProcess } from '../src/main/export/process'
import { identity } from '../src/main/export/files'
import type { ExportSource } from '../src/main/export/types'
import { neutralAdjustments } from '../src/shared/adjustments'
import { automaticLensSettings } from '../src/shared/lens'
import { identityCrop } from '../src/shared/crop'
import { defaultExportOptions } from '../src/shared/export'
import { neutralMaskEdge, neutralMaskLight, type ResolvedMask } from '../src/shared/masks'
import { proofFixture } from './export-proof.helpers'
import { cropAdmission } from './crop-frame.helpers'
import { sha } from './export.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { syntheticMerge } from './merge.helpers'

async function sourceFor(path: string, raw = false): Promise<ExportSource> {
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  let metadata
  try {
    metadata = await worker.inspect(path, new AbortController().signal)
  } finally {
    await worker.close(true)
  }
  const dimensions = raw ? { width: 5472, height: 3648 } : await sharp(path).metadata()
  const bytes = await readFile(path)
  return {
    path,
    hdr: !!metadata.hdrEligible || metadata.hdrJpeg?.state === 'supported',
    identity: identity(await lstat(path)),
    photo: {
      id: sha(bytes),
      filename: raw ? 'Sony.ARW' : 'Photograph.jpg',
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
      adjustments: structuredClone(neutralAdjustments),
    },
  }
}

function masks(): ResolvedMask[] {
  return [
    {
      id: crypto.randomUUID(),
      name: 'Trunk',
      enabled: true,
      inverted: false,
      head: null,
      edge: { ...neutralMaskEdge },
      light: { ...neutralMaskLight, exposureEv: 0.8, shadows: 10 },
      strokes: [
        {
          mode: 'add',
          radius: 0.008,
          feather: 0.7,
          points: [
            { x: 0.52, y: 0.3 },
            { x: 0.52, y: 0.6 },
          ],
        },
      ],
    },
    {
      id: crypto.randomUUID(),
      name: 'Lower right',
      enabled: true,
      inverted: false,
      head: null,
      edge: { ...neutralMaskEdge },
      light: { ...neutralMaskLight, exposureEv: -0.7 },
      strokes: [{ mode: 'add', radius: 0.1, feather: 0.6, points: [{ x: 0.8, y: 0.8 }] }],
    },
  ]
}

async function compare(source: ExportSource, root: string) {
  const fixture = await proofFixture({ source, real: true })
  try {
    const options = {
      ...structuredClone(defaultExportOptions),
      output: source.hdr ? ('hdr' as const) : ('sdr' as const),
      quality: 100,
    }
    const proof = await fixture.proofs.request('dialog', { ...fixture.request(), options })
    const lease = fixture.proofs.acquire(new URL(proof.primary.url))!
    let primary
    try {
      primary = await readFile(lease.path)
    } finally {
      lease.release()
    }
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
        hdr: source.hdr,
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
    const decoded = await sharp(result.path)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(primary.length).toBe(decoded.data.length)
    let maximum = 0
    for (let i = 0; i < primary.length; i++)
      maximum = Math.max(maximum, Math.abs(primary[i] - decoded.data[i]))
    expect(maximum).toBeLessThanOrEqual(2)
    await test.info().attach('mask-proof-export', {
      contentType: 'application/json',
      body: JSON.stringify({
        width: proof.width,
        height: proof.height,
        output: proof.output,
        maximumCodeDifference: maximum,
        adapter: result.diagnostics?.adapter,
      }),
    })
    await fixture.proofs.release('dialog', proof.id)
    return decoded
  } finally {
    await fixture.close()
  }
}

test('real forest photograph keeps unmasked pixels and independent local edits in frozen proof/export', async ({}, info) => {
  test.setTimeout(120000)
  const source = await sourceFor(resolve('tests/fixtures/photos/forest-light.jpg'))
  const baseline = await compare(source, info.outputPath('baseline'))
  const local = masks()
  local[0].light = { ...neutralMaskLight, exposureEv: 0.35, shadows: 5 }
  local[0].strokes[0].radius = 0.015
  local[0].strokes[0].feather = 0.85
  source.processing.adjustments = { ...neutralAdjustments, localMasks: local }
  const edited = await compare(source, info.outputPath('edited'))
  const sample = (data: Buffer, x: number, y: number) => {
    const at =
      (Math.floor(y * edited.info.height) * edited.info.width + Math.floor(x * edited.info.width)) *
      4
    return [data[at], data[at + 1], data[at + 2]]
  }
  const center = sample(edited.data, 0.52, 0.5),
    before = sample(baseline.data, 0.52, 0.5)
  expect(center.reduce((a, b) => a + b, 0)).toBeGreaterThan(before.reduce((a, b) => a + b, 0) + 10)
  const dark = sample(edited.data, 0.8, 0.8),
    original = sample(baseline.data, 0.8, 0.8)
  expect(dark.reduce((a, b) => a + b, 0)).toBeLessThan(original.reduce((a, b) => a + b, 0) - 5)
  for (const [x, y] of [
    [0.1, 0.1],
    [0.3, 0.5],
    [0.6, 0.9],
    [0.95, 0.95],
  ]) {
    const a = sample(edited.data, x, y),
      b = sample(baseline.data, x, y)
    expect(Math.max(...a.map((value, c) => Math.abs(value - b[c])))).toBeLessThanOrEqual(2)
  }
  await sharp(edited.data, { raw: edited.info }).png().toFile(info.outputPath('forest-masked.png'))
  await sharp(baseline.data, { raw: baseline.info })
    .png()
    .toFile(info.outputPath('forest-baseline.png'))
})

test('real Sony RAW masks retain canonical placement through crop and HDR proof/export', async ({}, info) => {
  test.setTimeout(120000)
  const source = await sourceFor(resolve('tests/fixtures/sony-zv1.ARW'), true)
  source.processing.crop = { ...identityCrop, quarterTurns: 1, width: 0.05, height: 0.05 }
  source.processing.adjustments = { ...neutralAdjustments, localMasks: masks() }
  await compare(source, info.outputPath('sony'))
})

test('authored HDR and cropped synthetic merge-master edge masks agree between proof and exported JPEG', async ({}, info) => {
  test.setTimeout(120000)
  await mkdir(info.outputPath('authored'), { recursive: true })
  const input = await hdrJpegFixture(info.outputPath('authored'))
  const authored = await sourceFor(input.path)
  authored.processing.adjustments = { ...neutralAdjustments, localMasks: masks() }
  await compare(authored, info.outputPath('authored-output'))
  const merge = await syntheticMerge([0.5, 1, 2], { width: 160, height: 96 })
  try {
    const path = join(merge.output, 'linear.f32'),
      asset = merge.result.asset
    const merged = await sourceFor(resolve('tests/fixtures/photos/forest-light.jpg'))
    merged.path = path
    merged.hdr = true
    merged.identity = identity(await lstat(path))
    merged.photo = {
      ...merged.photo,
      id: asset.sha256,
      width: asset.width,
      height: asset.height,
      assetKind: 'derived',
    }
    merged.processing = {
      ...merged.processing,
      processing: 'hdr-v1',
      crop: {
        ...identityCrop,
        centerX: 0.53,
        centerY: 0.52,
        width: 0.8,
        height: 0.7,
        angle: 1.25,
        quarterTurns: 1,
      },
      adjustments: { ...neutralAdjustments, localMasks: masks() },
      metadata: {
        ...merged.processing.metadata,
        mergeMaster: { asset, recipe: merge.result.recipe },
      },
      workingAsset: {
        path,
        ...asset,
        transform: { white: 1, threshold: 0.0031308, offset: 0.055, quantize: false },
        hdr: asset,
      },
    }
    const local = merged.processing.adjustments!.localMasks!
    local[0].strokes = [
      {
        mode: 'add',
        radius: 0.08,
        feather: 0.2,
        points: [
          { x: 0.52, y: 0.3 },
          { x: 0.52, y: 0.65 },
        ],
      },
      { mode: 'subtract', radius: 0.025, feather: 0.1, points: [{ x: 0.52, y: 0.5 }] },
    ]
    local[1].inverted = true
    local[1].strokes = [
      { mode: 'add', radius: 0.15, feather: 0.2, points: [{ x: 0.52, y: 0.5 }] },
      { mode: 'subtract', radius: 0.04, feather: 0.1, points: [{ x: 0.6, y: 0.5 }] },
    ]
    const neutralEdges = await compare(merged, info.outputPath('merge-neutral-edges'))
    local[0].edge = { featherPx: 2.5, shiftPx: 2 }
    local[1].edge = { featherPx: 1.5, shiftPx: -1 }
    const edited = await compare(merged, info.outputPath('merge-edge-output'))
    expect(edited.info.width).toBe(neutralEdges.info.width)
    expect(edited.info.height).toBe(neutralEdges.info.height)
    let maximumEdgeEffect = 0
    for (let i = 0; i < edited.data.length; i++)
      maximumEdgeEffect = Math.max(
        maximumEdgeEffect,
        Math.abs(edited.data[i] - neutralEdges.data[i]),
      )
    expect(maximumEdgeEffect).toBeGreaterThan(2)
    await info.attach('synthetic-merge-edge-scope', {
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'Synthetic v4 merge master; not real merged-photograph quality acceptance.',
        crop: merged.processing.crop,
        edges: local.map((mask) => mask.edge),
        inverted: local.map((mask) => mask.inverted),
        maximumEdgeEffect,
        proofExportMaximumCodeDifference: 2,
      }),
    })
  } finally {
    await merge.close()
  }
})
