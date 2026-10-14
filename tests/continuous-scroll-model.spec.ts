import { expect, test } from '@playwright/test'
import { collectionPolicy } from '../src/shared/collections'
import {
  CollectionController,
  CollectionQueue,
  CollectionRefresh,
  type CollectionWindow,
} from '../src/renderer/src/collections/controller'
import {
  captureAnchor,
  collectionWindow,
  gridLayout,
  locateAnchor,
  measuredLayout,
} from '../src/renderer/src/collections/layout'
import { ThumbnailCache, decodeThumbnail } from '../src/renderer/src/collections/thumbnails'
import { WorkspaceCheckpoint } from '../src/renderer/src/collections/workspace-checkpoint'
import { DEFAULT_WORKSPACE, type WorkspaceChange } from '../src/shared/workspace'
import { restoreView, savedView } from '../src/renderer/src/preview/geometry'
import {
  applyCandidateSelection,
  applyReviewSelection,
} from '../src/renderer/src/collections/import-selection'
import type { ImportCandidate, ImportReviewSummary } from '../src/shared/contracts'

const gib = 1024 ** 3
for (const [memory, cpus, tier] of [
  [undefined, undefined, 'conservative'],
  [7.99 * gib, 8, 'conservative'],
  [16 * gib, 3, 'conservative'],
  [8 * gib, 4, 'standard'],
  [15.99 * gib, 8, 'standard'],
  [16 * gib, 7, 'standard'],
  [16 * gib, 8, 'capable'],
] as const)
  test(`resource policy ${memory ?? 'unavailable'} bytes and ${cpus ?? 'unavailable'} CPUs`, () => {
    const result = collectionPolicy(memory, cpus)
    expect(result.tier).toBe(tier)
    expect(result).toEqual(
      tier === 'conservative'
        ? { tier, records: 300, decodedBytes: 32 * 1024 ** 2, concurrency: 2, lookahead: 1 }
        : tier === 'standard'
          ? { tier, records: 600, decodedBytes: 64 * 1024 ** 2, concurrency: 3, lookahead: 2 }
          : { tier, records: 1200, decodedBytes: 128 * 1024 ** 2, concurrency: 4, lookahead: 3 },
    )
  })
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const demand = (indices: number[], lookahead: number[] = []): CollectionWindow => ({
  visible: indices,
  overscan: indices,
  lookahead,
  pinned: [],
  active: true,
})
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
test('deduplicates visible and keyboard reads and upgrades queued visible work ahead of speculation', async () => {
  const queue = new CollectionQueue(1),
    first = gate<{ records: number[] }>(),
    calls: number[] = []
  const controller = new CollectionController<number>(queue)
  controller.configure('one', 600, async (offset) => {
    calls.push(offset)
    return offset === 0 ? first.promise : { records: range(offset, offset + 60) }
  })
  controller.setWindow(demand([0], [60, 120, 180]))
  const visible = controller.get(180),
    duplicate = controller.get(180)
  await expect.poll(() => calls).toEqual([0])
  first.resolve({ records: range(0, 60) })
  expect(await visible).toBe(180)
  expect(await duplicate).toBe(180)
  expect(calls.slice(0, 2)).toEqual([0, 180])
  expect(calls.filter((i) => i === 180)).toHaveLength(1)
  controller.close()
})
test('direction reversal, query changes and suspension cancel obsolete reads and ignore late chunks', async () => {
  const queue = new CollectionQueue(2),
    held = gate<{ records: number[] }>(),
    aborts: number[] = []
  const controller = new CollectionController<number>(queue)
  controller.configure('one', 1000, async (offset, signal) => {
    signal.addEventListener('abort', () => aborts.push(offset))
    return offset === 60 ? held.promise : { records: range(offset, offset + 60) }
  })
  controller.setWindow(demand([120], [60, 180]))
  await expect.poll(() => controller.getSnapshot().records.has(120)).toBe(true)
  controller.setWindow(demand([120], [240]))
  await expect.poll(() => aborts).toContain(60)
  controller.configure('two', 1000, async (offset) => ({
    records: range(offset + 1000, offset + 1060),
  }))
  controller.setWindow(demand([0]))
  held.resolve({ records: range(60, 120) })
  await expect.poll(() => controller.getSnapshot().records.get(0)).toBe(1000)
  expect(controller.getSnapshot().records.has(60)).toBe(false)
  controller.suspend()
  expect(controller.getSnapshot().loading).toBe(false)
  controller.close()
})
test('scrollbar jumps and revisits stay bounded while visible and keyboard pins exceed the policy minimum safely', async () => {
  const controller = new CollectionController<number>(new CollectionQueue(3), () => ({
    ...collectionPolicy(),
    records: 120,
  }))
  const calls: number[] = []
  controller.configure('one', 5000, async (offset) => {
    calls.push(offset)
    return { records: range(offset, offset + 60) }
  })
  for (const start of [0, 900, 3000, 0]) {
    controller.setWindow({ ...demand(range(start, start + 20)), pinned: [4999] })
    await controller.get(start)
    await controller.get(4999)
    expect(controller.getSnapshot().records.size).toBeLessThanOrEqual(120)
    expect(controller.getSnapshot().records.get(4999)).toBe(4999)
  }
  expect(calls.filter((i) => i === 0)).toHaveLength(2)
  controller.setWindow(demand(range(0, 240)))
  await controller.refreshWindow()
  expect(controller.getSnapshot().records.size).toBe(240)
  expect([...controller.getSnapshot().records.keys()].sort((a, b) => a - b)).toEqual(range(0, 240))
  controller.close()
})
test('read failure reserves the same layout, Retry reloads it, and close rejects pending keyboard requests', async () => {
  let fail = true
  const controller = new CollectionController<number>(new CollectionQueue(1))
  controller.configure('one', 200, async (offset) => {
    if (fail) throw new Error('Read unavailable')
    return { records: range(offset, offset + 60) }
  })
  controller.setWindow(demand([0]))
  await expect.poll(() => controller.getSnapshot().error).toContain('Read unavailable')
  expect(gridLayout(200, 4, 190).height).toBe(9500)
  fail = false
  controller.retry()
  await expect.poll(() => controller.getSnapshot().records.get(0)).toBe(0)
  const held = gate<{ records: number[] }>()
  controller.configure('two', 200, () => held.promise)
  const pending = controller.get(100)
  controller.close()
  await expect(pending).rejects.toThrow('Cancelled')
  held.resolve({ records: range(60, 120) })
})
test('serial refresh coalesces a burst into one follow-up and never overlaps reads', async () => {
  const held = gate<void>()
  let calls = 0,
    active = 0,
    maximum = 0
  const refresh = new CollectionRefresh(async () => {
    calls++
    maximum = Math.max(maximum, ++active)
    if (calls === 1) await held.promise
    active--
  })
  const first = refresh.request()
  for (let i = 0; i < 20; i++) void refresh.request()
  expect(calls).toBe(1)
  held.resolve()
  await first
  expect(calls).toBe(2)
  expect(maximum).toBe(1)
  refresh.close()
})
test('grid and measured layouts preserve full scroll extents, directional lookahead and stable ID anchors', async () => {
  const layout = gridLayout(100000, 6, 190),
    window = collectionWindow(layout, 1900, 380, 1, 3, [99999], true)
  expect(layout.rowHeight).toBe(190)
  expect(window.visible).toEqual(range(60, 72))
  expect(window.overscan).toEqual(range(48, 84))
  expect(window.lookahead).toEqual(range(84, 108))
  const backwards = collectionWindow(layout, 1900, 380, -1, 2, [], true)
  expect(backwards.lookahead).toEqual(range(36, 48).reverse())
  const records = new Map(range(50, 75).map((i) => [i, { id: `photo-${i}` }]))
  const anchor = captureAnchor(layout, 1917, records, (p) => p.id)!
  expect(anchor).toMatchObject({
    id: 'photo-60',
    index: 60,
    inset: 17,
    afterId: 'photo-61',
    beforeId: 'photo-59',
  })
  expect(
    await locateAnchor(
      { ...anchor, coverId: 'cover' },
      async (id) => (id === 'cover' ? 20 : null),
      100,
    ),
  ).toBe(20)
  expect(await locateAnchor(anchor, async (id) => (id === 'photo-61' ? 59 : null), 100)).toBe(59)
  expect(await locateAnchor(anchor, async () => null, 40)).toBe(39)
  const measured = measuredLayout(
    125,
    new Map([
      [0, 300],
      [60, 480],
    ]),
  )
  expect(measured.top(1)).toBe(300)
  expect(measured.first(measured.top(60) + 479)).toBe(60)
  expect(measured.indices(measured.height - 120, 120).at(-1)).toBe(124)
})
test('decoded references obey their memory budget, pin visible images, cancel obsolete lookahead and release on close', async () => {
  const releases: string[] = [],
    held = gate<{ url: string; width: number; height: number; release: () => void }>()
  const cache = new ThumbnailCache(
    async (url) =>
      url === 'held'
        ? held.promise
        : { url, width: 100, height: 100, release: () => releases.push(url) },
    new CollectionQueue(2),
    () => 80000,
  )
  const owner = {}
  cache.update(owner, [
    { url: 'a', priority: 0, pinned: true },
    { url: 'b', priority: 2, pinned: false },
    { url: 'c', priority: 2, pinned: false },
  ])
  await expect.poll(() => cache.get('c')?.url).toBe('c')
  expect(cache.decodedBytes).toBe(80000)
  expect(cache.get('a')).toBeDefined()
  expect(releases).toContain('b')
  cache.update(owner, [
    { url: 'a', priority: 0, pinned: true },
    { url: 'held', priority: 2, pinned: false },
  ])
  cache.remove(owner)
  held.resolve({ url: 'held', width: 100, height: 100, release: () => releases.push('held') })
  await expect.poll(() => cache.get('held')).toBeUndefined()
  cache.close()
  expect(cache.decodedBytes).toBe(0)
  expect(releases).toContain('a')
})
test('optimistic bulk totals and row state apply once across independently arriving content and selection revisions', () => {
  const summary = {
    selected: 10,
    selectedBytes: 10240,
    unchecked: 10,
    ready: 0,
    totalBytes: 10240,
    selectionRevision: 0,
  } as ImportReviewSummary
  const changes = [
    { version: 1, ids: null, selected: false, previous: true, bytes: 0 },
    { version: 2, ids: ['x'], selected: true, previous: false, bytes: 1024 },
  ]
  expect(applyReviewSelection(summary, changes)).toMatchObject({ selected: 1, selectedBytes: 1024 })
  expect(
    applyReviewSelection(
      { ...summary, selected: 1, selectedBytes: 1024, selectionRevision: 2 },
      changes,
    ),
  ).toMatchObject({ selected: 1, selectedBytes: 1024 })
  const candidate = { id: 'x', status: 'unchecked', selected: true } as ImportCandidate
  expect(applyCandidateSelection(candidate, 0, changes).selected).toBe(true)
  expect(applyCandidateSelection({ ...candidate, id: 'y' }, 0, changes).selected).toBe(false)
  const imported = { ...candidate, selected: false, alreadyImported: true }
  expect(applyCandidateSelection(imported, 0, changes, true)).toBe(imported)
})
test('checkpoint throttle commits within 500ms during continuous interaction and scroll saves omit large selections', async () => {
  const saved: WorkspaceChange[] = [],
    checkpoint = new WorkspaceCheckpoint(async (change) => {
      saved.push(change)
      return saved.length
    })
  const selected = range(0, 10000).map((i) => ({ id: `id-${i}`, filename: `${i}` }))
  checkpoint.hydrate({
    checkpoint: 1,
    state: DEFAULT_WORKSPACE,
    selected,
    activePhoto: null,
    libraryPhoto: null,
  })
  checkpoint.patch({ consoleOpen: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  checkpoint.patch({ mode: 'library' })
  await new Promise((resolve) => setTimeout(resolve, 260))
  expect(saved).toHaveLength(1)
  expect(saved[0]).toEqual({ state: { mode: 'library', consoleOpen: true } })
  checkpoint.selection([...selected.slice(0, -1).map((p) => p.id), 'new'])
  await checkpoint.flush()
  expect(saved[1]).toEqual({ selection: { added: ['new'], removed: ['id-9999'] } })
  checkpoint.close()
})
test('failed checkpoints remain dirty and retryable, and hydration cannot save defaults', async () => {
  let fail = true
  const saved: WorkspaceChange[] = [],
    status: string[] = []
  const checkpoint = new WorkspaceCheckpoint(
    async (change) => {
      if (fail) throw new Error('disk full')
      saved.push(change)
      return 1
    },
    (message) => status.push(message),
  )
  checkpoint.patch({ consoleOpen: true })
  await checkpoint.flush()
  expect(saved).toEqual([])
  checkpoint.hydrate({
    checkpoint: 1,
    state: { ...DEFAULT_WORKSPACE, consoleOpen: true },
    selected: [],
    activePhoto: null,
    libraryPhoto: null,
  })
  checkpoint.patch({ mode: 'library' })
  await expect(checkpoint.flush()).rejects.toThrow('disk full')
  expect(status.at(-1)).toContain('could not be saved')
  fail = false
  await checkpoint.retry()
  expect(saved).toEqual([{ state: { mode: 'library' } }])
  expect(status.at(-1)).toBe('')
  checkpoint.close()
})
test('effect cleanup and setup can resume refreshes and hydrated checkpoints without losing pending work', async () => {
  const first = gate<void>()
  let reads = 0
  const refresh = new CollectionRefresh(async () => {
    reads++
    if (reads === 1) await first.promise
  })
  const pending = refresh.request()
  refresh.close()
  await refresh.request()
  expect(reads).toBe(1)
  refresh.resume()
  const restarted = refresh.request()
  first.resolve(undefined)
  await Promise.all([pending, restarted])
  expect(reads).toBe(2)
  refresh.close()

  const saved: WorkspaceChange[] = []
  const checkpoint = new WorkspaceCheckpoint(
    async (change) => {
      saved.push(change)
      return saved.length
    },
    () => {},
    5,
  )
  checkpoint.resume()
  checkpoint.close()
  checkpoint.resume()
  checkpoint.hydrate({
    checkpoint: 1,
    state: { ...DEFAULT_WORKSPACE, consoleOpen: true },
    selected: [{ id: 'selected', filename: 'selected.jpg' }],
    activePhoto: null,
    libraryPhoto: null,
  })
  checkpoint.patch({ mode: 'library' })
  checkpoint.close()
  await checkpoint.flush()
  expect(saved).toEqual([])
  checkpoint.resume()
  await expect.poll(() => saved).toEqual([{ state: { mode: 'library' } }])
  expect(saved).toEqual([{ state: { mode: 'library' } }])
  checkpoint.selection([])
  await checkpoint.flush()
  expect(saved[1]).toEqual({ selection: { added: [], removed: ['selected'] } })
  checkpoint.close()
})
test('zoom recovery uses normalized authoritative centers and constrains to the new viewport', () => {
  const view = { fit: false, scale: 2, x: 200, y: -100 },
    image = { width: 1200, height: 800 }
  const saved = savedView('photo', view, image)
  const recovered = restoreView(saved, { width: 2400, height: 1600 }, { width: 700, height: 400 })
  expect(recovered).toMatchObject({ fit: false, scale: 2, y: -200 })
  expect(recovered.x).toBeCloseTo(400, 8)
  expect(restoreView({ ...saved, fit: true }, image, { width: 2400, height: 1600 })).toMatchObject({
    fit: true,
    scale: 1,
    x: 0,
    y: 0,
  })
  expect(
    restoreView({ ...saved, centerX: 0, centerY: 1 }, image, { width: 700, height: 400 }),
  ).toMatchObject({ x: 850, y: -600 })
})

test('aborted browser decodes settle even when Image.decode itself never settles, releasing queue capacity', async () => {
  const original = globalThis.Image
  class HeldImage {
    src = ''
    naturalWidth = 1
    naturalHeight = 1
    decode() {
      return new Promise<void>(() => {})
    }
  }
  globalThis.Image = HeldImage as unknown as typeof Image
  try {
    const queue = new CollectionQueue(1),
      cache = new ThumbnailCache(decodeThumbnail, queue, () => 1024)
    const owner = {}
    cache.update(owner, [{ url: 'held', priority: 2, pinned: false }])
    await new Promise<void>((resolve) => setImmediate(resolve))
    cache.remove(owner)
    const controller = new CollectionController<number>(queue)
    controller.configure('new', 1, async () => ({ records: [42] }))
    controller.setWindow(demand([0]))
    expect(await controller.get(0)).toBe(42)
    controller.close()
    cache.close()
  } finally {
    if (original) globalThis.Image = original
    else delete (globalThis as unknown as { Image?: typeof Image }).Image
  }
})
