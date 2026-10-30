import { expect, test } from '@playwright/test'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { NativeCpuController } from '../src/main/native-cpu-controller'
import { nativeCpuExecutable } from '../src/main/native-cpu-executable'
import { nativeCpuExistingOwners } from '../src/shared/native-cpu-memory'
import {
  NATIVE_CPU_PREVIEW_VERSION,
  type CpuPreviewRequest,
} from '../src/shared/native-cpu-preview'
import type { HdrWorkingAsset } from '../src/shared/hdr'
import { detailCacheFixture } from './detail-preview-cache.helpers'
import { canonicalDetailFrame, detailFrameJob } from './detail-frame.helpers'
import { cpuOracle, readPlane } from './native-cpu-controller.helpers'
import { sha } from './export.helpers'

test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'The shipping helper is Linux x64.',
)

test('the shipped native renderer consumes an attested filtered cache FD, retains it independently and rejects changed detail controls', async () => {
  const executable = await nativeCpuExecutable(resolve('vendor')),
    previous = process.env.IRODORI_PREVIEW_BACKEND,
    f = await detailCacheFixture(true, 1)
  let acquisitions = 0,
    releases = 0,
    actualAsset: HdrWorkingAsset | undefined
  const controller = new NativeCpuController({
    root: join(f.source.root, 'native-pairs'),
    executable: async () => executable,
    policy: async () => structuredClone(f.source.job.policy),
    acquireSource: async (request, signal) => {
      const lease = await f.previews.acquireCpuWorkingSource(request, signal)
      acquisitions++
      actualAsset = lease.asset
      return {
        ...lease,
        release: async () => {
          await lease.release()
          releases++
        },
      }
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
    const frame = (await f.previews.requestHdr(f.id, crypto.randomUUID()))!,
      sourceOwner = f.previews.acquire(new URL(frame.linear.url!))!,
      path = sourceOwner.path,
      pixels = canonicalDetailFrame(f.source.frame, {
        ...detailFrameJob('rec2020'),
        ...f.source.job,
      }),
      frozen = structuredClone(f.options),
      request: CpuPreviewRequest = {
        version: NATIVE_CPU_PREVIEW_VERSION,
        requestId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        source: frame.cpuSource!,
        generation: 1,
        expectedSettingsRevision: frozen.revision,
        parameters: structuredClone(frozen.adjustments!),
        quality: 'normal',
        hdrRanges: false,
        headroom: null,
        viewport: { width: f.source.frame.width, height: f.source.frame.height, dpr: 1 },
      }
    sourceOwner.release()
    expect(await readFile(path)).toEqual(Buffer.from(pixels.buffer))
    expect(request.source.workingSha256).toBe(sha(Buffer.from(pixels.buffer)))
    const pair = await controller.render(request)
    await controller.acknowledge(request.sessionId, pair.pairId, null)
    expect(pair.source).toEqual(request.source)
    expect(pair.diagnostics).toMatchObject({
      sourceAttestedByMain: true,
      outputValidatedAfterChildClose: true,
      implementation: 'float64-ctl-cpu-strip-v1',
    })
    const expected = cpuOracle({ pixels, asset: actualAsset! }, request)
    for (const plane of ['before', 'after'] as const) {
      const bytes = await readPlane(controller, pair[plane].url)
      expect(bytes.length).toBe(expected[plane].length)
      let maximumCode = 0
      for (let i = 0; i < bytes.length; i++) {
        if (i % 4 === 3) expect(bytes[i]).toBe(expected[plane][i])
        else maximumCode = Math.max(maximumCode, Math.abs(bytes[i] - expected[plane][i]))
      }
      expect(maximumCode).toBeLessThanOrEqual(1)
    }
    await f.previews.release()
    const exportLease = (await f.previews.acquireWorkingAsset(
      f.id,
      frozen,
      new AbortController().signal,
    ))!
    expect(exportLease.asset.path).toBe(path)
    exportLease.release()
    await f.previews.release()
    expect(await readFile(path)).toEqual(Buffer.from(pixels.buffer))
    expect({ acquisitions, releases }).toEqual({ acquisitions: 1, releases: 0 })
    f.change({ noiseReduction: { ...f.options.noiseReduction!, luminance: 12 } })
    await expect(
      controller.render({
        ...request,
        requestId: crypto.randomUUID(),
        generation: 2,
        expectedSettingsRevision: f.options.revision,
      }),
    ).rejects.toThrow('identity changed')
    await controller.reset()
    expect({ acquisitions, releases }).toEqual({ acquisitions: 1, releases: 1 })
    await f.previews.release()
    await expect(access(path)).rejects.toThrow()
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await controller.close()
    await f.close()
    if (previous === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
    else process.env.IRODORI_PREVIEW_BACKEND = previous
  }
})
