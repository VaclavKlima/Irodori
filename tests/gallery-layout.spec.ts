import { test, expect } from '@playwright/test'
import { galleryLayout } from '../src/renderer/src/collections/gallery-layout'
import { captureAnchor, collectionWindow } from '../src/renderer/src/collections/layout'

test('unloaded mixed collections reserve group headers, insets and two-column tiles across chunks', () => {
  const layout = galleryLayout(300, [{ stackId: 'a', start: 199, count: 5 }], 204)
  const groupTop = 199 * 58
  expect(layout.box(0)).toEqual({ top: 0, left: 0, width: 204, height: 56, grouped: false })
  expect(layout.group(199)).toEqual({
    stackId: 'a',
    start: 199,
    count: 5,
    top: groupTop,
    width: 204,
    height: 409,
  })
  expect(layout.box(199)).toEqual({
    top: groupTop + 77,
    left: 8,
    width: 91,
    height: 104,
    grouped: true,
  })
  expect(layout.box(200)).toEqual({
    top: groupTop + 77,
    left: 105,
    width: 91,
    height: 104,
    grouped: true,
  })
  expect(layout.box(201).top).toBe(layout.box(199).top + 110)
  expect(layout.box(204).top).toBe(groupTop + 409 + 53)
  expect(layout.headings).toEqual([{ index: 204, top: groupTop + 409 + 14 }])
  const window = collectionWindow(layout, layout.top(199), 120, 1, 2, [], true)
  expect(window.visible).toEqual([199, 200, 201, 202])
  expect(new Set(window.visible).size).toBe(window.visible.length)
  // Header-only visibility requests the cover and completes its visual row.
  expect(layout.indices(groupTop, 30, 0)).toEqual([199, 200])
  // A visual row always requests both tiles, including at a chunk boundary.
  expect(layout.indices(layout.top(200), 104, 0)).toEqual([199, 200])
  // Merely touching the next row's top excludes it; adjacent rows never overlap.
  expect(layout.indices(layout.top(199), 110, 0)).toEqual([199, 200])
  expect(layout.indices(layout.top(201), 104, 0)).toEqual([201, 202])
})
test('directional movement follows visual rows and paging follows pixels', () => {
  const layout = galleryLayout(40, [{ stackId: 'a', start: 1, count: 5 }], 204)
  expect(layout.move(1, 'ArrowDown', 300)).toBe(3)
  expect(layout.move(2, 'ArrowDown', 300)).toBe(4)
  expect(layout.move(4, 'ArrowUp', 300)).toBe(2)
  expect(layout.move(3, 'ArrowRight', 300)).toBe(4)
  expect(layout.move(1, 'PageDown', 400)).toBe(6)
  expect(layout.move(6, 'Home', 300)).toBe(0)
  expect(layout.move(0, 'End', 300)).toBe(39)
})
test('ID and pixel inset recover when group folding changes earlier geometry', () => {
  const expanded = galleryLayout(10, [{ stackId: 'a', start: 0, count: 5 }], 204)
  const anchor = captureAnchor(
    expanded,
    expanded.top(7) + 12,
    new Map([[7, { id: 'retained' }]]),
    (p) => p.id,
  )
  expect(anchor).toMatchObject({ id: 'retained', index: 7, inset: 12 })
  const collapsed = galleryLayout(6, [{ stackId: 'a', start: 0, count: 1 }], 204)
  expect(collapsed.group(0)?.height).toBe(197)
  expect(collapsed.box(0)).toEqual({ top: 85, left: 15, width: 181, height: 104, grouped: true })
  expect(collapsed.top(3) + anchor!.inset).toBe(378)
})
