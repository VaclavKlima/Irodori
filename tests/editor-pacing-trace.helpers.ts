export interface SavedEditorTraceMark {
  name: string
  startTime: number
  timeOrigin: number
}

export interface EditorPacingTraceExpectation {
  rendererPid: number
  markers: readonly [SavedEditorTraceMark, SavedEditorTraceMark]
  trial: { inputStartedAt: number; inputReleasedAt: number; inputCount: number }
  bufferUsagePercentage?: number | null
}

interface TraceEvent {
  name?: unknown
  cat?: unknown
  ph?: unknown
  pid?: unknown
  tid?: unknown
  ts?: unknown
  dur?: unknown
  args?: unknown
}

export interface EditorPacingTraceCompleteness {
  complete: boolean
  reasons: { code: string; detail: string }[]
  observations: {
    rendererPid: number
    rendererThreadId: number | null
    bufferUsagePercentage: number | null
    markers: {
      name: string
      matchingEvents: number
      rendererEvents: number
      timestampUs: number | null
      offsetMs: number | null
    }[]
    clockToleranceMs: number
    offsetMs: number | null
    offsetDifferenceMs: number | null
    firstRendererAtMs: number | null
    lastRendererAtMs: number | null
    expectedInputEvents: number
    matchingInputEvents: number
    otherRendererInputEvents: number
    lossStatistics: {
      state: 'unavailable' | 'loss-observed' | 'no-loss-observed'
      buffers: Record<string, unknown>[]
      counters: { path: string; value: unknown }[]
    }
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const timingCategory = (value: unknown) =>
  typeof value === 'string' && value.split(',').includes('blink.user_timing')

// A trace timestamp has microsecond resolution; renderer performance clocks can
// have 0.1ms quantization. This bound is explicit and never infers completeness
// from buffer usage, event cadence or an estimated trace duration.
const clockToleranceMs = 0.1
const savedMarkToleranceMs = 0.000001
const requiredBufferCounters = ['chunks_discarded', 'bytes_overwritten', 'chunks_overwritten']
const lossCounter = (name: string) =>
  name.startsWith('data_loss_') ||
  /(?:discarded|overwritten|(?:^|_)(?:lost|dropped|overrun)(?:_|$))/.test(name)

/** Validate the retained renderer/input window, not every category's fidelity. */
export function assessEditorPacingTrace(
  parsedTrace: unknown,
  expected: EditorPacingTraceExpectation,
): EditorPacingTraceCompleteness {
  const reasons: EditorPacingTraceCompleteness['reasons'] = []
  const fail = (code: string, detail: string) => reasons.push({ code, detail })
  const root = object(parsedTrace)
  const events = Array.isArray(root?.traceEvents)
    ? (root.traceEvents.filter((event) => object(event)) as TraceEvent[])
    : []
  if (!Array.isArray(root?.traceEvents))
    fail('trace-events-unavailable', 'traceEvents is absent or invalid.')
  const { inputStartedAt, inputReleasedAt, inputCount } = expected.trial
  if (
    !Number.isInteger(expected.rendererPid) ||
    expected.rendererPid <= 0 ||
    !finite(inputStartedAt) ||
    !finite(inputReleasedAt) ||
    inputReleasedAt < inputStartedAt ||
    !Number.isInteger(inputCount) ||
    inputCount <= 0
  )
    fail(
      'invalid-capture-input',
      'A recorded PID, finite ordered input interval and positive exact count are required.',
    )
  const [before, after] = expected.markers
  if (
    !before.name ||
    !after.name ||
    before.name === after.name ||
    !finite(before.startTime) ||
    !finite(after.startTime) ||
    !finite(before.timeOrigin) ||
    before.timeOrigin !== after.timeOrigin ||
    before.startTime > inputStartedAt ||
    after.startTime < inputReleasedAt
  )
    fail(
      'saved-marks-invalid',
      'Two unique saved marks from the same renderer clock must bracket the input interval.',
    )

  const matched = expected.markers.map((saved) => {
    const named = events.filter((event) => event.name === saved.name && timingCategory(event.cat))
    const renderer = named.filter((event) => event.pid === expected.rendererPid)
    if (named.length !== 1)
      fail('mark-missing-or-duplicate', `${saved.name}: found ${named.length} trace marks.`)
    if (named.length > 0 && renderer.length !== 1)
      fail(
        'mark-wrong-renderer',
        `${saved.name}: expected one mark on PID ${expected.rendererPid}.`,
      )
    const event = named.length === 1 && renderer.length === 1 ? renderer[0] : null
    const data = object(object(event?.args)?.data)
    if (
      event &&
      (event.ph !== 'I' ||
        !finite(event.ts) ||
        !Number.isInteger(event.tid) ||
        !finite(data?.startTime) ||
        Math.abs(data.startTime - saved.startTime) > savedMarkToleranceMs)
    )
      fail(
        'trace-mark-invalid',
        `${saved.name}: expected a timestamped instant mark with its saved performance startTime.`,
      )
    return { saved, event }
  })
  const first = matched[0].event
  const last = matched[1].event
  const thread = Number.isInteger(first?.tid) ? (first!.tid as number) : null
  if (first && last && first.tid !== last.tid)
    fail('mark-thread-mismatch', 'The two marks are not on the same renderer thread.')
  if (finite(first?.ts) && finite(last?.ts) && first.ts > last.ts)
    fail('mark-order-mismatch', 'The end mark precedes the start mark in the trace clock.')
  const offsets = matched.map(({ saved, event }) =>
    finite(event?.ts) && finite(saved.startTime) ? event.ts / 1000 - saved.startTime : null,
  )
  const difference =
    offsets[0] !== null && offsets[1] !== null ? Math.abs(offsets[0] - offsets[1]) : null
  if (difference !== null && difference > clockToleranceMs)
    fail('clock-offset-mismatch', `The two trace-to-performance offsets differ by ${difference}ms.`)
  const offset = offsets[0] ?? offsets[1]
  const rendererEvents = events.filter(
    (event) => event.pid === expected.rendererPid && event.tid === thread && finite(event.ts),
  )
  let firstRenderer: number | null = null
  let lastRenderer: number | null = null
  if (offset !== null)
    for (const event of rendererEvents) {
      const start = (event.ts as number) / 1000 - offset
      const end =
        ((event.ts as number) + (finite(event.dur) && event.dur >= 0 ? event.dur : 0)) / 1000 -
        offset
      firstRenderer = firstRenderer === null ? start : Math.min(firstRenderer, start)
      lastRenderer = lastRenderer === null ? end : Math.max(lastRenderer, end)
    }
  if (
    firstRenderer === null ||
    lastRenderer === null ||
    firstRenderer > inputStartedAt + clockToleranceMs ||
    lastRenderer < inputReleasedAt - clockToleranceMs
  )
    fail(
      'input-window-not-covered',
      'The recorded renderer thread does not span the complete input interval.',
    )
  const inputEvent = (event: TraceEvent) =>
    event.name === 'EventDispatch' && object(object(event.args)?.data)?.type === 'input'
  const duringInput = (event: TraceEvent) =>
    offset !== null &&
    finite(event.ts) &&
    event.ts / 1000 - offset >= inputStartedAt - clockToleranceMs &&
    event.ts / 1000 - offset <= inputReleasedAt + clockToleranceMs
  const matchingInputs = rendererEvents.filter(
    (event) =>
      inputEvent(event) &&
      event.ph === 'X' &&
      finite(event.dur) &&
      event.dur >= 0 &&
      duringInput(event),
  )
  if (matchingInputs.length !== inputCount)
    fail(
      'input-event-count-mismatch',
      `Expected ${inputCount} input EventDispatch events; found ${matchingInputs.length}.`,
    )

  const stats = object(object(root?.metadata)?.trace_processor_stats)
  const buffers = Array.isArray(stats?.traced_buf) ? stats.traced_buf.map(object) : []
  const counters: { path: string; value: unknown }[] = []
  let available = buffers.length > 0 && buffers.every((buffer) => buffer !== null)
  let lossObserved = false
  const inspect = (values: Record<string, unknown>, path: string) => {
    for (const [name, value] of Object.entries(values)) {
      if (!lossCounter(name)) continue
      counters.push({ path: `${path}.${name}`, value })
      if (!finite(value) || !Number.isInteger(value) || value < 0) available = false
      else if (value > 0) lossObserved = true
    }
  }
  if (stats) inspect(stats, 'metadata.trace_processor_stats')
  buffers.forEach((buffer, index) => {
    if (!buffer) return
    for (const name of requiredBufferCounters) if (!(name in buffer)) available = false
    inspect(buffer, `metadata.trace_processor_stats.traced_buf[${index}]`)
  })
  if (!available)
    fail(
      'loss-statistics-unavailable',
      'Every trace buffer needs finite discarded/overwritten counters; unknown statistics cannot establish completeness.',
    )
  if (lossObserved)
    fail('trace-data-loss', 'Perfetto reports discarded, lost or overwritten trace data.')
  return {
    complete: reasons.length === 0,
    reasons,
    observations: {
      rendererPid: expected.rendererPid,
      rendererThreadId: thread,
      bufferUsagePercentage: finite(expected.bufferUsagePercentage)
        ? expected.bufferUsagePercentage
        : null,
      markers: matched.map(({ saved, event }, index) => ({
        name: saved.name,
        matchingEvents: events.filter(
          (entry) => entry.name === saved.name && timingCategory(entry.cat),
        ).length,
        rendererEvents: events.filter(
          (entry) =>
            entry.name === saved.name &&
            timingCategory(entry.cat) &&
            entry.pid === expected.rendererPid,
        ).length,
        timestampUs: finite(event?.ts) ? event.ts : null,
        offsetMs: offsets[index],
      })),
      clockToleranceMs,
      offsetMs: offset,
      offsetDifferenceMs: difference,
      firstRendererAtMs: firstRenderer,
      lastRendererAtMs: lastRenderer,
      expectedInputEvents: inputCount,
      matchingInputEvents: matchingInputs.length,
      otherRendererInputEvents: events.filter(
        (event) => inputEvent(event) && event.pid !== expected.rendererPid && duringInput(event),
      ).length,
      lossStatistics: {
        state: lossObserved ? 'loss-observed' : available ? 'no-loss-observed' : 'unavailable',
        buffers: buffers.filter((buffer): buffer is Record<string, unknown> => buffer !== null),
        counters,
      },
    },
  }
}
