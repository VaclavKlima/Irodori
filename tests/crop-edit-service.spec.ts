import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { ExportProcess } from '../src/main/export/process'
import { processingMetadata } from '../src/main/processing/metadata'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import { defaultExportOptions } from '../src/shared/export'
import type { LibraryEvent } from '../src/shared/contracts'
import { cropAdmission } from './crop-frame.helpers'

const previousPreview = process.env.IRODORI_PREVIEW_BACKEND,
  previousExport = process.env.IRODORI_EXPORT_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
  process.env.IRODORI_EXPORT_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previousPreview === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previousPreview
  if (previousExport === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = previousExport
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-crop-edit-')),
    width = 100,
    height = 80,
    rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rgba.set([32 + x, 44 + y, 64 + Math.floor((x + y) / 2), 255], (y * width + x) * 4)
  const original = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer(),
    id = createHash('sha256').update(original).digest('hex'),
    path = join(root, 'library', 'originals', id, 'original.png'),
    destination = join(root, 'destination'),
    events: LibraryEvent[] = [],
    counters = { sources: 0, crops: 0 }
  const create = () => {
    const worker = new PreviewProcess(resolve('out/main/preview-worker.js')),
      args: ConstructorParameters<typeof PhotoLibrary> = [
        join(root, 'library'),
        {
          async process() {
            throw new Error('Unexpected import preparation.')
          },
          async close() {},
        },
        (event) => events.push(event),
      ]
    args[15] = new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    )
    args[16] = {
      async renderFull(source, output, signal, options) {
        if (!options?.workingAsset) counters.sources++
        return worker.renderFull(source, output, signal, options)
      },
      async prepareCropPreview(source, output, job, signal) {
        counters.crops++
        return worker.prepareCropPreview(source, output, job, signal)
      },
      statistics: (path, frame, signal) => worker.statistics(path, frame, signal),
      releaseFrame: () => worker.releaseFrame(),
      close: () => worker.close(true),
    }
    const library = new PhotoLibrary(...args)
    library.cropAdmission = async () => cropAdmission()
    library.fullPreviews.installCropAdmission(library.cropAdmission)
    return library
  }
  let library = create()
  await library.open()
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, original)
  await mkdir(destination)
  await library.catalogCommands.command({
    operation: 'original.publish',
    payload: {
      photo: {
        id,
        filename: 'Authored.png',
        format: 'PNG',
        width: 999,
        height: 777,
        bytes: original.length,
        importedAt: '2026-10-25T00:00:00.000Z',
        previewSource: 'image',
        thumbnailUrl: '',
        previewUrl: '',
      },
      processingIdentity: 'display-referred-v1',
      createdAt: '2026-10-25T00:00:00.000Z',
      metadata: processingMetadata({}, []),
    },
  })
  return {
    root,
    id,
    path,
    original,
    destination,
    events,
    counters,
    get library() {
      return library
    },
    async restart() {
      await library.close()
      library = create()
      await library.open()
    },
    async close() {
      await library.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('committed crop agrees with independent oriented pixels, histogram, frozen export and history after restart', async () => {
  const f = await fixture()
  try {
    const context = await f.library.getCropContext(f.id, 0),
      crop = { ...identityCrop, quarterTurns: 1 as const, width: 0.8, height: 0.75 }
    expect(context.source).toEqual({ width: 80, height: 100 })
    const geometry = cropGeometry(context.source, crop)
    expect(geometry.pixelAligned).toBe(true)
    expect([geometry.width, geometry.height]).toEqual([80, 60])
    const accepted = await f.library.updateEdits(f.id, { crop }, 0)
    expect(accepted).toMatchObject({
      revision: 1,
      settings: { crop },
      canUndo: true,
      canRedo: false,
    })
    expect(
      f.events
        .filter((event) => event.geometryChanged)
        .map((event) => event.geometryChanged!.revision),
    ).toEqual([1])
    const frame = await f.library.fullPreviews.requestEditing(f.id, randomUUID()),
      lease = f.library.fullPreviews.acquire(new URL(frame.url))!,
      expected = await sharp(f.original)
        .autoOrient()
        .rotate(90)
        .extract({ left: 10, top: 10, width: 80, height: 60 })
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer()
    try {
      expect(await readFile(lease.path)).toEqual(expected)
    } finally {
      lease.release()
    }
    expect(frame.crop).toEqual(geometry)
    expect(frame.linear!.byteLength).toBe(80 * 60 * 16)
    expect((await f.library.getPhotoStatistics(f.id, 1)).visiblePixels).toBe(80 * 60)
    expect(f.counters).toEqual({ sources: 1, crops: 1 })

    const prepared = await f.library.prepareExport([f.id]),
      grant = await f.library.exports.store.authorize(f.destination),
      exportId = await f.library.startExport({
        preparationId: prepared.id,
        destinationId: grant.id,
        action: 'custom',
        options: { ...defaultExportOptions, output: 'sdr', metadata: 'none', quality: 100 },
      })
    await f.library.updateEdits(f.id, { exposureEv: 0.5 }, 1)
    await expect
      .poll(() => f.library.listTasks().find((task) => task.id === exportId)?.finishedAt, {
        timeout: 20000,
      })
      .toBeTruthy()
    expect(f.library.listTasks().find((task) => task.id === exportId)!.export).toMatchObject({
      exported: 1,
      failed: 0,
    })
    const frozen = f.library.exports.store
      .jobs()
      .find((job) => job.manifest.id === exportId)!.manifest
    expect(frozen.sources[0].processing.crop).toEqual(crop)
    expect(frozen.sources[0].processing.revision).toBe(1)
    const output = join(f.destination, 'Authored.jpg'),
      decoded = await sharp(output).ensureAlpha().raw().toBuffer()
    expect(await sharp(output).metadata()).toMatchObject({ width: 80, height: 60 })
    let maximumError = 0
    for (let i = 0; i < expected.length; i++)
      maximumError = Math.max(maximumError, Math.abs(decoded[i] - expected[i]) / 255)
    expect(maximumError).toBeLessThanOrEqual(0.03)

    await f.library.undoEdit(f.id, 2)
    expect((await f.library.undoEdit(f.id, 3)).settings.crop).toEqual(identityCrop)
    const uncropped = await f.library.fullPreviews.requestEditing(f.id, randomUUID())
    expect([uncropped.width, uncropped.height]).toEqual([80, 100])
    await f.library.redoEdit(f.id, 4)
    await f.library.redoEdit(f.id, 5)
    await f.library.undoEdit(f.id, 6)
    const saved = await f.library.getEditHistory(f.id)
    expect(saved).toMatchObject({ revision: 7, canRedo: true, settings: { crop, exposureEv: 0 } })
    await f.restart()
    expect(await f.library.getEditHistory(f.id)).toEqual(saved)
    expect((await f.library.redoEdit(f.id, 7)).settings).toMatchObject({ crop, exposureEv: 0.5 })
    const restored = await f.library.fullPreviews.requestEditing(f.id, randomUUID())
    expect(restored.crop).toEqual(geometry)
    expect(f.counters).toEqual({ sources: 1, crops: 1 })
    expect(await readFile(f.path)).toEqual(f.original)
  } finally {
    await f.close()
  }
})

test('crop patches freeze caller data, reject invalid native geometry and preserve one winning history branch', async () => {
  const f = await fixture()
  try {
    const crop = { ...identityCrop, width: 0.5, height: 0.5 },
      frozen = { ...crop },
      pending = f.library.updateEdits(f.id, { crop }, 0)
    Object.assign(crop, { angle: 45, centerX: 0.99 })
    expect((await pending).settings.crop).toEqual(frozen)
    const before = await f.library.getEditHistory(f.id)
    for (const invalid of [
      { ...identityCrop, version: 2 },
      { ...identityCrop, angle: 0.001 },
      { ...identityCrop, width: 0.00000001 },
      { ...identityCrop, centerX: 0.99, width: 0.8 },
      { ...identityCrop, aspectRatio: 1 },
      { ...identityCrop, extra: true },
    ]) {
      await expect(f.library.updateEdits(f.id, { crop: invalid } as never, 1)).rejects.toThrow(
        /crop|native pixel/i,
      )
      expect(await f.library.getEditHistory(f.id)).toEqual(before)
    }
    const outcomes = await Promise.allSettled([
      f.library.updateEdits(f.id, { crop: { ...frozen, centerX: 0.45 } }, 1),
      f.library.updateEdits(f.id, { crop: { ...frozen, centerX: 0.55 } }, 1),
    ])
    expect(outcomes.map((value) => value.status).sort()).toEqual(['fulfilled', 'rejected'])
    const accepted = await f.library.getEditHistory(f.id)
    expect(accepted.revision).toBe(2)
    expect(accepted.snapshots).toHaveLength(3)
    await f.library.undoEdit(f.id, 2)
    const branched = await f.library.updateEdits(f.id, { saturation: 15 }, 3)
    expect(branched).toMatchObject({
      revision: 4,
      canRedo: false,
      settings: { crop: frozen, saturation: 15 },
    })
    expect((await f.library.getEditHistory(f.id)).snapshots).toHaveLength(3)
    expect(await readFile(f.path)).toEqual(f.original)
  } finally {
    await f.close()
  }
})
