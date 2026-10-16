import { neutralAdjustments } from '../src/shared/adjustments'
import { createHash } from 'node:crypto'
import { LibRaw } from '@colorhythm/libraw-wasm'
import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import sharp from 'sharp'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { readGpuSource, type RawSource } from '../src/main/gpu/raw-source'
import { PreviewEngine } from '../src/main/preview-engine'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
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

async function hardwareRender(gpu: RawGpuRenderer, source: RawSource) {
  try {
    return await gpu.render(source)
  } catch (error) {
    if (error instanceof Error && error.message === 'No hardware GPU adapter is available.')
      test.skip(true, 'No hardware GPU adapter; CPU fallback is tested separately.')
    throw error
  }
}

// Additional local samples are read in place; photographs are never added to fixtures.
const rawSamples: string[] = process.env.LUMA_RAW_TEST_FILES
  ? JSON.parse(process.env.LUMA_RAW_TEST_FILES)
  : ['tests/fixtures/sony-zv1.ARW']

for (const sample of rawSamples) {
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture arguments must be destructured.
  test(`Sony GPU AHD preserves CPU rendering and full detail: ${basename(sample)}`, async ({}, info) => {
    test.setTimeout(90_000)
    await LibRaw.initialize()
    const decoder = new LibRaw()
    await decoder.waitUntilReady()
    const gpu = new RawGpuRenderer()
    try {
      const bytes = await readFile(sample)
      decoder.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      decoder.setHalfSize(0)
      decoder.setDemosaic(3)
      decoder.setUseCameraWb(1)
      decoder.setOutputColor(1)
      decoder.setGamma(0, 1 / 2.4)
      decoder.setGamma(1, 12.92)
      decoder.setOutputBps(8)
      decoder.unpack()
      const source = readGpuSource(decoder)!
      expect(source).not.toBeNull()
      const started = performance.now()
      const actual = await hardwareRender(gpu, source)
      const gpuMs = performance.now() - started
      const cpuStart = performance.now()
      decoder.dcrawProcess()
      const reference = decoder.dcrawMakeMemImage()
      const cpuMs = performance.now() - cpuStart
      expect([actual.width, actual.height]).toEqual([reference.width, reference.height])
      let difference = 0,
        large = 0,
        max = 0
      for (let i = 0; i < reference.width * reference.height; i++)
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs(actual.data[i * 4 + c] - reference.data[i * 3 + c])
          difference += delta
          max = Math.max(max, delta)
          if (delta > 2) large++
        }
      const samples = reference.width * reference.height * 3
      const report = {
        gpuMs,
        cpuMs,
        mean: difference / samples,
        largeFraction: large / samples,
        max,
        timings: actual.timings,
        scale: source.scale,
      }
      console.log(report)
      await writeFile(info.outputPath('comparison.json'), JSON.stringify(report, null, 2))
      await sharp(actual.data, { raw: { width: actual.width, height: actual.height, channels: 4 } })
        .resize(1280)
        .png()
        .toFile(info.outputPath('gpu.png'))
      await sharp(reference.data, {
        raw: { width: reference.width, height: reference.height, channels: 3 },
      })
        .resize(1280)
        .png()
        .toFile(info.outputPath('cpu.png'))
      expect(report.mean).toBeLessThan(0.02)
      expect(report.largeFraction).toBeLessThan(0.001)
    } finally {
      decoder.dispose()
      gpu.close()
    }
  })
}

test('ZV-1A metadata enables the verified GPU layout while unknown models stay on CPU', async () => {
  await LibRaw.initialize()
  const decoder = new LibRaw()
  await decoder.waitUntilReady()
  try {
    const bytes = await readFile('tests/fixtures/sony-zv1.ARW')
    decoder.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    decoder.unpack()
    const camera = decoder.getIParams()
    decoder.getIParams = () => ({ ...camera, normalized_model: 'ZV-1A' })
    expect(readGpuSource(decoder)).not.toBeNull()
    decoder.getIParams = () => ({ ...camera, normalized_model: 'unverified camera' })
    expect(readGpuSource(decoder)).toBeNull()
    decoder.getIParams = () => ({ ...camera, normalized_make: 'Other', normalized_model: 'ZV-1A' })
    expect(readGpuSource(decoder)).toBeNull()
    decoder.getIParams = () => ({ ...camera, normalized_model: 'ZV-1A' })
    decoder.getPixelAspect = () => 2
    expect(readGpuSource(decoder)).toBeNull()
  } finally {
    decoder.dispose()
  }
})

test('GPU stripes preserve neutral colors, black, highlights and all flip orientations', async () => {
  const gpu = new RawGpuRenderer()
  const width = 64,
    height = 600,
    rawWidth = 68
  const left = 2,
    top = 4
  const pixels = new Uint16Array(rawWidth * (height + top))
  // Flat neutral bars cross both 256-row stripe boundaries, with stored row padding.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels[(y + top) * rawWidth + x + left] = x < 16 ? 100 : x < 48 ? 10000 : 65535
  const source: RawSource = {
    pixels,
    width,
    height,
    rawWidth,
    left,
    top,
    flip: 0,
    cfa: [0, 1, 3, 2],
    black: [100, 100, 100, 100],
    scale: [1, 1, 1, 1],
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  }
  try {
    const reference = await hardwareRender(gpu, source)
    for (const x of [8, 32, 56])
      for (let y = 6; y < height - 6; y++) {
        const offset = (y * width + x) * 4
        expect(reference.data[offset]).toBe(reference.data[offset + 1])
        expect(reference.data[offset + 1]).toBe(reference.data[offset + 2])
        expect(reference.data[offset]).toBe(reference.data[(10 * width + x) * 4])
        expect(reference.data[offset + 3]).toBe(255)
      }
    expect(reference.data[(10 * width + 8) * 4]).toBe(0)
    expect(reference.data[(10 * width + 56) * 4]).toBe(255)
    for (let flip = 1; flip < 8; flip++) {
      const actual = await gpu.render({ ...source, flip })
      expect([actual.width, actual.height]).toEqual(flip & 4 ? [height, width] : [width, height])
      for (let y = 0; y < height; y += 17)
        for (let x = 0; x < width; x += 7) {
          let dx = flip & 1 ? width - 1 - x : x,
            dy = flip & 2 ? height - 1 - y : y
          if (flip & 4) [dx, dy] = [dy, dx]
          expect(
            actual.data.subarray((dy * actual.width + dx) * 4, (dy * actual.width + dx) * 4 + 4),
          ).toEqual(reference.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
        }
    }
    // Simulate an actual WebGPU device-lost notification, then verify a clean failure.
    const device = (gpu as unknown as { device: GPUDevice }).device
    device.destroy()
    await device.lost
    await expect(gpu.render(source)).rejects.toThrow('GPU device lost')
  } finally {
    gpu.close()
  }
})

test('GPU failure falls back to a complete CPU frame with its own matching placeholder', async () => {
  // This deliberately includes full CPU HDR preparation and the native-size ACES proof.
  test.setTimeout(120000)
  const output = test.info().outputPath('fallback')
  await mkdir(output, { recursive: true })
  const source = await readFile('tests/fixtures/sony-zv1.ARW')
  let gpuCalls = 0,
    extracted = false
  const engine = new PreviewEngine(
    async () => {
      extracted = true
      throw new Error('Embedded extraction must not supply the full preview.')
    },
    'auto',
    {
      render: async () => {
        gpuCalls++
        throw new Error('Simulated GPU device loss')
      },
      releaseFrame: () => {},
      close: () => {},
    },
  )
  try {
    const result = await engine.renderFull('tests/fixtures/sony-zv1.ARW', output)
    expect(gpuCalls).toBe(1)
    expect(extracted).toBe(false)
    expect(result.renderId).toBe(
      `${HDR_RAW_SOURCE_VERSION}-${HDR_ADJUSTMENT_VERSION}-${HDR_OUTPUT_VERSION}-${JSON.stringify(neutralAdjustments)}`,
    )
    expect(result).toMatchObject({
      width: 5422,
      height: 3622,
      format: 'rgba8-srgb',
      byteLength: 5422 * 3622 * 4,
      diagnostics: { backend: 'cpu', fallback: 'Error: Simulated GPU device loss' },
    })
    const frame = await readFile(`${output}/full.rgba`)
    expect(frame.length).toBe(result.byteLength)
    expect(createHash('sha256').update(frame).digest('hex')).toBe(result.sha256)
    const asset = result.linear!.hdr!
    expect(asset).toMatchObject({
      width: result.width,
      height: result.height,
      byteLength: result.width * result.height * 16,
      source: { processing: 'hdr-v1', colorSpace: 'rec2020', transfer: 'linear' },
    })
    expect(result.linear!.byteLength).toBe(asset.byteLength)
    expect(result.linear!.sha256).toBe(asset.sha256)
    const wb = hdrAdjustmentMatrix(neutralAdjustments, asset.whiteBalance) ?? undefined
    let offset = 0,
      invalidAlpha = false,
      aboveWhite = false,
      negative = false
    let firstDifference:
      { position: number; channel: number; actual: number; expected: number } | undefined
    for await (const strip of readHdrStrips(`${output}/linear.f32`, asset)) {
      aboveWhite ||= strip.some((value, index) => index % 4 !== 3 && value > 1)
      negative ||= strip.some((value, index) => index % 4 !== 3 && value < 0)
      for (let sample = 0; sample < 32; sample++) {
        const local = Math.floor(((sample + 0.5) * strip.length) / (32 * 4)) * 4
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
      }
      offset += strip.length / 4
    }
    for (let i = 3; i < frame.length; i += 4) invalidAlpha ||= frame[i] !== 255
    expect(offset).toBe(result.width * result.height)
    expect(firstDifference).toBeUndefined()
    expect(invalidAlpha).toBe(false)
    expect(aboveWhite).toBe(true)
    expect(negative).toBe(true)
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
    const placeholder = await sharp(thumbnail, { raw: { width, height, channels: 4 } })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    const actualPlaceholder = await readFile(`${output}/placeholder.png`)
    expect(actualPlaceholder.length).toBe(result.placeholderBytes)
    expect(actualPlaceholder).toEqual(placeholder)
    expect(await sharp(actualPlaceholder).metadata()).toMatchObject({
      width,
      height,
      hasProfile: true,
    })
    expect((await readFile('tests/fixtures/sony-zv1.ARW')).equals(source)).toBe(true)
  } finally {
    await engine.close()
  }
})

test('native GPU exposure, contrast and highlights agree with the exported linear frame without changing neutral brightness', async () => {
  const gpu = new RawGpuRenderer()
  const { renderAdjustments, neutralAdjustments } = await import('../src/shared/adjustments')
  const source: RawSource = {
    width: 64,
    height: 32,
    rawWidth: 64,
    left: 0,
    top: 0,
    flip: 0,
    pixels: new Uint16Array(64 * 32),
    cfa: [0, 1, 3, 2],
    black: [0, 0, 0, 0],
    scale: [1, 1, 1, 1],
    matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  }
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++)
      source.pixels[y * source.width + x] = x < 10 ? 0 : x < 20 ? 6000 : x < 40 ? 20000 : 60000
  try {
    await hardwareRender(gpu, source)
    const neutral = await gpu.render(
      source,
      undefined,
      { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
      true,
    )
    expect(neutral.working).toBeDefined()
    expect(neutral.working!.data.some((value) => value > 1)).toBe(true)
    for (const ev of [-5, -1.25, 0, 1.5, 5]) {
      for (const contrast of [-100, -35, 0, 40, 100])
        for (const highlights of [-100, 0, 100]) {
          const actual = await gpu.render(source, undefined, {
            shadows: 0,
            whites: 0,
            blacks: 0,
            exposureEv: ev,
            contrast,
            highlights,
          })
          const expected = renderAdjustments(
            neutral.working!.data,
            { shadows: 0, whites: 0, blacks: 0, exposureEv: ev, contrast, highlights },
            neutral.working!.transform,
          )
          let max = 0
          for (let i = 0; i < actual.data.length; i++)
            max = Math.max(max, Math.abs(actual.data[i] - expected[i]))
          expect(max).toBeLessThanOrEqual(1)
        }
    }
    for (const adjustments of [
      ...(['shadows', 'whites', 'blacks'] as const).flatMap((key) =>
        [-100, 100].map((value) => ({ ...neutralAdjustments, [key]: value })),
      ),
      { exposureEv: 0.75, contrast: 35, highlights: -65, shadows: 100, whites: -80, blacks: 65 },
      { exposureEv: -0.5, contrast: -35, highlights: 40, shadows: -100, whites: 80, blacks: -65 },
    ]) {
      const actual = await gpu.render(source, undefined, adjustments)
      const expected = renderAdjustments(
        neutral.working!.data,
        adjustments,
        neutral.working!.transform,
      )
      expect(
        actual.data.reduce((max, value, i) => Math.max(max, Math.abs(value - expected[i])), 0),
      ).toBeLessThanOrEqual(1)
    }
  } finally {
    gpu.close()
  }
})

test('Sony RAW native highlights and combined exposure/contrast match CPU conversion of the neutral working frame', async () => {
  test.setTimeout(90000)
  const { rawDecoder } = await import('../src/main/processing/decoders')
  const { renderAdjustments, neutralAdjustments } = await import('../src/shared/adjustments')
  const session = await rawDecoder('tests/fixtures/sony-zv1.ARW')!.open(
    'tests/fixtures/sony-zv1.ARW',
  )
  const gpu = new RawGpuRenderer()
  try {
    session.unpack()
    const source = session.gpuSource()!
    await hardwareRender(gpu, source)
    const neutral = await gpu.render(
      source,
      undefined,
      { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
      true,
    )
    for (const adjustments of [
      ...(['shadows', 'whites', 'blacks'] as const).flatMap((key) =>
        [-100, 100].map((value) => ({ ...neutralAdjustments, [key]: value })),
      ),
      { exposureEv: 0.75, contrast: 35, highlights: -65, shadows: 80, whites: -40, blacks: 25 },
      { exposureEv: -0.5, contrast: -35, highlights: 40, shadows: -80, whites: 60, blacks: -30 },
      { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: -100, highlights: 0 },
      { shadows: 0, whites: 0, blacks: 0, exposureEv: -1.25, contrast: 100, highlights: 0 },
      { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: -100 },
      { shadows: 0, whites: 0, blacks: 0, exposureEv: 0.75, contrast: 35, highlights: 100 },
      { shadows: 0, whites: 0, blacks: 0, exposureEv: 1.25, contrast: -40, highlights: -65 },
    ]) {
      const actual = await gpu.render(source, undefined, adjustments)
      const expected = renderAdjustments(
        neutral.working!.data,
        adjustments,
        neutral.working!.transform,
      )
      let max = 0
      for (let i = 0; i < expected.length; i++)
        max = Math.max(max, Math.abs(expected[i] - actual.data[i]))
      expect(max).toBeLessThanOrEqual(1)
      expect(actual.timings.reusedLinear).toBe(1)
    }
  } finally {
    session.close()
    gpu.close()
  }
})
