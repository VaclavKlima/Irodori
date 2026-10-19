import { expect, test } from '@playwright/test'
import {
  createEditorInputPacer,
  summarizeFirstVisibleInputResponses,
  type EditorInputPacingClock,
} from './editor-input-pacing.helpers'

function fakeClock() {
  let now = 0,
    serial = 0
  const tasks = new Map<number, { at: number; callback: () => void }>()
  const add = (at: number, callback: () => void) => {
    const id = ++serial
    tasks.set(id, { at, callback })
    return id
  }
  const clock: EditorInputPacingClock = {
    now: () => now,
    timeout: (callback, delayMs) => add(now + delayMs, callback),
    clearTimeout: (id) => {
      tasks.delete(id)
    },
    raf: (callback) => {
      const at = (Math.floor(now / (1000 / 60) + 1e-9) + 1) * (1000 / 60)
      return add(at, () => callback(now))
    },
    cancelRaf: (id) => {
      tasks.delete(id)
    },
  }
  const runNext = async () => {
    const [id, task] = [...tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
    tasks.delete(id)
    now = Math.max(now, task.at)
    task.callback()
    for (let index = 0; index < 6; index++) await Promise.resolve()
  }
  return {
    clock,
    runNext,
    blockUntil: (at: number) => {
      now = at
    },
    pending: () => tasks.size,
    runUntil: async (predicate: () => boolean) => {
      for (let index = 0; !predicate(); index++) {
        if (index > 1000 || !tasks.size) throw new Error('Fake pacing did not converge.')
        await runNext()
      }
    },
  }
}

test('120 Hz deadlines deliver inputs independently of a 60 Hz native frame clock', async () => {
  const fake = fakeClock()
  const pacer = createEditorInputPacer({ mode: 'timer-deadline-v1', frequency: 120 }, fake.clock)
  await pacer.start()
  const inputs: number[] = []
  const drive = (async () => {
    for (let index = 0; index < 8; index++) {
      const tick = await pacer.next()
      inputs.push(fake.clock.now())
      pacer.recordDispatch(tick.index, fake.clock.now())
    }
  })()
  await fake.runUntil(() => inputs.length === 8)
  await drive
  pacer.stop()
  const result = pacer.snapshot()
  expect(result.dispatches).toHaveLength(8)
  expect(result.nativeRafSamples).toHaveLength(3)
  expect(result.nativeRafAchievedHz).toBeCloseTo(60, 8)
  expect(inputs.at(-1)).toBeLessThan(60)
  for (let index = 0; index < inputs.length; index++) {
    expect(result.dispatches[index].scheduledAt).toBeCloseTo((index * 1000) / 120, 8)
    expect(inputs[index]).toBeGreaterThanOrEqual(result.dispatches[index].scheduledAt)
    expect(result.dispatches[index].dispatchLatenessMs).toBeLessThan(1.01)
  }
  expect(fake.pending()).toBe(0)
})

test('explicit native-rAF pacing preserves the existing 60 Hz initial phase and deadlines', async () => {
  const fake = fakeClock()
  const pacer = createEditorInputPacer({ mode: 'native-raf', frequency: 60 }, fake.clock)
  let started = false
  const start = pacer.start().then(() => {
    started = true
  })
  await fake.runUntil(() => started)
  await start
  const inputs: number[] = []
  const drive = (async () => {
    for (let index = 0; index < 3; index++) {
      const tick = await pacer.next()
      pacer.recordDispatch(tick.index, fake.clock.now())
      inputs.push(fake.clock.now())
    }
  })()
  await fake.runUntil(() => inputs.length === 3)
  await drive
  pacer.stop()
  inputs.forEach((at, index) => expect(at).toBeCloseTo(((index + 2) * 1000) / 60, 8))
  expect(pacer.snapshot().dispatches[0].scheduledAt).toBeCloseTo(1000 / 60, 8)
  expect(fake.pending()).toBe(0)
})

test('overdue deadlines retain lateness and yield a new task for every input instead of a synchronous catch-up burst', async () => {
  const fake = fakeClock()
  const pacer = createEditorInputPacer({ mode: 'timer-deadline-v1', frequency: 120 }, fake.clock)
  await pacer.start()
  fake.blockUntil(50)
  const inputs: number[] = []
  const drive = (async () => {
    for (let index = 0; index < 2; index++) {
      const tick = await pacer.next()
      pacer.recordDispatch(tick.index, fake.clock.now())
      inputs.push(fake.clock.now())
    }
  })()
  expect(inputs).toEqual([])
  await fake.runUntil(() => inputs.length === 1)
  expect(inputs).toHaveLength(1)
  expect(pacer.snapshot().dispatches).toHaveLength(1)
  await fake.runUntil(() => inputs.length === 2)
  await drive
  pacer.stop()
  expect(pacer.snapshot().dispatches.map((dispatch) => dispatch.dispatchLatenessMs)).toEqual([
    50,
    50 - 1000 / 120,
  ])
})

test('stopping pacing rejects pending waits and clears timer and native frame callbacks', async () => {
  const fake = fakeClock()
  const pacer = createEditorInputPacer({ mode: 'timer-deadline-v1', frequency: 120 }, fake.clock)
  await pacer.start()
  const pending = pacer.next()
  pacer.stop()
  await expect(pending).rejects.toThrow('stopped')
  await expect(pacer.next()).rejects.toThrow('stopped')
  expect(fake.pending()).toBe(0)
  expect(() =>
    createEditorInputPacer({ mode: 'timer-deadline-v1', frequency: 60 }, fake.clock),
  ).toThrow('120 Hz')
})

test('first-visible latency includes first-only final feedback and excludes duplicate exact refinement', () => {
  const inputs = [{ value: 1 }, { value: 2 }]
  const presentations = [
    { serial: 0, at: 10, latencyMs: 10, intent: 'interactive' },
    { serial: 1, at: 170, latencyMs: 150, intent: 'settled' },
    { serial: 0, at: 200, latencyMs: 200, intent: 'settled' },
  ]
  expect(summarizeFirstVisibleInputResponses(inputs, presentations)).toEqual({
    firstVisibleResponseCount: 2,
    firstVisibleLatencyP50Ms: 10,
    firstVisibleLatencyP95Ms: 150,
    firstVisibleLatencyP99Ms: 150,
    firstVisibleLatencyMaximumMs: 150,
  })
  expect(summarizeFirstVisibleInputResponses(inputs, [])).toMatchObject({
    firstVisibleResponseCount: 0,
    firstVisibleLatencyP99Ms: null,
  })
})
