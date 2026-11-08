import { test, expect } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentPhotoPreviews } from '../src/main/agent/photo-previews'
import { syntheticExportSource, sha } from './export.helpers'
import { identity } from '../src/main/export/files'
import { cropAdmission } from './crop-frame.helpers'
import { WorkScheduler } from '../src/main/work-scheduler'
import type { ExportRenderJob, ExportRenderResult } from '../src/main/export/types'

async function fixture(
  render: (job: ExportRenderJob, signal: AbortSignal) => Promise<ExportRenderResult>,
) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-inspection-'))
  const source = await syntheticExportSource(root, 32, 24, (x, y) => [x / 32, y / 24, 0.3])
  source.identity = identity(await lstat(source.path))
  let revision = source.processing.revision
  const previews = new AgentPhotoPreviews(
    root,
    async () => source,
    async () => revision,
    async () => undefined,
    async () => cropAdmission(),
    new WorkScheduler(),
    { render },
  )
  return {
    root,
    source,
    previews,
    change: () => {
      revision++
    },
    close: async () => {
      await previews.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('matched members share frozen coordinates/encoding and neutral Before with sequential rendering', async () => {
  const jobs: ExportRenderJob[] = []
  const f = await fixture(async (job) => {
    jobs.push(job)
    const bytes = Buffer.from(`image-${jobs.length}`),
      path = join(job.directory, 'output.png')
    await writeFile(path, bytes)
    return { path, sha256: sha(bytes), geometry: { width: 12, height: 10 } }
  })
  try {
    const context = await f.previews.context(f.source.photo.id, 4)
    const result = await f.previews.inspect(f.source.photo.id, 4, {
      region: {
        units: 'pixels',
        x: 3,
        y: 4,
        width: 12,
        height: 10,
        gridIdentity: context.gridIdentity,
      },
      resolutionPercent: 100,
      encoding: { format: 'png' },
      comparison: 'pair',
    })
    expect(result.members.map((m) => m.label)).toEqual(['before', 'after'])
    expect(
      result.members.every(
        (m) =>
          m.width === 12 &&
          m.height === 10 &&
          m.native === 'photo-native' &&
          m.effectiveRendition === 'sdr',
      ),
    ).toBe(true)
    expect(jobs[0].source.processing.adjustments?.exposureEv).toBe(0)
    expect(jobs[0].inspection).toEqual(jobs[1].inspection)
    expect(jobs[0].options).toEqual(jobs[1].options)
    expect(await readdir(join(f.root, 'cache', 'agent-previews'))).toEqual([])
  } finally {
    await f.close()
  }
})

test('oversize is an explicit refusal with no retry or quality reduction; stale pairs publish nothing', async () => {
  let count = 0
  const f = await fixture(async (job) => {
    count++
    const path = join(job.directory, 'output.jpg'),
      bytes = Buffer.alloc(8 * 1024 ** 2 + 1)
    await writeFile(path, bytes)
    return { path, sha256: sha(bytes), geometry: { width: 32, height: 24 } }
  })
  try {
    await expect(
      f.previews.inspect(f.source.photo.id, 4, { resolutionPercent: 100 }),
    ).rejects.toThrow('exceeds 8 MiB')
    expect(count).toBe(1)
    await expect(f.previews.inspect(f.source.photo.id, 4, { hdr: true })).rejects.toThrow(
      'no client/version/model/transport',
    )
    expect(count).toBe(1)
    expect(await readdir(join(f.root, 'cache', 'agent-previews'))).toEqual([])
  } finally {
    await f.close()
  }
  const g = await fixture(async (job) => {
    const path = join(job.directory, 'output.jpg'),
      bytes = await readFile(g.source.path)
    await writeFile(path, bytes)
    g.change()
    return { path, sha256: sha(bytes), geometry: { width: 32, height: 24 } }
  })
  try {
    await expect(
      g.previews.inspect(g.source.photo.id, 4, { comparison: 'pair', resolutionPercent: 100 }),
    ).rejects.toThrow('revision changed')
  } finally {
    await g.close()
  }
})

test('cancelling an active photo inspection drains rendering before removing its disposable assets', async () => {
  let started = false,
    drained = false
  const f = await fixture(async (job, signal) => {
    started = true
    await writeFile(join(job.directory, 'partial.png'), 'in-flight encoder')
    try {
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    } finally {
      drained = true
    }
  })
  const controller = new AbortController()
  try {
    const work = f.previews.inspect(
      f.source.photo.id,
      4,
      { resolutionPercent: 100, encoding: { format: 'png' } },
      controller.signal,
    )
    void work.catch(() => {})
    await expect.poll(() => started).toBe(true)
    controller.abort(new Error('Inspection cancelled by client.'))
    await expect(work).rejects.toThrow('cancelled by client')
    expect(drained).toBe(true)
    expect(await readdir(join(f.root, 'cache', 'agent-previews'))).toEqual([])
    expect(await readFile(f.source.path)).not.toHaveLength(0)
  } finally {
    await f.close()
  }
})
