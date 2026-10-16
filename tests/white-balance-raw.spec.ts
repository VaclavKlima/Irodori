import { correctionPlan } from '../src/main/processing/lens-correction'
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { neutralAdjustments, renderAdjustments } from '../src/shared/adjustments'
import { automaticLensSettings, noLensSettings } from '../src/shared/lens'
import { librawDecoder } from '../src/main/processing/decoders/libraw'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { resolveWhiteBalance } from '../src/main/processing/white-balance'
import {
  adjustHdr,
  encodeHdr,
  hdrAdjustmentMatrix,
  hdrWhiteBalance,
  HDR_ADJUSTMENT_VERSION,
  HDR_OUTPUT_VERSION,
  HDR_RAW_SOURCE_VERSION,
  outputHdr,
  SDR_TARGET,
} from '../src/shared/hdr'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('Sony gains and camera matrices support custom WB with native GPU/CPU agreement and retained working pixels', async () => {
  // Two correction variants each retain native CPU preparation, edited proof and full reference.
  test.setTimeout(360000)
  const path = 'tests/fixtures/sony-zv1.ARW',
    root = test.info().outputPath('wb')
  await mkdir(root, { recursive: true })
  const sourceSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
  expect(sha256(await readFile(path))).toBe(sourceSha256)
  const session = await librawDecoder.open(path),
    gpu = new RawGpuRenderer(),
    engine = new PreviewEngine(undefined, 'cpu')
  try {
    const profile = resolveWhiteBalance(session.metadata)
    expect(profile).toBeDefined()
    session.unpack()
    const source = session.gpuSource()!
    const cameraBytes = Buffer.from(
        source.pixels.buffer,
        source.pixels.byteOffset,
        source.pixels.byteLength,
      ),
      cameraSha256 = sha256(cameraBytes)
    source.whiteBalance = profile
    const neutral = await gpu.render(source, undefined, neutralAdjustments, true)
    expect(neutral.working?.transform.whiteBalance).toEqual(profile)
    const working = neutral.working!,
      workingBytes = Buffer.from(
        working.data.buffer,
        working.data.byteOffset,
        working.data.byteLength,
      ),
      workingSha256 = sha256(workingBytes)
    const parameters = {
      ...neutralAdjustments,
      whiteBalance: { mode: 'custom' as const, kelvin: 8000, tint: 25 },
      exposureEv: 0.5,
      contrast: 20,
      highlights: -50,
      shadows: 30,
      whites: -20,
      blacks: 10,
    }
    const adjusted = await gpu.render(source, undefined, parameters)
    const reference = renderAdjustments(
      neutral.working!.data,
      parameters,
      neutral.working!.transform,
    )
    let max = 0
    for (let i = 0; i < reference.length; i++)
      max = Math.max(max, Math.abs(reference[i] - adjusted.data[i]))
    expect(max).toBeLessThanOrEqual(1)
    expect(sha256(workingBytes)).toBe(workingSha256)
    const again = await gpu.render(source)
    expect(again.data.equals(neutral.data)).toBe(true)
    await gpu.close()
    const metadata = await engine.inspect(path)
    const plan = correctionPlan(
      source.width,
      source.height,
      metadata.lensProfile,
      automaticLensSettings,
    )
    const corrected = await gpu.render(source, plan, neutralAdjustments, true)
    const correctedWorking = corrected.working!,
      correctedBytes = Buffer.from(
        correctedWorking.data.buffer,
        correctedWorking.data.byteOffset,
        correctedWorking.data.byteLength,
      ),
      correctedSha256 = sha256(correctedBytes)
    const correctedCustom = await gpu.render(source, plan, parameters)
    const correctedReference = renderAdjustments(
      corrected.working!.data,
      parameters,
      corrected.working!.transform,
    )
    let correctedMax = 0
    for (let i = 0; i < correctedReference.length; i++)
      correctedMax = Math.max(
        correctedMax,
        Math.abs(correctedReference[i] - correctedCustom.data[i]),
      )
    expect(correctedMax).toBeLessThanOrEqual(1)
    expect(sha256(correctedBytes)).toBe(correctedSha256)
    expect(sha256(cameraBytes)).toBe(cameraSha256)
    gpu.close()
    const reports: {
      corrections: typeof noLensSettings
      workingSha256: string
      frameSha256: string
    }[] = []
    for (const [name, settings] of [
      ['uncorrected', noLensSettings],
      ['corrected', automaticLensSettings],
    ] as const) {
      const options = {
          metadata,
          settings,
          revision: 0,
          processing: 'hdr-v1' as const,
          adjustments: neutralAdjustments,
        },
        preparedOutput = join(root, `${name}-prepared`),
        adjustedOutput = join(root, `${name}-adjusted`)
      await mkdir(preparedOutput)
      await mkdir(adjustedOutput)
      // Different correction settings prepare independent working assets.
      const baseline = await engine.renderFull(path, preparedOutput, undefined, options),
        asset = baseline.linear!.hdr!,
        workingPath = join(preparedOutput, 'linear.f32')
      expect(baseline.appliedCorrections).toEqual(settings)
      expect([baseline.width, baseline.height]).toEqual(
        name === 'corrected' ? [5422, 3622] : [5496, 3672],
      )
      expect(asset.whiteBalance).toEqual(hdrWhiteBalance(metadata.whiteBalance))
      expect(asset.source.highlightBlend).toBe('sensor-blend-v1')
      expect(asset.source.normalization.referenceWhite).toBe(1)
      const result = await engine.renderFull(path, adjustedOutput, undefined, {
        ...options,
        adjustments: parameters,
        revision: 1,
        workingAsset: {
          path: workingPath,
          width: baseline.width,
          height: baseline.height,
          ...baseline.linear!,
        },
      })
      expect(result.linear).toBeUndefined()
      expect(result.settingsRevision).toBe(1)
      expect(result.format).toBe('rgba8-srgb')
      expect([result.width, result.height]).toEqual([baseline.width, baseline.height])
      expect(result.byteLength).toBe(result.width * result.height * 4)
      expect(result.renderId).toBe(
        `${HDR_RAW_SOURCE_VERSION}-${HDR_ADJUSTMENT_VERSION}-${HDR_OUTPUT_VERSION}-${JSON.stringify(parameters)}`,
      )
      expect((await readdir(adjustedOutput)).sort()).toEqual(['full.rgba', 'placeholder.png'])
      const expected = Buffer.alloc(result.byteLength),
        matrix = hdrAdjustmentMatrix(parameters, asset.whiteBalance) ?? undefined
      let offset = 0
      // Read verified Rec.2020 strips, retaining the HDR reference instead of the legacy SDR transform.
      for await (const strip of readHdrStrips(workingPath, asset)) {
        for (let i = 0; i < strip.length; i += 4) {
          const rgb = outputHdr(
            adjustHdr([strip[i], strip[i + 1], strip[i + 2]], parameters, matrix),
            SDR_TARGET,
          ).rgb
          for (let c = 0; c < 3; c++) expected[offset + i + c] = Math.round(encodeHdr(rgb[c]) * 255)
          expected[offset + i + 3] = Math.round(strip[i + 3] * 255)
        }
        offset += strip.length
      }
      expect(offset).toBe(result.byteLength)
      const pixels = await readFile(join(adjustedOutput, 'full.rgba'))
      expect(pixels.equals(expected)).toBe(true)
      expect(sha256(pixels)).toBe(result.sha256)
      const ratio = Math.min(1, 96 / Math.max(result.width, result.height)),
        width = Math.max(1, Math.round(result.width * ratio)),
        height = Math.max(1, Math.round(result.height * ratio)),
        sample = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const from =
            (Math.floor(((y + 0.5) * result.height) / height) * result.width +
              Math.floor(((x + 0.5) * result.width) / width)) *
            4
          expected.copy(sample, (y * width + x) * 4, from, from + 4)
        }
      const placeholder = await sharp(sample, { raw: { width, height, channels: 4 } })
        .withIccProfile('srgb')
        .png()
        .toBuffer()
      expect(result.placeholderBytes).toBe(placeholder.length)
      expect(await readFile(join(adjustedOutput, 'placeholder.png'))).toEqual(placeholder)
      expect(
        (await engine.statistics(join(adjustedOutput, 'full.rgba'), result)).visiblePixels,
      ).toBe(result.width * result.height)
      reports.push({
        corrections: settings,
        workingSha256: asset.sha256,
        frameSha256: result.sha256,
      })
    }
    expect(reports[0].workingSha256).not.toBe(reports[1].workingSha256)
    expect(sha256(await readFile(path))).toBe(sourceSha256)
    await writeFile(
      test.info().outputPath('white-balance-hdr.json'),
      JSON.stringify(reports, null, 2),
    )
  } finally {
    session.close()
    gpu.close()
    await engine.close()
  }
})
