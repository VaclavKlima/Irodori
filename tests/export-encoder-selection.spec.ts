import { expect, test } from '@playwright/test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { halfFloat } from '../src/main/export/codec'
import {
  encodeExportHdr,
  selectedExportEncoder,
  verifyExportEncoder,
} from '../src/main/export/encoder'

test('Auto selects the qualified encoder before execution and never restarts a failed native job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-encoder-selection-'))
  try {
    const bundle = join(root, 'bundle')
    await cp(resolve('vendor/ultrahdr'), bundle, { recursive: true })
    const target = join(bundle, `native/${process.platform}-${process.arch}`)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'irodori-ultrahdr'), 'deliberately invalid candidate')
    await writeFile(join(target, 'SHA256SUMS'), `${'a'.repeat(64)}  irodori-ultrahdr\n`)
    const expected =
      (process.platform === 'linux' && process.arch === 'x64') ||
      (process.platform === 'darwin' && process.arch === 'arm64')
        ? 'native'
        : 'wasm'
    expect(selectedExportEncoder()).toBe(expected)
    const sdr = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#707070' } })
        .withIccProfile('srgb')
        .jpeg()
        .toBuffer(),
      half = new Uint16Array(8 * 8 * 4).fill(halfFloat(1))
    const failed = join(root, 'failed')
    await mkdir(failed)
    await expect(
      encodeExportHdr(half, 8, 8, sdr, 90, 1.01, failed, 'native', bundle),
    ).rejects.toThrow('checksum')
    if (expected === 'wasm') {
      await expect(verifyExportEncoder(bundle)).resolves.toBeUndefined()
      const output = join(root, 'selected')
      await mkdir(output)
      const result = await encodeExportHdr(half, 8, 8, sdr, 90, 1.01, output, 'auto', bundle)
      expect(result.backend).toBe('wasm')
      expect(result.fallback).toBeUndefined()
    } else await expect(verifyExportEncoder(bundle)).rejects.toThrow('checksum')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
