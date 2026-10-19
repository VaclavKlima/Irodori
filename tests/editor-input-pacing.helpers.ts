export type EditorInputPacingMode = 'native-raf' | 'timer-deadline-v1'

export interface EditorInputPacingClock {
  now(): number
  timeout(callback: () => void, delayMs: number): number
  clearTimeout(id: number): void
  raf(callback: (timestamp: number) => void): number
  cancelRaf(id: number): void
}

/** Self-contained so evaluateHandle transfers this executable factory without eval. */
export function createEditorInputPacer(
  options: { mode: EditorInputPacingMode; frequency: 60 | 120 },
  suppliedClock?: EditorInputPacingClock,
) {
  if (!['native-raf', 'timer-deadline-v1'].includes(options.mode))
    throw new Error('Unknown editor input pacing mode.')
  if (options.mode === 'timer-deadline-v1' && options.frequency !== 120)
    throw new Error('Timer-deadline pacing is an explicit 120 Hz load only.')
  const clock: EditorInputPacingClock = suppliedClock ?? {
    now: () => performance.now(),
    timeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (id) => window.clearTimeout(id),
    raf: (callback) => requestAnimationFrame(callback),
    cancelRaf: (id) => cancelAnimationFrame(id),
  }
  const nativeRafSamples: { timestamp: number; observedAt: number }[] = []
  const dispatches: {
    index: number
    scheduledAt: number
    readyAt: number
    dispatchAt?: number
    dispatchLatenessMs?: number
    raf: number | null
  }[] = []
  const cancellations = new Set<() => void>()
  let startedAt: number | null = null,
    stoppedAt: number | null = null,
    deadline = 0,
    nextIndex = 0,
    nativeRaf: number | null = null,
    rafHandle: number | null = null,
    omittedNativeRafSamples = 0
  const wait = (kind: 'timer' | 'raf', delayMs = 0) =>
    new Promise<number>((resolve, reject) => {
      if (stoppedAt !== null) {
        reject(new Error('Editor input pacer is stopped.'))
        return
      }
      const cancel = () => {
        if (kind === 'timer') clock.clearTimeout(id)
        else clock.cancelRaf(id)
        cancellations.delete(cancel)
        reject(new Error('Editor input pacer is stopped.'))
      }
      const done = (at: number) => {
        cancellations.delete(cancel)
        resolve(at)
      }
      cancellations.add(cancel)
      const id: number =
        kind === 'timer'
          ? clock.timeout(() => done(clock.now()), Math.ceil(delayMs))
          : clock.raf(done)
    })
  const observeNativeFrame = (timestamp: number) => {
    if (stoppedAt !== null) return
    nativeRaf = timestamp
    if (nativeRafSamples.length < 4096)
      nativeRafSamples.push({ timestamp, observedAt: clock.now() })
    else omittedNativeRafSamples++
    rafHandle = clock.raf(observeNativeFrame)
  }
  return {
    async start() {
      if (startedAt !== null) throw new Error('Editor input pacer has already started.')
      if (stoppedAt !== null) throw new Error('Editor input pacer is stopped.')
      startedAt = clock.now()
      rafHandle = clock.raf(observeNativeFrame)
      // Preserve the existing native-rAF phase, including its initial frame.
      deadline = options.mode === 'native-raf' ? await wait('raf') : startedAt
    },
    async next() {
      if (startedAt === null) throw new Error('Editor input pacer has not started.')
      const scheduledAt = deadline
      let raf: number | null
      if (options.mode === 'native-raf') {
        raf = await wait('raf')
        while (raf + 0.1 < scheduledAt) raf = await wait('raf')
      } else {
        // Even an overdue deadline yields a new timer task. Never dispatch a
        // synchronous burst to conceal event-loop blocking or missed deadlines.
        await wait('timer', Math.max(0, scheduledAt - clock.now()))
        while (clock.now() < scheduledAt)
          await wait('timer', Math.max(0, scheduledAt - clock.now()))
        raf = nativeRaf
      }
      const tick = { index: nextIndex++, scheduledAt, readyAt: clock.now(), raf }
      dispatches.push(tick)
      deadline += 1000 / options.frequency
      return tick
    },
    recordDispatch(index: number, at: number) {
      const dispatch = dispatches[index]
      if (!dispatch) throw new Error('Unknown editor input pacing tick.')
      dispatch.dispatchAt = at
      dispatch.dispatchLatenessMs = Math.max(0, at - dispatch.scheduledAt)
    },
    stop() {
      if (stoppedAt !== null) return
      stoppedAt = clock.now()
      if (rafHandle !== null) clock.cancelRaf(rafHandle)
      for (const cancel of [...cancellations]) cancel()
    },
    snapshot() {
      const intervals = nativeRafSamples
        .slice(1)
        .map((sample, index) => sample.timestamp - nativeRafSamples[index].timestamp)
      const sorted = [...intervals].sort((a, b) => a - b)
      const lateness = dispatches
        .flatMap((dispatch) => dispatch.dispatchLatenessMs ?? [])
        .sort((a, b) => a - b)
      return {
        mode: options.mode,
        requestedHz: options.frequency,
        startedAt,
        stoppedAt,
        dispatches,
        nativeRafSamples,
        omittedNativeRafSamples,
        nativeRafAchievedHz:
          nativeRafSamples.length > 1
            ? ((nativeRafSamples.length - 1) * 1000) /
              (nativeRafSamples.at(-1)!.timestamp - nativeRafSamples[0].timestamp)
            : null,
        nativeRafIntervalP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
        nativeRafIntervalMaximumMs: sorted.at(-1) ?? null,
        dispatchLatenessP95Ms: lateness.length
          ? lateness[Math.ceil(lateness.length * 0.95) - 1]
          : null,
        dispatchLatenessMaximumMs: lateness.at(-1) ?? null,
      }
    },
  }
}

export function editorInputPacingSummary(
  pacing: ReturnType<ReturnType<typeof createEditorInputPacer>['snapshot']> | null,
) {
  if (!pacing) return null
  const { nativeRafSamples, dispatches, ...summary } = pacing
  return {
    ...summary,
    nativeRafSampleCount: nativeRafSamples.length,
    inputDispatchCount: dispatches.length,
  }
}

/** Count first changed feedback, including an input first served by final-quality output. */
export function summarizeFirstVisibleInputResponses(
  inputs: { value: number }[],
  presentations: { serial: number; at: number; latencyMs: number }[],
) {
  const seen = new Set<number>()
  let previousValue: number | undefined
  const latencies: number[] = []
  for (const presentation of [...presentations].sort((a, b) => a.at - b.at)) {
    const value = inputs[presentation.serial].value
    if (seen.has(presentation.serial) || value === previousValue) continue
    seen.add(presentation.serial)
    previousValue = value
    latencies.push(presentation.latencyMs)
  }
  latencies.sort((a, b) => a - b)
  const quantile = (p: number) =>
    latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null
  return {
    firstVisibleResponseCount: latencies.length,
    firstVisibleLatencyP50Ms: quantile(0.5),
    firstVisibleLatencyP95Ms: quantile(0.95),
    firstVisibleLatencyP99Ms: quantile(0.99),
    firstVisibleLatencyMaximumMs: latencies.at(-1) ?? null,
  }
}
