/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { encodeExportHdr, nativeEncoderPath, verifyExportEncoder } from '../src/main/export/encoder'
import { halfFloat, loadUltraHdr } from '../src/main/export/codec'
import { validatePrimary } from '../src/main/export/jpeg'
import { fromHalf, readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'

const execute = promisify(execFile)

async function tinyInput() {
  const sdr = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#707070' } })
    .withIccProfile('srgb')
    .jpeg({ quality: 100 })
    .toBuffer()
  return { sdr, half: new Uint16Array(8 * 8 * 4).fill(halfFloat(1)) }
}

test.beforeEach(async () => {
  test.skip(
    !(await nativeEncoderPath()),
    'A checksummed native encoder is required: build the Linux x64 candidate or use the existing macOS arm64 bundle.',
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
    const wasm =
      process.platform === 'linux'
        ? await encodeExportHdr(half, width, height, sdr, quality, 4, directory, 'wasm')
        : undefined
    for (const headroom of [1, 2, 4]) {
      const decoded = codec.inspect(result.output, headroom)
      if (wasm) {
        const reference = codec.inspect(wasm.output, headroom)
        expect(decoded.info).toEqual(reference.info)
        expect(decoded.stride).toBe(reference.stride)
        expect(decoded.gamut).toBe(reference.gamut)
        expect(
          Buffer.from(decoded.pixels!.buffer).equals(Buffer.from(reference.pixels!.buffer)),
          `Linux native/WASM complete reconstructed binary16 image at quality ${quality}, headroom ${headroom}`,
        ).toBe(true)
      }
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

test('Linux default Auto selects the native encoder and retains the supplied primary', async ({}, info) => {
  test.skip(process.platform !== 'linux' || process.arch !== 'x64', 'Linux x64 Auto contract.')
  const directory = info.outputPath('default-auto')
  await mkdir(directory)
  const bundle = resolve('vendor/ultrahdr')
  const { sdr, half } = await tinyInput()
  const previous = process.env.IRODORI_EXPORT_ENCODER
  try {
    delete process.env.IRODORI_EXPORT_ENCODER
    await expect(verifyExportEncoder(bundle)).resolves.toBeUndefined()
    const result = await encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, undefined, bundle)
    expect(result.backend).toBe('native')
    expect(result.memory.kind).toBe('process-rss')
    expect(result).not.toHaveProperty('fallback')
    expect(() => validatePrimary(result.output, sdr)).not.toThrow()
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_ENCODER
    else process.env.IRODORI_EXPORT_ENCODER = previous
  }
})

test('native checksums and allocation guards keep the platform Auto failure policy explicit', async ({}, info) => {
  const directory = info.outputPath('corrupt')
  await mkdir(directory)
  const bundle = join(directory, 'bundle')
  await cp(resolve('vendor/ultrahdr'), bundle, { recursive: true })
  await writeFile(
    join(bundle, `native/${process.platform}-${process.arch}/irodori-ultrahdr`),
    'corrupt',
  )
  await expect(nativeEncoderPath(bundle)).rejects.toThrow('checksum')
  const { sdr, half } = await tinyInput()
  await expect(
    encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, 'native', bundle),
  ).rejects.toThrow('checksum')
  const mandatoryNative = process.platform === 'linux' && process.arch === 'x64'
  if (mandatoryNative) {
    await expect(verifyExportEncoder(bundle, 'auto')).rejects.toThrow('checksum')
    await expect(
      encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, 'auto', bundle),
    ).rejects.toThrow('checksum')
  } else await expect(verifyExportEncoder(bundle, 'auto')).resolves.toBeUndefined()
  const result = await encodeExportHdr(
    half,
    8,
    8,
    sdr,
    100,
    1.01,
    directory,
    mandatoryNative ? 'wasm' : 'auto',
    bundle,
  )
  expect(result.backend).toBe('wasm')
  if (!mandatoryNative)
    expect(result).toMatchObject({ fallback: expect.stringContaining('checksum') })
  expect(() => validatePrimary(result.output, sdr)).not.toThrow()
  await expect(
    encodeExportHdr(half, 32768, 32768, sdr, 100, 1.01, directory, 'native'),
  ).rejects.toThrow('allocation')
})

test('Linux native availability uses the unpacked executable and rejects missing or non-executable helpers', async ({}, info) => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'x64',
    'Linux x64 availability contract.',
  )
  const directory = info.outputPath('availability')
  const bundle = join(directory, 'app.asar.unpacked', 'ultrahdr')
  const logicalBundle = join(directory, 'app.asar', 'ultrahdr')
  await cp(resolve('vendor/ultrahdr'), bundle, { recursive: true })
  const native = join(bundle, 'native', 'linux-x64')
  const executable = join(native, 'irodori-ultrahdr')
  expect(await nativeEncoderPath(logicalBundle)).toBe(executable)
  await expect(verifyExportEncoder(logicalBundle, 'auto')).resolves.toBeUndefined()
  await chmod(executable, 0o600)
  await expect(nativeEncoderPath(logicalBundle)).rejects.toMatchObject({ code: 'EACCES' })
  await expect(verifyExportEncoder(logicalBundle, 'auto')).rejects.toMatchObject({ code: 'EACCES' })
  await rm(native, { recursive: true })
  expect(await nativeEncoderPath(logicalBundle)).toBeUndefined()
  await expect(verifyExportEncoder(logicalBundle, 'auto')).rejects.toThrow('No bundled native')
  await expect(verifyExportEncoder(logicalBundle, 'wasm')).resolves.toBeUndefined()
  const { sdr, half } = await tinyInput()
  await expect(
    encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, 'auto', logicalBundle),
  ).rejects.toThrow('No bundled native')
  await expect(verifyExportEncoder(logicalBundle, 'unknown')).rejects.toThrow(
    'Invalid export encoder',
  )
  await expect(
    encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, 'unknown', logicalBundle),
  ).rejects.toThrow('Invalid export encoder')
})

test('Linux Auto propagates a checksummed native helper error without encoding a WASM replacement', async ({}, info) => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'x64',
    'Linux x64 helper failure contract.',
  )
  const directory = info.outputPath('helper-failure')
  const bundle = join(directory, 'bundle')
  await cp(resolve('vendor/ultrahdr'), bundle, { recursive: true })
  const native = join(bundle, 'native', 'linux-x64')
  const executable = join(native, 'irodori-ultrahdr')
  const script = '#!/bin/sh\necho "Deliberate native fixture failure." >&2\nexit 17\n'
  await writeFile(executable, script)
  await chmod(executable, 0o755)
  await writeFile(
    join(native, 'SHA256SUMS'),
    `${createHash('sha256').update(script).digest('hex')}  irodori-ultrahdr\n`,
  )
  await expect(verifyExportEncoder(bundle, 'auto')).resolves.toBeUndefined()
  const { sdr, half } = await tinyInput()
  await expect(
    encodeExportHdr(half, 8, 8, sdr, 100, 1.01, directory, 'auto', bundle),
  ).rejects.toThrow('Deliberate native fixture failure.')
  await expect(readFile(join(directory, 'encoder-output.jpg'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('Linux Rust codec rejects invalid dimensions, truncated or linked inputs and existing outputs', async ({}, info) => {
  test.skip(process.platform !== 'linux', 'Linux Rust codec process and mapping contract.')
  const executable = (await nativeEncoderPath())!
  const directory = info.outputPath('boundaries')
  await mkdir(directory)
  const half = join(directory, 'input.rgba16')
  const jpeg = join(directory, 'primary.jpg')
  const output = join(directory, 'output.jpg')
  await writeFile(half, Buffer.from(new Uint16Array(8 * 8 * 4).fill(halfFloat(1)).buffer))
  await writeFile(
    jpeg,
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#707070' } })
      .withIccProfile('srgb')
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toBuffer(),
  )
  const args = ['8', '8', '100', '1.01', half, jpeg, output]
  for (const invalid of [
    ['0', ...args.slice(1)],
    ['32769', ...args.slice(1)],
    [...args.slice(0, 2), '101', ...args.slice(3)],
    [...args.slice(0, 3), 'NaN', ...args.slice(4)],
  ])
    await expect(execute(executable, invalid)).rejects.toThrow('allocation or dimensions')
  const truncated = join(directory, 'short.rgba16')
  await writeFile(truncated, Buffer.alloc(8))
  await expect(
    execute(executable, [...args.slice(0, 4), truncated, ...args.slice(5)]),
  ).rejects.toThrow('input length')
  const link = join(directory, 'linked.rgba16')
  await symlink(half, link)
  await expect(execute(executable, [...args.slice(0, 4), link, ...args.slice(5)])).rejects.toThrow()
  const sentinel = Buffer.from('Existing output must survive.')
  await writeFile(output, sentinel)
  await expect(execute(executable, args)).rejects.toThrow()
  expect(await readFile(output)).toEqual(sentinel)
  const result = await execute(executable, [...args.slice(0, 6), join(directory, 'valid.jpg')])
  expect(JSON.parse(result.stdout)).toMatchObject({
    width: 8,
    height: 8,
    implementation: 'rust-ultrahdr-v1',
    peakBytes: expect.any(Number),
  })
})
