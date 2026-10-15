import { test, expect } from '@playwright/test'
import {
  defaultExportOptions,
  exportCounts,
  exportFilename,
  exportGeometry,
  exportPresets,
  validateExportOptions,
} from '../src/shared/export'
import { halfFloat } from '../src/main/export/codec'
import {
  buildPhotoMenu,
  photoActionIds,
  type PhotoActionsContext,
} from '../src/shared/photo-actions'

test('quick JPEG presets keep automatic original-size output and safe metadata defaults', () => {
  expect(exportPresets.map((p) => [p.label, p.quality])).toEqual([
    ['Maximum quality', 100],
    ['High quality', 90],
    ['Smaller file', 80],
  ])
  expect(defaultExportOptions).toMatchObject({
    quality: 90,
    output: 'auto',
    size: { mode: 'original' },
    existing: 'rename',
    metadata: 'camera-copyright',
  })
  expect(validateExportOptions(defaultExportOptions)).toEqual(defaultExportOptions)
  for (const patch of [
    { quality: 0 },
    { quality: 101 },
    { quality: 90.5 },
    { version: 2 },
    { path: '/tmp' },
    { existing: 'replace' },
    { metadata: 'all' },
    { size: { mode: 'fit', width: 0, height: 3 } },
    { size: { mode: 'longest', edge: 4.5 } },
    { size: { mode: 'original', width: 8 } },
    { names: { mode: 'sequence', prefix: '../' } },
  ])
    expect(() => validateExportOptions({ ...defaultExportOptions, ...patch })).toThrow()
})
test('linear rendition geometry preserves aspect ratio without enlargement, including odd dimensions', () => {
  expect(exportGeometry(4001, 3001, { mode: 'longest', edge: 2000 })).toEqual({
    width: 2000,
    height: 1500,
  })
  expect(exportGeometry(17, 31, { mode: 'fit', width: 10, height: 10 })).toEqual({
    width: 5,
    height: 10,
  })
  expect(exportGeometry(17, 31, { mode: 'fit', width: 1000, height: 1000 })).toEqual({
    width: 17,
    height: 31,
  })
  expect(exportGeometry(32768, 1, { mode: 'longest', edge: 1 })).toEqual({ width: 1, height: 1 })
})
test('output names stay in one directory and sequence follows frozen job order', () => {
  expect(exportFilename('Photo.ARW', { mode: 'original', suffix: '-edited' }, 9)).toBe(
    'Photo-edited.jpg',
  )
  expect(exportFilename('../../CON.ARW', { mode: 'original', suffix: '' }, 0)).toBe('_CON.jpg')
  expect(exportFilename('ignored.PNG', { mode: 'sequence', prefix: 'Trip-' }, 0)).toBe(
    'Trip-0001.jpg',
  )
  expect(exportFilename('ignored.PNG', { mode: 'sequence', prefix: 'Trip-' }, 124)).toBe(
    'Trip-0125.jpg',
  )
})
test('HDR counts and half-float units are explicit', () => {
  const p = {
    id: '',
    targets: Array.from({ length: 3 }, () => ({
      photoId: '',
      filename: '',
      revision: 0,
      hdr: true,
    })),
    hdr: 2,
    sdr: 1,
  }
  expect(exportCounts(p, 'auto')).toEqual({ hdr: 2, sdr: 1 })
  expect(exportCounts(p, 'sdr')).toEqual({ hdr: 0, sdr: 3 })
  expect(halfFloat(0)).toBe(0)
  expect(halfFloat(1)).toBe(0x3c00)
  expect(halfFloat(2 ** -24)).toBe(1)
  expect(halfFloat(1 + 2 ** -11)).toBe(0x3c00)
  expect(() => halfFloat(Infinity)).toThrow()
})
test('photo menus deduplicate identical export targets while keeping distinct focused targets', () => {
  const photo = {
    id: 'a',
    filename: 'photo',
    format: 'JPG',
    assetKind: 'original' as const,
    groupId: null,
    groupRevision: null,
  }
  const context: PhotoActionsContext = {
    photo,
    selection: [photo],
    group: null,
    galleryRevision: 0,
    catalogRevision: 0,
    originalArwCount: 0,
    targetsCurrent: true,
    targetIdentity: '',
    equivalent: { photoSelection: true, groupSelection: false, mergeInputs: false },
    availability: Object.fromEntries(
      photoActionIds.map((id) => [
        id,
        { kind: id.endsWith('export') ? 'applicable' : 'inapplicable' },
      ]),
    ) as PhotoActionsContext['availability'],
  }
  const ids = () =>
    buildPhotoMenu(context, false).sections.flatMap((s) => s.actions.map((a) => a.id))
  expect(ids()).toEqual(['selection-export'])
  context.equivalent.photoSelection = false
  expect(ids()).toEqual(['photo-export', 'selection-export'])
})
