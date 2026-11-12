import { expect, test } from '@playwright/test'
import { clippingOverlayPixels } from '../src/renderer/src/preview/clipping-overlay'
import { reduceHdrMask } from '../src/shared/hdr-statistics'

function painted(value: ReturnType<typeof clippingOverlayPixels>) {
  if (!value) return []
  return Array.from({ length: value.width * value.height }, (_, pixel) => ({
    x: value.left + (pixel % value.width),
    y: value.top + Math.floor(pixel / value.width),
    rgba: Array.from(value.data.subarray(pixel * 4, pixel * 4 + 4)),
  })).filter((pixel) => pixel.rgba[3])
}

test('native overlay preserves exact SDR endpoints and HDR warning selection', () => {
  const common = {
    levels: [{ width: 2, height: 2, data: new Uint8Array([2, 0, 0, 1]) }],
    image: { width: 2, height: 2 },
    viewport: { width: 4, height: 4 },
    view: { scale: 1, x: 0, y: 0 },
    highlights: true,
    shadows: true,
    hdrOverlay: 1,
  }
  expect(painted(clippingOverlayPixels({ ...common, hdr: false }))).toEqual([
    { x: 1, y: 1, rgba: [255, 0, 0, 180] },
    { x: 2, y: 2, rgba: [0, 0, 255, 180] },
  ])
  expect(painted(clippingOverlayPixels({ ...common, hdr: true }))).toEqual([
    { x: 2, y: 2, rgba: [255, 160, 0, 140] },
  ])
})

test('fractional Fit projection has fixed CSS pixel centres and keeps isolated OR events', () => {
  const source = new Uint8Array(8 * 4)
  source[0] = 2
  source[3 * 8 + 5] = 1
  const input = {
    ...reduceHdrMask(source, 8, 4),
    image: { width: 8, height: 4 },
    viewport: { width: 6, height: 5 },
    view: { scale: 0.5, x: 0, y: 0 },
    hdr: false,
    hdrOverlay: 0,
    highlights: true,
    shadows: true,
  }
  const expected = [
    { x: 1, y: 1, rgba: [255, 0, 0, 180] },
    { x: 3, y: 2, rgba: [0, 0, 255, 180] },
  ]
  expect(painted(clippingOverlayPixels(input))).toEqual(expected)
  expect(painted(clippingOverlayPixels(input))).toEqual(expected)
})

test('odd source dimensions choose an OR level that cannot lose the last clipped pixel at Fit', () => {
  const source = new Uint8Array(5 * 3)
  source[source.length - 1] = 2
  expect(
    painted(
      clippingOverlayPixels({
        ...reduceHdrMask(source, 5, 3),
        image: { width: 5, height: 3 },
        viewport: { width: 3, height: 2 },
        view: { scale: 0.6, x: 0, y: 0 },
        hdr: false,
        hdrOverlay: 0,
        highlights: true,
        shadows: true,
      }),
    ),
  ).toEqual([
    { x: 1, y: 0, rgba: [255, 0, 0, 180] },
    { x: 2, y: 0, rgba: [255, 0, 0, 180] },
    { x: 1, y: 1, rgba: [255, 0, 0, 180] },
    { x: 2, y: 1, rgba: [255, 0, 0, 180] },
  ])
})

test('split and panned overlays select only their visible native pixels', () => {
  const input = {
    levels: [{ width: 4, height: 2, data: new Uint8Array([2, 2, 2, 2, 0, 0, 0, 0]) }],
    image: { width: 4, height: 2 },
    viewport: { width: 4, height: 2 },
    view: { scale: 1, x: 0, y: 0 },
    hdr: false,
    hdrOverlay: 0,
    highlights: true,
    shadows: true,
  }
  expect(painted(clippingOverlayPixels({ ...input, split: 0.5 }))).toEqual([
    { x: 2, y: 0, rgba: [255, 0, 0, 180] },
    { x: 3, y: 0, rgba: [255, 0, 0, 180] },
  ])
  expect(painted(clippingOverlayPixels({ ...input, view: { scale: 1, x: -2, y: 0 } }))).toEqual([
    { x: 0, y: 0, rgba: [255, 0, 0, 180] },
    { x: 1, y: 0, rgba: [255, 0, 0, 180] },
  ])
})
