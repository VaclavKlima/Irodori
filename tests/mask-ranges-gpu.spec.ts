import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { prepareMaskRangeBase } from '../src/main/mask-ranges/gpu'
import type { MaskRangeSource } from '../src/main/mask-ranges/types'
import {
  defaultColorMaskRange,
  maskRangeColorSample,
  sampleMaskRangePixels,
  type MaskRange,
} from '../src/shared/mask-ranges'

async function source(
  root: string,
  pixels: Float32Array,
  width: number,
  height: number,
  primaries: 'srgb' | 'rec2020' = 'srgb',
): Promise<MaskRangeSource> {
  const data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const path = join(root, `${sha256}.f32`)
  await writeFile(path, data)
  return { path, width, height, byteLength: data.byteLength, sha256, identity: sha256, primaries }
}

test('range GPU preserves independent luminance boundaries, HDR levels, alpha and color exposure invariance across strips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-range-gpu-'))
  const owner = new RawGpuRenderer()
  try {
    const { device, adapter } = await owner.mergeDevice()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
    const width = 17,
      height = 130
    const gray = [0, 0.125, 0.1875, 0.25, 0.5, 0.75, 0.8125, 0.875, 1, 2, -0.25]
    const pixels = new Float32Array(width * height * 4)
    for (let index = 0; index < width * height; index++) {
      const y = gray[index % gray.length]
      pixels.set([y, y, y, index % 13 === 0 ? 0 : index % 7 === 0 ? 0.5 : 1], index * 4)
    }
    const abort = new AbortController().signal
    for (const primaries of ['srgb', 'rec2020'] as const) {
      const input = await source(root, pixels, width, height, primaries)
      const range: MaskRange = { version: 1, kind: 'luminance', lower: 25, upper: 75, softness: 25 }
      const actual = await prepareMaskRangeBase(device, input, range, abort)
      const levels = [0, 0, 128, 255, 255, 255, 128, 0, 0, 0, 0]
      for (let index = 0; index < actual.length; index++)
        expect(
          Math.abs(actual[index] - (pixels[index * 4 + 3] === 0 ? 0 : levels[index % gray.length])),
        ).toBeLessThanOrEqual(1)
      const hdr = await prepareMaskRangeBase(
        device,
        input,
        { version: 1, kind: 'luminance', lower: 150, upper: 250, softness: 0 },
        abort,
      )
      for (let index = 0; index < hdr.length; index++)
        expect(hdr[index]).toBe(
          pixels[index * 4 + 3] > 0 && gray[index % gray.length] === 2 ? 255 : 0,
        )
      const all = await prepareMaskRangeBase(
        device,
        input,
        { version: 1, kind: 'luminance', lower: 0, upper: null, softness: 0 },
        abort,
      )
      for (let index = 0; index < all.length; index++)
        expect(all[index]).toBe(
          pixels[index * 4 + 3] > 0 && gray[index % gray.length] >= 0 ? 255 : 0,
        )
    }
    const colors = new Float32Array([
      1, 0, 0, 1, 1e-20, 0, 0, 1, 1e20, 0, 0, 0.5, 0, 0, 1, 1, 0, 1, 0, 1, 0.5, 0.5, 0.5, 1, 0, 0,
      0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1,
    ])
    const input = await source(root, colors, 10, 1)
    const red = defaultColorMaskRange(maskRangeColorSample([1, 0, 0], 'srgb')!)
    expect([...(await prepareMaskRangeBase(device, input, red, abort))]).toEqual([
      255, 255, 255, 0, 0, 0, 0, 0, 0, 0,
    ])
    red.samples.push(
      maskRangeColorSample([0, 0, 1], 'srgb')!,
      maskRangeColorSample([0, 1, 0], 'srgb')!,
    )
    red.range = 5
    expect([...(await prepareMaskRangeBase(device, input, red, abort))]).toEqual([
      255, 255, 255, 255, 255, 0, 0, 0, 0, 0,
    ])
    red.samples.push(
      maskRangeColorSample([0, 1, 1], 'srgb')!,
      maskRangeColorSample([1, 1, 0], 'srgb')!,
    )
    expect([...(await prepareMaskRangeBase(device, input, red, abort))]).toEqual([
      255, 255, 255, 255, 255, 0, 0, 0, 255, 255,
    ])
    red.range = 100
    expect([...(await prepareMaskRangeBase(device, input, red, abort))]).toEqual([
      255, 255, 255, 255, 255, 255, 0, 0, 255, 255,
    ])
    const bad = { ...input, sha256: '0'.repeat(64) }
    await expect(prepareMaskRangeBase(device, bad, red, abort)).rejects.toThrow('hash changed')
    const invalid = colors.slice()
    invalid[0] = NaN
    await expect(
      prepareMaskRangeBase(device, await source(root, invalid, 10, 1), red, abort),
    ).rejects.toThrow('invalid pixels')
    const cancelled = new AbortController()
    cancelled.abort(new Error('range aborted'))
    await expect(prepareMaskRangeBase(device, input, red, cancelled.signal)).rejects.toThrow(
      'range aborted',
    )
    expect([...(await prepareMaskRangeBase(device, input, red, abort))]).toEqual([
      255, 255, 255, 255, 255, 255, 0, 0, 255, 255,
    ])
  } finally {
    owner.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('range GPU makes a useful source-relative foliage selection on the committed forest photograph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-range-photo-'))
  const owner = new RawGpuRenderer()
  try {
    const decoded = await sharp(resolve('tests/fixtures/photos/forest-light.jpg'))
      .autoOrient()
      .toColourspace('scrgb')
      .ensureAlpha()
      .raw({ depth: 'float' })
      .toBuffer({ resolveWithObject: true })
    const pixels = new Float32Array(
      decoded.data.buffer,
      decoded.data.byteOffset,
      decoded.data.byteLength / 4,
    )
    const input = await source(root, pixels, decoded.info.width, decoded.info.height)
    const { device, adapter } = await owner.mergeDevice()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
    // Five visibly identified leaves: left foreground, the sunlit branch and
    // three lower/central leaves. Sample exactly the UI's fixed 7 × 7 neighborhood.
    const points = [
      [508, 741],
      [835, 641],
      [642, 659],
      [1096, 712],
      [305, 920],
    ]
    const samples = points.map(([x, y]) => {
      const roi = new Float32Array(7 * 7 * 4)
      for (let row = 0; row < 7; row++)
        roi.set(
          pixels.subarray(
            ((y - 3 + row) * decoded.info.width + x - 3) * 4,
            ((y - 3 + row) * decoded.info.width + x + 4) * 4,
          ),
          row * 7 * 4,
        )
      return sampleMaskRangePixels(roi, 'srgb').color!
    })
    const green = defaultColorMaskRange(samples[0])
    green.samples = samples
    // The sampled leaves' distances to neutral are .12569–.16828. Range 10
    // has outer softness .125, selecting their variation while excluding gray.
    green.range = 10
    const coverage = await prepareMaskRangeBase(device, input, green, new AbortController().signal)
    let selected = 0,
      excluded = 0,
      strongGreen = 0,
      selectedGreen = 0,
      neutral = 0,
      selectedNeutral = 0
    for (let index = 0; index < coverage.length; index++) {
      const r = pixels[index * 4],
        g = pixels[index * 4 + 1],
        b = pixels[index * 4 + 2]
      if (coverage[index] > 127) selected++
      if (coverage[index] < 16) excluded++
      if (g > r * 1.35 && g > b * 1.5 && g > 0.005) {
        strongGreen++
        if (coverage[index] > 127) selectedGreen++
      }
      const peak = Math.max(r, g, b),
        low = Math.min(r, g, b)
      if (peak > 0.05 && low / peak > 0.95) {
        neutral++
        if (coverage[index] > 127) selectedNeutral++
      }
    }
    test.info().annotations.push({
      type: 'photographic-range',
      description: JSON.stringify({
        points,
        samples,
        range: green.range,
        softness: green.softness,
        selected,
        excluded,
        strongGreen,
        selectedGreen,
        neutral,
        selectedNeutral,
      }),
    })
    expect(selected).toBeGreaterThan(coverage.length * 0.05)
    expect(excluded).toBeGreaterThan(coverage.length * 0.02)
    expect(strongGreen).toBeGreaterThan(100)
    expect(selectedGreen / strongGreen).toBeGreaterThan(0.65)
    expect(neutral).toBeGreaterThan(100)
    expect(selectedNeutral / neutral).toBeLessThan(0.05)
  } finally {
    owner.close()
    await rm(root, { recursive: true, force: true })
  }
})
