import { expect, test } from '@playwright/test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { exportRenditions } from '../src/main/export/renditions'
import { ExportProcess } from '../src/main/export/process'
import { rasterLinear } from '../src/main/export/raster'
import { prepareExportWorkingSource } from '../src/main/export/preparation'
import { prepareExportDetailStage } from '../src/main/export/detail'
import { exportDetailPolicy } from '../src/main/export/detail-policy'
import { encodeHdr, contentHdr, adjustHdr } from '../src/shared/hdr'
import { halfFloat } from '../src/main/export/codec'
import { prepareCreativeColor } from '../src/shared/creative-color'
import { cropWorkingFrame } from '../src/main/processing/crop-frame'
import { fitCrop, identityCrop } from '../src/shared/crop'
import { srgbTransform } from '../src/shared/adjustments'
import { detailExportFixture } from './detail-export.helpers'
import { detailCacheFixture } from './detail-preview-cache.helpers'
import { canonicalDetailFrame, detailFrameJob } from './detail-frame.helpers'
import { sha } from './export.helpers'

const previous = process.env.IRODORI_EXPORT_BACKEND
const previousPreview = process.env.IRODORI_PREVIEW_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_EXPORT_BACKEND = 'cpu'
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = previous
  if (previousPreview === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previousPreview
})

test('raster exports filter native pixels before crop, alpha flattening and point edits, including the real isolated JPEG worker', async () => {
  const f = await detailExportFixture()
  try {
    const job = f.exportJob,
      expected = f.expected()
    job.source.processing.crop = fitCrop(f.frame, {
      ...identityCrop,
      quarterTurns: 1,
      width: 0.8,
      height: 0.7,
    })
    const result = await exportRenditions(job),
      cropped = await cropWorkingFrame(
        { ...f.frame, data: expected },
        {
          settings: job.source.processing.crop,
          admission: job.cropAdmission,
          backend: 'cpu',
        },
        new AbortController().signal,
      ),
      rgb = Buffer.alloc((cropped.frame.data.length / 4) * 3)
    for (let i = 0; i < cropped.frame.data.length; i += 4) {
      const data = cropped.frame.data,
        value = rasterLinear(
          [data[i], data[i + 1], data[i + 2]],
          job.source.processing.adjustments!,
        )
      for (let c = 0; c < 3; c++)
        rgb[(i / 4) * 3 + c] = Math.round(
          encodeHdr(
            Math.max(0, Math.min(1, Math.fround(value[c] * data[i + 3] + 1 - data[i + 3]))),
          ) * 255,
        )
    }
    expect(result.rgb).toEqual(rgb)
    expect(result.diagnostics.detail!.primary!.preparation).toBe('filtered')
    expect(await readFile(join(job.preparationDirectory!, 'detail-primary.f32'))).toEqual(
      Buffer.from(expected.buffer),
    )
    const process = new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      ),
      encoded = await process.render(
        { ...job, directory: await f.directory('encoded') },
        new AbortController().signal,
      ),
      info = await sharp(encoded.path).metadata()
    expect([info.width, info.height]).toEqual([result.geometry.width, result.geometry.height])
    expect(encoded.diagnostics!.detail!.primary!.preparation).toBe('retained')
    expect(sha(await readFile(encoded.path))).toBe(encoded.sha256)
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    await f.close()
  }
})

test('HDR native filtering precedes crop, resize and both renditions while retained source variants ignore later point edits', async () => {
  const f = await detailExportFixture(true)
  try {
    const job = f.exportJob,
      expected = f.expected(),
      original = await f.originalWorkingBytes()
    job.source.processing.crop = fitCrop(f.frame, {
      ...identityCrop,
      angle: 3.2,
      width: 0.8,
      height: 0.7,
    })
    job.options.size = { mode: 'fit', width: 9, height: 7 }
    const result = await exportRenditions(job),
      referenceAsset = await f.hdrReference(expected),
      reference = await exportRenditions({
        ...job,
        directory: await f.directory('reference-output'),
        source: {
          ...job.source,
          processing: {
            ...job.source.processing,
            workingAsset: referenceAsset,
            noiseReduction: undefined,
            detailSharpening: undefined,
          },
        },
      })
    expect(result.rgb).toEqual(reference.rgb)
    expect(result.half).toEqual(reference.half)
    expect(result.geometry).toEqual(reference.geometry)
    expect(await readFile(join(job.preparationDirectory!, 'detail-working.f32'))).toEqual(
      Buffer.from(expected.buffer),
    )
    expect(result.diagnostics.detail!.working!.preparation).toBe('filtered')
    const key = result.diagnostics.detail!.working!.key
    job.source.processing.adjustments = { ...job.source.processing.adjustments!, exposureEv: -0.8 }
    const changed = await exportRenditions({ ...job, directory: await f.directory('point-output') })
    expect(changed.diagnostics.detail!.working).toMatchObject({ key, preparation: 'retained' })
    expect(changed.rgb).not.toEqual(result.rgb)
    expect(await f.originalWorkingBytes()).toEqual(original)
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    await f.close()
  }
})

test('authored HDR and its SDR primary receive independent native filtering in their own color spaces', async () => {
  const f = await detailExportFixture(true, true)
  try {
    const job = f.exportJob,
      hdr = f.expected(),
      { data, info } = await sharp(f.original)
        .autoOrient()
        .toColourspace('scrgb')
        .ensureAlpha()
        .raw({ depth: 'float' })
        .toBuffer({ resolveWithObject: true }),
      primary = canonicalDetailFrame(
        {
          data: new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4),
          width: info.width,
          height: info.height,
          transform: srgbTransform,
        },
        { ...detailFrameJob(), ...f.job },
      ),
      result = await exportRenditions(job),
      rgb = Buffer.alloc((hdr.length / 4) * 3),
      half = new Uint16Array(hdr.length),
      creative = prepareCreativeColor(job.source.processing.adjustments!)
    for (let i = 0; i < hdr.length; i += 4) {
      const a = job.source.processing.adjustments!,
        sdr = rasterLinear([primary[i], primary[i + 1], primary[i + 2]], a),
        content = contentHdr(
          adjustHdr([hdr[i], hdr[i + 1], hdr[i + 2]], a, undefined, creative),
          f.job.asset.hdr!.source,
        ).rgb,
        alpha = hdr[i + 3]
      for (let c = 0; c < 3; c++) {
        rgb[(i / 4) * 3 + c] = Math.round(
          encodeHdr(Math.max(0, Math.min(1, Math.fround(sdr[c] * alpha + 1 - alpha)))) * 255,
        )
        half[i + c] = halfFloat(
          Math.max(0, Math.min(10, Math.fround(content[c] * alpha + 1 - alpha))),
        )
      }
      half[i + 3] = 0x3c00
    }
    expect(result.rgb).toEqual(rgb)
    expect(result.half).toEqual(half)
    expect(result.diagnostics.detail!.working!.key).not.toBe(
      result.diagnostics.detail!.primary!.key,
    )
    expect(await readFile(join(job.preparationDirectory!, 'detail-primary.f32'))).toEqual(
      Buffer.from(primary.buffer),
    )
    expect(await readFile(join(job.preparationDirectory!, 'detail-working.f32'))).toEqual(
      Buffer.from(hdr.buffer),
    )
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    await f.close()
  }
})

test('filtered cache leases use frozen detail controls and avoid applying denoising twice in the real export worker', async () => {
  const cache = await detailCacheFixture(true),
    f = await detailExportFixture(true),
    signal = new AbortController().signal
  try {
    await cache.previews.requestHdr(cache.id, crypto.randomUUID())
    const frozen = structuredClone(cache.options),
      lease = (await cache.previews.acquireWorkingAsset(cache.id, frozen, signal))!
    try {
      const job = {
          ...f.exportJob,
          hdr: false,
          source: { ...f.source, photo: { ...f.source.photo, id: cache.id }, processing: frozen },
          workingAsset: {
            identity: lease.identity,
            asset: lease.asset,
            detailSource: lease.detailSource,
          },
        },
        selected = await prepareExportWorkingSource(job, signal, async () => {
          throw new Error('Must reuse filtered cache data.')
        })
      expect(selected.preparation).toBe('preview-cache')
      cache.change({ noiseReduction: { ...cache.options.noiseReduction!, luminance: 10 } })
      const worker = new ExportProcess(
          resolve('out/main/export-worker.js'),
          resolve('out/main/preview-worker.js'),
        ),
        result = await worker.render(job, signal)
      expect(result.diagnostics!.sourcePreparation).toBe('preview-cache')
      expect(result.diagnostics!.detail!.working).toMatchObject({
        key: lease.identity,
        preparation: 'preview-cache',
      })
      expect(result.diagnostics!.detail!.working!.work).toBeUndefined()
      expect(await readFile(cache.source.original)).toEqual(cache.source.originalBytes)
    } finally {
      lease.release()
    }
  } finally {
    await cache.close()
    await f.close()
  }
})

test('retained export filtering rejects corrupt descriptors and pixels while preserving completed upstream sources', async () => {
  const f = await detailExportFixture(true)
  try {
    const job = f.exportJob,
      before = await f.originalWorkingBytes(),
      first = await exportRenditions(job),
      marker = join(job.preparationDirectory!, 'detail-working.json'),
      path = join(job.preparationDirectory!, 'detail-working.f32'),
      entry = JSON.parse(await readFile(marker, 'utf8'))
    entry.lineage.asset.path = '/must-not-read-this-path'
    await writeFile(marker, JSON.stringify(entry))
    let next = await exportRenditions(job)
    expect(next.diagnostics.detail!.working!.preparation).toBe('filtered')
    const damaged = await readFile(path)
    damaged[4] ^= 1
    await writeFile(path, damaged)
    next = await exportRenditions(job)
    expect(next.diagnostics.detail!.working!.preparation).toBe('filtered')
    expect(next.rgb).toEqual(first.rgb)
    expect(next.half).toEqual(first.half)
    job.source.processing.noiseReduction = {
      ...job.source.processing.noiseReduction!,
      luminance: 45,
    }
    next = await exportRenditions(job)
    expect(next.diagnostics.detail!.working!.key).not.toBe(first.diagnostics.detail!.working!.key)
    expect(await f.originalWorkingBytes()).toEqual(before)
  } finally {
    await f.close()
  }
})

test('detail export policy, admission and cancellation reject work before publishing derived files', async () => {
  const f = await detailExportFixture(true)
  try {
    const job = f.exportJob,
      before = await f.originalWorkingBytes()
    delete job.detailPolicy
    await expect(exportRenditions(job)).rejects.toThrow('frozen operator and stage policy')
    job.detailPolicy = { ...exportDetailPolicy, stage: 'unsupported-stage' }
    await expect(exportRenditions(job)).rejects.toThrow('policy is unsupported')
    job.detailPolicy = { ...exportDetailPolicy }
    const admission = job.detailAdmission!
    delete job.detailAdmission
    await expect(exportRenditions(job)).rejects.toThrow('resource admission')
    job.detailAdmission = {
      ...admission,
      policy: { ...admission.policy, ram: { ...admission.policy.ram, effectiveBytes: 1 } },
    }
    await expect(exportRenditions(job)).rejects.toThrow('managed image budgets')
    const controller = new AbortController()
    controller.abort(new Error('Cancelled before filtering.'))
    await expect(
      prepareExportDetailStage(job, 'working', f.job.asset, admission, controller.signal),
    ).rejects.toThrow('Cancelled before filtering')
    expect(await readdir(job.preparationDirectory!)).toEqual([])
    expect(await f.originalWorkingBytes()).toEqual(before)
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    await f.close()
  }
})
