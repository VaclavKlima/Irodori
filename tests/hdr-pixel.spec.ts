import { test, expect } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sampleHdrPixel } from '../src/main/processing/hdr-processing'
import { PreviewProcess } from '../src/main/preview-process'
import { FullPreviews } from '../src/main/full-previews'
import { PhotoLibrary } from '../src/main/library'
import type { FullPreviewProcessor, HdrPixelJob } from '../src/main/preview-types'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { SDR_TARGET, type DisplayTarget, type HdrWorkingAsset } from '../src/shared/hdr'
import { noLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { unavailableProfile } from '../src/main/processing/metadata'
import { referenceAdjust, referenceOutput } from './hdr-reference'
import { syntheticMerge } from './merge.helpers'

const id = 'a'.repeat(64)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'luma-hdr-pixel-'))
  const path = join(root, 'linear.f32')
  const width = 3,
    height = 130
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([x + 1, y / 64, -0.25, 0.5], (y * width + x) * 4)
  data.set([0, 0, 0, 0], 0)
  data.set([-1, -1, -1, 1], 4)
  data.set([2, 2, 2, 1], (64 * width + 1) * 4)
  const bytes = Buffer.from(data.buffer)
  const describe = (): HdrWorkingAsset => ({
    kind: 'hdr-working-v1',
    width,
    height,
    byteLength: bytes.length,
    sha256: sha(bytes),
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, i) => {
      const strip = bytes.subarray(i * width * 64 * 16, (i + 1) * width * 64 * 16)
      return { byteLength: strip.length, sha256: sha(strip) }
    }),
    source: {
      version: 'hdr-source-v1',
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      orientation: 'applied-once',
      decoder: 'test',
      cameraProfile: 'test',
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 1,
        gains: [1, 1, 1, 1],
        restoreGain: 1,
        referenceWhite: 1,
        sourceSaturation: null,
      },
    },
  })
  await writeFile(path, bytes)
  return {
    root,
    path,
    data,
    bytes,
    describe,
    close: () => rm(root, { recursive: true, force: true }),
  }
}

test('worker samples known native pixels, signed luminance, straight alpha and independent adjustment/output math', async () => {
  const f = await fixture(),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const asset = f.describe(),
    signal = new AbortController().signal
  const job = (x: number, y: number): HdrPixelJob => ({
    asset,
    x,
    y,
    adjustments: neutralAdjustments,
    domain: 'working-hdr',
    target: SDR_TARGET,
  })
  try {
    expect(await worker.hdrPixel(f.path, job(0, 0), signal)).toMatchObject({
      x: 0,
      y: 0,
      width: 3,
      height: 130,
      rgb: [0, 0, 0],
      alpha: 0,
      relativeLuminance: 0,
      stopsAboveReferenceWhite: null,
      colorSpace: 'rec2020',
    })
    expect(await worker.hdrPixel(f.path, job(1, 0), signal)).toMatchObject({
      rgb: [-1, -1, -1],
      alpha: 1,
      stopsAboveReferenceWhite: null,
    })
    const white = await worker.hdrPixel(f.path, job(1, 64), signal)
    expect(white.rgb).toEqual([2, 2, 2])
    expect(white.relativeLuminance).toBeCloseTo(2, 12)
    expect(white.stopsAboveReferenceWhite).toBeCloseTo(1, 12)
    const adjustments = {
      ...neutralAdjustments,
      exposureEv: 1.25,
      contrast: 35,
      highlights: -40,
      shadows: 20,
      whites: -15,
      blacks: 10,
    }
    for (const [x, y] of [
      [2, 63],
      [0, 64],
      [2, 129],
    ]) {
      const input = Array.from(f.data.slice((y * 3 + x) * 4, (y * 3 + x) * 4 + 3))
      const expected = referenceAdjust(input, adjustments)
      for (const domain of ['working-hdr', 'output'] as const)
        for (const target of [
          SDR_TARGET,
          { ...SDR_TARGET, mode: 'hdr' as const, colorSpace: 'display-p3' as const, peak: 4 },
        ]) {
          const result = await worker.hdrPixel(
            f.path,
            { ...job(x, y), domain, target, adjustments },
            signal,
          )
          const rgb =
            domain === 'working-hdr'
              ? expected
              : referenceOutput(expected, target.peak, target.colorSpace)
          result.rgb.forEach((v, c) => expect(v).toBeCloseTo(rgb[c], 6))
          const weights =
            domain === 'working-hdr'
              ? [0.2627002120112671, 0.6779980715188708, 0.059301716469862]
              : target.colorSpace === 'srgb'
                ? [0.2126390058715104, 0.715168678767756, 0.0721923153607337]
                : [0.2289745640697488, 0.6917385218365064, 0.07928691409374483]
          expect(result.relativeLuminance).toBeCloseTo(
            rgb.reduce((sum, v, c) => sum + v * weights[c], 0),
            6,
          )
          expect(result.stopsAboveReferenceWhite).toBeCloseTo(
            Math.log2(result.relativeLuminance),
            12,
          )
          expect(result.alpha).toBe(0.5)
          expect(result.target).toEqual(domain === 'output' ? target : undefined)
        }
    }
    for (const [x, y] of [
      [-1, 0],
      [3, 0],
      [0, 130],
      [0.5, 1],
      [NaN, 0],
      [0, Infinity],
      [Number.MAX_SAFE_INTEGER + 1, 0],
    ])
      await expect(sampleHdrPixel(f.path, job(x, y))).rejects.toThrow('coordinates')
  } finally {
    await worker.close()
    await f.close()
  }
})

test('pixel reads validate only the relevant 64-row strip and reject truncated, corrupt or invalid data', async () => {
  const f = await fixture()
  const sample = (asset = f.describe(), y = 64) =>
    sampleHdrPixel(f.path, {
      asset,
      x: 2,
      y,
      adjustments: neutralAdjustments,
      domain: 'working-hdr',
      target: SDR_TARGET,
    })
  try {
    const asset = f.describe()
    const damaged = Buffer.from(f.bytes)
    damaged[0] ^= 1
    await writeFile(f.path, damaged)
    expect((await sample(asset, 129)).y).toBe(129)
    await expect(sample(asset, 0)).rejects.toThrow('Damaged HDR strip')
    await writeFile(f.path, f.bytes.subarray(0, f.bytes.length - 1))
    await expect(sample(asset)).rejects.toThrow('Incomplete HDR asset')
    await writeFile(f.path, Buffer.concat([f.bytes, Buffer.from([0])]))
    await expect(sample(asset)).rejects.toThrow('Incomplete HDR asset')
    for (const [channel, value] of [
      [0, NaN],
      [1, Infinity],
      [3, -0.1],
      [3, 1.1],
    ]) {
      // Valid hashes must not bypass sample validation elsewhere in the requested strip.
      const index = 64 * 3 * 4 + channel,
        previous = f.data[index]
      f.data[index] = value
      await writeFile(f.path, f.bytes)
      await expect(sample()).rejects.toThrow('Invalid HDR pixels')
      f.data[index] = previous
    }
    await writeFile(f.path, f.bytes)
    const malformed = f.describe()
    malformed.strips[1].byteLength--
    await expect(sample(malformed)).rejects.toThrow('Invalid HDR asset')
    malformed.strips[1].byteLength++
    malformed.source.colorSpace = 'srgb' as 'rec2020'
    await expect(sample(malformed)).rejects.toThrow('Invalid HDR source')
  } finally {
    await f.close()
  }
})

async function serviceFixture() {
  const f = await fixture()
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  let options: ProcessingOptions = {
    metadata: { version: 3, lensProfile: unavailableProfile },
    settings: noLensSettings,
    revision: 0,
    processing: 'hdr-v1',
    adjustments: neutralAdjustments,
  }
  let sample: FullPreviewProcessor['hdrPixel'] = (path, job, signal) =>
    worker.hdrPixel(path, job, signal)
  let renders = 0
  const previews = new FullPreviews(
    join(f.root, 'cache'),
    (photoId) => (photoId === id ? f.path : undefined),
    {
      async renderFull(_path, output) {
        renders++
        const asset = f.describe()
        await writeFile(join(output, 'linear.f32'), f.bytes)
        return {
          width: 3,
          height: 130,
          format: 'hdr-working',
          byteLength: 0,
          sha256: asset.sha256,
          placeholderBytes: 0,
          renderId: `hdr-source-v1-${asset.sha256}`,
          linear: {
            byteLength: asset.byteLength,
            sha256: asset.sha256,
            hdr: asset,
            transform: srgbTransform,
          },
        }
      },
      hdrPixel: (path, job, signal) => sample!(path, job, signal),
      close: () => worker.close(),
    },
    undefined,
    async () => ({ ...options }),
  )
  await previews.open()
  const library = new PhotoLibrary(
    f.root,
    {
      process: async () => {
        throw new Error('Unused import')
      },
      close: async () => {},
    },
    () => {},
  )
  // Inject the real leased service without needing a RAW decode for conflict/transport tests.
  Object.defineProperty(library, 'fullPreviews', { value: previews })
  let target: DisplayTarget = {
    ...SDR_TARGET,
    generation: 5,
    mode: 'hdr',
    colorSpace: 'display-p3',
    peak: 4,
  }
  library.displayTarget = () => target
  return {
    ...f,
    previews,
    library,
    worker,
    renders: () => renders,
    edit: (patch: Partial<ProcessingOptions>) => {
      options = { ...options, ...patch }
      previews.settingsChanged(id)
    },
    setTarget: (next: DisplayTarget) => {
      target = next
    },
    target: () => target,
    setSample: (next: NonNullable<FullPreviewProcessor['hdrPixel']>) => {
      sample = next
    },
    close: async () => {
      await previews.close()
      await f.close()
    },
  }
}

test('application pixel requests retain source identity and reject stale revisions, targets and unsupported processing', async () => {
  const f = await serviceFixture()
  const pixel = (revision = 0) =>
    f.library.getPhotoPixel(id, revision, 1, 64, { domain: 'working-hdr' })
  try {
    const initial = await pixel()
    expect(initial).toMatchObject({
      photoId: id,
      revision: 0,
      rgb: [2, 2, 2],
      renderingIdentity: expect.any(String),
    })
    f.edit({ revision: 1, adjustments: { ...neutralAdjustments, exposureEv: 1 } })
    await expect(pixel()).rejects.toThrow('revision conflict')
    const changed = await pixel(1)
    expect(changed.rgb).toEqual([4, 4, 4])
    expect(changed.renderingIdentity).toBe(initial.renderingIdentity)
    expect(f.renders()).toBe(1)
    await expect(f.library.getPhotoPixel(id, 1, 3, 0, { domain: 'working-hdr' })).rejects.toThrow(
      'coordinates',
    )
    for (const request of [
      { domain: 'invalid' },
      { domain: 'output', target: 'invalid' },
      { domain: 'output', targetGeneration: -1 },
      { domain: 'output', target: 'current', targetGeneration: 4 },
    ])
      await expect(
        f.library.getPhotoPixel(
          id,
          1,
          0,
          0,
          request as Parameters<PhotoLibrary['getPhotoPixel']>[4],
        ),
      ).rejects.toThrow(/Invalid|conflict/)
    const output = await f.library.getPhotoPixel(id, 1, 1, 64, {
      domain: 'output',
      target: 'current',
      targetGeneration: 5,
    })
    expect(output).toMatchObject({ colorSpace: 'display-p3', target: { generation: 5, peak: 4 } })
    f.setTarget({
      ...f.target(),
      presentation: {
        photoId: id,
        revision: 1,
        targetGeneration: 5,
        backend: 'canvas2d-hdr-sdr',
        mode: 'sdr',
        stage: 'presented',
        reason: '',
        timings: {},
      },
    })
    expect(
      await f.library.getPhotoPixel(id, 1, 1, 64, { domain: 'output', targetGeneration: 5 }),
    ).toMatchObject({ colorSpace: 'srgb', target: { peak: 1, generation: 5 } })
    f.setSample(async (path, job, signal) => {
      const result = await f.worker.hdrPixel(path, job, signal)
      f.setTarget({ ...f.target(), generation: 6 })
      return result
    })
    await expect(
      f.library.getPhotoPixel(id, 1, 1, 64, { domain: 'output', targetGeneration: 5 }),
    ).rejects.toThrow('target generation conflict')
    f.edit({ processing: 'legacy-sdr-v1', revision: 2 })
    await expect(pixel(2)).rejects.toThrow('processing unavailable')
  } finally {
    await f.close()
  }
})

test('foreground requests, edits, deletion and shutdown cancel pixel jobs and release leased assets', async () => {
  for (const action of ['foreground', 'edit', 'delete', 'close'] as const) {
    const f = await serviceFixture()
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    let leasedPath = ''
    f.setSample(async (path, _job, signal) => {
      leasedPath = path
      await access(path)
      started()
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    })
    try {
      const pending = f.library
        .getPhotoPixel(id, 0, 1, 64, { domain: 'working-hdr' })
        .catch((error) => String(error))
      await began
      if (action === 'foreground') await f.previews.requestHdr(id, randomUUID())
      else if (action === 'edit') f.edit({ revision: 1 })
      else if (action === 'delete') await f.previews.beginRemoval(id)
      else await f.previews.close()
      expect(await pending).toMatch(/conflict|removed|closed|interrupted/)
      if (action === 'delete') {
        f.previews.endRemoval(id, true)
        await f.previews.release()
        await expect(access(leasedPath)).rejects.toThrow()
      }
    } finally {
      await f.close()
    }
  }
})

test('merged masters sample committed edits through the bundled worker without their source photographs', async () => {
  const f = await syntheticMerge([0.25, 1, 4]),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const path = join(f.output, 'linear.f32')
  let revision = 0
  const previews = new FullPreviews(
    join(f.directory, 'pixel-cache'),
    (photoId) => (photoId === id ? path : undefined),
    worker,
    undefined,
    async () => ({
      metadata: {
        ...f.sources[1].metadata,
        mergeMaster: { asset: f.result.asset, recipe: f.result.recipe },
      },
      settings: noLensSettings,
      revision,
      processing: 'hdr-v1',
      adjustments: { ...neutralAdjustments, exposureEv: revision },
      workingAsset: {
        path,
        width: f.result.asset.width,
        height: f.result.asset.height,
        byteLength: f.result.asset.byteLength,
        sha256: f.result.asset.sha256,
        hdr: f.result.asset,
        transform: srgbTransform,
      },
    }),
  )
  try {
    await previews.open()
    for (let i = 0; i < f.sources.length; i++) await rm(join(f.directory, `source-${i}.f32`))
    const initial = await previews.hdrPixel(id, 0, 20, 40, 'working-hdr', SDR_TARGET)
    const bytes = await readFile(path)
    const index = (40 * f.result.asset.width + 20) * 16
    expect(initial.rgb).toEqual([0, 1, 2].map((c) => bytes.readFloatLE(index + c * 4)))
    revision = 1
    previews.settingsChanged(id)
    const edited = await previews.hdrPixel(id, 1, 20, 40, 'working-hdr', SDR_TARGET)
    expect(edited.rgb).toEqual(initial.rgb.map((v) => v * 2))
    expect(edited.alpha).toBe(initial.alpha)
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await previews.close()
    await f.close()
  }
})
