import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { MaskEdgeService } from '../src/main/mask-edges/service'
import type { MaskEdgeProcess } from '../src/main/mask-edges/process'
import { neutralMaskLight, neutralMaskEdge, type ResolvedMask } from '../src/shared/masks'
import { maskEdgeMemoryPlan } from '../src/shared/mask-edges'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import type { EditState } from '../src/shared/edits'
import { cropAdmission } from './crop-frame.helpers'

const photoId = 'a'.repeat(64),
  maskId = '11111111-1111-1111-1111-111111111111'
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-mask-edge-service-'))
  let revision = 0,
    source = 1,
    calls = 0,
    reserved = 0,
    closed = 0
  let cachePath = '',
    sourceReads = 0
  let finalRead: (() => Promise<void>) | undefined
  let mask: ResolvedMask = {
    id: maskId,
    name: 'Object',
    enabled: true,
    inverted: false,
    head: null,
    edge: { ...neutralMaskEdge, featherPx: 2 },
    light: { ...neutralMaskLight },
    strokes: [],
  }
  let gate: ((signal: AbortSignal) => Promise<void>) | undefined
  let admission = cropAdmission()
  const runtime: Pick<MaskEdgeProcess, 'prepare' | 'close'> = {
    prepare: async (_mask, width, height, key, path, signal) => {
      calls++
      cachePath = path
      await gate?.(signal)
      signal.throwIfAborted()
      const png = await sharp(Buffer.alloc(width * height, 128), {
        raw: { width, height, channels: 1 },
      })
        .toColourspace('b-w')
        .png()
        .toBuffer()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, png)
      return {
        path,
        key,
        width,
        height,
        hash: createHash('sha256').update(png).digest('hex'),
        encodedBytes: png.length,
      }
    },
    close: async () => {
      closed++
    },
  }
  const service = new MaskEdgeService(
    root,
    {
      context: async () => ({
        photoId,
        revision,
        geometry: identityMaskGeometry(32, 24),
        width: 32,
        height: 24,
        renderingIdentity: 'context',
      }),
      edits: async () => ({ photoId, revision }) as EditState,
      source: async () => {
        sourceReads++
        if (sourceReads > 1) await finalRead?.()
        return { version: source }
      },
      masks: () => [mask],
      admission: async () => admission,
      reserve: async (bytes) => {
        reserved += bytes
        let released = false
        return () => {
          if (!released) {
            released = true
            reserved -= bytes
          }
        }
      },
    },
    runtime,
  )
  return {
    root,
    service,
    request: () => ({ photoId, revision, maskIds: [maskId] }),
    calls: () => calls,
    reserved: () => reserved,
    closed: () => closed,
    cachePath: () => cachePath,
    finalRead: (read: typeof finalRead) => {
      finalRead = read
    },
    revise: () => revision++,
    source: () => source++,
    setMask: (value: Partial<ResolvedMask>) => {
      mask = { ...mask, ...value }
    },
    gate: (value: typeof gate) => {
      gate = value
    },
    lowBudget: () => {
      admission = {
        ...admission,
        policy: { ...admission.policy, vram: { ...admission.policy.vram, effectiveBytes: 1 } },
      }
    },
    cleanup: async () => {
      await service.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('derived coverage is cached independently of Light/name, bound to source and released on close', async () => {
  const f = await fixture()
  try {
    const first = await f.service.prepare(f.request())
    expect(first.coverages[maskId].hash).toMatch(/^[a-f0-9]{64}$/)
    f.setMask({ name: 'Renamed', light: { ...neutralMaskLight, exposureEv: 0.25 } })
    f.revise()
    const second = await f.service.prepare(f.request())
    expect(second.coverages).toEqual(first.coverages)
    expect(f.calls()).toBe(1)
    f.source()
    f.revise()
    expect((await f.service.prepare(f.request())).coverages[maskId].key).not.toBe(
      first.coverages[maskId].key,
    )
    expect(f.calls()).toBe(2)
    expect(f.reserved()).toBeGreaterThan(0)
    await f.service.close()
    expect(f.reserved()).toBe(0)
    expect(f.closed()).toBe(1)
  } finally {
    await f.cleanup()
  }
})

test('stale revisions and sources are refused after native work before response publication', async () => {
  const f = await fixture()
  try {
    f.gate(async () => {
      f.revise()
    })
    await expect(f.service.prepare(f.request())).rejects.toThrow(/changed/)
    f.source()
    f.gate(async () => {
      f.source()
    })
    await expect(f.service.prepare(f.request())).rejects.toThrow(/changed/)
  } finally {
    await f.cleanup()
  }
})

test('cancellation drains superseded work and a late cancel cannot interrupt the next photo job', async () => {
  const f = await fixture()
  try {
    let entered!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    f.gate(async (signal) => {
      entered()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
    })
    const old = f.service.prepare(f.request())
    const rejected = expect(old).rejects.toThrow()
    await started
    const cancelled = f.service.cancel(photoId)
    f.gate(undefined)
    const current = f.service.prepare(f.request())
    await cancelled
    await rejected
    expect((await current).coverages[maskId]).toBeDefined()
  } finally {
    await f.cleanup()
  }
})

test('request-scoped cancellation cannot interrupt an independent queued read of the same photo', async () => {
  const f = await fixture()
  try {
    const oldId = '33333333-3333-4333-8333-333333333333'
    const currentId = '44444444-4444-4444-8444-444444444444'
    let firstEntered!: () => void, secondEntered!: () => void, release!: () => void
    const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve))
    const secondStarted = new Promise<void>((resolve) => (secondEntered = resolve))
    const completion = new Promise<void>((resolve) => (release = resolve))
    f.gate(async (signal) => {
      if (f.calls() === 1) {
        firstEntered()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      } else {
        secondEntered()
        await completion
      }
    })
    const old = f.service.prepare({ ...f.request(), requestId: oldId })
    const rejected = expect(old).rejects.toThrow()
    await firstStarted
    const current = f.service.prepare({ ...f.request(), requestId: currentId })
    await f.service.cancel(photoId, oldId)
    await rejected
    await secondStarted
    await f.service.cancel(photoId, oldId)
    release()
    expect((await current).coverages[maskId]).toBeDefined()
    expect(f.calls()).toBe(2)
  } finally {
    await f.cleanup()
  }
})

test('removal fences queued work, resource refusal precedes inference, and neutral edges need no GPU', async () => {
  const f = await fixture()
  try {
    f.lowBudget()
    await expect(f.service.prepare(f.request())).rejects.toThrow(/budget/)
    expect(f.calls()).toBe(0)
    f.setMask({ edge: { ...neutralMaskEdge } })
    // Neutral coverage does not allocate any of the spatial-stage buffers.
    const plan = maskEdgeMemoryPlan(32, 24, [], cropAdmission())
    expect(plan.ownGpu).toBe(0)
    expect(plan.ownRam).toBe(0)
    await f.service.beginRemoval(photoId)
    await expect(f.service.prepare(f.request())).rejects.toThrow(/removed/)
    f.service.endRemoval(photoId)
  } finally {
    await f.cleanup()
  }
})

test('malformed requests and unknown masks never enter the native process', async () => {
  const f = await fixture()
  try {
    expect(() => f.service.prepare({ ...f.request(), maskIds: [maskId, maskId] })).toThrow(
      /Invalid/,
    )
    await expect(
      f.service.prepare({ ...f.request(), maskIds: ['22222222-2222-2222-2222-222222222222'] }),
    ).rejects.toThrow(/unavailable/)
    expect(f.calls()).toBe(0)
  } finally {
    await f.cleanup()
  }
})

test('cancel during final source validation cannot publish completed coverage', async () => {
  const f = await fixture()
  try {
    let entered!: () => void, release!: () => void
    const finalStarted = new Promise<void>((resolve) => (entered = resolve))
    const validation = new Promise<void>((resolve) => (release = resolve))
    f.finalRead(async () => {
      entered()
      await validation
    })
    const work = f.service.prepare(f.request())
    const rejected = expect(work).rejects.toThrow()
    await finalStarted
    const cancelled = f.service.cancel(photoId)
    release()
    await rejected
    await cancelled
  } finally {
    await f.cleanup()
  }
})

test('damaged disposable coverage releases its cache reservation and explicit retry regenerates', async () => {
  const f = await fixture()
  try {
    const first = await f.service.prepare(f.request())
    await writeFile(f.cachePath(), Buffer.from('changed'))
    await expect(f.service.prepare(f.request())).rejects.toThrow()
    expect(f.reserved()).toBe(0)
    const retry = await f.service.prepare(f.request())
    expect(retry.coverages).toEqual(first.coverages)
    expect(f.calls()).toBe(2)
    await f.service.beginRemoval(photoId)
    expect(f.reserved()).toBe(0)
  } finally {
    await f.cleanup()
  }
})
