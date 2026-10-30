import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { ExifTool } from 'exiftool-vendored'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import { librawDecoder } from '../src/main/processing/decoders/libraw'
import {
  ReviewThumbnails,
  type ReviewThumbnailInput,
  type ReviewThumbnailState,
} from '../src/main/review-thumbnails'
import type { ThumbnailProcessor, ThumbnailResult } from '../src/main/preview-types'

test('Sony review thumbnails reuse warm ExifTool without opening the RAW decoder or creating large previews', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-review-raw-'))
  const engine = new PreviewEngine()
  const open = librawDecoder.open
  librawDecoder.open = async () => {
    throw new Error('Lightweight thumbnails must not open the RAW decoder.')
  }
  try {
    const source = resolve('tests/fixtures/sony-zv1.ARW')
    const original = await readFile(source)
    const tool = (engine as unknown as { tool: ExifTool }).tool
    expect(await engine.thumbnail(source, root)).toEqual({ state: 'ready', source: 'embedded' })
    const pids = tool.pids
    expect(pids).toHaveLength(1)
    expect(tool.ended).toBe(false)
    expect(await engine.thumbnail(source, root)).toEqual({ state: 'ready', source: 'embedded' })
    expect(tool.pids).toEqual(pids)
    expect(await readdir(root)).toEqual(['thumb.jpg'])
    const thumbnail = await sharp(join(root, 'thumb.jpg')).metadata()
    expect(thumbnail.width).toBe(480)
    expect(thumbnail.height).toBeLessThanOrEqual(480)
    expect((await sharp(join(root, 'thumb.jpg')).stats()).channels[0].stdev).toBeGreaterThan(10)
    expect(Buffer.compare(await readFile(source), original)).toBe(0)
  } finally {
    librawDecoder.open = open
    await engine.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('RAW embedded failure defers decoder work and forced fallback creates only one small thumbnail', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'irodori-review-fallback-'))
  const engine = new PreviewEngine(async () => {
    throw new Error('No embedded preview')
  })
  try {
    const source = resolve('tests/fixtures/sony-zv1.ARW')
    expect(await engine.thumbnail(source, root)).toEqual({ state: 'needs-fallback' })
    expect(await readdir(root)).toEqual([])
    expect(await engine.thumbnail(source, root, true)).toEqual({
      state: 'ready',
      source: 'decoded',
    })
    expect(await readdir(root)).toEqual(['thumb.jpg'])
    const details = await sharp(join(root, 'thumb.jpg')).metadata()
    expect(details.width).toBe(480)
    expect(details.height).toBeLessThanOrEqual(480)
    expect((await sharp(join(root, 'thumb.jpg')).stats()).channels[0].stdev).toBeGreaterThan(10)
  } finally {
    await engine.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('embedded JPEGs with readable headers but corrupt pixels defer to the decoder queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-review-corrupt-jpeg-'))
  const jpeg = await sharp({
    create: { width: 800, height: 600, channels: 3, background: '#753945' },
  })
    .jpeg()
    .withMetadata({ orientation: 1 })
    .toBuffer()
  const truncated = jpeg.subarray(0, jpeg.length - 500)
  const engine = new PreviewEngine(async (_tool, _path, output) => {
    await writeFile(output, truncated)
  })
  const open = librawDecoder.open
  librawDecoder.open = async () => {
    throw new Error('Lightweight thumbnails must not open the RAW decoder.')
  }
  try {
    expect((await sharp(truncated).metadata()).width).toBe(800)
    await expect(sharp(truncated).raw().toBuffer()).rejects.toThrow()
    expect(await engine.thumbnail(resolve('tests/fixtures/sony-zv1.ARW'), root)).toEqual({
      state: 'needs-fallback',
    })
    expect(await readdir(root)).toEqual([])
  } finally {
    librawDecoder.open = open
    await engine.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('embedded JPEGs without their own orientation follow all eight source orientations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-review-orientation-'))
  const engine = new PreviewEngine(async (_tool, path, output) => {
    // Extraction strips the source's orientation, like some camera previews.
    await sharp(path).jpeg().toFile(output)
  })
  try {
    const pixels = Buffer.alloc(120 * 80 * 3)
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 120; x++) {
        const offset = (y * 120 + x) * 3
        pixels[offset] = x < 60 ? 220 : 20
        pixels[offset + 1] = y < 40 ? 20 : 220
        pixels[offset + 2] = x + y
      }
    for (let orientation = 1; orientation <= 8; orientation++) {
      const source = join(root, `orientation-${orientation}.arw`)
      await sharp(pixels, { raw: { width: 120, height: 80, channels: 3 } })
        .jpeg()
        .withMetadata({ orientation })
        .toFile(source)
      expect(await engine.thumbnail(source, root)).toEqual({ state: 'ready', source: 'embedded' })
      const actual = await sharp(join(root, 'thumb.jpg'))
        .raw()
        .toBuffer({ resolveWithObject: true })
      const reference = await sharp(source).autoOrient().raw().toBuffer({ resolveWithObject: true })
      expect(actual.info.width).toBe(reference.info.width)
      expect(actual.info.height).toBe(reference.info.height)
      const meanDifference =
        actual.data.reduce(
          (sum, value, index) => sum + Math.abs(value - reference.data[index]),
          0,
        ) / actual.data.length
      expect(
        meanDifference,
        `Source orientation ${orientation}: ${JSON.stringify({ actual: actual.info, reference: reference.info })}`,
      ).toBeLessThan(3)
    }
  } finally {
    await engine.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('bundled review workers support raster and embedded RAW thumbnails and reclaim cancelled workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-review-worker-'))
  const processor = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const decoder = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const source = join(root, 'image.png')
    await sharp({ create: { width: 900, height: 600, channels: 3, background: '#753945' } })
      .png()
      .toFile(source)
    expect(await processor.thumbnail(source, root, new AbortController().signal)).toEqual({
      state: 'ready',
      source: 'image',
    })
    expect(
      await processor.thumbnail(
        resolve('tests/fixtures/sony-zv1.ARW'),
        root,
        new AbortController().signal,
      ),
    ).toEqual({ state: 'ready', source: 'embedded' })
    const controller = new AbortController()
    const fallback = decoder.thumbnail(
      resolve('tests/fixtures/sony-zv1.ARW'),
      root,
      controller.signal,
      true,
    )
    controller.abort()
    await expect(fallback).rejects.toThrow('cancelled')
    // A cancelled process is fully exited before the next request starts.
    expect(await decoder.thumbnail(source, root, new AbortController().signal)).toEqual({
      state: 'ready',
      source: 'image',
    })
  } finally {
    await processor.close()
    await decoder.close()
    await rm(root, { recursive: true, force: true })
  }
})

function heldProcessor() {
  const jobs: {
    path: string
    signal: AbortSignal
    fallback: boolean
    finish: (result: ThumbnailResult) => void
  }[] = []
  let closed = false
  const processor: ThumbnailProcessor = {
    thumbnail: (path, _output, signal, fallback = false) =>
      new Promise<ThumbnailResult>((finish) => jobs.push({ path, signal, fallback, finish })),
    close: async () => {
      closed = true
    },
  }
  return { processor, jobs, isClosed: () => closed }
}

async function scheduler() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-review-queue-'))
  const light = heldProcessor()
  const fallback = heldProcessor()
  const states: { id: string; state: ReviewThumbnailState }[] = []
  const queue = new ReviewThumbnails(
    (id, state) => states.push({ id, state }),
    light.processor,
    fallback.processor,
  )
  const inputs = (ids: string[]): ReviewThumbnailInput[] =>
    ids.map((id) => ({ id, path: id, output: join(root, id) }))
  return { root, light, fallback, states, queue, inputs }
}

test('visible requests discard obsolete jobs, prioritize newly visible rows, and ignore stale results', async () => {
  const t = await scheduler()
  try {
    t.queue.request(t.inputs(['a', 'b', 'c']))
    await expect.poll(() => t.light.jobs.length).toBe(1)
    t.queue.request(t.inputs(['b', 'c', 'd']))
    expect(t.light.jobs[0].signal.aborted).toBe(true)
    t.light.jobs[0].finish({ state: 'ready', source: 'image' })
    await expect.poll(() => t.light.jobs.map((job) => job.path)).toEqual(['a', 'd'])
    expect(t.states.filter((entry) => entry.id === 'a').map((entry) => entry.state.state)).toEqual([
      'loading',
      'idle',
    ])
    t.light.jobs[1].finish({ state: 'ready', source: 'image' })
    await expect.poll(() => t.light.jobs.map((job) => job.path)).toEqual(['a', 'd', 'b'])
    t.queue.request([])
    t.light.jobs[2].finish({ state: 'ready', source: 'image' })
    await t.queue.cancel()
    expect(t.light.jobs.map((job) => job.path)).not.toContain('c')
    expect(t.fallback.jobs).toHaveLength(0)
  } finally {
    for (const job of t.light.jobs) job.finish({ state: 'ready', source: 'image' })
    await t.queue.cancel()
    await rm(t.root, { recursive: true, force: true })
  }
})

test('RAW fallback waits for visible lightweight work and remains limited to one decoder', async () => {
  const t = await scheduler()
  try {
    t.queue.request(t.inputs(['raw-a', 'image', 'raw-b']))
    await expect.poll(() => t.light.jobs.length).toBe(1)
    t.light.jobs[0].finish({ state: 'needs-fallback' })
    await expect.poll(() => t.light.jobs.length).toBe(2)
    expect(t.fallback.jobs).toHaveLength(0)
    t.light.jobs[1].finish({ state: 'ready', source: 'image' })
    await expect.poll(() => t.light.jobs.length).toBe(3)
    t.light.jobs[2].finish({ state: 'needs-fallback' })
    await expect.poll(() => t.fallback.jobs.length).toBe(1)
    expect(t.fallback.jobs[0]).toMatchObject({ path: 'raw-a', fallback: true })
    t.fallback.jobs[0].finish({ state: 'ready', source: 'decoded' })
    await expect.poll(() => t.fallback.jobs.length).toBe(2)
    expect(t.fallback.jobs[1]).toMatchObject({ path: 'raw-b', fallback: true })
    t.fallback.jobs[1].finish({ state: 'ready', source: 'decoded' })
    await expect
      .poll(() => t.states.filter((entry) => entry.state.state === 'ready').length)
      .toBe(3)
  } finally {
    for (const job of [...t.light.jobs, ...t.fallback.jobs])
      job.finish({ state: 'ready', source: 'decoded' })
    await t.queue.cancel()
    await rm(t.root, { recursive: true, force: true })
  }
})

test('cancellation awaits active processors before staging cleanup and rejects late publication', async () => {
  const t = await scheduler()
  try {
    t.queue.request(t.inputs(['a']))
    await expect.poll(() => t.light.jobs.length).toBe(1)
    await writeFile(join(t.root, 'a', 'marker'), 'Active worker owns this staging directory.')
    let cancelled = false
    const cancellation = t.queue.cancel().then(() => {
      cancelled = true
    })
    expect(t.light.jobs[0].signal.aborted).toBe(true)
    expect(cancelled).toBe(false)
    expect(t.light.isClosed()).toBe(false)
    expect(await readdir(join(t.root, 'a'))).toEqual(['marker'])
    t.light.jobs[0].finish({ state: 'ready', source: 'image' })
    await cancellation
    expect(cancelled).toBe(true)
    expect(t.light.isClosed()).toBe(true)
    expect(t.fallback.isClosed()).toBe(true)
    expect(t.states.some((entry) => entry.state.state === 'ready')).toBe(false)
    t.queue.request(t.inputs(['b']))
    expect(t.light.jobs).toHaveLength(1)
  } finally {
    for (const job of t.light.jobs) job.finish({ state: 'ready', source: 'image' })
    await t.queue.cancel()
    await rm(t.root, { recursive: true, force: true })
  }
})

test('a revisited RAW waits for its obsolete decoder to exit before reusing its thumbnail directory', async () => {
  const t = await scheduler()
  try {
    t.queue.request(t.inputs(['raw']))
    await expect.poll(() => t.light.jobs.length).toBe(1)
    t.light.jobs[0].finish({ state: 'needs-fallback' })
    await expect.poll(() => t.fallback.jobs.length).toBe(1)
    t.queue.request([])
    t.queue.request(t.inputs(['raw']))
    expect(t.fallback.jobs[0].signal.aborted).toBe(true)
    expect(t.light.jobs).toHaveLength(1)
    t.fallback.jobs[0].finish({ state: 'ready', source: 'decoded' })
    await expect.poll(() => t.light.jobs.length).toBe(2)
    expect(t.states.some((entry) => entry.state.state === 'ready')).toBe(false)
    t.light.jobs[1].finish({ state: 'needs-fallback' })
    await expect.poll(() => t.fallback.jobs.length).toBe(2)
    t.fallback.jobs[1].finish({ state: 'ready', source: 'decoded' })
    await expect
      .poll(() => t.states.filter((entry) => entry.state.state === 'ready').length)
      .toBe(1)
  } finally {
    for (const job of [...t.light.jobs, ...t.fallback.jobs])
      job.finish({ state: 'ready', source: 'decoded' })
    await t.queue.cancel()
    await rm(t.root, { recursive: true, force: true })
  }
})
