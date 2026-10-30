import { expect, test } from '@playwright/test'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { NativeCpuController } from '../src/main/native-cpu-controller'
import { nativeCpuExecutable, nativeCpuMaskCapability } from '../src/main/native-cpu-executable'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import { nativeCpuExistingOwners } from '../src/shared/native-cpu-memory'
import {
  NATIVE_CPU_PREVIEW_VERSION,
  type CpuPreviewRequest,
} from '../src/shared/native-cpu-preview'
import { NATIVE_HDR_MASK_VERSION, type NativeHdrMaskRequest } from '../src/shared/native-hdr-mask'
import { receiveNativeHdrMask } from '../src/renderer/src/preview/native-mask-receiver'
import { detailCacheFixture } from './detail-preview-cache.helpers'

test.skip(process.platform !== 'linux' || process.arch !== 'x64', 'Checked Linux x64 helper.')
const previous = process.env.IRODORI_PREVIEW_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previous === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previous
})
async function sources(f: Awaited<ReturnType<typeof detailCacheFixture>>) {
  const after = (await f.previews.requestHdr(f.id, crypto.randomUUID()))!,
    before = await f.previews.requestComparison(
      after.workingSource!,
      crypto.randomUUID(),
      f.options.revision,
    ),
    request: NativeHdrMaskRequest = {
      version: NATIVE_HDR_MASK_VERSION,
      requestId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      source: before.cpuSource!,
      comparisonOf: after.cpuSource!,
      generation: 1,
      expectedSettingsRevision: f.options.revision,
      comparison: 'before',
      domain: 'content-hdr',
      parameters: structuredClone(neutralAdjustments),
      target: structuredClone(SDR_TARGET),
      existingOwners: { ramBytes: 0, vramBytes: 0 },
    }
  return { after, before, request }
}

test('an original Before mask lease requires exact After lineage and retains both entries independently of UI release', async () => {
  const f = await detailCacheFixture(true, 1),
    signal = new AbortController().signal
  let lease: Awaited<ReturnType<typeof f.previews.acquireCpuMaskWorkingSource>> | undefined
  try {
    const { after, before, request } = await sources(f),
      policy = f.source.job.policy
    await expect(
      f.previews.acquireCpuMaskWorkingSource(
        { ...request, comparisonOf: undefined },
        signal,
        policy,
      ),
    ).rejects.toThrow('identity changed')
    for (const changed of [
      { ...request, comparison: 'after' as const },
      { ...request, comparisonOf: { ...request.comparisonOf!, photoId: '0'.repeat(64) } },
      { ...request, comparisonOf: { ...request.comparisonOf!, cacheId: crypto.randomUUID() } },
    ])
      await expect(
        f.previews.acquireCpuMaskWorkingSource(changed, signal, policy),
      ).rejects.toThrow()
    lease = await f.previews.acquireCpuMaskWorkingSource(request, signal, policy)
    expect(lease.parameters).toEqual(neutralAdjustments)
    expect(lease.source).toEqual(before.cpuSource)
    expect(lease.asset.sha256).toBe(f.source.job.asset.sha256)
    const a = f.previews.acquire(new URL(after.linear.url!))!,
      b = f.previews.acquire(new URL(before.linear!.url!))!,
      afterPath = a.path,
      beforePath = b.path
    a.release()
    b.release()
    await f.previews.release(before.requestId)
    await f.previews.release(after.requestId)
    await lease.check(request.expectedSettingsRevision, signal)
    expect(await lease.file.readFile()).toEqual(await readFile(beforePath))
    expect(await readFile(afterPath)).not.toEqual(await readFile(beforePath))
    f.change({ noiseReduction: { ...f.options.noiseReduction!, luminance: 12 } })
    await expect(lease.check(request.expectedSettingsRevision, signal)).rejects.toThrow('changed')
    await lease.release()
    lease = undefined
    await f.previews.release()
    await expect(access(afterPath)).rejects.toThrow()
    await expect(access(beforePath)).rejects.toThrow()
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await lease?.release()
    await f.close()
  }
})

test('the real native mask uses unfiltered pixels, echoes its After lineage and recognizes only acknowledged CPU source pairs', async () => {
  const f = await detailCacheFixture(true),
    executable = await nativeCpuExecutable(resolve('vendor')),
    capability = await nativeCpuMaskCapability(resolve('vendor')),
    controller = new NativeCpuController({
      root: join(f.source.root, 'comparison-mask-native'),
      executable: async () => executable,
      policy: async () => structuredClone(f.source.job.policy),
      acquireSource: (request, signal, parent) =>
        f.previews.acquireCpuWorkingSource(request, signal, parent),
      foreground: (work, signal) => f.previews.runCpuForeground(work, signal),
      existingOwners: (asset, request) =>
        nativeCpuExistingOwners(
          asset.width,
          asset.height,
          request.viewport.width,
          request.viewport.height,
        ),
      mask: {
        arithmeticSha256: capability.arithmeticSha256,
        acquireSource: (request, signal) =>
          f.previews.acquireCpuMaskWorkingSource(request, signal, f.source.job.policy),
        checkTarget: (request) => expect(request.target).toEqual(SDR_TARGET),
      },
    })
  try {
    await controller.open()
    const { after, before, request } = await sources(f),
      presentation: CpuPreviewRequest = {
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
        viewport: { width: before.width, height: before.height, dpr: 1 },
      },
      pair = await controller.render(presentation)
    expect(controller.hasCpuPresentationSource(before.cpuSource!, after.cpuSource!)).toBe(false)
    await controller.acknowledge(presentation.sessionId, pair.pairId, null)
    expect(controller.hasCpuPresentationSource(after.cpuSource!)).toBe(true)
    expect(controller.hasCpuPresentationSource(before.cpuSource!)).toBe(false)
    expect(controller.hasCpuPresentationSource(before.cpuSource!, after.cpuSource!)).toBe(true)
    expect(
      controller.hasCpuPresentationSource(before.cpuSource!, {
        ...after.cpuSource!,
        cacheId: crypto.randomUUID(),
      }),
    ).toBe(false)
    expect(() => controller.renderMask({ ...request, comparison: 'after' })).toThrow('lineage')
    expect(() =>
      controller.renderMask({
        ...request,
        comparisonOf: { ...after.cpuSource!, photoId: '0'.repeat(64) },
      }),
    ).toThrow('lineage')
    const output = await controller.renderMask(request)
    expect(output.kind).toBe('mask')
    if (output.kind !== 'mask') throw new Error('Tiny native Before mask declined.')
    expect(output.comparisonOf).toEqual(after.cpuSource)
    expect(output.source).toEqual(before.cpuSource)
    expect(output.parameters).toEqual(neutralAdjustments)
    const expected = new Uint8Array(before.width * before.height),
      asset = before.linear!.hdr!,
      owner = controller.acquireMask(new URL(output.url))!
    analyzeHdr(
      f.source.frame.data,
      neutralAdjustments,
      asset,
      SDR_TARGET,
      hdrStatistics('content-hdr', SDR_TARGET, asset),
      expected,
    )
    try {
      expect(await readFile(owner.path)).toEqual(Buffer.from(expected))
      await expect(
        receiveNativeHdrMask(
          { ...output, comparisonOf: { ...after.cpuSource!, cacheId: crypto.randomUUID() } },
          request,
          asset,
          new AbortController().signal,
        ),
      ).rejects.toThrow('exact request/source')
      let released = false
      const release = controller.releaseMask(request.sessionId, output.maskId).then(() => {
        released = true
      })
      await Promise.resolve()
      expect(released).toBe(false)
      owner.release()
      await release
    } finally {
      owner.release()
    }
    await f.previews.release(before.requestId)
    await f.previews.release(after.requestId)
    await controller.release(presentation.sessionId, null)
    expect(controller.hasCpuPresentationSource(before.cpuSource!, after.cpuSource!)).toBe(false)
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await controller.close()
    await f.close()
  }
})
