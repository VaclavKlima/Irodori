/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { test, expect } from '@playwright/test'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import { setup, scan, commit } from './library.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { EXPORT_RENDERING_VERSION, EXPORT_CODEC_VERSION } from '../src/shared/export'
import { DISPLAY_RENDERING_VERSION } from '../src/shared/display-rendering'
import type { ExportDiagnostics } from '../src/main/export/types'
import { ExportProcess } from '../src/main/export/process'
import { jpegIdentity } from '../src/main/export/jpeg'
import { nativeEncoderPath } from '../src/main/export/encoder'
import { verifyUltraHdrBundle } from '../src/main/export/codec'
import { provenance } from '../scripts/research/pipeline/provenance'
import { randomUUID } from 'node:crypto'

const requestedEncoder = process.env.LUMA_EXPORT_BENCHMARK_ENCODER ?? 'auto'
if (!['auto', 'native', 'wasm'].includes(requestedEncoder))
  throw new Error('LUMA_EXPORT_BENCHMARK_ENCODER must be auto, native or wasm when set.')
const expectedEncoder = requestedEncoder === 'auto' ? 'native' : requestedEncoder

let previousEncoder: string | undefined
test.beforeEach(() => {
  previousEncoder = process.env.LUMA_EXPORT_ENCODER
  // Default measurements use application Auto; explicit controls remain isolated.
  if (requestedEncoder === 'auto') delete process.env.LUMA_EXPORT_ENCODER
  else process.env.LUMA_EXPORT_ENCODER = requestedEncoder
})
test.afterEach(() => {
  if (previousEncoder === undefined) delete process.env.LUMA_EXPORT_ENCODER
  else process.env.LUMA_EXPORT_ENCODER = previousEncoder
})

async function benchmarkProvenance() {
  const bundle = resolve('out/main/ultrahdr')
  const executable = expectedEncoder === 'native' ? await nativeEncoderPath(bundle) : undefined
  test.skip(
    expectedEncoder === 'native' && !executable,
    `The native full-size gate requires a checksummed bundled encoder for ${process.platform}-${process.arch}; WASM is a separate explicit benchmark selection.`,
  )
  await verifyUltraHdrBundle(bundle)
  const compiled = (await readdir('out/main', { recursive: true }))
    .filter((file) => /\.(?:js|cjs|mjs)$/.test(file))
    .map((file) => join('out/main', file))
    .sort()
  return {
    ...(await provenance([
      'tests/fixtures/sony-zv1.ARW',
      'tests/export-benchmark.spec.ts',
      'tests/library.helpers.ts',
      'src/main/export/encoder.ts',
      'src/main/export/process.ts',
      'src/main/export/render.ts',
      'src/main/export/renditions.ts',
      'src/main/export/jobs.ts',
      'src/shared/export.ts',
      'src/shared/display-rendering.ts',
      join(bundle, 'SHA256SUMS'),
      join(bundle, 'luma-ultrahdr.wasm'),
      ...(executable ? [executable, join(dirname(executable), 'SHA256SUMS')] : []),
      ...compiled,
    ])),
    build:
      'Production PhotoLibrary export acceptance through isolated compiled decoder/encoder workers, durable publication and scratch cleanup; no Electron presentation measurement.',
    encoderSelection: {
      environment: 'LUMA_EXPORT_BENCHMARK_ENCODER',
      requested: process.env.LUMA_EXPORT_BENCHMARK_ENCODER ?? 'unset (application Auto)',
      expected: expectedEncoder,
      inheritedWorkerMode: process.env.LUMA_EXPORT_ENCODER ?? 'auto',
      bundle,
      executable: executable ?? null,
      fallbackAllowed: false,
    },
    memoryLimitations:
      'Native encoderMemory is helper-process peak RSS; WASM encoderMemory is linear-heap capacity. Neither measures combined Node/helper process peak RSS or total application memory. GPU ownership remains a separate bound.',
  }
}

test('quality 100 original-size HDR export measures acceptance through durable publication', async ({}, info) => {
  test.skip(
    process.env.LUMA_PREVIEW_BENCHMARK !== '1',
    'Run npm run benchmark:export for the isolated hardware benchmark.',
  )
  test.setTimeout(600000)
  const source = await benchmarkProvenance()
  const fixture = await setup(
    undefined,
    undefined,
    new ExportProcess(resolve('out/main/export-worker.js'), resolve('out/main/preview-worker.js')),
  )
  const measurements: {
    series: string
    ms: number
    bytes: number
    diagnostics: ExportDiagnostics
  }[] = []
  const outputPath = info.outputPath('benchmark.json')
  const plannedSamples = { 'fresh-workers': 10, subsequent: 10 }
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  try {
    await writeFile(
      outputPath,
      JSON.stringify({ provenance: source, plannedSamples, measurements }, null, 2),
    )
    const session = await scan(fixture.service, [resolve('tests/fixtures/sony-zv1.ARW')])
    await commit(fixture.service, session)
    const photo = fixture.service.list().photos[0]
    const edits = await fixture.service.getEdits(photo.id)
    await fixture.service.updateEdits(
      photo.id,
      {
        exposureEv: 0.25,
        contrast: 10,
        highlights: -25,
        shadows: 20,
        whites: -15,
        blacks: 5,
        whiteBalance: { mode: 'custom', kelvin: 5800, tint: 8 },
      },
      edits.revision,
    )
    const destination = join(fixture.root, 'destination')
    await mkdir(destination)
    const grant = await fixture.service.exports.store.authorize(destination)
    for (const series of ['fresh-workers', 'subsequent'])
      for (let sample = 0; sample < 10; sample++) {
        const prepared = await fixture.service.prepareExport([photo.id])
        const started = performance.now()
        const id = await fixture.service.startExport({
          preparationId: prepared.id,
          destinationId: grant.id,
          action: 'maximum',
        })
        while (!fixture.service.listTasks().find((task) => task.id === id)?.finishedAt)
          await new Promise<void>((accept) => setTimeout(accept, 5))
        const elapsed = performance.now() - started
        const task = fixture.service.listTasks().find((task) => task.id === id)!
        expect(task.status, JSON.stringify(fixture.service.exports.results(id))).toBe('completed')
        const file = fixture.service.exports.store.files(id)[0]
        await writeFile(
          outputPath,
          JSON.stringify(
            {
              provenance: source,
              plannedSamples,
              measurements,
              latestDiagnostics: file.diagnostics,
            },
            null,
            2,
          ),
        )
        expect(file.diagnostics?.sourceBackend).toBe('gpu')
        expect(file.diagnostics?.renderer, JSON.stringify(file.diagnostics)).toBe('gpu')
        expect(file.diagnostics?.encoder, JSON.stringify(file.diagnostics)).toBe(expectedEncoder)
        expect(file.diagnostics?.encoderFallback, JSON.stringify(file.diagnostics)).toBeUndefined()
        expect(file.diagnostics?.encoderMemory?.kind).toBe(
          expectedEncoder === 'native' ? 'process-rss' : 'wasm-heap',
        )
        expect(file.diagnostics?.encoderMemory?.peakBytes).toBeLessThanOrEqual(2 * 1024 ** 3)
        expect(file.diagnostics?.gpuMemoryBytes).toBeLessThanOrEqual(1024 ** 3)
        expect(file.diagnostics?.retries).toBe(0)
        const path = join(destination, file.outputName!),
          bytes = await readFile(path)
        measurements.push({
          series,
          ms: elapsed,
          bytes: bytes.length,
          diagnostics: file.diagnostics!,
        })
        await writeFile(
          outputPath,
          JSON.stringify({ provenance: source, plannedSamples, measurements }, null, 2),
        )
        const metadata = await sharp(bytes).metadata()
        expect(metadata).toMatchObject({
          width: 5422,
          height: 3622,
          isProgressive: false,
        })
        expect(jpegIdentity(bytes).sampling).toEqual([0x11, 0x11, 0x11])
        await rm(path)
        fixture.service.exports.dismiss(id)
      }
    const p95 = Object.fromEntries(
      ['fresh-workers', 'subsequent'].map((series) => [
        series,
        percentile(measurements.filter((m) => m.series === series).map((m) => m.ms)),
      ]),
    )
    const result = {
      provenance: source,
      plannedSamples,
      fixture: 'sony-zv1.ARW',
      quality: 100,
      size: 'original',
      output: 'ISO HDR JPEG',
      rendering: EXPORT_RENDERING_VERSION,
      codec: EXPORT_CODEC_VERSION,
      display: DISPLAY_RENDERING_VERSION,
      p95,
      measurements,
      notes:
        'Every file decodes the managed original in fresh isolated workers; subsequent samples may benefit from OS and driver caches. Includes acceptance, source validation, encoding, publication hashes and fsync, and owned scratch cleanup. No preview cache, resizing or reduced quality.',
    }
    await writeFile(outputPath, JSON.stringify(result, null, 2))
    await recordBenchmark(info, {
      family: 'export',
      measurements: result,
      gates: [
        { metric: 'fresh-workers-p95Ms', operator: '<=', limit: 4000 },
        { metric: 'subsequent-p95Ms', operator: '<=', limit: 4000 },
      ],
      evidence: [outputPath],
    })
    expect(p95['fresh-workers'], 'Fresh-worker export p95').toBeLessThanOrEqual(4000)
    expect(p95.subsequent, 'Subsequent export p95').toBeLessThanOrEqual(4000)
  } finally {
    await fixture.close()
  }
})

test('quality 100 warm working-source and retained-preparation retries measure durable HDR export separately', async ({}, info) => {
  test.skip(
    process.env.LUMA_PREVIEW_BENCHMARK !== '1',
    'Run npm run benchmark:export for the isolated hardware benchmark.',
  )
  test.setTimeout(600000)
  const source = await benchmarkProvenance()
  const fixture = await setup(
    undefined,
    undefined,
    new ExportProcess(resolve('out/main/export-worker.js'), resolve('out/main/preview-worker.js')),
  )
  const measurements: {
    series: string
    ms: number
    bytes: number
    diagnostics: ExportDiagnostics
  }[] = []
  const outputPath = info.outputPath('warm-retry-benchmark.json')
  const plannedSamples = { 'warm-working-source': 10, 'retained-preparation-retry': 10 }
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  try {
    await writeFile(
      outputPath,
      JSON.stringify({ provenance: source, plannedSamples, measurements }, null, 2),
    )
    const session = await scan(fixture.service, [resolve('tests/fixtures/sony-zv1.ARW')])
    await commit(fixture.service, session)
    const photo = fixture.service.list().photos[0]
    const edits = await fixture.service.getEdits(photo.id)
    await fixture.service.updateEdits(
      photo.id,
      {
        exposureEv: 0.25,
        contrast: 10,
        highlights: -25,
        shadows: 20,
        whites: -15,
        blacks: 5,
        whiteBalance: { mode: 'custom', kelvin: 5800, tint: 8 },
      },
      edits.revision,
    )
    const original = resolve('tests/fixtures/sony-zv1.ARW')
    const before = await readFile(original)
    const destination = join(fixture.root, 'destination')
    await mkdir(destination)
    const grant = await fixture.service.exports.store.authorize(destination)
    await fixture.service.fullPreviews.requestHdr(photo.id, randomUUID())
    await fixture.service.fullPreviews.release()
    for (const series of ['warm-working-source', 'retained-preparation-retry']) {
      // A separate series deliberately has no preview-cache input.
      if (series === 'retained-preparation-retry') await fixture.service.fullPreviews.close()
      for (let sample = 0; sample < 10; sample++) {
        const prepared = await fixture.service.prepareExport([photo.id])
        const started = performance.now()
        const id = await fixture.service.startExport({
          preparationId: prepared.id,
          destinationId: grant.id,
          action: 'maximum',
        })
        if (series === 'retained-preparation-retry') {
          const descriptor = join(
            fixture.root,
            'library',
            'export-work',
            id,
            '0-preparation',
            'source.json',
          )
          await expect
            .poll(
              () =>
                readFile(descriptor, 'utf8').then(
                  () => true,
                  () => false,
                ),
              { timeout: 60000, intervals: [5] },
            )
            .toBe(true)
          await fixture.service.scheduler.run('interactive', async () => {})
        }
        while (!fixture.service.listTasks().find((task) => task.id === id)?.finishedAt)
          await new Promise<void>((accept) => setTimeout(accept, 5))
        const elapsed = performance.now() - started
        const task = fixture.service.listTasks().find((task) => task.id === id)!
        expect(task.status, JSON.stringify(fixture.service.exports.results(id))).toBe('completed')
        const file = fixture.service.exports.store.files(id)[0]
        await writeFile(
          outputPath,
          JSON.stringify(
            {
              provenance: source,
              plannedSamples,
              measurements,
              latestDiagnostics: file.diagnostics,
            },
            null,
            2,
          ),
        )
        expect(file.diagnostics?.sourcePreparation).toBe(
          series === 'warm-working-source' ? 'preview-cache' : 'retained',
        )
        expect(file.diagnostics?.sourceBackend).toBe('gpu')
        expect(file.diagnostics?.renderer, JSON.stringify(file.diagnostics)).toBe('gpu')
        expect(file.diagnostics?.encoder, JSON.stringify(file.diagnostics)).toBe(expectedEncoder)
        expect(file.diagnostics?.encoderFallback, JSON.stringify(file.diagnostics)).toBeUndefined()
        expect(file.diagnostics?.encoderMemory?.kind).toBe(
          expectedEncoder === 'native' ? 'process-rss' : 'wasm-heap',
        )
        expect(file.diagnostics?.encoderMemory?.peakBytes).toBeLessThanOrEqual(2 * 1024 ** 3)
        expect(file.diagnostics?.gpuMemoryBytes).toBeLessThanOrEqual(1024 ** 3)
        expect(file.diagnostics?.retries).toBe(series === 'warm-working-source' ? 0 : 1)
        const path = join(destination, file.outputName!),
          bytes = await readFile(path)
        measurements.push({
          series,
          ms: elapsed,
          bytes: bytes.length,
          diagnostics: file.diagnostics!,
        })
        await writeFile(
          outputPath,
          JSON.stringify({ provenance: source, plannedSamples, measurements }, null, 2),
        )
        expect(await sharp(bytes).metadata()).toMatchObject({
          width: 5422,
          height: 3622,
          isProgressive: false,
        })
        expect(jpegIdentity(bytes).sampling).toEqual([0x11, 0x11, 0x11])
        await rm(path)
        fixture.service.exports.dismiss(id)
      }
    }
    expect((await readFile(original)).equals(before)).toBe(true)
    const p95 = Object.fromEntries(
      ['warm-working-source', 'retained-preparation-retry'].map((series) => [
        series,
        percentile(measurements.filter((m) => m.series === series).map((m) => m.ms)),
      ]),
    )
    const result = {
      provenance: source,
      plannedSamples,
      fixture: 'sony-zv1.ARW',
      quality: 100,
      size: 'original',
      output: 'ISO HDR JPEG',
      rendering: EXPORT_RENDERING_VERSION,
      codec: EXPORT_CODEC_VERSION,
      display: DISPLAY_RENDERING_VERSION,
      p95,
      measurements,
      notes:
        'Warm-source samples validate and lease a matching preview working asset. Retry samples decode the original, interrupt after completed preparation, then reuse that preparation in a fresh encoder worker. All include durable publication and cleanup. The existing cold original-decode four-second series remains separate and unchanged; retry overhead is reported independently.',
    }
    await writeFile(outputPath, JSON.stringify(result, null, 2))
    await recordBenchmark(info, {
      family: 'export',
      measurements: result,
      gates: [{ metric: 'warm-working-source-p95Ms', operator: '<=', limit: 4000 }],
      evidence: [outputPath],
    })
    expect(p95['warm-working-source'], 'Warm working-source export p95').toBeLessThanOrEqual(4000)
  } finally {
    await fixture.close()
  }
})
