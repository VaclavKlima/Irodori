/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { test, expect } from '@playwright/test'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { encodeExportHdr, nativeEncoderPath } from '../src/main/export/encoder'
import { halfFloat, loadUltraHdr } from '../src/main/export/codec'
import { validatePrimary } from '../src/main/export/jpeg'
import { fromHalf, readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'

test.beforeEach(() => {
  test.skip(
    process.platform !== 'darwin' || process.arch !== 'arm64',
    'The bundled native encoder requires macOS arm64.',
  )
})

for (const [quality, tolerance] of [
  [100, 0.03],
  [90, 0.05],
  [80, 0.1],
])
  test(`native best-quality encoder preserves the primary and independent HDR reconstruction at quality ${quality}`, async ({}, info) => {
    const directory = info.outputPath('native')
    await mkdir(directory)
    const width = 384,
      height = 65
    const patches = [
      [0.18, 0.18, 0.18],
      [1, 1, 1],
      [4, 0.1, 0.03],
      [0.08, 4, 0.12],
      [0.05, 0.12, 4],
      [2, 1, 0.5],
    ]
    const half = new Uint16Array(width * height * 4)
    const primary = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = patches[Math.floor(x / 64)],
          index = y * width + x
        for (let c = 0; c < 3; c++) {
          half[index * 4 + c] = halfFloat(p[c])
          const v = Math.min(1, p[c])
          primary[index * 3 + c] = Math.round(
            (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255,
          )
        }
        half[index * 4 + 3] = halfFloat(1)
      }
    const sdr = await sharp(primary, { raw: { width, height, channels: 3 } })
      .withIccProfile('srgb')
      .withExif({ IFD0: { Artist: 'Fixture author' } })
      .jpeg({ quality, chromaSubsampling: '4:4:4' })
      .toBuffer()
    const result = await encodeExportHdr(half, width, height, sdr, quality, 4, directory, 'native')
    expect(result.backend).toBe('native')
    expect(() => validatePrimary(result.output, sdr)).not.toThrow()
    const ordinary = await sharp(result.output).raw().toBuffer()
    expect(ordinary.equals(await sharp(sdr).raw().toBuffer())).toBe(true)
    const parsed = readGainJpeg(result.output)
    const gain = await sharp(parsed.gain, { ignoreIcc: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(gain.info).toMatchObject({ width, height, channels: 3 })
    expect(parsed.metadata.alternateHeadroom).toBeCloseTo(2, 5)
    const codec = await loadUltraHdr()
    for (const headroom of [1, 2, 4]) {
      const decoded = codec.inspect(result.output, headroom)
      for (let p = 0; p < patches.length; p++) {
        const index = 32 * width + p * 64 + 32
        const base = to2020([0, 1, 2].map((c) => srgbLinear(ordinary[index * 3 + c] / 255)))
        const map = [0, 1, 2].map((c) => gain.data[index * 3 + c] / 255)
        const expected = reconstruct(base, map, parsed.metadata, headroom)
        for (let c = 0; c < 3; c++) {
          expect(
            Math.abs(
              fromHalf(decoded.pixels![(32 * decoded.stride! + p * 64 + 32) * 4 + c]) - expected[c],
            ),
          ).toBeLessThan(0.02)
          if (headroom === 4)
            expect(
              Math.abs(expected[c] - patches[p][c]) / Math.max(0.01, patches[p][c]),
            ).toBeLessThanOrEqual(tolerance)
        }
      }
    }
  })

test('native checksums and allocation guards fail explicitly, with a validated WASM fallback in Auto', async ({}, info) => {
  const directory = info.outputPath('corrupt')
  await mkdir(directory)
  const bundle = join(directory, 'bundle')
  await cp(resolve('vendor/ultrahdr'), bundle, { recursive: true })
  await writeFile(join(bundle, 'native/darwin-arm64/luma-ultrahdr'), 'corrupt')
  await expect(nativeEncoderPath(bundle)).rejects.toThrow('checksum')
  const sdr = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#707070' } })
    .withIccProfile('srgb')
    .jpeg({ quality: 100 })
    .toBuffer()
  const half = new Uint16Array(8 * 8 * 4).fill(halfFloat(1))
  await expect(
    encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, 'native', bundle),
  ).rejects.toThrow('checksum')
  const result = await encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, 'auto', bundle)
  expect(result).toMatchObject({ backend: 'wasm', fallback: expect.stringContaining('checksum') })
  expect(() => validatePrimary(result.output, sdr)).not.toThrow()
  await expect(
    encodeExportHdr(half, 32768, 32768, sdr, 100, 1.01, directory, 'native'),
  ).rejects.toThrow('allocation')
})
