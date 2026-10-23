import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { FullPreviews } from '../src/main/full-previews'
import { createPreviewAssetStream } from '../src/main/preview-asset-stream'
import type {
  FullPreviewResult,
  HdrFirstSurfaceArtifact,
  HdrFirstSurfaceProgress,
} from '../src/main/preview-types'
import { unavailableProfile } from '../src/main/processing/metadata'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { packAces } from '../src/shared/aces-data'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../src/shared/display-rendering'
import { SDR_TARGET, HDR_ADJUSTMENT_VERSION, HDR_OUTPUT_VERSION } from '../src/shared/hdr'
import {
  HDR_FIRST_SURFACE_VERSION,
  hdrFirstSurfaceOfferMatches,
  hdrFirstSurfaceOrientation,
  type HdrFirstSurfaceOffer,
  type HdrFirstSurfacePreparation,
  type HdrFirstSurfaceRequest,
} from '../src/shared/hdr-first-surface'
import { automaticLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'
import { HDR_SOURCE_MIP_POLICY } from '../src/renderer/src/preview/hdr-source-cache'
import { hdrCacheTileSize } from '../src/renderer/src/preview/hdr-render-cache'
import {
  hdrCacheKernel,
  hdrMipShader,
  hdrOrientedMipShader,
  hdrShader,
} from '../src/renderer/src/preview/hdr-shader'
import { workingAsset } from './export.helpers'

// Injected processing writes real files; no decoder, native child, GPU or paint is exercised.
const photoId = 'a'.repeat(64)
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const image = { width: 12, height: 8 }
const packed = packAces(prepareDisplayRendering({ mode: 'sdr', peak: 1, colorSpace: 'srgb' }))
const programHashes = Object.freeze({
  mip: digest(hdrMipShader),
  orientedMip: digest(hdrOrientedMipShader),
  tiles: digest(hdrCacheKernel().shader),
  presentation: digest(hdrShader),
  tables: digest(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)),
})

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(): HdrFirstSurfaceRequest {
  return {
    version: HDR_FIRST_SURFACE_VERSION,
    generation: 1,
    settingsRevision: 7,
    parameters: structuredClone(neutralAdjustments),
    target: { ...SDR_TARGET, generation: 3 },
    viewport: { width: 1024, height: 512 },
    dpr: 1,
    view: { fit: true, scale: 0.25, x: 0, y: 0 },
    comparison: 'after',
    split: 0.5,
    hdrRanges: false,
    kernel: 'linear64',
    rendererReservation: { ramBytes: 0, vramBytes: 0 },
  }
}

function artifact(first: HdrFirstSurfacePreparation, body: Buffer): HdrFirstSurfaceArtifact {
  return {
    width: first.viewport.width,
    height: first.viewport.height,
    byteLength: body.length,
    sha256: digest(body),
    programHashes,
    timings: { fixtureFileWriteMs: 0 },
    identity: {
      version: first.version,
      generation: first.generation,
      settingsRevision: first.settingsRevision,
      parameters: first.parameters,
      target: first.target,
      viewport: first.viewport,
      dpr: first.dpr,
      view: { fit: true, scale: 1, x: 0, y: 0 },
      comparison: first.comparison,
      split: first.split,
      hdrRanges: first.hdrRanges,
      kernel: first.kernel,
      originalSha256: first.originalSha256,
      parentWorkingKey: first.parentWorkingKey,
      image,
      sourceIdentity: {
        processing: 'synthetic-first-surface-service-fixture',
        adjustmentVersion: HDR_ADJUSTMENT_VERSION,
        outputVersion: HDR_OUTPUT_VERSION,
        mipPolicy: HDR_SOURCE_MIP_POLICY,
        arithmetic: 'reference',
        tileSize: hdrCacheTileSize(image.width, image.height),
        orientation: hdrFirstSurfaceOrientation(image, 0, 0),
      },
    },
  }
}

type Failure =
  | 'short-file'
  | 'wrong-hash'
  | 'symlink'
  | 'stale-progress'
  | 'bad-program'
  | 'bad-table'
  | 'hdr-table-for-sdr'
  | 'p3-table-for-srgb'
  | 'invalid-progress'

async function fixture(name: string, failure?: Failure) {
  const root = test.info().outputPath(name)
  const terminal = gate(),
    offered = gate<HdrFirstSurfaceOffer>(),
    interrupted = gate()
  const offers: HdrFirstSurfaceOffer[] = []
  const request = snapshot()
  const half = new Uint16Array(request.viewport.width * request.viewport.height * 4)
  half.fill(0x3400)
  for (let index = 3; index < half.length; index += 4) half[index] = 0x3c00
  const body = Buffer.from(half.buffer)
  const options: ProcessingOptions = {
    processing: 'hdr-v1',
    metadata: { version: 1, lensProfile: unavailableProfile },
    settings: { ...automaticLensSettings },
    adjustments: structuredClone(neutralAdjustments),
    revision: request.settingsRevision,
  }
  const policy = resolveResourcePolicy(
    DEFAULT_RESOURCE_SETTINGS,
    {
      ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 },
      gpu: { status: 'unknown', reason: 'adapter-unverified' },
    },
    1,
  )
  let fileClosedBeforeOffer = false,
    renderCount = 0,
    linearWrites = 0
  const cache = new FullPreviews(
    root,
    (id) => (id === photoId ? resolve('tests/fixtures/sony-zv1.ARW') : undefined),
    {
      renderFull: async (_path, output, signal, processing, progress) => {
        renderCount++
        const first = processing?.firstSurface
        if (!first || !progress) throw new Error('Missing first-surface fixture request.')
        const firstPath = join(output, 'first.rgba16')
        if (failure === 'symlink') {
          const target = join(output, 'symlink-target.rgba16')
          await writeFile(target, body)
          await symlink(target, firstPath)
        } else {
          const file = await open(firstPath, 'wx')
          try {
            const actual =
              failure === 'short-file'
                ? body.subarray(0, body.length - 8)
                : failure === 'wrong-hash'
                  ? Buffer.alloc(body.length, 0x7f)
                  : body
            await file.writeFile(actual)
          } finally {
            await file.close()
          }
        }
        fileClosedBeforeOffer = true
        let surface = artifact(first, body)
        if (failure === 'stale-progress')
          surface = { ...surface, identity: { ...surface.identity, generation: 2 } }
        if (failure === 'bad-program')
          surface = { ...surface, programHashes: { ...programHashes, mip: '0'.repeat(64) } }
        if (failure === 'bad-table')
          surface = { ...surface, programHashes: { ...programHashes, tables: '0'.repeat(64) } }
        if (failure === 'hdr-table-for-sdr' || failure === 'p3-table-for-srgb') {
          const alternate = packAces(
            prepareDisplayRendering(
              failure === 'hdr-table-for-sdr'
                ? HDR_CONTENT_TARGET
                : { mode: 'sdr', peak: 1, colorSpace: 'display-p3' },
            ),
          )
          const tables = digest(
            new Uint8Array(alternate.buffer, alternate.byteOffset, alternate.byteLength),
          )
          if (tables === programHashes.tables)
            throw new Error('The independently recomputed alternate table must differ.')
          surface = { ...surface, programHashes: { ...programHashes, tables } }
        }
        await progress(
          failure === 'invalid-progress'
            ? ({ status: 'unknown' } as unknown as HdrFirstSurfaceProgress)
            : { status: 'ready', artifact: surface },
        )
        let abort!: () => void
        try {
          await Promise.race([
            terminal.promise,
            new Promise<never>((_resolve, reject) => {
              abort = () => {
                interrupted.resolve()
                reject(signal.reason ?? new Error('Fixture processing cancelled.'))
              }
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
            }),
          ])
          signal.throwIfAborted()
        } finally {
          signal.removeEventListener('abort', abort)
        }
        const pixels = new Float32Array(image.width * image.height * 4).fill(0.25)
        for (let index = 3; index < pixels.length; index += 4) pixels[index] = 1
        const linear = Buffer.from(pixels.buffer)
        const hdr = workingAsset(linear, image.width, image.height)
        await writeFile(join(output, 'linear.f32'), linear)
        linearWrites++
        const result: FullPreviewResult = {
          ...image,
          format: 'hdr-working',
          byteLength: 0,
          sha256: hdr.sha256,
          renderId: 'synthetic-first-surface-service-fixture',
          placeholderBytes: 0,
          linear: { byteLength: linear.length, sha256: hdr.sha256, transform: srgbTransform, hdr },
          firstSurface: surface,
        }
        return result
      },
      close: async () => {},
    },
    undefined,
    async () => structuredClone(options),
  )
  cache.installFirstSurface({
    policy: async () => policy,
    publish: (offer) => {
      expect(fileClosedBeforeOffer).toBe(true)
      offers.push(offer)
      offered.resolve(offer)
    },
  })
  await cache.open()
  const token = randomUUID()
  const work = cache.requestHdr(photoId, token, false, 'hdr', request)
  // Failure assertions attach below after construction; observe early rejections immediately.
  void work.catch(() => undefined)
  const first = () =>
    Promise.race([
      offered.promise,
      work.then(
        () => {
          throw new Error('Fixture completed before publishing its first surface.')
        },
        (error: unknown) => {
          throw error
        },
      ),
    ])
  const leases = new Set<SurfaceLease>()
  const streams = new Set<ReturnType<typeof protocolStream>>()
  const acquire = (url: URL) => {
    const lease = cache.acquire(url)
    if (lease) leases.add(lease)
    return lease
  }
  const hold = (lease: SurfaceLease, signal?: AbortSignal) =>
    heldStream(lease, signal, (protocol) => streams.add(protocol))
  const dispose = async () => {
    terminal.resolve()
    // A stream retains its lease until its real close event drains pending reads.
    await Promise.all(
      [...streams].map(async ({ stream, closed }) => {
        stream.destroy()
        await closed
      }),
    )
    // Includes raw acquisitions that failed an assertion before becoming streams.
    for (const lease of leases) lease.release()
    await work.catch(() => undefined)
    await cache.close()
  }
  return {
    cache,
    request,
    token,
    body,
    offers,
    terminal,
    interrupted,
    work,
    first,
    acquire,
    hold,
    dispose,
    currentOptions: options,
    renderCount: () => renderCount,
    linearWrites: () => linearWrites,
  }
}

type SurfaceLease = NonNullable<ReturnType<FullPreviews['acquire']>>

function protocolStream(lease: SurfaceLease, signal = new AbortController().signal) {
  if (!lease.file) throw new Error('First surface did not supply its held descriptor.')
  let releases = 0
  const stream = createPreviewAssetStream(
    {
      ...lease,
      release: () => {
        releases++
        lease.release()
      },
    },
    0,
    lease.byteLength - 1,
    signal,
  )
  stream.on('error', () => undefined)
  const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()))
  return { stream, closed, releases: () => releases }
}

async function heldStream(
  lease: SurfaceLease,
  signal: AbortSignal | undefined,
  track: (protocol: ReturnType<typeof protocolStream>) => void,
) {
  const protocol = protocolStream(lease, signal)
  track(protocol)
  const { stream } = protocol
  try {
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const parts = [Buffer.from(first.value as Uint8Array)]
    const drain = async () => {
      for (let item = await iterator.next(); !item.done; item = await iterator.next())
        parts.push(Buffer.from(item.value as Uint8Array))
      await protocol.closed
      return Buffer.concat(parts)
    }
    return { ...protocol, drain }
  } catch (error) {
    stream.destroy()
    await protocol.closed
    throw error
  }
}

test('a verified first file is offered before terminal completion and revoked capabilities preserve the acquired inode', async () => {
  const f = await fixture('early-file-capability')
  try {
    const offer = await f.first()
    expect(hdrFirstSurfaceOfferMatches(offer, f.request, photoId, f.token)).toBe(true)
    let terminalSettled = false
    void f.work
      .finally(() => {
        terminalSettled = true
      })
      .catch(() => undefined)
    await Promise.resolve()
    expect(terminalSettled).toBe(false)
    const initial = f.acquire(new URL(offer.url))!
    expect(initial).toBeDefined()
    expect(initial.file).toBeDefined()
    expect(await readFile(initial.path)).toEqual(f.body)
    expect(digest(await readFile(initial.path))).toBe(offer.sha256)
    const firstFetchAbort = new AbortController()
    const firstFetch = await f.hold(initial, firstFetchAbort.signal)
    expect(await firstFetch.drain()).toEqual(f.body)
    expect(firstFetch.releases()).toBe(1)
    firstFetchAbort.abort()
    firstFetch.stream.destroy()
    await Promise.resolve()
    expect(firstFetch.releases()).toBe(1)
    expect((await initial.file!.stat()).size).toBe(f.body.length)
    await f.cache.releaseFirstSurface(randomUUID(), offer.surfaceId)
    const stillAvailable = f.acquire(new URL(offer.url))!
    expect(stillAvailable).toBeDefined()
    stillAvailable.release()
    const lease = f.acquire(new URL(offer.url))!
    const held = await f.hold(lease)
    const moved = `${lease.path}.original`
    await rename(lease.path, moved)
    await writeFile(lease.path, Buffer.alloc(f.body.length, 0x7f))
    let firstReleaseDone = false,
      repeatedReleaseDone = false
    const firstRelease = f.cache.releaseFirstSurface(f.token, offer.surfaceId).then(() => {
      firstReleaseDone = true
    })
    const repeatedRelease = f.cache.releaseFirstSurface(f.token, offer.surfaceId).then(() => {
      repeatedReleaseDone = true
    })
    expect(f.acquire(new URL(offer.url))).toBeUndefined()
    await Promise.resolve()
    expect(firstReleaseDone).toBe(false)
    expect(repeatedReleaseDone).toBe(false)
    expect((await lease.file!.stat()).size).toBe(f.body.length)
    expect(await held.drain()).toEqual(f.body)
    expect(held.releases()).toBe(1)
    await rm(lease.path)
    await rename(moved, lease.path)
    await Promise.all([firstRelease, repeatedRelease])
    await expect(lease.file!.stat()).rejects.toMatchObject({ code: 'EBADF' })
    f.terminal.resolve()
    const result = await f.work
    expect(result?.firstSurfaceLineage?.parentWorkingKey).toBe(offer.identity.parentWorkingKey)
    expect(f.offers).toHaveLength(1)
  } finally {
    await f.dispose()
  }
})

test('aborting a real protocol stream drains its lease while the active owner descriptor remains reusable', async () => {
  const f = await fixture('aborted-protocol-stream')
  try {
    const offer = await f.first()
    const lease = f.acquire(new URL(offer.url))!
    const controller = new AbortController()
    const cancelled = await f.hold(lease, controller.signal)
    controller.abort()
    await cancelled.closed
    expect(cancelled.releases()).toBe(1)
    expect((await lease.file!.stat()).size).toBe(f.body.length)
    const next = f.acquire(new URL(offer.url))!
    expect(next).toBeDefined()
    const fetched = await f.hold(next)
    expect(await fetched.drain()).toEqual(f.body)
    expect(fetched.releases()).toBe(1)
    expect((await lease.file!.stat()).size).toBe(f.body.length)
    await f.cache.releaseFirstSurface(f.token, offer.surfaceId)
    await expect(lease.file!.stat()).rejects.toMatchObject({ code: 'EBADF' })
    f.terminal.resolve()
    await f.work
  } finally {
    await f.dispose()
  }
})

test('ordinary Light revisions retain exact prepared-source lineage when an optional first surface no longer matches', async () => {
  const f = await fixture('edited-source-lineage')
  try {
    const offer = await f.first()
    f.terminal.resolve()
    const initial = await f.work
    expect(initial).not.toBeNull()
    expect(initial!.firstSurfaceLineage).toEqual({
      parentWorkingKey: offer.identity.parentWorkingKey,
      workingSha256: initial!.linear.sha256,
    })
    f.currentOptions.revision++
    f.currentOptions.adjustments = { ...neutralAdjustments, exposureEv: 1.25 }
    const current: HdrFirstSurfaceRequest = {
      ...f.request,
      generation: f.request.generation + 1,
      settingsRevision: f.currentOptions.revision,
      parameters: structuredClone(f.currentOptions.adjustments),
    }
    const edited = await f.cache.requestHdr(photoId, randomUUID(), false, 'hdr', current)
    expect(edited).not.toBeNull()
    expect(edited!.settingsRevision).toBe(f.currentOptions.revision)
    expect(edited!.adjustments?.exposureEv).toBe(1.25)
    expect(edited!.firstSurfaceDecline).toBe('cached-first-surface-identity-mismatch')
    expect(edited!.firstSurfaceLineage).toEqual(initial!.firstSurfaceLineage)
    expect(edited!.linear.sha256).toBe(initial!.linear.sha256)
    expect(edited!.linear.url).toBe(initial!.linear.url)
    expect(f.offers).toHaveLength(1)
    const ordinary = await f.cache.requestHdr(photoId, randomUUID())
    expect(ordinary).not.toBeNull()
    expect(ordinary!.settingsRevision).toBe(f.currentOptions.revision)
    expect(ordinary!.adjustments?.exposureEv).toBe(1.25)
    expect(ordinary!.firstSurfaceLineage).toEqual(initial!.firstSurfaceLineage)
    expect(ordinary!.linear.sha256).toBe(initial!.linear.sha256)
    expect(ordinary!.linear.url).toBe(initial!.linear.url)
    expect(f.offers).toHaveLength(1)
    expect(f.renderCount()).toBe(1)
    expect(f.linearWrites()).toBe(1)
  } finally {
    await f.dispose()
  }
})

test('a retained optional half with obsolete orientation/program proof is removed while its independently verified F32 source survives', async () => {
  const f = await fixture('retained-old-half-proof')
  let reopened: FullPreviews | undefined
  try {
    await f.first()
    f.terminal.resolve()
    const initial = (await f.work)!
    const lease = f.acquire(new URL(initial.linear.url))!
    expect(lease).toBeDefined()
    const entry = dirname(lease.path),
      firstPath = join(entry, 'first.rgba16')
    lease.release()
    await f.cache.release(f.token)
    await f.cache.close()
    const metadataPath = join(entry, 'entry.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      firstSurface?: HdrFirstSurfaceArtifact
      bytes: number
      firstSurfaceDecline?: string
    }
    const prior = metadata.firstSurface!
    expect((await stat(firstPath)).size).toBe(prior.byteLength)
    const sourceIdentity = { ...prior.identity.sourceIdentity }
    const oldPrograms = { ...prior.programHashes }
    delete sourceIdentity.orientation
    delete oldPrograms.orientedMip
    metadata.firstSurface = {
      ...prior,
      programHashes: oldPrograms,
      identity: { ...prior.identity, sourceIdentity },
    }
    const previousBytes = metadata.bytes
    await writeFile(metadataPath, JSON.stringify(metadata))
    let rerenders = 0
    reopened = new FullPreviews(
      dirname(dirname(entry)),
      (id) => (id === photoId ? resolve('tests/fixtures/sony-zv1.ARW') : undefined),
      {
        renderFull: async () => {
          rerenders++
          throw new Error('Retained F32 must not regenerate.')
        },
        close: async () => {},
      },
      undefined,
      async () => structuredClone(f.currentOptions),
    )
    await reopened.open()
    await expect(stat(firstPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const retained = JSON.parse(await readFile(metadataPath, 'utf8')) as typeof metadata
    expect(retained.firstSurface).toBeUndefined()
    expect(retained.firstSurfaceDecline).toBe('cached-first-surface-unavailable')
    expect(retained.bytes).toBe(previousBytes - prior.byteLength)
    expect(digest(await readFile(join(entry, 'linear.f32')))).toBe(initial.linear.sha256)
    const current = await reopened.requestHdr(photoId, randomUUID())
    expect(current!.firstSurfaceLineage).toEqual(initial.firstSurfaceLineage)
    expect(current!.linear.sha256).toBe(initial.linear.sha256)
    expect(rerenders).toBe(0)
    expect(f.linearWrites()).toBe(1)
  } finally {
    await reopened?.close()
    await f.dispose()
  }
})

for (const action of ['release', 'removal'] as const) {
  for (const completed of [false, true]) {
    test(`${action} waits for an owned first-surface stream ${completed ? 'after' : 'before'} terminal completion`, async () => {
      const f = await fixture(`${action}-${completed ? 'complete' : 'running'}`)
      try {
        const offer = await f.first()
        if (completed) {
          f.terminal.resolve()
          await f.work
        }
        const lease = f.acquire(new URL(offer.url))!
        expect(lease).toBeDefined()
        const held = await f.hold(lease)
        let drained = false
        const retiring = (
          action === 'release' ? f.cache.release(f.token) : f.cache.beginRemoval(photoId)
        ).then(() => {
          drained = true
        })
        if (!completed) await f.interrupted.promise
        else await Promise.resolve()
        expect(f.acquire(new URL(offer.url))).toBeUndefined()
        expect(drained).toBe(false)
        expect((await lease.file!.stat()).size).toBe(f.body.length)
        expect(await held.drain()).toEqual(f.body)
        expect(held.releases()).toBe(1)
        await retiring
        await expect(lease.file!.stat()).rejects.toMatchObject({ code: 'EBADF' })
        if (!completed) await expect(f.work).rejects.toThrow(/cancelled|removed/i)
        if (action === 'removal') f.cache.endRemoval(photoId, true)
        expect(f.acquire(new URL(offer.url))).toBeUndefined()
      } finally {
        await f.dispose()
      }
    })
  }
}

for (const [failure, message] of [
  ['short-file', /incomplete first HDR surface file/i],
  ['wrong-hash', /damaged first HDR surface file/i],
  ['symlink', /ELOOP|symbolic links/i],
  ['stale-progress', /does not match its admitted request/i],
  ['bad-program', /pixel programs do not match/i],
  ['bad-table', /pixel programs do not match/i],
  ['hdr-table-for-sdr', /pixel programs do not match/i],
  ['p3-table-for-srgb', /pixel programs do not match/i],
  ['invalid-progress', /invalid first HDR surface progress/i],
] as const) {
  test(`first-surface publication rejects ${failure} before exposing a capability`, async () => {
    const f = await fixture(`reject-${failure}`, failure)
    try {
      await expect(f.work).rejects.toThrow(message)
      expect(f.offers).toHaveLength(0)
    } finally {
      await f.dispose()
    }
  })
}
