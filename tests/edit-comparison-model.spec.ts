import { expect, test } from '@playwright/test'
import {
  ComparisonPublication,
  comparisonClips,
  comparisonMemoryPlan,
} from '../src/renderer/src/preview/edit-comparison'
import type { DisplayPreview } from '../src/shared/contracts'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import { boundedHdrMemoryLimits } from '../src/renderer/src/preview/hdr-memory'

test('comparison reservations cannot exceed the subsequently verified adapter policy', () => {
  expect(
    boundedHdrMemoryLimits(
      { revision: 3, ramBytes: 4 * 1024 ** 3, vramBytes: 2 * 1024 ** 3 },
      { revision: 4, ramBytes: 1024 ** 3, vramBytes: 256 * 1024 ** 2 },
    ),
  ).toEqual({
    revision: 4,
    ramBytes: 1024 ** 3,
    vramBytes: 256 * 1024 ** 2,
  })
})

test('split clips address complementary native display columns, including exact A/B endpoints', () => {
  expect(comparisonClips(101, 2, 0.333, 'split')).toEqual({
    boundary: 33.5,
    a: 'inset(0 67.5px 0 0)',
    b: 'inset(0 0 0 33.5px)',
  })
  expect(comparisonClips(101, 2, 0.5, 'a').boundary).toBe(101)
  expect(comparisonClips(101, 2, 0.5, 'b').boundary).toBe(0)
})

test('old source/view completions cannot reveal a half-updated split', () => {
  const publication = new ComparisonPublication()
  publication.request('snapshot-pair:view-1:display-1')
  expect(publication.accept('snapshot-pair:view-1:display-1', 'a')).toBe(false)
  publication.request('snapshot-pair:view-2:display-1')
  expect(publication.accept('snapshot-pair:view-1:display-1', 'b')).toBe(false)
  expect(publication.accept('snapshot-pair:view-2:display-1', 'b')).toBe(false)
  publication.request('snapshot-pair:view-2:display-2')
  expect(publication.accept('snapshot-pair:view-2:display-1', 'a')).toBe(false)
  expect(publication.accept('snapshot-pair:view-2:display-2', 'a')).toBe(false)
  expect(publication.accept('snapshot-pair:view-2:display-2', 'b')).toBe(true)
})

test('pair resource admission reserves both full pipelines and excludes already-owned external memory', () => {
  const frame: DisplayPreview = {
    photoId: 'a'.repeat(64),
    requestId: crypto.randomUUID(),
    format: 'rgba8-srgb',
    width: 1024,
    height: 768,
    byteLength: 1024 * 768 * 4,
    sha256: 'b'.repeat(64),
    url: 'irodori-photo://fixture',
    renderId: 'fixture',
    settingsRevision: 1,
    adjustments: { ...neutralAdjustments },
    linear: {
      url: 'irodori-photo://fixture/linear',
      byteLength: 1024 * 768 * 16,
      sha256: 'c'.repeat(64),
      transform: srgbTransform,
    },
  }
  const policy = resolveResourcePolicy(
    { version: 1, ramMiB: 1024, vramMiB: 1024 },
    {
      ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 },
      gpu: { status: 'unknown', reason: 'unavailable' },
    },
    9,
  )
  const admitted = comparisonMemoryPlan([frame, frame], { width: 600, height: 400 }, 2, policy, {
    ramBytes: 0,
    vramBytes: 0,
  })
  expect(admitted.accepted).toBe(true)
  expect(admitted.reservation.ramBytes).toBe(
    admitted.peaks[0].ramBytes + admitted.peaks[1].ramBytes,
  )
  expect(admitted.limits.ramBytes * 2).toBe(policy.ram.effectiveBytes)
  const refused = comparisonMemoryPlan([frame, frame], { width: 600, height: 400 }, 2, policy, {
    ramBytes: policy.ram.effectiveBytes - admitted.peaks[0].ramBytes,
    vramBytes: policy.vram.effectiveBytes - admitted.peaks[0].vramBytes,
  })
  expect(refused.accepted).toBe(false)
})
