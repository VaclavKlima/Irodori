import { expect, test } from '@playwright/test'
import { generatedMask } from './helpers/generated-mask'
import { createPointGpu } from '../src/main/gpu/point-renderer'
import { neutralAdjustments } from '../src/shared/adjustments'
import {
  neutralMaskEdge,
  neutralMaskColor,
  neutralMaskLight,
  type ResolvedMask,
} from '../src/shared/masks'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { referenceCoverage } from './helpers/mask-reference'

test('native point rendering decodes R8 PNG, then evaluates ordered Paint/Erase and inversion without quantization loss', async () => {
  const width = 11,
    height = 9,
    base = generatedMask(width, height, (x, y) => ((x + 2 * y) % 3 === 0 ? 128 : x < 6 ? 255 : 0)),
    local: ResolvedMask = {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Generated',
      head: null,
      enabled: true,
      inverted: false,
      base,
      edge: { ...neutralMaskEdge },
      color: { ...neutralMaskColor },
      light: { ...neutralMaskLight, exposureEv: 1 },
      strokes: [
        { mode: 'subtract', radius: 0.2, feather: 0.7, points: [{ x: 0.4, y: 0.5 }] },
        { mode: 'add', radius: 0.12, feather: 0.5, points: [{ x: 0.8, y: 0.6 }] },
      ],
    },
    input = new Float32Array(width * height * 4)
  for (let i = 0; i < width * height; i++) input.set([0.1, 0.2, 0.3, 1], i * 4)
  for (const inverted of [false, true]) {
    local.inverted = inverted
    const renderer = await createPointGpu(
      width * height,
      {
        ...neutralAdjustments,
        localMasks: [local],
        maskGeometry: identityMaskGeometry(width, height),
      },
      undefined,
      false,
      false,
      64,
      0,
      undefined,
      { domain: 'raster', preserveAlpha: true },
    )
    try {
      const actual = (await renderer.render(input)).data
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          let coverage = ((x + 2 * y) % 3 === 0 ? 128 : x < 6 ? 255 : 0) / 255
          for (const stroke of local.strokes) {
            const brush = referenceCoverage(
              { ...local, base: undefined, inverted: false, strokes: [{ ...stroke, mode: 'add' }] },
              (x + 0.5) / width,
              (y + 0.5) / height,
              width,
              height,
            )
            coverage = stroke.mode === 'add' ? Math.max(coverage, brush) : coverage * (1 - brush)
          }
          if (inverted) coverage = 1 - coverage
          for (let channel = 0; channel < 3; channel++)
            expect(actual.readFloatLE(((y * width + x) * 3 + channel) * 4)).toBeCloseTo(
              [0.1, 0.2, 0.3][channel] * (1 + coverage),
              5,
            )
        }
    } finally {
      await renderer.close()
    }
  }
})
