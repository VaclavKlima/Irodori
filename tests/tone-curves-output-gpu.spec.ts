import { test, expect } from '@playwright/test'
import { createPointGpu } from '../src/main/gpu/point-renderer'
import { neutralAdjustments } from '../src/shared/adjustments'
import { curveChannels, type ToneCurves } from '../src/shared/tone-curves'
import reference from './fixtures/tone-curve-reference.json' with { type: 'json' }
import { workingToXyz, xyzToWorking } from '../src/shared/color-model'

test('production raster and authored HDR point passes apply the independent Master/RGB reference before output mapping', async () => {
  for (const domain of ['raster', 'authored-hdr'] as const) {
    const primaries = domain === 'raster' ? 'srgb' : 'rec2020'
    for (const setting of [0, 5, 15]) {
      const names = reference.settings[setting],
        curves = {
          version: 1,
          ...Object.fromEntries(
            curveChannels.map((channel, i) => [
              channel,
              reference.curves.find((curve) => curve.name === names[i])!.points,
            ]),
          ),
        } as ToneCurves
      const vectors = reference.colorVectors
        .filter(
          (v) =>
            v.settings === setting && v.primaries === primaries && v.input.every((c) => c >= 0),
        )
        .slice(0, 32)
      expect(vectors.length).toBeGreaterThan(4)
      const gpu = await createPointGpu(
        vectors.length,
        { ...neutralAdjustments, curves },
        undefined,
        false,
        false,
        64,
        0,
        undefined,
        { domain, preserveAlpha: true },
      )
      try {
        test.info().annotations.push({ type: 'gpu-adapter', description: gpu.adapter })
        const output = await gpu.render(new Float32Array(vectors.flatMap((v) => [...v.input, 1]))),
          actual = new Float32Array(
            output.data.buffer,
            output.data.byteOffset,
            output.data.byteLength / 4,
          )
        let ratio = 0,
          worst: unknown
        vectors.forEach((v, i) => {
          const converted =
            domain === 'raster'
              ? v.output
              : xyzToWorking(
                  workingToXyz(
                    v.output.map((value) => Math.max(0, value)) as [number, number, number],
                    'rec2020',
                  ),
                  'srgb',
                )
          converted.forEach((value, c) => {
            const expected = Math.max(0, Math.min(1, value)),
              error = Math.abs(actual[i * 3 + c] - expected) / (2e-6 + 2e-5 * Math.abs(expected))
            expect(Number.isFinite(actual[i * 3 + c])).toBe(true)
            if (error > ratio) {
              ratio = error
              worst = { domain, setting, v, c, expected, actual: actual[i * 3 + c] }
            }
          })
        })
        expect(ratio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
      } finally {
        await gpu.close()
      }
    }
  }
})
