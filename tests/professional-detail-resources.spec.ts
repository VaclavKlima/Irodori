import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { createSpatialDetailGpu, type SpatialDetailGpu } from '../src/main/gpu/spatial-detail'
import { prepareNativeRawExecutable } from '../src/main/native-raw-executable'
import { PreviewProcess } from '../src/main/preview-process'
import {
  prepareDetailWorkingAsset,
  type DetailPreparationJob,
} from '../src/main/processing/detail-preparation'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import {
  DETAIL_BAND_ROWS,
  DETAIL_GPU_BYTES,
  detailMemoryPlan,
  detailStreamMemoryPlan,
} from '../src/shared/detail-resources'
import { noLensSettings } from '../src/shared/lens'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import { DETAIL_TILE_EDGE } from '../src/shared/spatial-detail'
import { sourceAgreementHash } from './professional-source-agreement.helpers'

const json = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n')

function boundedJob(job: DetailPreparationJob, ramBytes: number, vramBytes: number) {
  const result = structuredClone(job)
  Object.assign(result.policy.ram, { effectiveBytes: ramBytes })
  Object.assign(result.policy.vram, { effectiveBytes: vramBytes })
  return result
}

/** Observe the actual owner; no computation, result or retirement fence is replaced. */
function observedOwner() {
  const raw = createSpatialDetailGpu(),
    lifecycle = {
      closeCalls: 0,
      closeStartedAt: null as number | null,
      closeCompletedAt: null as number | null,
    },
    owner: SpatialDetailGpu = {
      get adapter() {
        return raw.adapter
      },
      get bytes() {
        return raw.bytes
      },
      get allocatedBytes() {
        return raw.allocatedBytes
      },
      get programCount() {
        return raw.programCount
      },
      get precisionRecoveryTiles() {
        return raw.precisionRecoveryTiles
      },
      render: (job, signal) => raw.render(job, signal),
      async close() {
        lifecycle.closeCalls++
        lifecycle.closeStartedAt = performance.now()
        await raw.close()
        lifecycle.closeCompletedAt = performance.now()
      },
    }
  return { raw, owner, lifecycle }
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('full real Sony RAW detail obeys exact stream admission, retires GPU and CPU cancellation, and retries the same output path', async ({}, info) => {
  test.setTimeout(300000)
  const root = info.outputPath('full-raw-resources'),
    original = resolve('tests/fixtures/sony-zv1.ARW'),
    originalSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
    input = join(root, 'sony-zv1.ARW'),
    prepared = join(root, 'prepared'),
    source = join(prepared, 'linear.f32'),
    output = join(root, 'gpu-retry.f32'),
    producer = new PreviewProcess(resolve('out/main/preview-worker.js'), 90_000, 30_000, () =>
      prepareNativeRawExecutable(resolve('out/main')),
    ),
    signal = new AbortController().signal,
    gpuCancel = observedOwner(),
    gpuRetry = observedOwner(),
    codePaths = [
      'package-lock.json',
      'tests/professional-detail-resources.spec.ts',
      'src/main/processing/detail-preparation.ts',
      'src/main/processing/detail-bands.ts',
      'src/main/gpu/spatial-detail.ts',
      'src/shared/detail-resources.ts',
      'src/shared/resource-policy.ts',
      'src/shared/spatial-detail.ts',
      'src/shared/spatial-detail-wgsl.ts',
      'out/main/preview-worker.js',
    ],
    codeHashes = () =>
      Promise.all(
        codePaths.map(async (path) => ({ path, sha256: await sourceAgreementHash(resolve(path)) })),
      ),
    codeBefore = await codeHashes()
  await mkdir(prepared, { recursive: true })
  await json(join(root, 'implementation-before.json'), codeBefore)
  try {
    expect(await sourceAgreementHash(original)).toBe(originalSha256)
    await copyFile(original, input)
    await chmod(input, 0o444)
    const metadata = await producer.inspect(input, signal),
      options = {
        metadata,
        settings: noLensSettings,
        revision: 0,
        processing: 'hdr-v1' as const,
        prepareLinear: true,
        workingOnly: true,
      },
      frame = await producer.renderFull(input, prepared, signal, options)
    await producer.close()
    const asset = frame.linear?.hdr
    if (!asset) throw new Error('The real RAW producer did not return its linear source.')
    expect(frame.format).toBe('hdr-working')
    expect([asset.width, asset.height]).toEqual([5496, 3672])
    expect(asset.byteLength).toBe(asset.width * asset.height * 16)
    expect(asset.width * asset.height).toBeGreaterThan(20_000_000)
    expect(await sourceAgreementHash(source)).toBe(asset.sha256)
    await chmod(source, 0o444)
    const job: DetailPreparationJob = {
        asset,
        sourceIdentity: createHash('sha256')
          .update(JSON.stringify({ originalSha256, options, asset }))
          .digest('hex'),
        noiseReduction: { version: 1, luminance: 35, chroma: 45 },
        detailSharpening: { version: 1, amount: 40, radius: 1.2, threshold: 50 },
        backend: 'gpu',
        policy: resolveResourcePolicy(
          { version: 1, ramMiB: 2048, vramMiB: 2048 },
          {
            ram: { totalBytes: totalmem(), availableBytes: null },
            gpu: { status: 'unknown', reason: 'adapter-unverified' },
          },
          1,
        ),
        reservation: { ramBytes: 0, vramBytes: 0 },
      },
      plan = detailStreamMemoryPlan(asset, job, true),
      exact = boundedJob(job, plan.gpu.ramBytes, plan.gpu.vramBytes),
      frozen = JSON.stringify(exact),
      exactPlan = detailStreamMemoryPlan(asset, exact, true)
    expect(
      detailMemoryPlan({ policy: exact.policy, reservation: exactPlan.tileReservation }, true),
    ).toMatchObject({ cpu: plan.cpu, gpu: plan.gpu, cpuAccepted: true, gpuAccepted: true })
    await json(join(root, 'source-and-admission.json'), {
      input,
      originalSha256,
      frame,
      options,
      exact,
      plan: exactPlan,
      boundaryConstruction:
        'Frozen policy effectiveBytes set to exact planner totals; no Settings UI override or physical memory limit is claimed.',
      scope:
        'Actual full-source managed stream admission, completed-band cancellation and retry; not shader-in-flight, shutdown, contention or physical peak acceptance.',
    })
    const refusals = [
      {
        name: 'gpu-vram-one-byte-under',
        ram: plan.gpu.ramBytes,
        vram: plan.gpu.vramBytes - 1,
        backend: 'gpu' as const,
        message: 'Detail GPU preparation exceeds',
      },
      {
        name: 'gpu-host-ram-one-byte-under',
        ram: plan.gpu.ramBytes - 1,
        vram: plan.gpu.vramBytes,
        backend: 'gpu' as const,
        message: 'Detail GPU preparation exceeds',
      },
      {
        name: 'cpu-ram-one-byte-under',
        ram: plan.cpu.ramBytes - 1,
        vram: plan.gpu.vramBytes,
        backend: 'cpu' as const,
        message: 'Detail preparation exceeds',
      },
    ]
    const refusalEvidence = []
    for (const boundary of refusals) {
      const path = join(root, `${boundary.name}.f32`),
        refused = { ...boundedJob(job, boundary.ram, boundary.vram), backend: boundary.backend }
      let creations = 0
      await expect(
        prepareDetailWorkingAsset(source, refused, path, signal, undefined, () => {
          creations++
          throw new Error('A refused job attempted GPU creation.')
        }),
      ).rejects.toThrow(boundary.message)
      expect(creations).toBe(0)
      expect(gpuCancel.raw.allocatedBytes + gpuRetry.raw.allocatedBytes).toBe(0)
      expect(gpuCancel.raw.programCount + gpuRetry.raw.programCount).toBe(0)
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await sourceAgreementHash(source)).toBe(asset.sha256)
      refusalEvidence.push({
        ...boundary,
        plan: detailStreamMemoryPlan(asset, refused, true),
        gpuCreations: creations,
        outputAbsent: true,
      })
    }
    await json(join(root, 'refusals.json'), refusalEvidence)

    async function cancelAfterBand(backend: 'cpu' | 'gpu', path: string) {
      const cancellation = new AbortController(),
        reason = new Error(`Cancel actual ${backend} detail after its first completed band.`),
        progress: { completedRows: number; partialBytes: number; allocatedGpuBytes: number }[] = []
      let creations = 0,
        rejectedAt: number | null = null,
        failure: unknown
      try {
        await prepareDetailWorkingAsset(
          source,
          { ...exact, backend },
          path,
          cancellation.signal,
          async (value) => {
            const partialBytes = (await stat(path)).size,
              allocatedGpuBytes = backend === 'gpu' ? gpuCancel.raw.allocatedBytes : 0
            progress.push({ completedRows: value.completedRows, partialBytes, allocatedGpuBytes })
            expect(value.completedRows).toBe(DETAIL_BAND_ROWS)
            expect(partialBytes).toBe(asset!.width * DETAIL_BAND_ROWS * 16)
            if (backend === 'gpu') expect(allocatedGpuBytes).toBe(DETAIL_GPU_BYTES)
            const retained = join(root, `${backend}-cancelled-first-band.f32`)
            await copyFile(path, retained)
            await json(join(root, `${backend}-cancelled-band.json`), {
              ...value,
              partialBytes,
              sha256: await sourceAgreementHash(retained),
            })
            cancellation.abort(reason)
          },
          () => {
            creations++
            if (backend !== 'gpu') throw new Error('The canonical CPU path attempted GPU creation.')
            return gpuCancel.owner
          },
        )
      } catch (error) {
        failure = error
        rejectedAt = performance.now()
      }
      await json(join(root, `${backend}-cancellation.json`), {
        progress,
        gpuCreations: creations,
        failure: String(failure),
        rejectedAt,
        ...(backend === 'gpu'
          ? { lifecycle: gpuCancel.lifecycle, finalGpuAllocatedBytes: gpuCancel.raw.allocatedBytes }
          : {}),
      })
      expect(failure).toBe(reason)
      expect(progress).toHaveLength(1)
      expect(creations).toBe(backend === 'gpu' ? 1 : 0)
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      if (backend === 'gpu') {
        expect(gpuCancel.lifecycle.closeCalls).toBe(1)
        expect(gpuCancel.lifecycle.closeCompletedAt).not.toBeNull()
        expect(gpuCancel.lifecycle.closeCompletedAt!).toBeLessThanOrEqual(rejectedAt!)
        expect(gpuCancel.raw.allocatedBytes).toBe(0)
        expect(gpuCancel.raw.precisionRecoveryTiles).toBe(0)
      }
      expect(await sourceAgreementHash(source)).toBe(asset!.sha256)
    }
    await cancelAfterBand('gpu', output)
    await cancelAfterBand('cpu', join(root, 'cpu-cancelled.f32'))
    const completedRows: number[] = []
    let retryCreations = 0
    const retried = await prepareDetailWorkingAsset(
      source,
      exact,
      output,
      signal,
      (value) => {
        completedRows.push(value.completedRows)
      },
      () => {
        retryCreations++
        return gpuRetry.owner
      },
    )
    let verifiedBytes = 0,
      verifiedStrips = 0
    for await (const strip of readHdrStrips(output, retried.asset)) {
      verifiedBytes += strip.byteLength
      verifiedStrips++
    }
    await json(join(root, 'retry.json'), {
      retried,
      completedRows,
      retryCreations,
      verifiedBytes,
      verifiedStrips,
      lifecycle: gpuRetry.lifecycle,
      finalGpuAllocatedBytes: gpuRetry.raw.allocatedBytes,
    })
    expect(retried.path).toBe(output)
    expect(retried.reused).toBe(false)
    expect(retryCreations).toBe(1)
    expect(retried).toMatchObject({
      backend: 'gpu',
      cpuTiles: 0,
      precisionRecoveryTiles: 0,
      maxSourceStrips: 3,
      gpuTiles: Math.ceil(asset.width / DETAIL_TILE_EDGE) * asset.strips.length,
    })
    expect(retried.adapter).toBeTruthy()
    expect(retried.memory).toEqual(exactPlan)
    expect([retried.asset.width, retried.asset.height, retried.asset.byteLength]).toEqual([
      asset.width,
      asset.height,
      asset.byteLength,
    ])
    expect(verifiedBytes).toBe(asset.byteLength)
    expect(verifiedStrips).toBe(asset.strips.length)
    expect(completedRows).toEqual(
      Array.from({ length: asset.strips.length }, (_, index) =>
        Math.min(asset.height, (index + 1) * DETAIL_BAND_ROWS),
      ),
    )
    expect(await sourceAgreementHash(output)).toBe(retried.asset.sha256)
    expect(retried.asset.sha256).not.toBe(asset.sha256)
    expect(retried.asset.source).toEqual(asset.source)
    expect(retried.asset.whiteBalance).toEqual(asset.whiteBalance)
    expect(gpuRetry.lifecycle.closeCalls).toBe(1)
    expect(gpuRetry.lifecycle.closeCompletedAt).not.toBeNull()
    expect(gpuRetry.raw.allocatedBytes).toBe(0)
    expect(JSON.stringify(exact)).toBe(frozen)
    expect(await sourceAgreementHash(source)).toBe(asset.sha256)
  } catch (error) {
    await json(join(root, 'failure.json'), {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  } finally {
    await producer.close(true)
    await Promise.all([gpuCancel.raw.close(), gpuRetry.raw.close()])
    await json(join(root, 'final-retirement.json'), {
      cancellation: gpuCancel.lifecycle,
      retry: gpuRetry.lifecycle,
      gpuAllocatedBytes: gpuCancel.raw.allocatedBytes + gpuRetry.raw.allocatedBytes,
    })
    const codeAfter = await codeHashes()
    await json(join(root, 'implementation-after.json'), codeAfter)
    expect(codeAfter).toEqual(codeBefore)
    expect(await sourceAgreementHash(original)).toBe(originalSha256)
    expect(await sourceAgreementHash(input)).toBe(originalSha256)
  }
})
