import type { GalleryGroupSpan } from '../../../shared/stacks'
import { gridLayout, type CollectionLayout } from './layout'

export interface GalleryGroupGeometry extends GalleryGroupSpan {
  top: number
  width: number
  height: number
}
export interface GalleryLayout extends CollectionLayout {
  box(index: number): { top: number; left: number; width: number; height: number; grouped: boolean }
  group(index: number): GalleryGroupGeometry | undefined
  move(index: number, key: string, viewportHeight: number): number
}

/** Uniform geometry keeps source indices authoritative even before records load. */
export function galleryLayout(
  total: number,
  groups: readonly GalleryGroupSpan[],
  width: number,
): GalleryLayout {
  const rowHeight = 56,
    gap = 2,
    stride = rowHeight + gap
  const rows = gridLayout(total, 1, stride)
  const spans = groups.map((span) => ({
    ...span,
    top: rows.top(span.start),
    width,
    height: span.count * stride - gap,
  }))
  const group = (index: number) => {
    let low = 0,
      high = spans.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (spans[middle].start <= index) low = middle + 1
      else high = middle
    }
    const span = spans[low - 1]
    return span && index < span.start + span.count ? span : undefined
  }
  return {
    ...rows,
    rowHeight,
    height: Math.max(0, rows.height - gap),
    box: (index) => ({
      top: rows.top(index),
      left: 0,
      width,
      height: rowHeight,
      grouped: !!group(index),
    }),
    group,
    move: (index, key, viewportHeight) => {
      if (key === 'Home') return 0
      if (key === 'End') return Math.max(0, total - 1)
      const sign = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' ? -1 : 1
      const distance = key.startsWith('Page') ? Math.max(1, Math.round(viewportHeight / stride)) : 1
      return Math.max(0, Math.min(Math.max(0, total - 1), index + sign * distance))
    },
  }
}
