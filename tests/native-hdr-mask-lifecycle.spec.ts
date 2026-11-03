import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { neutralAdjustments } from '../src/shared/adjustments'
import type {
  NativeHdrMaskDeclined,
  NativeHdrMaskRequest,
  NativeHdrMaskResult,
} from '../src/shared/native-hdr-mask'
import {
  controllerFixture,
  deferred,
  observed,
  processExists,
  rejected,
  resourcePolicy,
  scratchNames,
  valueOf,
} from './native-mask-controller.helpers'

test.setTimeout(30000)
const syntheticMath = 'f'.repeat(64)
const edited = {
  ...neutralAdjustments,
  exposureEv: 0.53,
  contrast: 45,
  highlights: -55,
  shadows: 40,
  whites: 20,
  blacks: -25,
  saturation: 40,
  vibrance: 65,
}
function mask(result: NativeHdrMaskResult | NativeHdrMaskDeclined): NativeHdrMaskResult {
  expect(result.kind).toBe('mask')
  if (result.kind !== 'mask') throw new Error(`Native mask unexpectedly declined: ${result.reason}`)
  return result
}

test('completed native EOF keeps its source FD and result unaccepted until the actual child closes', async () => {
  const t = await controllerFixture({
    synthetic: { maskHoldExit: [1] },
    mask: { arithmeticSha256: syntheticMath },
  })
  try {
    const source = await t.source('mask-held-actual-close'),
      request = t.maskRequest(source),
      completion = observed(t.controller.renderMask(request))
    let resolved = false
    void completion.then(() => {
      resolved = true
    })
    const held = await t.event('mask-held-after-output', 1)
    expect(processExists(held.pid)).toBe(true)
    expect(resolved).toBe(false)
    expect(source.releases).toBe(0)
    expect(source.handles.size).toBe(1)
    await [...source.handles][0].stat()
    await t.allow('exit', 1)
    const output = mask(await valueOf(completion))
    expect(processExists(held.pid)).toBe(false)
    expect(source.releases).toBe(1)
    expect(source.handles.size).toBe(0)
    await t.controller.releaseMask(request.sessionId, output.maskId)
  } finally {
    await t.close()
  }
})

for (const fault of ['echo', 'order', 'bits', 'excess', 'nonzero'])
  test(`real mask child ${fault} failure drains source and removes unpublished scratch`, async () => {
    const t = await controllerFixture({
      synthetic: { maskFaults: { 1: fault } },
      mask: { arithmeticSha256: syntheticMath },
    })
    try {
      const source = await t.source(`mask-bad-${fault}`),
        request = t.maskRequest(source)
      await expect(t.controller.renderMask(request)).rejects.toThrow()
      const started = await t.event('mask-started', 1)
      expect(processExists(started.pid)).toBe(false)
      expect(source.handles.size).toBe(0)
      expect(source.acquisitions).toBe(1)
      expect(source.releases).toBe(1)
      expect(await scratchNames(t.directory)).toEqual([])
    } finally {
      await t.close()
    }
  })

test('cancel acknowledgement waits a genuine in-flight source read after the actual child has already closed', async () => {
  const entered = deferred(),
    gate = deferred()
  let installed = false,
    restore: (() => void) | undefined
  const t = await controllerFixture({
    synthetic: { maskHoldExit: [1] },
    mask: { arithmeticSha256: syntheticMath },
    check: async (record) => {
      if (installed) return
      installed = true
      const file = [...record.handles][0],
        own = Object.getOwnPropertyDescriptor(file, 'read'),
        original = file.read
      Object.defineProperty(file, 'read', {
        configurable: true,
        value: async (...args: unknown[]) => {
          const result = await Reflect.apply(original, file, args)
          entered.resolve()
          await gate.promise
          return result
        },
      })
      restore = () => {
        if (own) Object.defineProperty(file, 'read', own)
        else Reflect.deleteProperty(file, 'read')
      }
    },
  })
  try {
    const source = await t.source('mask-source-read-drain'),
      request = t.maskRequest(source),
      rendering = observed(t.controller.renderMask(request))
    await entered.promise
    await t.event('mask-started', 1)
    let cancelled = false
    const cancellation = observed(
      t.controller.cancelMask(request.sessionId, request.requestId).then(() => {
        cancelled = true
      }),
    )
    const started = await t.event('mask-sigterm', 1)
    await t.allow('exit', 1)
    await expect.poll(() => processExists(started.pid)).toBe(false)
    expect(cancelled).toBe(false)
    expect(source.releases).toBe(0)
    expect(source.handles.size).toBe(1)
    await [...source.handles][0].stat()
    gate.resolve()
    await valueOf(cancellation)
    await rejected(rendering, /cancelled/)
    expect(source.handles.size).toBe(0)
    expect(source.releases).toBe(1)
    expect(await scratchNames(t.directory)).toEqual([])
  } finally {
    gate.resolve()
    restore?.()
    await t.close()
  }
})

test('a superseded mask drains its actual child before admitting only the final latest mask', async () => {
  const t = await controllerFixture({
    synthetic: { maskHoldOutput: [1] },
    mask: { arithmeticSha256: syntheticMath },
  })
  try {
    const source = await t.source('mask-current-latest'),
      firstRequest = t.maskRequest(source),
      first = observed(t.controller.renderMask(firstRequest))
    const started = await t.event('mask-held-before-output', 1)
    const second = observed(t.controller.renderMask(t.maskRequest(source))),
      latestRequest = t.maskRequest(source),
      latest = observed(t.controller.renderMask(latestRequest))
    await rejected(second, /superseded before admission/)
    await t.event('mask-sigterm', 1)
    expect(source.acquisitions).toBe(1)
    expect(source.releases).toBe(0)
    expect(processExists(started.pid)).toBe(true)
    await t.allow('exit', 1)
    await rejected(first, /superseded/)
    const output = mask(await valueOf(latest))
    expect(output.generation).toBe(latestRequest.generation)
    expect(processExists(started.pid)).toBe(false)
    expect(source.acquisitions).toBe(2)
    expect(source.releases).toBe(2)
    expect(
      (await t.events())
        .filter((event) => event.event === 'mask-started')
        .map((event) => event.generation),
    ).toEqual([1, 2])
    await t.controller.releaseMask(output.sessionId, output.maskId)
  } finally {
    await t.close()
  }
})

for (const fault of ['revision', 'target'] as const)
  test(`the completed native mask is rejected if its ${fault} changes before actual child close`, async () => {
    let targetChanged = false
    const t = await controllerFixture({
      synthetic: { maskHoldExit: [1] },
      mask: {
        arithmeticSha256: syntheticMath,
        checkTarget: () => {
          if (targetChanged) throw new Error('Actual display target changed.')
        },
      },
    })
    try {
      const source = await t.source(`mask-late-${fault}`),
        request = t.maskRequest(source),
        rendering = observed(t.controller.renderMask(request))
      const held = await t.event('mask-held-after-output', 1)
      if (fault === 'revision') source.revision++
      else targetChanged = true
      await t.allow('exit', 1)
      await rejected(rendering, /revision|target/)
      expect(processExists(held.pid)).toBe(false)
      expect(source.handles.size).toBe(0)
      expect(source.releases).toBe(1)
      expect(await scratchNames(t.directory)).toEqual([])
    } finally {
      await t.close()
    }
  })

test('completed receiver revokes its capability and deletion waits for actual stream pins', async () => {
  const t = await controllerFixture({ synthetic: {}, mask: { arithmeticSha256: syntheticMath } })
  let held: ReturnType<typeof t.controller.acquireMask>
  try {
    const source = await t.source('mask-receiver-drain'),
      request = t.maskRequest(source),
      output = mask(await t.controller.renderMask(request))
    held = t.controller.acquireMask(new URL(output.url))!
    expect(held).toBeTruthy()
    expect(await t.controller.renderMask(t.maskRequest(source))).toMatchObject({
      kind: 'mask-declined',
      reason: 'previous-receiver',
    })
    const retiring = observed(t.controller.beforeRemoval(source.ref.photoId))
    const revoked = t.controller.acquireMask(new URL(output.url))
    revoked?.release()
    expect(revoked).toBeUndefined()
    expect(await readFile(held.path)).toHaveLength(output.byteLength)
    let drained = false
    void retiring.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    held.release()
    held = undefined
    await valueOf(retiring)
    expect(await scratchNames(t.directory)).toEqual([])
    expect(source.handles.size).toBe(0)
  } finally {
    held?.release()
    await t.close()
  }
})

test('source revision, confirmed comparison, target and frozen budget failures cannot publish masks', async () => {
  const cases = ['revision', 'parameters', 'target', 'memory'] as const
  for (const fault of cases) {
    let rejectTarget = false
    const t = await controllerFixture({
      synthetic: {},
      mask: {
        arithmeticSha256: syntheticMath,
        parameters: () => (fault === 'parameters' ? edited : neutralAdjustments),
        policy: () =>
          fault === 'memory'
            ? { ...resourcePolicy(), ram: { ...resourcePolicy().ram, effectiveBytes: 1 } }
            : resourcePolicy(),
        checkTarget: () => {
          if (rejectTarget) throw new Error('Actual display target changed.')
        },
      },
    })
    try {
      const source = await t.source(`mask-reject-${fault}`),
        request = t.maskRequest(source)
      if (fault === 'revision') source.revision++
      if (fault === 'target') rejectTarget = true
      if (fault === 'memory')
        expect(await t.controller.renderMask(request)).toMatchObject({
          kind: 'mask-declined',
          reason: 'memory-limit',
        })
      else
        await expect(t.controller.renderMask(request)).rejects.toThrow(
          /revision|Before\/After|target/i,
        )
      expect(source.handles.size).toBe(0)
      expect((await t.events()).filter((event) => event.event === 'mask-started')).toEqual([])
    } finally {
      await t.close()
    }
  }
})

test('invalid IPC mask contracts fail synchronously before source, executable or policy acquisition', async () => {
  const t = await controllerFixture({ synthetic: {}, mask: { arithmeticSha256: syntheticMath } })
  try {
    const source = await t.source('invalid-mask-contract'),
      original = t.maskRequest(source),
      mutations: Array<(value: NativeHdrMaskRequest) => unknown> = [
        (value) => ({ ...value, path: '/tmp/not-a-capability' }),
        (value) => ({ ...value, generation: -1 }),
        (value) => ({ ...value, comparison: 'unknown' }),
        (value) => ({ ...value, source: { ...value.source, workingSha256: 'bad' } }),
        (value) => ({ ...value, source: { ...value.source, path: '/tmp/private' } }),
        (value) => ({ ...value, parameters: { ...value.parameters, exposureEv: 0.003 } }),
        (value) => ({ ...value, target: { ...value.target, peak: Infinity } }),
        (value) => ({ ...value, target: { ...value.target, headroom: 101 } }),
        (value) => ({ ...value, existingOwners: { ramBytes: -1, vramBytes: 0 } }),
        (value) => ({ ...value, existingOwners: { ramBytes: 0, vramBytes: 0, other: 0 } }),
      ]
    for (const mutate of mutations)
      expect(() => t.controller.renderMask(mutate(original) as NativeHdrMaskRequest)).toThrow()
    expect(source.acquisitions).toBe(0)
    expect(t.executableCalls()).toBe(0)
    expect(t.policyCalls()).toBe(0)
  } finally {
    await t.close()
  }
})

test('primary native work failure and source-release failure both survive actual source drain before latest admission', async () => {
  const releaseEntered = deferred(),
    releaseGate = deferred(),
    workFailure = new Error('primary post-close target failure'),
    releaseFailure = new Error('source lease release failure after its real FD closes')
  let firstPhoto = '',
    targetChanged = false
  const t = await controllerFixture({
    synthetic: { maskHoldExit: [1] },
    mask: {
      arithmeticSha256: syntheticMath,
      checkTarget: (request) => {
        if (targetChanged && request.source.photoId === firstPhoto) throw workFailure
      },
    },
    release: async (record) => {
      if (record.ref.photoId !== firstPhoto) return
      releaseEntered.resolve()
      await releaseGate.promise
      throw releaseFailure
    },
  })
  try {
    const source = await t.source('mask-work-and-release-failures')
    firstPhoto = source.ref.photoId
    const request = t.maskRequest(source),
      rendering = observed(t.controller.renderMask(request)),
      child = await t.event('mask-held-after-output', 1)
    targetChanged = true
    await t.allow('exit', 1)
    await releaseEntered.promise
    expect(processExists(child.pid)).toBe(false)
    expect(source.handles.size).toBe(1)
    expect(source.releases).toBe(0)
    await [...source.handles][0].stat()
    const nextSource = await t.source('mask-after-failed-cleanup'),
      nextRequest = t.maskRequest(nextSource),
      latest = observed(t.controller.renderMask(nextRequest))
    expect(nextSource.acquisitions).toBe(0)
    expect((await t.events()).filter((event) => event.event === 'mask-started')).toHaveLength(1)
    let firstSettled = false
    void rendering.then(() => {
      firstSettled = true
    })
    await readFile(source.path)
    expect(firstSettled).toBe(false)
    releaseGate.resolve()
    const failed = await rendering
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('A failed native job returned a descriptor.')
    expect(failed.error).toBeInstanceOf(AggregateError)
    expect((failed.error as AggregateError).errors).toEqual([workFailure, releaseFailure])
    expect(source.handles.size).toBe(0)
    expect(source.releases).toBe(1)
    const output = mask(await valueOf(latest))
    expect(output.source).toEqual(nextSource.ref)
    expect(nextSource.acquisitions).toBe(1)
    expect(nextSource.releases).toBe(1)
    await t.controller.releaseMask(output.sessionId, output.maskId)
    expect(await scratchNames(t.directory)).toEqual([])
  } finally {
    releaseGate.resolve()
    await t.close()
  }
})

test('successful native output followed by source-release failure revokes its unpublished result capability', async () => {
  const entered = deferred(),
    gate = deferred(),
    releaseFailure = new Error('source release failed after native success')
  let failPhoto = ''
  const t = await controllerFixture({
    synthetic: {},
    mask: { arithmeticSha256: syntheticMath },
    release: async (record) => {
      if (record.ref.photoId !== failPhoto) return
      entered.resolve()
      await gate.promise
      throw releaseFailure
    },
  })
  try {
    const source = await t.source('mask-success-release-failure')
    failPhoto = source.ref.photoId
    const rendering = observed(t.controller.renderMask(t.maskRequest(source)))
    await entered.promise
    const child = await t.event('mask-output-ended', 1)
    await expect.poll(() => processExists(child.pid)).toBe(false)
    const names = await scratchNames(t.directory)
    expect(names).toHaveLength(1)
    const staged = JSON.parse(
        await readFile(join(t.directory, names[0], 'manifest.json'), 'utf8'),
      ) as NativeHdrMaskResult,
      probe = t.controller.acquireMask(new URL(staged.url))
    expect(probe).toBeTruthy()
    probe!.release()
    expect(source.handles.size).toBe(1)
    gate.resolve()
    const failed = await rendering
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('Source release failure returned a successful mask descriptor.')
    expect(failed.error).toBe(releaseFailure)
    expect(source.handles.size).toBe(0)
    expect(source.releases).toBe(1)
    expect(t.controller.acquireMask(new URL(staged.url))).toBeUndefined()
    expect(await scratchNames(t.directory)).toEqual([])
    const nextSource = await t.source('mask-after-release-failure'),
      output = mask(await t.controller.renderMask(t.maskRequest(nextSource)))
    await t.controller.releaseMask(output.sessionId, output.maskId)
  } finally {
    gate.resolve()
    await t.close()
  }
})
