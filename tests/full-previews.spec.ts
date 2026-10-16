import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { FullPreviews, PREVIEW_VERSION } from '../src/main/full-previews'
import { PreviewEngine } from '../src/main/preview-engine'
import type { FullPreviewProcessor, FullPreviewResult } from '../src/main/preview-types'
import { unavailableProfile } from '../src/main/processing/metadata'
import { automaticLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { srgbTransform } from '../src/shared/adjustments'
import { workingAsset } from './export.helpers'

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
