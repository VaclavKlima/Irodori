import type { BrowseSection } from '../../../shared/browse'

export const BROWSE_ROW_HEIGHT = 190
export const BROWSE_HEADER_HEIGHT = 42
export const BROWSE_OVERSCAN = 2
export interface BrowseLayoutSection {
  section: BrowseSection
  top: number
  bottom: number
  rows: number
}
export interface BrowseLayout {
  columns: number
  rowHeight: number
  height: number
  sections: BrowseLayoutSection[]
}
export type BrowseRow =
  | { kind: 'header'; top: number; section: BrowseSection }
  | { kind: 'photos'; top: number; start: number; count: number; section: BrowseSection }

export function createBrowseLayout(
  sections: BrowseSection[],
  width: number,
  viewportHeight = 500,
  collapsed: ReadonlySet<string> = new Set(),
): BrowseLayout {
  const columns = Math.min(12, Math.max(1, Math.floor((width - 32 + 12) / (168 + 12))))
  // At most 240 records with overscan leaves room for boundaries in a five-chunk cache.
  const rowHeight = Math.max(
    BROWSE_ROW_HEIGHT,
    Math.ceil(viewportHeight / Math.max(1, Math.floor(240 / columns) - (2 * BROWSE_OVERSCAN + 1))),
  )
  let height = 0
  const laidOut = sections.map((section) => {
    const top = height,
      rows = collapsed.has(section.key) ? 0 : Math.ceil(section.count / columns)
    height += BROWSE_HEADER_HEIGHT + rows * rowHeight
    return { section, top, bottom: height, rows }
  })
  return { columns, rowHeight, height, sections: laidOut }
}
export function visibleBrowseRows(
  layout: BrowseLayout,
  scrollTop: number,
  height: number,
): BrowseRow[] {
  const from = Math.max(0, scrollTop - BROWSE_OVERSCAN * layout.rowHeight)
  const to = scrollTop + height + BROWSE_OVERSCAN * layout.rowHeight
  const result: BrowseRow[] = []
  for (const { section, top, bottom, rows } of layout.sections) {
    if (bottom < from || top > to) continue
    if (top + BROWSE_HEADER_HEIGHT >= from) result.push({ kind: 'header', top, section })
    const first = Math.max(0, Math.floor((from - top - BROWSE_HEADER_HEIGHT) / layout.rowHeight))
    const last = Math.min(
      rows - 1,
      Math.floor((to - top - BROWSE_HEADER_HEIGHT) / layout.rowHeight),
    )
    for (let row = first; row <= last; row++) {
      const start = section.offset + row * layout.columns
      result.push({
        kind: 'photos',
        top: top + BROWSE_HEADER_HEIGHT + row * layout.rowHeight,
        start,
        count: Math.min(layout.columns, section.offset + section.count - start),
        section,
      })
    }
  }
  return result
}
export function browseIndexTop(layout: BrowseLayout, index: number): number {
  const section = layout.sections.find(
    (s) => index >= s.section.offset && index < s.section.offset + s.section.count,
  )
  return section?.rows === 0
    ? section.top
    : section
      ? section.top +
        BROWSE_HEADER_HEIGHT +
        Math.floor((index - section.section.offset) / layout.columns) * layout.rowHeight
      : 0
}
export function firstVisibleBrowseIndex(layout: BrowseLayout, scrollTop: number): number {
  const section = layout.sections.find((s) => s.bottom > scrollTop) ?? layout.sections.at(-1)
  if (!section) return 0
  if (!section.rows) return section.section.offset
  return (
    section.section.offset +
    Math.min(
      section.rows - 1,
      Math.max(0, Math.floor((scrollTop - section.top - BROWSE_HEADER_HEIGHT) / layout.rowHeight)),
    ) *
      layout.columns
  )
}

export function browseNavigableIndex(
  layout: BrowseLayout,
  index: number,
  direction: -1 | 1,
): number | null {
  const expanded = layout.sections.filter((section) => section.rows > 0)
  if (!expanded.length) return null
  const last = layout.sections.at(-1)!.section
  index = Math.max(0, Math.min(last.offset + last.count - 1, index))
  const containing = expanded.find(
    ({ section }) => index >= section.offset && index < section.offset + section.count,
  )
  if (containing) return index
  if (direction > 0) {
    const next = expanded.find(({ section }) => section.offset > index)
    if (next) return next.section.offset
    const previous = expanded.at(-1)!.section
    return previous.offset + previous.count - 1
  }
  const previous = [...expanded]
    .reverse()
    .find(({ section }) => section.offset + section.count - 1 < index)
  if (previous) return previous.section.offset + previous.section.count - 1
  return expanded[0].section.offset
}
