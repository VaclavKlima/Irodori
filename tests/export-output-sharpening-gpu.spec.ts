/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { exportRenditions } from '../src/main/export/renditions'
import { ExportProcess } from '../src/main/export/process'
import { PreviewProcess } from '../src/main/preview-process'
import { sharpenOutputRenditions } from '../src/main/export/output-sharpening'
import { exportOutputSharpeningPolicy } from '../src/main/export/output-sharpening-policy'
import { exportResizePolicy } from '../src/main/export/resize-policy'
import type { ExportRenderJob, ExportSource } from '../src/main/export/types'
import { createSpatialDetailGpu } from '../src/main/gpu/spatial-detail'
import { defaultExportOptions } from '../src/shared/export'
import { neutralAdjustments } from '../src/shared/adjustments'
import { outputSharpeningMode, resolveOutputSharpening } from '../src/shared/output-sharpening'
import { compileDetailSharpening, sharpenDetailTile } from '../src/shared/spatial-detail'
import { processingMetadata } from '../src/main/processing/metadata'
import { automaticLensSettings } from '../src/shared/lens'
import { cropAdmission } from './crop-frame.helpers'
import { syntheticExportSource, sha } from './export.helpers'
import { fromHalf } from './export-reference'
import { resizeLinear } from './export-resize-reference'
import type { DetailReference } from './spatial-detail.helpers'
import { proofFixture } from './export-proof.helpers'
import { readGainJpeg } from './export-reference'

function paired(data: Float32Array) {
  const result = new Float32Array((data.length / 4) * 6)
  for (let i = 0; i < data.length / 4; i++) {
    result.set(data.subarray(i * 4, i * 4 + 3), i * 6)
    result.set(data.subarray(i * 4, i * 4 + 3), i * 6 + 3)
  }
  return result
}
async function filter(
  path: string,
  width: number,
  height: number,
  mode: 'low' | 'standard' | 'high',
) {
  const output = {
    sdr: new Float32Array(width * height * 4),
    hdr: new Float32Array(width * height * 4),
  }
  const diagnostics = await sharpenOutputRenditions(
    path,
    width,
    height,
    6,
    mode,
    cropAdmission(),
    0,
    (band, top, rendition) => output[rendition].set(band, top * width * 4),
  )
  for (const pass of diagnostics.passes) {
    expect(pass).toMatchObject({ backend: 'gpu', cpuTiles: 0, precisionRecoveryTiles: 0 })
    expect(pass.adapter).toBeTruthy()
    expect(pass.adapter).not.toMatch(/llvmpipe|swiftshader|software/i)
    expect(pass.maxSourceStrips).toBeLessThanOrEqual(3)
    test.info().annotations.push({ type: 'gpu-adapter', description: pass.adapter! })
  }
  return { output, diagnostics }
}

test('final-output Standard matches the existing independent Decimal80 SDR and HDR sharpening points', async ({}, info) => {
  const reference = JSON.parse(
    await readFile('tests/fixtures/detail-reference.json', 'utf8'),
  ) as DetailReference
  let checked = 0,
    maximum = 0
  for (const scene of reference.scenes.filter((s) => s.data.every((pixel) => pixel[3] === 1))) {
    const input = new Float32Array(scene.data.flat()),
      path = info.outputPath(`${scene.name}.f32`),
      bytes = Buffer.from(paired(input).buffer)
    await writeFile(path, bytes)
    const { output } = await filter(path, scene.width, scene.height, 'standard')
    for (const primaries of ['srgb', 'rec2020'] as const) {
      const entry = scene.cases.find(
        (c) =>
          c.operation === 'sharpen' &&
          c.primaries === primaries &&
          'amount' in c.settings &&
          c.settings.amount === 50 &&
          c.settings.radius === 1 &&
          c.settings.threshold === 50,
      )!
      for (const point of entry.points)
        for (let c = 0; c < 3; c++) {
          const expected = point.output[c],
            actual =
              output[primaries === 'srgb' ? 'sdr' : 'hdr'][
                (point.y * scene.width + point.x) * 4 + c
              ]
          maximum = Math.max(
            maximum,
            Math.abs(actual - expected) / (2e-6 + 2e-5 * Math.abs(expected)),
          )
          checked++
        }
    }
    expect(await readFile(path)).toEqual(bytes)
  }
  expect(checked).toBeGreaterThan(100)
  expect(maximum).toBeLessThanOrEqual(1)
})

test('all preset strengths preserve frozen flat-noise bounds against the independent clean chart', async ({}, info) => {
  const reference = JSON.parse(await readFile('tests/fixtures/detail-quality.json', 'utf8')) as {
      coefficients: { srgb: number[] }
      cases: {
        name: string
        width: number
        height: number
        entering: number[][]
        cleanFeatures: number[][]
        enteringFeatures: number[][]
      }[]
    },
    scene = reference.cases.find((s) => s.name === 'flat-luminance')!,
    path = info.outputPath('noise.f32'),
    indices = Array.from(
      { length: (scene.width - 8) * (scene.height - 8) },
      (_, i) => (Math.floor(i / (scene.width - 8)) + 4) * scene.width + (i % (scene.width - 8)) + 4,
    ),
    rms = (values: number[]) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length),
    entering = rms(indices.map((i) => scene.enteringFeatures[i][0] - scene.cleanFeatures[i][0]))
  await writeFile(path, Buffer.from(paired(new Float32Array(scene.entering.flat())).buffer))
  let previous = 1
  for (const mode of ['low', 'standard', 'high'] as const) {
    const { output } = await filter(path, scene.width, scene.height, mode),
      actual = output.sdr,
      [r, g, b] = reference.coefficients.srgb,
      gain =
        rms(
          indices.map(
            (i) =>
              Math.asinh(
                (actual[i * 4] * r + actual[i * 4 + 1] * g + actual[i * 4 + 2] * b) / 0.18,
              ) - scene.cleanFeatures[i][0],
          ),
        ) / entering
    expect(gain).toBeLessThanOrEqual(1.1)
    expect(gain).toBeGreaterThan(previous)
    previous = gain
  }
})

test('output filtering preserves halos, flat fields and tile seams at 100% in both output domains', async ({}, info) => {
  const width = 259,
    height = 131,
    image = { width, height },
    tile = { left: 0, top: 0, ...image },
    source = new Float32Array(width * height * 4),
    path = info.outputPath('tile-boundaries.f32')
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = x < 256 ? 0.1 : 0.8
      source.set([value, value, value, 1], (y * width + x) * 4)
    }
  const interleaved = paired(source)
  for (let i = 0; i < width * height; i++) for (let c = 3; c < 6; c++) interleaved[i * 6 + c] *= 16
  await writeFile(path, Buffer.from(interleaved.buffer))
  const { output, diagnostics } = await filter(path, width, height, 'high')
  expect(diagnostics.passes.every((p) => p.gpuTiles === 6)).toBe(true)
  for (const rendition of ['sdr', 'hdr'] as const) {
    const scale = rendition === 'sdr' ? 1 : 16,
      original = source.slice()
    for (let i = 0; i < original.length; i++) if (i % 4 !== 3) original[i] *= scale
    const expected = sharpenDetailTile(
      image,
      tile,
      { ...tile, data: original },
      compileDetailSharpening(resolveOutputSharpening({ outputSharpening: 'high' })),
      rendition === 'sdr' ? 'srgb' : 'rec2020',
    )
    let error = 0,
      halo = 0,
      outside = 0
    for (let i = 0; i < expected.length; i++) {
      error = Math.max(
        error,
        Math.abs(output[rendition][i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i])),
      )
      if (i % 4 === 3) expect(output[rendition][i]).toBe(1)
      else {
        halo = Math.max(
          halo,
          (0.1 * scale - output[rendition][i]) / (0.7 * scale),
          (output[rendition][i] - 0.8 * scale) / (0.7 * scale),
        )
        if (Math.floor(i / 4) % width < 253)
          outside = Math.max(outside, Math.abs(output[rendition][i] - original[i]))
      }
    }
    expect(error).toBeLessThanOrEqual(1)
    expect(halo).toBeLessThanOrEqual(0.05)
    expect(outside).toBe(0)
  }
})

test('native and resized HDR exports sharpen each final rendition once before quantization and preserve originals', async ({}, info) => {
  const root = info.outputPath('order')
  await mkdir(root)
  const source = await syntheticExportSource(root, 64, 32, (x, y) => {
      const value = 0.2 + 0.1 * Math.tanh((x - 31.5) / 2) + 0.04 * Math.sin(x * 1.2 + y * 0.7)
      return [value * 8, value * 3, value]
    }),
    original = await readFile(source.path)
  for (const edge of [64, 32]) {
    const directory = join(root, String(edge))
    await mkdir(directory)
    const job: ExportRenderJob = {
        source,
        directory,
        hdr: true,
        options: {
          ...defaultExportOptions,
          outputSharpening: 'standard',
          size: { mode: 'longest', edge },
        },
        outputSharpeningPolicy: { ...exportOutputSharpeningPolicy },
        outputSharpeningAdmission: cropAdmission(),
        resizePolicy: { ...exportResizePolicy },
        resizeAdmission: cropAdmission(),
      },
      result = await exportRenditions(job),
      { width, height } = result.geometry,
      planes = {
        sdr: new Float32Array(width * height * 4),
        hdr: new Float32Array(width * height * 4),
      }
    await resizeLinear(join(directory, 'rendition.f32'), 64, 32, width, height, 6, (row, y) => {
      for (let x = 0; x < width; x++)
        for (const [rendition, offset] of [
          ['sdr', 0],
          ['hdr', 3],
        ] as const) {
          planes[rendition].set(
            row.subarray(x * 6 + offset, x * 6 + offset + 3),
            (y * width + x) * 4,
          )
          planes[rendition][(y * width + x) * 4 + 3] = 1
        }
    })
    let changed = 0,
      differenceFromTwice = 0,
      peak = 1.01
    for (const rendition of ['sdr', 'hdr'] as const) {
      const image = { width, height },
        tile = { left: 0, top: 0, ...image },
        settings = compileDetailSharpening(resolveOutputSharpening(job.options)),
        expected = sharpenDetailTile(
          image,
          tile,
          { ...tile, data: planes[rendition] },
          settings,
          rendition === 'sdr' ? 'srgb' : 'rec2020',
        ),
        twice = sharpenDetailTile(
          image,
          tile,
          { ...tile, data: expected },
          settings,
          rendition === 'sdr' ? 'srgb' : 'rec2020',
        )
      for (let i = 0; i < width * height; i++)
        for (let c = 0; c < 3; c++) {
          const at = i * 4 + c,
            value = Math.max(0, Math.min(rendition === 'sdr' ? 1 : 10, expected[at]))
          changed += Number(Math.abs(expected[at] - planes[rendition][at]) > 0.0001)
          differenceFromTwice = Math.max(differenceFromTwice, Math.abs(expected[at] - twice[at]))
          if (rendition === 'sdr') {
            const code = Math.round(
              (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255,
            )
            expect(Math.abs(result.rgb[i * 3 + c] - code)).toBeLessThanOrEqual(1)
          } else {
            expect(Math.abs(fromHalf(result.half![at]) - value)).toBeLessThanOrEqual(0.004)
            peak = Math.max(peak, value)
          }
        }
    }
    expect(changed).toBeGreaterThan(100)
    expect(differenceFromTwice).toBeGreaterThan(0.0001)
    expect(result.contentHeadroom).toBeCloseTo(peak, 4)
    expect(result.earlyPrimary).toBeUndefined()
    expect(result.diagnostics.outputSharpening).toMatchObject({
      mode: 'standard',
      radius: 1,
      amount: 50,
      width,
      height,
    })
    expect(result.diagnostics.outputSharpening!.passes.map((p) => p.rendition)).toEqual([
      'sdr',
      'hdr',
    ])
    expect(await readdir(directory)).not.toContain('output-sharpening.f32')
  }
  expect(await readFile(source.path)).toEqual(original)
})

test('GPU failure and cancellation close the output owner and preserve input without a CPU substitute', async ({}, info) => {
  const path = info.outputPath('failure.f32'),
    input = Buffer.from(new Float32Array(8 * 8 * 6).fill(0.2).buffer)
  await writeFile(path, input)
  let owners = 0,
    closes = 0,
    accepted = 0
  const failure = new Error('Injected output GPU device loss.'),
    factory: typeof createSpatialDetailGpu = () => {
      owners++
      return {
        adapter: undefined,
        bytes: 0,
        allocatedBytes: 0,
        programCount: 0,
        precisionRecoveryTiles: 0,
        async render() {
          throw failure
        },
        async close() {
          closes++
        },
      }
    }
  await expect(
    sharpenOutputRenditions(
      path,
      8,
      8,
      6,
      'high',
      cropAdmission(),
      0,
      () => accepted++,
      undefined,
      factory,
    ),
  ).rejects.toBe(failure)
  expect({ owners, closes, accepted }).toEqual({ owners: 1, closes: 1, accepted: 0 })
  const abort = new AbortController()
  abort.abort(new Error('Cancelled output sharpening.'))
  await expect(
    sharpenOutputRenditions(
      path,
      8,
      8,
      6,
      'high',
      cropAdmission(),
      0,
      () => accepted++,
      abort.signal,
      factory,
    ),
  ).rejects.toThrow('Cancelled output sharpening')
  expect(owners).toBe(1)
  expect(await readFile(path)).toEqual(input)
})

test('a committed photograph retains Off pixels and applies GPU output sharpening only to the resized export', async ({}, info) => {
  const path = resolve('tests/fixtures/photos/alpine-lake.jpg'),
    original = await readFile(path),
    metadata = await sharp(path).metadata(),
    stat = await lstat(path),
    source: ExportSource = {
      path,
      hdr: false,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
      photo: {
        id: sha(original),
        filename: 'alpine-lake.jpg',
        format: 'JPEG',
        width: metadata.width!,
        height: metadata.height!,
        bytes: original.length,
        importedAt: '',
        previewSource: 'image',
        previewUrl: '',
        thumbnailUrl: '',
      },
      processing: {
        metadata: processingMetadata({}, []),
        settings: automaticLensSettings,
        adjustments: neutralAdjustments,
        revision: 0,
      },
    },
    results = []
  for (const mode of [undefined, 'off', 'high'] as const) {
    const directory = info.outputPath(mode ?? 'legacy')
    await mkdir(directory)
    const options = {
        ...defaultExportOptions,
        size: { mode: 'longest' as const, edge: 128 },
        ...(mode === undefined ? {} : { outputSharpening: mode }),
      },
      result = await exportRenditions({
        source,
        directory,
        hdr: false,
        options,
        resizePolicy: { ...exportResizePolicy },
        resizeAdmission: cropAdmission(),
        outputSharpeningPolicy: { ...exportOutputSharpeningPolicy },
        outputSharpeningAdmission: cropAdmission(),
      })
    expect(Boolean(result.diagnostics.outputSharpening)).toBe(
      outputSharpeningMode(options) !== 'off',
    )
    results.push(result)
  }
  expect(results[0].rgb).toEqual(results[1].rgb)
  expect(results[2].rgb).not.toEqual(results[0].rgb)
  expect(results[2].diagnostics.outputSharpening!.passes).toHaveLength(1)
  const options = {
      ...defaultExportOptions,
      quality: 100,
      outputSharpening: 'high' as const,
      size: { mode: 'longest' as const, edge: 128 },
    },
    fixture = await proofFixture({ source, real: true })
  try {
    const proof = await fixture.proofs.request('dialog', { ...fixture.request(), options }),
      primary = fixture.proofs.acquire(new URL(proof.primary.url))!
    let actual: Buffer
    try {
      actual = await readFile(primary.path)
    } finally {
      primary.release()
    }
    const directory = info.outputPath('actual-export')
    await mkdir(directory)
    const result = await new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      ).render(
        {
          source,
          directory,
          hdr: false,
          options,
          resizePolicy: proof.pipeline.resize,
          resizeAdmission: cropAdmission(),
          outputSharpeningPolicy: proof.pipeline.outputSharpening,
          outputSharpeningAdmission: cropAdmission(),
        },
        new AbortController().signal,
      ),
      expected = await sharp(result.path).toColourspace('srgb').ensureAlpha().raw().toBuffer()
    expect(actual.length).toBe(expected.length)
    let difference = 0
    for (let i = 0; i < actual.length; i++)
      difference = Math.max(difference, Math.abs(actual[i] - expected[i]))
    expect(difference).toBeLessThanOrEqual(2)
    expect(result.diagnostics!.outputSharpening).toMatchObject({
      mode: 'high',
      width: proof.width,
      height: proof.height,
    })
    await fixture.proofs.release('dialog', proof.id)
  } finally {
    await fixture.close()
  }
  expect(await readFile(path)).toEqual(original)
})

test('active output policy and admission are refused before RAW preparation or worker launch', async ({}, info) => {
  const directory = info.outputPath('early-refusal')
  await mkdir(directory)
  const original = await syntheticExportSource(directory, 2, 2, () => [0.1, 0.2, 0.3]),
    source: ExportSource = {
      ...original,
      path: join(directory, 'must-never-open.ARW'),
      processing: {
        metadata: processingMetadata({}, []),
        settings: automaticLensSettings,
        revision: 0,
      },
    },
    job: ExportRenderJob = {
      source,
      directory,
      hdr: true,
      options: { ...defaultExportOptions, outputSharpening: 'standard' },
    },
    exporter = new ExportProcess(
      join(directory, 'must-never-start-worker.js'),
      join(directory, 'must-never-start-decoder.js'),
    )
  await expect(exporter.render(job, new AbortController().signal)).rejects.toThrow(
    'frozen operator and stage policy',
  )
  await expect(
    exporter.render(
      { ...job, outputSharpeningPolicy: { ...exportOutputSharpeningPolicy } },
      new AbortController().signal,
    ),
  ).rejects.toThrow('frozen resource admission')
  await expect(
    exporter.render(
      {
        ...job,
        outputSharpeningPolicy: { filter: 'unknown', stage: 'unknown' },
        outputSharpeningAdmission: cropAdmission(),
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('unsupported')
  expect(await readdir(directory)).toEqual(['master.f32'])
})

test('photographic output sharpening review retains native 768-pixel exports and detail crops', async ({}, info) => {
  test.setTimeout(120000)
  const path = resolve('tests/fixtures/photos/alpine-lake.jpg'),
    original = await readFile(path),
    metadata = await sharp(path).metadata(),
    stat = await lstat(path),
    source: ExportSource = {
      path,
      hdr: false,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
      photo: {
        id: sha(original),
        filename: 'alpine-lake.jpg',
        format: 'JPEG',
        width: metadata.width!,
        height: metadata.height!,
        bytes: original.length,
        importedAt: '',
        previewSource: 'image',
        previewUrl: '',
        thumbnailUrl: '',
      },
      processing: {
        metadata: processingMetadata({}, []),
        settings: automaticLensSettings,
        adjustments: neutralAdjustments,
        revision: 0,
      },
    },
    receipts = []
  let off: Buffer | undefined
  for (const mode of ['off', 'standard', 'high'] as const) {
    const directory = info.outputPath(`review-${mode}`)
    await mkdir(directory)
    const options = {
        ...defaultExportOptions,
        output: 'sdr' as const,
        outputSharpening: mode,
        quality: 100,
        metadata: 'none' as const,
        size: { mode: 'longest' as const, edge: 768 },
      },
      result = await new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      ).render(
        {
          source,
          directory,
          hdr: false,
          options,
          resizePolicy: { ...exportResizePolicy },
          resizeAdmission: cropAdmission(),
          outputSharpeningPolicy: { ...exportOutputSharpeningPolicy },
          outputSharpeningAdmission: cropAdmission(),
        },
        new AbortController().signal,
      ),
      decoded = await sharp(result.path)
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      raw = {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
      },
      imagePath = join(directory, 'decoded-output-native.png'),
      edge = Math.min(192, raw.width, raw.height)
    expect(Math.max(raw.width, raw.height)).toBe(768)
    await sharp(decoded.data, { raw }).png().toFile(imagePath)
    await info.attach(`photograph-${mode}-768-native`, {
      path: imagePath,
      contentType: 'image/png',
    })
    const crops = []
    for (const [name, x, y] of [
      ['mountain', 0.5, 0.25],
      ['water-and-shore', 0.65, 0.75],
    ] as const) {
      const crop = {
          left: Math.max(0, Math.min(raw.width - edge, Math.round(raw.width * x - edge / 2))),
          top: Math.max(0, Math.min(raw.height - edge, Math.round(raw.height * y - edge / 2))),
          width: edge,
          height: edge,
        },
        cropPath = join(directory, `${name}-native.png`)
      await sharp(decoded.data, { raw }).extract(crop).png().toFile(cropPath)
      await info.attach(`photograph-${mode}-${name}-native`, {
        path: cropPath,
        contentType: 'image/png',
      })
      crops.push({ name, ...crop })
    }
    if (mode === 'off') off = decoded.data
    let changed = 0,
      maximumCodeDifference = 0
    for (let i = 0; i < decoded.data.length; i++) {
      const difference = Math.abs(decoded.data[i] - off![i])
      changed += Number(difference !== 0)
      maximumCodeDifference = Math.max(maximumCodeDifference, difference)
    }
    if (mode !== 'off') expect(changed).toBeGreaterThan(0)
    receipts.push({
      mode,
      options,
      resolved: resolveOutputSharpening(options),
      dimensions: raw,
      crops,
      changedChannels: changed,
      maximumCodeDifference,
      diagnostics: result.diagnostics!.outputSharpening ?? null,
    })
  }
  await info.attach('photographic-review-settings', {
    contentType: 'application/json',
    body: JSON.stringify({
      source: source.photo.filename,
      sourceSha256: source.photo.id,
      receipts,
    }),
  })
  expect(await readFile(path)).toEqual(original)
})

test('full-size Sony RAW HDR output sharpens both full-resolution renditions and preserves its original', async ({}, info) => {
  test.setTimeout(300000)
  const path = resolve('tests/fixtures/sony-zv1.ARW'),
    bytes = await readFile(path),
    stat = await lstat(path),
    decoder = new PreviewProcess(resolve('out/main/preview-worker.js'))
  let metadata: Awaited<ReturnType<PreviewProcess['inspect']>>
  try {
    metadata = await decoder.inspect(path, new AbortController().signal)
  } finally {
    await decoder.close(true)
  }
  expect(metadata.hdrEligible).toBe(true)
  const source: ExportSource = {
      path,
      hdr: true,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
      photo: {
        id: sha(bytes),
        filename: 'sony-zv1.ARW',
        format: 'ARW',
        width: 5472,
        height: 3648,
        bytes: bytes.length,
        importedAt: '',
        previewSource: 'decoded',
        previewUrl: '',
        thumbnailUrl: '',
      },
      processing: {
        metadata,
        processing: 'hdr-v1',
        settings: automaticLensSettings,
        adjustments: neutralAdjustments,
        revision: 0,
      },
    },
    directory = info.outputPath('full-size-sony')
  await mkdir(directory)
  const result = await new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    ).render(
      {
        source,
        directory,
        hdr: true,
        options: { ...defaultExportOptions, outputSharpening: 'standard', metadata: 'none' },
        outputSharpeningPolicy: { ...exportOutputSharpeningPolicy },
        outputSharpeningAdmission: cropAdmission(),
      },
      new AbortController().signal,
    ),
    image = await sharp(result.path).metadata(),
    parsed = readGainJpeg(await readFile(result.path)),
    diagnostics = result.diagnostics!.outputSharpening!
  // Automatic lens correction defines the authoritative full-size export geometry.
  expect(image).toMatchObject({ format: 'jpeg', width: 5422, height: 3622 })
  expect(result.diagnostics!.resize).toBeUndefined()
  expect(diagnostics).toMatchObject({
    mode: 'standard',
    width: 5422,
    height: 3622,
    amount: 50,
    radius: 1,
  })
  expect(diagnostics.passes.map((p) => p.rendition)).toEqual(['sdr', 'hdr'])
  expect(
    diagnostics.passes.every((p) => p.backend === 'gpu' && p.gpuTiles > 1000 && p.cpuTiles === 0),
  ).toBe(true)
  expect(parsed.metadata.alternateHeadroom).toBeGreaterThan(0)
  for (const pass of diagnostics.passes)
    info.annotations.push({ type: 'gpu-adapter', description: pass.adapter! })
  expect(sha(await readFile(path))).toBe(sha(bytes))
})
