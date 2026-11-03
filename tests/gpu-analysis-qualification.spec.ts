import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { gpuMaskCandidate } from '../scripts/research/analysis/gpu-mask-candidate'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET, type HdrSource } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import { workingAsset } from './export.helpers'

// This explicit research target is an adoption gate, not a product regression.
// Preserve failed receipts and stop the candidate rather than changing predicates.
test('one bounded GPU mask candidate preserves the exact native/JavaScript classifications', async () => {
  const pixels = new Float32Array([
      1,
      1,
      1,
      1,
      1,
      1,
      1 + 2 ** -23,
      1,
      1,
      1,
      1 - 2 ** -24,
      1,
      1,
      1 + 2 ** -23,
      1,
      1,
      1 + 2 ** -23,
      1,
      1,
      1,
      2,
      2,
      2,
      1,
      0,
      0,
      0,
      1,
      0.4,
      0.6,
      1.2,
      0,
    ]),
    asset = workingAsset(Buffer.from(pixels.buffer), 8, 1),
    target = { ...SDR_TARGET, headroom: 1 },
    expected = new Uint8Array(8)
  asset.source = { ...asset.source, display: {} } as HdrSource
  analyzeHdr(
    pixels,
    neutralAdjustments,
    asset,
    target,
    hdrStatistics('content-hdr', target, asset),
    expected,
  )
  const actual = await gpuMaskCandidate(pixels, asset, target),
    mismatches = [...expected.keys()].filter((index) => expected[index] !== actual.mask[index])
  await writeFile(
    test.info().outputPath('qualification.json'),
    JSON.stringify(
      {
        candidate: actual.candidate,
        qualityGate:
          'Every existing classification bit must match exactly; no tolerance or CPU repair.',
        qualified: mismatches.length === 0,
        adapter: actual.adapter,
        elapsedMs: actual.elapsedMs,
        gpuBytes: actual.gpuBytes,
        pixels: Array.from(pixels),
        expected: Array.from(expected),
        actual: Array.from(actual.mask),
        mismatches,
      },
      null,
      2,
    ),
  )
  test.info().annotations.push({ type: 'adapter', description: actual.adapter })
  expect(
    mismatches,
    'A mismatch rejects this bounded candidate; retain the established native mask and its precision gate.',
  ).toEqual([])
})
