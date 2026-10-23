import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { FullPreviews, PREVIEW_VERSION } from '../src/main/full-previews'
import { PreviewEngine } from '../src/main/preview-engine'
import type {
  FullPreviewProcessor,
  FullPreviewResult,
  HdrRawPreparation,
} from '../src/main/preview-types'
import { unavailableProfile } from '../src/main/processing/metadata'
import { automaticLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import type { HdrPreview } from '../src/shared/contracts'
import type { CpuPreviewRequest } from '../src/shared/native-cpu-preview'
import { NativeCpuController, type CpuWorkingLease } from '../src/main/native-cpu-controller'
import { attestAndFeedCpuSource } from '../src/main/native-cpu-input'
import { nativeCpuExistingOwners } from '../src/shared/native-cpu-memory'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import { renderHdr, scanHdr } from '../src/main/processing/hdr-processing'
import { MERGE_LIMITS, MERGE_VERSION, type MergeRecipe } from '../src/shared/merge'
import { workingAsset } from './export.helpers'
import {
  HDR_FIRST_SURFACE_VERSION,
  type HdrFirstSurfaceRequest,
} from '../src/shared/hdr-first-surface'

async function writeFrame(
  output: string,
  bytes = Buffer.alloc(12 * 8 * 4),
  width = 12,
  height = 8,
): Promise<FullPreviewResult> {
  await writeFile(join(output, 'full.rgba'), bytes)
  await writeFile(join(output, 'placeholder.png'), 'placeholder')
  return {
    width,
    height,
    format: 'rgba8-srgb',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    renderId: 'libraw-ahd-srgb-cpu-1',
    placeholderBytes: 11,
  }
}

const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
const original = (id: string) =>
  ids.includes(id) ? resolve('tests/fixtures/sony-zv1.ARW') : undefined

async function writeWorkingFrame(output: string): Promise<FullPreviewResult> {
  const data = new Float32Array(12 * 8 * 4).fill(0.25)
  for (let i = 3; i < data.length; i += 4) data[i] = 1
  const bytes = Buffer.from(data.buffer)
  const hdr = workingAsset(bytes, 12, 8)
  await writeFile(join(output, 'linear.f32'), bytes)
  return {
    width: 12,
    height: 8,
    format: 'hdr-working',
    byteLength: 0,
    sha256: hdr.sha256,
    renderId: 'synthetic-hdr',
    placeholderBytes: 0,
    linear: { byteLength: bytes.length, sha256: hdr.sha256, transform: srgbTransform, hdr },
  }
}

// Reuses that suite's writeWorkingFrame, ids and original fixtures. No RAW decoder,
// native child, GPU or application performance is exercised by these five cases.
function cpuLeaseGate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function cpuLeaseOptions(): ProcessingOptions {
  return {
    processing: 'hdr-v1',
    metadata: { version: 1, lensProfile: unavailableProfile },
    settings: { ...automaticLensSettings },
    adjustments: { ...neutralAdjustments },
    revision: 0,
  }
}
function cpuLeaseRequest(
  frame: HdrPreview,
  patch: Partial<CpuPreviewRequest> = {},
): CpuPreviewRequest {
  if (!frame.cpuSource || frame.settingsRevision === undefined)
    throw new Error('Prepared HDR fixture omitted its trusted CPU reference/revision.')
  return {
    version: 'native-cpu-preview-v1',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    source: structuredClone(frame.cpuSource),
    generation: 1,
    expectedSettingsRevision: frame.settingsRevision,
    parameters: { ...neutralAdjustments },
    quality: 'normal',
    hdrRanges: false,
    headroom: null,
    viewport: { width: 64, height: 32, dpr: 1 },
    ...patch,
  }
}
async function cpuLeaseBytes(lease: CpuWorkingLease) {
  const bytes = Buffer.alloc(lease.asset.byteLength)
  for (let filled = 0; filled < bytes.length;) {
    const part = await lease.file.read(bytes, filled, bytes.length - filled, filled)
    if (!part.bytesRead) throw new Error('Truncated prepared CPU lease fixture.')
    filled += part.bytesRead
  }
  return bytes
}

test('CPU prepared-cache references survive independent HDR/statistics tokens and actual LRU touches during verified input', async () => {
  const root = test.info().outputPath('cpu-stable-source'),
    options = cpuLeaseOptions()
  const cache = new FullPreviews(
    root,
    original,
    {
      renderFull: (_path, output) => writeWorkingFrame(output),
      hdrStatistics: (path, job) => scanHdr(path, job),
      close: async () => {},
    },
    undefined,
    async () => structuredClone(options),
  )
  let lease: CpuWorkingLease | undefined
  try {
    await cache.open()
    const firstToken = randomUUID(),
      first = (await cache.requestHdr(ids[0], firstToken))!
    expect(first.cpuSource).toMatchObject({
      photoId: ids[0],
      workingSha256: first.sha256,
      renderingIdentity: first.renderId,
    })
    expect(first.cpuSource!.cacheId).toBe(new URL(first.linear.url).pathname.split('/').at(-1))
    lease = await cache.acquireCpuWorkingSource(
      cpuLeaseRequest(first),
      new AbortController().signal,
    )
    const originalBytes = await cpuLeaseBytes(lease),
      owner = cache.acquire(new URL(first.linear.url))!
    const path = owner.path
    owner.release()
    const nextToken = randomUUID(),
      next = (await cache.requestHdr(ids[1], nextToken))!
    await cache.release(firstToken)
    expect(cache.getDiagnostics().photoId).toBe(next.photoId)
    const statistics = await cache.hdrStatistics(ids[2], 0, 'working-hdr', SDR_TARGET)
    expect(statistics).toMatchObject({ photoId: ids[2], revision: 0, visiblePixels: 12 * 8 })
    expect(cache.getDiagnostics().photoId).toBe(next.photoId)
    await cache.release(nextToken)
    // There is no active preview token now; the immutable source entry is still leased.
    await lease.check(0, new AbortController().signal)
    const past = new Date('2001-01-01T00:00:00Z')
    await utimes(path, past, past)
    let touched: HdrPreview | undefined
    const received: Buffer[] = []
    const input = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received.push(Buffer.from(chunk))
        // The real cache hit touches linear.f32 while the producer owns this strip.
        void cache.requestHdr(ids[0], randomUUID()).then(
          (frame) => {
            if (!frame) {
              callback(new Error('Expected the prepared source cache hit.'))
              return
            }
            touched = frame
            callback()
          },
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        )
      },
    })
    input.on('error', () => undefined)
    const fed = await attestAndFeedCpuSource(
      lease.file,
      lease.asset,
      input,
      new AbortController().signal,
    )
    expect(fed.sourceAttestedByMain).toBe(true)
    expect(Buffer.concat(received)).toEqual(originalBytes)
    expect(createHash('sha256').update(Buffer.concat(received)).digest('hex')).toBe(first.sha256)
    expect(touched!.cpuSource).toEqual(first.cpuSource)
    expect(touched!.requestId).not.toBe(first.requestId)
    expect((await stat(path)).mtimeMs).toBeGreaterThan(past.getTime())
    await lease.check(0, new AbortController().signal)
    await lease.release()
    await lease.release()
    await expect(lease.file.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally {
    await lease?.release()
    await cache.close()
  }
})

test('CPU leases reject old settings revisions and changed correction identities while confirmed Light revisions reuse the exact source', async () => {
  const root = test.info().outputPath('cpu-source-revisions'),
    available = new Set(ids)
  let options = cpuLeaseOptions()
  const cache = new FullPreviews(
    root,
    (id) => (available.has(id) ? original(id) : undefined),
    { renderFull: (_path, output) => writeWorkingFrame(output), close: async () => {} },
    undefined,
    async () => structuredClone(options),
  )
  const leases: CpuWorkingLease[] = []
  try {
    await cache.open()
    const first = (await cache.requestHdr(ids[0], randomUUID()))!,
      initial = cpuLeaseRequest(first)
    const lease = await cache.acquireCpuWorkingSource(initial, new AbortController().signal)
    leases.push(lease)
    const bytes = await cpuLeaseBytes(lease)
    options = { ...options, revision: 1, adjustments: { ...neutralAdjustments, exposureEv: 1.25 } }
    cache.settingsChanged(ids[0])
    await expect(lease.check(0, new AbortController().signal)).rejects.toThrow(
      'revision or correction identity',
    )
    await expect(
      cache.acquireCpuWorkingSource(initial, new AbortController().signal),
    ).rejects.toThrow('revision or correction identity')
    await lease.check(1, new AbortController().signal)
    const confirmed = await cache.acquireCpuWorkingSource(
      { ...initial, expectedSettingsRevision: 1 },
      new AbortController().signal,
    )
    leases.push(confirmed)
    expect(confirmed.source).toEqual(initial.source)
    expect(await cpuLeaseBytes(confirmed)).toEqual(bytes)
    options = { ...options, revision: 2, settings: { ...options.settings, distortion: false } }
    cache.settingsChanged(ids[0])
    await expect(lease.check(2, new AbortController().signal)).rejects.toThrow(
      'correction identity',
    )
    await expect(
      cache.acquireCpuWorkingSource(
        { ...initial, expectedSettingsRevision: 2 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('correction identity')
    const changed = (await cache.requestHdr(ids[0], randomUUID()))!
    expect(changed.cpuSource!.cacheId).not.toBe(first.cpuSource!.cacheId)
    const corrected = await cache.acquireCpuWorkingSource(
      cpuLeaseRequest(changed),
      new AbortController().signal,
    )
    leases.push(corrected)
    options = {
      ...options,
      metadata: {
        ...options.metadata,
        lensProfile: { ...unavailableProfile, identity: 'synthetic-new-lens-provider-revision' },
      },
    }
    // Same persisted edit revision still cannot authorize another provider's source.
    await expect(corrected.check(2, new AbortController().signal)).rejects.toThrow(
      'correction identity',
    )
    available.delete(ids[0])
    await expect(corrected.check(2, new AbortController().signal)).rejects.toThrow(
      'identity changed',
    )
    await expect(
      cache.acquireCpuWorkingSource(cpuLeaseRequest(changed), new AbortController().signal),
    ).rejects.toThrow(/unavailable|identity changed/)
    expect(await cpuLeaseBytes(lease)).toEqual(bytes)
  } finally {
    await Promise.all(leases.map((lease) => lease.release()))
    await cache.close()
  }
})

test('failed CPU source references and aborts return their cache pins so later pressure can evict the entry', async () => {
  const root = test.info().outputPath('cpu-failed-acquisition'),
    options = cpuLeaseOptions()
  const entered = cpuLeaseGate(),
    gate = cpuLeaseGate()
  let holdOptions = false
  const cache = new FullPreviews(
    root,
    original,
    { renderFull: (_path, output) => writeWorkingFrame(output), close: async () => {} },
    12 * 8 * 16,
    async () => {
      if (holdOptions) {
        entered.resolve()
        await gate.promise
      }
      return structuredClone(options)
    },
  )
  try {
    await cache.open()
    const token = randomUUID(),
      frame = (await cache.requestHdr(ids[0], token))!,
      request = cpuLeaseRequest(frame)
    const owner = cache.acquire(new URL(frame.linear.url))!,
      path = owner.path
    owner.release()
    for (const source of [
      { ...request.source, photoId: ids[1] },
      { ...request.source, cacheId: randomUUID() },
      { ...request.source, workingSha256: '0'.repeat(64) },
      { ...request.source, renderingIdentity: 'mismatched-source' },
    ])
      await expect(
        cache.acquireCpuWorkingSource({ ...request, source }, new AbortController().signal),
      ).rejects.toThrow(/source|identity/)
    const early = new AbortController()
    early.abort(new Error('Stopped before CPU source acquisition.'))
    await expect(cache.acquireCpuWorkingSource(request, early.signal)).rejects.toThrow(
      'Stopped before CPU source acquisition',
    )
    holdOptions = true
    const late = new AbortController(),
      acquiring = cache.acquireCpuWorkingSource(request, late.signal)
    await entered.promise
    const rejected = expect(acquiring).rejects.toThrow('Stopped during CPU source acquisition')
    late.abort(new Error('Stopped during CPU source acquisition.'))
    gate.resolve()
    await rejected
    holdOptions = false
    await cache.release(token)
    await cache.requestHdr(ids[1], randomUUID())
    await cache.release()
    expect(cache.acquire(new URL(frame.linear.url))).toBeUndefined()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    gate.resolve()
    await cache.close()
  }
})

test('FullPreviews removal and shutdown drain the CPU controller and close its real source descriptor before releasing the prune pin', async () => {
  for (const action of ['removal', 'shutdown'] as const) {
    await test.step(action, async () => {
      const root = test.info().outputPath(`cpu-controller-${action}`),
        options = cpuLeaseOptions()
      const launched = cpuLeaseGate(),
        launchGate = cpuLeaseGate(),
        closingFd = cpuLeaseGate(),
        closeGate = cpuLeaseGate()
      const cache = new FullPreviews(
        root,
        original,
        { renderFull: (_path, output) => writeWorkingFrame(output), close: async () => {} },
        12 * 8 * 16,
        async () => structuredClone(options),
      )
      let lease: CpuWorkingLease | undefined
      const controller = new NativeCpuController({
        root: join(root, 'cpu-output'),
        // Deliberately stop before spawn; real child lifetime is covered by the
        // separate native-cpu-controller service target, not fabricated here.
        executable: async () => {
          launched.resolve()
          await launchGate.promise
          return '/never-launched-native-cpu-lease-fixture'
        },
        policy: async () =>
          resolveResourcePolicy(
            { version: 1, ramMiB: 2048, vramMiB: 2048 },
            {
              ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
              gpu: { status: 'unknown', reason: 'adapter-unverified' },
            },
            1,
          ),
        acquireSource: async (request, signal) => {
          const owned = await cache.acquireCpuWorkingSource(request, signal)
          lease = owned
          const close = owned.file.close.bind(owned.file)
          owned.file.close = async () => {
            closingFd.resolve()
            await closeGate.promise
            await close()
          }
          return owned
        },
        foreground: (work, signal) => cache.runCpuForeground(work, signal),
        existingOwners: (asset, request) =>
          nativeCpuExistingOwners(
            asset.width,
            asset.height,
            Math.round(request.viewport.width * request.viewport.dpr),
            Math.round(request.viewport.height * request.viewport.dpr),
          ),
      })
      cache.installCpuController(controller)
      try {
        await cache.open()
        await controller.open()
        const frame = (await cache.requestHdr(ids[0], randomUUID()))!,
          request = cpuLeaseRequest(frame)
        const owner = cache.acquire(new URL(frame.linear.url))!,
          path = owner.path
        owner.release()
        const rendering = controller.render(request).then(
          (pair) => ({ pair }),
          (error: unknown) => ({ error }),
        )
        await launched.promise
        const nextToken = randomUUID()
        await cache.requestHdr(ids[1], nextToken)
        expect(await readFile(path)).toHaveLength(12 * 8 * 16)
        let retired = false
        const retiring = (action === 'removal' ? cache.beginRemoval(ids[0]) : cache.close()).then(
          () => {
            retired = true
          },
        )
        launchGate.resolve()
        await closingFd.promise
        expect(retired).toBe(false)
        await lease!.file.stat()
        // Force real cache pressure while close still owns the actual fd. If
        // release unpinned before its awaited close, the old file is evicted here.
        await cache.release(nextToken)
        expect(await readFile(path)).toHaveLength(12 * 8 * 16)
        closeGate.resolve()
        await retiring
        const stopped = await rendering
        expect('error' in stopped).toBe(true)
        if ('error' in stopped) expect(String(stopped.error)).toMatch(/removed|closed/)
        await expect(lease!.file.stat()).rejects.toMatchObject({ code: 'EBADF' })
        await expect(
          cache.acquireCpuWorkingSource(request, new AbortController().signal),
        ).rejects.toThrow(/unavailable|identity changed/)
        if (action === 'removal') {
          cache.endRemoval(ids[0], true)
          await cache.release()
          await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      } finally {
        launchGate.resolve()
        closeGate.resolve()
        await controller.close()
        await cache.close()
      }
    })
  }
})

test('CPU source capability leases the real prepared cache copy of a synthetic composite master without changing export eligibility', async () => {
  const root = test.info().outputPath('cpu-composite-master'),
    originals = join(root, 'originals', ids[0])
  await mkdir(originals, { recursive: true })
  const bytes = Buffer.from(new Float32Array([-0.02, 2, 4, 1, 0.18, 0.18, 0.18, 0.5]).buffer)
  const asset = workingAsset(bytes, 2, 1),
    path = join(originals, 'linear.f32')
  asset.source.composite = { kind: 'hdr', sourceCount: 2 }
  await writeFile(path, bytes)
  // Typed header fixture only; merge computation/publication is not exercised.
  const recipe: MergeRecipe = {
    resolution: 'native',
    version: MERGE_VERSION,
    constants: MERGE_LIMITS,
    maskDimensions: { width: 2, height: 1 },
    width: 2,
    height: 1,
    crop: { left: 0, top: 0, width: 2, height: 1 },
    settings: {
      mode: 'hdr',
      autoAlign: false,
      deghost: false,
      strength: 50,
      autoCrop: true,
      referenceId: ids[1],
    },
    sources: ids.slice(1).map((id, index) => ({
      id,
      filename: `synthetic-source-${index}.f32`,
      capture: { shutterSeconds: 1 / 100, aperture: 4, iso: 100, focalLength: 9.4 },
      scale: 1,
      transform: { x: 0, y: 0, angle: 0, correlation: 1 },
      decoder: 'synthetic',
      cameraProfile: 'synthetic',
      lensIdentity: unavailableProfile.identity,
    })),
    affectedPercent: 0,
    referenceClippedPercent: 0,
    maskSha256: createHash('sha256').update(Buffer.alloc(2)).digest('hex'),
  }
  const options: ProcessingOptions = {
    ...cpuLeaseOptions(),
    metadata: { version: 3, lensProfile: unavailableProfile, mergeMaster: { asset, recipe } },
    workingAsset: {
      path,
      width: 2,
      height: 1,
      byteLength: bytes.length,
      sha256: asset.sha256,
      transform: srgbTransform,
      hdr: asset,
    },
  }
  let rendered = 0,
    lease: CpuWorkingLease | undefined
  const cache = new FullPreviews(
    join(root, 'cache'),
    (id) => (id === ids[0] ? path : undefined),
    {
      close: async () => {},
      renderFull: async (original, output, _signal, selected) => {
        rendered++
        expect(original).toBe(path)
        return renderHdr(
          original,
          output,
          selected!,
          {
            render: async () => {
              throw new Error('A composite master must not decode again.')
            },
            releaseFrame() {},
          },
          'cpu',
        )
      },
    },
    undefined,
    async () => structuredClone(options),
  )
  try {
    await cache.open()
    const token = randomUUID(),
      frame = (await cache.requestHdr(ids[0], token))!
    lease = await cache.acquireCpuWorkingSource(
      cpuLeaseRequest(frame),
      new AbortController().signal,
    )
    const owner = cache.acquire(new URL(frame.linear.url))!,
      copiedPath = owner.path
    owner.release()
    expect(copiedPath).not.toBe(path)
    expect(copiedPath.startsWith(join(root, 'cache', PREVIEW_VERSION))).toBe(true)
    expect(await cpuLeaseBytes(lease)).toEqual(bytes)
    expect(lease.asset.source.composite).toEqual({ kind: 'hdr', sourceCount: 2 })
    expect(lease.source.workingSha256).toBe(asset.sha256)
    expect(
      await cache.acquireWorkingAsset(ids[0], options, new AbortController().signal),
    ).toBeUndefined()
    await cache.release(token)
    const reused = (await cache.requestHdr(ids[0], randomUUID()))!
    expect(reused.cpuSource).toEqual(frame.cpuSource)
    expect(rendered).toBe(1)
    await cache.beginRemoval(ids[0])
    cache.endRemoval(ids[0], true)
    await expect(lease.check(0, new AbortController().signal)).rejects.toThrow('identity changed')
    expect(await cpuLeaseBytes(lease)).toEqual(bytes)
    await lease.release()
    await cache.release()
    await expect(readFile(copiedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await lease?.release()
    await cache.close()
  }
})

test('main-only export leases match frozen preparation and protect working assets during eviction', async () => {
  const root = test.info().outputPath('export-lease')
  let options: ProcessingOptions = {
    processing: 'hdr-v1',
    metadata: { version: 1, lensProfile: unavailableProfile },
    settings: { ...automaticLensSettings },
    revision: 0,
  }
  const frozen = structuredClone(options)
  const cache = new FullPreviews(
    root,
    original,
    { renderFull: (_path, output) => writeWorkingFrame(output), close: async () => {} },
    12 * 8 * 16,
    async () => ({ ...options }),
  )
  const signal = new AbortController().signal
  try {
    await cache.open()
    expect(await cache.acquireWorkingAsset(ids[0], frozen, signal)).toBeUndefined()
    await cache.requestHdr(ids[0], randomUUID())
    const lease = await cache.acquireWorkingAsset(ids[0], frozen, signal)
    expect(lease).toBeTruthy()
    await cache.release()
    options = { ...options, revision: 1, settings: { ...options.settings, distortion: false } }
    expect(await cache.acquireWorkingAsset(ids[0], options, signal)).toBeUndefined()
    const frozenAgain = await cache.acquireWorkingAsset(ids[0], frozen, signal)
    expect(frozenAgain?.asset.path).toBe(lease!.asset.path)
    frozenAgain?.release()
    await cache.requestHdr(ids[1], randomUUID())
    expect(await readFile(lease!.asset.path)).toHaveLength(12 * 8 * 16)
    lease!.release()
    lease!.release()
    await cache.release()
    await expect(readFile(lease!.asset.path)).rejects.toThrow('ENOENT')
  } finally {
    await cache.close()
  }
})

test('export working-asset corruption is a cache miss and repaired source preparation remains reusable', async () => {
  const root = test.info().outputPath('export-corruption')
  const options: ProcessingOptions = {
    processing: 'hdr-v1',
    metadata: { version: 1, lensProfile: unavailableProfile },
    settings: { ...automaticLensSettings },
    revision: 0,
  }
  let renders = 0
  const cache = new FullPreviews(
    root,
    original,
    {
      renderFull: (_path, output) => {
        renders++
        return writeWorkingFrame(output)
      },
      close: async () => {},
    },
    undefined,
    async () => ({ ...options }),
  )
  const signal = new AbortController().signal
  try {
    await cache.open()
    const frame = await cache.requestHdr(ids[0], randomUUID())
    const stream = cache.acquire(new URL(frame!.linear!.url!))!
    await writeFile(stream.path, Buffer.alloc(stream.byteLength))
    expect(await cache.acquireWorkingAsset(ids[0], options, signal)).toBeUndefined()
    stream.release()
    await cache.release()
    await cache.requestHdr(ids[0], randomUUID())
    const interrupted = new AbortController()
    const validating = cache.acquireWorkingAsset(ids[0], options, interrupted.signal)
    interrupted.abort(new Error('Stopped during validation.'))
    await expect(validating).rejects.toThrow('Stopped during validation')
    const lease = await cache.acquireWorkingAsset(ids[0], options, signal)
    expect(lease?.asset.hdr?.sha256).toBeTruthy()
    expect(renders).toBe(2)
    lease?.release()
    const aborted = new AbortController()
    aborted.abort(new Error('Stopped before validation.'))
    await expect(cache.acquireWorkingAsset(ids[0], options, aborted.signal)).rejects.toThrow(
      'Stopped before validation',
    )
  } finally {
    await cache.close()
  }
})

test('correction variants share the cache budget, carry the current revision and survive restart', async () => {
  const root = test.info().outputPath('variants')
  let renders = 0
  let options: ProcessingOptions = {
    metadata: { version: 1, lensProfile: unavailableProfile },
    settings: { ...automaticLensSettings },
    revision: 0,
  }
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output, _signal, options) => {
      renders++
      return { ...(await writeFrame(output)), appliedCorrections: options?.settings }
    },
    close: async () => {},
  }
  const create = () => new FullPreviews(root, original, processor, undefined, async () => options)
  let cache = create()
  try {
    await cache.open()
    const first = await cache.request(ids[0], randomUUID())
    options = { ...options, revision: 1, settings: { ...options.settings, distortion: false } }
    cache.settingsChanged(ids[0])
    const second = await cache.request(ids[0], randomUUID())
    expect(second.url).not.toBe(first.url)
    expect(second.settingsRevision).toBe(1)
    options = { ...options, revision: 2, settings: { ...automaticLensSettings } }
    cache.settingsChanged(ids[0])
    expect(await cache.request(ids[0], randomUUID())).toMatchObject({
      url: first.url,
      settingsRevision: 2,
    })
    expect(renders).toBe(2)
    await cache.close()
    cache = create()
    await cache.open()
    expect(await cache.requestCached(ids[0], randomUUID())).toMatchObject({
      url: first.url,
      settingsRevision: 2,
      appliedCorrections: automaticLensSettings,
    })
    const stream = cache.acquire(new URL(first.url))!
    await cache.beginRemoval(ids[0])
    cache.endRemoval(ids[0], true)
    expect(cache.acquire(new URL(second.url))).toBeUndefined()
    expect(await readFile(stream.path)).toHaveLength(12 * 8 * 4)
    stream.release()
    await cache.release()
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(0)
  } finally {
    await cache.close()
  }
})

test('preserves native raster size, rotates once, converts profiles, and retains alpha', async () => {
  const info = test.info()
  const engine = new PreviewEngine()
  const source = info.outputPath('sources')
  await mkdir(source, { recursive: true })
  const small = join(source, 'small.png')
  const portrait = join(source, 'portrait.tiff')
  await sharp({
    create: {
      width: 80,
      height: 40,
      channels: 4,
      background: { r: 12, g: 100, b: 200, alpha: 0.5 },
    },
  })
    .png()
    .toFile(small)
  await sharp({ create: { width: 70, height: 30, channels: 3, background: '#da9012' } })
    .toColourspace('rgb16')
    .withMetadata({ orientation: 6 })
    .withIccProfile('p3')
    .tiff()
    .toFile(portrait)
  try {
    for (const [path, dimensions] of [
      [small, [80, 40]],
      [portrait, [30, 70]],
      [resolve('tests/fixtures/photos/alpine-lake.jpg'), [1920, 1280]],
    ] as const) {
      const output = info.outputPath(randomUUID())
      await mkdir(output)
      expect(await engine.renderFull(path, output)).toMatchObject({
        width: dimensions[0],
        height: dimensions[1],
      })
      const actual = await readFile(join(output, 'full.rgba'))
      const expected = await sharp(path)
        .autoOrient()
        .withIccProfile('srgb')
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer()
      expect(actual.equals(expected)).toBe(true)
      if (path === small) expect(actual[3]).toBe(128)
    }
  } finally {
    await engine.close()
  }
})

test('reuses cache across restarts and regenerates missing or explicitly invalidated entries', async () => {
  const info = test.info()
  const root = info.outputPath('cache')
  const bytes = Buffer.alloc(12 * 8 * 4, 100)
  let renders = 0
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output) => {
      renders++
      return writeFrame(output, bytes)
    },
    close: async () => {},
  }
  let cache = new FullPreviews(root, original, processor)
  try {
    await cache.open()
    expect(await cache.requestCached(ids[0], randomUUID())).toBeNull()
    expect(renders).toBe(0)
    const first = await cache.request(ids[0], randomUUID())
    await cache.close()
    cache = new FullPreviews(root, original, processor)
    await cache.open()
    const again = (await cache.requestCached(ids[0], randomUUID()))!
    expect(again.url).toBe(first.url)
    expect(renders).toBe(1)
    const lease = cache.acquire(new URL(first.url))!
    await rm(lease.path)
    lease.release()
    expect(await cache.requestCached(ids[0], randomUUID())).toBeNull()
    const repaired = await cache.request(ids[0], randomUUID())
    expect(repaired.url).not.toBe(first.url)
    expect(renders).toBe(2)
    const regenerated = await cache.request(ids[0], randomUUID(), true)
    expect(regenerated.url).not.toBe(repaired.url)
    expect(renders).toBe(3)
    expect(cache.acquire(new URL(repaired.url))).toBeUndefined()
    expect(cache.acquire(new URL(regenerated.url + '?path=/etc/passwd'))).toBeUndefined()
    await expect(cache.request('../bad', randomUUID())).rejects.toThrow('Invalid')
    const current = cache.acquire(new URL(regenerated.url))!
    const metadataPath = join(current.path, '..', 'entry.json')
    current.release()
    await cache.close()
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    delete metadata.variant
    await writeFile(metadataPath, JSON.stringify(metadata))
    cache = new FullPreviews(root, original, processor)
    await cache.open()
    expect(await cache.requestCached(ids[0], randomUUID())).toBeNull()
    expect(renders).toBe(3)
    const rebuilt = await cache.request(ids[0], randomUUID())
    expect(rebuilt.url).not.toBe(regenerated.url)
    expect(renders).toBe(4)
  } finally {
    await cache.close()
  }
})

test('bounds disk use with LRU eviction while protecting active previews and open streams', async () => {
  const info = test.info()
  const root = info.outputPath('cache')
  const bytes = Buffer.alloc(12 * 8 * 4)
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output) => {
      return writeFrame(output, bytes)
    },
    close: async () => {},
  }
  const cache = new FullPreviews(root, original, processor, bytes.length + 11)
  try {
    await cache.open()
    const a = await cache.request(ids[0], randomUUID())
    const stream = cache.acquire(new URL(a.url))!
    const b = await cache.request(ids[1], randomUUID())
    expect(await readFile(stream.path)).toEqual(bytes)
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(2)
    stream.release()
    await cache.request(ids[1], randomUUID())
    expect(cache.acquire(new URL(a.url))).toBeUndefined()
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(1)
    const c = await cache.request(ids[2], randomUUID())
    expect(cache.acquire(new URL(b.url))).toBeUndefined()
    const current = cache.acquire(new URL(c.url))!
    current.release()
    expect(await readdir(join(root, PREVIEW_VERSION))).toHaveLength(1)
  } finally {
    await cache.close()
  }
})

test('supersedes obsolete work, ignores old releases, and cancels before removal and shutdown', async () => {
  const info = test.info()
  let entered!: () => void
  let started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let slow = true
  let active = 0
  let maximum = 0
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output, signal) => {
      active++
      maximum = Math.max(maximum, active)
      try {
        await writeFile(join(output, 'partial'), 'unfinished')
        entered()
        if (slow)
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
        signal.throwIfAborted()
        return writeFrame(output)
      } finally {
        active--
      }
    },
    close: async () => {},
  }
  const root = info.outputPath('cache')
  const cache = new FullPreviews(root, original, processor)
  try {
    await cache.open()
    const oldToken = randomUUID()
    const a = cache.request(ids[0], oldToken).catch((error: Error) => error)
    await started
    // Removal of another photo must finish without waiting for this deliberately blocked render.
    await cache.beginRemoval(ids[1])
    await cache.endRemoval(ids[1], true)
    slow = false
    const b = cache.request(ids[1], randomUUID()).catch((error: Error) => error)
    const c = cache.request(ids[2], randomUUID())
    await cache.release(oldToken)
    expect(await a).toBeInstanceOf(Error)
    expect(await b).toBeInstanceOf(Error)
    const result = await c
    expect(result.photoId).toBe(ids[2])
    expect(maximum).toBe(1)
    await cache.beginRemoval(ids[2])
    await expect(cache.request(ids[2], randomUUID())).rejects.toThrow('unavailable')
    await cache.endRemoval(ids[2], true)
    expect(cache.acquire(new URL(result.url))).toBeUndefined()
    slow = true
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const removing = cache.request(ids[0], randomUUID()).catch((error: Error) => error)
    await started
    await cache.beginRemoval(ids[0])
    expect(await removing).toBeInstanceOf(Error)
    await cache.endRemoval(ids[0], false)
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const shutdown = cache.request(ids[0], randomUUID()).catch((error: Error) => error)
    await started
    await cache.close()
    expect(await shutdown).toBeInstanceOf(Error)
    expect(await readdir(join(root, PREVIEW_VERSION))).toEqual([])
  } finally {
    await cache.close()
  }
})

test('waits for a superseded worker to stop before removal without waiting for the next photo', async () => {
  let enteredA!: () => void
  let enteredB!: () => void
  let stopA!: () => void
  const startedA = new Promise<void>((resolve) => {
    enteredA = resolve
  })
  const startedB = new Promise<void>((resolve) => {
    enteredB = resolve
  })
  const stoppedA = new Promise<void>((resolve) => {
    stopA = resolve
  })
  const cache = new FullPreviews(test.info().outputPath('cache'), (id) => id, {
    renderFull: async (id, _output, signal) => {
      if (id === ids[0]) enteredA()
      else enteredB()
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (id === ids[0]) await stoppedA
      signal.throwIfAborted()
      return writeFrame(_output, Buffer.alloc(4), 1, 1)
    },
    close: async () => {},
  })
  try {
    await cache.open()
    const a = cache.request(ids[0], randomUUID()).catch((error: Error) => error)
    await startedA
    const b = cache.request(ids[1], randomUUID()).catch((error: Error) => error)
    let removalFinished = false
    const removal = cache.beginRemoval(ids[0]).then(() => {
      removalFinished = true
    })
    await Promise.resolve()
    expect(removalFinished).toBe(false)
    stopA()
    await removal
    expect(await a).toBeInstanceOf(Error)
    await startedB
    await cache.endRemoval(ids[0], true)
    await cache.release()
    expect(await b).toBeInstanceOf(Error)
  } finally {
    stopA()
    await cache.close()
  }
})

test('cleans interrupted and obsolete entries, and recovers after rendering failure', async () => {
  const info = test.info()
  const root = info.outputPath('cache')
  await mkdir(join(root, 'v0', 'obsolete'), { recursive: true })
  await mkdir(join(root, PREVIEW_VERSION, '.tmp-interrupted'), { recursive: true })
  await mkdir(join(root, PREVIEW_VERSION, `${ids[0]}-${randomUUID()}`), { recursive: true })
  let fail = true
  const cache = new FullPreviews(root, original, {
    renderFull: async (_path, output) => {
      await writeFile(join(output, 'full.rgba'), 'partial')
      if (fail) throw new Error('Disk write failed')
      return writeFrame(output, Buffer.alloc(4), 1, 1)
    },
    close: async () => {},
  })
  try {
    await cache.open()
    expect(await readdir(root)).toEqual([PREVIEW_VERSION])
    expect(await readdir(join(root, PREVIEW_VERSION))).toEqual([])
    await expect(cache.request(ids[0], randomUUID())).rejects.toThrow('Disk write failed')
    expect(await readdir(join(root, PREVIEW_VERSION))).toEqual([])
    fail = false
    expect((await cache.request(ids[0], randomUUID(), true)).width).toBe(1)
  } finally {
    await cache.close()
  }
})

test('leases one immutable working asset across exposure variants and worker restarts', async () => {
  const root = test.info().outputPath('linear-variants')
  let options: ProcessingOptions = {
    metadata: { version: 1, lensProfile: unavailableProfile },
    settings: { ...automaticLensSettings },
    revision: 0,
    adjustments: { shadows: 0, whites: 0, blacks: 0, exposureEv: 0, contrast: 0, highlights: 0 },
  }
  let preparations = 0,
    reused = 0
  const processor: FullPreviewProcessor = {
    renderFull: async (_path, output, _signal, request) => {
      const result = await writeFrame(output)
      if (request?.workingAsset) {
        reused++
        expect(await readFile(request.workingAsset.path)).toHaveLength(result.byteLength * 4)
      }
      if (request?.prepareLinear) {
        preparations++
        const bytes = Buffer.from(new Float32Array(result.byteLength).fill(0.25).buffer)
        await writeFile(join(output, 'linear.f32'), bytes)
        result.linear = {
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          transform: { white: 1, threshold: 0.0031308, offset: 0.055, quantize: false },
        }
      }
      return result
    },
    close: async () => {},
  }
  const create = () =>
    new FullPreviews(root, original, processor, 2400, async () => ({ ...options }))
  let cache = create()
  try {
    await cache.open()
    const first = await cache.request(ids[0], randomUUID())
    const prepared = await cache.requestEditing(ids[0], randomUUID())
    expect(prepared.url).toBe(first.url)
    const stream = cache.acquire(new URL(prepared.linear!.url!))!
    options = {
      ...options,
      adjustments: { shadows: 0, whites: 0, blacks: 0, exposureEv: 1, contrast: 35, highlights: 0 },
      revision: 1,
    }
    cache.settingsChanged(ids[0])
    const changed = await cache.request(ids[0], randomUUID())
    expect(changed.url).not.toBe(first.url)
    expect(changed.linear!.url).toBe(prepared.linear!.url)
    expect(preparations).toBe(1)
    expect(reused).toBe(1)
    options = {
      ...options,
      adjustments: { shadows: 0, whites: 0, blacks: 0, exposureEv: 1, contrast: 36, highlights: 0 },
      revision: 2,
    }
    cache.settingsChanged(ids[0])
    const contrastOnly = await cache.request(ids[0], randomUUID())
    expect(contrastOnly.url).not.toBe(changed.url)
    expect(contrastOnly.linear!.url).toBe(prepared.linear!.url)
    expect(preparations).toBe(1)
    expect(reused).toBe(2)
    options = { ...options, adjustments: { ...options.adjustments!, highlights: -50 }, revision: 3 }
    cache.settingsChanged(ids[0])
    const highlightsOnly = await cache.request(ids[0], randomUUID())
    expect(highlightsOnly.url).not.toBe(contrastOnly.url)
    expect(highlightsOnly.linear!.url).toBe(prepared.linear!.url)
    expect(preparations).toBe(1)
    expect(reused).toBe(3)
    let previousUrl = highlightsOnly.url
    for (const key of ['shadows', 'whites', 'blacks'] as const) {
      options = {
        ...options,
        adjustments: { ...options.adjustments!, [key]: 35 },
        revision: options.revision + 1,
      }
      cache.settingsChanged(ids[0])
      const variant = await cache.request(ids[0], randomUUID())
      expect(variant.url).not.toBe(previousUrl)
      expect(variant.linear!.url).toBe(prepared.linear!.url)
      expect(preparations).toBe(1)
      previousUrl = variant.url
    }
    expect(reused).toBe(6)
    stream.release()
    await cache.close()
    cache = create()
    await cache.open()
    expect((await cache.requestEditing(ids[0], randomUUID())).linear!.url).toBe(
      prepared.linear!.url,
    )
    expect(preparations).toBe(1)
    const lease = cache.acquire(new URL(prepared.linear!.url!))!
    await cache.beginRemoval(ids[0])
    cache.endRemoval(ids[0], true)
    expect(cache.acquire(new URL(prepared.linear!.url!))).toBeUndefined()
    expect(await readFile(lease.path)).toHaveLength(1536)
    lease.release()
    await cache.release()
    expect(await readdir(join(root, PREVIEW_VERSION))).toEqual([])
  } finally {
    await cache.close()
  }
})

test('statistics lease exact frames, cache summaries, preserve the active preview and reject stale revisions', async () => {
  const root = test.info().outputPath('statistics'),
    engine = new PreviewEngine()
  let revision = 0,
    analyzed = 0
  const processor: FullPreviewProcessor = {
    async renderFull(_path, output) {
      return writeFrame(output, Buffer.from([0, 0, 0, 255, 255, 1, 1, 255]), 2, 1)
    },
    async statistics(path, frame) {
      analyzed++
      return engine.statistics(path, frame)
    },
    async close() {
      await engine.close()
    },
  }
  const cache = new FullPreviews(root, original, processor, undefined, async () => ({
    metadata: { version: 2, lensProfile: unavailableProfile },
    settings: automaticLensSettings,
    revision,
  }))
  try {
    await cache.open()
    const active = await cache.request(ids[0], randomUUID())
    const first = await cache.statistics(ids[1], 0)
    expect(first).toMatchObject({
      visiblePixels: 2,
      shadowClipped: 1,
      highlightClipped: 1,
      revision: 0,
      photoId: ids[1],
    })
    expect(first.rgb[0][255]).toBe(1)
    const lease = cache.acquire(new URL(active.url))!
    expect(lease).toBeDefined()
    lease.release()
    expect(await cache.statistics(ids[1], 0)).toEqual(first)
    expect(analyzed).toBe(1)
    revision = 1
    cache.settingsChanged(ids[1])
    await expect(cache.statistics(ids[1], 0)).rejects.toThrow('conflict')
    expect((await cache.statistics(ids[1], 1)).revision).toBe(1)
    await cache.beginRemoval(ids[1])
    cache.endRemoval(ids[1], true)
  } finally {
    await cache.close()
  }
})

test('editing or deleting cancels pending background statistics without publishing a stale result', async () => {
  const root = test.info().outputPath('statistics-cancel')
  let revision = 0,
    started: () => void = () => {}
  let began = new Promise<void>((resolve) => {
    started = resolve
  })
  const processor: FullPreviewProcessor = {
    async renderFull(_path, _output, signal) {
      started()
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      )
    },
    async close() {},
  }
  const cache = new FullPreviews(root, original, processor, undefined, async () => ({
    metadata: { version: 2, lensProfile: unavailableProfile },
    settings: automaticLensSettings,
    revision,
  }))
  try {
    await cache.open()
    const first = cache.statistics(ids[0], 0).catch((error) => String(error))
    await began
    revision++
    cache.settingsChanged(ids[0])
    expect(await first).toContain('cancelled')
    began = new Promise<void>((resolve) => {
      started = resolve
    })
    const second = cache.statistics(ids[0], 1).catch((error) => String(error))
    await began
    await cache.beginRemoval(ids[0])
    expect(await second).toContain('cancelled')
  } finally {
    await cache.close()
  }
})

// These service controls use existing synthetic working-file helpers, not a RAW/native/GPU run.
function nativePreparationOptions(): ProcessingOptions {
  const selected = cpuLeaseOptions()
  selected.metadata = { ...selected.metadata, make: 'Sony', model: 'ZV-1A', hdrEligible: true }
  return selected
}
function nativePreparationPolicy(ramMiB: number, revision: number) {
  return resolveResourcePolicy(
    { version: 1, ramMiB, vramMiB: null },
    {
      ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 },
      gpu: { status: 'unknown', reason: 'adapter-unverified' },
    },
    revision,
  )
}

test('an HDR source miss freezes native admission without an optional surface and cached revisits do no preparation', async () => {
  const root = test.info().outputPath('native-admission-snapshot'),
    selected = nativePreparationOptions()
  const entered = cpuLeaseGate(),
    complete = cpuLeaseGate()
  const captures: HdrRawPreparation[] = []
  let currentPolicy = nativePreparationPolicy(1024, 19),
    policyReads = 0
  const cache = new FullPreviews(
    root,
    original,
    {
      renderFull: async (_path, output, signal, processing, progress, preparation) => {
        expect(processing?.firstSurface).toBeUndefined()
        expect(progress).toBeUndefined()
        expect(preparation).toBeDefined()
        captures.push(preparation!)
        if (captures.length === 1) {
          entered.resolve()
          await complete.promise
          signal.throwIfAborted()
        }
        return writeWorkingFrame(output)
      },
      close: async () => {},
    },
    undefined,
    async () => structuredClone(selected),
  )
  cache.installFirstSurface({
    policy: async () => {
      policyReads++
      return currentPolicy
    },
    publish: () => {
      throw new Error('This request has no optional first surface.')
    },
  })
  const reservation = { ramBytes: 256 * 1024 ** 2, vramBytes: 256 * 1024 ** 2 }
  let pending: ReturnType<typeof cache.requestHdr> | undefined
  try {
    await cache.open()
    pending = cache.requestHdr(ids[0], randomUUID(), false, 'hdr', undefined, reservation)
    void pending.catch(() => undefined)
    // Mutate the caller's object before queued options/policy admission can resume.
    reservation.ramBytes = 512 * 1024 ** 2
    reservation.vramBytes = 768 * 1024 ** 2
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Source preparation completed before its admission witness.')
      }),
    ])
    expect(captures[0].originalSha256).toBe(ids[0])
    expect(captures[0].parentWorkingKey).not.toBe('')
    expect(captures[0].rendererReservation).toEqual({
      ramBytes: 256 * 1024 ** 2,
      vramBytes: 256 * 1024 ** 2,
    })
    expect(captures[0].policy.revision).toBe(19)
    expect(captures[0].policy.ram.effectiveBytes).toBe(1024 ** 3)
    const admitted = structuredClone(captures[0])
    currentPolicy = nativePreparationPolicy(4096, 20)
    expect(captures[0]).toEqual(admitted)
    expect(policyReads).toBe(1)
    complete.resolve()
    const first = (await pending)!
    expect(first.format).toBe('hdr-working')
    const second = (await cache.requestHdr(
      ids[1],
      randomUUID(),
      false,
      'hdr',
      undefined,
      reservation,
    ))!
    expect(second.format).toBe('hdr-working')
    expect(captures).toHaveLength(2)
    expect(captures[1].originalSha256).toBe(ids[1])
    expect(captures[1].policy.revision).toBe(20)
    expect(captures[1].policy.ram.effectiveBytes).toBe(4 * 1024 ** 3)
    expect(captures[1].rendererReservation).toEqual(reservation)
    expect(captures[0]).toEqual(admitted)
    const cached = (await cache.requestHdr(
      ids[0],
      randomUUID(),
      false,
      'hdr',
      undefined,
      reservation,
    ))!
    expect(cached.linear.url).toBe(first.linear.url)
    expect(captures).toHaveLength(2)
    expect(policyReads).toBe(2)
  } finally {
    complete.resolve()
    await pending?.catch(() => undefined)
    await cache.close()
  }
})

test('inconsistent or malformed HDR reservations reject before settings, policy or processor admission', async () => {
  let policyReads = 0,
    renders = 0,
    settingsReads = 0
  const cache = new FullPreviews(
    test.info().outputPath('native-admission-invalid'),
    original,
    {
      renderFull: async (_path, output) => {
        renders++
        return writeWorkingFrame(output)
      },
      close: async () => {},
    },
    undefined,
    async () => {
      settingsReads++
      return nativePreparationOptions()
    },
  )
  cache.installFirstSurface({
    policy: async () => {
      policyReads++
      return nativePreparationPolicy(1024, 1)
    },
    publish: () => {
      throw new Error('Invalid reservations must never publish a surface.')
    },
  })
  const first: HdrFirstSurfaceRequest = {
    version: HDR_FIRST_SURFACE_VERSION,
    generation: 1,
    settingsRevision: 0,
    parameters: { ...neutralAdjustments },
    target: { ...SDR_TARGET, generation: 3 },
    viewport: { width: 1024, height: 512 },
    dpr: 1,
    view: { fit: true, scale: 0.25, x: 0, y: 0 },
    comparison: 'after',
    split: 0.5,
    hdrRanges: false,
    kernel: 'linear64',
    rendererReservation: { ramBytes: 256 * 1024 ** 2, vramBytes: 256 * 1024 ** 2 },
  }
  try {
    await cache.open()
    await expect(
      cache.requestHdr(ids[0], randomUUID(), false, 'hdr', first, {
        ...first.rendererReservation,
        ramBytes: first.rendererReservation.ramBytes + 1,
      }),
    ).rejects.toThrow('reservations disagree')
    const invalid = [
      { ramBytes: -1, vramBytes: 0 },
      { ramBytes: 0, vramBytes: Number.NaN },
      { ramBytes: 0.5, vramBytes: 0 },
      { ramBytes: 0, vramBytes: 0, driverBytes: 0 },
    ]
    for (const reservation of invalid)
      await expect(
        cache.requestHdr(ids[0], randomUUID(), false, 'hdr', undefined, reservation),
      ).rejects.toThrow('Invalid managed image reservation')
    expect(settingsReads).toBe(0)
    expect(policyReads).toBe(0)
    expect(renders).toBe(0)
  } finally {
    await cache.close()
  }
})

test('a manual HDR request without a renderer reservation retains the existing source route', async () => {
  let renders = 0,
    policyReads = 0
  const cache = new FullPreviews(
    test.info().outputPath('native-admission-manual'),
    original,
    {
      renderFull: async (_path, output, _signal, processing, progress, preparation) => {
        renders++
        expect(processing?.workingOnly).toBe(true)
        expect(processing?.firstSurface).toBeUndefined()
        expect(progress).toBeUndefined()
        expect(preparation).toBeUndefined()
        return writeWorkingFrame(output)
      },
      close: async () => {},
    },
    undefined,
    async () => nativePreparationOptions(),
  )
  cache.installFirstSurface({
    policy: async () => {
      policyReads++
      return nativePreparationPolicy(1024, 1)
    },
    publish: () => {
      throw new Error('A manual source request has no optional first surface.')
    },
  })
  try {
    await cache.open()
    expect((await cache.requestHdr(ids[0], randomUUID()))!.format).toBe('hdr-working')
    expect(renders).toBe(1)
    expect(policyReads).toBe(0)
  } finally {
    await cache.close()
  }
})
