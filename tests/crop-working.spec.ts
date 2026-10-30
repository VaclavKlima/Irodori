import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareIntegerCrop } from '../src/main/processing/crop-working'
import { cropGeometry, fitCrop, identityCrop, rotateCrop } from '../src/shared/crop'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { workingAsset, sha } from './export.helpers'
import { profile } from './white-balance-picker.helpers'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-crop-working-')),
    width = 9,
    height = 131,
    data = new Float32Array(width * height * 4)
  for (let i = 0; i < data.length / 4; i++)
    data.set([-i / 7, i % 3 ? i / 13 : -0, 16 + i, (i % 5) / 4], i * 4)
  const bytes = Buffer.from(data.buffer),
    asset = workingAsset(bytes, width, height),
    path = join(root, 'source.f32')
  asset.url = 'irodori-photo://synthetic/uncropped-source'
  asset.whiteBalance = structuredClone(profile)
  await writeFile(path, bytes)
  return {
    root,
    width,
    height,
    data,
    bytes,
    asset,
    path,
    close: () => rm(root, { recursive: true, force: true }),
  }
}

test('exact crop preparation authenticates input and publishes matching strip hashes without changing color/provenance', async () => {
  const f = await fixture()
  try {
    const snapshot = structuredClone(f.asset)
    let settings = { ...identityCrop, width: 7 / f.width, height: 129 / f.height }
    for (let turn = 0; turn < 4; turn++) {
      const geometry = cropGeometry(f.asset, settings),
        destination = new Float32Array(geometry.width * geometry.height * 4),
        rows: number[] = [],
        result = await prepareIntegerCrop(
          f.path,
          f.asset,
          settings,
          join(f.root, `crop-${turn}.f32`),
          new AbortController().signal,
          destination,
          (done) => {
            rows.push(done)
          },
        )
      expect(rows).toEqual([64, 128, 131])
      expect(result.reused).toBe(false)
      expect(result.asset.width).toBe(geometry.width)
      expect(result.asset.height).toBe(geometry.height)
      expect(result.asset.byteLength).toBe(destination.byteLength)
      expect(result.asset.sha256).toBe(sha(Buffer.from(destination.buffer)))
      expect(result.asset.source).toEqual(snapshot.source)
      expect(result.asset.whiteBalance).toEqual(snapshot.whiteBalance)
      expect(result.asset.url).toBeUndefined()
      const bytes = await readFile(result.path)
      expect(bytes.equals(Buffer.from(destination.buffer))).toBe(true)
      let top = 0
      for await (const strip of readHdrStrips(result.path, result.asset)) {
        expect(
          Buffer.from(strip.buffer, strip.byteOffset, strip.byteLength).equals(
            bytes.subarray(
              top * result.asset.width * 16,
              top * result.asset.width * 16 + strip.byteLength,
            ),
          ),
        ).toBe(true)
        top += strip.length / (result.asset.width * 4)
      }
      expect(top).toBe(result.asset.height)
      settings = rotateCrop(settings, 1)
    }
    expect(f.asset).toEqual(snapshot)
    expect(await readFile(f.path)).toEqual(f.bytes)
  } finally {
    await f.close()
  }
})

test('damaged strips or whole-source identity and cancellation cannot leave a publishable crop', async () => {
  const f = await fixture()
  try {
    const settings = { ...identityCrop, width: 7 / f.width, height: 129 / f.height },
      geometry = cropGeometry(f.asset, settings),
      output = join(f.root, 'unpublished.f32')
    for (const broken of [
      { ...f.asset, sha256: '0'.repeat(64) },
      {
        ...f.asset,
        strips: f.asset.strips.map((strip, i) =>
          i === 1 ? { ...strip, sha256: '0'.repeat(64) } : strip,
        ),
      },
    ]) {
      await expect(
        prepareIntegerCrop(
          f.path,
          broken,
          settings,
          output,
          new AbortController().signal,
          new Float32Array(geometry.width * geometry.height * 4),
        ),
      ).rejects.toThrow(/Damaged HDR/)
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const abort = new AbortController(),
      rows: number[] = []
    await expect(
      prepareIntegerCrop(
        f.path,
        f.asset,
        settings,
        output,
        abort.signal,
        new Float32Array(geometry.width * geometry.height * 4),
        (done) => {
          rows.push(done)
          abort.abort(new Error('Crop cancelled between authenticated strips.'))
        },
      ),
    ).rejects.toThrow('Crop cancelled')
    expect(rows).toEqual([64])
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.path)).toEqual(f.bytes)
  } finally {
    await f.close()
  }
})

test('identity uses no destination and failures preserve existing files and the admitted source', async () => {
  const f = await fixture()
  try {
    const output = join(f.root, 'owned-by-someone-else.f32'),
      preserved = Buffer.from('Existing output must remain byte-for-byte unchanged.')
    await writeFile(output, preserved)
    const identity = await prepareIntegerCrop(
      f.path,
      f.asset,
      identityCrop,
      output,
      new AbortController().signal,
    )
    expect(identity.path).toBe(f.path)
    expect(identity.asset).toEqual(f.asset)
    expect(identity.reused).toBe(true)
    const crop = { ...identityCrop, width: 7 / f.width, height: 129 / f.height },
      geometry = cropGeometry(f.asset, crop),
      destination = new Float32Array(geometry.width * geometry.height * 4)
    await expect(
      prepareIntegerCrop(f.path, f.asset, crop, output, new AbortController().signal, destination),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(
      prepareIntegerCrop(f.path, f.asset, crop, output, new AbortController().signal),
    ).rejects.toThrow('admitted')
    await expect(
      prepareIntegerCrop(
        f.path,
        f.asset,
        fitCrop(f.asset, { ...crop, angle: 12.34 }),
        output,
        new AbortController().signal,
        destination,
      ),
    ).rejects.toThrow('spatial-filter')
    const aborted = AbortSignal.abort(new Error('Cancelled before allocation.'))
    await expect(
      prepareIntegerCrop(f.path, f.asset, crop, output, aborted, destination),
    ).rejects.toThrow('Cancelled before allocation')
    expect(await readFile(output)).toEqual(preserved)
    expect(await readFile(f.path)).toEqual(f.bytes)
  } finally {
    await f.close()
  }
})
