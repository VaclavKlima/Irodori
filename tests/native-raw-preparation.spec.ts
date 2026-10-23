import { expect, test } from '@playwright/test'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderHdr } from '../src/main/processing/hdr-processing'
import { unavailableProfile } from '../src/main/processing/metadata'
import { GpuResourceBudgetError, type RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { nativeRawPreparationMemory } from '../src/main/native-raw-owner'
import type { HdrRawSourceFactory, NativeRawPreparedSource } from '../src/main/native-raw-source'
import type { HdrRawPreparation } from '../src/main/preview-types'
import { noLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'

// Stage ownership controls only: one synthetic sensor plane and a throwing GPU stub.
// No source bytes are decoded, no GPU is initialized, and no full F32 frame is allocated.
const width = 5496,
  height = 3672,
  rawWidth = 5504
let synthetic: NativeRawPreparedSource
let inputBytes: number
test.beforeAll(async () => {
  inputBytes = (await stat(resolve('tests/fixtures/sony-zv1.ARW'))).size
  synthetic = {
    source: {
      pixels: new Uint16Array(rawWidth * height),
      width,
      height,
      rawWidth,
      left: 0,
      top: 0,
      flip: 0,
      cfa: [0, 1, 3, 2],
      black: [0, 0, 0, 0],
      scale: [1, 1, 1, 1],
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 65535,
        gains: [1, 1, 1, 1],
        restoreGain: 1,
        referenceWhite: 1,
        sourceSaturation: null,
      },
    },
    make: 'Sony',
    model: 'ZV-1A',
    inputBytes,
    // Unused fixture fields; these zeroes do not represent measured native work.
    timings: { sourceMs: 0, validateMs: 0, receiveMs: 0, openMs: 0, unpackMs: 0 },
  }
})

function context(ramMiB: number): HdrRawPreparation {
  return {
    originalSha256: 'a'.repeat(64),
    parentWorkingKey: 'synthetic-stage-ownership',
    policy: resolveResourcePolicy(
      { ...DEFAULT_RESOURCE_SETTINGS, ramMiB },
      {
        ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'adapter-unverified' },
      },
      11,
    ),
    rendererReservation: { ramBytes: 256 * 1024 ** 2, vramBytes: 256 * 1024 ** 2 },
  }
}
function options(): ProcessingOptions {
  return {
    processing: 'hdr-v1',
    metadata: {
      version: 4,
      make: 'Sony',
      model: 'ZV-1A',
      hdrEligible: true,
      lensProfile: unavailableProfile,
    },
    settings: { ...noLensSettings },
    revision: 0,
  }
}

async function run(source: HdrRawSourceFactory, admission: HdrRawPreparation, fault: Error) {
  const output = test.info().outputPath('no-publication'),
    missing = test.info().outputPath('missing-original.ARW')
  await mkdir(output, { recursive: true })
  let gpuCalls = 0,
    releases = 0
  const gpu: Pick<RawGpuRenderer, 'render' | 'releaseFrame'> = {
    render: async (
      received,
      plan,
      _adjustments,
      exportLinear,
      cameraOnly,
      _merge,
      _consumer,
      _first,
      actual,
    ) => {
      gpuCalls++
      expect(received === synthetic.source).toBe(true)
      expect(plan?.applied).toEqual({
        distortion: false,
        vignetting: false,
        chromaticAberration: false,
      })
      expect(exportLinear).toBe(true)
      expect(cameraOnly).toBe(false)
      expect(actual?.policy).toBe(admission.policy)
      expect(actual?.rendererReservation).toBe(admission.rendererReservation)
      // The actual production call supplies its GPU-stage host ownership, even without a first surface.
      expect(
        actual!.baseEstimatedRamBytes + admission.rendererReservation.ramBytes,
      ).toBeLessThanOrEqual(admission.policy.ram.effectiveBytes)
      // The existing renderer additionally bounds all native GPU allocations to 1 GiB.
      expect(1024 ** 3 + admission.rendererReservation.vramBytes).toBeLessThanOrEqual(
        admission.policy.vram.effectiveBytes,
      )
      throw fault
    },
    releaseFrame: () => {
      releases++
    },
  }
  const outcome = renderHdr(
    missing,
    output,
    options(),
    gpu,
    'auto',
    undefined,
    source,
    admission,
  ).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  return {
    outcome,
    output,
    missing,
    get gpuCalls() {
      return gpuCalls
    },
    get releases() {
      return releases
    },
  }
}

test('a fitting native and GPU stage cannot allocate lazy WASM when CPU overlap exceeds the frozen budget', async () => {
  const admission = context(1024)
  expect(nativeRawPreparationMemory(inputBytes, admission).accepted).toBe(true)
  const attempted = await run(
    async () => synthetic,
    admission,
    new Error('Deliberate GPU preparation fault.'),
  )
  const outcome = await attempted.outcome
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('An injected GPU fault must not publish a working frame.')
  expect(outcome.error).toBeInstanceOf(GpuResourceBudgetError)
  expect(outcome.error).not.toMatchObject({ code: 'ENOENT' })
  expect(attempted.gpuCalls).toBe(1)
  expect(attempted.releases).toBe(1)
  expect(await readdir(attempted.output)).toEqual([])
})

test('a generous frozen CPU budget reaches the real lazy decoder open after the same GPU fault', async () => {
  const attempted = await run(
    async () => synthetic,
    context(8192),
    new Error('Deliberate GPU preparation fault.'),
  )
  const outcome = await attempted.outcome
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('The deliberately absent RAW must not produce a frame.')
  expect(outcome.error).toMatchObject({ code: 'ENOENT', path: attempted.missing })
  expect(outcome.error).not.toBeInstanceOf(GpuResourceBudgetError)
  expect(attempted.gpuCalls).toBe(1)
  expect(attempted.releases).toBe(1)
  expect(await readdir(attempted.output)).toEqual([])
})

test('a GPU resource-budget rejection is preserved instead of entering CPU recovery', async () => {
  const fault = new GpuResourceBudgetError()
  const attempted = await run(async () => synthetic, context(8192), fault)
  const outcome = await attempted.outcome
  if (outcome.ok) throw new Error('The injected budget rejection must remain terminal.')
  expect(outcome.error).toBe(fault)
  expect(attempted.gpuCalls).toBe(1)
  expect(attempted.releases).toBe(1)
  expect(await readdir(attempted.output)).toEqual([])
})

test('a rejected native source factory never starts GPU work or retries through WASM', async () => {
  const fault = new Error('Deliberate malformed native framing.')
  let calls = 0
  const attempted = await run(
    async () => {
      calls++
      throw fault
    },
    context(8192),
    new Error('GPU must not run.'),
  )
  const outcome = await attempted.outcome
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('A malformed native source must remain terminal.')
  expect(outcome.error).toBe(fault)
  expect(calls).toBe(1)
  expect(attempted.gpuCalls).toBe(0)
  expect(attempted.releases).toBe(1)
  expect(await readdir(attempted.output)).toEqual([])
})

test('an explicitly unavailable native source opens the existing decoder lazily', async () => {
  let calls = 0
  const attempted = await run(
    async () => {
      calls++
      return null
    },
    context(8192),
    new Error('GPU must not run.'),
  )
  const outcome = await attempted.outcome
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('The deliberately absent RAW must not produce a frame.')
  expect(outcome.error).toMatchObject({ code: 'ENOENT', path: attempted.missing })
  expect(calls).toBe(1)
  expect(attempted.gpuCalls).toBe(0)
  expect(attempted.releases).toBe(1)
  expect(await readdir(attempted.output)).toEqual([])
})
