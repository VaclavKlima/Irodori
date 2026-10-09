import { expect, test } from '@playwright/test'
import { HDR_CONTENT, renderHdrContent, renderDisplay } from '../src/shared/display-rendering'
import {
  SDR_TARGET,
  presentHdrContent,
  outputHdr,
  luminance,
  type HdrWorkingAsset,
  type RGB,
} from '../src/shared/hdr'
import { neutralAdjustments } from '../src/shared/adjustments'
import { hdrStatistics, analyzeHdr } from '../src/shared/hdr-statistics'
import { collectHdrSample } from '../src/renderer/src/preview/hdr-sample'
import { HdrEditQueue } from '../src/renderer/src/preview/hdr-edit-queue'
import { HdrRenderCache, hdrCachePlan } from '../src/renderer/src/preview/hdr-render-cache'

const asset = { source: { normalization: { sourceSaturation: null } } } as HdrWorkingAsset
test('fixed Rec.2020 content survives display, gamut, SDR and fallback changes with real unavailable highlights', () => {
  const input = new Float32Array([
    0, 0, 0, 1, 0.18, 0.18, 0.18, 1, 4, 4, 4, 1, 64, 64, 64, 0.5, 1, 0, 0, 1, 1, 1, 1, 0,
  ])
  let previous: ReturnType<typeof hdrStatistics> | undefined
  for (const mode of ['hdr', 'sdr'] as const)
    for (const colorSpace of ['srgb', 'display-p3'] as const)
      for (const headroom of [null, 1, 2, 4, 16]) {
        const target = {
          ...SDR_TARGET,
          mode,
          colorSpace,
          headroom,
          peak: mode === 'hdr' ? (headroom ?? 1) : 1,
        }
        const result = hdrStatistics('content-hdr', target, asset)
        analyzeHdr(input, neutralAdjustments, asset, target, result)
        expect(result.content).toEqual(HDR_CONTENT)
        expect(result.rgbHistogram).toMatchObject({
          mode: 'hdr',
          maxStops: 4,
          colorSpace: 'rec2020',
        })
        expect(result.rgbHistogram!.displayLimitStops).toBe(
          headroom === null ? null : Math.log2(headroom),
        )
        expect(result.visiblePixels).toBe(5)
        if (previous) {
          expect(result.bins).toEqual(previous.bins)
          expect(result.rgbHistogram!.rgb).toEqual(previous.rgbHistogram!.rgb)
        }
        if (headroom === 1 || headroom === 2) expect(result.exceedingHeadroom).toBeGreaterThan(0)
        if (headroom === null) expect(result.exceedingHeadroom).toBeNull()
        previous = result
      }
})
test('reference proof separates luminance headroom, channel clipping and gamut limitation; SDR renders from working', () => {
  const target = { ...SDR_TARGET, mode: 'hdr' as const, headroom: 2, peak: 2 }
  expect(luminance([3, 0, 0])).toBeLessThan(target.headroom)
  expect(presentHdrContent([3, 0, 0], target)).toMatchObject({ clipped: true, gamutLimited: true })
  expect(presentHdrContent([4, 4, 4], target)).toMatchObject({
    rgb: [2, 2, 2],
    clipped: true,
    gamutLimited: false,
  })
  for (const source of [
    [0.18, 0.18, 0.18],
    [16, -0.1, 4],
    [-2, 4, 1],
  ] as RGB[]) {
    expect(outputHdr(source, SDR_TARGET).rgb).toEqual(renderDisplay(source, SDR_TARGET).rgb)
    expect(outputHdr(source, target).rgb).toEqual(
      presentHdrContent(renderHdrContent(source).rgb, target).rgb,
    )
  }
  expect(HDR_CONTENT).toMatchObject({
    nominalPeakNits: 1000,
    referenceWhiteNits: 100,
    relativePeak: 10,
  })
})
test('drafts advance monotonically while input coalesces; cancellation and history retire epochs and obsolete refinements', () => {
  const queue = new HdrEditQueue<number>()
  queue.request(1, true)
  const first = queue.take()!
  for (let i = 2; i <= 40; i++) queue.request(i, true)
  expect(queue.take()).toBeUndefined()
  expect(queue.finish(first)).toBe(true)
  const last = queue.take()!
  expect(last.value).toBe(40)
  expect(queue.finish(last)).toBe(true)
  queue.request(40, false)
  const refine = queue.take()!
  queue.request(41, true)
  expect(queue.superseded(refine)).toBe(true)
  expect(queue.finish(refine)).toBe(false)
  const cancelled = queue.take()!
  queue.invalidate()
  queue.request(39, false)
  expect(queue.finish(cancelled)).toBe(false)
  expect(queue.finish(queue.take()!)).toBe(true)
})
test('canonical content and SDR variants share a bounded cache without retiring content on monitor changes', () => {
  const cache = new HdrRenderCache(16)
  const plan = hdrCachePlan(
    { width: 300, height: 200 },
    { width: 300, height: 200 },
    { width: 300, height: 200 },
    { fit: false, scale: 1, x: 0, y: 0 },
    'after',
    0.5,
  )
  plan.variant = 'content-hdr'
  expect([...cache.batches(plan, true)].reduce((n, b) => n + b.renderedTiles, 0)).toBeGreaterThan(0)
  expect(
    [...cache.batches({ ...plan, variant: 'sdr-srgb' }, true)][0].renderedTiles,
  ).toBeGreaterThan(0)
  expect([...cache.batches(plan, true)][0].renderedTiles).toBe(0)
  cache.setEdits('new edit')
  expect([...cache.batches(plan, true)][0].renderedTiles).toBe(0)
  expect(cache.size).toBeLessThanOrEqual(16)
})

test('draft and refined CPU samples retain the same stable source sites as GPU sampling', () => {
  const width = 257,
    height = 257,
    total = width * height
  const sampler = collectHdrSample({ width, height } as HdrWorkingAsset)
  for (let row = 0; row < height; row += 64) {
    const strip = new Float32Array(Math.min(64, height - row) * width * 4)
    for (let i = 0; i < strip.length; i += 4)
      strip.set([row * width + i / 4, 0, 0, (row * width + i / 4) % 2], i)
    sampler.add(strip, row)
  }
  for (const sample of [sampler.draft, sampler.sample]) {
    const count = sample.length / 4
    expect(count).toBe(sample === sampler.draft ? 8192 : 65536)
    for (let i = 0; i < count; i++) {
      const index = Math.floor(((i + 0.5) * total) / count)
      if (sample[i * 4] !== index || sample[i * 4 + 3] !== index % 2)
        throw new Error(`Stable source/alpha mismatch at ${count} sample ${i}`)
    }
  }
})
