import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  editCheckpointName,
  editCheckpointNameKey,
  validateCheckpointSettings,
  validateEditCheckpoint,
  validateEditComparisonSource,
} from '../src/shared/edit-checkpoints'
import { initialSettings } from '../src/shared/edits'

test('version names normalize uniqueness while rejecting empty, long and invisible names', () => {
  expect(editCheckpointName('  Natural  ')).toBe('Natural')
  expect(editCheckpointNameKey('ＮＡＴＵＲＡＬ')).toBe(editCheckpointNameKey('natural'))
  for (const value of ['', '  ', 'x'.repeat(101), 'Natural\nlook', 'Look\u200b'])
    expect(() => editCheckpointName(value)).toThrow('version name')
})

test('saved versions require complete validated settings and immutable metadata envelopes', () => {
  const checkpoint = {
    version: 1,
    kind: 'checkpoint',
    id: randomUUID(),
    photoId: 'a'.repeat(64),
    name: 'Natural',
    revision: 1,
    capturedFromRevision: 0,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    settings: initialSettings(),
  }
  expect(() => validateEditCheckpoint(checkpoint)).not.toThrow()
  for (const settings of [
    { ...checkpoint.settings, version: 999 },
    { ...checkpoint.settings, exposureEv: NaN },
    { ...checkpoint.settings, lens: { distortion: false } },
    { ...checkpoint.settings, curves: {} },
    { ...checkpoint.settings, noiseReduction: { luminance: 4 } },
    { ...checkpoint.settings, maskStack: [{ id: randomUUID() }] },
    { ...checkpoint.settings, arbitrary: true },
  ])
    expect(() => validateCheckpointSettings(settings)).toThrow()
  for (const patch of [
    { version: 2 },
    { revision: 0 },
    { capturedFromRevision: -1 },
    { name: ' Natural ' },
    { path: '/private' },
  ])
    expect(() => validateEditCheckpoint({ ...checkpoint, ...patch })).toThrow()
})

test('comparison source references explicitly distinguish saved checkpoints from Current freshness', () => {
  expect(() => validateEditComparisonSource({ kind: 'current', expectedRevision: 0 })).not.toThrow()
  expect(() =>
    validateEditComparisonSource({
      kind: 'checkpoint',
      checkpointId: randomUUID(),
      expectedCheckpointRevision: 1,
    }),
  ).not.toThrow()
  for (const source of [
    { kind: 'current' },
    { kind: 'revision', revision: 2 },
    { kind: 'checkpoint', checkpointId: randomUUID(), expectedCheckpointRevision: 0 },
    { kind: 'current', expectedRevision: 1, settings: initialSettings() },
  ])
    expect(() => validateEditComparisonSource(source)).toThrow()
})
