import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import { PREVIEW_ASSET_VERSION } from '../src/shared/preview-frame'
import {
  HDR_FIRST_SURFACE_VERSION,
  hdrFirstSurfaceOfferMatches,
  hdrFirstSurfaceRequestKey,
  validateHdrFirstSurfaceRequest,
  hdrFirstSurfaceImage,
  hdrFirstSurfaceMipLevel,
  hdrFirstSurfaceOrientation,
  validateHdrFirstSurfaceOrientation,
  type HdrFirstSurfaceOffer,
  type HdrFirstSurfaceRequest,
} from '../src/shared/hdr-first-surface'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'
import { hdrMipShader } from '../src/renderer/src/preview/hdr-shader'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../src/shared/display-rendering'
import {
  HDR_RENDERING_TABLE_HASHES,
  HDR_RENDERING_TABLES_VERSION,
} from '../src/shared/hdr-rendering-tables'
import {
  manuallyOrientedThreeByTwo,
  orientedPixelOrder,
  orientationInput,
} from './hdr-first-surface-orientation.helpers'

test('the ordinary source-mip program remains byte-for-byte the established reference', () => {
  expect(createHash('sha256').update(hdrMipShader).digest('hex')).toBe(
    'ed44a2f14edeeb352613af088e94016f28aff97c793b421a92e4ff1b6215c140',
  )
})

test('versioned fixed table identities match all three independently recomputed packed byte sets', () => {
  expect(HDR_RENDERING_TABLE_HASHES.version).toBe(HDR_RENDERING_TABLES_VERSION)
  expect(HDR_RENDERING_TABLE_HASHES.version).toBe(
    'aces2-069b0bc3-v3:hdr-content-v1-aces2-rec2020-1000-d65:fixed-sdr-srgb-p3-v1',
  )
  expect(HDR_CONTENT_TARGET).toEqual({ mode: 'hdr', peak: 10, colorSpace: 'rec2020' })
  const targets = [
    ['hdr', HDR_CONTENT_TARGET],
    ['srgb', { mode: 'sdr', peak: 1, colorSpace: 'srgb' }],
    ['display-p3', { mode: 'sdr', peak: 1, colorSpace: 'display-p3' }],
  ] as const
  const hashes = targets.map(([name, target]) => {
    const packed = packAces(prepareDisplayRendering(target)),
      bytes = new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength),
      hash = createHash('sha256').update(bytes).digest('hex')
    expect(bytes.byteLength).toBe(ACES_DATA_BYTES)
    expect(bytes.byteLength).toBe(28240)
    expect(packed.every(Number.isFinite)).toBe(true)
    expect(hash, name).toBe(HDR_RENDERING_TABLE_HASHES[name])
    return hash
  })
  expect(new Set(hashes).size).toBe(3)
})

test('the independent mip fixture exposes reassociation of alpha-premultiplied ordered sums', () => {
  const input = orientationInput(17, 11)
  const terms = [2, 3, 19, 20].map((pixel) => Math.fround(input[pixel * 4] * input[pixel * 4 + 3]))
  const sum = (values: number[]) => values.reduce((total, value) => Math.fround(total + value), 0)
  expect(terms).toEqual([2 ** 24, 0.5, -(2 ** 24), 0.5])
  expect(sum(terms)).not.toBe(sum(terms.slice().reverse()))
})

test('all decoder flips retain independent forward orientation and authoritative Fit mip identity', () => {
  for (let flip = 0; flip < 8; flip++) {
    expect(orientedPixelOrder(3, 2, flip).pixels).toEqual(manuallyOrientedThreeByTwo[flip])
    const corrected = { width: 17, height: 11 }
    const image = hdrFirstSurfaceImage(corrected, flip)
    expect(image).toEqual(flip < 4 ? { width: 17, height: 11 } : { width: 11, height: 17 })
    const viewport = { width: 4, height: 3 }
    const level = hdrFirstSurfaceMipLevel(image, viewport)
    expect(level).toBe(2)
    const orientation = hdrFirstSurfaceOrientation(corrected, flip, level)
    expect(orientation.firstMip).toBe(flip === 0 ? 'ordinary' : 'oriented')
    validateHdrFirstSurfaceOrientation(orientation, image, viewport)
    for (const changed of [
      { ...orientation, selectedLevel: 1 },
      { ...orientation, firstMip: 'source' },
      { ...orientation, corrected: { width: 18, height: 11 } },
      { ...orientation, decoderFlip: 8 },
      { ...orientation, version: 'unknown-orientation' },
    ])
      expect(() => validateHdrFirstSurfaceOrientation(changed, image, viewport)).toThrow()
  }
  for (const flip of [-1, 8, 1.5, NaN])
    expect(() => hdrFirstSurfaceImage({ width: 17, height: 11 }, flip)).toThrow()
  expect(hdrFirstSurfaceOrientation({ width: 17, height: 11 }, 0, 0).firstMip).toBe('source')
  for (let flip = 1; flip < 8; flip++)
    expect(() => hdrFirstSurfaceOrientation({ width: 17, height: 11 }, flip, 0)).toThrow()
})
import { readFirstSurface } from '../src/renderer/src/preview/hdr-first-surface-client'

const photoId = 'a'.repeat(64)
const requestId = 'dddddddd-dddd-4ddd-addd-dddddddddddd'
const surfaceId = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'
const request = (): HdrFirstSurfaceRequest => ({
  version: HDR_FIRST_SURFACE_VERSION,
  generation: 2,
  settingsRevision: 7,
  parameters: structuredClone(neutralAdjustments),
  target: { ...SDR_TARGET, generation: 3 },
  viewport: { width: 2866, height: 1189 },
  dpr: 1,
  view: { fit: true, scale: 1, x: 0, y: 0 },
  comparison: 'after',
  split: 0.5,
  hdrRanges: false,
  kernel: 'linear64',
  rendererReservation: { ramBytes: 256 * 1024 ** 2, vramBytes: 256 * 1024 ** 2 },
})
const offer = (snapshot = request()): HdrFirstSurfaceOffer => {
  const display = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== 'rendererReservation'),
  ) as Omit<HdrFirstSurfaceRequest, 'rendererReservation'>
  const image = { width: 5422, height: 3622 }
  const width = Math.round(snapshot.viewport.width * snapshot.dpr)
  const height = Math.round(snapshot.viewport.height * snapshot.dpr)
  return {
    version: HDR_FIRST_SURFACE_VERSION,
    photoId,
    requestId,
    surfaceId,
    identity: {
      ...display,
      originalSha256: photoId,
      parentWorkingKey: 'b'.repeat(64),
      image,
      sourceIdentity: { processing: 'synthetic-test-source' },
      view: {
        fit: true,
        scale: Math.min(
          1,
          snapshot.viewport.width / image.width,
          snapshot.viewport.height / image.height,
        ),
        x: 0,
        y: 0,
      },
    },
    policy: resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      {
        ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 },
        gpu: { status: 'unknown', reason: 'adapter-unverified' },
      },
      1,
    ),
    format: 'rgba16float-le',
    width,
    height,
    byteLength: width * height * 8,
    sha256: 'c'.repeat(64),
    url: `luma-photo://library/${photoId}/first/${PREVIEW_ASSET_VERSION}/${surfaceId}`,
  }
}

test('a corrected source establishes authoritative centered Fit without reusing catalog scale', () => {
  const snapshot = request(),
    surface = offer(snapshot)
  expect(surface.identity.view.scale).not.toBe(snapshot.view.scale)
  expect(hdrFirstSurfaceOfferMatches(surface, snapshot, photoId, requestId)).toBe(true)
  expect(hdrFirstSurfaceRequestKey(snapshot)).toBe(
    hdrFirstSurfaceRequestKey({
      ...snapshot,
      view: surface.identity.view,
    }),
  )
  const oversized = offer({ ...snapshot, viewport: { width: 12000, height: 12000 } })
  expect(oversized.identity.view.scale).toBe(1)
})

test('received source, request, revision, target and backing extent cannot be relabelled', () => {
  const snapshot = request(),
    good = offer(snapshot)
  for (const alter of [
    (s: HdrFirstSurfaceOffer) => ({ ...s, photoId: 'f'.repeat(64) }),
    (s: HdrFirstSurfaceOffer) => ({ ...s, requestId: surfaceId }),
    (s: HdrFirstSurfaceOffer) => ({ ...s, url: `file:///tmp/${surfaceId}` }),
    (s: HdrFirstSurfaceOffer) => ({ ...s, byteLength: s.byteLength - 8 }),
    (s: HdrFirstSurfaceOffer) => ({ ...s, width: s.width + 1 }),
    (s: HdrFirstSurfaceOffer) => ({ ...s, identity: { ...s.identity, generation: 3 } }),
    (s: HdrFirstSurfaceOffer) => ({ ...s, identity: { ...s.identity, settingsRevision: 8 } }),
    (s: HdrFirstSurfaceOffer) => ({
      ...s,
      identity: { ...s.identity, parameters: { ...s.identity.parameters, exposureEv: 1 } },
    }),
    (s: HdrFirstSurfaceOffer) => ({
      ...s,
      identity: { ...s.identity, target: { ...s.identity.target, generation: 4 } },
    }),
    (s: HdrFirstSurfaceOffer) => ({
      ...s,
      identity: {
        ...s.identity,
        target: { ...s.identity.target, colorSpace: 'display-p3' as const },
      },
    }),
    (s: HdrFirstSurfaceOffer) => ({
      ...s,
      identity: {
        ...s.identity,
        view: { ...s.identity.view, scale: s.identity.view.scale + 0.001 },
      },
    }),
  ])
    expect(hdrFirstSurfaceOfferMatches(alter(good), snapshot, photoId, requestId)).toBe(false)
})

test('non-Fit position, comparison, range and kernel changes invalidate an offer', () => {
  const snapshot = request(),
    surface = offer(snapshot)
  for (const changed of [
    { ...snapshot, view: { ...snapshot.view, fit: false } },
    { ...snapshot, view: { ...snapshot.view, x: 1 } },
    { ...snapshot, comparison: 'before' as const },
    { ...snapshot, hdrRanges: true },
    { ...snapshot, viewport: { ...snapshot.viewport, height: 1190 } },
    { ...snapshot, dpr: 2 },
  ])
    expect(hdrFirstSurfaceOfferMatches(surface, changed, photoId, requestId)).toBe(false)
})

test('invalid dimensions, missing edits, unsafe budgets and extra privileged fields are rejected', () => {
  const snapshot = request()
  validateHdrFirstSurfaceRequest(snapshot)
  expect(
    hdrFirstSurfaceOfferMatches(
      offer(snapshot),
      { ...snapshot, kernel: 'grid8' } as unknown as HdrFirstSurfaceRequest,
      photoId,
      requestId,
    ),
  ).toBe(false)
  for (const changed of [
    { ...snapshot, sourcePath: '/tmp/original.arw' },
    { ...snapshot, kernel: 'grid8' },
    { ...snapshot, viewport: { width: 0, height: 1189 } },
    { ...snapshot, viewport: { width: 0.01, height: 1189 } },
    { ...snapshot, viewport: { width: Number.MAX_VALUE, height: 1189 } },
    { ...snapshot, dpr: Infinity },
    { ...snapshot, parameters: { exposureEv: 0 } },
    { ...snapshot, view: { ...snapshot.view, x: NaN } },
    { ...snapshot, rendererReservation: { ramBytes: -1, vramBytes: 0 } },
    { ...snapshot, rendererReservation: { ramBytes: Number.MAX_SAFE_INTEGER + 1, vramBytes: 0 } },
  ])
    expect(() => validateHdrFirstSurfaceRequest(changed)).toThrow()
})

const halfPixels = () => {
  const bytes = Buffer.alloc(2 * 2 * 8)
  for (let pixel = 0; pixel < 4; pixel++) {
    bytes.writeUInt16LE(0x3800, pixel * 8)
    bytes.writeUInt16LE(0xbc00, pixel * 8 + 2)
    bytes.writeUInt16LE(0x4000, pixel * 8 + 4)
    bytes.writeUInt16LE(0x3c00, pixel * 8 + 6)
  }
  return bytes
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('the binary receiver preserves HDR half values and rejects corrupt, truncated, oversized or nonopaque output', async () => {
  const originalFetch = globalThis.fetch
  const surface = offer({ ...request(), viewport: { width: 2, height: 2 } })
  const valid = halfPixels()
  try {
    for (const kind of ['valid', 'hash', 'short', 'long', 'nan', 'alpha'] as const) {
      const body = Buffer.from(valid)
      if (kind === 'nan') body.writeUInt16LE(0x7e00, 0)
      if (kind === 'alpha') body.writeUInt16LE(0x3800, 6)
      const bytes =
        kind === 'short' ? body.subarray(1) : kind === 'long' ? Buffer.concat([body, body]) : body
      const descriptor = { ...surface, sha256: kind === 'hash' ? '0'.repeat(64) : digest(body) }
      globalThis.fetch = async (url) => {
        expect(String(url)).toBe(descriptor.url)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Deliberately split a half word across chunks.
              controller.enqueue(bytes.subarray(0, 3))
              controller.enqueue(bytes.subarray(3))
              controller.close()
            },
          }),
          { headers: { 'content-length': String(descriptor.byteLength) } },
        )
      }
      const work = readFirstSurface(descriptor, new AbortController().signal)
      if (kind === 'valid') expect(Buffer.from(await work)).toEqual(valid)
      else await expect(work).rejects.toThrow()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('cancellation during a real noninterruptible digest drains that operation before receiver completion', async () => {
  const originalFetch = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest')
  const realDigest = crypto.subtle.digest.bind(crypto.subtle)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((done) => {
    enter = done
  })
  const held = new Promise<void>((done) => {
    release = done
  })
  const body = halfPixels()
  const surface = {
    ...offer({ ...request(), viewport: { width: 2, height: 2 } }),
    sha256: digest(body),
  }
  const abort = new AbortController()
  let settled = false
  let result: Promise<string> | undefined
  try {
    globalThis.fetch = async () =>
      new Response(body, { headers: { 'content-length': String(body.byteLength) } })
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const actual = realDigest(algorithm, data)
        enter()
        await held
        return actual
      },
    })
    result = readFirstSurface(surface, abort.signal).then(
      () => {
        settled = true
        return 'accepted'
      },
      (error: unknown) => {
        settled = true
        return String(error)
      },
    )
    await entered
    abort.abort(new Error('Receiver superseded during digest.'))
    expect(settled).toBe(false)
    release()
    expect(await result).toContain('Receiver superseded during digest.')
  } finally {
    release()
    await result
    globalThis.fetch = originalFetch
    if (descriptor) Object.defineProperty(crypto.subtle, 'digest', descriptor)
    else Reflect.deleteProperty(crypto.subtle, 'digest')
  }
})
