import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { expect, test as base } from '@playwright/test'
import { librawDecoder } from '../src/main/processing/decoders/libraw'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { neutralAdjustments } from '../src/shared/adjustments'
import { PreviewEngine } from '../src/main/preview-engine'
import { readHdrStrips, scanHdr } from '../src/main/processing/hdr-processing'
import { mkdir, mkdtemp, rm, readdir, chmod, stat, writeFile, readFile } from 'node:fs/promises'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import { noLensSettings } from '../src/shared/lens'
import { correctionPlan } from '../src/main/processing/lens-correction'
import { unavailableProfile } from '../src/main/processing/metadata'
import { SDR_TARGET } from '../src/shared/hdr'

// Only the two read-only correction checks share preparation. Cold decoding,
// cache recovery/cancellation and CPU references below always remain fresh.
const test = base.extend<
  object,
  {
    correctedHdr: {
      output: string
      result: Awaited<ReturnType<PreviewEngine['renderFull']>>
    }
  }
>({
  correctedHdr: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
    async ({}, use) => {
      const output = await mkdtemp(join(tmpdir(), 'luma-hdr-corrected-'))
      const engine = new PreviewEngine()
      try {
        const path = 'tests/fixtures/sony-zv1.ARW',
          metadata = await engine.inspect(path)
        const result = await engine.renderFull(path, output, undefined, {
          metadata,
          settings: { distortion: true, vignetting: true, chromaticAberration: true },
          revision: 0,
          processing: 'hdr-v1',
          adjustments: neutralAdjustments,
        })
        expect(result.diagnostics?.backend, JSON.stringify(result.diagnostics)).toBe('gpu')
        await engine.close()
        for (const file of await readdir(output)) await chmod(join(output, file), 0o444)
        await use(Object.freeze({ output, result: Object.freeze(result) }))
      } finally {
        await engine.close()
        await rm(output, { recursive: true, force: true })
      }
    },
    { scope: 'worker', timeout: 120000 },
  ],
})

const samples: string[] = [
  'tests/fixtures/sony-zv1.ARW',
  ...JSON.parse(process.env.LUMA_RAW_TEST_FILES ?? '[]'),
]
for (const sample of samples)
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
  test(`HDR GPU AHD agrees with unclipped LibRaw camera RGB: ${basename(sample)}`, async ({}, info) => {
    test.setTimeout(120000)
    const session = await librawDecoder.open(sample)
    const gpu = new RawGpuRenderer()
    try {
      expect(session.metadata.hdrEligible).toBe(true)
      session.unpack()
      const source = session.gpuSource(true)!
      const actual = (await gpu.render(source, undefined, neutralAdjustments, false, true)).working!
      const reference = session.linear(true)
      expect(source.normalization).toEqual(reference.normalization)
      let sum = 0,
        large = 0,
        max = 0,
        above = 0
      for (let i = 0; i < reference.data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          const error = Math.abs(actual.data[i + c] - reference.data[i + c])
          sum += error
          max = Math.max(max, error)
          large += Number(error > 64 / 65535)
          above += Number(reference.data[i + c] * reference.normalization!.restoreGain > 1)
        }
      const count = reference.width * reference.height * 3
      console.log({
        mean: sum / count,
        largeFraction: large / count,
        max,
        above,
        normalization: source.normalization,
      })
      await writeFile(
        info.outputPath('normalization.json'),
        JSON.stringify(
          {
            sample: basename(sample),
            sha256: createHash('sha256')
              .update(await readFile(sample))
              .digest('hex'),
            normalization: source.normalization,
            metadata: session.metadata,
            mean: sum / count,
            largeFraction: large / count,
            max,
            above,
          },
          null,
          2,
        ),
      )
      expect(sum / count).toBeLessThanOrEqual(4 / 65535)
      expect(large / count).toBeLessThanOrEqual(0.001)
      if (sample === 'tests/fixtures/sony-zv1.ARW') expect(above).toBeGreaterThan(0)
    } finally {
      session.close()
      gpu.close()
    }
  })

test('HDR lens preparation streams validated working data and an SDR proof', async ({
  correctedHdr,
}, info) => {
  test.setTimeout(120000)
  const { output, result } = correctedHdr
  const asset = result.linear!.hdr!
  expect(asset.source.highlightBlend).toBe('sensor-blend-v1')
  expect(result.renderId).toContain('sensor-blend-v1')
  await writeFile(info.outputPath('working-descriptor.json'), JSON.stringify(asset, null, 2))
  expect((await stat(`${output}/linear.f32`)).size).toBe(asset.byteLength)
  let above = 0,
    negative = 0
  for await (const data of readHdrStrips(`${output}/linear.f32`, asset))
    for (let i = 0; i < data.length; i += 4)
      for (let c = 0; c < 3; c++) {
        above += Number(data[i + c] > 1)
        negative += Number(data[i + c] < 0)
      }
  expect(above).toBeGreaterThan(0)
  expect(negative).toBeGreaterThan(0)
  const statistics = await scanHdr(`${output}/linear.f32`, {
    asset,
    adjustments: neutralAdjustments,
    domain: 'working-hdr',
    target: SDR_TARGET,
  })
  const count = Math.min(65536, asset.width * asset.height),
    sampled = new Float32Array(count * 4)
  let next = 0,
    offset = 0
  for await (const data of readHdrStrips(`${output}/linear.f32`, asset)) {
    while (next < count) {
      const position = Math.floor(((next + 0.5) * asset.width * asset.height) / count)
      if (position >= offset + data.length / 4) break
      sampled.set(data.subarray((position - offset) * 4, (position - offset) * 4 + 4), next++ * 4)
    }
    offset += data.length / 4
  }
  const approximate = hdrStatistics('working-hdr', SDR_TARGET, asset, false)
  analyzeHdr(sampled, neutralAdjustments, asset, SDR_TARGET, approximate)
  let actualCdf = 0,
    approximateCdf = 0,
    maximumCdfError = 0
  for (let bin = 0; bin < 256; bin++) {
    actualCdf += statistics.bins[bin] / statistics.visiblePixels
    approximateCdf += approximate.bins[bin] / approximate.visiblePixels
    maximumCdfError = Math.max(maximumCdfError, Math.abs(actualCdf - approximateCdf))
  }
  expect(maximumCdfError).toBeLessThanOrEqual(0.01)
  expect(statistics.visiblePixels).toBe(asset.width * asset.height)
  expect(
    statistics.bins.reduce((a, b) => a + b, 0) +
      statistics.zero +
      statistics.negative +
      statistics.underflow +
      statistics.overflow,
  ).toBe(statistics.visiblePixels)
  console.log({
    width: result.width,
    height: result.height,
    above,
    negative,
    diagnostics: result.diagnostics,
  })
})

test('CPU HDR preparation keeps signed highlights and agrees with GPU corrected working data', async ({
  correctedHdr,
}, info) => {
  test.setTimeout(180000)
  const cpu = new PreviewEngine(undefined, 'cpu')
  const path = 'tests/fixtures/sony-zv1.ARW',
    cpuPath = info.outputPath('cpu'),
    gpuPath = correctedHdr.output
  await mkdir(cpuPath)
  try {
    const metadata = await cpu.inspect(path)
    const options = {
      metadata,
      settings: { distortion: true, vignetting: true, chromaticAberration: true },
      revision: 0,
      processing: 'hdr-v1' as const,
      adjustments: neutralAdjustments,
    }
    const a = await cpu.renderFull(path, cpuPath, undefined, options)
    const b = correctedHdr.result
    expect(a.diagnostics?.backend).toBe('cpu')
    expect([a.width, a.height]).toEqual([b.width, b.height])
    expect(a.linear!.hdr!.source.normalization).toEqual(b.linear!.hdr!.source.normalization)
    const reference = readHdrStrips(`${cpuPath}/linear.f32`, a.linear!.hdr!)
    let sum = 0,
      count = 0,
      above = 0,
      negative = 0
    for await (const data of readHdrStrips(`${gpuPath}/linear.f32`, b.linear!.hdr!)) {
      const expected = (await reference.next()).value!
      for (let i = 0; i < data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          sum += Math.abs(data[i + c] - expected[i + c])
          count++
          above += Number(expected[i + c] > 1)
          negative += Number(expected[i + c] < 0)
        }
    }
    expect((await reference.next()).done).toBe(true)
    // Demosaic differences precede gain restoration and bicubic lens interpolation.
    expect(sum / count).toBeLessThanOrEqual(0.002)
    expect(above).toBeGreaterThan(0)
    expect(negative).toBeGreaterThan(0)
    console.log({ correctedMeanError: sum / count, above, negative })
  } finally {
    await cpu.close()
  }
})

test('unsaturated Bayer sites survive integer AHD boundaries above common reference white', async () => {
  const session = await librawDecoder.open('tests/fixtures/sony-zv1.ARW'),
    gpu = new RawGpuRenderer()
  try {
    session.unpack()
    const real = session.gpuSource(true)!,
      width = 64,
      height = 64
    const source = {
      ...real,
      width,
      height,
      rawWidth: width,
      left: 0,
      top: 0,
      flip: 0,
      pixels: new Uint16Array(width * height),
    }
    const level = Math.floor(real.normalization!.maximum * 0.9)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        source.pixels[y * width + x] = level + real.black[real.cfa[(y % 2) * 2 + (x % 2)]]
    const actual = (await gpu.render(source, undefined, neutralAdjustments, false, true)).working!
      .data
    for (let c = 0; c < 3; c++) {
      const expected = Math.trunc(level * source.scale[c]) / 65535
      expect(Math.abs(actual[(32 * width + 32) * 4 + c] - expected)).toBeLessThanOrEqual(2 / 65535)
    }
    expect(actual[(32 * width + 32) * 4] * source.normalization!.restoreGain).toBeGreaterThan(2)
  } finally {
    session.close()
    gpu.close()
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('direct HDR cache has no SDR proof, reuses edits, validates restart and protects removal leases', async ({}, info) => {
  test.setTimeout(120000)
  const { FullPreviews } = await import('../src/main/full-previews')
  const { randomUUID } = await import('node:crypto')
  const { join } = await import('node:path')
  const { readdir } = await import('node:fs/promises')
  const id = 'f'.repeat(64),
    source = 'tests/fixtures/sony-zv1.ARW',
    root = info.outputPath('direct-cache')
  let engine = new PreviewEngine()
  const metadata = await engine.inspect(source)
  const options = {
    metadata,
    settings: { distortion: true, vignetting: true, chromaticAberration: true },
    revision: 0,
    processing: 'hdr-v1' as const,
    adjustments: { ...neutralAdjustments },
  }
  const create = () =>
    new FullPreviews(
      root,
      (key) => (key === id || key === 'e'.repeat(64) ? source : undefined),
      {
        renderFull: (path, output, _signal, options) =>
          engine.renderFull(path, output, undefined, options),
        close: () => engine.close(),
      },
      undefined,
      async () => ({ ...options }),
    )
  let cache = create()
  try {
    await cache.open()
    const first = (await cache.requestHdr(id, randomUUID()))!
    expect(first.format).toBe('hdr-working')
    expect(cache.getDiagnostics().cacheHit).toBe(false)
    const proof = await cache.request('e'.repeat(64), randomUUID())
    const proofSource = (await cache.requestHdr('e'.repeat(64), randomUUID()))!
    expect(proofSource.format).toBe('hdr-working')
    expect(proofSource.linear.url).toBe(proof.linear!.url)
    expect(proofSource.sha256).toBe(proof.linear!.sha256)
    expect(cache.getDiagnostics().cacheHit).toBe(true)
    const lease = cache.acquire(new URL(first.linear.url))!
    expect((await readdir(join(lease.path, '..'))).sort()).toEqual(['entry.json', 'linear.f32'])
    const path = lease.path
    lease.release()
    options.revision++
    options.adjustments.exposureEv = 1
    cache.settingsChanged(id)
    const edited = (await cache.requestHdr(id, randomUUID()))!
    expect(edited.linear.url).toBe(first.linear.url)
    expect(edited.settingsRevision).toBe(1)
    expect(edited.adjustments?.exposureEv).toBe(1)
    expect(cache.getDiagnostics().cacheHit).toBe(true)
    await cache.close()
    engine = new PreviewEngine()
    cache = create()
    await cache.open()
    expect((await cache.requestHdr(id, randomUUID()))!.linear.url).toBe(first.linear.url)
    await cache.close()
    await writeFile(path, Buffer.alloc(first.linear.byteLength))
    engine = new PreviewEngine()
    cache = create()
    await cache.open()
    const rebuilt = (await cache.requestHdr(id, randomUUID()))!
    expect(rebuilt.linear.url).not.toBe(first.linear.url)
    const stream = cache.acquire(new URL(rebuilt.linear.url))!
    await cache.beginRemoval(id)
    cache.endRemoval(id, true)
    expect(cache.acquire(new URL(rebuilt.linear.url))).toBeUndefined()
    expect((await stat(stream.path)).size).toBe(rebuilt.linear.byteLength)
    stream.release()
    await cache.release()
  } finally {
    await cache.close()
  }
})

test('changing scene content cannot normalize RAW capture exposure', async () => {
  const session = await librawDecoder.open('tests/fixtures/sony-zv1.ARW'),
    gpu = new RawGpuRenderer()
  try {
    session.unpack()
    const real = session.gpuSource(true)!,
      width = 96,
      height = 96
    const values: number[][] = []
    for (const background of [0.001, 0.9]) {
      const source = {
        ...real,
        width,
        height,
        rawWidth: width,
        left: 0,
        top: 0,
        flip: 0,
        normalization: structuredClone(real.normalization!),
        pixels: new Uint16Array(width * height),
      }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const c = real.cfa[(y % 2) * 2 + (x % 2)],
            fixed = x >= 32 && x < 64 && y >= 32 && y < 64
          source.pixels[y * width + x] =
            real.black[c] + Math.floor(real.normalization!.maximum * (fixed ? 0.1 : background))
        }
      const result = await gpu.render(
        source,
        correctionPlan(width, height, unavailableProfile, noLensSettings),
        neutralAdjustments,
        true,
      )
      expect(result.hdrPrepared).toBe(true)
      expect(source.normalization.referenceWhite).toBe(1)
      expect(source.normalization.maximum).toBe(real.normalization!.maximum)
      values.push(
        Array.from(result.working!.data.slice((48 * width + 48) * 4, (48 * width + 48) * 4 + 4)),
      )
      gpu.releaseFrame()
    }
    expect(values[0]).toEqual(values[1])
  } finally {
    session.close()
    gpu.close()
  }
})
