import { test, expect } from '@playwright/test'
import {
  CAPTURE_METADATA_VERSION,
  CAPTURE_SEQUENCE_PROFILE,
  captureMetadata,
  detectCaptureSequences,
  verifyCaptureSequence,
} from '../src/shared/capture-sequence'
import { sequenceFrames } from './capture.helpers'
import { bracketFrames } from './brk.helpers'

test('capture v2 records numeric shutter seconds and rejects invalid optional exposures', () => {
  for (const shutter of [0.001, 0.8, 3.2])
    expect(captureMetadata({ 'ExifIFD:ExposureTime': shutter }, 'ARW')).toMatchObject({
      version: CAPTURE_METADATA_VERSION,
      shutterSeconds: shutter,
    })
  for (const shutter of ['1/125', 0, -1, NaN, Infinity, null])
    expect(
      captureMetadata({ 'ExifIFD:ExposureTime': shutter }, 'ARW').shutterSeconds,
    ).toBeUndefined()
})

test('a partial BRK prefix has the same stable trigger key as the completed shuffled bracket', () => {
  const frames = bracketFrames(),
    partial = verifyCaptureSequence(frames.slice(0, 2))!,
    full = verifyCaptureSequence([frames[2], frames[0], frames[1]])!
  expect(partial).toMatchObject({ kind: 'bracket', expectedLength: 3, complete: false })
  expect(full).toMatchObject({ key: partial.key, complete: true, ids: frames.map((f) => f.id) })
  expect(verifyCaptureSequence(frames.slice(0, 1))).toBeNull()
  expect(verifyCaptureSequence(frames.slice(1))).toBeNull()
  expect(verifyCaptureSequence([frames[0], frames[2]])).toBeNull()
  expect(verifyCaptureSequence([frames[0], frames[0]])).toBeNull()
})

test('both evidenced continuous modes work while version 1 preserves existing group keys', () => {
  const current = sequenceFrames(),
    old = current.map((f) => ({ ...f, metadata: { ...f.metadata, version: 1 } }))
  expect(verifyCaptureSequence(old)).toEqual(verifyCaptureSequence(current))
  expect(verifyCaptureSequence(old)!.profile).toBe(CAPTURE_SEQUENCE_PROFILE)
  const high = current.map((f) => ({ ...f, metadata: { ...f.metadata, releaseMode2: 33 } }))
  expect(verifyCaptureSequence(high)).toMatchObject({ kind: 'continuous', complete: true })
  expect(verifyCaptureSequence(high)!.key).not.toBe(verifyCaptureSequence(old)!.key)
})

test('BRK allows long exposures only inside the shutter-dependent adjacent timing bound', () => {
  const frames = bracketFrames(3, 0, 3.2)
  frames[0].metadata.preciseTime = '2026-10-04T20:37:46.080'
  frames[1].metadata.preciseTime = '2026-10-04T20:37:50.280'
  frames[2].metadata.preciseTime = '2026-10-04T20:37:51.500'
  expect(verifyCaptureSequence(frames)?.complete).toBe(true)
  frames[1].metadata.preciseTime = '2026-10-04T20:37:50.280000001'
  expect(verifyCaptureSequence(frames)).toBeNull()
  expect(
    verifyCaptureSequence(
      frames.map((f) => ({ ...f, metadata: { ...f.metadata, shutterSeconds: 0.01 } })),
    ),
  ).toBeNull()
  const continuous = sequenceFrames(2)
  continuous[1].metadata = {
    ...continuous[1].metadata,
    preciseTime: '2026-10-04T14:42:34.080',
    shutterSeconds: 10,
  }
  expect(verifyCaptureSequence(continuous)).toBeNull()
})

test('counter resets and mode changes separate neighboring shutter presses', () => {
  const first = bracketFrames(2),
    second = bracketFrames(3, 3).map((f) => ({
      ...f,
      metadata: {
        ...f.metadata,
        preciseTime: f.metadata.preciseTime!.replace('14:42:32', '14:42:33'),
      },
    })),
    continuous = sequenceFrames(2).map((f) => ({
      id: `a${f.id.slice(1)}`,
      metadata: {
        ...f.metadata,
        preciseTime: f.metadata.preciseTime!.replace('14:42:32', '14:42:34'),
      },
    }))
  expect(detectCaptureSequences([...second, ...continuous, ...first]).map((s) => s.ids)).toEqual(
    [first, second, continuous].map((fs) => fs.map((f) => f.id)),
  )
  expect(verifyCaptureSequence([...first, ...second])).toBeNull()
})

test('contradictory counters, gaps, ambiguous times and different camera identities stay manual', () => {
  for (const patch of [
    { sequenceImageNumber: 9 },
    { sequenceFileNumber: undefined },
    { preciseTime: undefined },
    { preciseTime: '2026-10-04T14:42:32.080' },
    { serial: 'other-body' },
    { driveMode: 5 },
    { version: 99 },
  ]) {
    const frames = bracketFrames()
    frames[1].metadata = { ...frames[1].metadata, ...patch }
    expect(verifyCaptureSequence(frames)).toBeNull()
  }
  const single = bracketFrames().map((f) => ({
    ...f,
    metadata: { ...f.metadata, releaseMode2: 23, sequenceLength: 1 },
  }))
  expect(detectCaptureSequences(single)).toEqual([])
})
