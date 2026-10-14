import { test, expect } from '@playwright/test'
import type { Photo } from '../src/shared/contracts'
import { galleryPosition, projectGallery, type StackSummary } from '../src/shared/stacks'

const photos: Photo[] = Array.from({ length: 65 }, (_, i) => ({
  id: String(i),
  filename: `photo-${i}.jpg`,
  width: 10,
  height: 10,
  format: 'JPG',
  bytes: 1,
  importedAt: '2026',
  thumbnailUrl: '',
  previewUrl: '',
  previewSource: 'image',
}))
const summary: StackSummary = {
  id: 'stack',
  coverId: '59',
  count: 4,
  expanded: false,
  origin: 'merge',
  revision: 0,
}
const stack = { summary, memberIds: ['59', '61', '63', '60'] }

test('collapsed covers are ordinary photo rows and counts distinguish recipes from memberships', () => {
  const entries = projectGallery(photos, [stack], new Map([['59', 2]]))
  expect(entries).toHaveLength(62)
  expect(entries[59]).toMatchObject({
    photo: { id: '59' },
    stack: { count: 4 },
    memberIndex: 0,
    mergeSourceCount: 2,
  })
  expect(entries.some((e) => e.photo.id === '61')).toBe(false)
  expect(galleryPosition(entries, '61', '59')).toBe(59)
  expect(galleryPosition(entries, '0', '59')).toBe(0)
})
test('expanded members stay contiguous in persisted order across 60-row transport chunks with their parent', () => {
  const entries = projectGallery(photos, [{ ...stack, summary: { ...summary, expanded: true } }])
  expect(entries).toHaveLength(65)
  expect(entries.slice(59, 63).map((e) => e.photo.id)).toEqual(['59', '61', '63', '60'])
  expect(entries[60]).toMatchObject({
    cover: { id: '59', filename: 'photo-59.jpg' },
    memberIndex: 1,
  })
  expect(galleryPosition(entries, '63', '59')).toBe(61)
})
