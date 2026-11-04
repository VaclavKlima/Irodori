import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import type { FullPreviewProcessor } from '../src/main/preview-types'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import { processingMetadata } from '../src/main/processing/metadata'
import { workingAsset, sha } from './export.helpers'
import { identityToneCurves } from '../src/shared/tone-curves'
import { profile } from './white-balance-picker.helpers'
import { whiteBalanceMatrix } from '../src/shared/white-balance'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-curves-')),
    width = 97,
    height = 131,
    pixels = new Float32Array(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([0.18, 0.36, 0.09, 1], i)
  const bytes = Buffer.from(pixels.buffer),
    asset = workingAsset(bytes, width, height),
    original = Buffer.from('Explicitly synthetic curve source; no real camera decoder.'),
    id = sha(original)
  asset.whiteBalance = profile
  let renders = 0,
    hold: ((signal: AbortSignal) => Promise<void>) | undefined
  const make = () => {
    const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
    const processor: FullPreviewProcessor = {
      renderFull: async (_path, output) => {
        renders++
        await writeFile(join(output, 'linear.f32'), bytes)
        return {
          width,
          height,
          format: 'hdr-working',
          byteLength: 0,
          sha256: asset.sha256,
          renderId: 'synthetic-curve-source',
          placeholderBytes: 0,
          linear: {
            byteLength: bytes.length,
            sha256: asset.sha256,
            transform: srgbTransform,
            hdr: asset,
          },
        }
      },
      curveTone: async (path, job, signal) => {
        await hold?.(signal)
        return worker.curveTone(path, job, signal)
      },
      close: () => worker.close(),
    }
    const args: ConstructorParameters<typeof PhotoLibrary> = [
      join(root, 'library'),
      {
        process: async () => {
          throw new Error('No decoding in this synthetic fixture.')
        },
        close: async () => {},
      },
      () => {},
    ]
    args[16] = processor
    return new PhotoLibrary(...args)
  }
  let library = make()
  await library.open()
  await mkdir(join(root, 'library', 'originals', id), { recursive: true })
  await writeFile(join(root, 'library', 'originals', id, 'original.arw'), original)
  await library.catalogCommands.command({
    operation: 'original.publish',
    payload: {
      photo: {
        id,
        filename: 'Synthetic.ARW',
        format: 'ARW',
        width,
        height,
        bytes: original.length,
        importedAt: '2026-11-04T00:00:00Z',
        previewSource: 'decoded',
        thumbnailUrl: '',
        previewUrl: '',
      },
      processingIdentity: 'hdr-v1',
      createdAt: '2026-11-04T00:00:00Z',
      metadata: { ...processingMetadata({}, []), hdrEligible: true, whiteBalance: profile },
    },
  })
  return {
    id,
    asset,
    bytes,
    root,
    get library() {
      return library
    },
    renders: () => renders,
    setHold: (next: typeof hold) => {
      hold = next
    },
    restart: async () => {
      await library.close()
      library = make()
      await library.open()
    },
    close: async () => {
      await library.close()
      expect(await readFile(join(root, 'library', 'originals', id, 'original.arw'))).toEqual(
        original,
      )
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('the real sample worker authenticates a 5 × 5 seam region, shares atomic history and reuses prepared data through restart', async () => {
  const f = await fixture()
  try {
    const request = { channel: 'master' as const, x: 0.5, y: 63.5 / 131 },
      before = await f.library.sampleCurveTone(f.id, 0, request)
    expect(before).toMatchObject({
      photoId: f.id,
      revision: 0,
      channel: 'master',
      visibleSamples: 25,
      area: { x: 46, y: 61, width: 5, height: 5 },
    })
    const curve = [
      { input: 0, output: 0 },
      { input: 1, output: 2 },
    ]
    const edited = await f.library.updateEdits(
      f.id,
      { curves: { master: curve }, exposureEv: 1 },
      0,
    )
    expect(
      (
        await f.library.updateEdits(
          f.id,
          { curves: { master: curve.map((p) => ({ output: p.output, input: p.input })) } },
          1,
        )
      ).revision,
    ).toBe(1)
    const sample = await f.library.sampleCurveTone(f.id, 1, { ...request, channel: 'red' })
    expect(sample.input).toBeGreaterThan(0.36)
    expect(sample.input).not.toBeCloseTo(0.36, 4)
    expect(f.renders()).toBe(1)
    await expect(f.library.sampleCurveTone(f.id, 0, request)).rejects.toThrow('revision conflict')
    await f.library.undoEdit(f.id, 1)
    expect((await f.library.getEdits(f.id)).settings.curves).toEqual(identityToneCurves)
    await f.library.redoEdit(f.id, 2)
    const history = await f.library.getEditHistory(f.id)
    expect(history.settings).toEqual(edited.settings)
    await f.restart()
    expect(await f.library.getEditHistory(f.id)).toEqual(history)
    expect((await f.library.sampleCurveTone(f.id, 3, request)).input).toBeCloseTo(
      before.input * 2,
      7,
    )
    expect(f.renders()).toBe(1)
  } finally {
    await f.close()
  }
})

test('a revision arriving during sample acquisition invalidates the response and never changes history', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve))
  try {
    f.setHold(async () => {
      entered()
      await held
    })
    const request = f.library.sampleCurveTone(f.id, 0, { channel: 'blue', x: 0.5, y: 0.5 })
    const outcome = expect(request).rejects.toThrow(/revision conflict|abort|settings|cancel/i)
    await started
    await f.library.updateEdits(
      f.id,
      {
        curves: {
          blue: [
            { input: 0, output: 0 },
            { input: 1, output: 1.1 },
          ],
        },
      },
      0,
    )
    release()
    await outcome
    expect((await f.library.getEditHistory(f.id)).snapshots).toHaveLength(2)
  } finally {
    release?.()
    await f.close()
  }
})

test('HDR tone sampling uses the prepared asset white-balance profile before Light and Master', async () => {
  const f = await fixture()
  try {
    const whiteBalance = { mode: 'custom' as const, kelvin: 6500, tint: 15 }
    await f.library.updateEdits(f.id, { whiteBalance }, 0)
    const sampled = await f.library.sampleCurveTone(f.id, 1, { channel: 'red', x: 0.5, y: 0.5 }),
      matrix = whiteBalanceMatrix(whiteBalance, profile)!
    const expected =
      matrix[0] * Math.fround(0.18) + matrix[1] * Math.fround(0.36) + matrix[2] * Math.fround(0.09)
    expect(sampled.input).toBeCloseTo(expected, 9)
    expect(sampled.input).not.toBeCloseTo(0.18, 4)
  } finally {
    await f.close()
  }
})

test('the real worker refuses full-image CPU curve analysis before reading a source and retains identity analysis', async () => {
  const f = await fixture(),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const job = {
      asset: f.asset,
      adjustments: {
        ...neutralAdjustments,
        curves: {
          ...identityToneCurves,
          red: [
            { input: 0, output: 0 },
            { input: 1, output: 1.1 },
          ],
        },
      },
      domain: 'working-hdr' as const,
      target: SDR_TARGET,
    }
    await expect(
      worker.hdrStatistics(
        join(f.root, 'unavailable-source.f32'),
        job,
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      'Exact HDR statistics with active curves require a qualified GPU analysis path',
    )
    const path = join(f.root, 'prepared.f32')
    await writeFile(path, f.bytes)
    const result = await worker.hdrStatistics(
      path,
      {
        ...job,
        adjustments: { ...neutralAdjustments, curves: identityToneCurves },
      },
      new AbortController().signal,
    )
    expect(result.visiblePixels).toBe(f.asset.width * f.asset.height)
    expect(await readFile(path)).toEqual(f.bytes)
  } finally {
    await worker.close()
    await f.close()
  }
})
