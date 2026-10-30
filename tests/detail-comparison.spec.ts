import { expect, test } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { cropWorkingFrame } from '../src/main/processing/crop-frame'
import { PREVIEW_VERSION } from '../src/main/full-previews'
import { fitCrop, identityCrop } from '../src/shared/crop'
import { neutralAdjustments, renderAdjustments } from '../src/shared/adjustments'
import { PREPARED_COMPARISON_VERSION } from '../src/shared/prepared-comparison'
import { detailCacheFixture } from './detail-preview-cache.helpers'

const previous = process.env.IRODORI_PREVIEW_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previous === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previous
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test('raster Before bypasses native filtering and point edits on the identical committed crop while preserving After and reusing preparation', async () => {
  const f = await detailCacheFixture(),
    signal = new AbortController().signal
  try {
    f.change({
      crop: fitCrop(f.source.frame, { ...identityCrop, angle: 3.2, width: 0.8, height: 0.7 }),
    })
    const after = await f.previews.requestEditing(f.id, crypto.randomUUID()),
      frozen = structuredClone(f.options),
      owner = f.previews.acquire(new URL(after.linear!.url!))!,
      afterBytes = await readFile(owner.path),
      expected = await cropWorkingFrame(
        f.source.frame,
        {
          settings: f.options.crop!,
          backend: 'cpu',
          admission: { policy: f.source.job.policy, reservation: f.source.job.reservation },
        },
        signal,
      )
    owner.release()
    let firstUrl = ''
    for (let i = 0; i < 2; i++) {
      const token = crypto.randomUUID(),
        before = await f.previews.requestComparison(after.workingSource!, token, frozen.revision),
        source = f.previews.acquire(new URL(before.linear!.url!))!,
        proof = f.previews.acquire(new URL(before.url))!
      try {
        expect(before.comparisonOf).toEqual({
          version: PREPARED_COMPARISON_VERSION,
          after: after.workingSource,
          settingsRevision: frozen.revision,
        })
        expect(before.crop).toEqual(after.crop)
        expect([before.width, before.height]).toEqual([after.width, after.height])
        expect(before.adjustments).toEqual(neutralAdjustments)
        expect(await readFile(source.path)).toEqual(Buffer.from(expected.frame.data.buffer))
        expect(await readFile(source.path)).not.toEqual(afterBytes)
        expect(await readFile(proof.path)).toEqual(
          Buffer.from(
            renderAdjustments(expected.frame.data, neutralAdjustments, expected.frame.transform),
          ),
        )
        if (firstUrl) expect(before.linear!.url).toBe(firstUrl)
        firstUrl = before.linear!.url!
      } finally {
        source.release()
        proof.release()
        await f.previews.release(token)
      }
    }
    const afterOwner = f.previews.acquire(new URL(after.linear!.url!))!
    try {
      expect(await readFile(afterOwner.path)).toEqual(afterBytes)
    } finally {
      afterOwner.release()
    }
    expect(f.options).toEqual(frozen)
    expect(f.counters).toMatchObject({ sources: 1, filters: 1, crops: 2 })
    expect(f.previews.getDiagnostics().renderingIdentity).toBe(after.renderId)
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await f.close()
  }
})

test('HDR Before leases original floats independently and requires explicit comparison lineage for native CPU access', async () => {
  const f = await detailCacheFixture(true, 1),
    signal = new AbortController().signal
  try {
    const after = (await f.previews.requestHdr(f.id, crypto.randomUUID()))!,
      token = crypto.randomUUID(),
      before = await f.previews.requestComparison(after.workingSource!, token, f.options.revision)
    expect(before.linear!.hdr).toBeDefined()
    expect(before.linear!.sha256).toBe(f.source.job.asset.sha256)
    expect(before.linear!.sha256).not.toBe(after.linear.sha256)
    const request = { source: before.cpuSource!, expectedSettingsRevision: f.options.revision }
    await expect(f.previews.acquireCpuWorkingSource(request, signal)).rejects.toThrow(
      'identity changed',
    )
    const lease = await f.previews.acquireCpuWorkingSource(request, signal, after.workingSource!)
    try {
      await f.previews.release(token)
      await f.previews.release(after.requestId)
      await lease.check(f.options.revision, signal)
      expect(await lease.file.readFile()).toEqual(await readFile(f.source.job.asset.path))
      f.change({ noiseReduction: { ...f.options.noiseReduction!, luminance: 15 } })
      await expect(lease.check(f.options.revision, signal)).rejects.toThrow('identity changed')
    } finally {
      await lease.release()
    }
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await f.close()
  }
})

test('authored HDR comparison keeps the HDR working baseline and SDR primary baseline in distinct domains', async () => {
  const f = await detailCacheFixture(true, undefined, true)
  try {
    const hdrAfter = (await f.previews.requestHdr(f.id, crypto.randomUUID()))!,
      hdrToken = crypto.randomUUID(),
      hdrBefore = await f.previews.requestComparison(
        hdrAfter.workingSource!,
        hdrToken,
        f.options.revision,
      )
    expect(hdrBefore.linear!.hdr!.source.display).toBeDefined()
    expect(hdrBefore.linear!.sha256).toBe(f.source.job.asset.sha256)
    await f.previews.release(hdrToken)
    const after = await f.previews.requestEditing(f.id, crypto.randomUUID()),
      token = crypto.randomUUID(),
      before = await f.previews.requestComparison(after.workingSource!, token, f.options.revision)
    try {
      expect(before.linear!.hdr).toBeUndefined()
      expect(before.linear!.sha256).not.toBe(hdrBefore.linear!.sha256)
      expect(before.linear!.transform.white).toBe(1)
      expect(before.comparisonOf!.after).toEqual(after.workingSource)
      expect(f.counters.filters).toBe(2)
      expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
    } finally {
      await f.previews.release(token)
    }
  } finally {
    await f.close()
  }
})

test('comparison capability, revision, single-owner and memory refusals leave the current After source available', async () => {
  const f = await detailCacheFixture()
  try {
    const after = await f.previews.requestEditing(f.id, crypto.randomUUID()),
      token = crypto.randomUUID(),
      input = { ...after.workingSource! },
      frozen = { ...input },
      pending = f.previews.requestComparison(input, token, f.options.revision)
    Object.assign(input, { workingSha256: '0'.repeat(64) })
    const before = await pending
    expect(before.comparisonOf!.after).toEqual(frozen)
    await expect(
      f.previews.requestComparison(frozen, crypto.randomUUID(), f.options.revision),
    ).rejects.toThrow('already in use')
    await f.previews.release(token)
    for (const [source, revision, id] of [
      [{ ...frozen, workingSha256: '0'.repeat(64) }, f.options.revision, crypto.randomUUID()],
      [frozen, f.options.revision + 1, crypto.randomUUID()],
      [frozen, f.options.revision, after.requestId],
    ] as const)
      await expect(f.previews.requestComparison(source, id, revision)).rejects.toThrow()
    const normal = { policy: f.source.job.policy, reservation: f.source.job.reservation },
      limited = structuredClone(normal)
    Object.assign(limited.policy.ram, { effectiveBytes: limited.reservation.ramBytes + 1 })
    f.previews.installDetailAdmission(async () => limited)
    await expect(
      f.previews.requestComparison(frozen, crypto.randomUUID(), f.options.revision),
    ).rejects.toThrow('managed image budgets')
    f.previews.installDetailAdmission(async () => normal)
    const healthy = await f.previews.requestComparison(
      frozen,
      crypto.randomUUID(),
      f.options.revision,
    )
    await f.previews.release(healthy.requestId)
    const owner = f.previews.acquire(new URL(after.linear!.url!))!
    expect(owner).toBeTruthy()
    owner.release()
    expect(f.counters.filters).toBe(1)
  } finally {
    await f.close()
  }
})

for (const ending of ['release', 'revision', 'removal', 'close'] as const)
  test(`comparison ${ending} drains a pending crop and cleans only its owned unpublished output`, async () => {
    const f = await detailCacheFixture(),
      entered = gate(),
      resume = gate()
    try {
      f.change({
        crop: fitCrop(f.source.frame, { ...identityCrop, angle: 2, width: 0.8, height: 0.7 }),
      })
      const after = await f.previews.requestEditing(f.id, crypto.randomUUID()),
        token = crypto.randomUUID()
      f.beforeCrop(async (_job, signal) => {
        entered.resolve()
        await resume.promise
        signal.throwIfAborted()
      })
      const work = f.previews
        .requestComparison(after.workingSource!, token, f.options.revision)
        .then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        )
      await entered.promise
      let retired = false
      const retirement =
        ending === 'release'
          ? f.previews.release(token)
          : ending === 'removal'
            ? f.previews.beginRemoval(f.id)
            : ending === 'close'
              ? f.previews.close()
              : (f.change({ adjustments: { ...f.options.adjustments!, exposureEv: 1 } }),
                Promise.resolve())
      void retirement.then(() => {
        retired = true
      })
      await setImmediate()
      if (ending !== 'revision') expect(retired).toBe(false)
      resume.resolve()
      await retirement
      expect((await work).ok).toBe(false)
      if (ending === 'removal') f.previews.endRemoval(f.id, false)
      expect(
        (await readdir(join(f.root, PREVIEW_VERSION))).some((name) => name.startsWith('.tmp-')),
      ).toBe(false)
      expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
      if (ending === 'release') {
        f.beforeCrop(async () => {})
        const again = await f.previews.requestComparison(
          after.workingSource!,
          crypto.randomUUID(),
          f.options.revision,
        )
        await f.previews.release(again.requestId)
      }
    } finally {
      resume.resolve()
      await f.close()
    }
  })
