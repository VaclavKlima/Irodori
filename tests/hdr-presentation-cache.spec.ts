import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../src/shared/display-rendering'
import {
  HDR_RENDERING_TABLES_BYTES,
  HDR_RENDERING_TABLES_VERSION,
  prepareHdrRenderingTableData,
  type HdrRenderingTables,
} from '../src/shared/hdr-rendering-tables'
import { HdrRenderingTableCache } from '../src/renderer/src/preview/hdr-rendering-tables'
import {
  HdrPipelineCache,
  presentationBlit,
  type HdrPipelines,
  type HdrPipelineProfile,
} from '../src/renderer/src/preview/hdr-pipelines'
import {
  ACES_HDR_INTERACTIVE_PREVIEW_VERSION,
  ACES_SDR_INTERACTIVE_PREVIEW_VERSION,
} from '../src/shared/aces-preview-wgsl'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import {
  hdrPresentationMemory,
  hdrRestoredUploadMemory,
  HdrPresentationHeadroom,
  HDR_BITMAP_RESERVATION,
  type HdrMemoryLimits,
  type HdrMemoryRequest,
} from '../src/renderer/src/preview/hdr-memory'
import { hdrCachePlan, HdrRenderCache } from '../src/renderer/src/preview/hdr-render-cache'
import { fitScale, zoomAt } from '../src/renderer/src/preview/geometry'
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
test('exact Before/Split presentations bind the original source while After identity stays reusable', () => {
  const original = input(),
    a = { identity: 'unfiltered-a', sha256: 'b'.repeat(64) },
    b = { identity: 'unfiltered-b', sha256: 'c'.repeat(64) }
  expect(hdrPresentationIdentity({ ...original, beforeSource: a })?.key).toBe(
    hdrPresentationIdentity(original)?.key,
  )
  for (const comparison of ['before', 'split'] as const) {
    const base = { ...original, comparison },
      first = hdrPresentationIdentity({ ...base, beforeSource: a })!
    expect(first.key).not.toBe(hdrPresentationIdentity(base)?.key)
    expect(first.key).not.toBe(hdrPresentationIdentity({ ...base, beforeSource: b })?.key)
    expect(first.key).not.toBe(
      hdrPresentationIdentity({ ...base, beforeSource: { ...a, sha256: b.sha256 } })?.key,
    )
    expect(hdrPresentationIdentity({ ...base, beforeSource: { ...a, identity: '' } })).toBeNull()
    expect(hdrPresentationIdentity({ ...base, beforeSource: { ...a, sha256: 'bad' } })).toBeNull()
  }
})
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
    (v) => v.adjustments.saturation++,
    (v) => v.adjustments.vibrance++,
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

const memoryLimits: HdrMemoryLimits = {
  ramBytes: 8 * 1024 ** 3,
  vramBytes: 2 * 1024 ** 3,
  revision: 4,
}
function memoryRequest(
  width: number,
  height: number,
  canvasWidth = 0,
  canvasHeight = 0,
): HdrMemoryRequest {
  return { width, height, canvasWidth, canvasHeight, bitmapReservation: HDR_BITMAP_RESERVATION }
}
function memory(request: HdrMemoryRequest, limits = memoryLimits) {
  return hdrPresentationMemory(request, limits)
}
function blockingCache(request: HdrMemoryRequest, limits = memoryLimits) {
  const minimum = memory({ ...request, maximumLayers: 1, rawHalfSupported: false }, limits)
  return new HdrPresentationCache(limits.vramBytes - minimum.minimumPresentation.vramBytes + 1)
}

test('retained exact surfaces reserve GPU ownership in both phases without charging CPU planes', () => {
  const request = memoryRequest(5496, 3672, 2900, 1000)
  const ordinary = memory(request)
  const retained = memory({ ...request, retainedPresentationBytes: HDR_PRESENTATION_CACHE_BUDGET })
  expect(retained.owners.retainedPresentation).toEqual({
    ramBytes: 0,
    vramBytes: HDR_PRESENTATION_CACHE_BUDGET,
  })
  expect(retained.uploadPeak.vramBytes - ordinary.uploadPeak.vramBytes).toBe(
    HDR_PRESENTATION_CACHE_BUDGET,
  )
  expect(retained.minimumPresentation.vramBytes - ordinary.minimumPresentation.vramBytes).toBe(
    HDR_PRESENTATION_CACHE_BUDGET,
  )
  expect(retained.uploadPeak.ramBytes).toBe(ordinary.uploadPeak.ramBytes)
  expect(retained.cacheSlots).toBeLessThanOrEqual(ordinary.cacheSlots)
  expect(retained.accepted).toBe(true)
  expect(() => memory({ ...request, retainedPresentationBytes: -1 })).toThrow(
    'retained presentation',
  )
})

test('native maximized Fit to 100% retains the complete warmed canonical tile path', () => {
  const source = { width: 5422, height: 3622 },
    viewport = { width: 2866, height: 1189 }
  const planned = memory({
    ...memoryRequest(source.width, source.height, viewport.width, viewport.height),
    retainedPresentationBytes: HDR_PRESENTATION_CACHE_BUDGET,
  })
  const cache = new HdrRenderCache(planned.cacheSlots),
    start = fitScale(source, viewport),
    anchor = { x: 429, y: -119.5 }
  expect(planned.tileSize).toBe(128)
  expect(planned.tileBytes).toBe(130 * 130 * 16)
  expect(planned.cacheSlots).toBe(2048)
  expect(planned.accepted).toBe(true)
  const keys = new Set<string>()
  let view = { fit: true, scale: start, x: 0, y: 0 },
    maximumPlan = 0
  const path = Array.from({ length: 40 }, (_, index) => {
    const step = (index + 1) % 40,
      position = step <= 20 ? step : 40 - step
    view = zoomAt(view, start * (1 / start) ** (position / 20), anchor, source, viewport)
    const plan = hdrCachePlan(source, source, viewport, view, 'after', 0.5, planned.tileSize)
    plan.variant = 'sdr-display-p3'
    for (const tile of plan.tiles) keys.add(`${tile.level}:${tile.x}:${tile.y}`)
    maximumPlan = Math.max(maximumPlan, plan.tiles.length)
    return plan
  })
  expect(maximumPlan).toBe(817)
  expect(keys.size).toBe(1147)
  expect(keys.size).toBeLessThanOrEqual(planned.cacheSlots)
  const render = () =>
    path
      .flatMap((plan) => [...cache.batches(plan, true)])
      .reduce((sum, batch) => sum + batch.renderedTiles, 0)
  expect(render()).toBe(keys.size)
  expect(render()).toBe(0)
  expect(render()).toBe(0)
})

test('two native-size retained surfaces and the active source fit independent RAM and GPU limits', async () => {
  const { frame, destroyed } = resources(),
    cache = new HdrPresentationCache(),
    device = {}
  const identities = ['landscape', 'portrait'].map((sourceIdentity) =>
    hdrPresentationIdentity({
      ...input(),
      sourceIdentity,
      viewport: { width: 1226, height: 948 },
    })!,
  )
  for (const [i, key] of identities.entries())
    expect(
      cache.retain(device, key, { ...frame(String(i)), width: key.width, height: key.height }),
    ).toBe(true)
  expect(cache.bytes).toBe(2452 * 1896 * 8 * 2)
  expect(cache.bytes).toBeLessThanOrEqual(HDR_PRESENTATION_CACHE_BUDGET)
  for (const [width, height] of [
    [5422, 3622],
    [3622, 5422],
  ]) {
    const request = memoryRequest(width, height, 2452, 1896)
    const ordinary = memory(request),
      reserved = memory({ ...request, retainedPresentationBytes: cache.budget })
    const headroom = new HdrPresentationHeadroom(memoryLimits, cache)
    expect(reserved.cacheSlots).toBe(2048)
    expect(reserved.presentationPeak.vramBytes - ordinary.presentationPeak.vramBytes).toBe(
      cache.budget,
    )
    expect(reserved.accepted).toBe(true)
    expect(await headroom.plan(request)).toEqual(reserved)
    expect(headroom.bypassed).toBe(false)
    headroom.dispose()
  }
  cache.dispose()
  expect(destroyed).toEqual(['0', '1'])
})

test('fitting plans stay synchronous and freeze the presenter limits against later input mutation', () => {
  const original = { ...memoryLimits },
    cache = new HdrPresentationCache()
  const headroom = new HdrPresentationHeadroom(original, cache),
    request = memoryRequest(5496, 3672, 1828, 1004)
  original.ramBytes = 0
  original.vramBytes = 0
  original.revision++
  const planned = headroom.plan(request)
  expect(planned).not.toBeInstanceOf(Promise)
  expect(planned).toEqual(memory({ ...request, retainedPresentationBytes: cache.budget }))
  expect(headroom.limits).toEqual(memoryLimits)
  expect(Object.isFrozen(headroom.limits)).toBe(true)
  expect(headroom.eligible).toBe(true)
  headroom.dispose()
  headroom.dispose()
  expect(() => headroom.plan(request)).toThrow('closed')
})

test('viewport growth bypasses optional cache permanently without raising either policy limit', async () => {
  const request = memoryRequest(6400, 4800, 3000, 2000),
    cache = blockingCache(request)
  const headroom = new HdrPresentationHeadroom(memoryLimits, cache)
  const initial = headroom.plan(memoryRequest(6400, 4800))
  expect(initial).not.toBeInstanceOf(Promise)
  expect(headroom.eligible).toBe(true)
  const growing = headroom.plan(request)
  expect(growing).toBeInstanceOf(Promise)
  expect(headroom.bypassed).toBe(true)
  expect(headroom.reservationBytes).toBe(0)
  const ordinary = await growing
  expect(ordinary).toEqual(memory(request))
  expect(ordinary.accepted).toBe(true)
  expect(ordinary.limits).toEqual(memoryLimits)
  expect(await headroom.plan(memoryRequest(6400, 4800))).toEqual(memory(memoryRequest(6400, 4800)))
  expect(cache.canRetain(identity())).toBe(false)
  headroom.dispose()
  await Promise.resolve()
  expect(cache.canRetain(identity())).toBe(true)
})

test('large sources bypass optional reservations before source allocation and reject an oversized viewport honestly', async () => {
  const request = memoryRequest(7008, 4672),
    cache = blockingCache(request)
  const headroom = new HdrPresentationHeadroom(memoryLimits, cache)
  expect(memory({ ...request, retainedPresentationBytes: cache.budget }).accepted).toBe(false)
  const upload = await headroom.plan(request)
  expect(headroom.bypassed).toBe(true)
  expect(upload).toEqual(memory(request))
  expect(upload.accepted).toBe(true)
  const viewport = await headroom.plan(memoryRequest(7008, 4672, 1000, 1000))
  expect(viewport.accepted).toBe(true)
  expect(viewport.retentionMethod).toBe('raw-half-cpu')
  expect((await headroom.plan(memoryRequest(7008, 4672, 9000, 6000))).accepted).toBe(false)
  headroom.dispose()
})

test('ordinary planning waits for all retired pins and coalesces concurrent viewport requests', async () => {
  const request = memoryRequest(6400, 4800, 3000, 2000),
    cache = blockingCache(request)
  const { frame, destroyed } = resources(),
    device = {},
    a = identity('retired'),
    b = identity('current')
  const headroom = new HdrPresentationHeadroom(memoryLimits, cache)
  cache.retain(device, a, frame('retired'))
  const firstLease = cache.acquire(device, a)!,
    secondLease = cache.acquire(device, a)!
  cache.invalidate(device)
  cache.retain(device, b, frame('current'))
  let firstReady = false,
    secondReady = false
  const first = Promise.resolve(headroom.plan(request)).then((plan) => {
    firstReady = true
    return plan
  })
  const nextRequest = memoryRequest(7008, 4672, 2000, 1000)
  const second = Promise.resolve(headroom.plan(nextRequest)).then((plan) => {
    secondReady = true
    return plan
  })
  expect(cache.bytes).toBe(a.byteLength)
  expect(destroyed).toEqual(['current'])
  expect(cache.retain(device, identity('late'), frame('late'))).toBe(false)
  await Promise.resolve()
  expect([firstReady, secondReady]).toEqual([false, false])
  firstLease.release()
  firstLease.release()
  await Promise.resolve()
  expect([firstReady, secondReady]).toEqual([false, false])
  secondLease.release()
  expect(await first).toEqual(memory(request))
  expect(await second).toEqual(memory(nextRequest))
  expect(destroyed).toEqual(['current', 'retired'])
  headroom.dispose()
  await Promise.resolve()
  expect(cache.canRetain(a)).toBe(true)
})

test('disposal during a pending headroom drain prevents admission until the last lease releases', async () => {
  const request = memoryRequest(6400, 4800, 3000, 2000),
    cache = blockingCache(request)
  const { frame, destroyed } = resources(),
    device = {},
    key = identity()
  const headroom = new HdrPresentationHeadroom(memoryLimits, cache)
  cache.retain(device, key, frame('pinned'))
  const lease = cache.acquire(device, key)!,
    plan = headroom.plan(request),
    additionalDrain = cache.clearAndDrain()
  headroom.dispose()
  headroom.dispose()
  expect(cache.canRetain(key)).toBe(false)
  await Promise.resolve()
  expect(cache.bytes).toBe(key.byteLength)
  expect(destroyed).toEqual([])
  lease.release()
  await Promise.all([plan, additionalDrain])
  expect(cache.bytes).toBe(0)
  expect(destroyed).toEqual(['pinned'])
  expect(cache.canRetain(key)).toBe(true)
  cache.dispose()
})

test('cache disposal drains pinned ownership and admission pauses release independently', async () => {
  const { frame, destroyed } = resources(),
    cache = new HdrPresentationCache(),
    device = {},
    key = identity()
  const resumeFirst = cache.pauseRetaining(),
    resumeSecond = cache.pauseRetaining()
  resumeFirst()
  resumeFirst()
  expect(cache.canRetain(key)).toBe(false)
  resumeSecond()
  expect(cache.retain(device, key, frame('pinned'))).toBe(true)
  const lease = cache.acquire(device, key)!
  cache.dispose()
  let drained = false
  const drain = cache.clearAndDrain().then(() => (drained = true))
  await Promise.resolve()
  expect(drained).toBe(false)
  lease.release()
  await drain
  expect(drained).toBe(true)
  expect(destroyed).toEqual(['pinned'])
  expect(cache.bytes).toBe(0)
})

test('old restored native backing is charged only during its concurrent upload ownership', () => {
  const request = memoryRequest(5496, 3672, 1000, 1000)
  const missed = memory(request),
    restoredUpload = hdrRestoredUploadMemory(16384, 8192)
  const restored = memory({ ...request, restoredUpload })
  expect(restoredUpload).toEqual({
    ramBytes: 16384 * 8192 * 32 + 4 * 1024 ** 2 + 64 * 1024,
    vramBytes: 16384 * 8192 * 32,
  })
  expect(restored.uploadPeak.ramBytes - missed.uploadPeak.ramBytes).toBe(restoredUpload.ramBytes)
  expect(restored.uploadPeak.vramBytes - missed.uploadPeak.vramBytes).toBe(restoredUpload.vramBytes)
  expect(restored.presentationPeak).toEqual(missed.presentationPeak)
  expect(missed.accepted).toBe(true)
  expect(restored.accepted).toBe(false)
  expect(() => memory({ ...request, restoredUpload: { ramBytes: -1, vramBytes: 0 } })).toThrow(
    'RAM',
  )
})

test('optional exact presentation surfaces cannot force CPU recovery when ordinary raw recovery fits', async () => {
  const request = { ...memoryRequest(5496, 3672, 3000, 2000), maximumLayers: 1 }
  const full = memory(request)
  const limits = { ...memoryLimits, vramBytes: full.minimumPresentation.vramBytes + 1024 }
  const cache = new HdrPresentationCache(2048)
  expect(memory(request, limits).retentionMethod).toBe('raw-half-cpu')
  const reserved = memory({ ...request, retainedPresentationBytes: cache.budget }, limits)
  expect(reserved.retentionMethod).toBe('cpu-staging')
  expect(reserved.accepted).toBe(true)
  const headroom = new HdrPresentationHeadroom(limits, cache)
  const planned = await headroom.plan(request)
  expect(planned.retentionMethod).toBe('raw-half-cpu')
  expect(planned.accepted).toBe(true)
  expect(headroom.bypassed).toBe(true)
  headroom.dispose()
})

test('raw recovery charges two CPU planes, rare conversion, GPU readback and a host map allowance', () => {
  const presentation = memory(memoryRequest(5496, 3672, 2914, 1258))
  const padded = 29_628_416
  expect(presentation.retentionMethod).toBe('raw-half-cpu')
  expect(presentation.owners.rawRecovery).toEqual({
    ramBytes: 2914 * 1258 * 24 + padded,
    vramBytes: padded,
  })
  expect(presentation.owners.nativeCanvas).toEqual({
    ramBytes: 2914 * 1258 * 32,
    vramBytes: 2914 * 1258 * 32,
  })
  expect(memory(memoryRequest(1, 1, 1, 2)).owners.rawRecovery.vramBytes).toBe(512)
  expect(memory(memoryRequest(1, 1, 33, 2)).owners.rawRecovery.vramBytes).toBe(1024)
  expect(presentation.accepted).toBe(true)
})

for (const resource of ['ramBytes', 'vramBytes'] as const) {
  test(`raw recovery falls back to bounded CPU staging at the independent ${resource} boundary`, () => {
    const request = { ...memoryRequest(5496, 3672, 3000, 2000), maximumLayers: 1 }
    const full = memory(request)
    expect(full.retentionMethod).toBe('raw-half-cpu')
    const limits = { ...memoryLimits, [resource]: full.peak[resource] - 1 }
    const fallback = memory(request, limits)
    expect(fallback.retentionMethod).toBe('cpu-staging')
    expect(fallback.accepted).toBe(true)
    expect(fallback.peak[resource]).toBeLessThan(full.peak[resource])
    const minimum = { ...fallback.peak, revision: 5 }
    expect(memory({ ...request, rawHalfSupported: false }, minimum).accepted).toBe(true)
    expect(
      memory(
        { ...request, rawHalfSupported: false },
        { ...minimum, [resource]: minimum[resource] - 1 },
      ).accepted,
    ).toBe(false)
  })
}

test('shrinking recovery reserves old CPU and GPU owners through replacement and fallback drain', () => {
  const request = memoryRequest(5496, 3672, 512, 256)
  const previous = {
    rawReplacementOverlap: { ramBytes: 128 * 1024 ** 2, vramBytes: 32 * 1024 ** 2 },
    cpuStagingCarry: { ramBytes: 128 * 1024 ** 2, vramBytes: 32 * 1024 ** 2 },
  }
  const ordinary = memory(request),
    overlap = memory({ ...request, recovery: previous })
  expect(overlap.retentionMethod).toBe('raw-half-cpu')
  expect(overlap.minimumPresentation.ramBytes - ordinary.minimumPresentation.ramBytes).toBe(
    previous.rawReplacementOverlap.ramBytes,
  )
  expect(overlap.minimumPresentation.vramBytes - ordinary.minimumPresentation.vramBytes).toBe(
    previous.rawReplacementOverlap.vramBytes,
  )
  const fallback = memory({ ...request, recovery: previous, rawHalfSupported: false })
  const without = memory({ ...request, rawHalfSupported: false })
  expect(fallback.minimumPresentation.ramBytes - without.minimumPresentation.ramBytes).toBe(
    previous.cpuStagingCarry.ramBytes,
  )
  expect(fallback.minimumPresentation.vramBytes - without.minimumPresentation.vramBytes).toBe(
    previous.cpuStagingCarry.vramBytes,
  )
  expect(() =>
    memory({
      ...request,
      recovery: { ...previous, cpuStagingCarry: { ramBytes: 0, vramBytes: -1 } },
    }),
  ).toThrow('GPU')
})

test('bitmap, mask, rendering-table and diagnostic owners remain separate and explicit', () => {
  const request = memoryRequest(5496, 3672, 1000, 1000)
  const planned = memory({ ...request, diagnostic: { ramBytes: 2048, vramBytes: 6144 } })
  expect(planned.owners.bitmapReservation).toEqual({
    ramBytes: 256 * 1024 ** 2,
    vramBytes: 256 * 1024 ** 2,
  })
  expect(planned.owners.analysis.ramBytes).toBeGreaterThan(5496 * 3672 * 2)
  expect(planned.owners.analysis.vramBytes).toBe(0)
  expect(planned.owners.tablesAndHistogram.ramBytes).toBeGreaterThanOrEqual(
    HDR_RENDERING_TABLES_BYTES,
  )
  expect(planned.owners.tablesAndHistogram.vramBytes).toBeGreaterThanOrEqual(ACES_DATA_BYTES * 3)
  expect(planned.owners.diagnostic).toEqual({ ramBytes: 2048, vramBytes: 6144 })
  expect(() => memory({ ...request, bitmapReservation: undefined! })).toThrow('explicit')
  expect(() => memory({ ...request, width: 0 })).toThrow('HDR width')
  expect(() => memory({ ...request, canvasHeight: 0 })).toThrow('both')
  expect(() => memory(request, { ...memoryLimits, ramBytes: -1 })).toThrow('RAM')
})

function tablePayload(): HdrRenderingTables {
  const table = (value: number) => new Float32Array(ACES_DATA_BYTES / 4).fill(value)
  return {
    version: HDR_RENDERING_TABLES_VERSION,
    packed: table(10),
    sdr: { srgb: table(1), 'display-p3': table(2) },
    preparationMs: 4,
  }
}

test('fixed target table preparation preserves all three existing packed byte hashes', () => {
  const prepared = prepareHdrRenderingTableData()
  const hash = (data: Float32Array) =>
    createHash('sha256')
      .update(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      .digest('hex')
  const expected = [
    packAces(prepareDisplayRendering(HDR_CONTENT_TARGET)),
    packAces(prepareDisplayRendering({ mode: 'sdr', peak: 1, colorSpace: 'srgb' })),
    packAces(prepareDisplayRendering({ mode: 'sdr', peak: 1, colorSpace: 'display-p3' })),
  ].map(hash)
  const actual = [prepared.packed, prepared.sdr.srgb, prepared.sdr['display-p3']].map(hash)
  expect(actual).toEqual(expected)
  expect(new Set(actual).size).toBe(3)
  expect(prepared.version).toBe(HDR_RENDERING_TABLES_VERSION)
  expect(prepared.preparationMs).toBeGreaterThanOrEqual(0)
  expect(HDR_RENDERING_TABLES_BYTES).toBe(3 * 28240)
  // Both the shared CPU set and the three existing GPU buffers remain budgeted.
  const budget = memory(memoryRequest(1, 1)).owners.tablesAndHistogram
  expect(budget.ramBytes).toBeGreaterThanOrEqual(HDR_RENDERING_TABLES_BYTES)
  expect(budget.vramBytes).toBeGreaterThanOrEqual(ACES_DATA_BYTES * 3)
})

test('a cancelled photo cannot publish late tables or cancel the next photo preparation', async () => {
  let complete!: (tables: HdrRenderingTables) => void
  let requests = 0
  const payload = tablePayload()
  const cache = new HdrRenderingTableCache(() => {
    requests++
    return new Promise((resolve) => (complete = resolve))
  })
  const first = new AbortController(),
    second = new AbortController()
  const old = cache.acquire(first.signal),
    current = cache.acquire(second.signal)
  expect(old.state).toBe('cold')
  expect(current.state).toBe('pending')
  const published: string[] = []
  const oldResult = old.tables.then(
    () => published.push('old-photo'),
    (error: unknown) => error,
  )
  const currentResult = current.tables.then((tables) => {
    published.push('current-photo')
    return tables
  })
  first.abort(new Error('Photo superseded'))
  await Promise.resolve()
  complete(payload)
  expect(await oldResult).toBe(first.signal.reason)
  expect(await currentResult).toBe(payload)
  expect(published).toEqual(['current-photo'])
  expect(requests).toBe(1)
  // A new presenter/device consumes target-only CPU bytes without preparing again.
  const recreated = cache.acquire(new AbortController().signal)
  expect(recreated.state).toBe('ready')
  expect(await recreated.tables).toBe(payload)
  expect(requests).toBe(1)
})

test('an already prepared table set still rejects a disposed consumer before delivery', async () => {
  const cache = new HdrRenderingTableCache(async () => tablePayload())
  await cache.acquire(new AbortController().signal).tables
  const disposed = new AbortController()
  const late = cache.acquire(disposed.signal)
  disposed.abort(new Error('Presenter disposed'))
  await expect(late.tables).rejects.toThrow('Presenter disposed')
  expect(() => cache.acquire(disposed.signal)).toThrow('Presenter disposed')
  expect((await cache.acquire(new AbortController().signal).tables).version).toBe(
    HDR_RENDERING_TABLES_VERSION,
  )
})

test('failed and incompatible table preparations are evicted before retry', async () => {
  const invalid = [
    { ...tablePayload(), version: 'previous-rendering-policy' },
    { ...tablePayload(), packed: new Float32Array(1) },
    { ...tablePayload(), preparationMs: NaN },
    {
      ...tablePayload(),
      sdr: { ...tablePayload().sdr, 'display-p3': new Float32Array(ACES_DATA_BYTES / 4).fill(NaN) },
    },
  ]
  for (const result of [new Error('Worker failed'), ...invalid]) {
    let requests = 0
    const valid = tablePayload()
    const cache = new HdrRenderingTableCache(async () => {
      if (++requests === 1) {
        if (result instanceof Error) throw result
        return result
      }
      return valid
    })
    await expect(cache.acquire(new AbortController().signal).tables).rejects.toThrow()
    const retry = cache.acquire(new AbortController().signal)
    expect(retry.state).toBe('cold')
    expect(await retry.tables).toBe(valid)
    expect(requests).toBe(2)
  }
})

function pipelineDevice() {
  let lose!: (info: GPUDeviceLostInfo) => void
  const device = {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      lose = resolve
    }),
  } as GPUDevice
  return {
    device,
    lose: () => lose({ reason: 'destroyed', message: 'Unit device retired.' } as GPUDeviceLostInfo),
  }
}
function compiledPrograms(label: string): HdrPipelines {
  const layout = { label } as GPUBindGroupLayout,
    compute = { label } as GPUComputePipeline,
    presentation = { label } as GPURenderPipeline
  return Object.freeze({
    mipLayout: layout,
    mip: compute,
    layout,
    presentation,
    histogram: compute,
    cacheLayout: layout,
    cache: compute,
    blit: presentation,
    interactive: Object.freeze({
      [ACES_HDR_INTERACTIVE_PREVIEW_VERSION]: compute,
      [ACES_SDR_INTERACTIVE_PREVIEW_VERSION]: compute,
    }),
  })
}

test('concurrent photographs share one device pipeline preparation and its ready result', async () => {
  const { device } = pipelineDevice(),
    programs = compiledPrograms('shared')
  const requests: HdrPipelineProfile[] = []
  let complete!: (programs: HdrPipelines) => void
  const cache = new HdrPipelineCache(async (_device, profile) => {
    requests.push(profile)
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  const first = cache.acquire(device, { interactive: true }),
    second = cache.acquire(device, { interactive: true })
  expect(first.state).toBe('cold')
  expect(second.state).toBe('pending')
  expect(second.pipelines).toBe(first.pipelines)
  await Promise.resolve()
  expect(requests).toEqual([{ interactive: true }])
  expect(Object.isFrozen(requests[0])).toBe(true)
  // The first photo can stop consuming without cancelling another photo's program.
  complete(programs)
  expect(await second.pipelines).toBe(programs)
  expect(await first.pipelines).toBe(programs)
  const ready = cache.acquire(device, { interactive: true })
  expect(ready.state).toBe('ready')
  expect(ready.pipelines).toBe(first.pipelines)
  expect(Object.isFrozen(await ready.pipelines)).toBe(true)
  expect(Object.isFrozen((await ready.pipelines).interactive)).toBe(true)
})

test('pipeline identity separates devices and canonical versus interactive families while freezing caller input', async () => {
  const first = pipelineDevice(),
    second = pipelineDevice(),
    requests: Array<{ device: GPUDevice; profile: HdrPipelineProfile }> = [],
    cache = new HdrPipelineCache(async (device, profile) => {
      requests.push({ device, profile })
      return compiledPrograms(String(requests.length))
    })
  const original = { interactive: false }
  const reference = cache.acquire(first.device, original)
  original.interactive = true
  const interactive = cache.acquire(first.device, original),
    sameInteractive = cache.acquire(first.device, { interactive: true }),
    differentDevice = cache.acquire(second.device, { interactive: false })
  expect(sameInteractive.pipelines).toBe(interactive.pipelines)
  const results = await Promise.all([
    reference.pipelines,
    interactive.pipelines,
    differentDevice.pipelines,
  ])
  expect(new Set(results).size).toBe(3)
  expect(requests.map(({ profile }) => profile)).toEqual([
    { interactive: false },
    { interactive: true },
    { interactive: false },
  ])
  expect(Object.isFrozen(requests[0].profile)).toBe(true)
  expect(cache.acquire(first.device, { interactive: false }).pipelines).toBe(reference.pipelines)
})

test('rejected interactive preparation leaves canonical programs reusable and retries only that profile', async () => {
  const { device } = pipelineDevice(),
    failure = new Error('Native interactive pipeline rejected.')
  let interactiveAttempts = 0,
    referenceAttempts = 0
  const cache = new HdrPipelineCache(async (_device, profile) => {
    if (profile.interactive) {
      if (++interactiveAttempts === 1) throw failure
    } else referenceAttempts++
    return compiledPrograms(profile.interactive ? 'interactive' : 'reference')
  })
  const reference = cache.acquire(device, { interactive: false })
  await reference.pipelines
  const rejected = cache.acquire(device, { interactive: true })
  await expect(rejected.pipelines).rejects.toBe(failure)
  const retry = cache.acquire(device, { interactive: true })
  expect(retry.state).toBe('cold')
  await retry.pipelines
  expect(interactiveAttempts).toBe(2)
  expect(referenceAttempts).toBe(1)
  expect(cache.acquire(device, { interactive: false }).pipelines).toBe(reference.pipelines)
})

test('synchronous and asynchronous compiler failures are observed and do not poison pipeline retry', async () => {
  const { device } = pipelineDevice()
  let attempts = 0
  const cache = new HdrPipelineCache(() => {
    if (++attempts === 1) throw new Error('Synchronous shader failure.')
    if (attempts === 2) return Promise.reject(new Error('Asynchronous pipeline failure.'))
    return Promise.resolve(compiledPrograms('retry'))
  })
  const first = cache.acquire(device, { interactive: false })
  await expect(first.pipelines).rejects.toThrow('Synchronous shader failure')
  const second = cache.acquire(device, { interactive: false })
  expect(second.state).toBe('cold')
  await expect(second.pipelines).rejects.toThrow('Asynchronous pipeline failure')
  const third = cache.acquire(device, { interactive: false })
  expect(third.state).toBe('cold')
  expect((await third.pipelines).mip.label).toBe('retry')
  expect(attempts).toBe(3)
})

test('device loss rejects late compilation and never exposes those programs to a replacement device', async () => {
  const old = pipelineDevice(),
    replacement = pipelineDevice()
  let complete!: (programs: HdrPipelines) => void
  const cache = new HdrPipelineCache((device) =>
    device === old.device
      ? new Promise((resolve) => {
          complete = resolve
        })
      : Promise.resolve(compiledPrograms('replacement')),
  )
  const pending = cache.acquire(old.device, { interactive: true })
  await Promise.resolve()
  old.lose()
  await Promise.resolve()
  const fresh = cache.acquire(replacement.device, { interactive: true })
  complete(compiledPrograms('retired'))
  await expect(pending.pipelines).rejects.toThrow('device was lost')
  expect(() => cache.acquire(old.device, { interactive: true })).toThrow('device was lost')
  expect((await fresh.pipelines).mip.label).toBe('replacement')
  expect(cache.acquire(replacement.device, { interactive: true }).state).toBe('ready')
})

test('cached restoration and ordinary loads share a blit program while rejected compilation remains retryable', async () => {
  const { device } = pipelineDevice(),
    programs = compiledPrograms('blit')
  let modules = 0,
    attempts = 0
  Object.assign(device, {
    createShaderModule: () => {
      modules++
      return {} as GPUShaderModule
    },
    createRenderPipelineAsync: () =>
      ++attempts === 1
        ? Promise.reject(new Error('Native blit compilation failed.'))
        : Promise.resolve(programs.blit),
  })
  const rejected = presentationBlit(device)
  expect(presentationBlit(device)).toBe(rejected)
  await expect(rejected).rejects.toThrow('Native blit compilation failed')
  const retry = presentationBlit(device)
  expect(retry).not.toBe(rejected)
  expect(await retry).toBe(programs.blit)
  expect(presentationBlit(device)).toBe(retry)
  expect(attempts).toBe(2)
  expect(modules).toBe(2)
})

test('a late blit completion from a lost device cannot be reused or replace a new device program', async () => {
  const old = pipelineDevice(),
    replacement = pipelineDevice(),
    programs = compiledPrograms('replacement-blit')
  let complete!: (program: GPURenderPipeline) => void
  Object.assign(old.device, {
    createShaderModule: () => ({}) as GPUShaderModule,
    createRenderPipelineAsync: () =>
      new Promise<GPURenderPipeline>((resolve) => {
        complete = resolve
      }),
  })
  Object.assign(replacement.device, {
    createShaderModule: () => ({}) as GPUShaderModule,
    createRenderPipelineAsync: () => Promise.resolve(programs.blit),
  })
  const pending = presentationBlit(old.device)
  await Promise.resolve()
  old.lose()
  await Promise.resolve()
  const fresh = presentationBlit(replacement.device)
  complete(compiledPrograms('retired-blit').blit)
  await expect(pending).rejects.toThrow('device was lost')
  expect(() => presentationBlit(old.device)).toThrow('device was lost')
  expect(await fresh).toBe(programs.blit)
  expect(presentationBlit(replacement.device)).toBe(fresh)
})
