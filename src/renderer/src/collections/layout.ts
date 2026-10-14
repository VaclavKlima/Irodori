import type { CollectionAnchor } from '../../../shared/collections'
import type { CollectionWindow } from './controller'

export const COLLECTION_OVERSCAN = 2
export interface CollectionLayout {
  height: number
  rowHeight: number
  columns: number
  indices: (top: number, height: number, overscan?: number) => number[]
  top: (index: number) => number
  first: (top: number) => number
}
export function gridLayout(total: number, columns: number, rowHeight: number): CollectionLayout {
  return {
    height: Math.ceil(total / columns) * rowHeight,
    rowHeight,
    columns,
    top: (index) => Math.floor(index / columns) * rowHeight,
    first: (top) =>
      Math.min(Math.max(0, total - 1), Math.max(0, Math.floor(top / rowHeight)) * columns),
    indices: (top, height, overscan = COLLECTION_OVERSCAN) => {
      const start = Math.max(0, Math.floor(top / rowHeight) - overscan) * columns
      const end = Math.min(total, (Math.ceil((top + height) / rowHeight) + overscan) * columns)
      return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
    },
  }
}
export function collectionWindow(
  layout: CollectionLayout,
  top: number,
  height: number,
  direction: -1 | 1,
  lookahead: number,
  pinned: number[],
  active: boolean,
): CollectionWindow {
  const visible = layout.indices(top, height, 0)
  const overscan = layout.indices(top, height)
  const start = direction > 0 ? top + height : Math.max(0, top - height * lookahead)
  const extent = direction > 0 ? height * lookahead : top - start
  const seen = new Set(overscan)
  return {
    visible,
    overscan,
    lookahead: (direction > 0
      ? layout.indices(start, extent, 0)
      : layout.indices(start, extent, 0).reverse()
    ).filter((i) => !seen.has(i)),
    pinned,
    active,
  }
}
export function revealNearest(element: HTMLElement, top: number, rowHeight: number) {
  const before = element.scrollTop
  if (top < before) element.scrollTop = top
  else if (top + rowHeight > before + element.clientHeight)
    element.scrollTop = top + rowHeight - element.clientHeight
  return element.scrollTop
}
export function captureAnchor<T>(
  layout: CollectionLayout,
  top: number,
  records: ReadonlyMap<number, T>,
  identity: (record: T) => string,
  cover?: (record: T) => string | undefined,
): CollectionAnchor | null {
  const index = layout.first(top),
    record = records.get(index)
  if (!record) return null
  return {
    id: identity(record),
    index,
    inset: top - layout.top(index),
    coverId: cover?.(record),
    beforeId: records.has(index - 1) ? identity(records.get(index - 1)!) : undefined,
    afterId: records.has(index + 1) ? identity(records.get(index + 1)!) : undefined,
  }
}
export async function locateAnchor(
  anchor: CollectionAnchor,
  locate: (id: string) => Promise<number | null>,
  total: number,
): Promise<number> {
  for (const id of [...new Set([anchor.id, anchor.coverId, anchor.afterId, anchor.beforeId])]) {
    if (!id) continue
    const index = await locate(id)
    if (index !== null) return index
  }
  return Math.max(0, Math.min(total - 1, anchor.index))
}

/** Heights persist by stable row ID; unmeasured rows reserve readable loading space. */
export function measuredLayout(
  total: number,
  heights: ReadonlyMap<number, number>,
  estimate = 68,
): CollectionLayout {
  const tops = [0]
  for (let i = 0; i < total; i++) tops.push(tops[i] + (heights.get(i) ?? estimate))
  const first = (top: number) => {
    let low = 0,
      high = total
    while (low < high) {
      const middle = (low + high) >>> 1
      if (tops[middle + 1] <= top) low = middle + 1
      else high = middle
    }
    return Math.min(Math.max(0, total - 1), low)
  }
  return {
    height: tops[total],
    rowHeight: estimate,
    columns: 1,
    top: (index) => tops[index] ?? 0,
    first,
    indices: (top, height, overscan = COLLECTION_OVERSCAN) => {
      const start = Math.max(0, first(top) - overscan),
        end = Math.min(total, first(top + height) + overscan + 1)
      return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
    },
  }
}
