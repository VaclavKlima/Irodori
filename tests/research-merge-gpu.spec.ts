/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createCameraStudy,
  CAMERA_STUDY_GPU_LIMIT,
} from '../scripts/research/merge-pipeline/camera-study'
import {
  cameraOracle,
  compareCameraStudy,
  comparePlanes,
  cpuCameraStage,
} from '../scripts/research/merge-pipeline/camera-oracle'
import { provenance } from '../scripts/research/pipeline/provenance'
import { distribution } from '../scripts/research/pipeline/metrics'
import { attachResearchEvidence } from './research.helpers'
import type { RawSource } from '../src/main/gpu/raw-source'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { librawDecoder } from '../src/main/processing/decoders/libraw'
import { PreviewEngine } from '../src/main/preview-engine'
import { correctionPlan, type CorrectionPlan } from '../src/main/processing/lens-correction'
import { automaticLensSettings, type LensProfile } from '../src/shared/lens'
import { unavailableProfile } from '../src/main/processing/metadata'

test.afterEach(async ({}, info) => attachResearchEvidence(info))
let retainedGpu: GPU | undefined

const sources = [
  'scripts/research/merge-pipeline/camera-study.ts',
  'scripts/research/merge-pipeline/camera-oracle.ts',
  'tests/research-merge-gpu.spec.ts',
  'src/main/merge/camera-registration.ts',
  'src/main/merge/area.ts',
  'src/main/gpu/merge-prepare-shader.ts',
  'src/main/processing/lens-correction.ts',
]
const lens: LensProfile = {
  provider: 'research',
  version: '1',
  label: 'Numeric distortion/CA clipping probe',
  identity: 'research-camera-evidence-lens-1',
  distortion: { radii: [0, 0.5, 1], values: [1, 1.02, 1.06] },
  vignetting: { radii: [0, 0.5, 1], values: [1, 1.2, 1.6] },
  chromaticAberration: {
    red: { radii: [0, 0.5, 1], values: [1, 0.998, 0.995] },
    blue: { radii: [0, 0.5, 1], values: [1, 1.003, 1.008] },
  },
  unavailable: {},
}

function numericInput(flip: number, corrected: boolean) {
  const width = 139,
    height = 71,
    rawWidth = width + 5,
    pixels = new Uint16Array(rawWidth * (height + 2)).fill(1200),
    raw: RawSource = {
      width,
      height,
      rawWidth,
      left: 2,
      top: 1,
      flip,
      pixels,
      cfa: [0, 1, 3, 2],
      black: [0, 0, 0, 0],
      scale: [1, 1, 1, 1],
      matrix: [1.8, -0.6, -0.2, 0, -0.1, 1.2, -0.1, 0, -0.1, -0.6, 1.7, 0],
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 4095,
        gains: [2, 1, 1.5, 1],
        restoreGain: 2,
        referenceWhite: 1,
        sourceSaturation: {
          thresholds: [3800, 3800, 3800, 3800],
          saturatedSites: 4,
          totalSites: width * height,
        },
      },
    }
  for (const [x, y] of [
    [0, 0],
    [70, 8],
    [71, 8],
    [width - 1, height - 1],
  ])
    pixels[(y + raw.top) * rawWidth + x + raw.left] = 4000
  const plan = correctionPlan(
      width,
      height,
      corrected ? lens : unavailableProfile,
      automaticLensSettings,
    ),
    outWidth = flip & 4 ? plan.height : plan.width,
    outHeight = flip & 4 ? plan.width : plan.height,
    rgba = new Float32Array(outWidth * outHeight * 4)
  for (let y = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++)
      rgba.set(
        [
          0.03 + (x / outWidth) * 4,
          0.02 + (y / outHeight) * 3,
          (x + y) % 7 ? 0.04 + ((x * 13 + y * 7) % 31) / 19 : -0.125,
          1,
        ],
        (y * outWidth + x) * 4,
      )
  return { raw, plan, rgba }
}

async function hardware() {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter({ powerPreference: 'high-performance' })
  test.skip(
    !adapter || adapter.info.isFallbackAdapter,
    'Hardware Dawn is required; software is not timing evidence.',
  )
  const device = await adapter!.requestDevice({
    requiredFeatures: adapter!.features.has('timestamp-query') ? ['timestamp-query'] : [],
    requiredLimits: {
      maxTextureDimension2D: Math.min(8192, adapter!.limits.maxTextureDimension2D),
    },
  })
  return { adapter: adapter!, device }
}

function deviceLimits(device: GPUDevice) {
  return {
    maxBufferSize: device.limits.maxBufferSize,
    maxTextureDimension2D: device.limits.maxTextureDimension2D,
    maxTextureArrayLayers: device.limits.maxTextureArrayLayers,
  }
}

function assertNoGpuErrors(errors: string[]) {
  expect(
    errors.length,
    JSON.stringify({ total: errors.length, first: errors.slice(0, 3) }, null, 2),
  ).toBe(0)
}

async function measure(
  directory: string,
  index: number,
  device: GPUDevice,
  raw: RawSource,
  plan: CorrectionPlan,
  rgba: Float32Array<ArrayBuffer>,
  native: boolean,
) {
  const width = raw.flip & 4 ? plan.height : plan.width,
    height = raw.flip & 4 ? plan.width : plan.height,
    scale = native ? Math.min(1, 1024 / Math.max(width, height)) : 0,
    reducedWidth = native ? Math.max(1, Math.floor(width * scale)) : 11,
    reducedHeight = native ? Math.max(1, Math.floor(height * scale)) : 7,
    inputHash = createHash('sha256').update(new Uint8Array(rgba.buffer)).digest('hex'),
    prepared = await cameraOracle(directory, index, raw, plan, rgba, reducedWidth, reducedHeight),
    cpuSamples: number[] = [],
    cpuProofs = []
  for (let i = 0; i < 3; i++) {
    const started = performance.now(),
      result = cpuCameraStage(prepared.input)
    cpuSamples.push(performance.now() - started)
    cpuProofs.push(comparePlanes(prepared.oracle.planes, result))
  }
  const study = await createCameraStudy(device, prepared.input)
  try {
    // One separately reported warm-up; every measured run still executes all native pixels.
    const warmup = await study.run(),
      observations = []
    for (let i = 0; i < 3; i++) observations.push(await study.run())
    const proof = await compareCameraStudy(study, prepared.input, prepared.oracle)
    const abort = new AbortController()
    abort.abort(new Error('Research pre-submission cancellation.'))
    await expect(study.run(abort.signal)).rejects.toThrow('Research pre-submission cancellation.')
    const after = createHash('sha256').update(new Uint8Array(rgba.buffer)).digest('hex')
    return {
      width,
      height,
      reducedWidth,
      reducedHeight,
      flip: raw.flip,
      crop: { left: plan.left, top: plan.top, width: plan.width, height: plan.height },
      corrections: plan.applied,
      sourceSaturation: raw.normalization?.sourceSaturation,
      inputHash,
      inputUnchanged: after === inputHash,
      oracleWallMs: prepared.oracleWallMs,
      canonicalMaskExtractionMs: prepared.canonicalMaskExtractionMs,
      cpuNumericalMs: distribution(cpuSamples),
      cpuSamples,
      cpuProofs,
      gpuCompletedMs: distribution(observations.map((v) => v.completedWallMs)),
      observations,
      warmup,
      allocationMs: study.allocationMs,
      uploadMs: study.uploadMs,
      compileMs: study.compileMs,
      allocatedGpuBytes: study.allocatedGpuBytes,
      gpuLimitBytes: CAMERA_STUDY_GPU_LIMIT,
      textureLayers: {
        rows: study.layerRows,
        count: study.layerCount,
        paddedNativeRows: study.paddedNativeRows,
      },
      maximumUploadBytes: study.maximumUploadBytes,
      timestamped: study.timestamped,
      ...proof,
    }
  } finally {
    study.destroy()
  }
}

function assertResult(result: Awaited<ReturnType<typeof measure>>) {
  expect(result.inputUnchanged).toBe(true)
  expect(result.allocatedGpuBytes).toBeLessThanOrEqual(result.gpuLimitBytes)
  expect(result.maximumUploadBytes).toBeLessThanOrEqual(8 * 1024 ** 2)
  for (const proof of [result.native, result.reduced, ...result.cpuProofs]) {
    expect.soft(proof.nonFinite, JSON.stringify(proof.worst)).toBe(0)
    expect.soft(proof.overTolerance, JSON.stringify(proof.worst)).toBe(0)
    expect.soft(proof.maximumToleranceRatio, JSON.stringify(proof.worst)).toBeLessThanOrEqual(1)
    expect.soft(proof.maskMismatches, JSON.stringify(proof.worst)).toBe(0)
  }
}

test('research camera evidence compares all orientations, signed pixels, lens clipping and partial strips to the maintained CPU writer', async ({}, info) => {
  test.setTimeout(180000)
  const { device, adapter } = await hardware(),
    directory = await mkdtemp(join(tmpdir(), 'luma-research-camera-')),
    errors: string[] = [],
    results = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  try {
    let index = 0
    for (const corrected of [false, true])
      for (let flip = 0; flip < 8; flip++) {
        const { raw, plan, rgba } = numericInput(flip, corrected),
          result = await measure(directory, index++, device, raw, plan, rgba, false)
        results.push(result)
        assertResult(result)
      }
    assertNoGpuErrors(errors)
  } finally {
    await writeFile(
      info.outputPath('camera-synthetic.json'),
      JSON.stringify(
        {
          provenance: await provenance(sources),
          adapter: adapter.info,
          deviceLimits: deviceLimits(device),
          errors,
          results,
          classification:
            'bounded research; original pixel/mask limits retained; no production or five-second acceptance',
        },
        null,
        2,
      ),
    )
    device.destroy()
    retainedGpu = undefined
    await rm(directory, { recursive: true, force: true })
  }
})

async function identity(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size }
}

for (const name of ['DSC03245.ARW', 'DSC03246.ARW'])
  test(`research native ${name} camera evidence retains fixture lens/clipping masks and records resident numerical cost separately`, async ({}, info) => {
    test.setTimeout(300000)
    const fixtureRoot = resolve('tests/fixtures/research-sony'),
      manifestPath = join(fixtureRoot, 'manifest.json'),
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        files: { name: string; path: string; sha256: string; bytes: number }[]
      },
      entry = manifest.files.find((file) => file.name === name)!,
      path = resolve(fixtureRoot, entry.path),
      before = await identity(path)
    expect(before).toEqual({ sha256: entry.sha256, bytes: entry.bytes })
    const directory = await mkdtemp(join(tmpdir(), 'luma-research-camera-native-')),
      inspector = new PreviewEngine(),
      gpu = new RawGpuRenderer()
    let device: GPUDevice | undefined,
      result: Awaited<ReturnType<typeof measure>> | undefined,
      setupMs = 0,
      adapter: GPUAdapterInfo | undefined
    const errors: string[] = []
    try {
      const started = performance.now(),
        metadata = await inspector.inspect(path),
        session = await librawDecoder.open(path)
      let raw: RawSource, plan: CorrectionPlan, rgba: Float32Array<ArrayBuffer>
      try {
        const decoded = session.gpuSource(true)
        if (!decoded?.normalization?.sourceSaturation)
          throw new Error('Verified Sony sensor data is required.')
        raw = decoded
        plan = correctionPlan(raw.width, raw.height, metadata.lensProfile, automaticLensSettings)
        const width = raw.flip & 4 ? plan.height : plan.width,
          height = raw.flip & 4 ? plan.width : plan.height
        rgba = new Float32Array(width * height * 4)
        await gpu.render(raw, plan, undefined, false, false, {
          gains: metadata.whiteBalance!.asShotGains,
          reviewWidth: Math.max(1, Math.floor(width * Math.min(1, 1024 / Math.max(width, height)))),
          reviewHeight: Math.max(
            1,
            Math.floor(height * Math.min(1, 1024 / Math.max(width, height))),
          ),
          checkpoint: async () => {},
          strip: async (top, bytes) => {
            const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
            rgba.set(values, top * width * 4)
          },
        })
      } finally {
        session.close()
        gpu.close()
      }
      await inspector.close()
      setupMs = performance.now() - started
      const hardwareContext = await hardware()
      device = hardwareContext.device
      adapter = hardwareContext.adapter.info
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
      result = await measure(directory, 0, device, raw, plan, rgba, true)
      assertResult(result)
      assertNoGpuErrors(errors)
    } finally {
      const after = await identity(path)
      await writeFile(
        info.outputPath(`camera-${name}.json`),
        JSON.stringify(
          {
            provenance: await provenance([...sources, manifestPath]),
            fixture: { name, before, after },
            adapter,
            deviceLimits: device && deviceLimits(device),
            setupMs,
            result,
            errors,
            classification:
              'native fixture stage research; not three-source merge or end-to-end five-second evidence',
            exclusions: [
              'RAW decode and existing GPU RGB/lens preparation are setup',
              'Canonical clipping masks are computed by the production CPU oracle and uploaded once',
              'Resident timings exclude all proof readback, source hashing, encoding and publication',
              'No alignment transforms, deghosting, exposure weighting or CFA fusion algorithm is replaced',
            ],
          },
          null,
          2,
        ),
      )
      device?.destroy()
      gpu.close()
      await inspector.close()
      retainedGpu = undefined
      await rm(directory, { recursive: true, force: true })
      expect(after).toEqual(before)
    }
  })
