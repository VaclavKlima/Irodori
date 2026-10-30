import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { ExportProcess } from '../src/main/export/process'
import { processingMetadata } from '../src/main/processing/metadata'
import { defaultExportOptions } from '../src/shared/export'
import { imageStatistics } from '../src/shared/statistics'
import type { EditPatch } from '../src/shared/edits'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import { cropAdmission } from './crop-frame.helpers'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: { input: number[]; output: number[]; primaries: string; configuration: number }[]
}
const palette = [
    [0, 0, 0],
    [1, 1, 1],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ],
  tile = 16,
  width = tile * palette.length,
  height = 24
function expected(index: number) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let x = 0; x < width; x++) {
    const color = palette[Math.floor(x / tile)],
      vector = reference.gpuVectors.find(
        (v) =>
          v.primaries === 'srgb' &&
          v.configuration === index &&
          v.input.every((v, i) => v === color[i]),
      )
    if (!vector) throw new Error(`Independent palette vector unavailable: ${color}`)
    const encoded = vector.output.map((v) =>
      Math.round(
        Math.min(1, Math.max(0, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)) * 255,
      ),
    )
    for (let y = 0; y < height; y++) pixels.set([...encoded, 255], (y * width + x) * 4)
  }
  return pixels
}
function patch(index: number): EditPatch {
  const value = reference.configurations[index]
  return { colorMixer: value.mixer, colorGrading: value.grading, ...value.intensity }
}

test('a small authored image agrees with independent grades, reuses its source and freezes export through later edits and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-color-raster-')),
    original = await sharp(expected(0), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
    id = createHash('sha256').update(original).digest('hex'),
    path = join(root, 'library', 'originals', id, 'original.png'),
    destination = join(root, 'destination'),
    oldPreview = process.env.IRODORI_PREVIEW_BACKEND,
    oldExport = process.env.IRODORI_EXPORT_BACKEND,
    counters = { sources: 0 }
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
  process.env.IRODORI_EXPORT_BACKEND = 'cpu'
  const create = () => {
    const worker = new PreviewProcess(resolve('out/main/preview-worker.js')),
      args: ConstructorParameters<typeof PhotoLibrary> = [
        join(root, 'library'),
        {
          process: async () => {
            throw new Error('No import decoder is needed')
          },
          close: async () => {},
        },
        () => {},
      ]
    args[15] = new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    )
    args[16] = {
      renderFull: (source, output, signal, options) => {
        if (!options?.workingAsset) counters.sources++
        return worker.renderFull(source, output, signal, options)
      },
      prepareCropPreview: (source, output, job, signal) =>
        worker.prepareCropPreview(source, output, job, signal),
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
  try {
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
          width,
          height,
          bytes: original.length,
          importedAt: '2026-10-27T12:00:00.000Z',
          previewSource: 'image',
          thumbnailUrl: '',
          previewUrl: '',
        },
        processingIdentity: 'display-referred-v1',
        createdAt: '2026-10-27T12:00:00.000Z',
        metadata: processingMetadata({}, []),
      },
    })
    const inspect = async (index: number, revision: number) => {
      const frame = await library.fullPreviews.requestEditing(id, randomUUID()),
        lease = library.fullPreviews.acquire(new URL(frame.url))!
      try {
        const proof = await readFile(lease.path),
          pixels = expected(index)
        expect([frame.width, frame.height]).toEqual([width, height])
        expect(proof.length).toBe(pixels.length)
        let maximum = 0
        for (let i = 0; i < pixels.length; i++) {
          if (i % 4 === 3) expect(proof[i]).toBe(255)
          else maximum = Math.max(maximum, Math.abs(proof[i] - pixels[i]))
        }
        expect(maximum).toBeLessThanOrEqual(1)
        expect(await library.getPhotoStatistics(id, revision)).toMatchObject({
          ...imageStatistics(proof),
        })
        return frame.linear!.sha256
      } finally {
        lease.release()
      }
    }
    const sourceHash = await inspect(0, 0)
    expect(sourceHash).toMatch(/^[a-f0-9]{64}$/)
    for (const [ordinal, index] of [2, 5, 9].entries()) {
      await library.updateEdits(id, patch(index), ordinal)
      expect(await inspect(index, ordinal + 1)).toBe(sourceHash)
      expect(counters.sources).toBe(1)
    }
    const preparation = await library.prepareExport([id]),
      grant = await library.exports.store.authorize(destination),
      taskId = await library.startExport({
        preparationId: preparation.id,
        destinationId: grant.id,
        action: 'custom',
        options: { ...defaultExportOptions, quality: 100, output: 'sdr', metadata: 'none' },
      })
    await library.updateEdits(id, patch(2), 3)
    await expect
      .poll(() => library.listTasks().find((task) => task.id === taskId)?.finishedAt, {
        timeout: 20000,
      })
      .toBeTruthy()
    expect(library.listTasks().find((task) => task.id === taskId)?.export).toMatchObject({
      exported: 1,
      failed: 0,
    })
    const manifest = library.exports.store
      .jobs()
      .find((job) => job.manifest.id === taskId)!.manifest
    expect(manifest.sources[0].processing).toMatchObject({
      revision: 3,
      adjustments: {
        colorMixer: reference.configurations[9].mixer,
        colorGrading: reference.configurations[9].grading,
        ...reference.configurations[9].intensity,
      },
    })
    const output = await sharp(join(destination, 'Authored.jpg')).ensureAlpha().raw().toBuffer(),
      pixels = expected(9)
    // Compare tile interiors; the existing JPEG tolerance includes independent codec quantization.
    let maximum = 0
    for (let y = 4; y < height - 4; y++)
      for (let x = 4; x < width; x++)
        if (x % tile >= 4 && x % tile < tile - 4)
          for (let c = 0; c < 3; c++)
            maximum = Math.max(
              maximum,
              Math.abs(output[(y * width + x) * 4 + c] - pixels[(y * width + x) * 4 + c]) / 255,
            )
    expect(maximum).toBeLessThanOrEqual(0.03)
    const saved = await library.getEditHistory(id)
    await library.close()
    library = create()
    await library.open()
    expect(await library.getEditHistory(id)).toEqual(saved)
    expect(await inspect(2, 4)).toBe(sourceHash)
    expect(counters.sources).toBe(1)
    await library.undoEdit(id, 4)
    expect(await inspect(9, 5)).toBe(sourceHash)
    await library.redoEdit(id, 5)
    expect(await inspect(2, 6)).toBe(sourceHash)
    expect(await readFile(path)).toEqual(original)
  } finally {
    await library.close()
    await rm(root, { recursive: true, force: true })
    if (oldPreview === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
    else process.env.IRODORI_PREVIEW_BACKEND = oldPreview
    if (oldExport === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = oldExport
  }
})
