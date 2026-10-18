import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { neutralAdjustments } from '../src/shared/adjustments'
import {
  adjustHdr,
  encodeHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  SDR_TARGET,
  HDR_RAW_SOURCE_VERSION,
  HDR_ADJUSTMENT_VERSION,
  HDR_OUTPUT_VERSION,
} from '../src/shared/hdr'

test('renders native Sony HDR detail and its exact sRGB proof without embedded extraction', async () => {
  // Retain the native CPU proof and a separate full-image analytic ACES reference.
  test.setTimeout(120000)
  const info = test.info()
  const output = info.outputPath('full')
  await mkdir(output, { recursive: true })
  let extracted = false
  const engine = new PreviewEngine(async () => {
    extracted = true
    throw new Error('Do not extract')
  }, 'cpu')
  const source = await readFile('tests/fixtures/sony-zv1.ARW')
  try {
    const result = await engine.renderFull('tests/fixtures/sony-zv1.ARW', output)
    expect(result).toMatchObject({
      width: 5422,
      height: 3622,
      format: 'rgba8-srgb',
      byteLength: 5422 * 3622 * 4,
      diagnostics: { backend: 'cpu' },
    })
    expect(result.renderId).toBe(
      `${HDR_RAW_SOURCE_VERSION}-${HDR_ADJUSTMENT_VERSION}-${HDR_OUTPUT_VERSION}-${JSON.stringify(neutralAdjustments)}`,
    )
    expect(extracted).toBe(false)
    const frame = await readFile(join(output, 'full.rgba'))
    expect(frame.length).toBe(result.byteLength)
    expect(createHash('sha256').update(frame).digest('hex')).toBe(result.sha256)
    const asset = result.linear!.hdr!
    expect(asset).toMatchObject({
      kind: 'hdr-working-v1',
      width: result.width,
      height: result.height,
      byteLength: result.width * result.height * 16,
      source: {
        processing: 'hdr-v1',
        highlightBlend: 'sensor-blend-v1',
        colorSpace: 'rec2020',
        transfer: 'linear',
        alpha: 'straight',
        orientation: 'applied-once',
      },
    })
    expect(result.linear!.sha256).toBe(asset.sha256)
    expect(result.linear!.byteLength).toBe(asset.byteLength)
    // Current full-resolution geometry includes the verified automatic lens crop.
    // Compare every RGB and alpha sample, retaining full-image CPU agreement.
    const pixels = result.width * result.height
    const wb = hdrAdjustmentMatrix(neutralAdjustments, asset.whiteBalance) ?? undefined
    let offset = 0,
      aboveWhite = false,
      negative = false,
      invalidAlpha = false
    let firstDifference:
      { position: number; channel: number; actual: number; expected: number } | undefined
    for await (const strip of readHdrStrips(join(output, 'linear.f32'), asset)) {
      aboveWhite ||= strip.some((value, index) => index % 4 !== 3 && value > 1)
      negative ||= strip.some((value, index) => index % 4 !== 3 && value < 0)
      for (let local = 0; local < strip.length; local += 4) {
        const position = offset + local / 4
        const rgb = outputHdr(
          adjustHdr([strip[local], strip[local + 1], strip[local + 2]], neutralAdjustments, wb),
          SDR_TARGET,
        ).rgb
        for (let c = 0; c < 3; c++) {
          const expected = Math.round(encodeHdr(rgb[c]) * 255)
          const actual = frame[position * 4 + c]
          if (actual !== expected) firstDifference ??= { position, channel: c, actual, expected }
        }
        const expectedAlpha = Math.round(strip[local + 3] * 255)
        const actualAlpha = frame[position * 4 + 3]
        if (actualAlpha !== expectedAlpha)
          firstDifference ??= { position, channel: 3, actual: actualAlpha, expected: expectedAlpha }
      }
      offset += strip.length / 4
    }
    for (let i = 3; i < frame.length; i += 4) invalidAlpha ||= frame[i] !== 255
    expect(offset).toBe(pixels)
    expect(firstDifference).toBeUndefined()
    expect(aboveWhite).toBe(true)
    expect(negative).toBe(true)
    expect(invalidAlpha).toBe(false)
    const ratio = Math.min(1, 96 / Math.max(result.width, result.height))
    const width = Math.max(1, Math.round(result.width * ratio))
    const height = Math.max(1, Math.round(result.height * ratio))
    const thumbnail = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const from =
          (Math.floor(((y + 0.5) * result.height) / height) * result.width +
            Math.floor(((x + 0.5) * result.width) / width)) *
          4
        frame.copy(thumbnail, (y * width + x) * 4, from, from + 4)
      }
    const expectedPlaceholder = await sharp(thumbnail, { raw: { width, height, channels: 4 } })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    const placeholder = await readFile(join(output, 'placeholder.png'))
    expect(placeholder.length).toBe(result.placeholderBytes)
    expect(placeholder).toEqual(expectedPlaceholder)
    expect(await sharp(placeholder).metadata()).toMatchObject({ width, height, hasProfile: true })
    expect((await readdir(output)).sort()).toEqual(['full.rgba', 'linear.f32', 'placeholder.png'])
    expect((await readFile('tests/fixtures/sony-zv1.ARW')).equals(source)).toBe(true)
  } finally {
    await engine.close()
  }
})

test('cancels a real full-resolution worker and can render again afterwards', async () => {
  const info = test.info()
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const output = info.outputPath('worker')
  await mkdir(output, { recursive: true })
  const timed = new PreviewProcess(resolve('out/main/preview-worker.js'), 25)
  try {
    await expect(
      timed.renderFull(
        resolve('tests/fixtures/sony-zv1.ARW'),
        output,
        new AbortController().signal,
      ),
    ).rejects.toThrow('timed out')
  } finally {
    await timed.close()
  }
  const abort = new AbortController()
  const rendering = worker.renderFull(resolve('tests/fixtures/sony-zv1.ARW'), output, abort.signal)
  const timer = setTimeout(() => abort.abort(), 100)
  try {
    await expect(rendering).rejects.toThrow('cancelled')
    const crashed = worker.renderFull(
      resolve('tests/fixtures/sony-zv1.ARW'),
      output,
      new AbortController().signal,
    )
    const stopped = expect(crashed).rejects.toThrow('stopped')
    await worker.close(true)
    await stopped
    expect(
      await worker.renderFull(
        resolve('tests/fixtures/photos/alpine-lake.jpg'),
        output,
        new AbortController().signal,
      ),
    ).toMatchObject({ width: 1920, height: 1280 })
  } finally {
    clearTimeout(timer)
    await worker.close()
  }
})
