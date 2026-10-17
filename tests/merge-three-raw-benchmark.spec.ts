import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewProcess } from '../src/main/preview-process'
import { verifyMaster } from '../src/main/merge/store'
import type { BackgroundTask } from '../src/shared/contracts'
import { automaticLensSettings, type ProcessingMetadata } from '../src/shared/lens'
import type { MergeMode, MergeRecipe } from '../src/shared/merge'
import type { HdrWorkingAsset } from '../src/shared/hdr'
import { provenance } from '../scripts/research/pipeline/provenance'
import { recordBenchmark } from './benchmark.helpers'

interface SonyManifest {
  version: number
  sequences: { id: string; mode: MergeMode; complete: boolean; files: string[] }[]
  files: {
    name: string
    path: string
    sha256: string
    bytes: number
    dimensions: { activeWidth: number; activeHeight: number }
  }[]
}

interface FrozenMergeEvidence {
  publishedAsset: HdrWorkingAsset
  registration: { key: string; sha256: string; data: string }
  recipe?: Pick<MergeRecipe, 'width' | 'height' | 'crop' | 'maskSha256'>
  preparationManifests?: Awaited<ReturnType<typeof preparationManifests>>
}

function preparationIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(preparationIdentity)
  if (!value || typeof value !== 'object') return value
  return normalizedRegistration(
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['measurement', 'gpuBytes'].includes(key))
        .map(([key, item]) => [key, preparationIdentity(item)]),
    ),
  )
}

function normalizedRegistration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedRegistration)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !['runtimeMs', 'wasmMemoryBytes'].includes(key) &&
          !/^(?:id|path)$|(?:Id|Ids|Path|Paths)$/.test(key),
      )
      .map(([key, item]) => [key, normalizedRegistration(item)])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )
}

function frozenIdentity(sample: FrozenMergeEvidence) {
  if (!sample.recipe) throw new Error('Merge baseline requires its native crop and motion mask.')
  const asset = sample.publishedAsset
  return {
    asset: {
      width: asset.width,
      height: asset.height,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
      strips: asset.strips,
    },
    native: {
      width: sample.recipe.width,
      height: sample.recipe.height,
      crop: sample.recipe.crop,
      maskSha256: sample.recipe.maskSha256,
    },
    registration: normalizedRegistration(JSON.parse(sample.registration.data)),
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function errorEvidence(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'UnknownError', message: String(error) }
}

interface AttemptEvidence {
  iteration: number
  phase: string
  reviewId?: string
  revision?: number
  taskId?: string
  completeOperationMs?: number
  createReviewMs?: number
  nativeReviewMs?: number
  diagnosticSnapshotMs?: number
  publicationAndCleanupMs?: number
  managedOriginalsBefore: { filename: string; sha256: string; bytes: number }[]
  managedOriginalsAfter: { filename: string; sha256: string; bytes: number }[]
  error?: ReturnType<typeof errorEvidence>
  cleanupError?: ReturnType<typeof errorEvidence>
}

async function mergeBaseline(mode: MergeMode) {
  const input = process.env.LUMA_MERGE_THREE_RAW_BASELINE
  if (!input) return
  const path = resolve(input),
    bytes = await readFile(path),
    record = JSON.parse(bytes.toString('utf8')) as {
      run?: string
      rows: { mode: MergeMode; samples: FrozenMergeEvidence[] }[]
    },
    row = record.rows.find((row) => row.mode === mode)
  expect(row, `The merge baseline must contain ${mode}.`).toBeTruthy()
  expect(row!.samples.length).toBeGreaterThanOrEqual(3)
  if (row!.samples.some((sample) => !sample.recipe)) {
    if (!record.run)
      throw new Error('Merge baseline lacks the native recipe and original run path.')
    const directory = resolve(record.run, 'benchmarks/merge/results')
    let full: { samples: FrozenMergeEvidence[] } | undefined
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        full = JSON.parse(
          await readFile(join(directory, entry.name, `merge-three-raw-${mode}.json`), 'utf8'),
        ) as typeof full
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (!full) throw new Error(`The original ${mode} baseline native recipe is unavailable.`)
    row!.samples = row!.samples.map((sample, index) => {
      const original = full!.samples[index]
      expect(original.publishedAsset).toEqual(sample.publishedAsset)
      expect(original.registration).toEqual(sample.registration)
      return { ...sample, recipe: sample.recipe ?? original.recipe }
    })
  }
  for (const sample of row!.samples) frozenIdentity(sample)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), samples: row!.samples }
}

async function preparationManifests(directory: string) {
  const sources = await Promise.all(
    [0, 1, 2].map(
      async (index) =>
        JSON.parse(await readFile(join(directory, `source-${index}.json`), 'utf8')) as unknown,
    ),
  )
  const referenceFallback = await readFile(
    join(directory, 'reference-fallback/source-0.json'),
    'utf8',
  )
    .then((bytes) => JSON.parse(bytes) as unknown)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  return { sources, referenceFallback }
}

async function fileIdentity(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size }
}

async function entries(path: string) {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

// This is a separate complete-operation gate. The existing synthetic and repeated
// RAW calibrations keep their own source counts, timings and fifteen-second gate.
// Playwright requires destructuring its fixture argument even without fixtures.
/* eslint-disable no-empty-pattern */
for (const mode of ['noise', 'hdr'] as const)
  test(`three fresh three-RAW ${mode} operations include native review and durable publication below five seconds`, async ({}, info) => {
    test.setTimeout(10 * 60 * 1000)
    const fixtureRoot = resolve('tests/fixtures/research-sony'),
      manifestPath = join(fixtureRoot, 'manifest.json'),
      manifestBytes = await readFile(manifestPath),
      manifest = JSON.parse(manifestBytes.toString('utf8')) as SonyManifest,
      sequence = manifest.sequences.find((sequence) => sequence.mode === mode)
    expect(manifest.version).toBe(1)
    expect(sequence?.complete, `The committed ${mode} sequence is mandatory.`).toBe(true)
    expect(sequence!.files.length).toBeGreaterThanOrEqual(3)
    // Match the existing distinct three-source calibration: the complete bracket,
    // or distributed first/middle/last members of the twelve-frame noise burst.
    const names = [0, Math.round((sequence!.files.length - 1) / 2), sequence!.files.length - 1].map(
      (index) => sequence!.files[index],
    )
    expect(new Set(names).size).toBe(3)
    const inspector = new PreviewProcess(resolve('out/main/preview-worker.js')),
      originals: {
        path: string
        name: string
        sha256: string
        bytes: number
        width: number
        height: number
        metadata: ProcessingMetadata
      }[] = [],
      fixtureIdentities: { filename: string; sha256: string; bytes: number }[] = [],
      attempts: AttemptEvidence[] = [],
      failures: unknown[] = []
    const retainSetupFailure = async (phase: string, error: unknown) => {
      const evidence = info.outputPath(`three-raw-${mode}-setup-failure.json`)
      await writeFile(
        evidence,
        JSON.stringify({ mode, phase, fixtureIdentities, error: errorEvidence(error) }, null, 2),
      )
      await info.attach(`three-raw-${mode}-setup-failure`, {
        path: evidence,
        contentType: 'application/json',
      })
    }
    try {
      for (const name of names) {
        const entry = manifest.files.find((file) => file.name === name)
        expect(entry, `Missing committed Sony manifest entry: ${name}`).toBeTruthy()
        const path = resolve(fixtureRoot, entry!.path)
        expect(path.startsWith(`${fixtureRoot}${sep}`)).toBe(true)
        const identity = await fileIdentity(path)
        fixtureIdentities.push({ filename: name, ...identity })
        expect(identity, `Committed fixture changed: ${name}`).toEqual({
          sha256: entry!.sha256,
          bytes: entry!.bytes,
        })
        originals.push({
          path,
          name,
          ...identity,
          width: entry!.dimensions.activeWidth,
          height: entry!.dimensions.activeHeight,
          metadata: await inspector.inspect(path, new AbortController().signal),
        })
      }
    } catch (error) {
      await retainSetupFailure('fixture-inspection', error)
      throw error
    } finally {
      await inspector.close()
    }
    expect(new Set(originals.map((source) => source.sha256)).size).toBe(3)
    const baseline = await mergeBaseline(mode).catch(async (error: unknown) => {
        await retainSetupFailure('baseline', error)
        throw error
      }),
      libraries = info.outputPath('libraries'),
      source = {
        ...(await provenance([
          manifestPath,
          'package-lock.json',
          'tests/merge-three-raw-benchmark.spec.ts',
          'out/main/merge-worker.js',
          'out/main/preview-worker.js',
          'src/main/library.ts',
          'src/main/merge/reviews.ts',
          'src/main/merge/process.ts',
          'src/main/merge/engine.ts',
          'src/main/merge/prepare.ts',
          'src/main/merge/camera-registration.ts',
          'src/main/merge/cpu-kernels.ts',
          'src/main/merge/kernels/prepare.c',
          'src/main/merge/gpu-output.ts',
          'vendor/merge-kernels/luma-merge-kernels.wasm',
          'vendor/merge-kernels/manifest.json',
          'src/main/merge/preparation-policy.ts',
          'src/main/preview-process.ts',
          'src/main/preview-engine.ts',
          'src/main/preview-types.ts',
          'src/main/preview-worker.ts',
          'src/main/merge/preparation-cache.ts',
          'src/main/merge/store.ts',
          'src/shared/merge.ts',
        ])),
        build: 'Production merge/preview workers; main PhotoLibrary service through Playwright.',
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      },
      samples: {
        iteration: number
        completeOperationMs: number
        createReviewMs: number
        nativeReviewMs: number
        diagnosticSnapshotMs: number
        publicationAndCleanupMs: number
        finishedAt: number
        reviewId: string
        revision: number
        width: number
        height: number
        recipe: MergeRecipe
        registration: FrozenMergeEvidence['registration']
        preparationManifests: Awaited<ReturnType<typeof preparationManifests>>
        task: BackgroundTask
        publishedAsset: HdrWorkingAsset
      }[] = []
    await mkdir(libraries, { recursive: true })
    try {
      for (let iteration = 0; iteration < 3; iteration++) {
        const attempt: AttemptEvidence = {
          iteration,
          phase: 'setup',
          managedOriginalsBefore: [],
          managedOriginalsAfter: [],
        }
        attempts.push(attempt)
        const retained: Record<string, unknown> = { attempt }
        const root = await mkdtemp(join(libraries, `luma-three-${mode}-`))
        let observe = () => {}
        const library = new PhotoLibrary(
          root,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
          () => observe(),
          undefined,
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
          undefined,
          resolve('out/main/merge-worker.js'),
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
        )
        let timer: ReturnType<typeof setTimeout> | undefined,
          taskId = '',
          cleanupFailure: { error: unknown } | undefined
        try {
          await library.open()
          // Import copying, hashes and metadata inspection are setup. Every timed
          // operation still freshly verifies managed capture facts and decodes RAW.
          const db = new DatabaseSync(join(root, 'catalog.sqlite'))
          try {
            for (const original of originals) {
              const directory = join(root, 'originals', original.sha256),
                path = join(directory, 'original.arw')
              await mkdir(directory, { recursive: true })
              await cp(original.path, path)
              const identity = await fileIdentity(path)
              attempt.managedOriginalsBefore.push({ filename: original.name, ...identity })
              expect(identity).toEqual({
                sha256: original.sha256,
                bytes: original.bytes,
              })
              db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
                original.sha256,
                '2026-10-16T00:00:00.000Z',
                JSON.stringify({
                  id: original.sha256,
                  filename: original.name,
                  format: 'ARW',
                  width: original.width,
                  height: original.height,
                  bytes: original.bytes,
                  importedAt: '2026-10-16T00:00:00.000Z',
                  thumbnailUrl: '',
                  previewUrl: '',
                  previewSource: 'decoded',
                }),
              )
              db.prepare('INSERT INTO processing VALUES (?, ?)').run(
                original.sha256,
                JSON.stringify({
                  processing: 'hdr-v1',
                  metadata: original.metadata,
                  settings: automaticLensSettings,
                  revision: 0,
                }),
              )
            }
          } finally {
            db.close()
          }
          expect(await entries(join(root, 'merge-reviews'))).toEqual([])
          attempt.phase = 'create-review'
          const started = performance.now(),
            review = await library.createMergeReview(
              originals.map((source) => source.sha256),
              mode,
            ),
            reviewCreated = performance.now()
          attempt.createReviewMs = reviewCreated - started
          attempt.reviewId = review.id
          attempt.revision = review.revision
          attempt.phase = 'native-review'
          const preview = await library.requestMergePreview(review.id, review.revision),
            nativeReady = performance.now()
          attempt.nativeReviewMs = nativeReady - reviewCreated
          retained.preview = preview
          attempt.phase = 'diagnostic-snapshot'
          const preparedDirectory = join(root, 'merge-reviews', review.id, 'prepared'),
            registration = JSON.parse(
              await readFile(
                join(root, 'merge-reviews', review.id, 'prepared', 'registration.json'),
                'utf8',
              ),
            ) as FrozenMergeEvidence['registration']
          retained.registration = registration
          const manifests = await preparationManifests(preparedDirectory),
            publicationStarted = performance.now()
          attempt.diagnosticSnapshotMs = publicationStarted - nativeReady
          retained.preparationManifests = manifests
          attempt.phase = 'publication'
          const completed = new Promise<{ task: BackgroundTask; at: number }>((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Three-RAW publication did not finish.')),
              180000,
            )
            observe = () => {
              const task = library.listTasks().find((task) => task.id === taskId)
              if (!task?.finishedAt) return
              // PhotoLibrary emits this immediate library event after worker exit,
              // durable publication and awaited review scratch cleanup. Polling
              // intervals and the later status-bar notification are not the clock.
              resolve({ task: structuredClone(task), at: performance.now() })
            }
          })
          taskId = library.startMerge(review.id, review.revision)
          attempt.taskId = taskId
          observe()
          const { task, at } = await completed
          clearTimeout(timer)
          timer = undefined
          observe = () => {}
          const completeOperationMs = at - started
          attempt.completeOperationMs = completeOperationMs
          attempt.publicationAndCleanupMs = at - publicationStarted
          retained.task = task
          retained.errors = library.taskErrors(taskId)
          attempt.phase = 'quality'
          expect(task.status, JSON.stringify(library.taskErrors(taskId))).toBe('completed')
          expect(preview.reviewId).toBe(review.id)
          expect(preview.revision).toBe(review.revision)
          expect(review.revision).toBe(0)
          expect(preview.recipe.resolution).toBe('native')
          expect(preview.recipe.settings).toEqual(review.settings)
          expect(preview.recipe.settings).toMatchObject({
            mode,
            autoAlign: true,
            autoCrop: true,
            deghost: true,
          })
          expect(new Set(preview.recipe.sources.map((source) => source.id))).toEqual(
            new Set(originals.map((source) => source.sha256)),
          )
          expect(
            preview.recipe.measurements!.preparation.every((p) => p.backend === 'gpu' && !p.reused),
          ).toBe(true)
          expect(task.mergeMeasurements!.accumulation.backend).toBe('gpu')
          expect(task.mergeMeasurements!.output?.backend).toBe('gpu')
          expect(Boolean(manifests.referenceFallback)).toBe(
            Boolean(preview.recipe.measurements?.referenceFallback),
          )
          expect(library.getActiveMergeReview()).toBeNull()
          expect(await entries(join(root, 'merge-reviews'))).toEqual([])
          expect(await entries(join(root, 'merge-publications'))).toEqual([])
          const { manifest: published, reproducible } = await library.getMergeProvenance(
            task.resultPhotoId!,
          )
          retained.publishedAsset = published.asset
          expect(reproducible).toBe(true)
          expect(published.recipe).toEqual(preview.recipe)
          expect(published.asset.width).toBe(preview.width)
          expect(published.asset.height).toBe(preview.height)
          expect(Math.max(preview.width, preview.height)).toBeGreaterThan(5000)
          expect(published.asset.byteLength).toBe(
            published.asset.width * published.asset.height * 16,
          )
          await verifyMaster(join(root, 'originals', task.resultPhotoId!), published)
          const catalog = new DatabaseSync(join(root, 'catalog.sqlite'))
          try {
            expect(
              catalog.prepare('SELECT COUNT(*) AS count FROM merge_publications').get(),
            ).toEqual({ count: 0 })
          } finally {
            catalog.close()
          }
          for (const original of originals) {
            const identity = await fileIdentity(
              join(root, 'originals', original.sha256, 'original.arw'),
            )
            attempt.managedOriginalsAfter.push({ filename: original.name, ...identity })
            expect(identity).toEqual({ sha256: original.sha256, bytes: original.bytes })
          }
          samples.push({
            iteration,
            completeOperationMs,
            createReviewMs: reviewCreated - started,
            nativeReviewMs: nativeReady - reviewCreated,
            diagnosticSnapshotMs: publicationStarted - nativeReady,
            publicationAndCleanupMs: at - publicationStarted,
            finishedAt: task.finishedAt!,
            reviewId: review.id,
            revision: review.revision,
            width: preview.width,
            height: preview.height,
            recipe: preview.recipe,
            registration,
            preparationManifests: manifests,
            task,
            publishedAsset: published.asset,
          })
          attempt.phase = 'complete'
        } catch (error) {
          attempt.error = errorEvidence(error)
          if (taskId) {
            retained.task = library.listTasks().find((task) => task.id === taskId)
            retained.errors = library.taskErrors(taskId)
          }
          throw error
        } finally {
          if (timer) clearTimeout(timer)
          observe = () => {}
          try {
            await library.close()
            await rm(root, { recursive: true, force: true })
          } catch (error) {
            attempt.cleanupError = errorEvidence(error)
            cleanupFailure = { error }
          } finally {
            const runEvidence = info.outputPath(`three-raw-${mode}-${iteration}.json`)
            await writeFile(runEvidence, JSON.stringify(retained, null, 2))
            await info.attach(`three-raw-${mode}-${iteration}`, {
              path: runEvidence,
              contentType: 'application/json',
            })
          }
        }
        if (cleanupFailure) throw cleanupFailure.error
      }
      expect(samples).toHaveLength(3)
      for (const sample of samples) {
        const measured = sample.recipe.measurements
        expect(measured?.peak.gpuBytes).toBeLessThanOrEqual(1024 ** 3)
        expect(measured?.peak.wasmBytes).toBeLessThanOrEqual(512 * 1024 ** 2)
        if (mode === 'hdr' && process.env.LUMA_MERGE_CPU_KERNEL === 'wasm') {
          for (const prepared of measured!.preparation)
            expect(prepared.work?.cpuKernel?.backend, 'Requested SIMD preparation ran').toBe(
              'wasm-simd',
            )
          expect(
            measured?.referenceFallback?.work?.cpuKernel?.backend,
            'Requested SIMD highlight fallback ran',
          ).toBe('wasm-simd')
          if (process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES)
            expect(measured?.referenceFallback?.work?.cpuKernel?.gainCacheEntries).toBe(
              Number(process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES),
            )
        }
        if (process.env.LUMA_MERGE_OUTPUT_SLOTS) {
          expect(measured?.output?.backend).toBe('gpu')
          expect(measured?.output?.conversion?.slots).toBe(
            Number(process.env.LUMA_MERGE_OUTPUT_SLOTS),
          )
          expect(measured?.output?.conversion?.pendingPeak).toBeLessThanOrEqual(2)
        }
      }
      if (baseline)
        for (const [index, sample] of samples.entries()) {
          expect(frozenIdentity(sample), `${mode} run ${index + 1} frozen baseline`).toEqual(
            frozenIdentity(baseline.samples[index]),
          )
          if (baseline.samples[index].preparationManifests)
            expect(
              digest(preparationIdentity(sample.preparationManifests)),
              `${mode} run ${index + 1} prepared linear, camera-channel, clipping and fallback evidence`,
            ).toBe(digest(preparationIdentity(baseline.samples[index].preparationManifests)))
        }
      for (const sample of samples)
        expect(sample.completeOperationMs, `${mode} run ${sample.iteration + 1}`).toBeLessThan(5000)
    } catch (error) {
      failures.push(error)
    } finally {
      const after = []
      for (const original of originals) {
        try {
          const identity = await fileIdentity(original.path)
          after.push({ filename: basename(original.path), ...identity })
          expect(
            identity,
            `Committed fixture changed after ${mode} runs: ${original.name}`,
          ).toEqual({
            sha256: original.sha256,
            bytes: original.bytes,
          })
        } catch (error) {
          failures.push(error)
        }
      }
      const measurements = {
          mode,
          sources: 3,
          runs: samples.length,
          freshLibrariesAndWorkers: true,
          distinctSonySequence: true,
          repeatedRawCalibration: false,
          frozenReviewRevision: 0,
          includesRawDecoding: true,
          includesNativeReview: true,
          includesDurablePublication: true,
          includesReviewScratchCleanup: true,
          excludesImportCopyAndMetadataSetup: true,
          includesFreshManagedCaptureVerification: true,
          includesDiagnosticSnapshot: true,
          includesElectronPresentation: false,
          experiment: {
            outputSlots: process.env.LUMA_MERGE_OUTPUT_SLOTS ?? 'default',
            gpuTimestamps: process.env.LUMA_MERGE_GPU_TIMESTAMPS === '1',
            cpuKernel: process.env.LUMA_MERGE_CPU_KERNEL ?? 'default',
            gainCacheEntries: process.env.LUMA_MERGE_GAIN_CACHE_ENTRIES ?? 'default',
          },
          publicationFilesystem: 'project-filesystem',
          clock:
            'performance.now before createMergeReview through immediate finished task event after cleanup',
          maximumCompleteOperationMs: samples.length
            ? Math.max(...samples.map((sample) => sample.completeOperationMs))
            : null,
          originalsBefore: originals.map(({ name, sha256, bytes }) => ({
            filename: name,
            sha256,
            bytes,
          })),
          originalsAfter: after,
          attempts,
          failures: failures.map(errorEvidence),
          samples,
          baseline: baseline ? { path: baseline.path, sha256: baseline.sha256 } : null,
          provenance: source,
        },
        evidence = info.outputPath(`merge-three-raw-${mode}.json`)
      await writeFile(evidence, JSON.stringify(measurements, null, 2))
      await recordBenchmark(info, {
        family: 'merge',
        measurements: {
          ...measurements,
          samples: samples.map((sample, index) => ({
            iteration: sample.iteration,
            completeOperationMs: sample.completeOperationMs,
            createReviewMs: sample.createReviewMs,
            nativeReviewMs: sample.nativeReviewMs,
            diagnosticSnapshotMs: sample.diagnosticSnapshotMs,
            publicationAndCleanupMs: sample.publicationAndCleanupMs,
            width: sample.width,
            height: sample.height,
            masterSha256: sample.publishedAsset.sha256,
            masterStripsSha256: digest(sample.publishedAsset.strips),
            motionMaskSha256: sample.recipe.maskSha256,
            registrationSha256: digest(
              normalizedRegistration(JSON.parse(sample.registration.data)),
            ),
            peak: sample.task.mergeMeasurements?.peak,
            stages: sample.task.mergeMeasurements?.stages,
            preparation: sample.recipe.measurements?.preparation.map((source) => ({
              backend: source.backend,
              reused: source.reused,
              decodingMs: source.decodingMs,
              preparationMs: source.preparationMs,
            })),
            accumulationBackend: sample.task.mergeMeasurements?.accumulation.backend,
            outputBackend: sample.task.mergeMeasurements?.output?.backend,
            baselineMatches: baseline
              ? digest(frozenIdentity(sample)) === digest(frozenIdentity(baseline.samples[index]))
              : null,
          })),
        },
        gates: [{ metric: 'maximumCompleteOperationMs', operator: '<', limit: 5000 }],
        evidence: [evidence],
      })
    }
    if (failures.length) throw failures[0]
  })
