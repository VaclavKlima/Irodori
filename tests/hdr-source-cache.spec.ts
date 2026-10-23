import { expect, test } from '@playwright/test'
import {
  HDR_SOURCE_CACHE_ENTRIES,
  HdrSourceCache,
  hdrSourceIdentity,
  type HdrSourceAdmission,
  type HdrSourceCandidate,
} from '../src/renderer/src/preview/hdr-source-cache'

class SourceResource {
  destroyed = 0
  constructor(readonly name: string) {}
  destroy() {
    this.destroyed++
  }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function candidate(
  name: string,
  width = 33,
  height = 65,
  completion = Promise.resolve(),
): HdrSourceCandidate<SourceResource> {
  const sha256 = name.repeat(64)
  const identity = hdrSourceIdentity({
    sha256,
    width,
    height,
    byteLength: width * height * 16,
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, index) => ({
      byteLength: width * Math.min(64, height - index * 64) * 16,
      sha256: (parseInt(name, 16) + index + 1).toString(16).padStart(64, '0'),
    })),
  })
  const plane = (count: number) => {
    const data = new Float32Array(count * 4)
    for (let index = 0; index < count; index++) data.set([0.25, 0.5, 2, 1], index * 4)
    return data
  }
  return {
    identity,
    resource: new SourceResource(name),
    mipCompletion: completion,
    samples: {
      sourceSha256: sha256,
      sample: plane(Math.min(65536, width * height)),
      draft: plane(Math.min(8192, width * height)),
    },
    verification: {
      sourceSha256: sha256,
      verifiedBytes: identity.byteLength,
      verifiedStripHashes: identity.strips.map((strip) => strip.sha256),
      eof: true,
    },
  }
}
const admission = (): HdrSourceAdmission => ({
  signal: new AbortController().signal,
  isCurrent: () => true,
})

test('source identity is detached and includes the verified manifest, geometry and mip policy', () => {
  const source = candidate('a').identity
  expect(Object.isFrozen(source)).toBe(true)
  expect(Object.isFrozen(source.strips)).toBe(true)
  expect(Object.isFrozen(source.strips[0])).toBe(true)
  expect(hdrSourceIdentity(source).key).toBe(source.key)
  expect(hdrSourceIdentity(source, 'different-mips').key).not.toBe(source.key)
  expect(candidate('b').identity.key).not.toBe(source.key)
  const strips = source.strips.map((strip) => ({ ...strip }))
  strips[0].sha256 = 'f'.repeat(64)
  expect(hdrSourceIdentity({ ...source, strips }).key).not.toBe(source.key)
  expect(candidate('a', 65, 33).identity.key).not.toBe(source.key)
  const tiny = candidate('a', 2, 2).identity
  expect(tiny.mipLevels).toBe(2)
  expect(tiny.textureBytes).toBe(5 * 16)
  expect(() => hdrSourceIdentity({ ...source, byteLength: source.byteLength - 1 })).toThrow(
    'descriptor',
  )
  expect(() => hdrSourceIdentity({ ...source, strips: [] })).toThrow('descriptor')
})

test('admission owns nothing until the completed source mip fence settles', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    fence = deferred(),
    photoId = '1'.repeat(64),
    source = { ...candidate('a', 33, 65, fence.promise), photoId }
  const pending = cache.admit(device, source, admission())
  await Promise.resolve()
  expect(cache.size).toBe(0)
  expect(cache.memory()).toEqual({ ramBytes: 0, vramBytes: 0, entries: 0 })
  expect(cache.acquire(device, source.identity)).toBeNull()
  expect(cache.hasCompletedPhoto(photoId)).toBe(false)
  fence.resolve()
  const lease = (await pending)!
  expect(lease.resource).toBe(source.resource)
  expect(lease.samples.sample).toBe(source.samples.sample)
  expect(lease.samples.draft).toBe(source.samples.draft)
  expect(cache.hasCompletedPhoto(photoId)).toBe(true)
  expect(cache.memory()).toEqual({
    ramBytes: source.samples.sample.byteLength + source.samples.draft.byteLength,
    vramBytes: source.identity.textureBytes,
    entries: 1,
  })
  expect(cache.memory(lease)).toEqual({ ramBytes: 0, vramBytes: 0, entries: 0 })
  await lease.releaseAfter(Promise.resolve())
  await cache.dispose()
  expect(cache.hasCompletedPhoto(photoId)).toBe(false)
  expect(source.resource.destroyed).toBe(1)
})

test('incomplete or mismatching upload evidence cannot admit an entry or take resource ownership', async () => {
  const source = candidate('a'),
    device = {},
    cache = new HdrSourceCache<SourceResource>()
  const invalid = [
    { ...source, verification: { ...source.verification, eof: false } },
    {
      ...source,
      verification: { ...source.verification, verifiedBytes: source.identity.byteLength - 1 },
    },
    { ...source, verification: { ...source.verification, sourceSha256: 'b'.repeat(64) } },
    { ...source, verification: { ...source.verification, verifiedStripHashes: [] } },
    {
      ...source,
      verification: {
        ...source.verification,
        verifiedStripHashes: ['0'.repeat(64), source.identity.strips[1].sha256],
      },
    },
    { ...source, identity: { ...source.identity, textureBytes: 1 } },
    { ...source, identity: { ...source.identity, mipLevels: 1 } },
    { ...source, mipCompletion: true as unknown as Promise<void> },
  ]
  for (const attempt of invalid)
    await expect(cache.admit(device, attempt, admission())).rejects.toThrow()
  expect(cache.memory().entries).toBe(0)
  expect(source.resource.destroyed).toBe(0)
})

test('failed, cancelled and stale mip completions stay caller-owned', async () => {
  for (const reason of ['failure', 'cancel', 'stale', 'clear', 'device-loss'] as const) {
    const cache = new HdrSourceCache<SourceResource>(),
      device = {},
      fence = deferred(),
      photoId = '1'.repeat(64),
      source = { ...candidate('a', 33, 65, fence.promise), photoId },
      abort = new AbortController()
    let current = true
    const pending = cache.admit(device, source, { signal: abort.signal, isCurrent: () => current })
    expect(cache.hasCompletedPhoto(photoId)).toBe(false)
    if (reason === 'failure') {
      fence.reject(new Error('mip submission failed'))
      await expect(pending).rejects.toThrow('mip submission failed')
    } else {
      if (reason === 'cancel') abort.abort()
      if (reason === 'stale') current = false
      if (reason === 'clear') await cache.clearAndDrain()
      if (reason === 'device-loss') await cache.invalidate(device)
      fence.resolve()
      expect(await pending).toBeNull()
    }
    expect(cache.size).toBe(0)
    expect(cache.memory().entries).toBe(0)
    expect(cache.hasCompletedPhoto(photoId)).toBe(false)
    expect(source.resource.destroyed).toBe(0)
    await cache.dispose()
  }
})

test('photo association is optional and only an exact device and source acquisition can add it', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    photoId = '1'.repeat(64),
    source = candidate('a'),
    first = (await cache.admit(device, source, admission()))!
  await first.releaseAfter(Promise.resolve())
  expect(cache.hasCompletedPhoto(photoId)).toBe(false)
  expect(cache.acquire({}, source.identity, photoId)).toBeNull()
  expect(cache.acquire(device, candidate('b').identity, photoId)).toBeNull()
  expect(cache.hasCompletedPhoto(photoId)).toBe(false)
  const reused = cache.acquire(device, source.identity, photoId)!
  expect(reused.resource).toBe(source.resource)
  expect(cache.hasCompletedPhoto(photoId)).toBe(true)
  const memory = cache.memory()
  cache.forgetPhoto(photoId)
  expect(cache.hasCompletedPhoto(photoId)).toBe(false)
  expect(cache.memory()).toEqual(memory)
  expect(cache.evictOldestUnpinned()).toBe(false)
  await reused.releaseAfter(Promise.resolve())
  expect(cache.evictOldestUnpinned()).toBe(true)
  expect(source.resource.destroyed).toBe(1)
  await cache.dispose()
})

test('photo hint queries add no leases, reservations or LRU use', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    a = { ...candidate('a'), photoId: '1'.repeat(64) },
    b = { ...candidate('b'), photoId: '2'.repeat(64) },
    first = (await cache.admit(device, a, admission()))!,
    second = (await cache.admit(device, b, admission()))!
  await first.releaseAfter(Promise.resolve())
  await second.releaseAfter(Promise.resolve())
  const memory = cache.memory()
  for (let index = 0; index < 3; index++) expect(cache.hasCompletedPhoto(a.photoId)).toBe(true)
  expect(cache.memory()).toEqual(memory)
  const c = candidate('c'),
    third = (await cache.admit(device, c, admission()))!
  expect(cache.hasCompletedPhoto(a.photoId)).toBe(false)
  expect(cache.hasCompletedPhoto(b.photoId)).toBe(true)
  expect([a.resource.destroyed, b.resource.destroyed, c.resource.destroyed]).toEqual([1, 0, 0])
  await third.releaseAfter(Promise.resolve())
  await cache.dispose()
})

test('malformed photo association cannot change source ownership or an existing hint', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    photoId = '1'.repeat(64),
    source = { ...candidate('a'), photoId },
    first = (await cache.admit(device, source, admission()))!
  for (const invalid of ['', '../photo', 'A'.repeat(64), '1'.repeat(63)]) {
    expect(cache.hasCompletedPhoto(invalid)).toBe(false)
    expect(() => cache.acquire(device, source.identity, invalid)).toThrow('photo hint')
    await expect(
      cache.admit(device, { ...candidate('b'), photoId: invalid }, admission()),
    ).rejects.toThrow('photo hint')
  }
  expect(cache.hasCompletedPhoto(photoId)).toBe(true)
  expect(cache.memory().entries).toBe(1)
  await first.releaseAfter(Promise.resolve())
  expect(cache.evictOldestUnpinned()).toBe(true)
  expect(source.resource.destroyed).toBe(1)
  await cache.dispose()
})

test('cached samples must be source-matched, finite and tightly owned', async () => {
  const source = candidate('a'),
    badPixel = source.samples.sample.slice(),
    wide = new Float32Array(source.samples.sample.length + 4)
  badPixel[0] = NaN
  const invalid = [
    { ...source, samples: { ...source.samples, sourceSha256: 'b'.repeat(64) } },
    { ...source, samples: { ...source.samples, sample: badPixel } },
    { ...source, samples: { ...source.samples, draft: source.samples.sample } },
    { ...source, samples: { ...source.samples, sample: wide.subarray(4) } },
    { ...source, samples: { ...source.samples, sample: new Float32Array(4) } },
  ]
  const cache = new HdrSourceCache<SourceResource>()
  for (const attempt of invalid)
    await expect(cache.admit({}, attempt, admission())).rejects.toThrow('sample')
  expect(source.resource.destroyed).toBe(0)
  expect(cache.memory().entries).toBe(0)
})

test('reuse requires the exact device object and duplicates preserve caller ownership', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = { adapter: 'same' },
    otherDevice = { adapter: 'same' },
    source = candidate('a')
  const first = (await cache.admit(device, source, admission()))!
  expect(cache.acquire(otherDevice, source.identity)).toBeNull()
  const duplicate = candidate('a')
  expect(await cache.admit(device, duplicate, admission())).toBeNull()
  expect(await cache.admit(otherDevice, source, admission())).toBeNull()
  expect(duplicate.resource.destroyed).toBe(0)
  const other = (await cache.admit(otherDevice, duplicate, admission()))!
  expect(cache.memory().entries).toBe(2)
  await first.releaseAfter(Promise.resolve())
  await other.releaseAfter(Promise.resolve())
  await cache.dispose()
  expect(source.resource.destroyed).toBe(1)
  expect(duplicate.resource.destroyed).toBe(1)
})

test('two-entry LRU A/B/A/C retires only the idle least-recent source', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    a = candidate('a'),
    b = candidate('b'),
    c = candidate('c')
  const first = (await cache.admit(device, a, admission()))!
  await first.releaseAfter(Promise.resolve())
  const second = (await cache.admit(device, b, admission()))!
  await second.releaseAfter(Promise.resolve())
  const revisit = cache.acquire(device, a.identity)!
  await revisit.releaseAfter(Promise.resolve())
  const third = (await cache.admit(device, c, admission()))!
  expect(HDR_SOURCE_CACHE_ENTRIES).toBe(2)
  expect(cache.size).toBe(2)
  expect(cache.acquire(device, b.identity)).toBeNull()
  expect([a.resource.destroyed, b.resource.destroyed, c.resource.destroyed]).toEqual([0, 1, 0])
  await third.releaseAfter(Promise.resolve())
  expect(cache.evictOldestUnpinned()).toBe(true)
  expect(a.resource.destroyed).toBe(1)
  await cache.dispose()
  expect([a.resource.destroyed, b.resource.destroyed, c.resource.destroyed]).toEqual([1, 1, 1])
})

test('active and retired source leases stay charged until every final fence settles', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    photoId = '1'.repeat(64),
    source = { ...candidate('a'), photoId },
    firstFence = deferred(),
    secondFence = deferred()
  const first = (await cache.admit(device, source, admission()))!,
    second = cache.acquire(device, source.identity)!
  expect(cache.memory().entries).toBe(1)
  expect(cache.memory(first).entries).toBe(0)
  expect(cache.hasCompletedPhoto(photoId)).toBe(true)
  let drained = false
  const drain = cache.clearAndDrain().then(() => {
    drained = true
  })
  expect(cache.size).toBe(0)
  expect(cache.hasCompletedPhoto(photoId)).toBe(false)
  expect(cache.acquire(device, source.identity)).toBeNull()
  const releasing = first.releaseAfter(firstFence.promise)
  expect(first.releaseAfter(Promise.resolve())).toBe(releasing)
  expect(() => cache.memory(first)).toThrow('active source lease')
  const secondRelease = second.releaseAfter(secondFence.promise)
  firstFence.resolve()
  await releasing
  expect(drained).toBe(false)
  expect(source.resource.destroyed).toBe(0)
  expect(cache.memory().entries).toBe(1)
  secondFence.reject(new Error('device lost'))
  await secondRelease
  await drain
  expect(drained).toBe(true)
  expect(source.resource.destroyed).toBe(1)
  expect(cache.memory()).toEqual({ ramBytes: 0, vramBytes: 0, entries: 0 })
  await cache.dispose()
  expect(source.resource.destroyed).toBe(1)
})

test('pinned capacity rejects optional admission and a pending clear blocks late repopulation', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    a = candidate('a'),
    b = candidate('b'),
    c = candidate('c')
  const first = (await cache.admit(device, a, admission()))!,
    second = (await cache.admit(device, b, admission()))!
  expect(cache.evictOldestUnpinned()).toBe(false)
  expect(await cache.admit(device, c, admission())).toBeNull()
  expect(cache.memory().entries).toBe(2)
  const drain = cache.clearAndDrain()
  expect(await cache.admit(device, c, admission())).toBeNull()
  await first.releaseAfter(Promise.resolve())
  expect(cache.memory().entries).toBe(1)
  expect(await cache.admit(device, c, admission())).toBeNull()
  await second.releaseAfter(Promise.resolve())
  await drain
  const next = (await cache.admit(device, c, admission()))!
  expect(c.resource.destroyed).toBe(0)
  await next.releaseAfter(Promise.resolve())
  await cache.dispose()
  expect([a.resource.destroyed, b.resource.destroyed, c.resource.destroyed]).toEqual([1, 1, 1])
})

test('device invalidation drains only its owners and disposal rejects every later admission', async () => {
  const cache = new HdrSourceCache<SourceResource>(),
    device = {},
    otherDevice = {},
    a = { ...candidate('a'), photoId: '1'.repeat(64) },
    b = { ...candidate('b'), photoId: '2'.repeat(64) }
  const first = (await cache.admit(device, a, admission()))!,
    second = (await cache.admit(otherDevice, b, admission()))!
  const drain = cache.invalidate(device)
  expect(cache.hasCompletedPhoto(a.photoId)).toBe(false)
  expect(cache.hasCompletedPhoto(b.photoId)).toBe(true)
  expect(cache.acquire(device, a.identity)).toBeNull()
  expect(await cache.admit(device, candidate('c'), admission())).toBeNull()
  const other = cache.acquire(otherDevice, b.identity)!
  await first.releaseAfter(Promise.resolve())
  await drain
  expect(a.resource.destroyed).toBe(1)
  expect(b.resource.destroyed).toBe(0)
  await second.releaseAfter(Promise.resolve())
  const disposing = cache.dispose()
  expect(cache.hasCompletedPhoto(b.photoId)).toBe(false)
  expect(await cache.admit({}, candidate('c'), admission())).toBeNull()
  expect(cache.acquire(otherDevice, b.identity)).toBeNull()
  expect(cache.memory().entries).toBe(1)
  await other.releaseAfter(Promise.resolve())
  await disposing
  expect(b.resource.destroyed).toBe(1)
})
