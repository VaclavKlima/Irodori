import { PreviewEngine } from '../src/main/preview-engine'
import { HDR_SOURCE_VERSION } from '../src/shared/hdr'
import { test, expect } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHdrStrips, renderHdr, scanHdr } from '../src/main/processing/hdr-processing'
import { HDR_CONTENT } from '../src/shared/display-rendering'
import sharp from 'sharp'
import { DisplayState } from '../src/main/display-state'
import {
  readHdrUploadBytes,
  validateHdrAsset,
  validateHdrStrip,
} from '../src/renderer/src/preview/hdr-stream'
import type { HdrWorkingAsset } from '../src/shared/hdr'
import {
  validateHdrSource,
  HDR_RAW_SOURCE_VERSION,
  HDR_ADJUSTMENT_VERSION,
  outputHdr,
  encodeHdr,
  SDR_TARGET,
  type RGB,
} from '../src/shared/hdr'
import { FullPreviews } from '../src/main/full-previews'
import { unavailableProfile } from '../src/main/processing/metadata'
import { noLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { srgbTransform, neutralAdjustments } from '../src/shared/adjustments'
import { LENS_RENDER_VERSION, CROP_POLICY } from '../src/main/processing/lens-correction'
import { rawDecoderDefinitions } from '../src/main/processing/formats'
import { cameraProfiles } from '../src/main/processing/cameras'

test('exact content statistics scan validated original working strips independently of monitor presentation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-content-statistics-'))
  const pixels = new Float32Array([0.18, 0.18, 0.18, 1, 4, 4, 4, 1, 1, 0, 0, 0.5, 64, 64, 64, 0])
  const bytes = Buffer.from(pixels.buffer),
    asset = workingAsset(bytes, 4, 1),
    path = join(root, 'working')
  try {
    await writeFile(path, bytes)
    let previous: number[][] | undefined
    for (const target of [
      SDR_TARGET,
      {
        ...SDR_TARGET,
        mode: 'hdr' as const,
        colorSpace: 'display-p3' as const,
        headroom: 2,
        peak: 2,
      },
    ]) {
      const result = await scanHdr(path, {
        asset,
        adjustments: neutralAdjustments,
        domain: 'content-hdr',
        target,
      })
      expect(result).toMatchObject({
        exact: true,
        domain: 'content-hdr',
        content: HDR_CONTENT,
        colorSpace: 'rec2020',
        visiblePixels: 3,
      })
      if (previous) expect(result.rgbHistogram!.rgb).toEqual(previous)
      previous = result.rgbHistogram!.rgb
      if (target.headroom !== null) expect(result.exceedingHeadroom).toBeGreaterThan(0)
    }
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('HDR streams reject interrupted writes, damaged hashes and nonfinite samples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-hdr-assets-')),
    path = join(root, 'pixels')
  const data = new Float32Array([-0.1, 2, 16, 1, 0, 0.18, 1, 0]),
    bytes = Buffer.from(data.buffer)
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const asset = workingAsset(bytes, 2, 1)
  const scan = async () => {
    for await (const data of readHdrStrips(path, asset)) expect(data.length).toBe(8)
  }
  try {
    validateHdrAsset(asset)
    await writeFile(path, bytes)
    await scan()
    await writeFile(path, bytes.subarray(0, 16))
    await expect(scan()).rejects.toThrow('Incomplete')
    await writeFile(path, Buffer.alloc(32))
    await expect(scan()).rejects.toThrow('Damaged')
    data[0] = NaN
    const corrupt = Buffer.from(data.buffer)
    asset.sha256 = asset.strips[0].sha256 = hash(corrupt)
    await writeFile(path, corrupt)
    await expect(scan()).rejects.toThrow('Invalid HDR pixels')
    expect(() => validateHdrAsset({ ...asset, byteLength: 16 })).toThrow('Invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('HDR upload streams validate fragmented bytes and cancel incomplete or superseded reads', async () => {
  const values = new Float32Array(2 * 130 * 4)
  for (let i = 0; i < values.length; i += 4) values.set([-0.1, 2, 16, 1], i)
  const bytes = Buffer.from(values.buffer)
  const asset = workingAsset(bytes, 2, 130)
  const originalFetch = globalThis.fetch
  let cancelled = 0,
    requests = 0
  const serve = (body: Uint8Array, chunk = 73, keepOpen = false) => {
    globalThis.fetch = async (_url, options) => {
      requests++
      let offset = 0
      const response = new Response(
        new ReadableStream({
          start(controller) {
            options?.signal?.addEventListener(
              'abort',
              () => controller.error(options.signal!.reason),
              { once: true },
            )
          },
          pull(controller) {
            if (offset < body.byteLength) {
              controller.enqueue(body.subarray(offset, offset + chunk))
              offset += chunk
            } else if (!keepOpen) controller.close()
          },
          cancel() {
            cancelled++
          },
        }),
        { headers: { 'Content-Length': String(asset.byteLength) } },
      )
      return response
    }
  }
  const scan = async () => {
    let strips = 0
    for await (const next of readHdrUploadBytes(asset)) {
      const strip = await validateHdrStrip(asset, next.index, next.bytes, next.readMs)
      expect(strip.row).toBe(strips++ * 64)
      expect(strip.data[0]).toBeCloseTo(-0.1)
    }
    return strips
  }
  try {
    serve(bytes)
    expect(await scan()).toBe(3)
    expect(requests).toBe(1)
    serve(bytes.subarray(0, bytes.byteLength - 1))
    await expect(scan()).rejects.toThrow('Incomplete')
    serve(Buffer.concat([bytes, Buffer.from([0])]))
    await expect(scan()).rejects.toThrow('Unexpected')
    const damaged = Buffer.from(bytes)
    damaged[0] ^= 1
    serve(damaged)
    await expect(scan()).rejects.toThrow('Damaged')
    serve(new Uint8Array(1024 * 1024 + 1), 1024 * 1024 + 1)
    await expect(scan()).rejects.toThrow('memory limit')
    serve(bytes, 73, true)
    const reader = readHdrUploadBytes(asset)
    await reader.next()
    const before = cancelled
    await reader.return()
    expect(cancelled).toBe(before + 1)
    const abort = new AbortController()
    const pending = readHdrUploadBytes(asset, abort.signal)
    await pending.next()
    abort.abort(new Error('Superseded'))
    await expect(pending.next()).rejects.toThrow('Superseded')
    values[3] = 2
    const invalid = Buffer.from(values.buffer)
    const invalidAsset = workingAsset(invalid, 2, 130)
    await expect(
      validateHdrStrip(invalidAsset, 0, values.buffer.slice(0, 2 * 64 * 16), 0),
    ).rejects.toThrow('Invalid HDR sample')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workspace display generations and persistence never certify physical output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-display-state-'))
  try {
    const state = new DisplayState(root, () => {})
    await state.open()
    expect(state.get()).toMatchObject({ requested: 'auto', mode: 'sdr' })
    const hdr = state.report({
      hardware: true,
      extended: true,
      p3: true,
      headroomStops: 2,
      reason: '',
    })
    expect(hdr).toMatchObject({ mode: 'hdr', peak: 4, physicalOutputVerified: false })
    expect(
      state.report({ hardware: true, extended: true, p3: true, headroomStops: 2, reason: '' })
        .generation,
    ).toBe(hdr.generation)
    const sdr = await state.set('sdr')
    expect(sdr.peak).toBe(1)
    expect(sdr.generation).toBeGreaterThan(hdr.generation)
    const restarted = new DisplayState(root, () => {})
    await restarted.open()
    expect(restarted.get().requested).toBe('sdr')
    await state.set('hdr')
    state.invalidate('Device lost')
    expect(state.get()).toMatchObject({ mode: 'sdr', reason: 'Device lost' })
    expect(() =>
      state.report({ hardware: true, extended: true, p3: true, headroomStops: NaN, reason: '' }),
    ).toThrow('Invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function workingAsset(bytes: Buffer, width: number, height: number): HdrWorkingAsset {
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  return {
    kind: 'hdr-working-v1',
    url: 'luma-photo://library/test',
    width,
    height,
    byteLength: bytes.byteLength,
    sha256: hash(bytes),
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, index) => {
      const strip = bytes.subarray(index * width * 64 * 16, (index + 1) * width * 64 * 16)
      return { byteLength: strip.byteLength, sha256: hash(strip) }
    }),
    source: {
      version: HDR_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      normalization: {
        black: [800, 800, 800, 800],
        maximum: 15580,
        gains: [2, 1, 1, 1],
        restoreGain: 2,
        referenceWhite: 1,
        sourceSaturation: null,
      },
      decoder: 'test',
      cameraProfile: 'test',
      orientation: 'applied-once',
    },
  }
}

test('sensor blend invalidates only HDR RAW caches and preserves existing composite and legacy assets', async () => {
  const root = test.info().outputPath('sensor-cache')
  const bytes = Buffer.from(new Float32Array([2, 1, 0.5, 1]).buffer)
  const asset = workingAsset(bytes, 1, 1)
  const composite = structuredClone(asset)
  composite.source.composite = { kind: 'hdr', sourceCount: 3 }
  const options: ProcessingOptions = {
    processing: 'hdr-v1',
    revision: 0,
    settings: noLensSettings,
    metadata: { version: 3, lensProfile: unavailableProfile },
  }
  const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
  const masterOptions = {
    ...options,
    metadata: { ...options.metadata, mergeMaster: { asset: composite, recipe: {} } },
  } as ProcessingOptions
  let renders = 0
  const create = () =>
    new FullPreviews(
      root,
      () => '/managed/source.ARW',
      {
        close: async () => {},
        renderFull: async (_path, output, _signal, selected) => {
          renders++
          if (selected?.processing === 'display-referred-v1') {
            const rgba = Buffer.from([20, 30, 40, 255])
            await writeFile(join(output, 'full.rgba'), rgba)
            await writeFile(join(output, 'placeholder.png'), 'placeholder')
            return {
              width: 1,
              height: 1,
              format: 'rgba8-srgb',
              byteLength: 4,
              sha256: createHash('sha256').update(rgba).digest('hex'),
              renderId: 'legacy',
              placeholderBytes: 11,
            }
          }
          const prepared = structuredClone(selected?.metadata.mergeMaster ? composite : asset)
          if (!prepared.source.composite) prepared.source.highlightBlend = 'sensor-blend-v1'
          await writeFile(join(output, 'linear.f32'), bytes)
          return {
            width: 1,
            height: 1,
            format: 'hdr-working',
            byteLength: 0,
            sha256: prepared.sha256,
            renderId: 'prepared',
            placeholderBytes: 0,
            linear: {
              byteLength: prepared.byteLength,
              sha256: prepared.sha256,
              transform: srgbTransform,
              hdr: prepared,
            },
          }
        },
      },
      undefined,
      async (id) =>
        id === ids[1]
          ? masterOptions
          : id === ids[2]
            ? { ...options, processing: 'display-referred-v1' }
            : { ...options },
    )
  let cache = create()
  try {
    await cache.open()
    const raw = (await cache.requestHdr(ids[0], randomUUID()))!
    const master = (await cache.requestHdr(ids[1], randomUUID()))!
    const legacy = await cache.request(ids[2], randomUUID())
    const lease = cache.acquire(new URL(raw.linear.url))!
    const metadataPath = join(lease.path, '..', 'entry.json')
    lease.release()
    await cache.close()
    const entry = JSON.parse(await readFile(metadataPath, 'utf8'))
    const oldKey = createHash('sha256')
      .update(
        JSON.stringify([
          ids[0],
          'hdr-v1',
          HDR_SOURCE_VERSION,
          LENS_RENDER_VERSION,
          CROP_POLICY,
          rawDecoderDefinitions,
          cameraProfiles,
          unavailableProfile.identity,
          undefined,
          noLensSettings,
        ]),
      )
      .digest('hex')
    entry.sourceKey = oldKey
    entry.variant = `working-${oldKey}`
    entry.renderId = `${HDR_SOURCE_VERSION}-${asset.sha256}`
    delete entry.linear.hdr.source.highlightBlend
    await writeFile(metadataPath, JSON.stringify(entry))
    cache = create()
    await cache.open()
    const retained = (await cache.requestHdr(ids[1], randomUUID()))!
    expect(retained.linear.url).toBe(master.linear.url)
    expect(retained.linear.hdr!.source).toEqual(composite.source)
    expect((await cache.request(ids[2], randomUUID())).url).toBe(legacy.url)
    expect(renders).toBe(3)
    const regenerated = (await cache.requestHdr(ids[0], randomUUID()))!
    expect(regenerated.linear.url).not.toBe(raw.linear.url)
    expect(regenerated.renderId).toContain('sensor-blend-v1')
    expect(renders).toBe(4)
    validateHdrSource(composite.source)
    expect(() =>
      validateHdrSource({ ...composite.source, highlightBlend: 'sensor-blend-v1' }),
    ).toThrow('provenance')
  } finally {
    await cache.close()
  }
})

test('ACES regenerates retired proofs and placeholders while reusing unchanged linear sources and alpha', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-aces-cache-'))
  const path = join(root, 'original.ARW'),
    id = 'c'.repeat(64)
  const originals = Buffer.from('unchanged original fixture')
  const pixels = new Float32Array([
    0.18, 0.18, 0.18, 1, 2, 1, 0.5, 0.25, 16, -0.1, 4, 0, 0, 0, 0, 1,
  ])
  const bytes = Buffer.from(pixels.buffer)
  const asset = workingAsset(bytes, 4, 1)
  asset.source.highlightBlend = 'sensor-blend-v1'
  const options: ProcessingOptions = {
    metadata: { version: 3, lensProfile: unavailableProfile },
    settings: noLensSettings,
    revision: 0,
    processing: 'hdr-v1',
    adjustments: neutralAdjustments,
  }
  let preparations = 0,
    proofs = 0
  const create = () =>
    new FullPreviews(
      join(root, 'cache'),
      () => path,
      {
        async renderFull(input, output, _signal, options) {
          if (options!.workingOnly) {
            preparations++
            await writeFile(join(output, 'linear.f32'), bytes)
            return {
              width: 4,
              height: 1,
              format: 'hdr-working',
              byteLength: 0,
              sha256: asset.sha256,
              renderId: `${HDR_RAW_SOURCE_VERSION}-${asset.sha256}`,
              placeholderBytes: 0,
              linear: {
                byteLength: asset.byteLength,
                sha256: asset.sha256,
                transform: srgbTransform,
                hdr: asset,
              },
            }
          }
          proofs++
          expect(options!.workingAsset?.sha256).toBe(asset.sha256)
          return renderHdr(
            input,
            output,
            options!,
            {
              render: async () => {
                throw new Error('A look change must reuse the linear source.')
              },
              releaseFrame() {},
            },
            'cpu',
          )
        },
        async close() {},
      },
      undefined,
      async () => ({ ...options }),
    )
  let cache = create()
  try {
    await writeFile(path, originals)
    await cache.open()
    const working = (await cache.requestHdr(id, randomUUID()))!
    const source = cache.acquire(new URL(working.linear.url))!
    const sourcePath = source.path
    source.release()
    const first = await cache.request(id, randomUUID())
    const proof = cache.acquire(new URL(first.url))!
    const proofPath = proof.path
    proof.release()
    const metadataPath = join(proofPath, '..', 'entry.json')
    const initial = await readFile(proofPath)
    for (let i = 0; i < pixels.length; i += 4) {
      const scene: RGB = [pixels[i], pixels[i + 1], pixels[i + 2]]
      const output = outputHdr(scene, SDR_TARGET)
      for (let c = 0; c < 3; c++)
        expect(initial[i + c]).toBe(Math.round(encodeHdr(output.rgb[c]) * 255))
      expect(initial[i + 3]).toBe(Math.round(pixels[i + 3] * 255))
    }
    const placeholder = await sharp(join(proofPath, '..', 'placeholder.png'))
      .raw()
      .toBuffer()
    expect(placeholder).toEqual(initial)
    await cache.close()
    const retired = JSON.parse(await readFile(metadataPath, 'utf8'))
    retired.variant = createHash('sha256')
      .update(
        JSON.stringify([
          id,
          'hdr-v1',
          HDR_RAW_SOURCE_VERSION,
          LENS_RENDER_VERSION,
          CROP_POLICY,
          rawDecoderDefinitions,
          cameraProfiles,
          unavailableProfile.identity,
          undefined,
          noLensSettings,
          neutralAdjustments,
          [HDR_ADJUSTMENT_VERSION, 'hdr-output-v2'],
        ]),
      )
      .digest('hex')
    retired.renderId = 'hdr-source-v1-hdr-adjustments-v1-hdr-output-v2'
    const oldBytes = Buffer.alloc(initial.length, 10)
    retired.sha256 = createHash('sha256').update(oldBytes).digest('hex')
    await writeFile(proofPath, oldBytes)
    await writeFile(metadataPath, JSON.stringify(retired))
    cache = create()
    await cache.open()
    const regenerated = await cache.request(id, randomUUID())
    expect(regenerated.url).not.toBe(first.url)
    expect(regenerated.renderId).toContain('aces2-069b0bc3-v1')
    expect(regenerated.sha256).toBe(first.sha256)
    expect(regenerated.linear!.url).toBe(working.linear.url)
    expect((await cache.requestHdr(id, randomUUID()))!.linear.sha256).toBe(asset.sha256)
    expect(await readFile(sourcePath)).toEqual(bytes)
    expect(await readFile(path)).toEqual(originals)
    expect(preparations).toBe(1)
    expect(proofs).toBe(2)
  } finally {
    await cache.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('color-managed display-referred rasters bypass scene rendering at neutral settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-raster-rendering-')),
    engine = new PreviewEngine()
  try {
    const path = join(root, 'authored.png'),
      pixels = Buffer.from([128, 64, 192, 255, 32, 16, 8, 127])
    await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } })
      .withIccProfile('srgb')
      .png()
      .toFile(path)
    const original = await readFile(path),
      output = join(root, 'output')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(output)
    const result = await engine.renderFull(path, output)
    expect(result.renderId).toContain('raster-display-referred-v1')
    expect(result.linear?.hdr).toBeUndefined()
    expect(await readFile(join(output, 'full.rgba'))).toEqual(pixels)
    expect(await readFile(path)).toEqual(original)
  } finally {
    await engine.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('retired composite masters keep their exact bytes while proofs adopt ACES', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-master-cutover-'))
  try {
    const bytes = Buffer.from(new Float32Array([-0.02, 2, 4, 1, 0.18, 0.18, 0.18, 1]).buffer),
      asset = workingAsset(bytes, 2, 1)
    asset.source.version = 'hdr-source-v1'
    asset.source.composite = { kind: 'hdr', sourceCount: 3 }
    const path = join(root, 'master.f32')
    await writeFile(path, bytes)
    const { mkdir } = await import('node:fs/promises')
    const output = join(root, 'output')
    await mkdir(output)
    const options = {
      metadata: { version: 3, lensProfile: unavailableProfile, mergeMaster: { asset, recipe: {} } },
      settings: noLensSettings,
      revision: 8,
      processing: 'hdr-v1',
      prepareLinear: true,
      workingAsset: {
        path,
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        transform: srgbTransform,
        hdr: asset,
      },
      adjustments: neutralAdjustments,
    } as ProcessingOptions
    const result = await renderHdr(
      '/original/master',
      output,
      options,
      {
        render: async () => {
          throw new Error('A master must never be decoded again.')
        },
        releaseFrame() {},
      },
      'cpu',
    )
    expect(result.renderId).toContain('aces2-069b0bc3-v1')
    expect(result.settingsRevision).toBe(8)
    expect(await readFile(path)).toEqual(bytes)
    expect(await readFile(join(output, 'linear.f32'))).toEqual(bytes)
    expect(result.linear!.hdr).toEqual(asset)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
