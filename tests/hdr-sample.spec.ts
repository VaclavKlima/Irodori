import { expect, test } from '@playwright/test'
import {
  hdrSampleMemory,
  observeHdrSample,
  publishHdrSample,
  selectHdrSampleSources,
} from '../src/renderer/src/preview/hdr-sample'

const hash = (value: string) => value.repeat(64)
function planes(value: number) {
  const buffer = new ArrayBuffer(48),
    data = new Float32Array(buffer, 0, 8),
    draft = new Float32Array(buffer, 32, 4)
  data.set([value, value, value, 1, value, value, value, 1])
  draft.set([value, value, value, 1])
  return { buffer, data, draft }
}

test('source observers retain both domains without cloning or notifying the other source', () => {
  const after = planes(0.2),
    before = planes(0.8),
    calls: string[] = []
  selectHdrSampleSources(hash('a'), hash('b'))
  const stopAfter = observeHdrSample(hash('a'), (data, draft) => {
      expect(data).toBe(after.data)
      expect(draft).toBe(after.draft)
      calls.push('after')
    }),
    stopBefore = observeHdrSample(hash('b'), (data, draft) => {
      expect(data).toBe(before.data)
      expect(draft).toBe(before.draft)
      calls.push('before')
    })
  try {
    publishHdrSample(hash('a'), after.data, after.draft)
    publishHdrSample(hash('b'), before.data, before.draft)
    publishHdrSample(hash('a'), after.data, after.draft)
    expect(calls).toEqual(['after', 'before'])
    expect(hdrSampleMemory()).toBe(96)
    expect(hdrSampleMemory((buffer) => buffer === before.buffer)).toBe(48)
    let retained: Float32Array | undefined
    const stop = observeHdrSample(hash('b'), (data) => (retained = data))
    expect(retained).toBe(before.data)
    stop()
    stopBefore()
    publishHdrSample(hash('b'), new Float32Array(8), new Float32Array(4))
    expect(calls).toEqual(['after', 'before'])
  } finally {
    stopAfter()
    stopBefore()
    selectHdrSampleSources(hash('f'))
  }
})

test('new source selections release obsolete planes and reject late publication while aliases share one allocation', () => {
  const first = planes(0.2),
    shared = planes(0.8)
  selectHdrSampleSources(hash('a'), hash('b'))
  publishHdrSample(hash('a'), first.data, first.draft)
  publishHdrSample(hash('b'), shared.data, shared.draft)
  selectHdrSampleSources(hash('b'), hash('b'))
  expect(hdrSampleMemory()).toBe(48)
  publishHdrSample(hash('a'), first.data, first.draft)
  expect(hdrSampleMemory()).toBe(48)
  expect(() => selectHdrSampleSources('invalid', hash('c'))).toThrow('identity')
  expect(hdrSampleMemory()).toBe(48)
  selectHdrSampleSources(hash('c'), hash('d'))
  expect(hdrSampleMemory()).toBe(0)
  publishHdrSample(hash('b'), shared.data, shared.draft)
  expect(hdrSampleMemory()).toBe(0)
})
