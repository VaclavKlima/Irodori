import { test, expect } from '@playwright/test'
import { galleryLayout } from '../src/renderer/src/collections/gallery-layout'
import { captureAnchor, collectionWindow } from '../src/renderer/src/collections/layout'

test('unloaded groups reserve uniform rows across chunk boundaries without headers or extra spacing', () => {
  const layout = galleryLayout(300, [{ stackId: 'a', start: 59, count: 5 }], 204)
  expect(layout.box(0)).toEqual({ top: 0, left: 0, width: 204, height: 56, grouped: false })
  expect(layout.group(59)).toEqual({
    stackId: 'a',
    start: 59,
    count: 5,
    top: 59 * 58,
    width: 204,
    height: 288,
  })
  for (let index = 59; index < 64; index++) {
    expect(layout.box(index)).toEqual({
      top: index * 58,
      left: 0,
      width: 204,
      height: 56,
      grouped: true,
    })
    expect(layout.group(index)).toBe(layout.group(59))
  }
  expect(layout.group(58)).toBeUndefined()
  expect(layout.group(64)).toBeUndefined()
  expect(layout.top(64)).toBe(64 * 58)
  expect(layout.height).toBe(300 * 58 - 2)
  const window = collectionWindow(layout, layout.top(59), 120, 1, 2, [], true)
  expect(window.visible).toEqual([59, 60, 61])
  expect(new Set(window.visible).size).toBe(window.visible.length)
  expect(layout.indices(layout.top(59), 56, 0)).toEqual([59])
  expect(layout.indices(layout.top(60), 56, 0)).toEqual([60])
  expect(layout.indices(layout.top(59), 58, 0)).toEqual([59])
})
test('directional movement follows the same sequence inside and outside groups; paging follows viewport height', () => {
  const layout = galleryLayout(40, [{ stackId: 'a', start: 1, count: 5 }], 204)
  expect(layout.move(1, 'ArrowDown', 300)).toBe(2)
  expect(layout.move(2, 'ArrowDown', 300)).toBe(3)
  expect(layout.move(4, 'ArrowUp', 300)).toBe(3)
  expect(layout.move(3, 'ArrowRight', 300)).toBe(4)
  expect(layout.move(5, 'ArrowDown', 300)).toBe(6)
  expect(layout.move(1, 'PageDown', 400)).toBe(8)
  expect(layout.move(8, 'PageUp', 400)).toBe(1)
  expect(layout.move(6, 'Home', 300)).toBe(0)
  expect(layout.move(0, 'End', 300)).toBe(39)
  expect(layout.move(0, 'ArrowUp', 300)).toBe(0)
  expect(layout.move(39, 'PageDown', 300)).toBe(39)
})
test('ID and pixel inset recover when group folding removes earlier member rows', () => {
  const expanded = galleryLayout(10, [{ stackId: 'a', start: 0, count: 5 }], 204)
  const anchor = captureAnchor(
    expanded,
    expanded.top(7) + 12,
    new Map([[7, { id: 'retained' }]]),
    (p) => p.id,
  )
  expect(anchor).toMatchObject({ id: 'retained', index: 7, inset: 12 })
  const collapsed = galleryLayout(6, [{ stackId: 'a', start: 0, count: 1 }], 204)
  expect(collapsed.group(0)?.height).toBe(56)
  expect(collapsed.box(0)).toEqual({ top: 0, left: 0, width: 204, height: 56, grouped: true })
  expect(collapsed.top(3) + anchor!.inset).toBe(186)
  expect(expanded.top(7) - collapsed.top(3)).toBe(4 * 58)
})
test('adjacent expanded and collapsed groups retain exact membership at boundaries and empty lists are bounded', () => {
  const layout = galleryLayout(
    10,
    [
      { stackId: 'a', start: 0, count: 1 },
      { stackId: 'b', start: 1, count: 3 },
      { stackId: 'c', start: 7, count: 2 },
    ],
    204,
  )
  expect(Array.from({ length: 10 }, (_, i) => layout.group(i)?.stackId)).toEqual([
    'a',
    'b',
    'b',
    'b',
    undefined,
    undefined,
    undefined,
    'c',
    'c',
    undefined,
  ])
  expect(layout.group(0)?.height).toBe(56)
  expect(layout.group(1)?.top).toBe(58)
  const empty = galleryLayout(0, [], 204)
  expect(empty.height).toBe(0)
  expect(empty.indices(0, 400)).toEqual([])
  expect(empty.move(0, 'End', 400)).toBe(0)
})
