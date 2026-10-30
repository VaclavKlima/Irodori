import { test, expect } from '@playwright/test'
import { reconstruct, srgbLinear, to2020, type GainMetadata } from './export-reference'
import { referenceBase2020, referenceYcbcrToSrgb } from './jpeg-ycbcr-model.helpers'

test('independent full-range YCbCr conversion retains fractional RGB and clips only gamut bounds', () => {
  const value = referenceYcbcrToSrgb(253, 126, 129)
  expect(value[0]).toBeCloseTo(0.9976549019607843, 14)
  expect(value[1]).toBeCloseTo(0.9920554364164746, 14)
  expect(value[2]).toBeCloseTo(0.9782588235294118, 14)
  expect(value[2]).not.toBe(249 / 255)
  expect(referenceYcbcrToSrgb(0, 128, 128)).toEqual([0, 0, 0])
  expect(referenceYcbcrToSrgb(255, 128, 128)).toEqual([1, 1, 1])
  expect(referenceYcbcrToSrgb(255, 255, 255)).toEqual([1, expect.any(Number), 1])
  expect(referenceYcbcrToSrgb(0, 0, 0)).toEqual([0, expect.any(Number), 0])
})

test('independent base model indexes planar YCbCr and rejects gain codes or invalid coordinates', () => {
  const samples = {
    mode: 'base-ycbcr' as const,
    width: 2,
    height: 1,
    pixels: new Uint8Array([0, 255, 128, 128, 128, 128]),
  }
  expect(referenceBase2020(samples, 0, 0)).toEqual([0, 0, 0])
  for (const value of referenceBase2020(samples, 1, 0)) expect(value).toBeCloseTo(1, 14)
  expect(() => referenceBase2020(samples, 2, 0)).toThrow('coordinate or mode')
  expect(() => referenceBase2020(samples, 0, -1)).toThrow('coordinate or mode')
  expect(() => referenceBase2020(samples, 0.5, 0)).toThrow('coordinate or mode')
  expect(() => referenceBase2020({ ...samples, mode: 'gain-rgb' }, 0, 0)).toThrow(
    'coordinate or mode',
  )
})

test('RGB8 base rounding can falsely fail the unchanged independent ISO codec gate', () => {
  // Original synthetic chart sample retained from the Goal 1 acceptance failure,
  // not a photographic reference or an application algorithm copied into the oracle.
  const metadata: GainMetadata = {
    min: [0.4804903268814087, 0.4228588342666626, 0.39167875051498413],
    max: [2.3083744049072266, 2.268568515777588, 2.2321553230285645],
    gamma: [1, 1, 1],
    sdrOffset: Array(3).fill(1.0000000116883119e-7),
    hdrOffset: Array(3).fill(1.0000000116883119e-7),
    baseHeadroom: 0,
    alternateHeadroom: 2.2243809700012207,
    useBase: false,
  }
  const gain = [227, 231, 234].map((value) => value / 255),
    headroom = 2 ** metadata.alternateHeadroom,
    independent = reconstruct(
      to2020(referenceYcbcrToSrgb(253, 126, 129).map(srgbLinear)),
      gain,
      metadata,
      headroom,
    ),
    rounded = reconstruct(
      to2020([254, 253, 249].map((value) => srgbLinear(value / 255))),
      gain,
      metadata,
      headroom,
    ),
    retainedBlue = 4.04296875
  expect(independent[2]).toBeCloseTo(4.038067246396505, 12)
  expect(rounded[2]).toBeCloseTo(4.022955113477337, 12)
  expect(Math.abs(retainedBlue - independent[2])).toBeLessThan(0.02)
  expect(Math.abs(retainedBlue - rounded[2])).toBeGreaterThanOrEqual(0.02)
})
