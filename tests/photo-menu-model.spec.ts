import { test, expect } from '@playwright/test'
import {
  buildPhotoMenu,
  photoActionIds,
  type PhotoActionsContext,
} from '../src/shared/photo-actions'

function context(): PhotoActionsContext {
  const photo = {
    id: 'a',
    filename: 'A very long focused filename.ARW',
    format: 'ARW',
    assetKind: 'original' as const,
    groupId: 'group',
    groupRevision: 0,
  }
  const second = { ...photo, id: 'b', filename: 'second.ARW' }
  return {
    photo,
    selection: [photo, second],
    group: {
      stack: {
        id: 'group',
        coverId: 'b',
        revision: 0,
        count: 2,
        expanded: false,
        origin: 'manual',
      },
      photos: [second, photo],
      originals: [second, photo],
    },
    galleryRevision: 1,
    catalogRevision: 1,
    originalArwCount: 2,
    targetsCurrent: true,
    targetIdentity: 'targets',
    equivalent: { photoSelection: false, groupSelection: true, mergeInputs: false },
    availability: Object.fromEntries(
      photoActionIds.map((id) => [id, { kind: 'applicable' }]),
    ) as PhotoActionsContext['availability'],
  }
}
const commands = (c: PhotoActionsContext, toolbar = true) =>
  buildPhotoMenu(c, toolbar).sections.flatMap((s) => s.actions)

test('flat scope headings disclose targets and put every destructive action last', () => {
  const c = context()
  const model = buildPhotoMenu(c, true)
  expect(model.sections.map((s) => s.id)).toEqual([
    'photo',
    'selection',
    'group',
    'library',
    'trash',
  ])
  expect(model.sections[0].heading).toBe(`Photo · ${c.photo!.filename}`)
  expect(model.sections[1].heading).toBe('Selection · 2 photos')
  expect(model.sections[2].heading).toBe('Photo group · 2 photos · 2 originals')
  expect(model.sections.at(-1)!.actions.map((a) => [a.id, a.scope, a.destructive])).toEqual([
    ['photo-trash', 'photo', true],
    ['selection-trash', 'selection', true],
  ])
  expect(commands(c).find((a) => a.id === 'selection-trash')?.label).toBe(
    'Move 2 selected photos to Trash…',
  )
})

test('empty sections and inapplicable actions disappear without explanatory clutter', () => {
  const c = context()
  for (const id of photoActionIds) c.availability[id] = { kind: 'inapplicable' }
  expect(buildPhotoMenu(c, true)).toEqual({ sections: [], blockers: [] })
  c.selection = [c.photo!]
  c.equivalent.photoSelection = true
  c.availability['selection-trash'] = { kind: 'applicable' }
  expect(buildPhotoMenu(c, false).sections).toHaveLength(1)
  expect(commands(c, false).map((a) => a.label)).toEqual(['Move selected photo to Trash…'])
})

test('Trash deduplicates by set but group merges retain different source order and originals-only behavior', () => {
  const c = context()
  expect(commands(c).map((a) => a.id)).toContain('group-hdr')
  c.equivalent.mergeInputs = true
  expect(commands(c).map((a) => a.id)).not.toContain('group-hdr')
  expect(commands(c).map((a) => a.id)).not.toContain('group-noise')
  c.equivalent.mergeInputs = false
  c.equivalent.groupSelection = false
  c.group!.photos.push({ ...c.photo!, id: 'result', assetKind: 'derived', format: 'IRODORI HDR' })
  c.group!.stack.count = 3
  expect(
    commands(c)
      .filter((a) => a.id.startsWith('group-'))
      .map((a) => a.id),
  ).toEqual(['group-select', 'group-hdr', 'group-noise', 'group-ungroup', 'group-trash'])
  expect(commands(c).find((a) => a.id === 'group-trash')?.label).toBe(
    'Move entire group to Trash (3 photos)…',
  )
})

test('distinct temporary reasons appear once and irrelevant toolbar operations stay out of context menus', () => {
  const c = context()
  for (const id of [
    'photo-cover',
    'photo-remove',
    'selection-group',
    'group-ungroup',
    'library-scan',
  ] as const)
    c.availability[id] = { kind: 'blocked', reason: 'Finish the current task.' }
  c.availability['photo-trash'] = { kind: 'blocked', reason: 'Close the source review.' }
  expect(buildPhotoMenu(c, true).blockers).toEqual([
    'Finish the current task.',
    'Close the source review.',
  ])
  expect(commands(c, false).map((a) => a.id)).not.toContain('library-scan')
  expect(commands(c).find((a) => a.id === 'library-scan')?.label).toBe('Group capture sequences')
  for (const action of commands(c))
    expect(action.label.endsWith('…')).toBe(
      action.id.endsWith('trash') ||
        action.id.endsWith('hdr') ||
        action.id.endsWith('noise') ||
        action.id.endsWith('export') ||
        action.id.endsWith('paste-edits'),
    )
})
