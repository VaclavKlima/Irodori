import { expect, test } from '@playwright/test'
import {
  defaultExportOptions,
  exportGeometry,
  validateExportOptions,
  exportAllowsEnlargement,
  exportResizeCapabilities,
  EXPORT_MAX_PIXELS,
} from '../src/shared/export'

test('explicit Lanczos3 enlargement preserves legacy options and rejects ambiguous resize choices', () => {
  const legacy = { ...defaultExportOptions, size: { mode: 'longest' as const, edge: 34 } }
  expect(validateExportOptions(legacy)).toEqual(legacy)
  expect(exportGeometry(17, 11, legacy.size)).toEqual({ width: 17, height: 11 })
  const selected = {
    ...legacy,
    size: { ...legacy.size, allowEnlargement: true, method: 'lanczos3' as const },
  }
  const owned = validateExportOptions(selected)
  expect(owned).toEqual(selected)
  selected.size.edge = 99
  expect(owned.size).toMatchObject({ edge: 34 })
  expect(exportAllowsEnlargement(owned.size)).toBe(true)
  expect(exportResizeCapabilities).toMatchObject({
    methods: ['lanczos3'],
    defaultAllowEnlargement: false,
    maxPixels: 33554432,
  })
  for (const size of [
    { mode: 'original', allowEnlargement: false },
    { mode: 'original', method: 'lanczos3' },
    { mode: 'longest', edge: 34, allowEnlargement: 1 },
    { mode: 'longest', edge: 34, allowEnlargement: undefined },
    { mode: 'longest', edge: 34, allowEnlargement: 'true' },
    { mode: 'longest', edge: 34, method: 'fsr' },
    { mode: 'longest', edge: 34, method: undefined },
    { mode: 'fit', width: 34, height: 22, allowEnlargement: null },
    { mode: 'fit', width: 34, height: 22, scale: 2 },
  ])
    expect(() => validateExportOptions({ ...legacy, size })).toThrow()
})

test('enlargement uses uniform crop-sized geometry and preserves fit bounds for portrait and odd dimensions', () => {
  expect(exportGeometry(17, 11, { mode: 'longest', edge: 34, allowEnlargement: true })).toEqual({
    width: 34,
    height: 22,
  })
  expect(exportGeometry(17, 31, { mode: 'longest', edge: 63, allowEnlargement: true })).toEqual({
    width: 35,
    height: 63,
  })
  expect(
    exportGeometry(17, 11, { mode: 'fit', width: 100, height: 31, allowEnlargement: true }),
  ).toEqual({ width: 48, height: 31 })
  for (const width of [1, 3, 17, 101])
    for (const height of [1, 7, 31, 83]) {
      const resized = exportGeometry(width, height, {
        mode: 'fit',
        width: 139,
        height: 97,
        allowEnlargement: true,
      })
      expect(resized.width).toBeLessThanOrEqual(139)
      expect(resized.height).toBeLessThanOrEqual(97)
      expect(resized.width).toBeGreaterThan(0)
      expect(resized.height).toBeGreaterThan(0)
      const scale = Math.min(139 / width, 97 / height)
      expect(Math.abs(resized.width - width * scale)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(resized.height - height * scale)).toBeLessThanOrEqual(0.5)
    }
  expect(exportGeometry(17, 11, { mode: 'longest', edge: 34, allowEnlargement: false })).toEqual({
    width: 17,
    height: 11,
  })
})

test('enlargement refuses excess dimensions and pixels without allocating or reducing the requested output', () => {
  expect(exportGeometry(32, 1, { mode: 'longest', edge: 32768, allowEnlargement: true })).toEqual({
    width: 32768,
    height: 1024,
  })
  expect(EXPORT_MAX_PIXELS).toBe(32768 * 1024)
  expect(() =>
    exportGeometry(1, 1, { mode: 'longest', edge: 32768, allowEnlargement: true }),
  ).toThrow('floating-point image limit')
  expect(() =>
    exportGeometry(1, 1, { mode: 'fit', width: 32769, height: 2, allowEnlargement: true }),
  ).toThrow('1 to 32768')
  expect(defaultExportOptions.size).toEqual({ mode: 'original' })
})
