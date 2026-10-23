import { test, expect } from '@playwright/test'
import { runImportPipeline } from '../src/main/import-pipeline'
import { WorkScheduler } from '../src/main/work-scheduler'
import type { PreviewProcessor, PreviewResult } from '../src/main/preview-types'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const result: PreviewResult = { source: 'image', metadata: { width: 3, height: 2 } }
const processor: PreviewProcessor = { process: async () => result, close: async () => {} }

for (const failNotification of [false, true])
  test(`two preparation lanes ${failNotification ? 'abort and drain failed' : 'await held'} completion exactly once after publication`, async () => {
    const scheduler = new WorkScheduler(),
      prepare = gate(),
      bothPublished = gate(),
      notify = gate()
    const candidates = [
      { id: 0, bytes: 7 },
      { id: 1, bytes: 11 },
      { id: 2, bytes: 13 },
    ]
    const prepared: number[] = [],
      copied: number[] = [],
      published: number[] = []
    const cleaned: number[] = [],
      completed: { id: number; outcome?: string }[] = []
    const accounting: { inFlight: number; stagedBytes: number }[] = []
    let notificationFailed = false,
      settled = false
    // Controlled transport-free hooks exercise asynchronous owner bookkeeping,
    // not image decoding or database timing. Candidate2 is a true hash duplicate.
    const work = runImportPipeline(
      candidates,
      [processor, processor],
      scheduler,
      new AbortController().signal,
      {
        copy: async (candidate) => {
          copied.push(candidate.id)
          return {
            hash: candidate.id === 1 ? 'other' : 'same',
            path: `source-${candidate.id}`,
            directory: `stage-${candidate.id}`,
          }
        },
        known: () => undefined,
        prepare: async (_processor, staged) => {
          prepared.push(Number(staged.path.split('-').at(-1)))
          await prepare.promise
          return result
        },
        publish: async (candidate) => {
          published.push(candidate.id)
          if (published.length === 2) bothPublished.release()
          await bothPublished.promise
          return 'imported'
        },
        clean: async (candidate) => {
          cleaned.push(candidate.id)
        },
        resolved: async (candidate, outcome) => {
          completed.push({ id: candidate.id, outcome })
          if (failNotification && candidate.id === 2) {
            notificationFailed = true
            throw new Error('Recognition persistence failed after durable publication.')
          }
          await notify.promise
        },
        sourceStopped: () => false,
        progress: (value) => {
          accounting.push({ inFlight: value.inFlight, stagedBytes: value.stagedBytes })
        },
      },
      { maxCandidates: 3, maxBytes: 31 },
    )
    const observed = work.then(
      (value) => {
        settled = true
        return { ok: true as const, value }
      },
      (error) => {
        settled = true
        return { ok: false as const, error }
      },
    )
    try {
      await expect.poll(() => copied.length).toBe(3)
      await expect.poll(() => prepared.length).toBe(2)
      prepare.release()
      await expect.poll(() => completed.length).toBe(3)
      expect(settled).toBe(false)
      expect(notificationFailed).toBe(failNotification)
      expect(published.slice().sort()).toEqual([0, 1])
      expect(completed.slice().sort((a, b) => a.id - b.id)).toEqual([
        { id: 0, outcome: 'imported' },
        { id: 1, outcome: 'imported' },
        { id: 2, outcome: 'duplicate' },
      ])
      notify.release()
      const final = await observed
      if (failNotification) {
        expect(final.ok).toBe(false)
        if (!final.ok) expect(String(final.error)).toContain('Recognition persistence failed')
      } else expect(final).toEqual({ ok: true, value: 0 })
      expect(cleaned.slice().sort()).toEqual([0, 1, 2])
      for (const value of accounting) {
        expect(value.inFlight).toBeGreaterThanOrEqual(0)
        expect(value.inFlight).toBeLessThanOrEqual(3)
        expect(value.stagedBytes).toBeGreaterThanOrEqual(0)
        expect(value.stagedBytes).toBeLessThanOrEqual(31)
      }
      expect(accounting.at(-1)).toEqual({ inFlight: 0, stagedBytes: 0 })
      expect(completed).toHaveLength(3)
    } finally {
      prepare.release()
      bothPublished.release()
      notify.release()
      await observed
      scheduler.close()
    }
  })
