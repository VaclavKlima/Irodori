import { expect, test } from '@playwright/test'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  hdrMaskBackend,
  nativeCpuExecutable,
  nativeCpuMaskCapability,
} from '../src/main/native-cpu-executable'
import { NativeMaskController } from '../src/main/native-mask-controller'
import { receiveNativeHdrMask } from '../src/renderer/src/preview/native-mask-receiver'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import { NATIVE_HDR_MASK_VERSION, type NativeHdrMaskRequest } from '../src/shared/native-hdr-mask'
import { detailCacheFixture } from './detail-preview-cache.helpers'

test.skip(hdrMaskBackend() !== 'native', 'Checked Linux x64 helper.')
const previous = process.env.IRODORI_PREVIEW_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_PREVIEW_BACKEND = 'gpu'
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
      source: before.sourceRef!,
      comparisonOf: after.sourceRef!,
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
    expect(lease.source).toEqual(before.sourceRef)
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

test('the real native mask uses unfiltered pixels, echoes its After lineage', async () => {
  const f = await detailCacheFixture(true),
    executable = await nativeCpuExecutable(resolve('vendor')),
    capability = await nativeCpuMaskCapability(resolve('vendor')),
    controller = new NativeMaskController({
      root: join(f.source.root, 'comparison-mask-native'),
      executable: async () => executable,
      foreground: (work, signal) => f.previews.runCpuForeground(work, signal),
      mask: {
        arithmeticSha256: capability.arithmeticSha256,
        acquireSource: (request, signal) =>
          f.previews.acquireCpuMaskWorkingSource(request, signal, f.source.job.policy),
        checkTarget: (request) => expect(request.target).toEqual(SDR_TARGET),
      },
    })
  try {
    await controller.open()
    const { after, before, request } = await sources(f)
    expect(() => controller.renderMask({ ...request, comparison: 'after' })).toThrow('lineage')
    expect(() =>
      controller.renderMask({
        ...request,
        comparisonOf: { ...after.sourceRef!, photoId: '0'.repeat(64) },
      }),
    ).toThrow('lineage')
    const output = await controller.renderMask(request)
    expect(output.kind).toBe('mask')
    if (output.kind !== 'mask') throw new Error('Tiny native Before mask declined.')
    expect(output.comparisonOf).toEqual(after.sourceRef)
    expect(output.source).toEqual(before.sourceRef)
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
          { ...output, comparisonOf: { ...after.sourceRef!, cacheId: crypto.randomUUID() } },
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
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await controller.close()
    await f.close()
  }
})
