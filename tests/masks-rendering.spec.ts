/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { identity } from '../src/main/export/files'
import { neutralAdjustments } from '../src/shared/adjustments'
import { identityCrop } from '../src/shared/crop'
import { neutralMaskEdge, neutralMaskLight, type ResolvedMask } from '../src/shared/masks'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { syntheticMerge } from './merge.helpers'
import { sourceFor, compare } from './helpers/mask-rendering'
import { gradientMask } from './helpers/mask-gradients'

test('linear/radial gradients with local Light/Color and corrections share frozen real SDR/HDR proof/export', async ({}, info) => {
  test.setTimeout(180000)
  const raster = await sourceFor(resolve('tests/fixtures/photos/forest-light.jpg')),
    baseline = await compare(raster, info.outputPath('gradient-baseline')),
    linear = gradientMask({ kind: 'linear', start: { x: 0.5, y: 0.2 }, end: { x: 0.5, y: 0.7 } }),
    radial = gradientMask({
      kind: 'radial',
      center: { x: 0.6, y: 0.55 },
      radiusX: 0.25,
      radiusY: 0.18,
      rotation: 37,
      feather: 50,
    })
  radial.id = crypto.randomUUID()
  linear.color = { temperature: 18, tint: 7, saturation: -12 }
  linear.light = { ...neutralMaskLight, exposureEv: 0.35, highlights: -10 }
  radial.color = { temperature: -16, tint: -3, saturation: 18 }
  radial.light = { ...neutralMaskLight, exposureEv: -0.5, shadows: 12 }
  radial.strokes = [
    { mode: 'subtract', radius: 0.04, feather: 0.7, points: [{ x: 0.6, y: 0.55 }] },
    { mode: 'add', radius: 0.02, feather: 0.4, points: [{ x: 0.7, y: 0.5 }] },
  ]
  linear.edge = { featherPx: 2.5, shiftPx: 1 }
  radial.edge = { featherPx: 1.5, shiftPx: -1 }
  raster.processing.adjustments = { ...neutralAdjustments, localMasks: [linear, radial] }
  const edited = await compare(raster, info.outputPath('gradient-forest'))
  expect(edited.info).toMatchObject({ width: baseline.info.width, height: baseline.info.height })
  let maximum = 0
  for (let i = 0; i < edited.data.length; i++)
    maximum = Math.max(maximum, Math.abs(edited.data[i] - baseline.data[i]))
  expect(maximum).toBeGreaterThan(5)
  await sharp(edited.data, { raw: edited.info })
    .resize({ width: 800, withoutEnlargement: true })
    .png()
    .toFile(info.outputPath('gradient-forest-fit.png'))

  const raw = await sourceFor(resolve('tests/fixtures/sony-zv1.ARW'), true)
  raw.processing.crop = { ...identityCrop, quarterTurns: 1, width: 0.05, height: 0.05, angle: 1.25 }
  linear.edge = { ...neutralMaskEdge }
  radial.edge = { ...neutralMaskEdge }
  linear.gradient = { kind: 'linear', start: { x: 0.48, y: 0.49 }, end: { x: 0.52, y: 0.51 } }
  radial.gradient = {
    kind: 'radial',
    center: { x: 0.5, y: 0.5 },
    radiusX: 0.025,
    radiusY: 0.025,
    rotation: 37,
    feather: 50,
  }
  radial.strokes = [
    { mode: 'subtract', radius: 0.004, feather: 0.6, points: [{ x: 0.5, y: 0.5 }] },
    { mode: 'add', radius: 0.003, feather: 0.2, points: [{ x: 0.515, y: 0.5 }] },
  ]
  raw.processing.adjustments = { ...neutralAdjustments, localMasks: [linear, radial] }
  await compare(raw, info.outputPath('gradient-sony-hdr'), true)
  await info.attach('gradient-photographic-scope', {
    contentType: 'application/json',
    body: JSON.stringify({
      fixtures: ['tests/fixtures/photos/forest-light.jpg', 'tests/fixtures/sony-zv1.ARW'],
      raster:
        'Linear/radial local Light/Color, ordered brush corrections and non-neutral whole-mask edges.',
      raw: 'Cropped/quarter-turned/straightened Sony RAW with lens geometry and independent HDR gain-map reconstruction samples.',
      maximumSdrChange: maximum,
      proofExportMaximumCodeDifference: 2,
      hdrLinearGate: 0.02,
    }),
  })
})

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
      color: { temperature: 24, tint: 12, saturation: 15 },
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
      color: { temperature: -20, tint: -8, saturation: -15 },
      strokes: [{ mode: 'add', radius: 0.1, feather: 0.6, points: [{ x: 0.8, y: 0.8 }] }],
    },
  ]
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
