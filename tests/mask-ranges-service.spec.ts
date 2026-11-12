import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { MaskRangeService } from '../src/main/mask-ranges/service'
import type { MaskEdgeProcess } from '../src/main/mask-edges/process'
import type { PreviewProcess } from '../src/main/preview-process'
import { FullPreviews } from '../src/main/full-previews'
import type { ExportSource } from '../src/main/export/types'
import { processingMetadata } from '../src/main/processing/metadata'
import { initialSettings, type EditState } from '../src/shared/edits'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { automaticLensSettings } from '../src/shared/lens'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { defaultLuminanceMaskRange } from '../src/shared/mask-ranges'
import {
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type ResolvedMask,
} from '../src/shared/masks'
import { cropAdmission } from './crop-frame.helpers'
import { workingAsset } from './export.helpers'

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

async function fixture(hdr = false) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-range-service-'))
  const originalPath = join(root, 'original.dat'),
    original = Buffer.from('unchanged-range-original')
  await writeFile(originalPath, original)
  const stat = await lstat(originalPath)
  const photoId = hash(original),
    width = 8,
    height = 6
  const source: ExportSource = {
    hdr,
    path: originalPath,
    identity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    },
    photo: {
      id: photoId,
      filename: hdr ? 'Source.ARW' : 'Source.png',
      format: hdr ? 'ARW' : 'PNG',
      width,
      height,
      bytes: original.byteLength,
      importedAt: '2026-11-12T12:00:00.000Z',
      previewSource: 'decoded',
      previewUrl: '',
      thumbnailUrl: '',
    },
    processing: {
      metadata: processingMetadata({}, []),
      settings: automaticLensSettings,
      processing: hdr ? 'hdr-v1' : 'display-referred-v1',
      revision: 0,
      adjustments: { ...structuredClone(neutralAdjustments), exposureEv: 2 },
    },
  }
  const pixels = new Float32Array(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4)
    pixels.set([hdr ? 4 : 0.5, hdr ? 4 : 0.5, hdr ? 4 : 0.5, 1], i)
  let revision = 0,
    reserved = 0,
    decode = 0,
    gpu = 0,
    decoderClosed = 0,
    runtimeClosed = 0
  let linearPath = '',
    admission = cropAdmission(),
    contextIdentity = 'geometry-0'
  let beforeDecode: ((signal: AbortSignal) => Promise<void>) | undefined
  let beforeGpu: ((signal: AbortSignal) => Promise<void>) | undefined
  const inputs: Parameters<MaskEdgeProcess['prepare']>[] = []
  const options: NonNullable<Parameters<PreviewProcess['renderFull']>[3]>[] = []
  const state = (): EditState => ({
    photoId,
    revision,
    settings: initialSettings(),
    canUndo: false,
    canRedo: false,
  })
  const decoder: Pick<PreviewProcess, 'renderFull' | 'close'> = {
    renderFull: async (_path, output, signal, config) => {
      decode++
      options.push(structuredClone(config!))
      await beforeDecode?.(signal)
      signal.throwIfAborted()
      await mkdir(output, { recursive: true })
      linearPath = join(output, 'linear.f32')
      const bytes = Buffer.from(pixels.buffer)
      await writeFile(linearPath, bytes)
      return {
        width,
        height,
        format: hdr ? 'hdr-working' : 'rgba8-srgb',
        byteLength: width * height * 4,
        sha256: 'a'.repeat(64),
        renderId: 'neutral-canonical-fixture',
        placeholderBytes: 0,
        linear: {
          byteLength: bytes.byteLength,
          sha256: hash(bytes),
          transform: srgbTransform,
          ...(hdr ? { hdr: workingAsset(bytes, width, height) } : {}),
        },
      }
    },
    close: async () => {
      decoderClosed++
    },
  }
  const runtime: Pick<MaskEdgeProcess, 'prepare' | 'close'> = {
    prepare: async (...args) => {
      gpu++
      inputs.push(structuredClone(args))
      const [, w, h, key, output, signal] = args
      await beforeGpu?.(signal)
      signal.throwIfAborted()
      const bytes = await sharp(Buffer.alloc(w * h, 128), {
        raw: { width: w, height: h, channels: 1 },
      })
        .toColourspace('b-w')
        .png()
        .toBuffer()
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, bytes)
      return {
        path: output,
        key,
        width: w,
        height: h,
        hash: hash(bytes),
        encodedBytes: bytes.byteLength,
      }
    },
    close: async () => {
      runtimeClosed++
    },
  }
  const service = new MaskRangeService(
    root,
    {
      source: async () => structuredClone(source),
      context: async (_id, expected) => {
        if (expected !== revision) throw new Error('Range context revision changed.')
        return {
          photoId,
          revision,
          geometry: identityMaskGeometry(width, height),
          width,
          height,
          renderingIdentity: contextIdentity,
        }
      },
      edits: async () => state(),
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
    { decoder, runtime },
  )
  const mask: ResolvedMask = {
    id: randomUUID(),
    name: 'Source brightness',
    enabled: true,
    inverted: false,
    head: null,
    range: structuredClone(defaultLuminanceMaskRange),
    edge: { ...neutralMaskEdge },
    light: { ...neutralMaskLight, exposureEv: 1 },
    color: { ...neutralMaskColor },
    strokes: [],
    resultStrokes: [],
    operands: [],
  }
  return {
    root,
    source,
    mask,
    service,
    inputs,
    options,
    pixels,
    counts: () => ({ decode, gpu, reserved, decoderClosed, runtimeClosed }),
    request: () => ({
      photoId,
      expectedRevision: revision,
      renderingIdentity: contextIdentity,
      point: { x: 0.5, y: 0.5 },
    }),
    linearPath: () => linearPath,
    revise: () => {
      revision++
      source.processing.revision = revision
      source.processing.adjustments!.exposureEv += 1
    },
    changeGeometry: () => {
      contextIdentity = 'geometry-changed'
    },
    beforeDecode: (hook: typeof beforeDecode) => {
      beforeDecode = hook
    },
    beforeGpu: (hook: typeof beforeGpu) => {
      beforeGpu = hook
    },
    lowBudget: () => {
      admission = {
        ...admission,
        policy: { ...admission.policy, vram: { ...admission.policy.vram, effectiveBytes: 1 } },
      }
    },
    close: async () => {
      await service.close()
      expect(reserved).toBe(0)
      expect(await readFile(originalPath)).toEqual(original)
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('range sampling consumes neutral Float32 source without SDR double decoding or HDR clipping and caches through creative edits', async () => {
  for (const hdr of [false, true]) {
    const f = await fixture(hdr)
    try {
      const first = await f.service.sample(f.request())
      expect(first.luminance).toBeCloseTo(hdr ? 400 : 50, 9)
      expect(Math.hypot(first.color!.a, first.color!.b)).toBeLessThan(1e-7)
      expect(first.canonicalPoint).toEqual({ x: 0.5, y: 0.5 })
      expect(first.validPixels).toBe(42)
      expect(f.counts().reserved).toBe(f.pixels.byteLength)
      expect(f.options[0]).toMatchObject({
        settings: { distortion: false, vignetting: false, chromaticAberration: false },
        adjustments: neutralAdjustments,
        prepareLinear: true,
        workingOnly: hdr,
      })
      for (const key of [
        'workingAsset',
        'crop',
        'noiseReduction',
        'detailSharpening',
        'firstSurface',
      ])
        expect(f.options[0][key as keyof (typeof f.options)[0]]).toBeUndefined()
      f.revise()
      const second = await f.service.sample(f.request())
      expect(second.sourceIdentity).toBe(first.sourceIdentity)
      expect(second.color).toEqual(first.color)
      expect(second.luminance).toBe(first.luminance)
      expect(f.counts().decode).toBe(1)
      expect(f.counts().gpu).toBe(0)
    } finally {
      await f.close()
    }
  }
})

test('derived range bases are parameter cached primitives and retain independent composition and corrections', async () => {
  const f = await fixture()
  try {
    const child = {
      id: randomUUID(),
      name: 'Independent brightness part',
      enabled: true,
      inverted: false,
      head: null,
      range: structuredClone(defaultLuminanceMaskRange),
      edge: { ...neutralMaskEdge },
      strokes: [],
      resultStrokes: [],
      operands: [],
      operator: 'intersect' as const,
    }
    const mask = {
      ...f.mask,
      inverted: true,
      edge: { featherPx: 2, shiftPx: 1 },
      operands: [child],
      strokes: [
        { mode: 'subtract' as const, radius: 0.1, feather: 0, points: [{ x: 0.5, y: 0.5 }] },
      ],
    }
    const before = structuredClone(mask)
    const first = await f.service.prepareMasks(f.source, [mask])
    expect(mask).toEqual(before)
    expect(first[0]).toMatchObject(before)
    expect(first[0].preparedRangeBase?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(first[0].operands![0].preparedRangeBase?.key).toBe(first[0].preparedRangeBase?.key)
    expect(first[0].preparedCoverage).toBeUndefined()
    expect(f.counts().gpu).toBe(1)
    const baseBytes = Buffer.from(first[0].preparedRangeBase!.pngBase64, 'base64').byteLength
    expect(f.counts().reserved).toBe(f.pixels.byteLength + baseBytes)
    f.revise()
    const second = await f.service.prepareMasks(f.source, [
      { ...mask, name: 'Renamed', light: { ...mask.light, exposureEv: 2 } },
    ])
    expect(second[0].preparedRangeBase).toEqual(first[0].preparedRangeBase)
    expect(f.counts().gpu).toBe(1)
    const changed = { ...f.mask, range: { ...defaultLuminanceMaskRange, lower: 50, upper: 90 } }
    expect((await f.service.prepareMasks(f.source, [changed]))[0].preparedRangeBase?.key).not.toBe(
      first[0].preparedRangeBase?.key,
    )
    expect(f.counts().gpu).toBe(2)
    expect(f.counts().reserved).toBe(f.pixels.byteLength + 2 * baseBytes)
    await f.service.close()
    expect(f.counts().reserved).toBe(0)
  } finally {
    await f.close()
  }
})

test('neutral ranges skip processing until coverage is requested and memory refusal precedes source decoding', async () => {
  const f = await fixture()
  try {
    const neutral = { ...f.mask, light: { ...neutralMaskLight } }
    expect(await f.service.prepareMasks(f.source, [neutral])).toEqual([neutral])
    expect(f.counts()).toMatchObject({ decode: 0, gpu: 0 })
    expect(
      (await f.service.prepareMasks(f.source, [neutral], undefined, true))[0].preparedRangeBase,
    ).toBeDefined()
    expect(f.counts()).toMatchObject({ decode: 1, gpu: 1 })
  } finally {
    await f.close()
  }
  const refused = await fixture()
  try {
    refused.lowBudget()
    await expect(refused.service.prepareMasks(refused.source, [refused.mask])).rejects.toThrow(
      'image-memory budget',
    )
    expect(refused.counts()).toMatchObject({ decode: 0, gpu: 0, reserved: 0 })
  } finally {
    await refused.close()
  }
})

test('range sampling rejects stale geometry/revisions and a changed cached canonical source before returning values', async () => {
  const f = await fixture()
  try {
    const request = f.request()
    const first = await f.service.sample(request)
    f.changeGeometry()
    await expect(f.service.sample(request)).rejects.toThrow('Refresh')
    const stale = f.request()
    f.revise()
    await expect(f.service.sample(stale)).rejects.toThrow('revision changed')
    const path = f.linearPath()
    const bytes = await readFile(path)
    await writeFile(path, Buffer.concat([bytes, Buffer.from([1])]))
    await expect(f.service.sample(f.request())).rejects.toThrow(/canonical|source|cache/i)
    expect(f.counts().reserved).toBe(0)
    const retried = await f.service.sample(f.request())
    expect(retried.color).toEqual(first.color)
    expect(retried.luminance).toBe(first.luminance)
    expect(f.counts().decode).toBe(2)
    expect(f.counts().reserved).toBe(f.pixels.byteLength)
  } finally {
    await f.close()
  }
})

test('cancelled range work drains before rejection and releases temporary reservations without publishing a base', async () => {
  const f = await fixture(),
    abort = new AbortController()
  let started!: () => void, release!: () => void
  const start = new Promise<void>((done) => {
      started = done
    }),
    drain = new Promise<void>((done) => {
      release = done
    })
  try {
    f.beforeGpu(async (signal) => {
      started()
      await new Promise<void>((_done, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Expected range cancellation.')), {
          once: true,
        }),
      ).catch(async (error) => {
        await drain
        throw error
      })
    })
    let settled = false
    const pending = f.service.prepareMasks(f.source, [f.mask], abort.signal).finally(() => {
      settled = true
    })
    const expected = expect(pending).rejects.toThrow('Expected range cancellation')
    await start
    abort.abort()
    await new Promise<void>((done) => setImmediate(done))
    expect(settled).toBe(false)
    release()
    await expected
    expect(f.counts().reserved).toBe(f.pixels.byteLength)
    expect(f.mask.preparedRangeBase).toBeUndefined()
  } finally {
    release?.()
    await f.close()
  }
})

test('range coverage disk reservation completes inside the preview queue and retains shared budget/release guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-range-preview-budget-'))
  const cache = new FullPreviews(
    root,
    () => undefined,
    {
      renderFull: async () => {
        throw new Error('No decode expected.')
      },
      close: async () => {},
    },
    100,
  )
  try {
    const serialized = cache as unknown as { enqueue<T>(run: () => Promise<T>): Promise<T> }
    const release = await serialized.enqueue(() => cache.reserveRangeCoverageBytes(60))
    await expect(cache.reserveRangeCoverageBytes(41)).rejects.toThrow('storage limit')
    release()
    release()
    const releaseAll = await cache.reserveRangeCoverageBytes(100)
    await expect(cache.reserveOutputProofBytes(1)).rejects.toThrow('storage limit')
    releaseAll()
    const proofRelease = await cache.reserveOutputProofBytes(100)
    await expect(cache.reserveRangeCoverageBytes(1)).rejects.toThrow('storage limit')
    proofRelease()
    await cache.close()
    await expect(cache.reserveRangeCoverageBytes(1)).rejects.toThrow('storage limit')
  } finally {
    await cache.close()
    await rm(root, { recursive: true, force: true })
  }
})
