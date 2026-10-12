/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { PhotoLibrary } from '../src/main/library'
import { PreviewProcess } from '../src/main/preview-process'
import { ReviewThumbnails } from '../src/main/review-thumbnails'
import type { ThumbnailProcessor } from '../src/main/preview-types'

const diagnosticPath = resolve(
  'artifacts/verification/2026-10-09T19-24-06.408Z-review-diagnostic-841caae1/summary.md',
)
const workerPath = resolve('out/main/preview-worker.js')

interface LegacyTiming {
  firstCandidateReadyMs: number
  firstSelectableMs: number
  completedListingMs: number
  firstThumbnailMs: number
  newlyVisitedPageMs: number | null
  preparations: number
  duplicates: number
  rawHashMs: number
  rawPreparationMs: number
}

interface ProgressiveTiming {
  firstSelectableMs: number
  completedListingMs: number
  firstThumbnailMs: number
  newlyVisitedPageMs: number | null
  newlyVisitedPageCompleteMs: number | null
  preparationsBeforeAcceptance: number
  thumbnailRequests: { filename: string; fallback: boolean; startedMs: number }[]
  total: number
}

async function until(ready: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!ready()) {
    if (performance.now() >= deadline) throw new Error('Review measurement timed out.')
    await delay(1)
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function legacyScan(paths: string[], output: string): Promise<LegacyTiming> {
  const processor = new PreviewProcess(workerPath)
  const signal = new AbortController().signal
  const seen = new Map<string, string>()
  const catalog = new Set<string>()
  const started = performance.now()
  let firstCandidateReadyMs = 0,
    preparations = 0,
    duplicates = 0,
    rawHashMs = 0,
    rawPreparationMs = 0
  try {
    for (const [index, path] of paths.entries()) {
      // Reconstruct the pre-change scan's filesystem/hash/preparation order.
      // The actual unchanged browsing-asset worker is used, rather than a delay.
      await stat(path)
      const canonical = await realpath(path)
      const before = await stat(canonical)
      const hashStarted = performance.now()
      const hash = await hashFile(canonical)
      if (index === 0) rawHashMs = performance.now() - hashStarted
      if (catalog.has(hash) || seen.has(hash)) {
        duplicates++
        continue
      }
      const directory = join(output, String(index))
      await mkdir(directory, { recursive: true })
      const preparationStarted = performance.now()
      await processor.process(canonical, directory, signal)
      if (index === 0) rawPreparationMs = performance.now() - preparationStarted
      preparations++
      const after = await stat(canonical)
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error('The benchmark source changed during baseline preparation.')
      seen.set(hash, canonical)
      if (!firstCandidateReadyMs) firstCandidateReadyMs = performance.now() - started
    }
    const completedListingMs = performance.now() - started
    // The prior ImportDialog disabled checkboxes while phase === scanning.
    // Page thumbnails had already been generated when that review became usable.
    return {
      firstCandidateReadyMs,
      firstSelectableMs: completedListingMs,
      completedListingMs,
      firstThumbnailMs: firstCandidateReadyMs,
      newlyVisitedPageMs: paths.length > 60 ? 0 : null,
      preparations,
      duplicates,
      rawHashMs,
      rawPreparationMs,
    }
  } finally {
    await processor.close()
  }
}

async function progressiveScan(paths: string[], root: string): Promise<ProgressiveTiming> {
  const processor = new PreviewProcess(workerPath)
  const light = new PreviewProcess(workerPath)
  const fallback = new PreviewProcess(workerPath)
  let preparations = 0,
    started = 0
  const thumbnailRequests: ProgressiveTiming['thumbnailRequests'] = []
  const instrument = (worker: PreviewProcess): ThumbnailProcessor => ({
    thumbnail: (path, output, signal, decoder = false) => {
      thumbnailRequests.push({
        filename: basename(path),
        fallback: decoder,
        startedMs: performance.now() - started,
      })
      return worker.thumbnail(path, output, signal, decoder)
    },
    close: () => worker.close(),
  })
  const service = new PhotoLibrary(
    root,
    {
      process: (...args) => {
        preparations++
        return processor.process(...args)
      },
      close: () => processor.close(),
    },
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (onState) => new ReviewThumbnails(onState, instrument(light), instrument(fallback)),
  )
  await service.open()
  try {
    started = performance.now()
    const id = await service.scan(paths, false)
    await until(() => service.review(id).total > 0)
    const firstSelectableMs = performance.now() - started
    const first = service.review(id).candidates[0]
    expect(first).toMatchObject({ status: 'unchecked', selected: true, thumbnailState: 'idle' })
    service.select(id, [first.id], false)
    service.select(id, [first.id], true)
    expect(preparations).toBe(0)
    service.requestReviewThumbnails(id, [first.id])
    await until(() => service.review(id).phase === 'review')
    const completedListingMs = performance.now() - started
    expect(preparations).toBe(0)
    expect(service.review(id)).toMatchObject({
      total: paths.length,
      unchecked: paths.length,
      selected: paths.length,
    })
    await until(() => service.review(id).candidates[0].thumbnailState === 'ready')
    const firstThumbnailMs = performance.now() - started
    let newlyVisitedPageMs: number | null = null,
      newlyVisitedPageCompleteMs: number | null = null
    if (paths.length > 60) {
      const firstPage = service.review(id).candidates
      const secondPage = service.review(id, 60).candidates
      // Queue several old-page rows and immediately visit a new page. Only the
      // new visible page can enter the processor after its replacement request.
      service.requestReviewThumbnails(
        id,
        firstPage.slice(0, 4).map((candidate) => candidate.id),
      )
      const visiting = performance.now()
      service.requestReviewThumbnails(
        id,
        secondPage.map((candidate) => candidate.id),
      )
      await until(() =>
        service.review(id, 60).candidates.some((candidate) => candidate.thumbnailState === 'ready'),
      )
      newlyVisitedPageMs = performance.now() - visiting
      await until(() =>
        service
          .review(id, 60)
          .candidates.every((candidate) => candidate.thumbnailState === 'ready'),
      )
      newlyVisitedPageCompleteMs = performance.now() - visiting
      expect(thumbnailRequests.map((request) => request.filename)).toEqual([
        first.filename,
        ...secondPage.map((candidate) => candidate.filename),
      ])
      expect(
        service
          .review(id)
          .candidates.slice(1)
          .every((candidate) => candidate.thumbnailState === 'idle'),
      ).toBe(true)
    }
    expect(preparations).toBe(0)
    expect(thumbnailRequests.some((request) => request.fallback)).toBe(false)
    return {
      firstSelectableMs,
      completedListingMs,
      firstThumbnailMs,
      newlyVisitedPageMs,
      newlyVisitedPageCompleteMs,
      preparationsBeforeAcceptance: preparations,
      thumbnailRequests,
      total: service.review(id).total,
    }
  } finally {
    await service.close()
    await Promise.all([light.close(), fallback.close()])
  }
}

test('measures reconstructed legacy and progressive review discovery, thumbnails, and page visits', async ({}, info) => {
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'luma-review-performance-'))
  const evidence: {
    scope: string
    provenance: Record<string, unknown>
    samples: Record<string, unknown>
    limitations: string[]
    failure?: string
  } = {
    scope:
      'Service-level filesystem discovery and thumbnail readiness; excludes renderer IPC, image decoding in the browser, and Electron presentation.',
    provenance: {
      baseline:
        'Reconstruction of pre-change sequential stat, SHA-256, duplicate lookup, full metadata and browsing-asset preparation. Uses the current unchanged PreviewProcess.process operation. Prior UI disabled selection until the complete scan finished.',
      existingSonyDiagnostic: diagnosticPath,
      existingSonyDiagnosticProcessMs: [296, 411],
      measurementOrder: ['legacy collection', 'progressive collection', 'progressive single RAW'],
      operatingSystem: process.platform,
      architecture: process.arch,
      node: process.version,
      pollingIntervalMs: 1,
    },
    samples: {},
    limitations: [
      'One controlled observation per mode; this is not a statistical hardware benchmark.',
      'Source files are already in the OS cache from fixture creation; worker processes start cold for each mode.',
      'Legacy newly visited page generation latency is zero because every thumbnail was prepared before selection became usable; browser presentation is excluded for both modes.',
      'The prior Sony diagnostic contains two preparation observations and excludes enumeration; it is retained as contextual evidence, not a formal performance gate.',
    ],
  }
  try {
    evidence.provenance.sourceCommit = (
      await promisify(execFile)('git', ['rev-parse', 'HEAD'])
    ).stdout.trim()
    const source = join(root, 'source')
    await mkdir(source)
    const raw = resolve('tests/fixtures/sony-zv1.ARW')
    const rawModified = (await stat(raw)).mtimeMs
    const fixture = await readFile('tests/fixtures/photos/alpine-lake.jpg')
    const paths = [raw]
    // Distinct trailing bytes preserve the licensed JPEG pixels and exercise
    // real hashing/duplicate detection without 61 expensive fixture files.
    for (let index = 0; index < 61; index++) {
      const path = join(source, `${String(index).padStart(3, '0')}.jpg`)
      await writeFile(
        path,
        Buffer.concat([fixture, Buffer.from(`\nLuma review sample ${index}\n`)]),
      )
      // Keep the RAW first in the chronological review without touching its fixture.
      const modified = new Date(rawModified - (index + 1) * 60_000)
      await utimes(path, modified, modified)
      paths.push(path)
    }
    evidence.provenance.sourceFiles = {
      sonyRaw: 1,
      distinctJpegOriginals: 61,
      total: paths.length,
      reviewOrder: 'Filesystem modification time descending; Sony RAW is newest.',
    }
    const legacy = await legacyScan(paths, join(root, 'legacy'))
    evidence.samples.legacyCollection = legacy
    const progressive = await progressiveScan(paths, join(root, 'progressive'))
    evidence.samples.progressiveCollection = progressive
    const singleRaw = await progressiveScan([raw], join(root, 'single-raw'))
    evidence.samples.progressiveSingleRaw = singleRaw
    evidence.samples.ratios = {
      firstSelectable: progressive.firstSelectableMs / legacy.firstSelectableMs,
      completedListing: progressive.completedListingMs / legacy.completedListingMs,
      firstThumbnail: progressive.firstThumbnailMs / legacy.firstThumbnailMs,
      rawDiscoveryAgainstPreparedCandidate:
        singleRaw.completedListingMs / legacy.firstCandidateReadyMs,
    }
    expect(legacy).toMatchObject({ preparations: 62, duplicates: 0 })
    expect(progressive.preparationsBeforeAcceptance).toBe(0)
    expect(progressive.firstSelectableMs).toBeLessThan(legacy.firstCandidateReadyMs / 2)
    expect(progressive.completedListingMs).toBeLessThan(legacy.completedListingMs / 4)
    expect(singleRaw.completedListingMs).toBeLessThan(legacy.firstCandidateReadyMs / 2)
    expect(progressive.thumbnailRequests).toHaveLength(3)
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    const path = info.outputPath('review-performance.json')
    await writeFile(path, JSON.stringify(evidence, null, 2))
    await info.attach('Review performance measurements', { path, contentType: 'application/json' })
    await rm(root, { recursive: true, force: true })
  }
})
