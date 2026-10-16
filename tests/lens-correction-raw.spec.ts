import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import type { FullPreviewResult } from '../src/main/preview-types'
import { rawDecoder } from '../src/main/processing/decoders'
import { correctionPlan } from '../src/main/processing/lens-correction'
import { neutralAdjustments } from '../src/shared/adjustments'
import {
  HDR_ADJUSTMENT_VERSION,
  HDR_OUTPUT_VERSION,
  HDR_RAW_SOURCE_VERSION,
} from '../src/shared/hdr'
import { automaticLensSettings, noLensSettings, type ProcessingOptions } from '../src/shared/lens'

const sourcePath = 'tests/fixtures/sony-zv1.ARW',
  sourceSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'

async function fileSha256(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function proof(output: string, result: FullPreviewResult) {
  const pixels = await readFile(join(output, 'full.rgba'))
  expect(result.format).toBe('rgba8-srgb')
  expect(result.byteLength).toBe(result.width * result.height * 4)
  expect(pixels.length).toBe(result.byteLength)
  expect(createHash('sha256').update(pixels).digest('hex')).toBe(result.sha256)
  expect(result.renderId).toBe(
    `${HDR_RAW_SOURCE_VERSION}-${HDR_ADJUSTMENT_VERSION}-${HDR_OUTPUT_VERSION}-${JSON.stringify(result.adjustments)}`,
  )
  let invalidAlpha = 0
  for (let i = 3; i < pixels.length; i += 4) invalidAlpha += Number(pixels[i] !== 255)
  expect(invalidAlpha).toBe(0)

  const ratio = Math.min(1, 96 / Math.max(result.width, result.height)),
    width = Math.max(1, Math.round(result.width * ratio)),
    height = Math.max(1, Math.round(result.height * ratio)),
    sample = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from =
        (Math.floor(((y + 0.5) * result.height) / height) * result.width +
          Math.floor(((x + 0.5) * result.width) / width)) *
        4
      pixels.copy(sample, (y * width + x) * 4, from, from + 4)
    }
  const placeholder = await sharp(sample, { raw: { width, height, channels: 4 } })
    .withIccProfile('srgb')
    .png()
    .toBuffer()
  expect(result.placeholderBytes).toBe(placeholder.length)
  expect(await readFile(join(output, 'placeholder.png'))).toEqual(placeholder)
  return pixels
}

function workingAsset(output: string, result: FullPreviewResult) {
  expect(result.linear?.hdr).toBeDefined()
  return {
    path: join(output, 'linear.f32'),
    width: result.width,
    height: result.height,
    ...result.linear!,
  }
}

test('real Sony corrected CPU and GPU frames agree, reuse linear data and generate exact placeholders', async () => {
  test.setTimeout(180_000)
  const root = test.info().outputPath('corrected')
  await mkdir(root, { recursive: true })
  const cpu = new PreviewEngine(undefined, 'cpu'),
    gpu = new PreviewEngine(undefined, 'gpu')
  const output = async (name: string) => {
    const directory = join(root, name)
    await mkdir(directory)
    return directory
  }
  try {
    expect(await fileSha256(sourcePath)).toBe(sourceSha256)
    const metadata = await cpu.inspect(sourcePath)
    expect(metadata.lensProfile.distortion?.values).toHaveLength(11)
    expect(metadata.lensProfile.vignetting?.values).toHaveLength(16)
    expect(metadata.lensProfile.chromaticAberration?.red.values).toHaveLength(11)
    const options: ProcessingOptions = {
        metadata,
        settings: automaticLensSettings,
        revision: 7,
        processing: 'hdr-v1',
        adjustments: neutralAdjustments,
      },
      cpuOutput = await output('cpu-neutral'),
      gpuOutput = await output('gpu-neutral')
    const reference = await cpu.renderFull(sourcePath, cpuOutput, undefined, options)
    const expected = await proof(cpuOutput, reference)
    const actual = await gpu.renderFull(sourcePath, gpuOutput, undefined, options)
    if (actual.diagnostics?.fallback?.includes('No hardware GPU'))
      test.skip(true, 'No hardware GPU available; CPU render completed.')
    expect(actual.diagnostics?.backend, JSON.stringify(actual.diagnostics)).toBe('gpu')
    expect([actual.width, actual.height]).toEqual([reference.width, reference.height])
    expect([actual.width, actual.height]).toEqual([5422, 3622])
    expect(actual.settingsRevision).toBe(7)
    expect(reference.appliedCorrections).toEqual(automaticLensSettings)
    expect(actual.appliedCorrections).toEqual(automaticLensSettings)
    const cpuWorking = workingAsset(cpuOutput, reference),
      gpuWorking = workingAsset(gpuOutput, actual)
    expect(await fileSha256(cpuWorking.path)).toBe(cpuWorking.sha256)
    expect(await fileSha256(gpuWorking.path)).toBe(gpuWorking.sha256)
    expect(actual.linear!.hdr!.source).toEqual(reference.linear!.hdr!.source)
    const pixels = await proof(gpuOutput, actual)
    let difference = 0,
      large = 0
    for (let i = 0; i < pixels.length; i++) {
      const delta = Math.abs(pixels[i] - expected[i])
      difference += delta
      if (delta > 2) large++
    }
    const report = {
      cpu: reference.diagnostics,
      gpu: actual.diagnostics,
      mean: difference / pixels.length,
      largeFraction: large / pixels.length,
      width: actual.width,
      height: actual.height,
    }
    console.log(report)
    await writeFile(
      test.info().outputPath('corrected-comparison.json'),
      JSON.stringify(report, null, 2),
    )
    await sharp(pixels, { raw: { width: actual.width, height: actual.height, channels: 4 } })
      .resize(1280)
      .png()
      .toFile(test.info().outputPath('corrected.png'))
    expect(report.mean).toBeLessThan(0.1)
    expect(report.largeFraction).toBeLessThan(0.002)
    const adjustedOptions = {
      ...options,
      adjustments: {
        ...neutralAdjustments,
        shadows: 65,
        whites: -35,
        blacks: -20,
        exposureEv: 0.75,
        contrast: 35,
        highlights: -80,
      },
      revision: 8,
    }
    const cpuAdjusted = await output('cpu-adjusted'),
      gpuAdjusted = await output('gpu-adjusted'),
      adjustedCpu = await cpu.renderFull(sourcePath, cpuAdjusted, undefined, {
        ...adjustedOptions,
        workingAsset: cpuWorking,
      }),
      adjustedGpu = await gpu.renderFull(sourcePath, gpuAdjusted, undefined, {
        ...adjustedOptions,
        workingAsset: gpuWorking,
      })
    for (const [directory, result] of [
      [cpuAdjusted, adjustedCpu],
      [gpuAdjusted, adjustedGpu],
    ] as const) {
      expect(result.linear).toBeUndefined()
      expect(result.settingsRevision).toBe(8)
      expect((await readdir(directory)).sort()).toEqual(['full.rgba', 'placeholder.png'])
    }
    const adjustedReference = await proof(cpuAdjusted, adjustedCpu),
      adjustedPixels = await proof(gpuAdjusted, adjustedGpu)
    let adjustedDifference = 0,
      adjustedLarge = 0
    for (let i = 0; i < adjustedPixels.length; i++) {
      const delta = Math.abs(adjustedPixels[i] - adjustedReference[i])
      adjustedDifference += delta
      if (delta > 2) adjustedLarge++
    }
    expect(adjustedDifference / adjustedPixels.length).toBeLessThan(0.1)
    expect(adjustedLarge / adjustedPixels.length).toBeLessThan(0.002)
    // Correction changes need a newly prepared asset; the warm assets above match all settings.
    const toggledOutput = await output('gpu-distortion-only'),
      toggledSettings = { ...noLensSettings, distortion: true },
      toggled = await gpu.renderFull(sourcePath, toggledOutput, undefined, {
        ...options,
        settings: toggledSettings,
        revision: 8,
      })
    const plan = correctionPlan(5496, 3672, metadata.lensProfile, toggledSettings)
    expect([toggled.width, toggled.height]).toEqual([plan.width, plan.height])
    expect(toggled.appliedCorrections).toEqual(toggledSettings)
    expect(toggled.linear!.hdr!.sha256).not.toBe(gpuWorking.sha256)
    expect(await fileSha256(join(toggledOutput, 'linear.f32'))).toBe(toggled.linear!.sha256)
    await proof(toggledOutput, toggled)
    expect(await fileSha256(cpuWorking.path)).toBe(cpuWorking.sha256)
    expect(await fileSha256(gpuWorking.path)).toBe(gpuWorking.sha256)
    expect(await fileSha256(sourcePath)).toBe(sourceSha256)
  } finally {
    await cpu.close()
    await gpu.close()
  }
})

test('CPU adapter exposes an owned unrotated linear camera frame', async () => {
  const session = await rawDecoder('sample.arw')!.open('tests/fixtures/sony-zv1.ARW')
  try {
    const frame = session.linear()
    expect([frame.width, frame.height]).toEqual([5496, 3672])
    expect(frame.data.length).toBe(frame.width * frame.height * 4)
    expect(frame.data.some((n) => n > 0 && n < 1)).toBe(true)
  } finally {
    session.close()
  }
})

test('corrected previews retain all supported corrections after GPU failure', async () => {
  // Each correction variant requires a full CPU preparation after the simulated failure.
  test.setTimeout(180_000)
  const root = test.info().outputPath('fallback')
  await mkdir(root, { recursive: true })
  let attempts = 0
  const engine = new PreviewEngine(undefined, 'auto', {
    render: async () => {
      attempts++
      throw new Error('Simulated corrected GPU failure')
    },
    releaseFrame: () => {},
    close: () => {},
  })
  try {
    expect(await fileSha256(sourcePath)).toBe(sourceSha256)
    const metadata = await engine.inspect(sourcePath),
      firstOutput = join(root, 'all-corrections'),
      secondOutput = join(root, 'vignetting-off'),
      warmOutput = join(root, 'vignetting-off-warm')
    await mkdir(firstOutput)
    await mkdir(secondOutput)
    await mkdir(warmOutput)
    const result = await engine.renderFull(sourcePath, firstOutput, undefined, {
      metadata,
      settings: automaticLensSettings,
      revision: 3,
    })
    expect(result).toMatchObject({
      width: 5422,
      height: 3622,
      settingsRevision: 3,
      appliedCorrections: automaticLensSettings,
      diagnostics: { backend: 'cpu', fallback: 'Error: Simulated corrected GPU failure' },
    })
    await proof(firstOutput, result)
    const settings = { ...automaticLensSettings, vignetting: false },
      second = await engine.renderFull(sourcePath, secondOutput, undefined, {
        metadata,
        settings,
        revision: 4,
      })
    expect(attempts).toBe(2)
    expect(second.appliedCorrections).toEqual(settings)
    expect(second.linear!.sha256).not.toBe(result.linear!.sha256)
    expect(second.settingsRevision).toBe(4)
    await proof(secondOutput, second)
    const working = workingAsset(secondOutput, second),
      warm = await engine.renderFull(sourcePath, warmOutput, undefined, {
        metadata,
        settings,
        revision: 5,
        workingAsset: working,
      })
    expect(attempts).toBe(2)
    expect(warm.linear).toBeUndefined()
    expect(warm.settingsRevision).toBe(5)
    expect(warm.sha256).toBe(second.sha256)
    expect((await readdir(warmOutput)).sort()).toEqual(['full.rgba', 'placeholder.png'])
    await proof(warmOutput, warm)
    expect(await fileSha256(working.path)).toBe(working.sha256)
    expect(await fileSha256(join(firstOutput, 'linear.f32'))).toBe(result.linear!.sha256)
    expect(await fileSha256(sourcePath)).toBe(sourceSha256)
  } finally {
    await engine.close()
  }
})
