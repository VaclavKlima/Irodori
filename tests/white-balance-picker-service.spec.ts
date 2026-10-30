import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { sampleNeutralWhiteBalance } from '../src/main/processing/white-balance-picker'
import { whiteBalanceSampleArea, type WhiteBalanceSample } from '../src/shared/white-balance-picker'
import type { FullPreviewProcessor } from '../src/main/preview-types'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { PROCESSING_METADATA_VERSION } from '../src/shared/lens'
import { unavailableProfile } from '../src/main/processing/metadata'
import { workingAsset, sha } from './export.helpers'
import { profile, normalization, product, patch } from './white-balance-picker.helpers'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-neutral-picker-'))
  const width = 97,
    height = 131
  const sample: WhiteBalanceSample = { x: 0.5, y: 63.5 / height, diameter: 15 }
  const area = whiteBalanceSampleArea(sample, width, height)
  const pixels = new Float32Array(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([5, -2, 1, 1], i)
  const xyz = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329]
  const neutral = patch(
    product(profile.xyzToCamera, xyz).map((v) => v * 0.15),
    1,
  )
  for (let y = area.y; y < area.y + area.height; y++)
    for (let x = area.x; x < area.x + area.width; x++) pixels.set(neutral, (y * width + x) * 4)
  const bytes = Buffer.from(pixels.buffer),
    asset = workingAsset(bytes, width, height)
  asset.whiteBalance = profile
  if (asset.source.display) throw new Error('Expected a synthetic capture fixture.')
  asset.source.normalization = normalization
  asset.source.decoder = 'synthetic-neutral-picker-service'
  const original = Buffer.from('Synthetic source fixture; no RAW decoder or camera is exercised.')
  const id = sha(original)
  const sourcePath = join(root, 'sample.f32')
  await writeFile(sourcePath, bytes)
  let renders = 0
  let beforeSample: (signal: AbortSignal) => Promise<void> = async () => {}
  const make = () => {
    const sampler = new PreviewProcess(resolve('out/main/preview-worker.js'))
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
          renderId: 'synthetic-neutral-source-v1',
          placeholderBytes: 0,
          linear: {
            byteLength: bytes.length,
            sha256: asset.sha256,
            transform: srgbTransform,
            hdr: asset,
          },
        }
      },
      whiteBalanceSample: async (path, job, signal) => {
        await beforeSample(signal)
        signal.throwIfAborted()
        return sampler.whiteBalanceSample(path, job, signal)
      },
      close: () => sampler.close(),
    }
    const args: ConstructorParameters<typeof PhotoLibrary> = [
      join(root, 'library'),
      {
        process: async () => {
          throw new Error('No decoding is allowed in a neutral-sample service fixture.')
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
        importedAt: '2026-10-25T00:00:00.000Z',
        previewSource: 'decoded',
        thumbnailUrl: '',
        previewUrl: '',
      },
      processingIdentity: 'hdr-v1',
      createdAt: '2026-10-25T00:00:00.000Z',
      metadata: {
        version: PROCESSING_METADATA_VERSION,
        lensProfile: unavailableProfile,
        whiteBalance: profile,
        hdrEligible: true,
      },
    },
  })
  return {
    root,
    id,
    sample,
    area,
    asset,
    bytes,
    sourcePath,
    get library() {
      return library
    },
    renders: () => renders,
    hold: (work: typeof beforeSample) => {
      beforeSample = work
    },
    restart: async () => {
      await library.close()
      library = make()
      await library.open()
    },
    assertSources: async () => {
      expect(await readFile(join(root, 'library', 'originals', id, 'original.arw'))).toEqual(
        original,
      )
      expect(await readFile(sourcePath)).toEqual(bytes)
    },
    close: async () => {
      await library.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('real isolated worker samples only the authenticated native region across a strip seam', async () => {
  const f = await fixture()
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const result = await worker.whiteBalanceSample(
      f.sourcePath,
      { asset: f.asset, sample: f.sample },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ status: 'valid', total: 225, accepted: 225, area: f.area })
    expect(result.residual!).toBeLessThanOrEqual(0.01)
    const corrupt = Buffer.from(f.bytes)
    corrupt[(f.area.y * f.asset.width + f.area.x) * 16] ^= 1
    const damaged = join(f.root, 'damaged.f32')
    await writeFile(damaged, corrupt)
    await expect(
      worker.whiteBalanceSample(
        damaged,
        { asset: f.asset, sample: f.sample },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Damaged HDR strip')
    await f.assertSources()
  } finally {
    await worker.close()
    await f.close()
  }
})

test('proposals ignore creative edits, remain read-only and apply one combined history entry across restart', async () => {
  const f = await fixture()
  try {
    const before = await f.library.getEditHistory(f.id)
    const first = await f.library.proposeWhiteBalance(f.id, 0, f.sample)
    expect(first).toMatchObject({
      status: 'valid',
      photoId: f.id,
      revision: 0,
      sample: f.sample,
      area: f.area,
    })
    expect(await f.library.getEditHistory(f.id)).toEqual(before)
    await f.library.updateEdits(
      f.id,
      {
        ...neutralAdjustments,
        exposureEv: 2,
        saturation: 80,
        vibrance: -60,
        whiteBalance: { mode: 'custom', kelvin: 4000, tint: 40 },
      },
      0,
    )
    const proposal = await f.library.proposeWhiteBalance(f.id, 1, f.sample)
    expect(proposal.status).toBe('valid')
    if (proposal.status !== 'valid' || first.status !== 'valid')
      throw new Error('Expected a usable neutral fixture.')
    expect(proposal.settings).toEqual(first.settings)
    expect(f.renders()).toBe(1)
    const prior = await f.library.getEditHistory(f.id)
    const accepted = await f.library.updateEdits(
      f.id,
      { whiteBalance: proposal.settings },
      proposal.revision,
    )
    const after = await f.library.getEditHistory(f.id)
    expect(after.snapshots).toHaveLength(prior.snapshots.length + 1)
    expect(accepted.settings).toMatchObject({
      whiteBalance: proposal.settings,
      exposureEv: 2,
      saturation: 80,
      vibrance: -60,
    })
    await expect(
      f.library.updateEdits(f.id, { whiteBalance: proposal.settings }, proposal.revision),
    ).rejects.toThrow('conflict')
    expect((await f.library.undoEdit(f.id, 2)).settings.whiteBalance).toEqual(
      prior.settings.whiteBalance,
    )
    expect((await f.library.redoEdit(f.id, 3)).settings.whiteBalance).toEqual(proposal.settings)
    await f.restart()
    expect((await f.library.getEdits(f.id)).settings.whiteBalance).toEqual(proposal.settings)
    expect(await f.library.proposeWhiteBalance(f.id, 4, f.sample)).toMatchObject({
      status: 'valid',
      settings: proposal.settings,
    })
    expect(f.renders()).toBe(1)
    await f.assertSources()
  } finally {
    await f.close()
  }
})

test('sampling rejects concurrent requests and stale revisions without adding history or retaining the busy owner', async () => {
  const f = await fixture(),
    entered = gate(),
    release = gate()
  f.hold(async () => {
    entered.resolve()
    await release.promise
  })
  try {
    const sampling = f.library.proposeWhiteBalance(f.id, 0, f.sample).then(
      (value) => ({ value }),
      (error) => ({ error: String(error) }),
    )
    await entered.promise
    const before = await f.library.getEditHistory(f.id)
    await expect(f.library.proposeWhiteBalance(f.id, 0, f.sample)).rejects.toThrow(
      'already being prepared',
    )
    expect(await f.library.getEditHistory(f.id)).toEqual(before)
    await f.library.updateEdits(f.id, { contrast: 30 }, 0)
    release.resolve()
    expect(await sampling).toHaveProperty('error')
    await expect(f.library.proposeWhiteBalance(f.id, 0, f.sample)).rejects.toThrow(
      'revision conflict',
    )
    f.hold(async () => {})
    expect(await f.library.proposeWhiteBalance(f.id, 1, f.sample)).toMatchObject({
      status: 'valid',
      revision: 1,
    })
    expect((await f.library.getEditHistory(f.id)).snapshots).toHaveLength(2)
    await f.assertSources()
  } finally {
    release.resolve()
    await f.close()
  }
})

test('unsupported composite sources are rejected before sampling', async () => {
  const f = await fixture()
  try {
    const asset = structuredClone(f.asset)
    if (asset.source.display) throw new Error('Expected a capture fixture.')
    asset.source.composite = { kind: 'hdr', sourceCount: 3 }
    asset.source.normalization.sourceSaturation = null
    const result = await sampleNeutralWhiteBalance(f.sourcePath, { asset, sample: f.sample })
    expect(result).toMatchObject({ status: 'invalid', reason: 'unsupported-source', accepted: 0 })
    await f.assertSources()
  } finally {
    await f.close()
  }
})
