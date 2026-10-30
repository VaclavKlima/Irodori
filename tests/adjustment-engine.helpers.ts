import { expect, test } from '@playwright/test'
import { access, mkdir, readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import {
  renderAdjustments,
  neutralAdjustments,
  type AdjustmentParameters,
} from '../src/shared/adjustments'
import { adjustHdr, outputHdr, encodeHdr, hdrAdjustmentMatrix, SDR_TARGET } from '../src/shared/hdr'
import type { FullPreviewResult } from '../src/main/preview-types'
import type { ProcessingMetadata } from '../src/shared/lens'
import { noLensSettings } from '../src/shared/lens'

async function fileHash(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function rawEngineAgreement(
  engine: PreviewEngine,
  metadata: ProcessingMetadata,
  source: string,
  root: string,
) {
  // Preserve all nine native-size CPU proofs and full-image reference comparisons.
  // ACES adds substantial per-pixel work; this correctness budget is not a performance gate.
  test.setTimeout(900000)
  const originalHash = await fileHash(source)
  const options = { metadata, settings: noLensSettings, revision: 0, prepareLinear: true }
  const prepared = join(root, 'prepared')
  await mkdir(prepared)
  try {
    const neutral = await engine.renderFull(source, prepared, undefined, options)
    const linear = neutral.linear!
    const asset = linear.hdr!
    expect(asset.source).toMatchObject({
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      transfer: 'linear',
      alpha: 'straight',
    })
    expect(neutral.appliedCorrections).toEqual(noLensSettings)
    const path = join(prepared, 'linear.f32')
    expect(await fileHash(path)).toBe(asset.sha256)
    const bytes = await readFile(path)
    expect(bytes.byteLength).toBe(neutral.width * neutral.height * 16)
    const working = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    const workingAsset = { ...linear, path, width: neutral.width, height: neutral.height }
    const verify = async (
      result: FullPreviewResult,
      output: string,
      adjustments: AdjustmentParameters,
    ) => {
      expect(result).toMatchObject({
        format: 'rgba8-srgb',
        width: neutral.width,
        height: neutral.height,
        byteLength: neutral.width * neutral.height * 4,
        adjustments,
      })
      const pixels = await readFile(join(output, 'full.rgba'))
      expect(pixels.byteLength).toBe(result.byteLength)
      expect(createHash('sha256').update(pixels).digest('hex')).toBe(result.sha256)
      const expected = Buffer.alloc(pixels.byteLength)
      const wb = hdrAdjustmentMatrix(adjustments, asset.whiteBalance) ?? undefined
      for (let i = 0; i < working.length; i += 4) {
        const rgb = outputHdr(
          adjustHdr([working[i], working[i + 1], working[i + 2]], adjustments, wb),
          SDR_TARGET,
        ).rgb
        for (let c = 0; c < 3; c++) expected[i + c] = Math.round(encodeHdr(rgb[c]) * 255)
        expected[i + 3] = Math.round(working[i + 3] * 255)
      }
      // Retain exact CPU quantization across every RGB and alpha sample.
      expect(pixels.equals(expected)).toBe(true)
      return pixels
    }
    const pixels = await verify(neutral, prepared, neutralAdjustments)
    const warm = async (name: string, adjustments: AdjustmentParameters) => {
      const output = join(root, name)
      await mkdir(output)
      // A validated working asset must render without opening the original again.
      const result = await engine.renderFull(
        join(root, 'unavailable-original.ARW'),
        output,
        undefined,
        {
          ...options,
          workingAsset,
          adjustments,
          revision: 1,
        },
      )
      await expect(access(join(output, 'linear.f32'))).rejects.toThrow()
      await verify(result, output, adjustments)
      expect(await fileHash(path)).toBe(asset.sha256)
    }
    await warm('combined', {
      saturation: 0,
      vibrance: 0,
      shadows: 65,
      whites: -35,
      blacks: -20,
      exposureEv: -1.5,
      contrast: 60,
      highlights: -75,
    })
    for (const key of ['shadows', 'whites', 'blacks'] as const)
      await warm(`warm-${key}`, { ...neutralAdjustments, [key]: key === 'blacks' ? -65 : 75 })
    await engine.close()
    for (const key of ['highlights', 'shadows', 'whites', 'blacks'] as const) {
      const cold = new PreviewEngine(undefined, 'cpu')
      const output = join(root, `cold-${key}`)
      await mkdir(output)
      try {
        const adjustments = { ...neutralAdjustments, [key]: -100 }
        const result = await cold.renderFull(source, output, undefined, {
          metadata,
          settings: noLensSettings,
          revision: 2,
          adjustments,
        })
        expect(result.appliedCorrections).toEqual(noLensSettings)
        expect(result.linear!.hdr!.sha256).toBe(asset.sha256)
        expect(await fileHash(join(output, 'linear.f32'))).toBe(asset.sha256)
        expect((await verify(result, output, adjustments)).equals(pixels)).toBe(false)
      } finally {
        await cold.close()
      }
    }
    expect(await fileHash(path)).toBe(asset.sha256)
  } finally {
    expect(await fileHash(source)).toBe(originalHash)
  }
}

export function engineAgreement(formats: readonly ('png' | 'tiff' | 'jpeg' | 'raw')[]) {
  for (const format of formats)
    test(`${format} uses float originals and reuses working pixels for combined adjustments`, async () => {
      const root = test.info().outputPath(format)
      await mkdir(root, { recursive: true })
      const source =
        format === 'raw' ? 'tests/fixtures/sony-zv1.ARW' : join(root, `source.${format}`)
      if (format !== 'raw')
        await sharp(Buffer.from([120, 80, 200, 128, 255, 255, 255, 255]), {
          raw: { width: 2, height: 1, channels: 4 },
        })
          .toFormat(format)
          .toFile(source)
      const engine = new PreviewEngine(undefined, 'cpu')
      try {
        const metadata = await engine.inspect(source)
        if (format === 'raw') {
          await rawEngineAgreement(engine, metadata, source, root)
          return
        }
        const options = { metadata, settings: noLensSettings, revision: 0, prepareLinear: true }
        const neutral = await engine.renderFull(source, root, undefined, options)
        const pixels = await readFile(join(root, 'full.rgba'))
        const reference = await sharp(source)
          .withIccProfile('srgb')
          .toColourspace('srgb')
          .ensureAlpha()
          .raw()
          .toBuffer()
        expect(
          pixels.reduce((max, value, i) => Math.max(max, Math.abs(value - reference[i])), 0),
        ).toBeLessThanOrEqual(1)
        const bytes = await readFile(join(root, 'linear.f32'))
        const working = new Float32Array(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        )
        const adjusted = await engine.renderFull(source, root, undefined, {
          ...options,
          adjustments: {
            saturation: 0,
            vibrance: 0,
            shadows: 65,
            whites: -35,
            blacks: -20,
            exposureEv: -1.5,
            contrast: 60,
            highlights: -75,
          },
          revision: 1,
        })
        expect(adjusted.diagnostics?.timings.reusedWorking).toBe(1)
        const expectedCombined = Buffer.from(
          renderAdjustments(
            working,
            {
              saturation: 0,
              vibrance: 0,
              shadows: 65,
              whites: -35,
              blacks: -20,
              exposureEv: -1.5,
              contrast: 60,
              highlights: -75,
            },
            neutral.linear!.transform,
          ),
        )
        expect((await readFile(join(root, 'full.rgba'))).equals(expectedCombined)).toBe(true)
        for (const key of ['shadows', 'whites', 'blacks'] as const) {
          const adjustments = { ...neutralAdjustments, [key]: key === 'blacks' ? -65 : 75 }
          const result = await engine.renderFull(source, root, undefined, {
            ...options,
            adjustments,
          })
          expect(result.diagnostics?.timings.reusedWorking).toBe(1)
          const expected = Buffer.from(
            renderAdjustments(working, adjustments, neutral.linear!.transform),
          )
          expect((await readFile(join(root, 'full.rgba'))).equals(expected)).toBe(true)
        }
      } finally {
        await engine.close()
      }
    })
}
