import { expect, test } from '@playwright/test'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ExportProcess } from '../src/main/export/process'
import { exportRenditions } from '../src/main/export/renditions'
import { matchesExportWorkingAsset } from '../src/main/export/detail-policy'
import { validateWorkingAsset } from '../src/main/working-assets'
import { fitCrop, identityCrop } from '../src/shared/crop'
import { detailCacheFixture } from './detail-preview-cache.helpers'
import { detailExportFixture } from './detail-export.helpers'
import { canonicalDetailFrame, detailFrameJob } from './detail-frame.helpers'

const exportBackend = process.env.IRODORI_EXPORT_BACKEND,
  previewBackend = process.env.IRODORI_PREVIEW_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_EXPORT_BACKEND = 'cpu'
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (exportBackend === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = exportBackend
  if (previewBackend === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previewBackend
})

test('a frozen raster lease reuses uncropped filtered pixels in the real worker without another decode or filter and survives independent cache eviction', async () => {
  const cache = await detailCacheFixture(false, 1),
    f = await detailExportFixture(),
    signal = new AbortController().signal
  try {
    expect(
      await cache.previews.acquireWorkingAsset(cache.id, cache.options, signal),
    ).toBeUndefined()
    await cache.previews.requestEditing(cache.id, crypto.randomUUID())
    const crop = fitCrop(cache.source.frame, {
        ...identityCrop,
        quarterTurns: 1,
        width: 0.75,
        height: 0.65,
      }),
      lease = (await cache.previews.acquireWorkingAsset(
        cache.id,
        { ...cache.options, crop },
        signal,
      ))!
    cache.change({ crop })
    const preview = await cache.previews.requestEditing(cache.id, crypto.randomUUID()),
      stream = cache.previews.acquire(new URL(preview.linear!.url!))!,
      frozen = structuredClone(cache.options),
      expected = canonicalDetailFrame(cache.source.frame, {
        ...detailFrameJob(),
        ...cache.source.job,
      })
    try {
      expect(lease.asset.hdr).toBeUndefined()
      expect([lease.asset.width, lease.asset.height]).toEqual([
        cache.source.frame.width,
        cache.source.frame.height,
      ])
      expect(await readFile(lease.asset.path)).toEqual(Buffer.from(expected.buffer))
      const source = {
          ...f.source,
          photo: { ...f.source.photo, id: cache.id },
          processing: frozen,
        },
        reference = await exportRenditions({ ...f.exportJob, source }),
        preparationDirectory = await f.directory('cache-export-preparation'),
        job = {
          ...f.exportJob,
          directory: await f.directory('cache-export'),
          preparationDirectory,
          // This worker-only guard proves that adoption never opens the original decoder.
          source: { ...source, path: join(f.root, 'decoder-must-not-open.png') },
          workingAsset: {
            identity: lease.identity,
            asset: lease.asset,
            detailSource: lease.detailSource,
          },
        }
      cache.change({ noiseReduction: { ...frozen.noiseReduction!, luminance: 12 } })
      await cache.previews.release()
      expect(matchesExportWorkingAsset(source, job.workingAsset)).toBe(true)
      expect(
        matchesExportWorkingAsset({ ...source, processing: cache.options }, job.workingAsset),
      ).toBe(false)
      const reused = await exportRenditions(job)
      expect(reused.rgb).toEqual(reference.rgb)
      expect(reused.diagnostics.detail!.primary!.preparation).toBe('preview-cache')
      expect(reused.diagnostics.detail!.primary!.work).toBeUndefined()
      const worker = new ExportProcess(
          resolve('out/main/export-worker.js'),
          resolve('out/main/preview-worker.js'),
        ),
        encoded = await worker.render(job, signal)
      expect(encoded.diagnostics!.sourcePreparation).toBe('preview-cache')
      expect(encoded.diagnostics!.detail!.primary!.key).toBe(lease.identity)
      await expect(access(join(preparationDirectory, 'detail-primary.f32'))).rejects.toThrow()
      expect(cache.counters.filters).toBe(1)
      expect(cache.counters.sources).toBe(1)
      // The cropped protocol stream and uncropped export source have independent pins.
      stream.release()
      await cache.previews.release()
      expect(await readFile(lease.asset.path)).toEqual(Buffer.from(expected.buffer))
      lease.release()
      await cache.previews.release()
      await expect(access(lease.asset.path)).rejects.toThrow()
      expect(await readFile(f.original)).toEqual(f.originalBytes)
      expect(await readFile(cache.source.original)).toEqual(cache.source.originalBytes)
    } finally {
      stream.release()
      lease.release()
    }
  } finally {
    await cache.close()
    await f.close()
  }
})

test('raster lease validation refuses corrupt bytes and malformed descriptors while cancellation does not invalidate a healthy source', async () => {
  const cache = await detailCacheFixture(),
    signal = new AbortController().signal
  try {
    const preview = await cache.previews.requestEditing(cache.id, crypto.randomUUID()),
      stream = cache.previews.acquire(new URL(preview.linear!.url!))!,
      original = await readFile(stream.path)
    try {
      const damaged = Buffer.from(original)
      damaged[0] ^= 1
      await writeFile(stream.path, damaged)
      expect(
        await cache.previews.acquireWorkingAsset(cache.id, cache.options, signal),
      ).toBeUndefined()
    } finally {
      stream.release()
    }
    await cache.previews.requestEditing(cache.id, crypto.randomUUID())
    expect(cache.counters.filters).toBe(2)
    const abort = new AbortController(),
      pending = cache.previews.acquireWorkingAsset(cache.id, cache.options, abort.signal)
    abort.abort(new Error('Cancel only this export lease.'))
    await expect(pending).rejects.toThrow('Cancel only this export lease.')
    const lease = (await cache.previews.acquireWorkingAsset(cache.id, cache.options, signal))!
    try {
      expect(await readFile(lease.asset.path)).toEqual(original)
      await expect(
        validateWorkingAsset(
          { ...lease.asset, transform: { ...lease.asset.transform, white: 0 } },
          signal,
        ),
      ).rejects.toThrow('transform')
      await expect(
        validateWorkingAsset({ ...lease.asset, byteLength: lease.asset.byteLength - 1 }, signal),
      ).rejects.toThrow('Invalid raster working asset')
      await expect(
        validateWorkingAsset({ ...lease.asset, sha256: '0'.repeat(64) }, signal),
      ).rejects.toThrow('Damaged raster working asset')
      expect(cache.counters.filters).toBe(2)
      expect(await readFile(cache.source.original)).toEqual(cache.source.originalBytes)
    } finally {
      lease.release()
    }
  } finally {
    await cache.close()
  }
})

test('authored HDR and its SDR primary use independent frozen cache leases and preserve their native export renditions', async () => {
  const cache = await detailCacheFixture(true, undefined, true),
    f = await detailExportFixture(true, true),
    signal = new AbortController().signal
  try {
    await cache.previews.requestHdr(cache.id, crypto.randomUUID())
    await cache.previews.requestEditing(cache.id, crypto.randomUUID())
    const frozen = structuredClone(cache.options),
      working = (await cache.previews.acquireWorkingAsset(cache.id, frozen, signal))!,
      primary = (await cache.previews.acquireWorkingAsset(cache.id, frozen, signal, 'primary'))!
    try {
      expect(working.asset.hdr).toBeDefined()
      expect(primary.asset.hdr).toBeUndefined()
      expect(working.identity).not.toBe(primary.identity)
      const source = {
          ...f.source,
          photo: { ...f.source.photo, id: cache.id },
          processing: { ...frozen, workingAsset: f.job.asset },
        },
        reference = await exportRenditions({ ...f.exportJob, source }),
        referenceBytes = await readFile(working.asset.path),
        primaryBytes = await readFile(primary.asset.path),
        workingAsset = {
          identity: working.identity,
          asset: working.asset,
          detailSource: working.detailSource,
        },
        primaryWorkingAsset = {
          identity: primary.identity,
          asset: primary.asset,
          detailSource: primary.detailSource,
        }
      expect(matchesExportWorkingAsset(source, primaryWorkingAsset)).toBe(false)
      expect(matchesExportWorkingAsset(source, workingAsset, true)).toBe(false)
      const job = {
          ...f.exportJob,
          source: {
            ...source,
            path: join(f.root, 'primary-decoder-must-not-open.png'),
            processing: { ...frozen, workingAsset: working.asset },
          },
          directory: await f.directory('paired-cache-export'),
          preparationDirectory: await f.directory('paired-cache-preparation'),
          workingAsset,
          primaryWorkingAsset,
        },
        reused = await exportRenditions(job)
      expect(reused.rgb).toEqual(reference.rgb)
      expect(reused.half).toEqual(reference.half)
      expect(reused.diagnostics.detail!.working!.preparation).toBe('preview-cache')
      expect(reused.diagnostics.detail!.primary!.preparation).toBe('preview-cache')
      expect(reused.diagnostics.memory!.retainedBytes).toBe(
        primary.asset.byteLength + reference.rgb.byteLength + reference.half!.byteLength,
      )
      expect(await readFile(working.asset.path)).toEqual(referenceBytes)
      expect(await readFile(primary.asset.path)).toEqual(primaryBytes)
      expect(cache.counters.filters).toBe(2)
      const worker = new ExportProcess(
          resolve('out/main/export-worker.js'),
          resolve('out/main/preview-worker.js'),
        ),
        encoded = await worker.render(
          { ...job, directory: await f.directory('paired-encoded-cache') },
          signal,
        )
      expect(encoded.diagnostics!.sourcePreparation).toBe('preview-cache')
      expect(encoded.diagnostics!.detail!.working!.preparation).toBe('preview-cache')
      expect(encoded.diagnostics!.detail!.primary!.preparation).toBe('preview-cache')
      expect(encoded.diagnostics!.memory!.hdr!.accepted).toBe(true)
    } finally {
      primary.release()
      working.release()
    }
  } finally {
    await cache.close()
    await f.close()
  }
})
