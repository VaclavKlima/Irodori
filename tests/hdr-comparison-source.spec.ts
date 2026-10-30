import { expect, test } from '@playwright/test'
import { srgbTransform, type WorkingFrame } from '../src/shared/adjustments'
import { HDR_SOURCE_VERSION } from '../src/shared/hdr'
import { checkedHdrComparison } from '../src/renderer/src/preview/hdr-comparison-source'

function frame(hash: string): WorkingFrame {
  return {
    width: 8,
    height: 6,
    identity: `isolated-${hash}`,
    data: new Float32Array(0),
    transform: { ...srgbTransform },
    hdr: {
      kind: 'hdr-working-v1',
      width: 8,
      height: 6,
      byteLength: 8 * 6 * 16,
      url: `blob:isolated-${hash}`,
      sha256: hash.repeat(64),
      strips: [{ byteLength: 8 * 6 * 16, sha256: hash.repeat(64) }],
      source: {
        version: HDR_SOURCE_VERSION,
        processing: 'hdr-v1',
        colorSpace: 'rec2020',
        whitePoint: 'D65',
        transfer: 'linear',
        alpha: 'straight',
        decoder: 'isolated',
        orientation: 'applied-once',
        cameraProfile: 'isolated',
        normalization: {
          black: [0, 0, 0, 0],
          maximum: 1,
          gains: [1, 1, 1, 1],
          restoreGain: 1,
          referenceWhite: 1,
          sourceSaturation: null,
        },
      },
    },
  }
}
test('HDR comparison capabilities detach metadata and exact pixel aliases reuse the ordinary source', () => {
  const after = frame('a'),
    before = frame('b'),
    accepted = checkedHdrComparison(after, before)!
  expect(accepted.frame).not.toBe(before)
  expect(accepted.frame.hdr).not.toBe(before.hdr)
  expect(accepted.identity.sha256).toBe(before.hdr!.sha256)
  before.hdr!.strips[0].sha256 = 'c'.repeat(64)
  before.hdr!.url = 'blob:changed'
  expect(accepted.frame.hdr!.strips[0].sha256).toBe('b'.repeat(64))
  expect(accepted.frame.hdr!.url).toBe('blob:isolated-b')
  expect(checkedHdrComparison(after, after)).toBeUndefined()
  expect(
    checkedHdrComparison(after, { ...frame('a'), identity: 'different-owner-same-pixels' }),
  ).toBeUndefined()
})
test('HDR comparison rejects malformed bytes, geometry and rendering domains before adoption', () => {
  const after = frame('a')
  const cases: ((before: WorkingFrame) => void)[] = [
    (v) => {
      v.hdr = undefined
    },
    (v) => v.width--,
    (v) => v.height--,
    (v) => v.hdr!.width--,
    (v) => v.hdr!.byteLength--,
    (v) => v.hdr!.strips.pop(),
    (v) => {
      v.hdr!.sha256 = 'invalid'
    },
    (v) => {
      v.transform.white = 2
    },
    (v) => {
      v.hdr!.source.normalization.referenceWhite = 2
    },
    (v) => {
      v.hdr!.source.decoder = 'different-source-domain'
    },
  ]
  for (const change of cases) {
    const before = frame('b')
    change(before)
    expect(() => checkedHdrComparison(after, before)).toThrow()
  }
})
