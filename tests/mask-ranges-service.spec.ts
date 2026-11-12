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
import { renderHdr } from '../src/main/processing/hdr-processing'
import { initialSettings, type EditState } from '../src/shared/edits'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { automaticLensSettings } from '../src/shared/lens'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { defaultLuminanceMaskRange } from '../src/shared/mask-ranges'
import { MERGE_VERSION, type MergeRecipe } from '../src/shared/merge'
import {
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type ResolvedMask,
} from '../src/shared/masks'
import { cropAdmission } from './crop-frame.helpers'
import { workingAsset } from './export.helpers'

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

async function fixture(hdr = false, merged = false) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-range-service-'))
  const width = 8,
    height = 6,
    pixels = new Float32Array(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4)
    pixels.set([hdr ? 4 : 0.5, hdr ? 4 : 0.5, hdr ? 4 : 0.5, 1], i)
  const originalPath = join(root, merged ? 'master.f32' : 'original.dat'),
    original = merged ? Buffer.from(pixels.buffer) : Buffer.from('unchanged-range-original')
  await writeFile(originalPath, original)
  const stat = await lstat(originalPath)
  const photoId = hash(original)
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
  if (merged) {
    const asset = workingAsset(original, width, height)
    asset.source.composite = { kind: 'hdr', sourceCount: 3 }
    // Only the accepted header is consumed here; no merge computation is exercised.
    source.processing.metadata.mergeMaster = {
      asset,
      recipe: { version: MERGE_VERSION } as MergeRecipe,
    }
    source.processing.workingAsset = {
      path: originalPath,
      width,
      height,
      byteLength: original.byteLength,
      sha256: asset.sha256,
      transform: srgbTransform,
      hdr: asset,
    }
  }
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
      if (merged)
        return renderHdr(
          _path,
          output,
          config!,
          {
            render: async () => {
              throw new Error('A merged range source must not decode RAW pixels.')
            },
            releaseFrame() {},
            mergeDevice() {
              throw new Error('A merged range source must not render a display proof.')
            },
          },
          'gpu',
          undefined,
          async () => {
            throw new Error('A merged range source must not open a RAW host.')
          },
        )
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
        let released = false,
          held = bytes
        return Object.assign(
          () => {
            if (!released) {
              released = true
              reserved -= held
            }
          },
          {
            shrink(next: number) {
              if (released || !Number.isSafeInteger(next) || next < 0 || next > held)
                throw new Error('Invalid fixture reservation shrink.')
              reserved -= held - next
              held = next
            },
          },
        )
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

test('merged HDR range sampling and coverage retain the permanent master without RAW decoding or highlight clipping', async () => {
  const f = await fixture(true, true)
  try {
    const master = structuredClone(f.source.processing.workingAsset),
      metadata = structuredClone(f.source.processing.metadata.mergeMaster)
    const first = await f.service.sample(f.request())
    expect(first.luminance).toBeCloseTo(400, 9)
    expect(await readFile(f.linearPath())).toEqual(Buffer.from(f.pixels.buffer))
    expect(f.options[0]).toMatchObject({
      workingAsset: master,
      adjustments: neutralAdjustments,
      prepareLinear: true,
      workingOnly: true,
    })
    const masks = await f.service.prepareMasks(f.source, [f.mask])
    expect(masks[0].preparedRangeBase).toMatchObject({ width: 8, height: 6 })
    expect(f.inputs[0][6]?.source).toMatchObject({
      primaries: 'rec2020',
      sha256: master!.sha256,
      width: 8,
      height: 6,
    })
    f.revise()
    const after = await f.service.sample(f.request())
    expect(after.sourceIdentity).toBe(first.sourceIdentity)
    expect(after.luminance).toBe(first.luminance)
    const repeated = await f.service.prepareMasks(f.source, [f.mask])
    expect(repeated[0].preparedRangeBase).toEqual(masks[0].preparedRangeBase)
    expect(f.counts()).toMatchObject({ decode: 1, gpu: 1 })
    expect(f.source.processing.workingAsset).toEqual(master)
    expect(f.source.processing.metadata.mergeMaster).toEqual(metadata)
  } finally {
    await f.close()
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

async function rangePreviewBudgetFixture(options?: ConstructorParameters<typeof FullPreviews>[4]) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-range-preview-reclaim-')),
    original = Buffer.from('unchanged-preview-budget-source'),
    originalPath = join(root, 'original.dat'),
    ids = ['a'.repeat(64), 'b'.repeat(64)]
  await writeFile(originalPath, original)
  const pixels = Buffer.alloc(2 * 2 * 4, 127)
  let renders = 0
  const cache = new FullPreviews(
    root,
    (id) => (ids.includes(id) ? originalPath : undefined),
    {
      renderFull: async (_path, output) => {
        renders++
        await writeFile(join(output, 'full.rgba'), pixels)
        await writeFile(join(output, 'placeholder.png'), Buffer.alloc(0))
        return {
          width: 2,
          height: 2,
          format: 'rgba8-srgb',
          byteLength: pixels.byteLength,
          sha256: hash(pixels),
          renderId: 'synthetic-range-budget-preview',
          placeholderBytes: 0,
        }
      },
      close: async () => {},
    },
    100,
    options,
  )
  await cache.open()
  return {
    cache,
    ids,
    pixels,
    renders: () => renders,
    async close() {
      await cache.close()
      expect(await readFile(originalPath)).toEqual(original)
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('range storage reservation shrink retains its remaining bytes until release', async () => {
  const f = await rangePreviewBudgetFixture()
  const releases: (() => void)[] = []
  try {
    const retained = await f.cache.reserveRangeCoverageBytes(100)
    releases.push(retained)
    retained.shrink(60)
    retained.shrink(60)
    for (const invalid of [-1, 60.5, 61, NaN, Infinity])
      expect(() => retained.shrink(invalid)).toThrow()
    await expect(f.cache.reserveRangeCoverageBytes(41)).rejects.toThrow(/storage limit/i)
    releases.push(await f.cache.reserveRangeCoverageBytes(40))
    await expect(f.cache.reserveRangeCoverageBytes(1)).rejects.toThrow(/storage limit/i)
    retained()
    retained()
    expect(() => retained.shrink(0)).toThrow()
    const replacement = await f.cache.reserveRangeCoverageBytes(60)
    releases.push(replacement)
    await expect(f.cache.reserveRangeCoverageBytes(1)).rejects.toThrow(/storage limit/i)
    replacement.shrink(0)
    releases.push(await f.cache.reserveRangeCoverageBytes(60))
  } finally {
    for (const release of releases) release()
    await f.close()
  }
})

test('range storage reclaims unused previews while protecting the active photo and open streams', async () => {
  const f = await rangePreviewBudgetFixture()
  let stream: ReturnType<FullPreviews['acquire']>, release: (() => void) | undefined
  try {
    const old = await f.cache.request(f.ids[0], randomUUID())
    stream = f.cache.acquire(new URL(old.url))!
    const current = await f.cache.request(f.ids[1], randomUUID())
    const refused = f.cache.reserveRangeCoverageBytes(80)
    await expect(refused).rejects.toThrow(/storage limit/i)
    expect(await readFile(stream.path)).toEqual(f.pixels)
    const oldPath = stream.path
    stream.release()
    stream = undefined
    const serialized = f.cache as unknown as {
      enqueue<T>(run: () => Promise<T>): Promise<T>
    }
    release = await serialized.enqueue(() => f.cache.reserveRangeCoverageBytes(80))
    await expect(refused).rejects.toThrow(/requested/i)
    await expect(refused).rejects.toThrow(/budget/i)
    await expect(refused).rejects.toThrow(/protected/i)
    expect(f.cache.acquire(new URL(old.url))).toBeUndefined()
    await expect(readFile(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const active = f.cache.acquire(new URL(current.url))!
    try {
      expect(await readFile(active.path)).toEqual(f.pixels)
      expect(f.cache.getDiagnostics().photoId).toBe(current.photoId)
    } finally {
      active.release()
    }
    release()
    release()
  } finally {
    stream?.release()
    release?.()
    await f.close()
  }
})

test('range reclamation protects a cached photo while its preview lookup awaits current settings', async () => {
  let block = false,
    entered!: () => void,
    unblock!: () => void
  const started = new Promise<void>((done) => {
      entered = done
    }),
    gate = new Promise<void>((done) => {
      unblock = done
    })
  const f = await rangePreviewBudgetFixture(async () => {
    if (block) {
      entered()
      await gate
    }
    return {
      metadata: processingMetadata({}, []),
      settings: { ...automaticLensSettings },
      revision: 0,
    }
  })
  let pending: ReturnType<FullPreviews['request']> | undefined, release: (() => void) | undefined
  try {
    const first = await f.cache.request(f.ids[0], randomUUID())
    await f.cache.request(f.ids[1], randomUUID())
    block = true
    pending = f.cache.request(f.ids[0], randomUUID())
    await started
    release = await f.cache.reserveRangeCoverageBytes(80)
    unblock()
    const resumed = await pending
    expect(resumed.url).toBe(first.url)
    expect(f.renders()).toBe(2)
    const active = f.cache.acquire(new URL(resumed.url))!
    try {
      expect(await readFile(active.path)).toEqual(f.pixels)
    } finally {
      active.release()
    }
  } finally {
    unblock()
    await pending?.catch(() => undefined)
    release?.()
    await f.close()
  }
})

test('concurrent range and output-proof reservations cannot overcommit protected preview storage', async () => {
  const f = await rangePreviewBudgetFixture()
  const releases: (() => void)[] = []
  try {
    await f.cache.request(f.ids[0], randomUUID())
    const current = await f.cache.request(f.ids[1], randomUUID())
    for (const second of ['range', 'proof'] as const) {
      const outcomes = await Promise.allSettled([
        f.cache.reserveRangeCoverageBytes(48),
        second === 'range'
          ? f.cache.reserveRangeCoverageBytes(48)
          : f.cache.reserveOutputProofBytes(48),
      ])
      const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      expect(accepted).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
      for (const outcome of accepted) {
        releases.push(outcome.value)
        outcome.value()
      }
    }
    releases.push(await f.cache.reserveRangeCoverageBytes(48))
    await expect(f.cache.reserveOutputProofBytes(37)).rejects.toThrow(/storage limit/i)
    const proofRelease = await f.cache.reserveOutputProofBytes(36)
    releases.push(proofRelease)
    await expect(f.cache.reserveRangeCoverageBytes(1)).rejects.toThrow(/storage limit/i)
    const active = f.cache.acquire(new URL(current.url))!
    try {
      expect(await readFile(active.path)).toEqual(f.pixels)
    } finally {
      active.release()
    }
    for (const release of releases) {
      release()
      release()
    }
    const retryRelease = await f.cache.reserveRangeCoverageBytes(84)
    releases.push(retryRelease)
  } finally {
    for (const release of releases) release()
    await f.close()
  }
})
