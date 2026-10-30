import { expect, test } from '@playwright/test'
import {
  hdrCachePlan,
  hdrCacheJobRuns,
  HdrRenderCache,
} from '../src/renderer/src/preview/hdr-render-cache'
import { hdrShader } from '../src/renderer/src/preview/hdr-shader'
import { HdrGpuTimings, type HdrGpuFrameTimings } from '../src/renderer/src/preview/hdr-gpu-timings'

const frame = { width: 4096, height: 3072 },
  viewport = { width: 1100, height: 700 }
const view = { fit: false, scale: 1, x: 0, y: 0 }
test('interactive arithmetic tiles cannot satisfy the full-quality settled cache identity', () => {
  const source = { width: 64, height: 64 }
  const cache = new HdrRenderCache(8)
  const plan = hdrCachePlan(source, source, { width: 16, height: 16 }, view, 'after', 0.5)
  const exact = { ...plan, variant: 'content-hdr' }
  const preview = { ...plan, variant: 'content-hdr:aces2-f32-interactive-v1' }
  const render = (p: typeof plan) => [...cache.batches(p, true)].map((batch) => batch.renderedTiles)
  expect(render(preview).some((count) => count > 0)).toBe(true)
  expect(cache.has(exact, true)).toBe(false)
  expect(render(exact).some((count) => count > 0)).toBe(true)
  expect(render(preview).every((count) => count === 0)).toBe(true)
  expect(render(exact).every((count) => count === 0)).toBe(true)
})
test('nearby pan and zoom reuse rendered texels without evaluating ACES in presentation', () => {
  const cache = new HdrRenderCache(128)
  const first = hdrCachePlan(frame, frame, viewport, view, 'after', 0.5)
  const render = (plan: ReturnType<typeof hdrCachePlan>) =>
    [...cache.batches(plan, false)].reduce((n, b) => n + b.renderedTiles, 0)
  expect(cache.has(first, false)).toBe(false)
  expect(render(first)).toBeGreaterThan(0)
  expect(cache.has(first, false)).toBe(true)
  expect(render(first)).toBe(0)
  expect(render(hdrCachePlan(frame, frame, viewport, { ...view, x: 4 }, 'after', 0.5))).toBe(0)
  expect(render(hdrCachePlan(frame, frame, viewport, { ...view, scale: 1.1 }, 'after', 0.5))).toBe(
    0,
  )
  expect(hdrShader).not.toContain('outputTransform_fwd')
  expect(hdrShader).not.toContain('adjusted(')
})
test('edits retire After tiles while neutral Before survives; target resets retire all', () => {
  const cache = new HdrRenderCache(128)
  const plan = hdrCachePlan(frame, frame, viewport, view, 'split', 0.5)
  cache.setEdits('old')
  const first = [...cache.batches(plan, false)]
  cache.setEdits('new')
  const edited = [...cache.batches(plan, false)]
  expect(edited[0].renderedTiles).toBeGreaterThan(0)
  expect(edited[0].renderedTiles).toBeLessThan(first[0].renderedTiles)
  expect([...cache.batches(plan, false)][0].renderedTiles).toBe(0)
  cache.reset()
  expect([...cache.batches(plan, false)][0].renderedTiles).toBe(first[0].renderedTiles)
})
test('neutral comparison shares tiles and bounded batches cover every visible tile', () => {
  const plan = hdrCachePlan(frame, frame, viewport, view, 'split', 0.5)
  const cache = new HdrRenderCache(3)
  const batches = [...cache.batches(plan, true)]
  expect(batches.length).toBeGreaterThan(1)
  expect(cache.size).toBeLessThanOrEqual(3)
  for (const tile of plan.tiles)
    expect(
      batches.some(
        (b) => b.lookup[(Number(tile.before) * plan.rows + tile.y) * plan.columns + tile.x] >= 0,
      ),
    ).toBe(true)
  for (const batch of batches) {
    expect(batch.renderedTiles).toBeLessThanOrEqual(3)
    expect([...batch.lookup].every((slot) => slot >= -1 && slot < 3)).toBe(true)
  }
  const neutral = [...new HdrRenderCache(128).batches(plan, true)][0]
  const edited = [...new HdrRenderCache(128).batches(plan, false)][0]
  const unique = new Set(plan.tiles.map((tile) => `${tile.x}:${tile.y}`))
  expect(neutral.renderedTiles).toBe(unique.size)
  expect(edited.renderedTiles).toBe(plan.tiles.length)
  expect(neutral.renderedTiles).toBeLessThan(edited.renderedTiles)
  for (const tile of plan.tiles) {
    const index = tile.y * plan.columns + tile.x
    if (neutral.lookup[index] >= 0 && neutral.lookup[index + plan.columns * plan.rows] >= 0)
      expect(neutral.lookup[index]).toBe(neutral.lookup[index + plan.columns * plan.rows])
  }
})
test('separate Before sources retain distinct neutral tiles and cannot replace the resident After', () => {
  const source = { width: 16, height: 16 },
    plan = {
      ...hdrCachePlan(source, source, source, view, 'split', 0.5, 16),
      beforeSourceIdentity: 'unfiltered-a',
    },
    cache = new HdrRenderCache(8),
    first = [...cache.batches(plan, true)][0]
  expect(first.renderedTiles).toBe(2)
  expect(first.lookup[0]).not.toBe(first.lookup[1])
  expect([...first.jobs].filter((_, i) => i % 4 === 3).sort()).toEqual([1, 3])
  const afterSlot = first.lookup[0],
    changed = [...cache.batches({ ...plan, beforeSourceIdentity: 'unfiltered-b' }, true)][0]
  expect(changed.renderedTiles).toBe(1)
  expect(changed.lookup[0]).toBe(afterSlot)
  expect(changed.jobs[3]).toBe(3)
  expect(cache.has(plan, true)).toBe(true)
  cache.setEdits('new-point-edit')
  const edited = [...cache.batches({ ...plan, beforeSourceIdentity: 'unfiltered-b' }, false)][0]
  expect(edited.renderedTiles).toBe(1)
  expect(edited.jobs[3]).toBe(0)
  expect(edited.lookup[1]).toBe(changed.lookup[1])
})
test('cache job runs bind one source per bounded dispatch and preserve ordinary job order', () => {
  const jobs = new Uint32Array([0, 1, 3, 3, 3, 0, 1].flatMap((flags, i) => [i, 0, i, flags])),
    runs = [...hdrCacheJobRuns(jobs, 2)]
  expect(runs.map((run) => [run.start, run.jobs.length / 4, run.beforeSource])).toEqual([
    [0, 2, false],
    [8, 2, true],
    [16, 1, true],
    [20, 2, false],
  ])
  expect(runs.flatMap((run) => [...run.jobs])).toEqual([...jobs])
  expect([...hdrCacheJobRuns(new Uint32Array([0, 0, 0, 0, 0, 0, 1, 1]), 32)]).toHaveLength(1)
  expect(() => [...hdrCacheJobRuns(jobs, 0)]).toThrow('batch')
  expect(() => [...hdrCacheJobRuns(jobs.subarray(1), 2)]).toThrow('batch')
})
test('mips, edge halos, split endpoints and off-image views keep lookups bounded', () => {
  for (const scale of [0.1, 0.51, 0.99, 1, 8, 32])
    for (const split of [0, 0.5, 1]) {
      const plan = hdrCachePlan(frame, frame, viewport, { ...view, scale }, 'split', split)
      expect(plan.tiles.length).toBeGreaterThan(0)
      for (const t of plan.tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0)
        expect(t.y).toBeGreaterThanOrEqual(0)
        expect(t.x).toBeLessThan(plan.columns)
        expect(t.y).toBeLessThan(plan.rows)
        expect(t.before ? split > 0 : split < 1).toBe(true)
      }
    }
  expect(hdrCachePlan(frame, frame, viewport, { ...view, x: 1e6 }, 'after', 0.5).tiles).toEqual([])
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function timingGlobals(work: () => Promise<void>) {
  // Exercise resource ownership in Node without loading a native GPU runtime.
  const values = {
    GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 },
    GPUMapMode: { READ: 1 },
  }
  const previous = Object.keys(values).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  try {
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(globalThis, name, { configurable: true, value })
    await work()
  } finally {
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
  }
}

type TimingFailure = 'allocation-throw' | 'allocation-validation' | 'submit-validation'
function timingProbe(failure?: TimingFailure) {
  const resources: { destroyCalls: number; destroy(): void }[] = []
  const scopes: { filter: GPUErrorFilter; error: GPUError | null }[] = []
  const uncaptured: string[] = []
  let buffers = 0,
    mappingCount = 0,
    unmapCount = 0
  let mapWaiter: Deferred<Deferred<void>> | undefined
  const resource = () => {
    const value = {
      destroyCalls: 0,
      destroy() {
        this.destroyCalls++
      },
    }
    resources.push(value)
    return value
  }
  const validation = (message: string) => {
    const scope = [...scopes].reverse().find((scope) => scope.filter === 'validation')
    if (scope) scope.error = new Error(message)
    else uncaptured.push(message)
  }
  const device = {
    pushErrorScope(filter: GPUErrorFilter) {
      scopes.push({ filter, error: null })
    },
    popErrorScope() {
      const scope = scopes.pop()
      if (!scope) throw new Error('No owned GPU error scope.')
      return Promise.resolve(scope.error)
    },
    createQuerySet: resource,
    createBuffer() {
      buffers++
      if (buffers === 2 && failure === 'allocation-throw') throw new Error('Allocation failed.')
      const owned = resource()
      if (buffers === 2 && failure === 'allocation-validation') validation('Invalid allocation.')
      return {
        ...owned,
        destroy: () => owned.destroy(),
        mapAsync() {
          mappingCount++
          const mapping = deferred<void>()
          mapWaiter!.resolve(mapping)
          mapWaiter = undefined
          return mapping.promise
        },
        getMappedRange: () =>
          new BigUint64Array([1_000_000n, 5_000_000n, 7_000_000n, 8_000_000n]).buffer,
        unmap() {
          unmapCount++
        },
      }
    },
    createCommandEncoder: () => ({
      resolveQuerySet: () => undefined,
      copyBufferToBuffer: () => undefined,
      finish: () => ({}),
    }),
    queue: {
      submit() {
        if (failure === 'submit-validation') {
          failure = undefined
          validation('Invalid diagnostic submission.')
        }
      },
    },
  } as unknown as GPUDevice
  return {
    device,
    resources,
    scopes,
    uncaptured,
    validation,
    nextMapping() {
      mapWaiter = deferred<Deferred<void>>()
      return mapWaiter.promise
    },
    get mappingCount() {
      return mappingCount
    },
    get unmapCount() {
      return unmapCount
    },
  }
}

for (const failure of ['allocation-throw', 'allocation-validation'] as const)
  test(`optional GPU timing ${failure} cleans acquired resources and leaves image errors unscoped`, async () => {
    await timingGlobals(async () => {
      const probe = timingProbe(failure),
        errors: string[] = [],
        observations: HdrGpuFrameTimings[] = []
      const timing = new HdrGpuTimings(
        probe.device,
        (value) => observations.push(value),
        (error) => errors.push(error),
      )
      try {
        expect(probe.scopes).toHaveLength(0)
        expect(await timing.ready).toBe(false)
        expect(errors).toHaveLength(1)
        expect(observations).toEqual([])
        expect(probe.uncaptured).toEqual([])
        expect(probe.resources).toHaveLength(failure === 'allocation-throw' ? 2 : 3)
        expect(probe.resources.every((resource) => resource.destroyCalls === 1)).toBe(true)
        expect(timing.begin(1, 1, 'source')).toBeUndefined()
        // The diagnostic scopes must also stop owning unrelated image failures.
        probe.validation('Independent image validation.')
        expect(probe.uncaptured).toEqual(['Independent image validation.'])
      } finally {
        timing.dispose()
      }
      expect(probe.resources.every((resource) => resource.destroyCalls === 1)).toBe(true)
    })
  })

test('optional GPU timing submission errors disable diagnostics without an uncaptured image failure', async () => {
  await timingGlobals(async () => {
    const probe = timingProbe('submit-validation'),
      failed = deferred<string>(),
      observations: HdrGpuFrameTimings[] = []
    const timing = new HdrGpuTimings(
      probe.device,
      (value) => observations.push(value),
      failed.resolve,
    )
    try {
      expect(await timing.ready).toBe(true)
      const frame = timing.begin(8, 2, 'source')!
      timing.writes(frame, 'tile')
      expect(timing.finish(frame, true)).toBeUndefined()
      expect(probe.scopes).toHaveLength(0)
      expect(await failed.promise).toContain('Invalid diagnostic submission.')
      expect(probe.uncaptured).toEqual([])
      expect(observations).toEqual([])
      expect(probe.mappingCount).toBe(0)
      expect(timing.begin(9, 2, 'source')).toBeUndefined()
      expect(probe.resources.every((resource) => resource.destroyCalls === 1)).toBe(true)
    } finally {
      timing.dispose()
    }
  })
})

test('GPU timing readback is single-flight, attributes its immutable request, and suppresses late disposal results', async () => {
  await timingGlobals(async () => {
    const probe = timingProbe(),
      published = deferred<HdrGpuFrameTimings>(),
      observations: HdrGpuFrameTimings[] = [],
      errors: string[] = []
    const timing = new HdrGpuTimings(
      probe.device,
      (result) => {
        observations.push(result)
        published.resolve(result)
      },
      (error) => errors.push(error),
      2,
    )
    try {
      expect(timing.begin(1, 1, 'not-ready')).toBeUndefined()
      expect(await timing.ready).toBe(true)
      const frame = timing.begin(43, 7, 'source-one')!
      timing.writes(frame, 'tile')
      timing.writes(frame, 'blit')
      const mappingStarted = probe.nextMapping()
      expect(timing.finish(frame, true)).toBeUndefined()
      expect(timing.begin(44, 7, 'source-one')).toBeUndefined()
      const mapping = await mappingStarted
      expect(probe.scopes).toHaveLength(0)
      expect(probe.mappingCount).toBe(1)
      expect(timing.begin(45, 8, 'source-two')).toBeUndefined()
      mapping.resolve()
      expect(await published.promise).toEqual({
        inputSerial: 43,
        epoch: 7,
        sourceIdentity: 'source-one',
        tileGpuMs: 4,
        offscreenGpuMs: 0,
        blitGpuMs: 1,
        measuredPasses: 2,
        droppedPasses: 0,
        complete: 1,
        imagePresented: 1,
      })
      expect(probe.unmapCount).toBe(1)
      const next = timing.begin(46, 8, 'source-two')!
      expect(next).toBeDefined()
      timing.writes(next, 'offscreen')
      const lateMappingStarted = probe.nextMapping()
      timing.finish(next, false)
      const lateMapping = await lateMappingStarted
      timing.dispose()
      lateMapping.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(observations).toHaveLength(1)
      expect(errors).toEqual([])
      expect(probe.uncaptured).toEqual([])
      expect(probe.resources.every((resource) => resource.destroyCalls === 1)).toBe(true)
    } finally {
      timing.dispose()
    }
  })
})
