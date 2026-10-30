import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { rasterLinear } from '../src/main/export/raster'
import { createExportGpu } from '../src/main/export/gpu'
import { neutralAdjustments } from '../src/shared/adjustments'
import { buildAcesReference, referenceAces } from './aces-reference'
import reference from './fixtures/color-intensity-reference.json' with { type: 'json' }

test('authored raster export applies color in linear sRGB before its output clamp', () => {
  const vectors = reference.vectors.filter(
    (v) => v.primaries === 'srgb' && v.input.every((c) => c >= 0 && c <= 1),
  )
  expect(vectors.length).toBeGreaterThan(100)
  for (const vector of vectors) {
    const result = rasterLinear(vector.input, {
      ...neutralAdjustments,
      saturation: vector.saturation,
      vibrance: vector.vibrance,
    })
    for (let c = 0; c < 3; c++)
      expect(Math.abs(result[c] - Math.max(0, Math.min(1, vector.output[c])))).toBeLessThanOrEqual(
        2e-12 + 2e-11 * Math.abs(vector.output[c]),
      )
  }
})

test('GPU export composes independent Decimal80 color with independent CTL HDR and SDR renditions', async () => {
  const directory = test.info().outputPath('ctl')
  await mkdir(directory)
  const binary = buildAcesReference(directory)
  for (const [saturation, vibrance] of [
    [-100, 100],
    [0, 100],
    [100, 100],
    [50, -100],
  ]) {
    const vectors = reference.vectors.filter(
      (v) => v.primaries === 'rec2020' && v.saturation === saturation && v.vibrance === vibrance,
    )
    expect(vectors.length).toBeGreaterThan(50)
    const gpu = await createExportGpu(
      vectors.length,
      { ...neutralAdjustments, saturation, vibrance },
      undefined,
      true,
      false,
    )
    try {
      const result = await gpu.render(new Float32Array(vectors.flatMap((v) => [...v.input, 1])))
      const actual = new Float32Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength / 4,
      )
      for (const [offset, peak, primaries] of [
        [0, 1, 'srgb'],
        [3, 10, 'rec2020'],
      ] as const) {
        const expected = referenceAces(
          binary,
          vectors.map((v) => v.output),
          peak,
          primaries,
        )
        let maximumRatio = 0,
          worst: unknown
        for (let i = 0; i < vectors.length; i++)
          for (let c = 0; c < 3; c++) {
            const value = actual[i * 6 + offset + c]
            expect(Number.isFinite(value)).toBe(true)
            const wanted = Math.max(0, Math.min(peak, expected[i][c]))
            const ratio = Math.abs(value - wanted) / (2e-6 + 2e-5 * Math.abs(wanted))
            if (ratio > maximumRatio) {
              maximumRatio = ratio
              worst = { vector: vectors[i], c, value, wanted }
            }
          }
        expect(maximumRatio, JSON.stringify({ peak, worst })).toBeLessThanOrEqual(1)
      }
    } finally {
      gpu.close()
    }
  }
})
