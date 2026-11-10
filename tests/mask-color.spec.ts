import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import reference from '../assets/tests/references/mask-color/reference.json' with { type: 'json' }
import { maskColorBalanceMatrices, maskColorWhite } from '../src/shared/mask-color'
import {
  hasLocalMasks,
  localMaskAllocationBytes,
  localMaskPixelData,
  MASK_DESCRIPTOR_VEC4S,
  packLocalMasks,
} from '../src/shared/masks-gpu'
import { maskEdgePixelIdentity } from '../src/shared/mask-edges'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { neutralMaskColor } from '../src/shared/masks'
import { maskColorReferenceMasks } from './helpers/mask-color'

test('relative D65 balance agrees with independent primary-derived Decimal80 Bradford matrices', async () => {
  expect(reference.precision).toBe(80)
  expect(reference.matrices).toHaveLength(50)
  expect(reference.vectors).toHaveLength(351)
  for (const [file, hash] of Object.entries(reference.sources))
    expect(
      createHash('sha256')
        .update(await readFile(`scripts/research/${file}`))
        .digest('hex'),
    ).toBe(hash)
  for (const vector of reference.matrices) {
    const actual = maskColorBalanceMatrices(vector.color),
      white = maskColorWhite(vector.color)
    if (!vector.matrix) {
      expect(actual).toBeNull()
      expect(white).toBeNull()
      continue
    }
    const primaries = vector.primaries as 'srgb' | 'rec2020'
    for (const [index, value] of vector.matrix.entries())
      expect(
        Math.abs(actual![primaries][index] - value),
        JSON.stringify(vector),
      ).toBeLessThanOrEqual(2e-12 + 2e-11 * Math.abs(value))
    vector.white!.forEach((value, index) =>
      expect(Math.abs(white![index] - value)).toBeLessThanOrEqual(2e-12 + 2e-11 * Math.abs(value)),
    )
  }
})

test('color-only masks activate packing and pixel identities while coverage is reused across color amounts', () => {
  const [mask] = maskColorReferenceMasks('warm'),
    parameters = { localMasks: [mask], maskGeometry: identityMaskGeometry(1, 1) },
    image = { width: 1, height: 1 }
  expect(hasLocalMasks(parameters)).toBe(true)
  expect(MASK_DESCRIPTOR_VEC4S).toBe(9)
  const packed = packLocalMasks(parameters, image),
    matrices = maskColorBalanceMatrices(mask.color)!,
    pixels = structuredClone(localMaskPixelData(parameters)),
    coverage = maskEdgePixelIdentity(mask)
  expect(localMaskAllocationBytes(parameters, image)).toBe(packed.byteLength)
  expect(packed[34]).toBe(0)
  expect(packed[35]).toBe(1)
  for (const [ordinal, primaries] of (['srgb', 'rec2020'] as const).entries())
    for (let row = 0; row < 3; row++)
      for (let channel = 0; channel < 3; channel++)
        expect(packed[36 + ordinal * 12 + row * 4 + channel]).toBe(
          Math.fround(matrices[primaries][row * 3 + channel]),
        )
  mask.color.tint = 15
  mask.color.saturation = 27
  expect(localMaskPixelData(parameters)).not.toEqual(pixels)
  expect(maskEdgePixelIdentity(mask)).toBe(coverage)
  mask.edge = { featherPx: 2, shiftPx: 1 }
  expect(() => packLocalMasks(parameters, image)).toThrow(/coverage is not ready/)
  expect(localMaskAllocationBytes(parameters, image)).toBeGreaterThan(packed.byteLength)
  mask.edge = { featherPx: 0, shiftPx: 0 }
  mask.color = { ...neutralMaskColor }
  expect(hasLocalMasks(parameters)).toBe(false)
  expect(localMaskPixelData(parameters)).toEqual([])
  const neutral = packLocalMasks(parameters, image)
  expect(neutral[34]).toBe(0)
  expect(neutral[35]).toBe(0)
  expect(maskColorBalanceMatrices({ ...neutralMaskColor, saturation: 100 })).toBeNull()
})
