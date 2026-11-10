/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test, type TestInfo } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { neutralAdjustments } from '../src/shared/adjustments'
import {
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type MaskColor,
  type ResolvedMask,
} from '../src/shared/masks'
import { generatedMask } from './helpers/generated-mask'
import { sourceFor, compare } from './helpers/mask-rendering'

type Frame = Awaited<ReturnType<typeof compare>>
const birdPath =
  'assets/tests/images/raster/wikimedia/flamingo-reflection/originals/Flamant_rose_Salines_de_Thyna.jpg'
const skinPath = 'assets/tests/images/raster/wikimedia/forearm-hair/originals/ArmHair.jpg'

function localMask(
  name: string,
  color: MaskColor,
  strokes: ResolvedMask['strokes'] = [],
): ResolvedMask {
  return {
    id: randomUUID(),
    name,
    enabled: true,
    inverted: false,
    head: null,
    light: { ...neutralMaskLight },
    color,
    edge: { ...neutralMaskEdge },
    strokes,
  }
}

async function verifiedPhoto(path: string, sha256: string) {
  expect(
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  ).toBe(sha256)
  return sourceFor(resolve(path))
}

function meanPatch(frame: Frame, x: number, y: number, radius = 3): number[] {
  const centerX = Math.floor(x * frame.info.width),
    centerY = Math.floor(y * frame.info.height)
  const sum = [0, 0, 0]
  let count = 0
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const at = ((centerY + dy) * frame.info.width + centerX + dx) * 4
      for (let channel = 0; channel < 3; channel++) sum[channel] += frame.data[at + channel]
      count++
    }
  return sum.map((value) => value / count)
}

function patchDifference(a: Frame, b: Frame, x: number, y: number) {
  const first = meanPatch(a, x, y),
    second = meanPatch(b, x, y)
  return Math.max(...first.map((value, channel) => Math.abs(value - second[channel])))
}

function patchMaximumDifference(a: Frame, b: Frame, x: number, y: number, radius = 3) {
  expect([b.info.width, b.info.height]).toEqual([a.info.width, a.info.height])
  const centerX = Math.floor(x * a.info.width),
    centerY = Math.floor(y * a.info.height)
  let maximum = 0
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const at = ((centerY + dy) * a.info.width + centerX + dx) * 4
      for (let channel = 0; channel < 3; channel++)
        maximum = Math.max(maximum, Math.abs(a.data[at + channel] - b.data[at + channel]))
    }
  return maximum
}

async function photographicEvidence(
  info: TestInfo,
  name: string,
  frame: Frame,
  credit: string,
  crops: { name: string; x: number; y: number }[],
) {
  await sharp(frame.data, { raw: frame.info })
    .resize({ width: 750, height: 700, fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(info.outputPath(`${name}-fit.png`))
  for (const crop of crops) {
    const width = Math.min(512, frame.info.width),
      height = Math.min(512, frame.info.height)
    const left = Math.max(
      0,
      Math.min(frame.info.width - width, Math.round(crop.x * frame.info.width - width / 2)),
    )
    const top = Math.max(
      0,
      Math.min(frame.info.height - height, Math.round(crop.y * frame.info.height - height / 2)),
    )
    await sharp(frame.data, { raw: frame.info })
      .extract({ left, top, width, height })
      .png()
      .toFile(info.outputPath(`${name}-${crop.name}-100-percent.png`))
  }
  await writeFile(
    info.outputPath(`${name}-credit.txt`),
    `${credit}\nChanges: local-color GPU proof/export; Fit image resized, native crops extracted without resampling.\nDistributed adaptations retain the source photographic license.\n`,
  )
}

test('real flamingo keeps plumage and its reflected legs independent from cooler masked water', async ({}, info) => {
  test.setTimeout(120000)
  const credit =
    'Elgollimoh, Flamant rose Salines de Thyna.jpg, Wikimedia Commons, CC BY-SA 3.0. https://commons.wikimedia.org/wiki/File:Flamant_rose_Salines_de_Thyna.jpg https://creativecommons.org/licenses/by-sa/3.0/'
  const crops = [
    { name: 'plumage-water-boundary', x: 0.16, y: 0.51 },
    { name: 'reflection-boundary', x: 0.36, y: 0.815 },
  ]
  const source = await verifiedPhoto(
    birdPath,
    '3b87780172e91a6986610d6632babda98bf6ab24ab6e03cdff50bd70e33db5c6',
  )
  const baseline = await compare(source, info.outputPath('bird-baseline'))
  await photographicEvidence(info, 'bird-baseline', baseline, credit, crops)
  const { width, height } = source.photo
  // Hand-authored protection polygon: intentionally includes a small water margin.
  // This tests local-color isolation, not automatic subject segmentation accuracy.
  const outline = [
    [0.025, 0.61],
    [0.07, 0.55],
    [0.21, 0.46],
    [0.37, 0.375],
    [0.49, 0.37],
    [0.605, 0.407],
    [0.63, 0.36],
    [0.615, 0.22],
    [0.615, 0.14],
    [0.66, 0.085],
    [0.72, 0.06],
    [0.79, 0.075],
    [0.82, 0.13],
    [0.856, 0.2],
    [0.845, 0.28],
    [0.79, 0.295],
    [0.77, 0.2],
    [0.72, 0.15],
    [0.69, 0.14],
    [0.69, 0.22],
    [0.73, 0.36],
    [0.755, 0.425],
    [0.73, 0.49],
    [0.675, 0.55],
    [0.625, 0.6],
    [0.5, 0.64],
    [0.455, 0.65],
    [0.455, 0.82],
    [0.33, 0.82],
    [0.33, 0.65],
    [0.22, 0.625],
    [0.1, 0.62],
  ]
  const inside = (x: number, y: number) => {
    let result = false
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const a = outline[i],
        b = outline[j]
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
        result = !result
    }
    return result
  }
  const reflection = (x: number, y: number) => x > 0.3 && x < 0.52 && y > 0.795
  const water = localMask('Water', { temperature: -40, tint: 0, saturation: -20 })
  water.base = generatedMask(width, height, (x, y) =>
    inside((x + 0.5) / width, (y + 0.5) / height) ||
    reflection((x + 0.5) / width, (y + 0.5) / height)
      ? 0
      : 255,
  )
  water.edge.featherPx = 4
  source.processing.adjustments = { ...neutralAdjustments, localMasks: [water] }
  const waterOnly = await compare(source, info.outputPath('bird-water'))
  await photographicEvidence(info, 'bird-water', waterOnly, credit, crops)
  expect(patchDifference(baseline, waterOnly, 0.18, 0.22)).toBeGreaterThan(3)
  const originalWater = meanPatch(baseline, 0.18, 0.22),
    coolWater = meanPatch(waterOnly, 0.18, 0.22)
  expect(coolWater[2] / coolWater[0]).toBeGreaterThan(originalWater[2] / originalWater[0])
  for (const [x, y] of [
    [0.43, 0.46],
    [0.72, 0.1],
    [0.36, 0.9],
  ])
    expect(patchMaximumDifference(baseline, waterOnly, x, y)).toBeLessThanOrEqual(2)

  const plumage = localMask('Coral plumage', { temperature: 8, tint: 3, saturation: -4 }, [
    { mode: 'add', radius: 0.095, feather: 0.7, points: [{ x: 0.43, y: 0.46 }] },
  ])
  const reflectedLegs = localMask('Reflected legs', { temperature: -4, tint: 0, saturation: -35 })
  reflectedLegs.base = generatedMask(width, height, (x, y) =>
    reflection((x + 0.5) / width, (y + 0.5) / height) ? 255 : 0,
  )
  reflectedLegs.edge.featherPx = 4
  source.processing.adjustments = {
    ...neutralAdjustments,
    localMasks: [plumage, reflectedLegs, water],
  }
  const combined = await compare(source, info.outputPath('bird-independent'))
  await photographicEvidence(info, 'bird-independent', combined, credit, crops)
  expect(patchDifference(waterOnly, combined, 0.43, 0.46)).toBeGreaterThan(1)
  expect(patchDifference(waterOnly, combined, 0.36, 0.9)).toBeGreaterThan(3)
  expect(patchMaximumDifference(waterOnly, combined, 0.18, 0.22)).toBeLessThanOrEqual(2)
  expect(patchMaximumDifference(waterOnly, combined, 0.72, 0.1)).toBeLessThanOrEqual(2)
  await info.attach('photographic-scope', {
    contentType: 'application/json',
    body: JSON.stringify({
      input: birdPath,
      controls: [plumage, reflectedLegs, water].map(({ name, color, edge }) => ({
        name,
        color,
        edge,
      })),
      native: { width, height },
      scope:
        'Authored SDR coral bird, water and reflected legs; manual coverage, no full-body reflection or automatic-selection claim.',
    }),
  })
})

test('anonymous real skin photograph retains unmasked texture under bounded local balance and saturation', async ({}, info) => {
  test.setTimeout(120000)
  const source = await verifiedPhoto(
    skinPath,
    '02f590a33003698f750166798552a63b038456c008e9f3a220ed3544b79db4b8',
  )
  const baseline = await compare(source, info.outputPath('skin-baseline'))
  const skin = localMask('Skin', { temperature: 8, tint: -3, saturation: -10 }, [
    { mode: 'add', radius: 0.22, feather: 0.75, points: [{ x: 0.5, y: 0.5 }] },
  ])
  source.processing.adjustments = { ...neutralAdjustments, localMasks: [skin] }
  const edited = await compare(source, info.outputPath('skin-local-color'))
  expect(patchDifference(baseline, edited, 0.5, 0.5)).toBeGreaterThan(1)
  for (const [x, y] of [
    [0.12, 0.15],
    [0.8, 0.82],
    [0.85, 0.2],
  ])
    expect(patchMaximumDifference(baseline, edited, x, y)).toBeLessThanOrEqual(2)
  const credit =
    'Zephyris, ArmHair.jpg (2010 archived original), Wikimedia Commons, CC BY-SA 3.0. https://commons.wikimedia.org/wiki/File:ArmHair.jpg https://creativecommons.org/licenses/by-sa/3.0/'
  const crops = [{ name: 'feathered-skin-texture', x: 0.64, y: 0.5 }]
  await photographicEvidence(info, 'skin-baseline', baseline, credit, crops)
  await photographicEvidence(info, 'skin-local-color', edited, credit, crops)
  source.processing.adjustments = {
    ...neutralAdjustments,
    localMasks: [{ ...skin, color: { ...neutralMaskColor } }],
  }
  const neutral = await compare(source, info.outputPath('skin-neutral'))
  expect(neutral.data).toEqual(baseline.data)
  await info.attach('photographic-scope', {
    contentType: 'application/json',
    body: JSON.stringify({
      input: skinPath,
      color: skin.color,
      scope:
        'Anonymous authored-SDR skin and body hair only; no face, foliage pairing or true HDR appearance claim.',
    }),
  })
})
