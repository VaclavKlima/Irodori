import { expect } from '@playwright/test'
import type { CropGpu } from '../src/main/gpu/crop'
import type { SpatialDetailGpu } from '../src/main/gpu/spatial-detail'
import { cropWorkingFrame, type CropFrameJob } from '../src/main/processing/crop-frame'
import {
  prepareCropWorkingAsset,
  type CropPreparationJob,
} from '../src/main/processing/crop-preparation'
import { detailWorkingFrame, type DetailFrameJob } from '../src/main/processing/detail-frame'
import {
  prepareDetailWorkingAsset,
  type DetailPreparationJob,
} from '../src/main/processing/detail-preparation'
import type { WorkingFrame } from '../src/shared/adjustments'
import { resampleCropTile } from '../src/shared/crop-filter'
import {
  compileDetailSharpening,
  compileNoiseReduction,
  spatialDetailTile,
} from '../src/shared/spatial-detail'

type ReferenceJob<T> = Omit<T, 'backend'> & { readonly backend?: string }
/** Test-only numerical oracles. Production admission/stream/lease checks remain active,
 * while independent canonical CPU mathematics supplies expected pixels. No application
 * entry point imports this file or exposes these owners as selectable backends. */
export function detailReferenceOwner(): SpatialDetailGpu {
  return {
    adapter: 'test-only-independent-reference',
    bytes: 0,
    allocatedBytes: 0,
    programCount: 0,
    precisionRecoveryTiles: 0,
    async render(job, signal) {
      signal.throwIfAborted()
      return spatialDetailTile(
        job.image,
        job.tile,
        job.source,
        compileNoiseReduction(job.noiseReduction),
        compileDetailSharpening(job.detailSharpening),
        job.primaries,
      )
    },
    async close() {},
  }
}
export async function cropReferenceOwner(): Promise<CropGpu> {
  return {
    adapter: 'test-only-independent-reference',
    bytes: 0,
    precisionRecoveryTiles: 0,
    async render(geometry, tile, source, signal) {
      signal.throwIfAborted()
      return resampleCropTile(geometry, tile, source)
    },
    async close() {},
  }
}
export async function prepareDetailReference(
  path: string,
  job: ReferenceJob<DetailPreparationJob>,
  output: string,
  signal: AbortSignal,
  progress?: Parameters<typeof prepareDetailWorkingAsset>[4],
) {
  const result = await prepareDetailWorkingAsset(
    path,
    { ...job, backend: 'gpu' },
    output,
    signal,
    progress,
    detailReferenceOwner,
  )
  return {
    ...result,
    backend: result.backend === 'identity' ? ('identity' as const) : ('cpu' as const),
    cpuTiles: result.gpuTiles,
    gpuTiles: 0,
  }
}
export async function detailFrameReference(
  frame: WorkingFrame,
  job: ReferenceJob<DetailFrameJob>,
  signal: AbortSignal,
) {
  const result = await detailWorkingFrame(
    frame,
    { ...job, backend: 'gpu' },
    signal,
    detailReferenceOwner,
  )
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      backend: result.active ? ('cpu' as const) : ('identity' as const),
      cpuTiles: result.diagnostics.gpuTiles,
      gpuTiles: 0,
    },
  }
}
export async function prepareCropReference(
  path: string,
  job: ReferenceJob<CropPreparationJob>,
  output: string,
  signal: AbortSignal,
  progress?: Parameters<typeof prepareCropWorkingAsset>[4],
) {
  const result = await prepareCropWorkingAsset(
    path,
    { ...job, backend: 'gpu' },
    output,
    signal,
    progress,
    cropReferenceOwner,
  )
  return {
    ...result,
    backend:
      result.backend === 'identity' || result.backend === 'copy'
        ? result.backend
        : ('cpu' as const),
    cpuTiles: result.gpuTiles,
    gpuTiles: 0,
  }
}
export async function cropFrameReference(
  frame: WorkingFrame,
  job: ReferenceJob<CropFrameJob>,
  signal: AbortSignal,
) {
  return cropWorkingFrame(frame, { ...job, backend: 'gpu' }, signal, cropReferenceOwner)
}

/** Existing spatial GPU acceptance gate (unchanged). */
export function expectFloatReference(
  actual: Float32Array | Buffer,
  expected: Float32Array,
  exactAlpha = false,
) {
  const values =
    actual instanceof Float32Array
      ? actual
      : new Float32Array(actual.buffer, actual.byteOffset, actual.byteLength / 4)
  expect(values.length).toBe(expected.length)
  let ratio = 0
  for (let i = 0; i < values.length; i++) {
    if (exactAlpha && i % 4 === 3)
      expect(Object.is(values[i], expected[i]), `alpha at ${i}`).toBe(true)
    ratio = Math.max(
      ratio,
      Math.abs(values[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i])),
    )
  }
  expect(ratio).toBeLessThanOrEqual(1)
}
export function expectDisplayReference(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length)
  let maximum = 0
  for (let i = 0; i < actual.length; i++)
    maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]))
  expect(maximum).toBeLessThanOrEqual(1)
}
