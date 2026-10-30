import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { createExportGpu } from '../src/main/export/gpu'
import { neutralAdjustments } from '../src/shared/adjustments'
import { CREATIVE_COLOR_PARAMETER_BYTES } from '../src/shared/creative-color-gpu'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import { buildAcesReference, referenceAces } from './aces-reference'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: {
    input: [number, number, number]
    output: [number, number, number]
    primaries: string
    configuration: number
  }[]
}
const settings = (index: number) => {
  const c = reference.configurations[index]
  return {
    ...neutralAdjustments,
    ...c.intensity,
    colorMixer: structuredClone(c.mixer),
    colorGrading: structuredClone(c.grading),
  }
}

test('actual GPU export composes all independent creative-color references with independent SDR/HDR CTL and alpha', async () => {
  const directory = test.info().outputPath('ctl')
  await mkdir(directory)
  const binary = buildAcesReference(directory)
  let maximumRatio = 0,
    worst: unknown,
    count = 0
  for (let index = 0; index < reference.configurations.length; index++) {
    const vectors = reference.gpuVectors.filter(
        (v) => v.primaries === 'rec2020' && v.configuration === index,
      ),
      gpu = await createExportGpu(vectors.length, settings(index), undefined, true, false)
    try {
      const pixels = new Float32Array(vectors.flatMap((v, i) => [...v.input, (i % 4) / 3])),
        result = await gpu.render(pixels),
        actual = new Float32Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength / 4,
        )
      for (const [offset, peak, space] of [
        [0, 1, 'srgb'],
        [3, 10, 'rec2020'],
      ] as const) {
        const expected = referenceAces(
          binary,
          vectors.map((v) => v.output),
          peak,
          space,
        )
        for (let i = 0; i < vectors.length; i++)
          for (let c = 0; c < 3; c++) {
            const alpha = pixels[i * 4 + 3],
              wanted = expected[i][c] * alpha + 1 - alpha,
              value = actual[i * 6 + offset + c],
              ratio = Math.abs(value - wanted) / (2e-6 + 2e-5 * Math.abs(wanted))
            assert.ok(Number.isFinite(value))
            if (ratio > maximumRatio) {
              maximumRatio = ratio
              worst = { index, i, c, space, value, wanted, input: vectors[i].input }
            }
          }
      }
      count += vectors.length
    } finally {
      gpu.close()
    }
  }
  expect(count).toBe(1260)
  expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
})

test('neutral export retains existing buffer ownership and active jobs freeze color and white-balance settings', async () => {
  const vectors = reference.gpuVectors.filter(
      (v) => v.primaries === 'rec2020' && v.configuration === 9,
    ),
    pixels = new Float32Array(vectors.flatMap((v) => [...v.input, 1])),
    old = await createExportGpu(vectors.length, { ...neutralAdjustments }, undefined, true, false)
  let neutral: Awaited<ReturnType<typeof createExportGpu>> | undefined,
    active: Awaited<ReturnType<typeof createExportGpu>> | undefined,
    replay: Awaited<ReturnType<typeof createExportGpu>> | undefined
  try {
    neutral = await createExportGpu(vectors.length, settings(0), undefined, true, false)
    expect(neutral.peakBytes).toBe(old.peakBytes)
    expect((await neutral.render(pixels)).data.equals((await old.render(pixels)).data)).toBe(true)
    const p = settings(9),
      wb = [1, 0, 0, 0, 1, 0, 0, 0, 1],
      pending = createExportGpu(vectors.length, p, wb, true, false)
    Object.assign(p.colorMixer.ranges.blue, { hue: 100, saturation: 100, luminance: 100 })
    Object.assign(p.colorGrading.tones.shadows, { hue: 0, saturation: 100, luminance: 100 })
    p.saturation = -100
    wb.fill(50)
    active = await pending
    replay = await createExportGpu(
      vectors.length,
      settings(9),
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      true,
      false,
    )
    expect(active.peakBytes).toBe(old.peakBytes + CREATIVE_COLOR_PARAMETER_BYTES)
    expect((await active.render(pixels)).data.equals((await replay.render(pixels)).data)).toBe(true)
  } finally {
    old.close()
    neutral?.close()
    active?.close()
    replay?.close()
  }
})

test('packed and deferred GPU exports retain identical frozen grading in both renditions', async () => {
  const vectors = reference.gpuVectors.filter(
      (v) => v.primaries === 'rec2020' && v.configuration === 9,
    ),
    pixels = new Float32Array(vectors.flatMap((v, i) => [...v.input, (i % 4) / 3])),
    packed = await createExportGpu(vectors.length, settings(9), undefined, true, true)
  let deferred: Awaited<ReturnType<typeof createExportGpu>> | undefined
  try {
    deferred = await createExportGpu(
      vectors.length,
      settings(9),
      undefined,
      true,
      true,
      64,
      vectors.length,
    )
    expect(deferred.hdrDeferred).toBe(true)
    const normal = await packed.render(pixels),
      sdr = await deferred.render(pixels),
      hdr = await deferred.finishHdr(0, vectors.length)
    for (let i = 0; i < vectors.length; i++) {
      assert.equal(sdr.data.readUInt32LE(i * 4), normal.data.readUInt32LE(i * 12))
      assert.equal(hdr.data.readUInt32LE(i * 12 + 4), normal.data.readUInt32LE(i * 12 + 4))
      assert.equal(hdr.data.readUInt32LE(i * 12 + 8), normal.data.readUInt32LE(i * 12 + 8))
    }
    expect(hdr.headroom).toBe(normal.headroom)
  } finally {
    packed.close()
    deferred?.close()
  }
})
