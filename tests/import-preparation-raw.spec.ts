import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'

test('RAW deferred fallback retains complete metadata, white balance, orientation and asset sizes', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'irodori-import-raw-'))
  const engine = new PreviewEngine(async () => {
    throw new Error('Embedded JPEG unavailable')
  })
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const input = resolve('tests/fixtures/sony-zv1.ARW')
  try {
    const hash = createHash('sha256')
      .update(await readFile(input))
      .digest('hex')
    const seed = await engine.process(input, root, 'embedded')
    expect(seed.needsFallback).toBe(true)
    expect(seed.metadata).toMatchObject({ camera: 'ZV-1', width: 5504, height: 3672 })
    expect(seed.processing?.whiteBalance?.provider).toBe('sony-zv1-white-balance')
    expect(seed.processing?.hdrEligible).toBe(true)
    const prepared = await worker.prepare(input, root, new AbortController().signal, true, seed)
    expect(prepared.needsFallback).toBeUndefined()
    expect(prepared.source).toBe('decoded')
    expect(prepared.processing).toEqual(seed.processing)
    expect(prepared.captureMetadata).toEqual(seed.captureMetadata)
    // ExifTool dimensions are provisional until sensor decoding determines the native frame.
    expect(prepared.metadata).toEqual({ ...seed.metadata, width: 5496, height: 3672 })
    expect(await sharp(join(root, 'preview.jpg')).metadata()).toMatchObject({ width: 2560 })
    expect(await sharp(join(root, 'thumb.jpg')).metadata()).toMatchObject({ width: 480 })
    expect(
      createHash('sha256')
        .update(await readFile(input))
        .digest('hex'),
    ).toBe(hash)
  } finally {
    await worker.close()
    await engine.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('two independent preparation workers keep ExifTool warm and produce identical RAW contracts', async () => {
  const roots = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'irodori-preparation-'))))
  const first = new PreviewProcess(resolve('out/main/preview-worker.js')),
    second = first.createWorker()
  try {
    const prepared = await Promise.all(
      [first, second].map((worker, index) =>
        worker.prepare(
          resolve('tests/fixtures/sony-zv1.ARW'),
          roots[index],
          new AbortController().signal,
          false,
        ),
      ),
    )
    expect(prepared.every((r) => r.source === 'embedded')).toBe(true)
    expect(prepared[0].metadata).toEqual(prepared[1].metadata)
    expect(prepared[0].processing).toEqual(prepared[1].processing)
    expect(await readFile(join(roots[0], 'thumb.jpg'))).toEqual(
      await readFile(join(roots[1], 'thumb.jpg')),
    )
    const repeated = await first.prepare(
      resolve('tests/fixtures/sony-zv1.ARW'),
      roots[0],
      new AbortController().signal,
      false,
    )
    expect(repeated.processing).toEqual(prepared[0].processing)
  } finally {
    await first.close()
    await second.close()
    await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })))
  }
})
