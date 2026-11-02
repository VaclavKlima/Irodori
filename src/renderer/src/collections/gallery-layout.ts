import type { GalleryGroupSpan } from '../../../shared/stacks'
import type { CollectionLayout } from './layout'

export interface GalleryGroupGeometry extends GalleryGroupSpan {
  top: number
  width: number
  height: number
}
export interface GalleryLayout extends CollectionLayout {
  box(index: number): { top: number; left: number; width: number; height: number; grouped: boolean }
  group(index: number): GalleryGroupGeometry | undefined
  headings: readonly { index: number; top: number }[]
  move(index: number, key: string, viewportHeight: number): number
}

/** Geometry is independent of loaded records; source indices remain the collection identity. */
export function galleryLayout(
  total: number,
  groups: readonly GalleryGroupSpan[],
  width: number,
): GalleryLayout {
  const boxes: ReturnType<GalleryLayout['box']>[] = [],
    memberships: (GalleryGroupGeometry | undefined)[] = [],
    headings: { index: number; top: number }[] = []
  let top = 0,
    groupIndex = 0,
    afterGroup = false
  const rowHeight = 56,
    tileHeight = 104,
    gap = 6,
    inset = 8,
    // 30px heading, 5px separation, 26px disclosure and 8px before the images.
    groupHeader = 69
  for (let index = 0; index < total;) {
    const group = groups[groupIndex]
    if (group && group.start === index) {
      if (afterGroup) top += 12
      const collapsed = group.count === 1,
        columns = collapsed ? 1 : 2,
        memberInset = collapsed ? 7 : 0,
        memberTop = top + inset + groupHeader + (collapsed ? 8 : 0),
        tileWidth = Math.max(0, (width - inset * 2 - memberInset - gap * (columns - 1)) / columns),
        rows = Math.ceil(group.count / columns),
        height =
          inset * 2 +
          groupHeader +
          (collapsed ? 8 : 0) +
          rows * tileHeight +
          Math.max(0, rows - 1) * gap,
        geometry: GalleryGroupGeometry = { ...group, top, width, height }
      for (let member = 0; member < group.count; member++) {
        boxes.push({
          top: memberTop + Math.floor(member / columns) * (tileHeight + gap),
          left: inset + memberInset + (member % columns) * (tileWidth + gap),
          width: tileWidth,
          height: tileHeight,
          grouped: true,
        })
        memberships.push(geometry)
      }
      top += height
      index += group.count
      groupIndex++
      afterGroup = true
    } else {
      if (afterGroup) {
        // Match the separate loose-photo heading and its surrounding spacing.
        headings.push({ index, top: top + 14 })
        top += 53
      }
      boxes.push({ top, left: 0, width, height: rowHeight, grouped: false })
      memberships.push(undefined)
      top += rowHeight + 2
      index++
      afterGroup = false
    }
  }
  const first = (y: number) => {
    let low = 0,
      high = boxes.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (boxes[middle].top + boxes[middle].height <= y) low = middle + 1
      else high = middle
    }
    return Math.min(Math.max(0, total - 1), low)
  }
  const box = (index: number) =>
    boxes[index] ?? { top: 0, left: 0, width, height: rowHeight, grouped: false }
  return {
    height: top - (total && !afterGroup ? 2 : 0),
    rowHeight,
    columns: 1,
    box,
    group: (index) => memberships[index],
    headings,
    first,
    top: (index) => box(index).top,
    indices: (y, height, overscan = 2) => {
      let low = 0,
        high = total
      while (low < high) {
        const middle = (low + high) >>> 1
        if (boxes[middle].top < y + height) low = middle + 1
        else high = middle
      }
      let start = Math.max(0, first(y) - overscan * 2),
        end = Math.min(total, Math.max(first(y) + 1, low) + overscan * 2)
      if (start > 0 && box(start - 1).top === box(start).top) start--
      if (end < total && end > 0 && box(end - 1).top === box(end).top) end++
      return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
    },
    move: (index, key, viewportHeight) => {
      if (key === 'Home') return 0
      if (key === 'End') return total - 1
      if (key === 'ArrowLeft' || key === 'ArrowRight')
        return Math.max(0, Math.min(total - 1, index + (key === 'ArrowLeft' ? -1 : 1)))
      const current = box(index),
        sign = key === 'ArrowUp' || key === 'PageUp' ? -1 : 1
      const target = current.top + sign * (key.startsWith('Page') ? viewportHeight : 1)
      let best = index,
        score = Infinity
      boxes.forEach((candidate, candidateIndex) => {
        if (sign * (candidate.top - current.top) <= 0) return
        const distance =
          Math.abs(candidate.top - target) * (width + 1) +
          Math.abs(candidate.left + candidate.width / 2 - current.left - current.width / 2)
        if (distance < score) {
          score = distance
          best = candidateIndex
        }
      })
      return best
    },
  }
}
