import { expect, test } from '@playwright/test'
import { validatePreparedPreviewSourceRef } from '../src/shared/prepared-comparison'

test('comparison capabilities accept only a photo hash, cache UUID and float hash', () => {
  const valid = {
    photoId: 'a'.repeat(64),
    cacheId: '11111111-2222-3333-4444-555555555555',
    workingSha256: 'b'.repeat(64),
  }
  expect(() => validatePreparedPreviewSourceRef(valid)).not.toThrow()
  for (const value of [
    null,
    [],
    'source',
    {},
    { ...valid, photoId: '../original' },
    { ...valid, cacheId: valid.photoId },
    { ...valid, workingSha256: 'B'.repeat(64) },
    { ...valid, path: '/tmp/original.f32' },
    { ...valid, photoId: { toString: () => valid.photoId } },
    { ...valid, workingSha256: undefined },
  ])
    expect(() => validatePreparedPreviewSourceRef(value)).toThrow('Invalid prepared comparison')
})
