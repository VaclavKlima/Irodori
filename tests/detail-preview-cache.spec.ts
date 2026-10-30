import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { join } from 'node:path'
import { PREVIEW_VERSION } from '../src/main/full-previews'
import { PREPARED_PROOF_VERSION } from '../src/shared/preview-frame'
import { detailLineageKey } from '../src/main/processing/detail-identity'
import { cropWorkingFrame } from '../src/main/processing/crop-frame'
import { neutralAdjustments, renderAdjustments } from '../src/shared/adjustments'
import { cropGeometry, fitCrop, identityCrop } from '../src/shared/crop'
import { SDR_TARGET } from '../src/shared/hdr'
import { neutralNoiseReduction, neutralDetailSharpening } from '../src/shared/spatial-detail'
import { canonicalDetailFrame, detailFrameJob } from './detail-frame.helpers'
import { detailCacheFixture } from './detail-preview-cache.helpers'
import { sha } from './export.helpers'

const previousBackend = process.env.IRODORI_PREVIEW_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previousBackend === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previousBackend
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('raster detail is cached before crop and reused across point edits, crop drafts, restart and neutral reset', async () => {
  const f = await detailCacheFixture(),
    signal = new AbortController().signal
  try {
    const first = await f.previews.requestEditing(f.id, randomUUID()),
      expected = canonicalDetailFrame(f.source.frame, { ...detailFrameJob(), ...f.source.job }),
      owner = f.previews.acquire(new URL(first.linear!.url!))!,
      rgba = f.previews.acquire(new URL(first.url))!
    try {
      expect(await readFile(owner.path)).toEqual(Buffer.from(expected.buffer))
      expect(await readFile(rgba.path)).toEqual(
        Buffer.from(renderAdjustments(expected, f.options.adjustments!, f.source.frame.transform)),
      )
    } finally {
      owner.release()
      rgba.release()
    }
    expect(f.counters.sources).toBe(1)
    expect(f.counters.filters).toBe(1)
    f.change({ adjustments: { ...f.options.adjustments!, exposureEv: -0.6, saturation: 35 } })
    const graded = await f.previews.requestEditing(f.id, randomUUID())
    expect(graded.linear!.url).toBe(first.linear!.url)
    expect(graded.sha256).not.toBe(first.sha256)
    expect(graded.renderId).toContain(first.linear!.sha256)
    expect(graded.renderId).toContain(PREPARED_PROOF_VERSION)
    expect(f.counters.proofs).toBe(1)
    const native = { width: f.source.frame.width, height: f.source.frame.height },
      settings = fitCrop(native, { ...identityCrop, width: 0.7, height: 0.65, angle: 3.2 })
    f.change({ crop: settings })
    const cropped = await f.previews.requestEditing(f.id, randomUUID()),
      expectedCrop = await cropWorkingFrame(
        { data: expected, ...native, transform: f.source.frame.transform },
        {
          settings,
          admission: { policy: f.source.job.policy, reservation: f.source.job.reservation },
          backend: 'cpu',
        },
        signal,
      ),
      cropOwner = f.previews.acquire(new URL(cropped.linear!.url!))!
    try {
      expect(await readFile(cropOwner.path)).toEqual(Buffer.from(expectedCrop.frame.data.buffer))
    } finally {
      cropOwner.release()
    }
    expect(cropped.crop).toEqual(cropGeometry(native, settings))
    expect(f.counters.filters).toBe(1)
    expect(f.counters.crops).toBe(1)
    const draft = await f.previews.requestCropSource(f.id, randomUUID(), f.options.revision)
    expect(draft.sourceSpace).toBe('uncropped')
    expect(draft.linear!.sha256).toBe(first.linear!.sha256)
    expect(draft.crop).toBeUndefined()
    const restored = await f.previews.requestEditing(f.id, randomUUID())
    expect(restored.url).toBe(cropped.url)
    const counts = { ...f.counters }
    await f.restart()
    const reopened = await f.previews.requestEditing(f.id, randomUUID())
    expect(reopened.url).toBe(cropped.url)
    expect(reopened.linear!.url).toBe(cropped.linear!.url)
    expect(f.previews.getDiagnostics().cacheHit).toBe(true)
    expect(f.counters).toEqual(counts)
    f.change({
      crop: { ...identityCrop },
      noiseReduction: { ...neutralNoiseReduction },
      detailSharpening: { ...neutralDetailSharpening, radius: 2.7, threshold: 13 },
    })
    const neutral = await f.previews.requestEditing(f.id, randomUUID())
    expect(neutral.linear!.sha256).toBe(f.source.job.asset.sha256)
    expect(f.counters.filters).toBe(1)
    expect(f.counters.sources).toBe(1)
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await f.close()
  }
})

test('HDR CPU references, statistics and frozen working leases bind filtered pixels while WB samples stay unfiltered', async () => {
  const f = await detailCacheFixture(true),
    signal = new AbortController().signal
  try {
    f.change({ noiseReduction: undefined, detailSharpening: undefined })
    const original = (await f.previews.requestHdr(f.id, randomUUID()))!
    f.change({
      noiseReduction: f.source.job.noiseReduction,
      detailSharpening: f.source.job.detailSharpening,
    })
    const filtered = (await f.previews.requestHdr(f.id, randomUUID()))!,
      frozen = structuredClone(f.options),
      expected = canonicalDetailFrame(f.source.frame, {
        ...detailFrameJob('rec2020'),
        ...f.source.job,
      })
    expect(filtered.linear.sha256).toBe(sha(Buffer.from(expected.buffer)))
    expect(filtered.linear.sha256).not.toBe(original.linear.sha256)
    await expect(
      f.previews.acquireCpuWorkingSource(
        { source: original.cpuSource!, expectedSettingsRevision: f.options.revision },
        signal,
      ),
    ).rejects.toThrow('identity changed')
    const cpu = await f.previews.acquireCpuWorkingSource(
        { source: filtered.cpuSource!, expectedSettingsRevision: f.options.revision },
        signal,
      ),
      frozenOwner = (await f.previews.acquireWorkingAsset(f.id, frozen, signal))!
    try {
      expect(await cpu.file.readFile()).toEqual(Buffer.from(expected.buffer))
      expect(frozenOwner.asset.sha256).toBe(filtered.linear.sha256)
      expect(frozenOwner.identity).toBe(detailLineageKey(frozenOwner.detailSource!))
      f.change({ adjustments: { ...f.options.adjustments!, exposureEv: 0.8 } })
      await cpu.check(f.options.revision, signal)
      const color = (await f.previews.requestHdr(f.id, randomUUID()))!
      expect(color.linear.url).toBe(filtered.linear.url)
      await f.previews.hdrStatistics(f.id, f.options.revision, 'working-hdr', SDR_TARGET)
      expect(f.counters.statisticsHash).toBe(filtered.linear.sha256)
      await expect(
        f.previews.proposeWhiteBalance(f.id, f.options.revision, { x: 0.5, y: 0.5, diameter: 7 }),
      ).rejects.toThrow('Captured unfiltered synthetic WB source')
      expect(f.counters.sampleHash).toBe(f.source.job.asset.sha256)
      f.change({ noiseReduction: { ...f.options.noiseReduction!, luminance: 45 } })
      await expect(cpu.check(f.options.revision, signal)).rejects.toThrow('identity changed')
      const frozenAgain = (await f.previews.acquireWorkingAsset(f.id, frozen, signal))!
      try {
        expect(frozenAgain.identity).toBe(frozenOwner.identity)
        expect(await readFile(frozenAgain.asset.path)).toEqual(Buffer.from(expected.buffer))
      } finally {
        frozenAgain.release()
      }
    } finally {
      await cpu.release()
      frozenOwner.release()
    }
    expect(f.counters.sources).toBe(1)
    expect(f.counters.filters).toBe(1)
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await f.close()
  }
})

test('filtered raster and authored-HDR cache entries recover without an evicted parent and rerender through prepared sources', async () => {
  for (const hdr of [false, true]) {
    const f = await detailCacheFixture(hdr, undefined, hdr)
    try {
      const first = await f.previews.requestEditing(f.id, randomUUID()),
        parent = (await f.entries()).find((entry) => !entry.metadata.detailSource)!
      await f.removeEntry(parent.path)
      await f.restart()
      const cached = await f.previews.requestEditing(f.id, randomUUID())
      expect(cached.url).toBe(first.url)
      expect(cached.linear!.sha256).toBe(first.linear!.sha256)
      f.change({ adjustments: { ...neutralAdjustments, exposureEv: -0.5, saturation: -15 } })
      const changed = await f.previews.requestEditing(f.id, randomUUID())
      expect(changed.linear!.url).toBe(cached.linear!.url)
      expect(changed.sha256).not.toBe(first.sha256)
      expect(f.counters.sources).toBe(1)
      expect(f.counters.filters).toBe(1)
      expect(f.counters.proofs).toBeGreaterThan(0)
      expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
    } finally {
      await f.close()
    }
  }
})

test('independent filtered stream and CPU leases survive cache pressure until both owners release', async () => {
  const f = await detailCacheFixture(true, 1),
    signal = new AbortController().signal
  try {
    const first = (await f.previews.requestHdr(f.id, randomUUID()))!,
      stream = f.previews.acquire(new URL(first.linear.url!))!,
      cpu = await f.previews.acquireCpuWorkingSource(
        { source: first.cpuSource!, expectedSettingsRevision: f.options.revision },
        signal,
      )
    try {
      f.change({ noiseReduction: { ...f.options.noiseReduction!, luminance: 30 } })
      await f.previews.requestHdr(f.id, randomUUID())
      expect((await stat(stream.path)).size).toBe(first.linear.byteLength)
      expect(await readFile(stream.path)).toEqual(await cpu.file.readFile())
      await cpu.release()
      await cpu.release()
      await f.previews.release()
      expect((await stat(stream.path)).size).toBe(first.linear.byteLength)
      stream.release()
      stream.release()
      await f.previews.release()
      await expect(stat(stream.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.previews.acquire(new URL(first.linear.url!))).toBeUndefined()
    } finally {
      stream.release()
      await cpu.release()
    }
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await f.close()
  }
})

test('removal waits for a cancelled detail request and cleans only its unpublished output before retry', async () => {
  const f = await detailCacheFixture(),
    entered = gate(),
    proceed = gate()
  f.beforeDetail(async (_job, signal) => {
    entered.resolve()
    await proceed.promise
    signal.throwIfAborted()
  })
  try {
    const pending = f.previews.requestEditing(f.id, randomUUID()).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    )
    await entered.promise
    const parent = (await f.entries())[0]
    let removed = false
    const removal = f.previews.beginRemoval(f.id).then(() => {
      removed = true
    })
    await setImmediate()
    expect(removed).toBe(false)
    expect((await stat(join(parent.path, 'linear.f32'))).size).toBe(f.source.job.asset.byteLength)
    proceed.resolve()
    expect((await pending).error).toBeInstanceOf(Error)
    await removal
    f.previews.endRemoval(f.id, false)
    expect(
      (await readdir(join(f.root, PREVIEW_VERSION))).some((name) => name.startsWith('.tmp-')),
    ).toBe(false)
    f.beforeDetail(async () => {})
    const retried = await f.previews.requestEditing(f.id, randomUUID())
    expect(retried.linear!.sha256).not.toBe(f.source.job.asset.sha256)
    expect(f.counters.sources).toBe(1)
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    proceed.resolve()
    await f.close()
  }
})

test('recovery rejects forged lineage and same-size damaged filtered pixels without discarding their original source', async () => {
  for (const hdr of [false, true]) {
    const f = await detailCacheFixture(hdr)
    try {
      const first = await f.previews.requestEditing(f.id, randomUUID()),
        derived = (await f.entries()).find(
          (entry) => entry.metadata.detailSource && entry.metadata.linear,
        )!
      derived.metadata.detailSource.asset.path = '/must-not-open-outside-the-cache'
      await f.damageEntry(derived.path, derived.metadata)
      await f.restart()
      const recovered = await f.previews.requestEditing(f.id, randomUUID())
      expect(recovered.linear!.sha256).toBe(first.linear!.sha256)
      expect(f.counters.filters).toBe(2)
      const current = (await f.entries()).find(
          (entry) => entry.metadata.detailSource && entry.metadata.linear,
        )!,
        path = join(current.path, 'linear.f32'),
        damaged = await readFile(path)
      damaged[4] ^= 1
      await writeFile(path, damaged)
      await f.restart()
      const verified = await f.previews.requestEditing(f.id, randomUUID())
      expect(verified.linear!.sha256).toBe(first.linear!.sha256)
      expect(f.counters.filters).toBe(3)
      expect(f.counters.sources).toBe(1)
      expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
    } finally {
      await f.close()
    }
  }
})

test('refused admission and a wrong worker identity publish no detail variant and preserve the reusable source', async () => {
  const f = await detailCacheFixture()
  try {
    const denied = {
      policy: {
        ...f.source.job.policy,
        ram: { ...f.source.job.policy.ram, effectiveBytes: 1 },
      },
      reservation: f.source.job.reservation,
    }
    f.previews.installDetailAdmission(async () => denied)
    await expect(f.previews.requestEditing(f.id, randomUUID())).rejects.toThrow(
      'managed image budgets',
    )
    expect((await f.entries()).every((entry) => !entry.metadata.detailSource)).toBe(true)
    f.previews.installDetailAdmission(async () => ({
      policy: f.source.job.policy,
      reservation: f.source.job.reservation,
    }))
    f.afterDetail((frame) => ({ ...frame, detail: { ...frame.detail!, key: '0'.repeat(64) } }))
    await expect(f.previews.requestEditing(f.id, randomUUID())).rejects.toThrow(
      'inconsistent source identity',
    )
    expect((await f.entries()).every((entry) => !entry.metadata.detailSource)).toBe(true)
    expect(
      (await readdir(join(f.root, PREVIEW_VERSION))).some((name) => name.startsWith('.tmp-')),
    ).toBe(false)
    f.afterDetail((frame) => frame)
    const result = await f.previews.requestEditing(f.id, randomUUID())
    expect(result.linear!.sha256).not.toBe(f.source.job.asset.sha256)
    expect(f.counters.sources).toBe(1)
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await f.close()
  }
})

test('legacy cropped RGBA proofs rebuild from the retained raster or authored-HDR float source', async () => {
  for (const hdr of [false, true]) {
    const f = await detailCacheFixture(hdr, undefined, hdr)
    try {
      f.change({
        noiseReduction: undefined,
        detailSharpening: undefined,
        crop: fitCrop(f.source.frame, { ...identityCrop, width: 0.7, height: 0.65, angle: 3.2 }),
      })
      const first = await f.previews.requestEditing(f.id, randomUUID()),
        cropped = (await f.entries()).find(
          (entry) => entry.metadata.crop && entry.metadata.linear,
        )!,
        retiredProof = Buffer.alloc(first.byteLength),
        retiredHash = sha(retiredProof)
      delete cropped.metadata.preparedProofVersion
      cropped.metadata.variant = 'retired-crop-proof-renderer'
      cropped.metadata.sha256 = retiredHash
      cropped.metadata.renderId = 'retired-crop-proof'
      await writeFile(join(cropped.path, 'full.rgba'), retiredProof)
      await f.damageEntry(cropped.path, cropped.metadata)
      await f.restart()
      const refreshed = await f.previews.requestEditing(f.id, randomUUID())
      expect(refreshed.url).not.toBe(first.url)
      expect(refreshed.linear!.url).toBe(first.linear!.url)
      expect(refreshed.linear!.sha256).toBe(first.linear!.sha256)
      expect(refreshed.sha256).not.toBe(retiredHash)
      expect(refreshed.sha256).toBe(first.sha256)
      expect(refreshed.renderId).toContain(PREPARED_PROOF_VERSION)
      expect(f.counters.sources).toBe(1)
      expect(f.counters.crops).toBe(1)
      expect(f.counters.filters).toBe(0)
      expect(f.counters.proofs).toBe(1)
      expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
    } finally {
      await f.close()
    }
  }
})
