import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { jpegReferencePrerequisite, readJpegReferenceSamples } from './jpeg-ycbcr-reference.helpers'
import { referenceBase2020 } from './jpeg-ycbcr-model.helpers'

test('pinned independent JPEG reader preserves raw base planes and numerical gain RGB8', async () => {
  const prerequisite = jpegReferencePrerequisite()
  test.skip(!prerequisite.available, prerequisite.available ? '' : prerequisite.reason)
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 254, g: 253, b: 249 } },
  })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer()
  const before = Buffer.from(jpeg),
    base = readJpegReferenceSamples(jpeg, 'base-ycbcr', prerequisite),
    gain = readJpegReferenceSamples(jpeg, 'gain-rgb', prerequisite),
    ordinary = await sharp(jpeg, { ignoreIcc: true }).removeAlpha().raw().toBuffer()
  expect(base).toMatchObject({
    width: 8,
    height: 8,
    mode: 'base-ycbcr',
    provenance: { version: '3.2.0', sampling: '4:4:4', layout: 'planar-y-cb-cr' },
  })
  expect(base.provenance.librarySha256).toMatch(/^[a-f0-9]{64}$/)
  expect(gain.provenance).toMatchObject({
    ...base.provenance,
    layout: 'interleaved-rgb8',
  })
  expect(gain.pixels).toEqual(ordinary)
  expect(jpeg).toEqual(before)
  expect(referenceBase2020(base, 0, 0)).toEqual(referenceBase2020(base, 7, 7))
  expect(() => referenceBase2020(base, 8, 0)).toThrow('coordinate or mode')
  expect(() => referenceBase2020(gain, 0, 0)).toThrow('coordinate or mode')

  const subsampled = await sharp(jpeg).jpeg({ chromaSubsampling: '4:2:0' }).toBuffer()
  expect(() => readJpegReferenceSamples(subsampled, 'base-ycbcr', prerequisite)).toThrow(
    'three-component 4:4:4 YCbCr JPEG',
  )
  expect(() =>
    readJpegReferenceSamples(Buffer.from([255, 216]), 'base-ycbcr', prerequisite),
  ).toThrow('Independent JPEG reader failed')
})
