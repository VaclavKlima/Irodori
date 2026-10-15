import { expect, test } from '@playwright/test'
import { WorkScheduler, ForegroundYield } from '../src/main/work-scheduler'
import { ForegroundActivities } from '../src/main/foreground-activity'
import { preparationWorkers } from '../src/main/import-pipeline'
import { randomUUID } from 'node:crypto'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
test('export drains import preparation, yields to foreground, and restores normal two-worker admission', async () => {
  const scheduler = new WorkScheduler(),
    signal = new AbortController().signal
  const first = gate(),
    second = gate(),
    exporting = gate()
  const events: string[] = []
  const imports = [first, second].map((held, i) =>
    scheduler.background(async () => {
      events.push(`import-${i}`)
      await held.promise
      events.push(`drained-${i}`)
    }, signal),
  )
  await expect.poll(() => events.length).toBe(2)
  const exportWork = scheduler
    .export(async (abort) => {
      events.push('export')
      exporting.release()
      await new Promise<void>((_, reject) =>
        abort.addEventListener('abort', () => reject(abort.reason), { once: true }),
      )
    }, signal)
    .catch((error) => error)
  first.release()
  await imports[0]
  expect(events).not.toContain('export')
  second.release()
  await imports[1]
  await exporting.promise
  expect(events.indexOf('export')).toBeGreaterThan(events.indexOf('drained-1'))
  const later = gate()
  const waitingImport = scheduler.background(async () => {
    events.push('later-import')
    await later.promise
  }, signal)
  const preview = scheduler.run('interactive', async () => {
    events.push('preview')
  })
  expect(await exportWork).toBeInstanceOf(ForegroundYield)
  await preview
  await expect.poll(() => events.includes('later-import')).toBe(true)
  // The original import worker allowance is not permanently reduced by export admission.
  const concurrent = scheduler.background(async () => {
    events.push('parallel-import')
  }, signal)
  await concurrent
  expect(events.at(-1)).toBe('parallel-import')
  later.release()
  await waitingImport
  scheduler.close()
})
test('foreground admission drains existing work, then orders preview before FIFO operations and background', async () => {
  const scheduler = new WorkScheduler(),
    signal = new AbortController().signal
  const copy = gate(),
    preview = gate(),
    events: string[] = []
  const copying = scheduler.background(async () => {
    events.push('copy')
    await copy.promise
  }, signal)
  await expect.poll(() => events).toEqual(['copy'])
  const first = scheduler.run('operation', async () => {
    events.push('merge')
  })
  const second = scheduler.run('operation', async () => {
    events.push('delete')
  })
  const viewing = scheduler.run('interactive', async () => {
    events.push('preview')
    await preview.promise
  })
  const nextCopy = scheduler.background(async () => {
    events.push('next copy')
  }, signal)
  copy.release()
  await copying
  await expect.poll(() => events).toEqual(['copy', 'preview'])
  preview.release()
  await Promise.all([first, second, viewing, nextCopy])
  expect(events).toEqual(['copy', 'preview', 'merge', 'delete', 'next copy'])
})
test('nested metadata and mutation inherit their operation owner; Trash and publication finish before handoff', async () => {
  const scheduler = new WorkScheduler(),
    trash = gate(),
    entered = gate()
  const events: string[] = []
  const deletion = scheduler.run('operation', async () =>
    scheduler.mutate(async () => {
      await scheduler.run('interactive', async () => {
        events.push('nested metadata')
      })
      entered.release()
      await trash.promise
      events.push('Trash finished')
    }),
  )
  await entered.promise
  const preview = scheduler.run('interactive', async () => {
    events.push('preview')
  })
  expect(events).toEqual(['nested metadata'])
  trash.release()
  await Promise.all([deletion, preview])
  expect(events).toEqual(['nested metadata', 'Trash finished', 'preview'])
})
test('preempted RAW fallback exits before foreground admission and cancellation unblocks paused waits', async () => {
  const scheduler = new WorkScheduler(),
    entered = gate(),
    exit = gate()
  const fallback = scheduler.background(
    async (signal) => {
      entered.release()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      await exit.promise
      throw new Error('worker exited')
    },
    new AbortController().signal,
    true,
  )
  const yielded = expect(fallback).rejects.toBeInstanceOf(ForegroundYield)
  await entered.promise
  let foreground = false
  const preview = scheduler.run('interactive', async () => {
    foreground = true
  })
  expect(foreground).toBe(false)
  exit.release()
  await Promise.all([yielded, preview])
  expect(foreground).toBe(true)
  scheduler.activity('gesture', true)
  const abort = new AbortController()
  const waiting = scheduler.background(async () => {}, abort.signal)
  const cancelled = expect(waiting).rejects.toThrow()
  abort.abort()
  await cancelled
  scheduler.activity('gesture', false)
  await scheduler.background(async () => {}, new AbortController().signal)
})
test('activity heartbeats expire, coalesce idle release and reject reordered sequences', async () => {
  const scheduler = new WorkScheduler(),
    activities = new ForegroundActivities(scheduler, 70, 20)
  const value = { activityId: randomUUID(), photoId: 'a'.repeat(64), sequence: 1, active: true }
  activities.report(value)
  expect(scheduler.waitingReason).toBe('foreground')
  activities.report({ ...value, sequence: 2, active: false })
  activities.report({ ...value, sequence: 1, active: true })
  await expect.poll(() => scheduler.waitingReason).toBeUndefined()
  activities.report({ ...value, sequence: 3 })
  await expect.poll(() => scheduler.waitingReason).toBeUndefined()
  activities.report({ ...value, sequence: 4 })
  activities.clear()
  expect(scheduler.waitingReason).toBeUndefined()
})
test('worker defaults require both RAM and CPU headroom', () => {
  expect(preparationWorkers(8 * 1024 ** 3, 3)).toBe(2)
  expect(preparationWorkers(8 * 1024 ** 3 - 1, 24)).toBe(1)
  expect(preparationWorkers(64 * 1024 ** 3, 2)).toBe(1)
})
