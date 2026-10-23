import { seedFixtureEdits } from './catalog-fixture.helpers'
import { test, expect } from '@playwright/test'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { bracketFrames } from './brk.helpers'
import { sequenceMetadata } from './capture.helpers'
import { stackFixture, finishTask } from './stack.helpers'
import {
  automaticLensSettings,
  PROCESSING_METADATA_VERSION,
  type ProcessingMetadata,
} from '../src/shared/lens'
import { unavailableProfile } from '../src/main/processing/metadata'
import { identityMatrix, WHITE_BALANCE_MODEL } from '../src/shared/white-balance'

test('partial brackets extend across shuffled metadata batches and survive restart and deletion', async () => {
  const t = await stackFixture(3),
    frames = bracketFrames()
  try {
    t.capture(1, frames[1].metadata)
    expect(t.store.reconcileCaptures()).toBe(0)
    t.capture(0, frames[0].metadata)
    expect(t.store.reconcileCaptures()).toBe(1)
    const partial = t.library.listStacks().stacks[0]
    await t.library.setStackExpanded(partial.id, true, partial.revision)
    t.capture(2, frames[2].metadata)
    expect(t.store.reconcileCaptures()).toBe(1)
    expect(t.library.listStacks().stacks[0]).toMatchObject({
      id: partial.id,
      count: 3,
      coverId: partial.coverId,
      expanded: true,
    })
    await t.restart()
    expect(t.library.listStacks().stacks[0].count).toBe(3)
    await finishTask(t.library, t.library.deletePhotos([t.photos[2].id])!)
    expect(t.library.listStacks().stacks[0].count).toBe(2)
    expect(t.store.reconcileCaptures()).toBe(0)
  } finally {
    await t.close()
  }
})

test('refresh repairs untouched automatic groups, retaining the earliest grouped cover and expansion', async () => {
  const t = await stackFixture(4)
  try {
    for (let i = 0; i < 4; i++)
      t.capture(
        i,
        sequenceMetadata(
          (i % 2) + 1,
          `2026-10-04T14:42:${i < 2 ? '32' : '33'}.${String(i * 80).padStart(3, '0')}`,
        ),
      )
    expect(t.store.reconcileCaptures()).toBe(2)
    const first = t.library.getPhotoStack(t.photos[0].id)!,
      second = t.library.getPhotoStack(t.photos[2].id)!
    await t.library.setStackExpanded(first.id, true, first.revision)
    for (let i = 0; i < 4; i++) t.capture(i, sequenceMetadata(i + 1))
    expect(t.store.reconcileCaptures()).toBe(1)
    expect(t.library.listStacks().stacks).toMatchObject([
      { id: first.id, coverId: first.coverId, expanded: true, count: 4 },
    ])
    expect(t.library.listStacks().stacks.some((s) => s.id === second.id)).toBe(false)
    expect(t.store.reconcileCaptures()).toBe(0)
  } finally {
    await t.close()
  }
})

for (const protection of [
  'manual',
  'merge',
  'cover',
  'remove',
  'ungroup',
  'foreign-member',
] as const)
  test(`${protection} protects automatic grouping choices`, async () => {
    const t = await stackFixture(4),
      frames = bracketFrames()
    try {
      for (let i = 0; i < 3; i++) t.capture(i, frames[i].metadata)
      if (protection === 'manual')
        await t.library.groupPhotos(
          t.photos.slice(0, 2).map((p) => p.id),
          t.photos[0].id,
          t.library.listStacks().revision,
        )
      else {
        t.store.reconcileCaptures()
        const stack = t.library.listStacks().stacks[0]
        if (protection === 'merge')
          t.db.prepare("UPDATE stacks SET origin = 'merge' WHERE id = ?").run(stack.id)
        if (protection === 'cover')
          await t.library.setStackCover(stack.id, t.photos[1].id, stack.revision)
        if (protection === 'remove') await t.library.removeFromStack(t.photos[2].id, stack.revision)
        if (protection === 'ungroup') await t.library.ungroupStack(stack.id, stack.revision)
        if (protection === 'foreign-member')
          t.db.prepare('INSERT INTO stack_members VALUES (?, ?, 3)').run(t.photos[3].id, stack.id)
      }
      const before = t.library.listStacks()
      expect(t.store.reconcileCaptures()).toBe(0)
      expect(t.library.listStacks()).toEqual(before)
    } finally {
      await t.close()
    }
  })

test('explicit grouping refreshes version 1 records to v2 while cancellation publishes no partial groups', async () => {
  const t = await stackFixture(3),
    frames = bracketFrames()
  let inspected = 0
  try {
    for (let i = 0; i < 3; i++) t.capture(i, { ...frames[i].metadata, version: 1 })
    const processor = {
      inspectCapture: async (path: string) => {
        inspected++
        return frames[t.photos.findIndex((p) => path.includes(p.id))].metadata
      },
      close: async () => {},
    }
    ;(t.library as unknown as { captureProcessor: typeof processor }).captureProcessor = processor
    const task = t.library.groupCaptureSequences()
    await t.library.cancelTask(task)
    expect(t.library.listStacks().stacks).toEqual([])
    expect(inspected).toBe(0)
    const retry = await finishTask(t.library, t.library.groupCaptureSequences())
    expect(retry.status).toBe('completed')
    expect(inspected).toBe(3)
    expect(t.library.listStacks().stacks[0].count).toBe(3)
    for (const p of t.photos) expect(t.store.capture(p.id)?.version).toBe(2)
    await t.restart()
    expect(t.library.listStacks().stacks[0].count).toBe(3)
  } finally {
    await t.close()
  }
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function captureConcurrencyFixture() {
  const t = await stackFixture(3),
    frames = bracketFrames(),
    started = deferred<void>(),
    release = deferred<void>(),
    inspected: string[] = []
  let active = 0,
    maximumConcurrent = 0,
    closeWhileActive = 0
  const processor = {
    inspectCapture: async (path: string, signal: AbortSignal) => {
      const index = t.photos.findIndex((p) => path.includes(p.id))
      maximumConcurrent = Math.max(maximumConcurrent, ++active)
      if (active > 1) {
        active--
        throw new Error('The capture worker is busy.')
      }
      inspected.push(t.photos[index].id)
      try {
        if (inspected.length === 1) {
          const aborted = deferred<never>(),
            onAbort = () => aborted.reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          started.resolve()
          try {
            signal.throwIfAborted()
            await Promise.race([release.promise, aborted.promise])
          } finally {
            signal.removeEventListener('abort', onAbort)
          }
        } else await new Promise<void>((resolve) => setImmediate(resolve))
        signal.throwIfAborted()
        return structuredClone(frames[index].metadata)
      } finally {
        active--
      }
    },
    close: async () => {
      if (active) {
        closeWhileActive++
        throw new Error('The capture worker closed during an inspection.')
      }
    },
  }
  ;(t.library as unknown as { captureProcessor: typeof processor }).captureProcessor = processor
  for (const [index, photo] of t.photos.entries()) {
    const original = join(t.root, 'library', 'originals', photo.id)
    await rename(join(original, 'original.jpg'), join(original, 'original.arw'))
    photo.filename = `photo-${index}.ARW`
    photo.format = 'ARW'
    t.db.prepare('UPDATE photos SET photo = ? WHERE id = ?').run(JSON.stringify(photo), photo.id)
    const metadata: ProcessingMetadata = {
      version: PROCESSING_METADATA_VERSION,
      make: 'SONY',
      model: 'ZV-1A',
      hdrEligible: true,
      capture: { shutterSeconds: 0.01, iso: 100, aperture: 2.8, focalLength: 9.4 },
      lensProfile: unavailableProfile,
      whiteBalance: {
        provider: 'test',
        version: '1',
        identity: 'capture-concurrency-test',
        model: WHITE_BALANCE_MODEL,
        asShotGains: [1, 1, 1],
        xyzToCamera: identityMatrix,
        cameraToWorking: identityMatrix,
        ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
        estimate: { kelvin: 6500, tint: 0 },
      },
    }
    t.db
      .prepare('INSERT INTO processing VALUES (?, ?)')
      .run(photo.id, JSON.stringify({ metadata, settings: automaticLensSettings, revision: 0 }))
    seedFixtureEdits(t.db)
    t.capture(index, { ...frames[index].metadata, version: 1 })
  }
  return {
    ...t,
    started: started.promise,
    release: () => release.resolve(),
    inspected,
    stats: () => ({ active, maximumConcurrent, closeWhileActive }),
  }
}

test('capture refresh during review creation preserves both results and source leases', async () => {
  const t = await captureConcurrencyFixture(),
    ids = t.photos.map((p) => p.id)
  try {
    const creating = t.library.createMergeReview(ids, 'hdr')
    await t.started
    const grouping = t.library.groupCaptureSequences()
    expect(t.library.merges.leased(ids)).toBe(true)
    t.release()
    const review = await creating,
      grouped = await finishTask(t.library, grouping)
    expect(grouped.status).toBe('completed')
    expect(t.library.listStacks().stacks[0]).toMatchObject({ count: 3, origin: 'capture' })
    expect(review.sources.map((s) => s.captureMetadata?.sequenceNumber)).toEqual([1, 2, 3])
    expect(t.inspected).toHaveLength(6)
    expect(t.stats()).toEqual({ active: 0, maximumConcurrent: 1, closeWhileActive: 0 })
    expect(() => t.library.deletePhotos(ids)).toThrow('Close the merge review')
    await t.library.disposeMergeReview(review.id)
    expect(t.library.merges.leased(ids)).toBe(false)
  } finally {
    t.release()
    await t.close()
  }
})

test('cancelled queued capture refresh drains without interrupting source verification', async () => {
  const t = await captureConcurrencyFixture(),
    ids = t.photos.map((p) => p.id)
  try {
    const creating = t.library.createMergeReview(ids, 'hdr')
    await t.started
    const grouping = t.library.groupCaptureSequences(),
      cancelled = t.library.cancelTask(grouping)
    t.release()
    const review = await creating
    await cancelled
    expect(t.library.listTasks().find((task) => task.id === grouping)?.status).toBe('cancelled')
    expect(t.library.listStacks().stacks).toEqual([])
    expect(t.inspected).toEqual(ids)
    expect(review.sources.map((s) => s.captureMetadata?.sequenceNumber)).toEqual([1, 2, 3])
    expect(t.stats()).toEqual({ active: 0, maximumConcurrent: 1, closeWhileActive: 0 })
    expect(() => t.library.deletePhotos(ids)).toThrow('Close the merge review')
    expect((await finishTask(t.library, t.library.groupCaptureSequences())).status).toBe(
      'completed',
    )
    expect(t.library.listStacks().stacks[0].count).toBe(3)
    await t.library.disposeMergeReview(review.id)
  } finally {
    t.release()
    await t.close()
  }
})

test('shutdown cancels capture inspection owners before draining the shared worker', async () => {
  const t = await captureConcurrencyFixture(),
    ids = t.photos.map((p) => p.id)
  try {
    const creating = t.library.createMergeReview(ids, 'hdr').then(
      () => false,
      () => true,
    )
    await t.started
    const grouping = t.library.groupCaptureSequences()
    await t.library.close()
    expect(await creating).toBe(true)
    expect(t.library.listTasks().find((task) => task.id === grouping)?.status).toBe('cancelled')
    expect(t.library.merges.leased(ids)).toBe(false)
    expect(t.inspected).toEqual([ids[0]])
    expect(t.stats()).toEqual({ active: 0, maximumConcurrent: 1, closeWhileActive: 0 })
  } finally {
    t.release()
    await t.close()
  }
})
