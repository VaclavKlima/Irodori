import { expect, test } from '@playwright/test'
import {
  assessEditorPacingTrace,
  type EditorPacingTraceExpectation,
} from './editor-pacing-trace.helpers'

const expected: EditorPacingTraceExpectation = {
  rendererPid: 42,
  markers: [
    { name: 'unique-before', startTime: 100, timeOrigin: 1_700_000_000_000 },
    { name: 'unique-after', startTime: 500, timeOrigin: 1_700_000_000_000 },
  ],
  trial: { inputStartedAt: 150, inputReleasedAt: 450, inputCount: 3 },
}

const mark = (name: string, startTime: number, offset = 1000) => ({
  name,
  cat: 'blink.user_timing',
  ph: 'I',
  pid: 42,
  tid: 1,
  ts: (offset + startTime) * 1000,
  args: { data: { startTime, callTime: (offset + startTime) * 1000 + 8 } },
})
const input = (at: number, offset = 1000) => ({
  name: 'EventDispatch',
  cat: 'devtools.timeline',
  ph: 'X',
  pid: 42,
  tid: 1,
  ts: (offset + at) * 1000,
  dur: 0,
  args: { data: { type: 'input' } },
})
const buffer = () => ({
  buffer_size: 16_777_216,
  bytes_written: 4096,
  chunks_discarded: 0,
  bytes_overwritten: 0,
  chunks_overwritten: 0,
  write_wrap_count: 0,
  readaheads_failed: 0,
})
const valid = () => ({
  traceEvents: [
    mark('unique-before', 100),
    input(150),
    input(250),
    input(400),
    mark('unique-after', 500),
  ],
  metadata: {
    trace_processor_stats: { data_loss_packets_lost: 0, traced_buf: [buffer(), buffer()] },
  },
})
const codes = (trace: unknown, capture = expected) =>
  assessEditorPacingTrace(trace, capture).reasons.map((reason) => reason.code)

test('both renderer marks, the complete input window and explicit no-loss counters establish completeness', () => {
  const result = assessEditorPacingTrace(valid(), expected)
  expect(result.complete).toBe(true)
  expect(result.reasons).toEqual([])
  expect(result.observations).toMatchObject({
    rendererThreadId: 1,
    offsetMs: 1000,
    offsetDifferenceMs: 0,
    firstRendererAtMs: 100,
    lastRendererAtMs: 500,
    matchingInputEvents: 3,
    expectedInputEvents: 3,
    lossStatistics: { state: 'no-loss-observed' },
  })
  expect(result.observations.lossStatistics.buffers).toHaveLength(2)
})

test('the retained 99.25-percent pattern remains incomplete with discarded chunks, 130 inputs and a missing tail', () => {
  const offset = 13_113_191.433
  const before = {
    name: 'actual-pattern-before',
    startTime: 5218.5999999996275,
    timeOrigin: 1_700_000_000_000,
  }
  const after = { name: 'actual-pattern-after', startTime: 9526.8, timeOrigin: before.timeOrigin }
  const trace = {
    traceEvents: [
      { ...mark(before.name, 5218.599999999627, offset), ts: 13_118_410_033 },
      ...Array.from({ length: 130 }, (_, index) => input(7000 + index * 7, offset)),
      { ...input(7943.874, offset), name: 'RunTask', args: {} },
    ],
    metadata: {
      trace_processor_stats: {
        data_loss_packets_lost: 0,
        traced_buf: [
          {
            ...buffer(),
            bytes_written: 16_777_216,
            chunks_discarded: 4871,
            write_wrap_count: 1,
            readaheads_failed: 7493,
          },
          buffer(),
        ],
      },
    },
  }
  const result = assessEditorPacingTrace(trace, {
    ...expected,
    markers: [before, after],
    bufferUsagePercentage: 0.9925,
    trial: { inputStartedAt: 7000, inputReleasedAt: 9153.5, inputCount: 240 },
  })
  expect(result.complete).toBe(false)
  expect(result.reasons.map((reason) => reason.code)).toEqual(
    expect.arrayContaining([
      'mark-missing-or-duplicate',
      'input-window-not-covered',
      'input-event-count-mismatch',
      'trace-data-loss',
    ]),
  )
  expect(result.observations.matchingInputEvents).toBe(130)
  expect(result.observations.lastRendererAtMs).toBeCloseTo(7943.874, 6)
  expect(result.observations.bufferUsagePercentage).toBe(0.9925)
  expect(result.observations.lossStatistics.counters).toContainEqual({
    path: 'metadata.trace_processor_stats.traced_buf[0].chunks_discarded',
    value: 4871,
  })
})

test('a missing end mark stays incomplete without loss statistics or a high buffer percentage', () => {
  const trace = { traceEvents: valid().traceEvents.slice(0, -1) }
  const result = assessEditorPacingTrace(trace, { ...expected, bufferUsagePercentage: 0.2 })
  expect(result.complete).toBe(false)
  expect(result.reasons.map((reason) => reason.code)).toEqual(
    expect.arrayContaining([
      'mark-missing-or-duplicate',
      'input-window-not-covered',
      'loss-statistics-unavailable',
    ]),
  )
})

test('marks and input events from another renderer cannot satisfy the recorded PID', () => {
  const trace = valid()
  trace.traceEvents = trace.traceEvents.map((event) => ({ ...event, pid: 77 }))
  expect(codes(trace)).toContain('mark-wrong-renderer')
  expect(assessEditorPacingTrace(trace, expected).complete).toBe(false)
})

test('the two marks must retain one renderer thread and a consistent microsecond-to-performance offset', () => {
  const wrongThread = valid()
  wrongThread.traceEvents.at(-1)!.tid = 2
  expect(codes(wrongThread)).toContain('mark-thread-mismatch')
  const wrongClock = valid()
  wrongClock.traceEvents.at(-1)!.ts += 1000
  expect(codes(wrongClock)).toContain('clock-offset-mismatch')
})

test('an end mark cannot replace missing input events within a covered interval', () => {
  const trace = valid()
  trace.traceEvents.splice(2, 1)
  expect(codes(trace)).toEqual(['input-event-count-mismatch'])
})

test('loss and overwrite counters are inspected in every buffer and at processor level', () => {
  const secondBuffer = valid()
  secondBuffer.metadata.trace_processor_stats.traced_buf[1].bytes_overwritten = 1
  expect(codes(secondBuffer)).toContain('trace-data-loss')
  const globalLoss = valid()
  globalLoss.metadata.trace_processor_stats.data_loss_packets_lost = 1
  expect(codes(globalLoss)).toContain('trace-data-loss')
})

test('unknown loss statistics never turn complete marks and input counts into a complete trace', () => {
  expect(codes({ traceEvents: valid().traceEvents })).toEqual(['loss-statistics-unavailable'])
  const trace = valid()
  const incompleteCounters = { ...trace.metadata.trace_processor_stats.traced_buf[0] }
  delete (incompleteCounters as Partial<typeof incompleteCounters>).chunks_discarded
  trace.metadata.trace_processor_stats.traced_buf[0] = incompleteCounters
  expect(codes(trace)).toEqual(['loss-statistics-unavailable'])
})

test('duplicate names and saved marks from different renderer time origins are rejected', () => {
  const duplicate = valid()
  duplicate.traceEvents.push(mark('unique-after', 500))
  expect(codes(duplicate)).toContain('mark-missing-or-duplicate')
  const wrongOrigin: EditorPacingTraceExpectation = {
    ...expected,
    markers: [
      expected.markers[0],
      { ...expected.markers[1], timeOrigin: expected.markers[1].timeOrigin + 1 },
    ],
  }
  expect(codes(valid(), wrongOrigin)).toContain('saved-marks-invalid')
})
