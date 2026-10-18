import { expect, test } from '@playwright/test'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import {
  hdrPresentationMemory,
  HDR_PRESENTATION_BUDGET,
} from '../src/renderer/src/preview/hdr-memory'
import {
  HDR_PRESENTATION_CACHE_BUDGET,
  HdrPresentationCache,
  hdrPresentationIdentity,
  type CompletedHdrPresentation,
  type HdrPresentationIdentityInput,
} from '../src/renderer/src/preview/hdr-presentation-cache'

function input(): HdrPresentationIdentityInput {
  return {
    confirmed: true,
    sourceIdentity: 'source-policy:photo:working-hash',
    sourceSha256: 'a'.repeat(64),
    renderingPolicy: 'fixed-aces:adjustments-v1:normal-sampling-v1',
    settingsRevision: 3,
    adjustments: structuredClone(neutralAdjustments),
    target: { ...SDR_TARGET, generation: 4 },
    comparison: 'after',
    split: 0.5,
    hdrRanges: false,
    image: { width: 5496, height: 3672 },
    viewport: { width: 32, height: 16 },
    view: { fit: true, scale: 32 / 5496, x: 0, y: 0 },
    dpr: 2,
  }
}
function identity(name = 'photo') {
  return hdrPresentationIdentity({ ...input(), sourceIdentity: name })!
}
function resources() {
  const destroyed: string[] = []
  const frame = (name: string): CompletedHdrPresentation<{ destroy: () => void }> => ({
    surface: { destroy: () => destroyed.push(name) },
    width: 64,
    height: 32,
    completed: true,
    quality: 'normal',
    transient: false,
    serial: 1,
  })
  return { frame, destroyed }
}

test('exact presentation identity covers source, edits, output, framing and native Retina dimensions', () => {
  const original = input(),
    first = hdrPresentationIdentity(original)!
  expect(first).toMatchObject({ width: 64, height: 32, byteLength: 64 * 32 * 8 })
  expect(Object.isFrozen(first)).toBe(true)
  const changes: ((value: HdrPresentationIdentityInput) => void)[] = [
    (v) => (v.sourceIdentity += ':different-source'),
    (v) => (v.sourceSha256 = 'b'.repeat(64)),
    (v) => (v.renderingPolicy += ':new-policy'),
    (v) => v.settingsRevision++,
    (v) => (v.adjustments.whiteBalance = { mode: 'custom', kelvin: 6500, tint: 5 }),
    (v) => (v.adjustments.exposureEv = 0.01),
    (v) => v.adjustments.contrast++,
    (v) => v.adjustments.highlights++,
    (v) => v.adjustments.shadows++,
    (v) => v.adjustments.whites++,
    (v) => v.adjustments.blacks++,
    (v) => v.target.generation++,
    (v) => (v.target.requested = 'auto'),
    (v) => (v.target.mode = 'hdr'),
    (v) => (v.target.colorSpace = 'display-p3'),
    (v) => (v.target.peak = 2),
    (v) => (v.target.headroom = 2),
    (v) => (v.comparison = 'split'),
    (v) => (v.split = 0.25),
    (v) => (v.hdrRanges = true),
    (v) => v.image.width++,
    (v) => v.image.height++,
    (v) => (v.viewport.width += 0.125),
    (v) => (v.viewport.height += 0.125),
    (v) => (v.view.fit = false),
    (v) => (v.view.scale += 0.00001),
    (v) => (v.view.x = 0.125),
    (v) => (v.view.y = 0.125),
    (v) => (v.dpr = 1),
  ]
  for (const change of changes) {
    const changed = structuredClone(original)
    change(changed)
    expect(hdrPresentationIdentity(changed)?.key).not.toBe(first.key)
  }
  expect(hdrPresentationIdentity(original)?.key).toBe(first.key)
  expect(
    hdrPresentationIdentity({ ...original, adjustments: { ...neutralAdjustments } })?.key,
  ).toBe(first.key)
  const custom = { ...original, adjustments: { ...neutralAdjustments, whiteBalance: undefined } }
  expect(hdrPresentationIdentity(custom)?.key).toBe(first.key)
})

test('identity bypasses unconfirmed edits, non-finite metadata and invalid native dimensions', () => {
  const invalid: ((value: HdrPresentationIdentityInput) => void)[] = [
    (v) => (v.confirmed = false),
    (v) => (v.sourceIdentity = ''),
    (v) => (v.sourceSha256 = 'not-a-content-hash'),
    (v) => (v.renderingPolicy = ''),
    (v) => (v.settingsRevision = -1),
    (v) => (v.settingsRevision = 0.5),
    (v) => (v.adjustments.exposureEv = NaN),
    (v) => (v.target.headroom = Infinity),
    (v) => (v.target.generation = -1),
    (v) => (v.image.width = 0),
    (v) => (v.image.height = 10.5),
    (v) => (v.viewport.width = 0),
    (v) => (v.viewport.height = Infinity),
    (v) => (v.view.scale = 0),
    (v) => (v.view.x = NaN),
    (v) => (v.dpr = 0),
    (v) => (v.dpr = Number.MAX_VALUE),
  ]
  for (const change of invalid) {
    const changed = input()
    change(changed)
    expect(hdrPresentationIdentity(changed)).toBeNull()
  }
  const fractional = hdrPresentationIdentity({
    ...input(),
    viewport: { width: 32.25, height: 16.125 },
    dpr: 2,
  })!
  expect(fractional).toMatchObject({ width: 65, height: 32, byteLength: 65 * 32 * 8 })
})

test('surface reuse requires an exact identity and the original GPU device owner', () => {
  const { frame, destroyed } = resources(),
    cache = new HdrPresentationCache(),
    device = {},
    first = identity(),
    presentation = frame('first')
  expect(cache.budget).toBe(HDR_PRESENTATION_CACHE_BUDGET)
  expect(cache.retain(device, first, presentation)).toBe(true)
  const lease = cache.acquire(device, first)!
  expect(lease.surface).toBe(presentation.surface)
  expect(lease.identity).toEqual(first)
  expect(lease.serial).toBe(1)
  expect(cache.acquire({}, first)).toBeNull()
  expect(
    cache.acquire(device, {
      ...first,
      width: first.width * 2,
      byteLength: first.byteLength * 2,
    }),
  ).toBeNull()
  expect(cache.acquire(device, identity('different-source'))).toBeNull()
  expect(
    cache.acquire(device, hdrPresentationIdentity({ ...input(), settingsRevision: 4 })!),
  ).toBeNull()
  expect(cache.bytes).toBe(first.byteLength)
  lease.release()
  lease.release()
  expect(destroyed).toEqual([])
  cache.dispose()
  expect(destroyed).toEqual(['first'])
  expect(cache.bytes).toBe(0)
})

test('only completed exact normal frames transfer ownership; all bypasses preserve caller resources', () => {
  const { frame, destroyed } = resources(),
    cache = new HdrPresentationCache(),
    device = {},
    key = identity()
  const failures: Partial<CompletedHdrPresentation<{ destroy: () => void }>>[] = [
    { completed: false },
    { quality: 'draft' },
    { transient: true },
    { serial: 0 },
    { serial: 1.5 },
    { width: 32 },
    { height: 16 },
  ]
  for (const [index, failure] of failures.entries())
    expect(cache.retain(device, key, { ...frame(`rejected-${index}`), ...failure })).toBe(false)
  expect(cache.bytes).toBe(0)
  expect(cache.size).toBe(0)
  expect(destroyed).toEqual([])
  const accepted = frame('accepted')
  expect(cache.retain(device, key, accepted)).toBe(true)
  expect(cache.retain(device, identity('same-resource'), accepted)).toBe(false)
  cache.clear()
  expect(destroyed).toEqual(['accepted'])
})

test('deterministic LRU admission preflights allocation without evicting on oversized or pinned misses', () => {
  const { frame, destroyed } = resources(),
    a = identity('a'),
    b = identity('b'),
    c = identity('c'),
    cache = new HdrPresentationCache(a.byteLength * 2),
    device = {}
  cache.retain(device, a, frame('a'))
  cache.retain(device, b, frame('b'))
  const lease = cache.acquire(device, a)!
  lease.release()
  expect(cache.canRetain(c)).toBe(true)
  expect(destroyed).toEqual([])
  cache.retain(device, c, frame('c'))
  expect(destroyed).toEqual(['b'])
  expect(cache.acquire(device, b)).toBeNull()
  const aLease = cache.acquire(device, a)!,
    cLease = cache.acquire(device, c)!
  expect(cache.canRetain(b)).toBe(false)
  expect(cache.retain(device, b, frame('blocked'))).toBe(false)
  const huge = hdrPresentationIdentity({ ...input(), viewport: { width: 128, height: 64 } })!
  expect(cache.canRetain(huge)).toBe(false)
  expect(
    cache.retain(device, huge, { ...frame('huge'), width: huge.width, height: huge.height }),
  ).toBe(false)
  expect(destroyed).toEqual(['b'])
  expect(cache.bytes).toBe(a.byteLength * 2)
  aLease.release()
  cLease.release()
  cache.dispose()
  expect(destroyed).toEqual(['b', 'a', 'c'])
})

test('device invalidation removes reuse immediately but keeps submitted surfaces alive and charged', () => {
  const { frame, destroyed } = resources(),
    a = identity('a'),
    b = identity('b'),
    device = {},
    otherDevice = {},
    cache = new HdrPresentationCache(a.byteLength * 2)
  cache.retain(device, a, frame('a'))
  cache.retain(otherDevice, b, frame('b'))
  const first = cache.acquire(device, a)!,
    second = cache.acquire(device, a)!
  cache.invalidate(device)
  expect(cache.acquire(device, a)).toBeNull()
  expect(cache.bytes).toBe(a.byteLength * 2)
  expect(cache.size).toBe(1)
  expect(destroyed).toEqual([])
  first.release()
  first.release()
  expect(destroyed).toEqual([])
  second.release()
  expect(destroyed).toEqual(['a'])
  expect(cache.bytes).toBe(b.byteLength)
  const other = cache.acquire(otherDevice, b)!
  cache.clear()
  expect(destroyed).toEqual(['a'])
  expect(cache.bytes).toBe(b.byteLength)
  other.release()
  expect(destroyed).toEqual(['a', 'b'])
  expect(cache.bytes).toBe(0)
})

test('replacing an identity never destroys its leased old surface or exceeds the aggregate cache budget', () => {
  const { frame, destroyed } = resources(),
    key = identity(),
    device = {},
    cache = new HdrPresentationCache(key.byteLength * 2)
  cache.retain(device, key, frame('old'))
  const old = cache.acquire(device, key)!
  expect(cache.retain(device, key, { ...frame('new'), serial: 2 })).toBe(true)
  expect(cache.bytes).toBe(key.byteLength * 2)
  expect(destroyed).toEqual([])
  const current = cache.acquire(device, key)!
  expect(current.serial).toBe(2)
  expect(current.surface).not.toBe(old.surface)
  cache.dispose()
  expect(cache.size).toBe(0)
  expect(cache.bytes).toBe(key.byteLength * 2)
  expect(cache.canRetain(key)).toBe(false)
  expect(cache.retain(device, key, frame('after-disposal'))).toBe(false)
  expect(cache.acquire(device, key)).toBeNull()
  current.release()
  expect(destroyed).toEqual(['new'])
  old.release()
  old.release()
  expect(destroyed).toEqual(['new', 'old'])
  expect(cache.bytes).toBe(0)
})

test('invalid byte accounting and zero-budget admission cannot evict valid owned resources', () => {
  const { frame, destroyed } = resources(),
    key = identity(),
    device = {},
    cache = new HdrPresentationCache(key.byteLength)
  expect(() => new HdrPresentationCache(-1)).toThrow('Invalid HDR presentation cache budget')
  expect(() => new HdrPresentationCache(Infinity)).toThrow('Invalid HDR presentation cache budget')
  expect(new HdrPresentationCache(0).canRetain(key)).toBe(false)
  cache.retain(device, key, frame('valid'))
  expect(cache.canRetain({ ...key, byteLength: 1 })).toBe(false)
  expect(cache.retain(device, { ...key, byteLength: 1 }, frame('invalid'))).toBe(false)
  expect(cache.canRetain({ ...key, width: NaN })).toBe(false)
  expect(destroyed).toEqual([])
  expect(cache.bytes).toBe(key.byteLength)
  cache.dispose()
  cache.dispose()
  expect(destroyed).toEqual(['valid'])
  expect(cache.bytes).toBe(0)
})

test('retained exact surfaces reserve room inside the existing upload and presentation budget', () => {
  const ordinary = hdrPresentationMemory(5496, 3672, 2900, 1000),
    retained = hdrPresentationMemory(
      5496,
      3672,
      2900,
      1000,
      undefined,
      0,
      HDR_PRESENTATION_CACHE_BUDGET,
    )
  expect(retained.retainedPresentationBytes).toBe(HDR_PRESENTATION_CACHE_BUDGET)
  expect(retained.uploadPeak - ordinary.uploadPeak).toBe(HDR_PRESENTATION_CACHE_BUDGET)
  expect(retained.minimumPresentationPeak - ordinary.minimumPresentationPeak).toBe(
    HDR_PRESENTATION_CACHE_BUDGET,
  )
  expect(retained.cacheSlots).toBeLessThanOrEqual(ordinary.cacheSlots)
  expect(retained.total).toBeLessThanOrEqual(HDR_PRESENTATION_BUDGET)
  expect(
    hdrPresentationMemory(5496, 3672, 5800, 2000, undefined, 0, HDR_PRESENTATION_CACHE_BUDGET)
      .total,
  ).toBeGreaterThan(HDR_PRESENTATION_BUDGET)
  expect(() => hdrPresentationMemory(1, 1, 1, 1, undefined, 0, -1)).toThrow(
    'Invalid retained HDR presentation reservation',
  )
})
