import { expect, test } from '@playwright/test'
import { initialSettings, mergeEditPatch } from '../src/shared/edits'
import {
  copiedEdits,
  defaultEditTransferGroups,
  transferPatch,
  transferredSettings,
  transferUnavailable,
  validateTransferGroups,
  type EditTransferGroup,
} from '../src/shared/edit-transfer'
import { processingMetadata } from '../src/main/processing/metadata'
import { profile } from './white-balance-picker.helpers'

const info = {
  id: 'copy',
  photoId: 'a'.repeat(64),
  filename: 'Source.png',
  revision: 4,
  copiedAt: '2026-10-29T00:00:00Z',
}

test('default transfer replaces complete color/detail groups while preserving destination geometry, camera state and processing', () => {
  const source = mergeEditPatch(initialSettings(), {
    exposureEv: 1.5,
    saturation: 30,
    colorMixer: { ranges: { red: { hue: 25 } } },
    noiseReduction: { luminance: 40 },
    detailSharpening: { amount: 25 },
  })
  const copied = copiedEdits(info, source, processingMetadata({}, [])),
    destination = initialSettings()
  destination.processing = 'hdr-v1'
  destination.crop = { ...destination.crop, quarterTurns: 1 }
  destination.whiteBalance = { mode: 'custom', kelvin: 5000, tint: 15 }
  destination.lens = { distortion: false, vignetting: false, chromaticAberration: false }
  const result = transferredSettings(destination, copied, defaultEditTransferGroups)
  expect(result).toMatchObject({
    exposureEv: 1.5,
    saturation: 30,
    noiseReduction: source.noiseReduction,
    detailSharpening: source.detailSharpening,
    colorMixer: source.colorMixer,
    crop: destination.crop,
    whiteBalance: destination.whiteBalance,
    lens: destination.lens,
    processing: 'hdr-v1',
    version: 11,
  })
  source.exposureEv = 3
  expect(copied.settings.exposureEv).toBe(1.5)
  expect(Object.keys(transferPatch(copied, defaultEditTransferGroups))).not.toContain('processing')
  const reset = transferredSettings(
    result,
    copiedEdits(info, initialSettings(), processingMetadata({}, [])),
    ['mixer', 'noise'],
  )
  expect(reset.colorMixer).toEqual(initialSettings().colorMixer)
  expect(reset.noiseReduction).toEqual(initialSettings().noiseReduction)
  expect(reset.exposureEv).toBe(1.5)
})

test('camera-dependent transfer copies choices only and requires compatible verified providers', () => {
  const metadata = structuredClone(processingMetadata({}, []))
  metadata.whiteBalance = profile
  metadata.lensProfile.distortion = { radii: [0, 1], values: [1, 1.1] }
  const source = copiedEdits(info, initialSettings(), metadata)
  expect(source.clipboard.groups).toContain('white-balance')
  expect(transferPatch(source, ['lens'])).toEqual({ lens: { distortion: true } })
  expect(transferUnavailable(source, ['white-balance', 'lens'], metadata)).toBeUndefined()
  expect(transferUnavailable(source, ['white-balance'], processingMetadata({}, []))).toContain(
    'compatible verified',
  )
  expect(
    transferUnavailable(source, ['white-balance'], {
      ...metadata,
      whiteBalance: { ...profile, identity: 'other-camera' },
    }),
  ).toContain('compatible verified')
  expect(transferUnavailable(source, ['lens'], processingMetadata({}, []))).toContain('unavailable')
  expect(
    transferUnavailable(source, defaultEditTransferGroups, processingMetadata({}, [])),
  ).toBeUndefined()
})

test('transfer rejects empty, repeated, unknown, unavailable and future-version groups without silently dropping them', () => {
  const source = copiedEdits(info, initialSettings(), processingMetadata({}, []))
  for (const groups of [[], ['light', 'light'], ['future']])
    expect(() => validateTransferGroups(groups)).toThrow()
  expect(() => transferPatch(source, ['white-balance'])).toThrow('unavailable')
  expect(() =>
    transferPatch({ ...source, version: 2 } as unknown as typeof source, ['light']),
  ).toThrow()
  expect(() => transferPatch(source, ['unknown'] as unknown as EditTransferGroup[])).toThrow()
})
