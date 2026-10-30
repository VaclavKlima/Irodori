import { expect, test } from '@playwright/test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { nativeCpuExecutable } from '../src/main/native-cpu-executable'
import { NativeCpuController } from '../src/main/native-cpu-controller'
import { nativeCpuExistingOwners } from '../src/shared/native-cpu-memory'
import {
  NATIVE_CPU_PREVIEW_VERSION,
  type CpuPreviewPair,
  type CpuPreviewRequest,
} from '../src/shared/native-cpu-preview'
import { neutralAdjustments } from '../src/shared/adjustments'
import { detailCacheFixture } from './detail-preview-cache.helpers'
import {
  controllerFixture,
  cpuOracle,
  observed,
  rejected,
  readPlane,
} from './native-cpu-controller.helpers'

test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'The checked native helper is Linux x64.',
)
const executable = () => nativeCpuExecutable(resolve('vendor'))
async function sources(t: Awaited<ReturnType<typeof controllerFixture>>) {
  const after = await t.source('filtered-test-domain'),
    data = new Float32Array(after.pixels)
  for (let i = 0; i < data.length; i += 4) {
    data[i] += 0.03
    data[i + 1] *= 0.7
    data[i + 2] += 0.02
  }
  const before = await t.source(
    'unfiltered-test-domain',
    after.asset.width,
    after.asset.height,
    data,
  )
  Object.assign(before.ref, { photoId: after.ref.photoId })
  return { after, before }
}
function compare(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) expect(actual[i]).toBe(expected[i])
    else expect(Math.abs(actual[i] - expected[i]), `channel ${i}`).toBeLessThanOrEqual(1)
  }
}

test('real native source pairs keep original Before pixels/samples and reuse its derived output across point edits', async () => {
  const t = await controllerFixture({ nativeExecutable: await executable() })
  try {
    const { after, before } = await sources(t)
    let previous: CpuPreviewPair | undefined,
      repeatedBeforeReads = 0
    for (const exposureEv of [0.5, -0.75, 1.25]) {
      const request = t.request(after, {
          beforeSource:
            exposureEv === 1.25
              ? {
                  workingSha256: before.ref.workingSha256,
                  renderingIdentity: before.ref.renderingIdentity,
                  cacheId: before.ref.cacheId,
                  photoId: before.ref.photoId,
                }
              : before.ref,
          parameters: { ...neutralAdjustments, exposureEv },
        }),
        pair = await t.controller.render(request)
      expect(pair.beforeSource).toEqual(before.ref)
      compare(await readPlane(t.controller, pair.after.url), cpuOracle(after, request).after)
      compare(
        await readPlane(t.controller, pair.before.url),
        cpuOracle(before, { ...request, source: before.ref, parameters: neutralAdjustments })
          .before,
      )
      expect(await readPlane(t.controller, pair.beforeSamples!.url)).toEqual(
        Buffer.from(new Float32Array([...before.pixels, ...before.pixels]).buffer),
      )
      expect(await readPlane(t.controller, pair.samples.url)).toEqual(
        Buffer.from(new Float32Array([...after.pixels, ...after.pixels]).buffer),
      )
      expect(pair.diagnostics.beforeCacheHit).toBe(!!previous)
      if (!previous)
        for (const file of before.handles) {
          const read = file.read.bind(file)
          file.read = ((
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null,
          ) => {
            repeatedBeforeReads++
            return read(buffer, offset, length, position)
          }) as typeof file.read
        }
      await t.controller.acknowledge(request.sessionId, pair.pairId, previous?.pairId ?? null)
      previous = pair
    }
    expect(after.acquisitions).toBe(1)
    expect(before.acquisitions).toBe(1)
    expect(t.policyCalls()).toBe(1)
    expect(repeatedBeforeReads).toBe(0)
    await t.controller.reset()
    expect([after.releases, before.releases]).toEqual([1, 1])
    expect(await readdir(t.directory)).toEqual([])
    expect(await readFile(after.path)).toEqual(after.bytes)
    expect(await readFile(before.path)).toEqual(before.bytes)
  } finally {
    await t.close()
  }
})

test('a damaged derived Before is regenerated from its attested original without changing either working source', async () => {
  const t = await controllerFixture({ nativeExecutable: await executable() })
  try {
    const { after, before } = await sources(t),
      request = t.request(after, { beforeSource: before.ref }),
      first = await t.controller.render(request)
    await t.controller.acknowledge(request.sessionId, first.pairId, null)
    const stream = t.controller.acquire(new URL(first.before.url))!
    try {
      const damaged = await readFile(stream.path)
      damaged[0] ^= 1
      await writeFile(stream.path, damaged)
      const next = t.request(after, {
          beforeSource: before.ref,
          parameters: { ...neutralAdjustments, exposureEv: 0.5 },
        }),
        second = await t.controller.render(next)
      expect(second.diagnostics.beforeCacheHit).toBe(false)
      compare(await readPlane(t.controller, second.before.url), cpuOracle(before, request).before)
      expect(await readFile(after.path)).toEqual(after.bytes)
      expect(await readFile(before.path)).toEqual(before.bytes)
      const acknowledgement = t.controller.acknowledge(next.sessionId, second.pairId, first.pairId)
      expect(t.controller.acquire(new URL(first.before.url))).toBeUndefined()
      stream.release()
      await acknowledgement
    } finally {
      stream.release()
    }
  } finally {
    await t.close()
  }
})

test('a still-running original-Before child keeps both source FDs leased through cancellation and real delayed close', async () => {
  const t = await controllerFixture({ synthetic: { holdBeforeGenerations: [1] } })
  try {
    const { after, before } = await sources(t),
      request = t.request(after, { beforeSource: before.ref }),
      result = observed(t.controller.render(request))
    const child = await t.event('held-before-output', 1)
    expect(child.phase).toBe('before')
    let closed = false
    const close = t.controller.reset().then(() => {
      closed = true
    })
    await t.event('sigterm', 1)
    expect(closed).toBe(false)
    expect([after.releases, before.releases]).toEqual([0, 0])
    await t.allow('exit', 1)
    await close
    await rejected(result, /closed|superseded|cancel/)
    expect([after.releases, before.releases]).toEqual([1, 1])
    expect(await readdir(t.directory)).toEqual([])
  } finally {
    await t.close()
  }
})

test('cross-photo comparisons and changed source pairs cannot reuse an existing native owner', async () => {
  const t = await controllerFixture({ synthetic: {} })
  try {
    const { after, before } = await sources(t)
    expect(() =>
      t.controller.render(
        t.request(after, { beforeSource: { ...before.ref, photoId: 'f'.repeat(64) } }),
      ),
    ).toThrow('another photograph')
    const request = t.request(after, { beforeSource: before.ref }),
      first = await t.controller.render(request)
    await t.controller.acknowledge(request.sessionId, first.pairId, null)
    await expect(t.controller.render(t.request(after))).rejects.toThrow('changed source')
    expect(await readFile(before.path)).toEqual(before.bytes)
  } finally {
    await t.close()
  }
})

test('the real prepared-source cache authorizes native Before against its exact filtered After lineage', async () => {
  const f = await detailCacheFixture(true, 1),
    oldBackend = process.env.IRODORI_PREVIEW_BACKEND,
    acquired: { cacheId: string; comparisonOf?: string }[] = []
  const controller = new NativeCpuController({
    root: join(f.source.root, 'native-comparison'),
    executable,
    policy: async () => structuredClone(f.source.job.policy),
    acquireSource: async (request, signal, comparisonOf) => {
      acquired.push({ cacheId: request.source.cacheId, comparisonOf: comparisonOf?.cacheId })
      return f.previews.acquireCpuWorkingSource(request, signal, comparisonOf)
    },
    foreground: (work, signal) => f.previews.runCpuForeground(work, signal),
    existingOwners: (asset, request) =>
      nativeCpuExistingOwners(
        asset.width,
        asset.height,
        request.viewport.width,
        request.viewport.height,
      ),
  })
  try {
    process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
    await controller.open()
    const after = (await f.previews.requestHdr(f.id, crypto.randomUUID()))!,
      before = await f.previews.requestComparison(
        after.workingSource!,
        crypto.randomUUID(),
        f.options.revision,
      ),
      request: CpuPreviewRequest = {
        version: NATIVE_CPU_PREVIEW_VERSION,
        requestId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        source: after.cpuSource!,
        beforeSource: before.cpuSource!,
        generation: 1,
        expectedSettingsRevision: f.options.revision,
        parameters: structuredClone(f.options.adjustments!),
        quality: 'normal',
        hdrRanges: false,
        headroom: null,
        viewport: { width: f.source.frame.width, height: f.source.frame.height, dpr: 1 },
      },
      pair = await controller.render(request)
    await controller.acknowledge(request.sessionId, pair.pairId, null)
    expect(acquired).toEqual([
      { cacheId: request.source.cacheId },
      { cacheId: request.beforeSource!.cacheId, comparisonOf: request.source.cacheId },
    ])
    expect(pair.beforeSource).toEqual(request.beforeSource)
    expect(await readPlane(controller, pair.beforeSamples!.url)).toEqual(
      Buffer.from(new Float32Array([...f.source.frame.data, ...f.source.frame.data]).buffer),
    )
    compare(
      await readPlane(controller, pair.before.url),
      cpuOracle(
        { pixels: f.source.frame.data, asset: f.source.frame.hdr! },
        { ...request, parameters: neutralAdjustments },
      ).before,
    )
    await f.previews.release(before.requestId)
    await f.previews.release()
    const next = await controller.render({
      ...request,
      requestId: crypto.randomUUID(),
      generation: 2,
    })
    expect(next.diagnostics.beforeCacheHit).toBe(true)
    await controller.acknowledge(request.sessionId, next.pairId, pair.pairId)
    f.change({ noiseReduction: { ...f.options.noiseReduction!, luminance: 12 } })
    await expect(
      controller.render({
        ...request,
        requestId: crypto.randomUUID(),
        generation: 3,
        expectedSettingsRevision: f.options.revision,
      }),
    ).rejects.toThrow('identity changed')
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
    await controller.reset()
    expect(await readdir(join(f.source.root, 'native-comparison'))).toEqual([])
  } finally {
    await controller.close()
    await f.close()
    if (oldBackend === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
    else process.env.IRODORI_PREVIEW_BACKEND = oldBackend
  }
})
