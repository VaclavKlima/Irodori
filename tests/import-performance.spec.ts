import { expect, test } from '@playwright/test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { copyOriginal } from '../src/main/copy-original'
import type { PreviewProcessor } from '../src/main/preview-types'
import { execFileSync } from 'node:child_process'

// This service benchmark deliberately has no browser fixture.
// eslint-disable-next-line no-empty-pattern
test('records three isolated import runs with separate copying and preparation timings', async ({}, info) => {
  test.setTimeout(240_000)
  const phase = process.env.LUMA_IMPORT_BENCHMARK_PHASE ?? 'pipeline'
  const cold = process.env.LUMA_IMPORT_BENCHMARK_COLD === '1'
  if (cold && process.platform !== 'linux')
    throw new Error('Per-source cache eviction is only verified on Linux.')
  const paths: string[] = process.env.LUMA_IMPORT_BENCHMARK_SOURCES
    ? JSON.parse(process.env.LUMA_IMPORT_BENCHMARK_SOURCES)
    : [
        'tests/fixtures/photos/alpine-lake.jpg',
        'tests/fixtures/photos/mountain-ridge.jpg',
        'tests/fixtures/photos/forest-light.jpg',
        'tests/fixtures/sony-zv1.ARW',
      ]
  const sources = await Promise.all(
    paths.map(async (path) => {
      const original = await stat(path)
      return {
        path: resolve(path),
        bytes: original.size,
      }
    }),
  )
  const runs = []
  for (let run = 0; run < 3; run++) {
    if (cold)
      execFileSync('python3', [
        '-c',
        'import os,sys,json\nfor path in json.loads(sys.argv[1]):\n fd=os.open(path,os.O_RDONLY)\n try: os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED)\n finally: os.close(fd)',
        JSON.stringify(sources.map((source) => source.path)),
      ])
    const directory = info.outputPath(`${phase}-${run}`)
    await mkdir(directory, { recursive: true })
    let copyingMs = 0
    const preparations: number[] = []
    let firstPublicationMs: number | undefined
    const started = performance.now()
    const cpu = process.cpuUsage()
    let peakRss = 0
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }, 20)
    const stageTimings: Record<string, number>[] = []
    let nativeCpuMicros = 0,
      nativePeakRss = 0
    const createProcessor = (): PreviewProcessor => {
      const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
      const record = (value: import('../src/main/preview-types').PreviewResult) => {
        if (value.preparation) {
          stageTimings.push(value.preparation.timings)
          nativeCpuMicros += value.preparation.cpuMicros
          nativePeakRss = Math.max(nativePeakRss, value.preparation.rssBytes)
        }
        return value
      }
      return {
        createWorker: createProcessor,
        process: async (...args) => {
          const at = performance.now()
          try {
            return record(await worker.process(...args))
          } finally {
            preparations.push(performance.now() - at)
          }
        },
        prepare: async (...args) => {
          const at = performance.now()
          try {
            return record(await worker.prepare(...args))
          } finally {
            preparations.push(performance.now() - at)
          }
        },
        close: () => worker.close(),
      }
    }
    const processor = createProcessor()
    const library = new PhotoLibrary(
      join(directory, 'library'),
      processor,
      (event) => {
        if (event.firstImportedId) firstPublicationMs ??= performance.now() - started
      },
      async (...args) => {
        const at = performance.now()
        try {
          return await copyOriginal(...args)
        } finally {
          copyingMs += performance.now() - at
        }
      },
    )
    try {
      await library.open()
      const id = await library.scan(
        sources.map((s) => s.path),
        false,
      )
      await expect.poll(() => library.review(id).phase, { timeout: 30_000 }).toBe('review')
      library.importSelected(id)
      await expect
        .poll(() => library.listTasks()[0]?.status, { timeout: 120_000 })
        .toBe('completed')
      const totalMs = performance.now() - started
      const bytes = sources.reduce((sum, s) => sum + s.bytes, 0)
      for (const source of sources) {
        const expectedHash = createHash('sha256')
          .update(await readFile(source.path))
          .digest('hex')
        const photo = library.list().photos.find((p) => p.id === expectedHash)!
        expect(photo).toBeDefined()
        const original = join(
          directory,
          'library',
          'originals',
          photo.id,
          `original.${photo.format.toLowerCase()}`,
        )
        expect((await stat(original)).size).toBe(source.bytes)
        expect(
          createHash('sha256')
            .update(await readFile(original))
            .digest('hex'),
        ).toBe(expectedHash)
      }
      runs.push({
        totalMs,
        bytes,
        copyingMs,
        copyMBps: bytes / (copyingMs / 1000) / 1e6,
        preparations,
        firstPublicationMs,
        nativeCpuMicros,
        nativePeakWorkerRss: nativePeakRss,
        stageTimings,
        mainCpu: process.cpuUsage(cpu),
        mainPeakRss: peakRss,
        task: library.listTasks()[0],
      })
    } finally {
      clearInterval(sampler)
      await library.close()
      await rm(join(directory, 'library'), { recursive: true, force: true })
    }
  }
  await writeFile(
    info.outputPath(`${phase}.json`),
    JSON.stringify(
      {
        phase,
        sources,
        runs,
        hardware: Boolean(process.env.LUMA_IMPORT_BENCHMARK_SOURCES),
        cachePolicy: cold ? 'POSIX_FADV_DONTNEED before every trial' : 'warm OS caches',
        limitations: [
          'No physical input or scanout measurement.',
          'Native CPU/RSS describe preparation workers; ExifTool CPU and aggregate simultaneous process RSS are not included.',
        ],
      },
      null,
      2,
    ),
  )
})
