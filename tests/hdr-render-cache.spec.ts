import { expect, test } from '@playwright/test'
import { hdrCachePlan, HdrRenderCache } from '../src/renderer/src/preview/hdr-render-cache'
import { hdrShader } from '../src/renderer/src/preview/hdr-shader'

const frame = { width: 4096, height: 3072 },
  viewport = { width: 1100, height: 700 }
const view = { fit: false, scale: 1, x: 0, y: 0 }
test('nearby pan and zoom reuse rendered texels without evaluating ACES in presentation', () => {
  const cache = new HdrRenderCache(128)
  const first = hdrCachePlan(frame, frame, viewport, view, 'after', 0.5)
  const render = (plan: ReturnType<typeof hdrCachePlan>) =>
    [...cache.batches(plan, false)].reduce((n, b) => n + b.renderedTiles, 0)
  expect(render(first)).toBeGreaterThan(0)
  expect(render(first)).toBe(0)
  expect(render(hdrCachePlan(frame, frame, viewport, { ...view, x: 4 }, 'after', 0.5))).toBe(0)
  expect(render(hdrCachePlan(frame, frame, viewport, { ...view, scale: 1.1 }, 'after', 0.5))).toBe(
    0,
  )
  expect(hdrShader).not.toContain('outputTransform_fwd')
  expect(hdrShader).not.toContain('adjusted(')
})
test('edits retire After tiles while neutral Before survives; target resets retire all', () => {
  const cache = new HdrRenderCache(128)
  const plan = hdrCachePlan(frame, frame, viewport, view, 'split', 0.5)
  cache.setEdits('old')
  const first = [...cache.batches(plan, false)]
  cache.setEdits('new')
  const edited = [...cache.batches(plan, false)]
  expect(edited[0].renderedTiles).toBeGreaterThan(0)
  expect(edited[0].renderedTiles).toBeLessThan(first[0].renderedTiles)
  expect([...cache.batches(plan, false)][0].renderedTiles).toBe(0)
  cache.reset()
  expect([...cache.batches(plan, false)][0].renderedTiles).toBe(first[0].renderedTiles)
})
test('neutral comparison shares tiles and bounded batches cover every visible tile', () => {
  const plan = hdrCachePlan(frame, frame, viewport, view, 'split', 0.5)
  const cache = new HdrRenderCache(3)
  const batches = [...cache.batches(plan, true)]
  expect(batches.length).toBeGreaterThan(1)
  expect(cache.size).toBeLessThanOrEqual(3)
  for (const tile of plan.tiles)
    expect(
      batches.some(
        (b) => b.lookup[(Number(tile.before) * plan.rows + tile.y) * plan.columns + tile.x] >= 0,
      ),
    ).toBe(true)
  for (const batch of batches) {
    expect(batch.renderedTiles).toBeLessThanOrEqual(3)
    expect([...batch.lookup].every((slot) => slot >= -1 && slot < 3)).toBe(true)
  }
  const neutral = [...new HdrRenderCache(128).batches(plan, true)][0]
  const edited = [...new HdrRenderCache(128).batches(plan, false)][0]
  const unique = new Set(plan.tiles.map((tile) => `${tile.x}:${tile.y}`))
  expect(neutral.renderedTiles).toBe(unique.size)
  expect(edited.renderedTiles).toBe(plan.tiles.length)
  expect(neutral.renderedTiles).toBeLessThan(edited.renderedTiles)
  for (const tile of plan.tiles) {
    const index = tile.y * plan.columns + tile.x
    if (neutral.lookup[index] >= 0 && neutral.lookup[index + plan.columns * plan.rows] >= 0)
      expect(neutral.lookup[index]).toBe(neutral.lookup[index + plan.columns * plan.rows])
  }
})
test('mips, edge halos, split endpoints and off-image views keep lookups bounded', () => {
  for (const scale of [0.1, 0.51, 0.99, 1, 8, 32])
    for (const split of [0, 0.5, 1]) {
      const plan = hdrCachePlan(frame, frame, viewport, { ...view, scale }, 'split', split)
      expect(plan.tiles.length).toBeGreaterThan(0)
      for (const t of plan.tiles) {
        expect(t.x).toBeGreaterThanOrEqual(0)
        expect(t.y).toBeGreaterThanOrEqual(0)
        expect(t.x).toBeLessThan(plan.columns)
        expect(t.y).toBeLessThan(plan.rows)
        expect(t.before ? split > 0 : split < 1).toBe(true)
      }
    }
  expect(hdrCachePlan(frame, frame, viewport, { ...view, x: 1e6 }, 'after', 0.5).tiles).toEqual([])
})
