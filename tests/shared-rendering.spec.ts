import { expect, test } from '@playwright/test'
import { halfFloat } from '../src/main/export/codec'
import { createExportGpu } from '../src/main/export/gpu'
import {
  neutralAdjustments,
  renderAdjustments,
  srgbTransform,
  type AdjustmentParameters,
} from '../src/shared/adjustments'
import type { PointRenderOptions } from '../src/shared/authored-output-wgsl'
import { neutralColorGrading } from '../src/shared/color-grading'
import { neutralColorMixer } from '../src/shared/color-mixer'
import { adjustHdr, outputHdr, SDR_TARGET, type HdrSource } from '../src/shared/hdr'
import { fromHalf } from './export-reference'
import { rasterLinear } from './raster-reference'

const source = new Float32Array([
  0, 0, 0, 1, 0.18, 0.18, 0.18, 1, 0.2, 0.04, 0.8, 0.5, -0.03, 0.5, 2, 0, 1, 2, 4, 1, 0.001, 0.0002,
  0.01, 0.3,
])
const primary = new Float32Array([
  0.8, 0.1, 0.05, 1, 0.02, 0.04, 0.08, 1, 0.7, 0.3, 0.1, 1, 0.1, 0.8, 0.4, 1, 0.5, 0.2, 0.1, 1,
  0.01, 0.02, 0.03, 1,
])
const settings: AdjustmentParameters[] = [
  { ...neutralAdjustments },
  {
    ...neutralAdjustments,
    exposureEv: 0.3,
    contrast: 35,
    highlights: -45,
    shadows: 25,
    whites: 15,
    blacks: -10,
    saturation: 30,
    vibrance: 45,
    colorMixer: {
      ...structuredClone(neutralColorMixer),
      ranges: {
        ...structuredClone(neutralColorMixer.ranges),
        red: { hue: 10, saturation: 15, luminance: -10 },
      },
    },
    colorGrading: structuredClone(neutralColorGrading),
  },
]
const encode = (v: number) =>
  Math.round(
    Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) * 255,
  )
for (const domain of ['raster', 'authored-hdr'] as const)
  for (const packed of [false, true])
    for (const [index, a] of settings.entries()) {
      test(`shared ${domain} ${packed ? 'packed' : 'linear'} output ${index} preserves the independent authored rendition`, async () => {
        const hdr = domain === 'authored-hdr',
          options: PointRenderOptions = { domain, primary: hdr },
          before = Array.from(source),
          owner = await createExportGpu(
            source.length / 4,
            a,
            undefined,
            hdr,
            packed,
            64,
            0,
            undefined,
            options,
          )
        test.info().annotations.push({ type: 'adapter', description: owner.adapter })
        try {
          const rendered = await owner.render(source, 0, hdr ? primary : undefined),
            words = new Uint32Array(
              rendered.data.buffer,
              rendered.data.byteOffset,
              rendered.data.byteLength / 4,
            ),
            floats = new Float32Array(
              rendered.data.buffer,
              rendered.data.byteOffset,
              rendered.data.byteLength / 4,
            )
          for (let i = 0; i < source.length / 4; i++) {
            const at = i * 4,
              alpha = source[at + 3],
              sdrInput = (hdr ? primary : source).subarray(at, at + 3),
              sdr = rasterLinear([...sdrInput], a).map((v) => v * alpha + 1 - alpha),
              content = hdr
                ? adjustHdr([source[at], source[at + 1], source[at + 2]], a).map((v) =>
                    Math.min(10, Math.max(0, v) * alpha + 1 - alpha),
                  )
                : undefined
            for (let c = 0; c < 3; c++) {
              if (packed) {
                expect(
                  Math.abs(((words[i * (hdr ? 3 : 1)] >>> (c * 8)) & 255) - encode(sdr[c])),
                ).toBeLessThanOrEqual(1)
                if (content) {
                  const actual = fromHalf(
                    c === 2 ? words[i * 3 + 2] & 65535 : (words[i * 3 + 1] >>> (c * 16)) & 65535,
                  )
                  expect(Math.abs(actual - fromHalf(halfFloat(content[c])))).toBeLessThanOrEqual(
                    0.004,
                  )
                }
              } else {
                expect(Math.abs(floats[i * (hdr ? 6 : 3) + c] - sdr[c])).toBeLessThanOrEqual(
                  2e-6 + 2e-5 * Math.abs(sdr[c]),
                )
                if (content)
                  expect(Math.abs(floats[i * 6 + 3 + c] - content[c])).toBeLessThanOrEqual(
                    2e-6 + 2e-5 * Math.abs(content[c]),
                  )
              }
            }
          }
          expect(Array.from(source)).toEqual(before)
          expect(owner.hdrDeferred).toBe(false)
        } finally {
          await owner.close()
        }
        await expect(owner.render(source, 0, hdr ? primary : undefined)).rejects.toThrow('closed')
      })
    }

test('shared raster proofs preserve alpha and transform semantics independently of export flattening', async () => {
  const a = settings[1],
    transform = { ...srgbTransform, white: 0.83 },
    expected = renderAdjustments(source, a, transform),
    owner = await createExportGpu(source.length / 4, a, undefined, false, true, 64, 0, undefined, {
      domain: 'raster',
      preserveAlpha: true,
      transform,
    })
  try {
    const actual = (await owner.render(source)).data
    for (let i = 0; i < expected.length; i++)
      expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(i % 4 === 3 ? 0 : 1)
  } finally {
    await owner.close()
  }
})

test('authored HDR proofs use primary conversion without scene tone rendering and reject unencodable HDR', async () => {
  const a = settings[0],
    owner = await createExportGpu(source.length / 4, a, undefined, false, true, 64, 0, undefined, {
      domain: 'authored-hdr',
      preserveAlpha: true,
    })
  try {
    const actual = (await owner.render(source)).data
    for (let i = 0; i < source.length / 4; i++) {
      const at = i * 4,
        rgb = outputHdr([source[at], source[at + 1], source[at + 2]], SDR_TARGET, {
          display: {},
        } as HdrSource).rgb
      for (let c = 0; c < 3; c++)
        expect(Math.abs(actual[at + c] - encode(rgb[c]))).toBeLessThanOrEqual(1)
      expect(actual[at + 3]).toBe(Math.round(source[at + 3] * 255))
    }
  } finally {
    await owner.close()
  }
  const hdr = await createExportGpu(1, a, undefined, true, true, 64, 0, undefined, {
    domain: 'authored-hdr',
    primary: true,
  })
  try {
    await expect(
      hdr.render(new Float32Array([NaN, 1, 1, 1]), 0, new Float32Array([0.5, 0.5, 0.5, 1])),
    ).rejects.toThrow('Invalid GPU output')
    await expect(hdr.render(new Float32Array([1, 1, 1, 1]))).rejects.toThrow('primary')
  } finally {
    await hdr.close()
  }
})
