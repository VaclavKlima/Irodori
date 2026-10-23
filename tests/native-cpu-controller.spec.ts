import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CpuPreviewPair } from '../src/shared/native-cpu-preview'
import { WorkScheduler } from '../src/main/work-scheduler'
import { NativeCpuCancelled } from '../src/main/native-cpu-controller'
import { neutralAdjustments } from '../src/shared/adjustments'
import {
  controllerFixture,
  cpuOracle,
  deferred,
  observed,
  processExists,
  readPlane,
  rejected,
  resourcePolicy,
  scratchNames,
  sha,
  valueOf,
} from './native-cpu-controller.helpers'

test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'The native CPU owner currently supports Linux x64 only.',
)
test.setTimeout(30000)

test('source removal drains the old owner inside a real mutation without waiting on unrelated admission or inheriting mutation context', async () => {
  for (const replaceQueued of [false, true]) {
    await test.step(
      replaceQueued
        ? 'a new latest ticket arrives during cleanup'
        : 'the unrelated queued ticket survives removal',
      async () => {
        const scheduler = new WorkScheduler(),
          admissions: boolean[] = []
        const releaseEntered = deferred(),
          releaseGate = deferred(),
          mutationEntered = deferred()
        const allowRemoval = deferred(),
          removalCalled = deferred(),
          endMutation = deferred()
        let oldCacheId = '',
          removalFinished = false
        const t = await controllerFixture({
          synthetic: {},
          // Model FullPreviews.runCpuForeground: cleanup completion can inherit
          // the Trash mutation's AsyncLocalStorage context, so explicitly detach.
          foreground: (work, signal) =>
            scheduler.detached(() =>
              scheduler.run(
                'interactive',
                async () => {
                  admissions.push(scheduler.mutating)
                  return work()
                },
                signal,
              ),
            ),
          release: async (record) => {
            if (record.ref.cacheId === oldCacheId) {
              releaseEntered.resolve()
              await releaseGate.promise
            }
          },
        })
        let held: ReturnType<typeof t.controller.acquire>
        let mutation: ReturnType<typeof observed<void>> | undefined
        try {
          const old = await t.source(`mutation-old-${replaceQueued}`),
            first = t.request(old, { generation: 1 })
          oldCacheId = old.ref.cacheId
          const prior = await t.controller.render(first)
          await t.controller.acknowledge(first.sessionId, prior.pairId, null)
          held = t.controller.acquire(new URL(prior.after.url))
          expect(held).toBeTruthy()
          const next = await t.source(`mutation-next-${replaceQueued}`),
            sessionId = randomUUID()
          mutation = observed(
            scheduler.run('operation', () =>
              scheduler.mutate(async () => {
                mutationEntered.resolve()
                await allowRemoval.promise
                const removal = t.controller.beforeRemoval(old.ref.photoId)
                removalCalled.resolve()
                await removal
                removalFinished = true
                await endMutation.promise
              }),
            ),
          )
          await mutationEntered.promise
          expect(scheduler.mutating).toBe(true)
          const queuedRequest = t.request(next, { generation: 2, sessionId })
          const queued = observed(t.controller.render(queuedRequest))
          await expect.poll(() => scheduler.interactivePending, { timeout: 3000 }).toBe(true)
          expect(admissions).toEqual([false])
          allowRemoval.resolve()
          await removalCalled.promise
          await expect
            .poll(
              () => {
                const probe = t.controller.acquire(new URL(prior.after.url))
                if (probe) {
                  probe.release()
                  return false
                }
                return true
              },
              { timeout: 3000, intervals: [1, 5, 10, 25] },
            )
            .toBe(true)
          held!.release()
          held = undefined
          await releaseEntered.promise
          expect(old.handles.size).toBe(1)
          expect(next.acquisitions).toBe(0)
          expect(admissions).toEqual([false])
          let latest = queued,
            latestRequest = queuedRequest
          if (replaceQueued) {
            latestRequest = t.request(next, { generation: 3, sessionId })
            latest = observed(t.controller.render(latestRequest))
            await rejected(queued, /superseded/)
          }
          releaseGate.resolve()
          await expect
            .poll(() => removalFinished, { timeout: 3000, intervals: [1, 5, 10, 25] })
            .toBe(true)
          // Before removal returns, the original source really closed. Give the
          // completion/pump continuations a real I/O turn while mutation remains
          // held: neither an old queued callback nor new pending work may enter.
          expect(old.handles.size).toBe(0)
          await readFile(join(t.control, 'config.json'))
          expect(scheduler.mutating).toBe(true)
          expect(admissions).toEqual([false])
          expect(next.acquisitions).toBe(0)
          expect(
            (await t.events())
              .filter((event) => event.event === 'started')
              .map((event) => event.generation),
          ).toEqual([1])
          endMutation.resolve()
          await valueOf(mutation)
          const completed = await valueOf(latest)
          expect(completed.generation).toBe(latestRequest.generation)
          expect(admissions).toEqual([false, false])
          expect(next.acquisitions).toBe(1)
          expect(
            (await t.events())
              .filter((event) => event.event === 'started')
              .map((event) => event.generation),
          ).toEqual([1, latestRequest.generation])
          await t.controller.acknowledge(sessionId, completed.pairId, null)
        } finally {
          held?.release()
          allowRemoval.resolve()
          releaseGate.resolve()
          endMutation.resolve()
          // Abort scheduler waits even when a regressed removal is waiting on one;
          // resolving the final mutation gate alone would not break that cycle.
          const closing = observed(t.controller.close())
          if (mutation) await mutation
          await valueOf(closing)
          await t.close()
          scheduler.close()
        }
      },
    )
  }
})

test('global shutdown drains an earlier retirement after it has detached the final source owner', async () => {
  const releaseEntered = deferred(),
    releaseGate = deferred()
  const t = await controllerFixture({
    synthetic: {},
    release: async () => {
      releaseEntered.resolve()
      await releaseGate.promise
    },
  })
  try {
    const source = await t.source('detached-owner-shutdown'),
      request = t.request(source)
    const pair = await t.controller.render(request)
    await t.controller.acknowledge(request.sessionId, pair.pairId, null)
    const releasing = observed(t.controller.release(request.sessionId, null))
    await releaseEntered.promise
    let closed = false
    const closing = observed(
      t.controller.close().then(() => {
        closed = true
      }),
    )
    await [...source.handles][0].stat()
    expect(closed).toBe(false)
    expect(source.handles.size).toBe(1)
    releaseGate.resolve()
    await valueOf(releasing)
    await valueOf(closing)
    expect(source.handles.size).toBe(0)
    expect(source.releases).toBe(1)
  } finally {
    releaseGate.resolve()
    await t.close()
  }
})

test('real Rust pairs and source samples match the unchanged CPU oracle while one source and policy stay leased across edits', async () => {
  const t = await controllerFixture()
  try {
    const source = await t.source('real-native-sensor-linear'),
      binary = await readFile(t.executable)
    await test.info().attach('native-cpu-controller-provenance.json', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          executable: t.executable,
          executableSha256: sha(binary),
          sourceSha256: source.asset.sha256,
          width: source.asset.width,
          height: source.asset.height,
          syntheticLinearInput: true,
          trustedSourceDomainStub: true,
          realRustChild: true,
          browserIntegration: false,
          performanceMeasurement: false,
        },
        null,
        2,
      ),
    })
    let previous: CpuPreviewPair | undefined
    const cases = [
      { parameters: { ...neutralAdjustments }, hdrRanges: false, headroom: null },
      {
        parameters: {
          ...neutralAdjustments,
          exposureEv: 1.25,
          contrast: 13,
          highlights: -25,
          shadows: 17,
          whites: 9,
          blacks: -11,
        },
        hdrRanges: false,
        headroom: null,
      },
      { parameters: { ...neutralAdjustments, exposureEv: 1.25 }, hdrRanges: true, headroom: 1.5 },
    ]
    for (const input of cases) {
      const request = t.request(source, input),
        pair = await t.controller.render(request),
        expected = cpuOracle(source, request)
      expect(pair).toMatchObject({
        requestId: request.requestId,
        sessionId: request.sessionId,
        source: source.ref,
        generation: request.generation,
        settingsRevision: 1,
        quality: 'normal',
        parameters: input.parameters,
        hdrRanges: input.hdrRanges,
        headroom: input.headroom,
        policy: { revision: 1 },
        diagnostics: { sourceAttestedByMain: true, outputValidatedAfterChildClose: true },
      })
      for (const name of ['after', 'before'] as const) {
        const bytes = await readPlane(t.controller, pair[name].url)
        expect(bytes).toEqual(expected[name])
        expect(sha(bytes)).toBe(pair[name].sha256)
        expect(pair[name]).toMatchObject({
          width: source.asset.width,
          height: source.asset.height,
          byteLength: source.asset.width * source.asset.height * 4,
        })
      }
      const samples = await readPlane(t.controller, pair.samples.url),
        expectedSamples: number[] = []
      for (const count of [
        Math.min(65536, source.asset.width * source.asset.height),
        Math.min(8192, source.asset.width * source.asset.height),
      ])
        for (let index = 0; index < count; index++) {
          const pixel = Math.floor(
            ((index + 0.5) * source.asset.width * source.asset.height) / count,
          )
          expectedSamples.push(...source.pixels.subarray(pixel * 4, pixel * 4 + 4))
        }
      expect(samples).toEqual(Buffer.from(new Float32Array(expectedSamples).buffer))
      expect(sha(samples)).toBe(pair.samples.sha256)
      const manifestOwner = t.controller.acquire(new URL(pair.after.url))!
      try {
        expect(
          JSON.parse(await readFile(join(dirname(manifestOwner.path), 'manifest.json'), 'utf8')),
        ).toEqual(pair)
      } finally {
        manifestOwner.release()
      }
      await t.controller.acknowledge(request.sessionId, pair.pairId, previous?.pairId ?? null)
      previous = pair
      // A preference change cannot replace this CPU owner's captured policy.
      t.setPolicy(async () => resourcePolicy(99, 1, 1))
      expect(source.handles.size).toBe(1)
      expect(source.releases).toBe(0)
    }
    expect(source.acquisitions).toBe(1)
    expect(t.policyCalls()).toBe(1)
    await t.controller.release(previous!.sessionId, null)
    expect(source.handles.size).toBe(0)
    expect(source.releases).toBe(1)
    expect(await scratchNames(t.directory)).toEqual([])
  } finally {
    await t.close()
  }
})

test('independent RAM and GPU rejection happens before executable launch or scratch output creation', async () => {
  for (const [name, ram, gpu] of [
    ['RAM', 1, 2048],
    ['GPU', 2048, 1],
  ] as const) {
    await test.step(name, async () => {
      const t = await controllerFixture({
        synthetic: {},
        policy: async () => resourcePolicy(7, ram, gpu),
      })
      try {
        const source = await t.source(`rejected-${name}`)
        await expect(t.controller.render(t.request(source))).rejects.toThrow(
          'managed image resource budget',
        )
        expect(t.executableCalls()).toBe(0)
        expect(await t.events()).toEqual([])
        expect(await scratchNames(t.directory)).toEqual([])
        // The admitted owner may retain its small opened source until closure;
        // rejection still must not leak that descriptor or pin on shutdown.
        await t.controller.close()
        expect(source.handles.size).toBe(0)
        expect(source.releases).toBe(1)
      } finally {
        await t.close()
      }
    })
  }
})

test('real native pair ACK revokes old capabilities immediately but waits its last stream pin before deleting files', async () => {
  const t = await controllerFixture()
  let held: ReturnType<typeof t.controller.acquire>
  try {
    const source = await t.source('real-native-pair-ownership'),
      firstRequest = t.request(source)
    const first = await t.controller.render(firstRequest)
    await expect(t.controller.render(t.request(source))).rejects.toThrow('acknowledged or released')
    await t.controller.acknowledge(firstRequest.sessionId, first.pairId, null)
    held = t.controller.acquire(new URL(first.after.url))
    expect(held).toBeTruthy()
    const oldBytes = await readFile(held!.path)
    const secondRequest = t.request(source, {
      parameters: { ...neutralAdjustments, exposureEv: 1 },
    })
    const second = await t.controller.render(secondRequest)
    await expect(
      t.controller.acknowledge(secondRequest.sessionId, second.pairId, randomUUID()),
    ).rejects.toThrow('replacement identity')
    let acknowledged = false
    const ack = t.controller
      .acknowledge(secondRequest.sessionId, second.pairId, first.pairId)
      .then(() => {
        acknowledged = true
      })
    expect(t.controller.acquire(new URL(first.after.url))).toBeUndefined()
    expect(await readFile(held!.path)).toEqual(oldBytes)
    expect(acknowledged).toBe(false)
    const oldPath = held!.path
    held!.release()
    held = undefined
    await ack
    await expect(access(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readPlane(t.controller, second.after.url)).toEqual(
      cpuOracle(source, secondRequest).after,
    )
    expect(await scratchNames(t.directory)).toHaveLength(1)
    expect(source.acquisitions).toBe(1)
    expect(source.handles.size).toBe(1)
    await expect(
      t.controller.acknowledge(secondRequest.sessionId, second.pairId, first.pairId),
    ).rejects.toThrow('Unknown CPU output acknowledgement')
  } finally {
    held?.release()
    await t.close()
  }
})

test('latest pending request supersedes without another child and shutdown drains a real delayed-close child before releasing the source', async () => {
  const t = await controllerFixture({ synthetic: { holdGenerations: [1, 4] } })
  try {
    const source = await t.source('synthetic-process-order'),
      oneRequest = t.request(source, { generation: 1 })
    const one = observed(t.controller.render(oneRequest)),
      started = await t.event('held-before-output', 1)
    const twoRequest = t.request(source, { generation: 2 }),
      two = observed(t.controller.render(twoRequest))
    const threeRequest = t.request(source, { generation: 3 }),
      three = observed(t.controller.render(threeRequest))
    await rejected(two, /superseded before admission/)
    const superseded = await two
    expect(superseded.ok ? undefined : superseded.error).toBeInstanceOf(NativeCpuCancelled)
    await t.event('sigterm', 1)
    let cancelled = false
    const cancel = t.controller.cancel(oneRequest.sessionId, oneRequest.requestId).then(() => {
      cancelled = true
    })
    expect(processExists(started.pid)).toBe(true)
    expect(cancelled).toBe(false)
    expect(source.handles.size).toBe(1)
    await [...source.handles][0].stat()
    expect(
      (await t.events())
        .filter((entry) => entry.event === 'started')
        .map((entry) => entry.generation),
    ).toEqual([1])
    await t.allow('exit', 1)
    await cancel
    await rejected(one, /superseded|cancelled|stopped|closed/i)
    const stopped = await one
    expect(stopped.ok ? undefined : stopped.error).toBeInstanceOf(NativeCpuCancelled)
    const latest = await valueOf(three)
    expect(processExists(started.pid)).toBe(false)
    expect(
      (await t.events())
        .filter((entry) => entry.event === 'started')
        .map((entry) => entry.generation),
    ).toEqual([1, 3])
    await t.controller.acknowledge(threeRequest.sessionId, latest.pairId, null)
    const fourRequest = t.request(source, { generation: 4 }),
      four = observed(t.controller.render(fourRequest))
    const closingChild = await t.event('held-before-output', 4)
    const five = observed(t.controller.render(t.request(source, { generation: 5 })))
    let closed = false
    const closing = t.controller.close().then(() => {
      closed = true
    })
    await t.event('sigterm', 4)
    expect(closed).toBe(false)
    expect(processExists(closingChild.pid)).toBe(true)
    expect(source.handles.size).toBe(1)
    await t.allow('exit', 4)
    await closing
    await rejected(four, /superseded|closed|stopped/i)
    await rejected(five, /closed/)
    expect(processExists(closingChild.pid)).toBe(false)
    expect(
      (await t.events())
        .filter((entry) => entry.event === 'started')
        .map((entry) => entry.generation),
    ).toEqual([1, 3, 4])
    expect(source.acquisitions).toBe(1)
    expect(source.releases).toBe(1)
    expect(source.handles.size).toBe(0)
    expect(await scratchNames(t.directory)).toEqual([])
    await expect(t.controller.render(t.request(source, { generation: 6 }))).rejects.toThrow(
      'closed',
    )
    expect((await t.events()).some((entry) => entry.generation === 6)).toBe(false)
  } finally {
    await t.close()
  }
})

test('a synthetic child with complete valid output and nonzero real close cannot publish a descriptor', async () => {
  const t = await controllerFixture({ synthetic: { nonzeroGenerations: [1] } })
  try {
    const source = await t.source('nonzero-after-trailer'),
      request = t.request(source, { generation: 1 })
    const rendering = observed(t.controller.render(request))
    await rejected(rendering, /42|stopped/)
    const failed = await rendering
    expect(failed.ok ? undefined : failed.error).not.toBeInstanceOf(NativeCpuCancelled)
    const output = await t.event('output-ended', 1),
      exit = await t.event('exiting', 1)
    expect(exit.code).toBe(42)
    expect(processExists(output.pid)).toBe(false)
    expect(await scratchNames(t.directory)).toEqual([])
    expect(
      t.controller.acquire(
        new URL(`luma-photo://library/${source.ref.photoId}/cpu/${randomUUID()}/after`),
      ),
    ).toBeUndefined()
    await t.controller.close()
    expect(source.releases).toBe(1)
    expect(source.handles.size).toBe(0)
  } finally {
    await t.close()
  }
})

test('source removal waits actual child close and a stale session cannot release a subsequent source pair', async () => {
  const t = await controllerFixture({ synthetic: { holdGenerations: [1] } })
  try {
    const source = await t.source('removed-source'),
      request = t.request(source, { generation: 1 })
    const rendering = observed(t.controller.render(request)),
      child = await t.event('held-before-output', 1)
    source.valid = false
    let removed = false
    const removing = t.controller.beforeRemoval(source.ref.photoId).then(() => {
      removed = true
    })
    await t.event('sigterm', 1)
    expect(removed).toBe(false)
    expect(source.handles.size).toBe(1)
    expect(processExists(child.pid)).toBe(true)
    await t.allow('exit', 1)
    await removing
    await rejected(rendering, /removed|stopped|closed/i)
    expect(processExists(child.pid)).toBe(false)
    expect(source.releases).toBe(1)
    expect(source.handles.size).toBe(0)
    const nextSource = await t.source('next-source'),
      nextRequest = t.request(nextSource, { generation: 2, sessionId: randomUUID() })
    const next = await t.controller.render(nextRequest)
    await t.controller.acknowledge(nextRequest.sessionId, next.pairId, null)
    await t.controller.cancel(request.sessionId, nextRequest.requestId)
    await t.controller.release(request.sessionId, next.pairId)
    await t.controller.release(request.sessionId, null)
    expect(await readPlane(t.controller, next.after.url)).toHaveLength(next.after.byteLength)
    expect(nextSource.handles.size).toBe(1)
    await t.controller.close()
    expect(nextSource.releases).toBe(1)
    expect(await scratchNames(t.directory)).toEqual([])
  } finally {
    await t.close()
  }
})

test('aborting new-session policy capture never resurrects a released source lease, and stale cancellation cannot stop the reopened owner', async () => {
  const t = await controllerFixture({ synthetic: { holdGenerations: [3] } })
  const policyEntered = deferred(),
    policyGate = deferred()
  try {
    const oldSource = await t.source('revisited-source'),
      oldRequest = t.request(oldSource, { generation: 1 })
    const oldPair = await t.controller.render(oldRequest)
    await t.controller.acknowledge(oldRequest.sessionId, oldPair.pairId, null)
    const otherSource = await t.source('aborted-new-source'),
      otherSession = randomUUID()
    t.setPolicy(async () => {
      policyEntered.resolve()
      await policyGate.promise
      return resourcePolicy(41)
    })
    const otherRequest = t.request(otherSource, { generation: 2, sessionId: otherSession })
    const other = observed(t.controller.render(otherRequest))
    await policyEntered.promise
    expect(oldSource.releases).toBe(1)
    expect(oldSource.handles.size).toBe(0)
    const cancelling = t.controller.cancel(otherSession, otherRequest.requestId)
    policyGate.resolve()
    await cancelling
    await rejected(other, /cancelled|abort/i)
    expect(otherSource.acquisitions).toBe(0)
    t.setPolicy(async () => resourcePolicy(42))
    const revisit = t.request(oldSource, { generation: 3, sessionId: oldRequest.sessionId })
    const revisiting = observed(t.controller.render(revisit))
    const heldChild = await t.event('held-before-output', 3)
    expect(oldSource.acquisitions).toBe(2)
    expect(oldSource.handles.size).toBe(1)
    await [...oldSource.handles][0].stat()
    await t.controller.cancel(otherSession, revisit.requestId)
    const staleRelease = observed(t.controller.release(otherSession, null))
    let staleReleased = false
    void staleRelease.then(() => {
      staleReleased = true
    })
    await readFile(join(t.control, 'config.json'))
    expect(staleReleased).toBe(true)
    await valueOf(staleRelease)
    expect(processExists(heldChild.pid)).toBe(true)
    expect(
      (await t.events()).some((entry) => entry.generation === 3 && entry.event === 'sigterm'),
    ).toBe(false)
    await t.allow('output', 3)
    const reopened = await valueOf(revisiting)
    expect(reopened.policy.revision).toBe(42)
    await t.controller.acknowledge(revisit.sessionId, reopened.pairId, null)
    await t.controller.close()
    expect(oldSource.releases).toBe(2)
    expect(oldSource.handles.size).toBe(0)
  } finally {
    policyGate.resolve()
    await t.close()
  }
})

test('a source invalidated after manifest rename is rechecked and never enters the capability owner map', async () => {
  let invalidated = false
  const t = await controllerFixture({
    synthetic: {},
    check: async (record, signal, directory) => {
      signal.throwIfAborted()
      for (const entry of await readdir(directory)) {
        if (!entry.startsWith('cpu-')) continue
        try {
          await access(join(directory, entry, 'manifest.json'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        invalidated = true
        record.valid = false
        throw new Error('Source invalidated after completed manifest rename.')
      }
    },
  })
  try {
    const source = await t.source('post-rename-source-change'),
      request = t.request(source, { generation: 1 })
    const rendering = observed(t.controller.render(request))
    await rejected(rendering, /after completed manifest rename/)
    const failed = await rendering
    expect(failed.ok ? undefined : failed.error).not.toBeInstanceOf(NativeCpuCancelled)
    expect(invalidated).toBe(true)
    await t.event('output-ended', 1)
    expect(await scratchNames(t.directory)).toEqual([])
    expect(
      t.controller.acquire(
        new URL(`luma-photo://library/${source.ref.photoId}/cpu/${randomUUID()}/after`),
      ),
    ).toBeUndefined()
    await t.controller.close()
    expect(source.handles.size).toBe(0)
    expect(source.releases).toBe(1)
  } finally {
    await t.close()
  }
})

test('release, removal and reset serialize new admission behind old pair pins and descriptor release, retaining only the latest request even on cleanup rejection', async () => {
  for (const mode of ['release', 'removal', 'reset', 'release-error'] as const) {
    await test.step(mode, async () => {
      const releaseEntered = deferred(),
        releaseGate = deferred()
      let oldCacheId = ''
      const t = await controllerFixture({
        synthetic: {},
        release: async (record) => {
          if (record.ref.cacheId !== oldCacheId) return
          releaseEntered.resolve()
          await releaseGate.promise
          if (mode === 'release-error')
            throw new Error('Synthetic source-release failure after drain.')
        },
      })
      let held: ReturnType<typeof t.controller.acquire>
      try {
        const old = await t.source(`barrier-old-${mode}`),
          initial = t.request(old, { generation: 1 })
        oldCacheId = old.ref.cacheId
        const pair = await t.controller.render(initial)
        await t.controller.acknowledge(initial.sessionId, pair.pairId, null)
        held = t.controller.acquire(new URL(pair.after.url))
        expect(held).toBeTruthy()
        const retiring = observed(
          mode === 'removal'
            ? t.controller.beforeRemoval(old.ref.photoId)
            : mode === 'reset'
              ? t.controller.reset()
              : t.controller.release(initial.sessionId, null),
        )
        const next = await t.source(`barrier-next-${mode}`),
          nextSession = randomUUID()
        const superseded = observed(
          t.controller.render(t.request(next, { generation: 2, sessionId: nextSession })),
        )
        const latestRequest = t.request(next, { generation: 3, sessionId: nextSession })
        const latest = observed(t.controller.render(latestRequest))
        let supersededSettled = false
        void superseded.then(() => {
          supersededSettled = true
        })
        await readFile(held!.path)
        expect(supersededSettled).toBe(true)
        await rejected(superseded, /superseded before admission/)
        expect(t.policyCalls()).toBe(1)
        expect(next.acquisitions).toBe(0)
        expect(t.controller.acquire(new URL(pair.after.url))).toBeUndefined()
        held!.release()
        held = undefined
        await releaseEntered.promise
        // Real descriptor I/O yields the event loop while the explicit release
        // gate still owns the old bytes; no timing threshold proves exclusion.
        expect(old.handles.size).toBe(1)
        await [...old.handles][0].stat()
        expect(t.policyCalls()).toBe(1)
        expect(next.acquisitions).toBe(0)
        expect(
          (await t.events())
            .filter((entry) => entry.event === 'started')
            .map((entry) => entry.generation),
        ).toEqual([1])
        releaseGate.resolve()
        if (mode === 'release-error') await rejected(retiring, /source-release failure/)
        else await valueOf(retiring)
        const completed = await valueOf(latest)
        expect(old.handles.size).toBe(0)
        expect(old.releases).toBe(1)
        expect(completed.generation).toBe(3)
        expect(
          (await t.events())
            .filter((entry) => entry.event === 'started')
            .map((entry) => entry.generation),
        ).toEqual([1, 3])
        expect(next.acquisitions).toBe(1)
        await t.controller.acknowledge(latestRequest.sessionId, completed.pairId, null)
      } finally {
        held?.release()
        releaseGate.resolve()
        await t.close()
      }
    })
  }
})
