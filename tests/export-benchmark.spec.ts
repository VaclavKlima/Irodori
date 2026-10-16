/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { test, expect } from '@playwright/test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { setup, scan, commit } from './library.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { EXPORT_RENDERING_VERSION, EXPORT_CODEC_VERSION } from '../src/shared/export'
import { DISPLAY_RENDERING_VERSION } from '../src/shared/display-rendering'
import type { ExportDiagnostics } from '../src/main/export/types'
import { ExportProcess } from '../src/main/export/process'
import { jpegIdentity } from '../src/main/export/jpeg'
import { nativeEncoderPath } from '../src/main/export/encoder'
import { randomUUID } from 'node:crypto'

test('quality 100 original-size HDR export measures acceptance through durable publication', async ({}, info) => {
  test.skip(
    process.env.LUMA_PREVIEW_BENCHMARK !== '1',
    'Run npm run benchmark:export for the isolated hardware benchmark.',
  )
  test.setTimeout(600000)
  test.skip(
    !(await nativeEncoderPath()),
    'This complete hardware gate requires the bundled macOS arm64 encoder.',
  )
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
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  try {
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
        expect(file.diagnostics?.sourceBackend).toBe('gpu')
        expect(file.diagnostics?.renderer, JSON.stringify(file.diagnostics)).toBe('gpu')
        expect(file.diagnostics?.encoder, JSON.stringify(file.diagnostics)).toBe('native')
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
        await writeFile(outputPath, JSON.stringify({ measurements }, null, 2))
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
  test.skip(
    !(await nativeEncoderPath()),
    'This complete hardware measurement requires the bundled macOS arm64 encoder.',
  )
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
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  try {
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
        expect(file.diagnostics?.sourcePreparation).toBe(
          series === 'warm-working-source' ? 'preview-cache' : 'retained',
        )
        expect(file.diagnostics?.sourceBackend).toBe('gpu')
        expect(file.diagnostics?.renderer, JSON.stringify(file.diagnostics)).toBe('gpu')
        expect(file.diagnostics?.encoder, JSON.stringify(file.diagnostics)).toBe('native')
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
        await writeFile(outputPath, JSON.stringify({ measurements }, null, 2))
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
