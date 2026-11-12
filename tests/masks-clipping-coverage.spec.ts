import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { neutralAdjustments } from '../src/shared/adjustments'
import { clippingCoverageMasks, clippingCoverageMemory } from '../src/shared/clipping-coverage'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { croppedMaskGeometry } from '../src/shared/mask-geometry'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import { neutralMaskLight } from '../src/shared/masks'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { sampleClippingCoverage } from '../src/main/clipping-coverage/gpu'
import { ClippingCoverageProcess } from '../src/main/clipping-coverage/process'
import { compoundLeaf, compoundOperand, compoundOracle } from './helpers/mask-compound'
import { referenceMaskEdges } from './helpers/mask-edge-reference'
import { generatedMask } from './helpers/generated-mask'

test('clipping Float32 strips preserve compound coverage, root order and exact disabled/neutral filtering', async () => {
  const owner = new RawGpuRenderer()
  const { device, adapter } = await owner.mergeDevice()
  test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
  const width = 200,
    height = 100
  const lower = {
    ...compoundLeaf(0.15),
    id: '00000000-0000-0000-0000-000000000002',
    inverted: true,
  }
  const upper = {
    ...compoundLeaf(-0.2),
    operands: [
      compoundOperand(compoundLeaf(0.3), 'subtract'),
      compoundOperand(compoundLeaf(0.1), 'intersect'),
    ],
  }
  const parameters = {
    ...neutralAdjustments,
    maskGeometry: identityMaskGeometry(width, height),
    localMasks: [
      upper,
      { ...compoundLeaf(0.2), enabled: false },
      lower,
      { ...compoundLeaf(0.4), light: neutralMaskLight },
    ],
  }
  expect(clippingCoverageMasks(parameters)).toEqual([upper, lower])
  const strips: Float32Array[] = []
  try {
    const count = await sampleClippingCoverage(
      device,
      parameters,
      width,
      height,
      new AbortController().signal,
      async (bytes) => {
        strips.push(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice())
      },
    )
    expect(count).toBe(2)
    expect(strips.map((strip) => strip.length)).toEqual([width * 64 * 2, width * 36 * 2])
    const sampled = new Float32Array(width * height * 2)
    strips.forEach((strip, index) => sampled.set(strip, index * width * 64 * 2))
    let worst = 0,
      unquantized = 0
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (const [index, mask] of [upper, lower].entries()) {
          const expected = compoundOracle(mask, (x + 0.5) / width, (y + 0.5) / height)
          const actual = sampled[(y * width + x) * 2 + index]
          worst = Math.max(worst, Math.abs(actual - expected) / (2e-6 + 2e-5 * Math.abs(expected)))
          if (Math.abs(actual * 255 - Math.round(actual * 255)) > 1e-3) unquantized++
        }
    expect(worst).toBeLessThanOrEqual(1)
    expect(unquantized).toBeGreaterThan(100)
    const abort = new AbortController()
    await expect(
      sampleClippingCoverage(device, parameters, width, height, abort.signal, async () =>
        abort.abort(new Error('cancelled after first strip')),
      ),
    ).rejects.toThrow('cancelled after first strip')
    let laterStrips = 0
    await sampleClippingCoverage(
      device,
      parameters,
      width,
      height,
      new AbortController().signal,
      async () => {
        laterStrips++
      },
    )
    expect(laterStrips).toBe(2)
    const crop = cropGeometry(
      { width, height },
      { ...identityCrop, centerX: 0.4, centerY: 0.45, width: 0.6, height: 0.5, quarterTurns: 1 },
    )
    const cropped = {
      ...parameters,
      maskGeometry: croppedMaskGeometry(parameters.maskGeometry, crop),
    }
    expect(() => clippingCoverageMemory(width, height, cropped)).toThrow(
      'authoritative working source grid',
    )
    const cropSamples: number[] = []
    await sampleClippingCoverage(
      device,
      cropped,
      crop.width,
      crop.height,
      new AbortController().signal,
      async (bytes) => {
        cropSamples.push(...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
      },
    )
    let cropWorst = 0
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++)
        for (const [index, mask] of [upper, lower].entries()) {
          const m = crop.outputToSource
          const u = (m[0] * (x + 0.5) + m[1] * (y + 0.5) + m[4]) / width
          const v = (m[2] * (x + 0.5) + m[3] * (y + 0.5) + m[5]) / height
          const expected = compoundOracle(mask, u, v)
          cropWorst = Math.max(
            cropWorst,
            Math.abs(cropSamples[(y * crop.width + x) * 2 + index] - expected) /
              (2e-6 + 2e-5 * Math.abs(expected)),
          )
        }
    expect(cropWorst).toBeLessThanOrEqual(1)
    expect(owner.failure).toBeUndefined()
  } finally {
    owner.close()
  }
})

test('isolated coverage worker binds complete edge coverage and every streamed strip to immutable hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-clipping-coverage-'))
  const worker = new ClippingCoverageProcess({
    workerPath: resolve('out/main/clipping-coverage-worker.js'),
  })
  const width = 35,
    height = 137
  const mask = { ...compoundLeaf(0.1), edge: { featherPx: 2.5, shiftPx: -1 } }
  const parameters = {
    ...neutralAdjustments,
    localMasks: [mask],
    maskGeometry: identityMaskGeometry(width, height),
  }
  try {
    const memory = clippingCoverageMemory(width, height, parameters)
    expect(memory.maskCount).toBe(1)
    expect(memory.stripBytes).toBe(width * 64 * 4)
    expect(memory.byteLength).toBe(width * height * 4)
    const rendered = {
      ...parameters,
      localMasks: [
        {
          ...mask,
          preparedCoverage: { ...generatedMask(width, height, () => 128), key: 'a'.repeat(64) },
        },
      ],
    }
    expect(clippingCoverageMemory(width, height, rendered)).toEqual(memory)
    const result = await worker.prepare(
      parameters,
      width,
      height,
      'source-revision-target-test',
      join(directory, 'coverage.f32'),
      new AbortController().signal,
    )
    await worker.close()
    const bytes = await readFile(result.path)
    expect(result.byteLength).toBe(memory.byteLength)
    expect(result.maskCount).toBe(1)
    expect(result.key).toBe('source-revision-target-test')
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const expected = referenceMaskEdges(mask, width, height)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let worst = 0
    for (let i = 0; i < expected.length; i++)
      worst = Math.max(worst, Math.abs(view.getFloat32(i * 4, true) - expected[i] / 255))
    expect(worst).toBeLessThanOrEqual(1 / 255 + 2e-6)
    expect(result.stripSha256).toHaveLength(3)
    result.stripSha256.forEach((hash, index) => {
      expect(hash).toBe(
        createHash('sha256')
          .update(
            bytes.subarray(
              index * width * 64 * 4,
              Math.min(bytes.byteLength, (index + 1) * width * 64 * 4),
            ),
          )
          .digest('hex'),
      )
    })
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancel before worker allocation'))
    await expect(
      worker.prepare(
        parameters,
        width,
        height,
        'cancelled',
        join(directory, 'cancelled.f32'),
        cancelled.signal,
      ),
    ).rejects.toThrow('cancel before worker allocation')
  } finally {
    await worker.close()
    await rm(directory, { force: true, recursive: true })
  }
})
