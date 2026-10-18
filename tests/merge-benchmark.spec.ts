import { test, expect } from '@playwright/test'
import { cp, mkdir, mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import { syntheticMerge } from './merge.helpers'
import { recordBenchmark } from './benchmark.helpers'
import type { MergeMode } from '../src/shared/merge'

async function diskBytes(path: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    bytes += entry.isDirectory() ? await diskBytes(child) : (await stat(child)).size
  }
  return bytes
}
// Playwright requires destructuring its fixture argument even without fixtures.
/* eslint-disable no-empty-pattern */
for (const count of [2, 9, 32])
  test(`merge ${count} frames records isolated worker memory, runtime and scratch`, async ({}, info) => {
    test.setTimeout(20 * 60 * 1000)
    const scratch = info.outputPath('scratch')
    await mkdir(scratch, { recursive: true })
    const width = process.env.LUMA_MERGE_BENCHMARK_NATIVE === '1' ? 5496 : 1024,
      height = process.env.LUMA_MERGE_BENCHMARK_NATIVE === '1' ? 3672 : 683,
      f = await syntheticMerge(Array(count).fill(1), {
        width,
        height,
        worker: true,
        autoAlign: true,
        scratchRoot: scratch,
      })
    try {
      expect(f.result.asset.width).toBe(width)
      const measurements = {
        sources: count,
        width,
        height,
        platform: process.platform,
        preparedSyntheticInputs: true,
        includesRawDecoding: false,
        autoAlign: true,
        alignmentMs: f.result.recipe.sources.reduce(
          (sum, s) => sum + (s.transform.diagnostics?.runtimeMs ?? 0),
          0,
        ),
        wasmMemoryBytes: Math.max(
          ...f.result.recipe.sources.map((s) => s.transform.diagnostics?.wasmMemoryBytes ?? 0),
        ),
        runtimeMs: f.result.runtimeMs,
        stages: f.result.measurements,
        peakWorkerMemoryBytes: f.result.peakMemoryBytes,
        scratchBytes: await diskBytes(f.directory),
      }
      await writeFile(info.outputPath(`merge-${count}.json`), JSON.stringify(measurements, null, 2))
      await recordBenchmark(info, {
        family: 'merge',
        measurements,
        gates: [],
        evidence: [info.outputPath(`merge-${count}.json`)],
      })
    } finally {
      await f.close()
    }
  })

// Repeated original RAW calibrates native throughput without claiming a distinct
// Sony sequence or real-scene quality at larger counts. Each run has a fresh library.
for (const count of [2, 3, 5, 9])
  test(`three cold ${count}-source native Sony RAW calibration runs include durable publication`, async ({}, info) => {
    test.setTimeout(20 * 60 * 1000)
    const inspector = new PreviewEngine(),
      path = resolve('tests/fixtures/sony-zv1.ARW'),
      metadata = await inspector.inspect(path)
    await inspector.close()
    const samples = []
    const libraries = info.outputPath('libraries')
    await mkdir(libraries, { recursive: true })
    for (let iteration = 0; iteration < 3; iteration++) {
      const root = await mkdtemp(join(libraries, 'luma-merge-cold-')),
        library = new PhotoLibrary(
          root,
          new PreviewEngine(),
          () => {},
          undefined,
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
          undefined,
          resolve('out/main/merge-worker.js'),
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
        )
      try {
        await library.open()
        const db = new DatabaseSync(join(root, 'catalog.sqlite')),
          ids: string[] = []
        try {
          for (let i = 0; i < count; i++) {
            const id = createHash('sha256').update(`${count}:${iteration}:${i}`).digest('hex'),
              directory = join(root, 'originals', id)
            ids.push(id)
            await mkdir(directory, { recursive: true })
            await cp(path, join(directory, 'original.arw'))
            const photo = {
              id,
              filename: `calibration-${i}.ARW`,
              format: 'ARW',
              width: 5496,
              height: 3672,
              bytes: (await stat(path)).size,
              importedAt: '2026',
              thumbnailUrl: '',
              previewUrl: '',
              previewSource: 'decoded',
            }
            db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
              id,
              '2026',
              JSON.stringify(photo),
            )
            db.prepare('INSERT INTO processing VALUES (?, ?)').run(
              id,
              JSON.stringify({
                metadata,
                settings: { distortion: true, vignetting: true, chromaticAberration: true },
                revision: 0,
              }),
            )
          }
        } finally {
          db.close()
        }
        const start = performance.now(),
          review = await library.createMergeReview(ids, 'noise'),
          preview = await library.requestMergePreview(review.id, 0),
          preparedMs = performance.now() - start,
          cold = await library.getMergeDiagnostics(review.id, 0)
        const reuseStart = performance.now(),
          updated = await library.updateMergeReview(review.id, 0, {
            ...review.settings,
            strength: 65,
          })
        await library.requestMergePreview(review.id, updated.revision)
        const preparationReuseMs = performance.now() - reuseStart,
          reused = await library.getMergeDiagnostics(review.id, updated.revision)
        expect(reused.measurements!.attempts).toHaveLength(0)
        expect(reused.measurements!.preparation.every((p) => p.reused)).toBe(true)
        const publicationStart = Date.now(),
          taskId = library.startMerge(review.id, updated.revision)
        await expect
          .poll(() => library.listTasks().find((t) => t.id === taskId)?.finishedAt, {
            timeout: 180000,
          })
          .toBeTruthy()
        const task = library.listTasks().find((t) => t.id === taskId)!,
          publicationMs = task.finishedAt! - publicationStart
        expect(task.status, JSON.stringify(library.taskErrors(taskId))).toBe('completed')
        const measurements = task.mergeMeasurements!
        expect(measurements.accumulation.backend, JSON.stringify(measurements)).toBe('gpu')
        expect(cold.measurements!.preparation.every((p) => p.backend === 'gpu' && !p.reused)).toBe(
          true,
        )
        samples.push({
          iteration,
          coldRunMs: preparedMs + publicationMs,
          nativeReviewMs: preparedMs,
          publicationMs,
          preparationReuseMs,
          width: preview.recipe.width,
          height: preview.recipe.height,
          cold: cold.measurements,
          reused: reused.measurements,
          published: measurements,
        })
      } finally {
        await library.close()
        await rm(root, { recursive: true, force: true })
      }
    }
    const measurements = {
      sources: count,
      repeatedRawCalibration: true,
      distinctSonySequence: false,
      includesRawDecoding: true,
      includesDurablePublication: true,
      publicationFilesystem: 'project-filesystem',
      autoAlign: true,
      coldRuns: 3,
      maximumColdRunMs: Math.max(...samples.map((s) => s.coldRunMs)),
      samples,
    }
    const evidence = info.outputPath(`merge-cold-${count}.json`)
    await writeFile(evidence, JSON.stringify(measurements, null, 2))
    await recordBenchmark(info, {
      family: 'merge',
      measurements,
      gates: [{ metric: 'maximumColdRunMs', operator: '<=', limit: 15000 }],
      evidence: [evidence],
    })
    expect(measurements.maximumColdRunMs).toBeLessThanOrEqual(15000)
  })

// Distinct, unmodified Sony originals supplied explicitly for this invocation.
// Source copying and catalog metadata inspection are import work, outside the
// merge clock; RAW sensor decoding remains inside each cold worker run.
for (const count of [2, 3, 5, 9])
  test(`three cold ${count}-source distinct Sony runs include durable publication`, async ({}, info) => {
    test.skip(!process.env.LUMA_MERGE_SONY_SEQUENCE, 'Supply distinct Sony originals explicitly.')
    test.setTimeout(20 * 60 * 1000)
    const paths = JSON.parse(process.env.LUMA_MERGE_SONY_SEQUENCE!) as string[],
      mode = (process.env.LUMA_MERGE_SONY_MODE ?? 'noise') as MergeMode
    expect(['noise', 'hdr']).toContain(mode)
    expect(paths.length).toBeGreaterThanOrEqual(count)
    const selected = Array.from(
        { length: count },
        (_, i) => paths[Math.round((i * (paths.length - 1)) / (count - 1))],
      ),
      inspector = new PreviewEngine()
    const originals = []
    try {
      for (const path of selected)
        originals.push({
          path,
          metadata: await inspector.inspect(path),
          id: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
          bytes: (await stat(path)).size,
        })
    } finally {
      await inspector.close()
    }
    expect(new Set(originals.map((s) => s.id)).size).toBe(count)
    const samples = []
    const libraries = info.outputPath('libraries')
    await mkdir(libraries, { recursive: true })
    for (let iteration = 0; iteration < 3; iteration++) {
      const root = await mkdtemp(join(libraries, 'luma-merge-distinct-')),
        library = new PhotoLibrary(
          root,
          new PreviewEngine(),
          () => {},
          undefined,
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
          undefined,
          resolve('out/main/merge-worker.js'),
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
        )
      try {
        await library.open()
        const db = new DatabaseSync(join(root, 'catalog.sqlite'))
        try {
          for (const s of originals) {
            const directory = join(root, 'originals', s.id)
            await mkdir(directory, { recursive: true })
            await cp(s.path, join(directory, 'original.arw'))
            db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
              s.id,
              '2026',
              JSON.stringify({
                id: s.id,
                filename: basename(s.path),
                format: 'ARW',
                width: 5496,
                height: 3672,
                bytes: s.bytes,
                importedAt: '2026',
                thumbnailUrl: '',
                previewUrl: '',
                previewSource: 'decoded',
              }),
            )
            db.prepare('INSERT INTO processing VALUES (?, ?)').run(
              s.id,
              JSON.stringify({
                metadata: s.metadata,
                settings: { distortion: true, vignetting: true, chromaticAberration: true },
                revision: 0,
              }),
            )
          }
        } finally {
          db.close()
        }
        const start = Date.now(),
          review = await library.createMergeReview(
            originals.map((s) => s.id),
            mode,
          ),
          preview = await library.requestMergePreview(review.id, review.revision),
          cold = await library.getMergeDiagnostics(review.id, review.revision),
          publicationStart = Date.now(),
          taskId = library.startMerge(review.id, review.revision)
        await expect
          .poll(() => library.listTasks().find((t) => t.id === taskId)?.finishedAt, {
            timeout: 180000,
          })
          .toBeTruthy()
        const task = library.listTasks().find((t) => t.id === taskId)!
        const runEvidence = info.outputPath(`distinct-${count}-run-${iteration}.json`)
        await writeFile(
          runEvidence,
          JSON.stringify({ task, cold, errors: library.taskErrors(taskId) }, null, 2),
        )
        await info.attach(`distinct-${count}-run-${iteration}`, {
          path: runEvidence,
          contentType: 'application/json',
        })
        expect(task.status, JSON.stringify(library.taskErrors(taskId))).toBe('completed')
        expect(task.mergeMeasurements!.accumulation.backend).toBe('gpu')
        expect(task.mergeMeasurements!.output?.backend).toBe('gpu')
        expect(cold.measurements!.preparation.every((p) => p.backend === 'gpu' && !p.reused)).toBe(
          true,
        )
        samples.push({
          iteration,
          coldRunMs: task.finishedAt! - start,
          nativeReviewMs: publicationStart - start,
          publicationMs: task.finishedAt! - publicationStart,
          width: preview.recipe.width,
          height: preview.recipe.height,
          cold: cold.measurements,
          published: task.mergeMeasurements,
          alignment: cold.sources,
        })
        if (iteration === 0)
          await cp(
            join(root, 'originals', task.resultPhotoId!),
            info.outputPath('published-master'),
            { recursive: true },
          )
      } finally {
        await library.close()
        await rm(root, { recursive: true, force: true })
      }
    }
    const measurements = {
      sources: count,
      originals: originals.map((s) => ({ filename: basename(s.path), sha256: s.id })),
      distinctSonySequence: true,
      repeatedRawCalibration: false,
      includesRawDecoding: true,
      includesDurablePublication: true,
      publicationFilesystem: 'project-filesystem',
      autoAlign: true,
      mode,
      coldRuns: 3,
      maximumColdRunMs: Math.max(...samples.map((s) => s.coldRunMs)),
      samples,
    }
    const evidence = info.outputPath(`merge-distinct-${count}.json`)
    await writeFile(evidence, JSON.stringify(measurements, null, 2))
    await recordBenchmark(info, {
      family: 'merge',
      measurements,
      gates: [{ metric: 'maximumColdRunMs', operator: '<=', limit: 15000 }],
      evidence: [evidence],
    })
    expect(measurements.maximumColdRunMs).toBeLessThanOrEqual(15000)
  })
