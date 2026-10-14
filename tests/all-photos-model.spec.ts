import { expect, test } from '@playwright/test'
import {
  browseSectionKey,
  browseSectionLabel,
  browseTerms,
  validatedCaptureDate,
} from '../src/shared/browse'
import type { BrowseSection } from '../src/shared/browse'
import {
  BROWSE_HEADER_HEIGHT,
  BROWSE_OVERSCAN,
  BROWSE_ROW_HEIGHT,
  browseIndexTop,
  browseNavigableIndex,
  createBrowseLayout,
  firstVisibleBrowseIndex,
  visibleBrowseRows,
} from '../src/renderer/src/browse/layout'

function sections(counts: number[]): BrowseSection[] {
  let offset = 0
  return counts.map((count, index) => {
    const section = {
      key: `section-${index}`,
      label: `Section ${index}`,
      offset,
      count,
      selected: 0,
    }
    offset += count
    return section
  })
}

test('capture dates retain the recorded calendar across timezone boundaries and normalize precision', () => {
  for (const offset of ['+14:00', '-12:00', 'Z'])
    expect(validatedCaptureDate(`2026-10-01T00:15:02.12${offset}`)).toBe(
      '2026-10-01T00:15:02.120000000000000000',
    )
  expect(validatedCaptureDate(' 2000:02:29 23:59:59.000001+0100 ')).toBe(
    '2000-02-29T23:59:59.000001000000000000',
  )
  expect(validatedCaptureDate('2024-02-29')).toBe('2024-02-29T00:00:00.000000000000000000')
  expect(validatedCaptureDate('2026-10-01T00:15:02.000000000000000001')).toBe(
    '2026-10-01T00:15:02.000000000000000001',
  )
})

test('invalid dates never overflow into another day or accept partial calendar text', () => {
  const invalid = [
    undefined,
    '',
    '2026-10',
    '2026',
    '0000-01-01',
    '1900-02-29',
    '2026-02-29',
    '2026-04-31',
    '2026-00-10',
    '2026-13-10',
    '2026-10-00',
    '2026-10-32',
    '2026-10-01T24:00:00',
    '2026-10-01T12:60:00',
    '2026-10-01T12:00:60',
    '2026-10-01T12:00:00+24:00',
    '2026-10-01T12:00:00+15:00',
    '2026-10-01T12:00:00-14:01',
    '2026-10-01T12:00:00-01:60',
    '2026-10:01T12:00:00',
    '2026-10-01T12:00:00 trailing text',
  ]
  for (const value of invalid) expect(validatedCaptureDate(value), String(value)).toBeNull()
})

test('Date, Month and Year keys and labels use calendar text with an explicit unknown section', () => {
  const date = validatedCaptureDate('2026:10:01 00:15:02+1400')
  expect(browseSectionKey(date, 'date')).toBe('2026-10-01')
  expect(browseSectionKey(date, 'month')).toBe('2026-10')
  expect(browseSectionKey(date, 'year')).toBe('2026')
  expect(browseSectionLabel('2026-10-01')).toBe('1 October 2026')
  expect(browseSectionLabel('2026-10')).toBe('October 2026')
  expect(browseSectionLabel('2026')).toBe('2026')
  for (const grouping of ['date', 'month', 'year'] as const)
    expect(browseSectionKey(null, grouping)).toBe('unknown')
  expect(browseSectionLabel('unknown')).toBe('Unknown date')
})

test('search terms are case-insensitive literal words without a query language', () => {
  expect(browseTerms('  SONY\t2026-10\nSony 50% _lens  camera:raw  ')).toEqual([
    'sony',
    '2026-10',
    '50%',
    '_lens',
    'camera:raw',
  ])
  expect(browseTerms(' \n ')).toEqual([])
})

test('browse layout keeps each section header, partial last row and full catalog offsets', () => {
  const summary = sections([7, 2])
  const layout = createBrowseLayout(summary, 1100)
  expect(layout.columns).toBe(6)
  expect(layout.rowHeight).toBe(BROWSE_ROW_HEIGHT)
  expect(layout.sections).toEqual([
    { section: summary[0], top: 0, bottom: 422, rows: 2 },
    { section: summary[1], top: 422, bottom: 654, rows: 1 },
  ])
  expect(layout.height).toBe(654)
  expect(visibleBrowseRows(layout, 0, layout.height)).toEqual([
    { kind: 'header', top: 0, section: summary[0] },
    { kind: 'photos', top: 42, start: 0, count: 6, section: summary[0] },
    { kind: 'photos', top: 232, start: 6, count: 1, section: summary[0] },
    { kind: 'header', top: 422, section: summary[1] },
    { kind: 'photos', top: 464, start: 7, count: 2, section: summary[1] },
  ])
  expect(createBrowseLayout([], 1100)).toMatchObject({ height: 0, sections: [] })
  expect(visibleBrowseRows(createBrowseLayout([], 1100), 0, 700)).toEqual([])
})

test('responsive columns include precisely two overscan rows on each side of a middle viewport', () => {
  const widths = [100, 200, 380, 560, 1100, 10000]
  const columns = widths.map((width) => createBrowseLayout(sections([100]), width).columns)
  expect(columns.slice(0, 5)).toEqual([1, 1, 2, 3, 6])
  expect(columns.at(-1)).toBeLessThanOrEqual(12)
  expect([...columns].sort((a, b) => a - b)).toEqual(columns)
  const layout = createBrowseLayout(sections([100]), 560)
  const firstVisibleRow = 5
  const scroll = BROWSE_HEADER_HEIGHT + firstVisibleRow * layout.rowHeight + 1
  const rows = visibleBrowseRows(layout, scroll, layout.rowHeight)
  expect(rows.every((row) => row.kind === 'photos')).toBe(true)
  expect(rows.filter((row) => row.kind === 'photos').map((row) => row.start)).toEqual(
    Array.from(
      { length: 2 * BROWSE_OVERSCAN + 2 },
      (_, index) => (firstVisibleRow - BROWSE_OVERSCAN + index) * layout.columns,
    ),
  )
  expect(firstVisibleBrowseIndex(layout, scroll)).toBe(firstVisibleRow * layout.columns)
})

test('virtualized rendering preserves card size across a hundred thousand photos and wide or tall viewports', () => {
  const summary = sections([100000])
  for (const [width, viewportHeight] of [
    [380, 500],
    [1100, 700],
    [10000, 10000],
    [10000, 50000],
  ]) {
    const layout = createBrowseLayout(summary, width, viewportHeight)
    expect(layout.columns).toBeGreaterThanOrEqual(1)
    expect(layout.columns).toBeLessThanOrEqual(12)
    expect(layout.sections[0].rows).toBe(Math.ceil(100000 / layout.columns))
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const scrollTop = Math.max(0, layout.height - viewportHeight) * fraction
      const rows = visibleBrowseRows(layout, scrollTop, viewportHeight).filter(
        (row) => row.kind === 'photos',
      )
      const records = rows.reduce((count, row) => count + row.count, 0)
      expect(layout.rowHeight).toBe(BROWSE_ROW_HEIGHT)
      expect(records, `${width} × ${viewportHeight} at ${fraction}`).toBeLessThanOrEqual(
        (Math.ceil(viewportHeight / BROWSE_ROW_HEIGHT) + 2 * BROWSE_OVERSCAN + 1) * layout.columns,
      )
      expect(records).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.start).toBeGreaterThanOrEqual(0)
        expect(row.start + row.count).toBeLessThanOrEqual(100000)
        expect(row.count).toBeLessThanOrEqual(layout.columns)
      }
      const chunks = new Set(
        rows.flatMap((row) =>
          Array.from({ length: row.count }, (_, index) => Math.floor((row.start + index) / 60)),
        ),
      )
      expect(chunks.size).toBeLessThanOrEqual(Math.ceil(records / 60) + 1)
    }
  }
})

test('index-to-scroll mapping preserves the anchor row across section headers, regrouping and catalog growth', () => {
  const original = createBrowseLayout(sections([7, 9, 11]), 1100)
  for (const index of [0, 6, 7, 8, 15, 16, 26]) {
    const top = browseIndexTop(original, index)
    const first = firstVisibleBrowseIndex(original, top + 17)
    expect(first).toBeLessThanOrEqual(index)
    expect(first + original.columns).toBeGreaterThan(index)
    expect(browseIndexTop(original, first)).toBe(top)
    expect(firstVisibleBrowseIndex(original, top + 17)).toBe(first)
  }
  expect(firstVisibleBrowseIndex(original, original.sections[1].top)).toBe(7)
  expect(firstVisibleBrowseIndex(original, original.height + 500)).toBe(22)
  expect(firstVisibleBrowseIndex(createBrowseLayout([], 1100), 20)).toBe(0)
  expect(browseIndexTop(original, -1)).toBe(0)
  expect(browseIndexTop(original, 27)).toBe(0)
  const anchor = 7
  const savedOffset = 17
  const regrouped = createBrowseLayout(sections([27]), 560)
  const newScroll = browseIndexTop(regrouped, anchor) + savedOffset
  const first = firstVisibleBrowseIndex(regrouped, newScroll)
  expect(first).toBeLessThanOrEqual(anchor)
  expect(first + regrouped.columns).toBeGreaterThan(anchor)
  const grown = createBrowseLayout(sections([10, 7, 9, 11]), 1100)
  expect(browseIndexTop(grown, anchor + 10) - grown.sections[1].top).toBe(
    browseIndexTop(original, anchor),
  )
  const restored = browseIndexTop(original, anchor) + savedOffset
  expect(firstVisibleBrowseIndex(original, restored)).toBe(anchor)
})

test('folded sections keep their headers and catalog offsets while removing every thumbnail row', () => {
  const summary = sections([5, 7, 4, 9])
  const before = structuredClone(summary)
  const collapsed = new Set([summary[0].key, summary[2].key])
  const layout = createBrowseLayout(summary, 1100, 500, collapsed)
  expect(
    layout.sections.map(({ section, top, bottom, rows }) => ({
      offset: section.offset,
      top,
      bottom,
      rows,
    })),
  ).toEqual([
    { offset: 0, top: 0, bottom: 42, rows: 0 },
    { offset: 5, top: 42, bottom: 464, rows: 2 },
    { offset: 12, top: 464, bottom: 506, rows: 0 },
    { offset: 16, top: 506, bottom: 928, rows: 2 },
  ])
  expect(layout.height).toBe(928)
  expect(visibleBrowseRows(layout, 0, layout.height)).toEqual([
    { kind: 'header', top: 0, section: summary[0] },
    { kind: 'header', top: 42, section: summary[1] },
    { kind: 'photos', top: 84, start: 5, count: 6, section: summary[1] },
    { kind: 'photos', top: 274, start: 11, count: 1, section: summary[1] },
    { kind: 'header', top: 464, section: summary[2] },
    { kind: 'header', top: 506, section: summary[3] },
    { kind: 'photos', top: 548, start: 16, count: 6, section: summary[3] },
    { kind: 'photos', top: 738, start: 22, count: 3, section: summary[3] },
  ])
  expect(summary).toEqual(before)
  expect(createBrowseLayout(summary, 1100).sections.map(({ section }) => section.offset)).toEqual([
    0, 5, 12, 16,
  ])
  for (const index of [0, 1, 4]) expect(browseIndexTop(layout, index)).toBe(0)
  for (const index of [12, 13, 15]) expect(browseIndexTop(layout, index)).toBe(464)
  expect(firstVisibleBrowseIndex(layout, -100)).toBe(0)
  expect(firstVisibleBrowseIndex(layout, 17)).toBe(0)
  expect(firstVisibleBrowseIndex(layout, 42)).toBe(5)
  expect(firstVisibleBrowseIndex(layout, 481)).toBe(12)
  expect(browseIndexTop(layout, 16)).toBe(548)
})

test('all-folded sections have only headers and never produce a negative photo index', () => {
  const summary = sections([5, 7, 4])
  const layout = createBrowseLayout(
    summary,
    1100,
    500,
    new Set(summary.map((section) => section.key)),
  )
  expect(layout.height).toBe(3 * BROWSE_HEADER_HEIGHT)
  expect(layout.sections.map(({ rows }) => rows)).toEqual([0, 0, 0])
  expect(visibleBrowseRows(layout, 0, 500)).toEqual(
    summary.map((section, index) => ({
      kind: 'header',
      top: index * BROWSE_HEADER_HEIGHT,
      section,
    })),
  )
  for (const [index, section] of summary.entries()) {
    for (const photoIndex of [section.offset, section.offset + section.count - 1])
      expect(browseIndexTop(layout, photoIndex)).toBe(index * BROWSE_HEADER_HEIGHT)
    expect(firstVisibleBrowseIndex(layout, index * BROWSE_HEADER_HEIGHT + 17)).toBe(section.offset)
  }
  expect(firstVisibleBrowseIndex(layout, -500)).toBe(0)
  expect(firstVisibleBrowseIndex(layout, layout.height + 500)).toBe(12)
  expect(firstVisibleBrowseIndex(createBrowseLayout([], 1100, 500, new Set()), 500)).toBe(0)
})

test('a hundred thousand photos in folded groups render only nearby headers', () => {
  const summary = sections(Array.from({ length: 1000 }, () => 100))
  const viewportHeight = 700
  const layout = createBrowseLayout(
    summary,
    1100,
    viewportHeight,
    new Set(summary.map((section) => section.key)),
  )
  expect(layout.height).toBe(summary.length * BROWSE_HEADER_HEIGHT)
  const maximumHeaders =
    Math.ceil((viewportHeight + 2 * BROWSE_OVERSCAN * layout.rowHeight) / BROWSE_HEADER_HEIGHT) + 2
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const scrollTop = Math.max(0, layout.height - viewportHeight) * fraction
    const rows = visibleBrowseRows(layout, scrollTop, viewportHeight)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(maximumHeaders)
    expect(rows.every((row) => row.kind === 'header')).toBe(true)
    for (const row of rows) {
      expect(row.top + BROWSE_HEADER_HEIGHT).toBeGreaterThanOrEqual(
        Math.max(0, scrollTop - BROWSE_OVERSCAN * layout.rowHeight),
      )
      expect(row.top).toBeLessThanOrEqual(
        scrollTop + viewportHeight + BROWSE_OVERSCAN * layout.rowHeight,
      )
    }
  }
})

test('keyboard navigation skips folded sections in each direction and clamps to an expanded boundary', () => {
  const summary = sections([3, 4, 2, 5, 3])
  const collapsed = new Set([summary[0].key, summary[2].key, summary[4].key])
  const layout = createBrowseLayout(summary, 1100, 500, collapsed)
  for (const [index, previous, next] of [
    [-100, 3, 3],
    [0, 3, 3],
    [2, 3, 3],
    [3, 3, 3],
    [6, 6, 6],
    [7, 6, 9],
    [8, 6, 9],
    [9, 9, 9],
    [13, 13, 13],
    [14, 13, 13],
    [16, 13, 13],
    [100, 13, 13],
  ]) {
    expect(browseNavigableIndex(layout, index, -1), `previous from ${index}`).toBe(previous)
    expect(browseNavigableIndex(layout, index, 1), `next from ${index}`).toBe(next)
  }
  const traverse = (start: number, direction: -1 | 1) => {
    const visited: number[] = []
    let current = browseNavigableIndex(layout, start, direction)
    while (current !== null && visited.length < 17) {
      visited.push(current)
      const next = browseNavigableIndex(layout, current + direction, direction)
      if (next === current) break
      current = next
    }
    return visited
  }
  const expanded = [3, 4, 5, 6, 9, 10, 11, 12, 13]
  expect(traverse(-100, 1)).toEqual(expanded)
  expect(traverse(100, -1)).toEqual([...expanded].reverse())
  const allExpanded = createBrowseLayout(summary, 1100)
  expect(browseNavigableIndex(allExpanded, -100, -1)).toBe(0)
  expect(browseNavigableIndex(allExpanded, 100, 1)).toBe(16)
  const allFolded = createBrowseLayout(
    summary,
    1100,
    500,
    new Set(summary.map((section) => section.key)),
  )
  for (const direction of [-1, 1] as const) {
    for (const index of [-100, 0, 8, 16, 100])
      expect(browseNavigableIndex(allFolded, index, direction)).toBeNull()
    expect(browseNavigableIndex(createBrowseLayout([], 1100), 0, direction)).toBeNull()
  }
})
