import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { resizeLinear } from '../src/main/export/resize'
import { ExportProcess } from '../src/main/export/process'
import { renderExport } from '../src/main/export/render'
import { exportResizePolicy } from '../src/main/export/resize-policy'
import { exportCropPolicy } from '../src/main/export/crop-policy'
import type { ExportRenderJob } from '../src/main/export/types'
import { defaultExportOptions } from '../src/shared/export'
import { identityCrop } from '../src/shared/crop'
import { HDR_JPEG_SOURCE_VERSION } from '../src/shared/hdr'
import { exportFixture, sha, syntheticExportSource } from './export.helpers'
import { cropAdmission } from './crop-frame.helpers'
import { readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'

const reference = JSON.parse(
  readFileSync(resolve('tests/fixtures/export-resize-reference.json'), 'utf8'),
) as {
  generatorSha256: string
  tolerance: { absolute: number; relative: number }
  cases: {
    name: string
    width: number
    height: number
    outWidth: number
    outHeight: number
    channels: number
    input: number[]
    expected: number[]
  }[]
}
const previous = process.env.IRODORI_EXPORT_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_EXPORT_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = previous
})

for (const vector of reference.cases)
  test(`linear Lanczos3 matches independent Decimal80 2D convolution: ${vector.name}`, async () => {
    expect(sha(await readFile('scripts/research/export-resize-reference.py'))).toBe(
      reference.generatorSha256,
    )
    const path = test.info().outputPath('input.f32'),
      input = new Float32Array(vector.input),
      output = new Float32Array(vector.expected.length)
    await writeFile(path, Buffer.from(input.buffer))
    let rows = 0
    await resizeLinear(
      path,
      vector.width,
      vector.height,
      vector.outWidth,
      vector.outHeight,
      vector.channels,
      (row, y) => {
        expect(y).toBe(rows++)
        output.set(row, y * vector.outWidth * vector.channels)
      },
    )
    expect(rows).toBe(vector.outHeight)
    for (let i = 0; i < output.length; i++)
      expect(Math.abs(output[i] - vector.expected[i]), `sample ${i}`).toBeLessThanOrEqual(
        reference.tolerance.absolute + reference.tolerance.relative * Math.abs(vector.expected[i]),
      )
    if (vector.name === 'identity') expect(output).toEqual(input)
    if (vector.name === 'constant')
      expect(output.every((value) => Math.abs(value - input[0]) < 2e-7)).toBe(true)
    expect(await readFile(path)).toEqual(Buffer.from(input.buffer))
  })

test('real queued enlargement freezes options across later edits, foreground retry and saved preferences', async () => {
  const f = await exportFixture(1),
    id = f.photos[0].id,
    path = join(f.root, 'library', 'originals', id, 'original.png'),
    original = await readFile(path),
    worker = new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    ),
    renderer = Reflect.get(f.library.exports, 'renderer') as Pick<ExportProcess, 'render'>,
    attempts: ExportRenderJob[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  renderer.render = async (job, signal, progress) => {
    attempts.push(structuredClone(job))
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener('abort', aborted)
        reject(signal.reason)
      }
      signal.addEventListener('abort', aborted, { once: true })
      void held.then(() => {
        signal.removeEventListener('abort', aborted)
        resolve()
      })
      if (signal.aborted) aborted()
    })
    signal.throwIfAborted()
    return worker.render(job, signal, progress)
  }
  f.library.cropAdmission = async () => cropAdmission()
  const options = {
    ...defaultExportOptions,
    metadata: 'none' as const,
    size: {
      mode: 'longest' as const,
      edge: 34,
      allowEnlargement: true,
      method: 'lanczos3' as const,
    },
  }
  try {
    const preparation = await f.library.prepareExport([id]),
      grant = await f.library.exports.store.authorize(f.destination),
      jobId = await f.library.startExport({
        preparationId: preparation.id,
        destinationId: grant.id,
        action: 'custom',
        options,
      })
    options.size.edge = 99
    options.size.allowEnlargement = false
    await expect.poll(() => attempts.length).toBe(1)
    await f.library.updateEdits(id, { exposureEv: 2 }, 0)
    release()
    await expect
      .poll(() => f.library.listTasks().find((task) => task.id === jobId)?.finishedAt)
      .toBeTruthy()
    expect(f.library.exports.errors(jobId)).toEqual({ errors: [], total: 0 })
    expect(f.library.exports.results(jobId).results[0].status).toBe('exported')
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    for (const attempt of attempts) {
      expect(attempt.options.size).toEqual({
        mode: 'longest',
        edge: 34,
        allowEnlargement: true,
        method: 'lanczos3',
      })
      expect(attempt.source.processing.revision).toBe(0)
      expect(attempt.resizePolicy).toEqual(exportResizePolicy)
      expect(attempt.resizeAdmission).toBeDefined()
    }
    const info = await sharp(join(f.destination, 'Photo-0.jpg')).metadata()
    expect([info.width, info.height]).toEqual([34, 22])
    expect((await f.library.getExportPreferences()).lastCustom!.size).toMatchObject({ edge: 34 })
    expect(f.library.exports.store.jobs()[0].manifest.pipeline.resize).toEqual(exportResizePolicy)
    expect(await readFile(path)).toEqual(original)
  } finally {
    release()
    await f.close()
  }
})

test('crop-aware enlargement keeps authored HDR and primary independent through actual ISO JPEG reconstruction', async () => {
  const root = test.info().outputPath('paired')
  await mkdir(root)
  const source = await syntheticExportSource(root, 8, 6, () => [3, 2, 1]),
    working = source.processing.workingAsset!,
    original = await readFile(working.path),
    path = join(root, 'authored-primary.png'),
    primary = await sharp({
      create: { width: 8, height: 6, channels: 3, background: { r: 100, g: 140, b: 180 } },
    })
      .png()
      .toBuffer()
  await writeFile(path, primary)
  source.path = path
  working.hdr!.source.version = HDR_JPEG_SOURCE_VERSION
  working.hdr!.source.display = {
    encoding: 'iso-21496-1-jpeg',
    referenceWhiteNits: 203,
    headroom: 3,
  }
  source.processing.crop = {
    ...identityCrop,
    quarterTurns: 1,
    width: 4 / 6,
    height: 6 / 8,
  }
  const admission = cropAdmission()
  for (const [quality, tolerance] of [
    [100, 0.03],
    [90, 0.05],
    [80, 0.1],
  ]) {
    const directory = join(root, String(quality))
    await mkdir(directory)
    const job: ExportRenderJob = {
      source,
      directory,
      hdr: true,
      options: {
        ...defaultExportOptions,
        metadata: 'none',
        quality,
        size: { mode: 'longest', edge: 15, allowEnlargement: true, method: 'lanczos3' },
      },
      cropPolicy: { ...exportCropPolicy },
      cropAdmission: admission,
      resizePolicy: { ...exportResizePolicy },
      resizeAdmission: admission,
    }
    const result = await renderExport(job),
      bytes = await readFile(result.path),
      parsed = readGainJpeg(bytes),
      ordinary = await sharp(parsed.primary)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      gain = await sharp(parsed.gain, { ignoreIcc: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    expect([ordinary.info.width, ordinary.info.height]).toEqual([10, 15])
    expect([gain.info.width, gain.info.height]).toEqual([10, 15])
    expect(result.diagnostics!.resize).toEqual({
      policy: exportResizePolicy,
      input: { width: 4, height: 6 },
      output: { width: 10, height: 15 },
      enlarged: true,
    })
    expect(ordinary.data).toEqual(
      await sharp(join(directory, 'sdr.jpg')).removeAlpha().raw().toBuffer(),
    )
    for (let i = 0; i < 150; i++) {
      const base = to2020([0, 1, 2].map((c) => srgbLinear(ordinary.data[i * 3 + c] / 255))),
        map = [0, 1, 2].map((c) => gain.data[i * 3 + c] / 255),
        actual = reconstruct(base, map, parsed.metadata, 10)
      for (let c = 0; c < 3; c++)
        expect(Math.abs(actual[c] - [3, 2, 1][c]) / [3, 2, 1][c]).toBeLessThan(tolerance)
    }
  }
  expect(await readFile(path)).toEqual(primary)
  expect(await readFile(working.path)).toEqual(original)
})

test('enlargement refuses missing policy, resource admission and insufficient budgets without publication', async () => {
  const f = await exportFixture(1),
    worker = new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    ),
    renderer = Reflect.get(f.library.exports, 'renderer') as Pick<ExportProcess, 'render'>
  let captured: ExportRenderJob | undefined
  renderer.render = async (job, signal) => {
    captured = structuredClone(job)
    await expect(worker.render({ ...job, resizePolicy: undefined }, signal)).rejects.toThrow(
      'resize policy',
    )
    await expect(worker.render({ ...job, resizeAdmission: undefined }, signal)).rejects.toThrow(
      'resource admission',
    )
    return worker.render(job, signal)
  }
  f.library.cropAdmission = async () => {
    const a = cropAdmission()
    Object.assign(a.policy.ram, { effectiveBytes: 0 })
    return a
  }
  try {
    const preparation = await f.library.prepareExport([f.photos[0].id]),
      grant = await f.library.exports.store.authorize(f.destination),
      jobId = await f.library.startExport({
        preparationId: preparation.id,
        destinationId: grant.id,
        action: 'custom',
        options: {
          ...defaultExportOptions,
          metadata: 'none',
          size: { mode: 'longest', edge: 34, allowEnlargement: true },
        },
      })
    await expect
      .poll(() => f.library.listTasks().find((task) => task.id === jobId)?.finishedAt)
      .toBeTruthy()
    expect(captured).toBeDefined()
    expect(f.library.exports.errors(jobId).errors[0].message).toContain(
      'frozen managed image budgets',
    )
    expect(await readdir(f.destination)).toEqual([])
  } finally {
    await f.close()
  }
})
