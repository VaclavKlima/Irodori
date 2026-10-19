import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import { sustainedEditorInput, type WorkabilitySlider } from './mac-workability.helpers'
import { provenance } from '../scripts/research/pipeline/provenance'
import type { BackgroundTask, TaskErrorPage } from '../src/shared/contracts'
import type { ExportPreparation, ExportResult } from '../src/shared/export'
import { HDR_PRESENTATION_BUDGET } from '../src/renderer/src/preview/hdr-memory'
import { ACES_INTERACTIVE_PREVIEW_VERSION } from '../src/shared/aces-preview-wgsl'
import { verifyMaster } from '../src/main/merge/store'
import type { MergeDiagnostics, MergeManifest } from '../src/shared/merge'

const reason =
  'Matched editor/task trials measure visible GPU presentation and native input cadence under actual work.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })

type Workload = 'import' | 'export-individual' | 'export-batch' | 'merge' | 'merge-hdr'
type InputTrial = Awaited<ReturnType<typeof sustainedEditorInput>>
type EditorResult = {
  trial?: InputTrial
  settledAtEpochMs: number
  allocatedBytes?: number
  policy?: string | null
  error?: string
}
interface PreparedOperation {
  workload: Workload
  sourceIds: string[]
  sessionId?: string
  exportPreparation?: ExportPreparation
  destinationId?: string
}
interface OperationResult {
  publishedMaster?: { asset: MergeManifest['asset']; verified: boolean }
  workload: Workload
  startedAtEpochMs: number
  acceptedAtEpochMs?: number
  previewReadyAtEpochMs?: number
  finishedAtEpochMs?: number
  settledAtEpochMs: number
  durationMs: number
  task?: BackgroundTask
  taskErrors?: TaskErrorPage
  mergeDiagnostics?: MergeDiagnostics
  exportResults?: { results: ExportResult[]; total: number }
  frozenExport?: ExportPreparation
  error?: string
  samples: {
    atEpochMs: number
    status: BackgroundTask['status'] | MergeDiagnostics['status']
    observation?: 'merge-preview-diagnostics' | 'background-task'
    reviewId?: string
    reviewRevision?: number
    sourceCount?: number
    phase?: string
    waitingReason?: BackgroundTask['waitingReason']
    completed?: number
    copiedBytes?: number
    prepared?: number
  }[]
}
interface SourceChange {
  atEpochMs: number
  filename: string | null
}
interface SourceIntegrity {
  phase: 'before' | 'after'
  filename: string
  expected: { sha256: string; bytes: number }
  fixture?: { sha256: string; bytes: number }
  managed?: { sha256: string; bytes: number }
  error?: string
}
interface MatchedTrial {
  repetition: number
  idleEditor?: EditorResult
  idleTask?: OperationResult
  editing?: EditorResult
  editingTask?: OperationResult
  sourceChanges?: SourceChange[]
  error?: string
  cleanupErrors: string[]
}

async function runOperation(page: Page, prepared: PreparedOperation): Promise<OperationResult> {
  return page.evaluate(async (prepared) => {
    const now = () => performance.timeOrigin + performance.now()
    const result: OperationResult = {
      workload: prepared.workload,
      startedAtEpochMs: now(),
      settledAtEpochMs: 0,
      durationMs: 0,
      frozenExport: prepared.exportPreparation,
      samples: [],
    }
    let taskId: string | undefined
    try {
      if (prepared.workload === 'import') {
        await window.luma.importSelected(prepared.sessionId!)
        taskId = prepared.sessionId!
      } else if (prepared.workload === 'merge' || prepared.workload === 'merge-hdr') {
        const review = await window.luma.createMergeReview(
          prepared.sourceIds,
          prepared.workload === 'merge-hdr' ? 'hdr' : 'noise',
        )
        let previewSettled = false,
          previewFailed = false,
          previewFailure: unknown
        const previewWork = window.luma.requestMergePreview(review.id, review.revision).then(
          () => {
            previewSettled = true
          },
          (error) => {
            previewSettled = true
            previewFailed = true
            previewFailure = error
          },
        )
        const previewDeadline = performance.now() + 180000
        try {
          do {
            const diagnostics = await window.luma.getMergeDiagnostics(review.id, review.revision)
            result.samples.push({
              atEpochMs: now(),
              status: diagnostics.status,
              observation: 'merge-preview-diagnostics',
              phase: 'merge-preview',
              reviewId: diagnostics.reviewId,
              reviewRevision: diagnostics.revision,
              sourceCount: diagnostics.sources.length,
            })
            if (!previewSettled) {
              if (performance.now() > previewDeadline) {
                await window.luma.disposeMergeReview(review.id)
                throw new Error('Merge preview did not finish within three minutes.')
              }
              await new Promise<void>((accept) => setTimeout(accept, 50))
            }
          } while (!previewSettled)
        } finally {
          await previewWork
        }
        if (previewFailed) throw previewFailure
        result.previewReadyAtEpochMs = now()
        result.mergeDiagnostics = await window.luma.getMergeDiagnostics(review.id, review.revision)
        taskId = await window.luma.startMerge(review.id, review.revision)
      } else {
        taskId = await window.luma.startExport({
          preparationId: prepared.exportPreparation!.id,
          destinationId: prepared.destinationId!,
          action: 'maximum',
        })
      }
      result.acceptedAtEpochMs = now()
      const deadline = performance.now() + 180000
      while (performance.now() < deadline) {
        const task = (await window.luma.listTasks()).find((task) => task.id === taskId)
        if (!task) throw new Error(`Accepted ${prepared.workload} task disappeared.`)
        result.task = task
        result.samples.push({
          atEpochMs: now(),
          status: task.status,
          observation: 'background-task',
          phase: task.phase,
          waitingReason: task.waitingReason,
          completed: task.progress?.completed,
          copiedBytes: task.transfer?.bytes,
          prepared: task.transfer?.prepared,
        })
        if (task.finishedAt !== undefined) {
          result.finishedAtEpochMs = task.finishedAt
          result.taskErrors = await window.luma.getTaskErrors(taskId)
          if (prepared.workload.startsWith('export'))
            result.exportResults = await window.luma.getExportResults(taskId)
          break
        }
        // Observation polling does not throttle source copying or processing.
        await new Promise<void>((accept) => setTimeout(accept, 50))
      }
      if (result.finishedAtEpochMs === undefined)
        throw new Error(`${prepared.workload} did not finish within three minutes.`)
    } catch (error) {
      result.error = String(error)
      if (taskId) {
        result.task = (await window.luma.listTasks()).find((task) => task.id === taskId)
        result.taskErrors = await window.luma.getTaskErrors(taskId).catch(() => undefined)
      }
    }
    result.settledAtEpochMs = now()
    result.durationMs =
      (result.finishedAtEpochMs ?? result.settledAtEpochMs) - result.startedAtEpochMs
    return result
  }, prepared)
}

async function editorTrial(page: Page, label: WorkabilitySlider): Promise<EditorResult> {
  try {
    const trial = await sustainedEditorInput(page, { label, zoom: 'fit', frequency: 60 })
    const canvas = page.getByTestId('main-preview')
    return {
      trial,
      settledAtEpochMs: Date.now(),
      allocatedBytes: Number(await canvas.getAttribute('data-allocated-bytes')),
      policy: await canvas.getAttribute('data-interactive-policy'),
    }
  } catch (error) {
    return { error: String(error), settledAtEpochMs: Date.now() }
  }
}

async function startSourceObserver(page: Page) {
  await page.evaluate(() => {
    const filename = document.querySelector<HTMLElement>('[data-testid="preview-filename"]')!
    const changes: SourceChange[] = []
    const observer = new MutationObserver(() => {
      changes.push({
        atEpochMs: performance.timeOrigin + performance.now(),
        filename: filename.textContent,
      })
    })
    observer.observe(filename, { childList: true, characterData: true, subtree: true })
    Object.assign(window, { workabilitySourceObserver: { observer, changes } })
  })
}
async function stopSourceObserver(page: Page): Promise<SourceChange[]> {
  return page.evaluate(() => {
    const host = window as unknown as {
      workabilitySourceObserver?: { observer: MutationObserver; changes: SourceChange[] }
    }
    const state = host.workabilitySourceObserver
    state?.observer.disconnect()
    delete host.workabilitySourceObserver
    return state?.changes ?? []
  })
}

function changedEditorPresentations(trial: InputTrial) {
  const changed: InputTrial['presentations'] = [],
    seen = new Set<number>()
  let previousValue: number | undefined
  for (const frame of [...trial.presentations].sort((a, b) => a.at - b.at)) {
    const value = trial.inputs[frame.serial].value
    if (seen.has(frame.serial) || value === previousValue) continue
    seen.add(frame.serial)
    previousValue = value
    changed.push(frame)
  }
  return changed
}
function changedEditorMetrics(trial: InputTrial) {
  const changed = changedEditorPresentations(trial)
  const visible = changed.filter((frame) => frame.at <= trial.inputReleasedAt)
  const boundaries = [
    trial.inputs[0].at,
    ...visible.map((frame) => frame.at),
    trial.inputReleasedAt,
  ]
  // A first response that arrives only after release is still interaction latency.
  // The changed-input set already excludes duplicate canonical refinement.
  const latencies = changed.map((frame) => frame.latencyMs).sort((a, b) => a - b)
  const quantile = (p: number) =>
    latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null
  const rate = (visible.length * 1000) / (trial.inputReleasedAt - trial.inputs[0].at)
  return {
    latencyPolicy: 'first-visible-changed-input-v1',
    changedPresentationCount: changed.length,
    duplicatePresentationCount: trial.presentations.length - changed.length,
    visibleUpdatesPerSecond: rate,
    visibleUpdateShortfall: Math.max(0, 55 - rate),
    longestPresentationGapMs: Math.max(
      0,
      ...boundaries.slice(1).map((at, i) => at - boundaries[i]),
    ),
    interactionLatencyP95Ms: quantile(0.95),
    interactionLatencyP99Ms: quantile(0.99),
    interactionLatencyMaximumMs: latencies.at(-1) ?? null,
  }
}
function editorMetrics(editor?: EditorResult) {
  if (!editor?.trial) return { error: editor?.error ?? 'Missing editor trial.' }
  const { inputs, requests, presentations, histograms, gpuObservations, ...metrics } = editor.trial
  return {
    ...metrics,
    ...changedEditorMetrics(editor.trial),
    rawPresentationMetrics: {
      visibleUpdatesPerSecond: metrics.visibleUpdatesPerSecond,
      longestPresentationGapMs: metrics.longestPresentationGapMs,
      interactionLatencyP95Ms: metrics.interactionLatencyP95Ms,
      interactionLatencyP99Ms: metrics.interactionLatencyP99Ms,
      interactionLatencyMaximumMs: metrics.interactionLatencyMaximumMs,
    },
    inputCount: inputs.length,
    observedRequestCount: requests.length,
    presentationCount: presentations.length,
    histogramCount: histograms.length,
    observedGpuSampleCount: gpuObservations.length,
    presentationsDuringInput: metrics.completedDuringInput,
    settledAtEpochMs: editor.settledAtEpochMs,
    allocatedBytes: editor.allocatedBytes,
    policy: editor.policy,
  }
}
function overlap(editor?: EditorResult, operation?: OperationResult) {
  if (!editor?.trial || !operation) return null
  const { trial } = editor,
    first = trial.epochMs + trial.inputs[0].at,
    last = trial.epochMs + trial.inputReleasedAt,
    end = operation.finishedAtEpochMs ?? operation.settledAtEpochMs,
    overlapStart = Math.max(first, operation.startedAtEpochMs),
    overlapEnd = Math.min(last, end),
    durationMs = Math.max(0, overlapEnd - overlapStart),
    within = (at: number) =>
      at + trial.epochMs >= operation.startedAtEpochMs && at + trial.epochMs <= end,
    inputCount = trial.inputs.filter((input) => within(input.at)).length,
    contended = changedEditorPresentations(trial).filter((frame) =>
      within(trial.inputs[frame.serial].at),
    ),
    visibleDuringOverlap = contended.filter(
      (frame) => frame.at + trial.epochMs >= overlapStart && frame.at + trial.epochMs <= overlapEnd,
    ),
    boundaries = [
      overlapStart,
      ...visibleDuringOverlap.map((frame) => frame.at + trial.epochMs),
      overlapEnd,
    ],
    contendedLatencies = contended.map((frame) => frame.latencyMs).sort((a, b) => a - b),
    quantile = (p: number) =>
      contendedLatencies.length
        ? contendedLatencies[Math.ceil(contendedLatencies.length * p) - 1]
        : null
  return {
    definition:
      'Dispatched operation interval, including preparation and scheduler waits; not simultaneous computation.',
    operationStartedAtEpochMs: operation.startedAtEpochMs,
    operationFinishedAtEpochMs: end,
    inputStartedAtEpochMs: first,
    inputFinishedAtEpochMs: last,
    durationMs,
    visibleUpdatesPerSecond: durationMs ? (visibleDuringOverlap.length * 1000) / durationMs : 0,
    visibleUpdateShortfall: Math.max(
      0,
      55 - (durationMs ? (visibleDuringOverlap.length * 1000) / durationMs : 0),
    ),
    longestPresentationGapMs: durationMs
      ? Math.max(0, ...boundaries.slice(1).map((at, i) => at - boundaries[i]))
      : 0,
    changedVisiblePresentationsDuringOverlap: visibleDuringOverlap.length,
    latencyObservation:
      'First visible changed-input responses retain their full latency even when presentation occurs after release or task completion; duplicate canonical refinement is excluded, and visible rate/gaps use only the actual overlap interval.',
    inputCount,
    inputFraction: inputCount / trial.inputs.length,
    contendedPresentationCount: contended.length,
    contendedLatencyP95Ms: quantile(0.95),
    contendedLatencyP99Ms: quantile(0.99),
    contendedLatencyMaximumMs: contendedLatencies.at(-1) ?? null,
    fullInputOverlap: inputCount === trial.inputs.length,
    presentations: trial.presentations.filter((frame) => within(frame.at)).length,
    sharpPresentations: trial.presentations.filter(
      (frame) => within(frame.at) && frame.quality === 'normal',
    ).length,
    draftPresentations: trial.presentations.filter(
      (frame) => within(frame.at) && frame.quality === 'draft',
    ).length,
    histograms: trial.histograms.filter((histogram) => within(histogram.at)).length,
    progressSamplesDuringInput: operation.samples.filter(
      (sample) => sample.atEpochMs >= first && sample.atEpochMs <= last,
    ),
    previewSamplesDuringInput: operation.samples.filter(
      (sample) =>
        sample.observation === 'merge-preview-diagnostics' &&
        sample.atEpochMs >= first &&
        sample.atEpochMs <= last,
    ),
    progressObservationLimit:
      'Merge diagnostics expose pending/ready/failed review status, not per-stage hardware progress. Background task samples retain actual counters and scheduler waiting reasons.',
  }
}

const allSliders: WorkabilitySlider[] = [
  'Exposure',
  'Contrast',
  'Highlights',
  'Shadows',
  'Whites',
  'Blacks',
  'Temperature',
  'Tint',
]
const selectedSliders = process.env.LUMA_RESPONSIVENESS_SLIDERS?.split(',').map((value) =>
  value.trim(),
)
if (
  selectedSliders &&
  (selectedSliders.some((value) => !allSliders.includes(value as WorkabilitySlider)) ||
    new Set(selectedSliders).size !== selectedSliders.length)
)
  throw new Error('LUMA_RESPONSIVENESS_SLIDERS must contain distinct known slider labels.')
const sliders = (selectedSliders ?? ['Exposure']) as WorkabilitySlider[]
const matrixPartial = sliders.length !== allSliders.length
if (!['reference', 'f32'].includes(process.env.VITE_LUMA_HDR_INTERACTIVE_PRECISION ?? 'reference'))
  throw new Error('VITE_LUMA_HDR_INTERACTIVE_PRECISION must be unset, reference or f32.')
const precision =
  process.env.VITE_LUMA_HDR_INTERACTIVE_PRECISION === 'f32'
    ? ACES_INTERACTIVE_PREVIEW_VERSION
    : 'reference'

for (const workload of ['import', 'export-individual', 'export-batch', 'merge'] as Workload[])
  for (const label of sliders)
    test(
      `${workload} ${label}: three matched responsive editing trials at 60Hz, 1440x900 Fit`,
      foregroundTest(reason),
      async ({ luma }, info) => {
        test.setTimeout(1200000)
        const { app, page } = luma,
          mergeWorkload = workload === 'merge' || workload === 'merge-hdr',
          editorStartDelayMs = workload === 'merge-hdr' ? 6000 : 0,
          manifest = JSON.parse(
            await readFile('tests/fixtures/research-sony/manifest.json', 'utf8'),
          ) as {
            sequences: { id: string; files: string[]; mode: string; complete: boolean }[]
            files: { name: string; path: string; sha256: string; bytes: number }[]
          },
          burst = manifest.sequences.find((sequence) => sequence.id === 'noise-burst')!.files,
          selected =
            workload === 'merge-hdr'
              ? manifest.sequences.find((sequence) => sequence.id === 'hdr-brk')!.files
              : Array.from(
                  { length: 9 },
                  (_, i) => burst[Math.round((i * (burst.length - 1)) / 8)],
                ),
          originals = selected.map((name) => {
            const entry = manifest.files.find((file) => file.name === name)!
            return { ...entry, path: resolve('tests/fixtures/research-sony', entry.path) }
          }),
          trash = await isolateTrash(app),
          destination = info.outputPath('exports'),
          evidencePath = info.outputPath('interference.json'),
          trials: MatchedTrial[] = [],
          sourceIntegrity: SourceIntegrity[] = []
        if (workload === 'merge-hdr') {
          expect(manifest.sequences.find((sequence) => sequence.id === 'hdr-brk')).toMatchObject({
            mode: 'hdr',
            complete: true,
          })
          expect(originals).toHaveLength(3)
          expect(new Set(originals.map((source) => source.sha256)).size).toBe(3)
        }
        await mkdir(destination, { recursive: true })
        await (
          await app.browserWindow(page)
        ).evaluate((window) => {
          window.unmaximize()
          window.setContentSize(1440, 900)
        })
        await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
        if ((await page.getByTestId('console-toggle').getAttribute('aria-expanded')) === 'true')
          await page.getByTestId('console-toggle').click()
        if (workload !== 'import') {
          await importPhotos(
            app,
            page,
            originals.map((source) => source.path),
            false,
          )
          // The prior import's retained status can still be visible after accepting this one.
          // Freeze benchmark sources only after every required record is published and work ends.
          await expect
            .poll(
              () =>
                page.evaluate(async () => ({
                  names: (await window.luma.listPhotos()).photos
                    .map((photo) => photo.filename)
                    .sort(),
                  running: (await window.luma.listTasks()).some(
                    (task) => task.status === 'running' || task.status === 'cancelling',
                  ),
                })),
              { timeout: 60000 },
            )
            .toEqual({
              names: ['sony-zv1.ARW', ...originals.map((source) => source.name)].sort(),
              running: false,
            })
        }
        const photos = (await page.evaluate(() => window.luma.listPhotos())).photos,
          editorId = photos.find((photo) => photo.filename === 'sony-zv1.ARW')!.id,
          sourceIds = originals.map(
            (source) => photos.find((photo) => photo.filename === source.name)?.id,
          )
        if (workload !== 'import') expect(sourceIds.every(Boolean)).toBe(true)
        const retained = new Set(photos.map((photo) => photo.id))
        let destinationId: string | undefined, currentPreparation: PreparedOperation | undefined
        if (workload.startsWith('export')) {
          const capability = await page.evaluate(() => window.luma.getExportCapabilities())
          test.skip(
            !capability.hdrAvailable,
            capability.hdrUnavailableReason ?? 'HDR export unavailable.',
          )
          await app.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
          }, destination)
          destinationId = (await page.evaluate(() => window.luma.chooseExportDestination()))!.id
        }
        const environment = {
          provenance: {
            ...(await provenance([
              'tests/fixtures/sony-zv1.ARW',
              'tests/fixtures/research-sony/manifest.json',
              'tests/mac-workability.helpers.ts',
              'tests/editor-responsiveness-interference.spec.ts',
              'src/shared/aces-preview-wgsl.ts',
              ...originals.map((source) => source.path),
              ...(await readdir('out', { recursive: true }))
                .filter((path) => /\.(?:js|cjs|css|html)$/.test(path))
                .map((path) => join('out', path))
                .sort(),
              'src/renderer/src/preview/hdr-presenter.ts',
              'src/renderer/src/preview/hdr-shader.ts',
              'src/renderer/src/preview/hdr-gpu-timings.ts',
              'src/shared/display-rendering.ts',
              'src/shared/aces-wgsl.ts',
              'src/shared/display-rendering-wgsl.ts',
              'src/shared/aces-precision-wgsl.ts',
              'src/shared/aces-data.ts',
              ...(workload === 'merge-hdr'
                ? [
                    'tests/mac-workability-interference.spec.ts',
                    'src/main/merge/engine.ts',
                    'src/main/merge/prepare.ts',
                    'src/main/merge/gpu-camera-registration.ts',
                    'src/main/merge/gpu-reference-fallback.ts',
                    'src/main/merge/fallback-geometry.ts',
                    'src/main/merge/cpu-kernels.ts',
                    'src/main/merge/kernels/prepare.c',
                    'src/shared/merge.ts',
                    'vendor/merge-kernels/manifest.json',
                  ]
                : []),
            ])),
            build: 'Production Electron application and bundled processing workers.',
          },
          viewport: await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
          })),
          displays: await app.evaluate(({ screen }) =>
            screen.getAllDisplays().map((display) => ({
              bounds: display.bounds,
              scaleFactor: display.scaleFactor,
              displayFrequency: display.displayFrequency,
              colorSpace: display.colorSpace,
              internal: display.internal,
            })),
          ),
          consoleOpen: false,
          label,
          sliders,
          matrixPartial,
          precision,
          histogramPolicy:
            'Nonblocking independent analysis; historical 33 ms latency remains a separately reported metric; final identity/convergence required.',
          requestedHz: 60,
          inputsPerTrial: 240,
          sourceOriginals: originals.map(({ name, sha256 }) => ({ name, sha256 })),
          sourceIntegrity,
          workload,
          mergeSources: workload === 'merge' ? 9 : workload === 'merge-hdr' ? 3 : undefined,
          mergeMode: workload === 'merge-hdr' ? 'hdr' : undefined,
          editorStartDelayMs: workload === 'merge-hdr' ? editorStartDelayMs : undefined,
          editingOrder:
            workload === 'merge-hdr'
              ? 'Operation first; wait 6000 ms, then run the unchanged 240-input Exposure trial.'
              : undefined,
          requestedMergeBackends:
            workload === 'merge-hdr'
              ? await app.evaluate(() => ({
                  merge: process.env.LUMA_MERGE_BACKEND ?? 'auto',
                  camera: process.env.LUMA_MERGE_CAMERA_PREPARATION ?? 'cpu',
                  reference: process.env.LUMA_MERGE_REFERENCE_PREPARATION ?? 'cpu',
                }))
              : undefined,
          exportSources:
            workload === 'export-batch' ? 9 : workload === 'export-individual' ? 1 : undefined,
          importSources: workload === 'import' ? 9 : undefined,
          processing:
            'Actual unmodified originals; no I/O delays, process hooks or synthetic task stretching.',
          importTiming:
            'Acceptance through completion; source chooser and review scanning are outside the task clock.',
          mergeTiming:
            'Review creation, native preparation/alignment/comparison, and durable publication.',
          exportTiming:
            'Frozen quality-100 original-size HDR JPEG export through durable publication.',
          exportTargets:
            workload === 'export-individual'
              ? [originals[0].name]
              : workload === 'export-batch'
                ? originals.map((source) => source.name)
                : undefined,
        }
        const verifyHdrOriginals = async (
          phase: SourceIntegrity['phase'],
          managed = workload !== 'import',
        ) => {
          const editorFixture = {
            name: 'sony-zv1.ARW',
            path: resolve('tests/fixtures/sony-zv1.ARW'),
            sha256: '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
            bytes: (await stat('tests/fixtures/sony-zv1.ARW')).size,
          }
          for (const original of [...originals, editorFixture]) {
            const result: SourceIntegrity = {
              phase,
              filename: original.name,
              expected: { sha256: original.sha256, bytes: original.bytes },
            }
            sourceIntegrity.push(result)
            try {
              for (const [kind, path] of [
                ['fixture', original.path],
                [
                  'managed',
                  join(luma.userDataDir, 'library/originals', original.sha256, 'original.arw'),
                ],
              ] as const) {
                if (kind === 'managed' && !managed) continue
                const digest = createHash('sha256')
                for await (const bytes of createReadStream(path)) digest.update(bytes)
                result[kind] = { sha256: digest.digest('hex'), bytes: (await stat(path)).size }
                expect
                  .soft(result[kind], `${phase} ${original.name} ${kind}`)
                  .toEqual(result.expected)
              }
            } catch (error) {
              result.error = String(error)
              expect.soft(result.error, `${phase} ${original.name} integrity`).toBeUndefined()
            }
          }
        }
        await verifyHdrOriginals('before')
        const save = () =>
          writeFile(evidencePath, JSON.stringify({ ...environment, trials }, null, 2))
        const restoreEditor = async () => {
          if ((await page.getByTestId('preview-filename').textContent()) !== 'sony-zv1.ARW')
            await page.getByTestId(`photo-card-${editorId}`).click()
          await expect(page.getByTestId('preview-filename')).toHaveText('sony-zv1.ARW')
          await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
            timeout: 60000,
          })
          await page.evaluate(async (id) => {
            const state = await window.luma.getEdits(id)
            await window.luma.updateEdits(id, { exposureEv: 0 }, state.revision)
          }, editorId)
          await expect(page.getByTestId('main-preview')).toHaveAttribute('data-exposure', '0', {
            timeout: 30000,
          })
          await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal', {
            timeout: 30000,
          })
        }
        const prepare = async (): Promise<PreparedOperation> => {
          await restoreEditor()
          if (workload === 'import') {
            await app.evaluate(
              ({ dialog }, paths) => {
                dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
              },
              originals.map((source) => source.path),
            )
            const sessionId = await page.evaluate(() => window.luma.chooseSource('files', false))
            if (!sessionId) throw new Error('The import chooser did not create a review.')
            await expect
              .poll(
                () =>
                  page.evaluate(async (id) => {
                    const review = await window.luma.getReviewSummary(id)
                    return {
                      phase: review.phase,
                      pending: Boolean(review.verificationPending),
                      selected: review.selected,
                      errors: review.errors,
                    }
                  }, sessionId),
                { timeout: 60000 },
              )
              .toEqual({ phase: 'review', pending: false, selected: 9, errors: 0 })
            currentPreparation = { workload, sourceIds: [], sessionId }
            return currentPreparation
          }
          if (mergeWorkload) {
            currentPreparation = { workload, sourceIds: sourceIds as string[] }
            return currentPreparation
          }
          const ids = workload === 'export-individual' ? [sourceIds[0]!] : (sourceIds as string[])
          currentPreparation = {
            workload,
            sourceIds: ids,
            destinationId,
            exportPreparation: await page.evaluate((ids) => window.luma.prepareExport(ids), ids),
          }
          return currentPreparation
        }
        const cleanup = async (operation?: OperationResult) => {
          if (operation?.task?.status === 'completed' && workload === 'import')
            await verifyHdrOriginals('after', true)
          if (operation?.task?.resultPhotoId) {
            const provenance = await page.evaluate(
              (id) => window.luma.getMergeProvenance(id),
              operation.task.resultPhotoId,
            )
            await verifyMaster(
              join(luma.userDataDir, 'library/originals', operation.task.resultPhotoId),
              provenance.manifest,
            )
            Object.assign(operation, {
              publishedMaster: { asset: provenance.manifest.asset, verified: true },
            })
          }
          for (const task of await page.evaluate(() => window.luma.listTasks()))
            if (task.status === 'running' || task.status === 'cancelling')
              await page.evaluate((id) => window.luma.cancelTask(id), task.id)
          const review = await page.evaluate(() => window.luma.getActiveMergeReview())
          if (review) await page.evaluate((id) => window.luma.disposeMergeReview(id), review.id)
          if (currentPreparation?.exportPreparation)
            await page.evaluate(
              (id) => window.luma.disposeExportPreparation(id),
              currentPreparation.exportPreparation.id,
            )
          if (currentPreparation?.sessionId)
            await page.evaluate((id) => window.luma.disposeImport(id), currentPreparation.sessionId)
          currentPreparation = undefined
          if (operation?.task?.resultPhotoId) {
            const result = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
              (photo) => photo.id === operation.task!.resultPhotoId,
            )
            if (result)
              await expect(page.getByTestId('preview-filename')).toHaveText(result.filename, {
                timeout: 30000,
              })
          }
          await restoreEditor()
          const added = (await page.evaluate(() => window.luma.listPhotos())).photos.filter(
            (photo) => !retained.has(photo.id),
          )
          if (added.length) {
            const id = await page.evaluate(
              (ids) => window.luma.deletePhotos(ids),
              added.map((photo) => photo.id),
            )
            if (!id) throw new Error('Imported/result records did not enter isolated Trash.')
            await expect
              .poll(
                () =>
                  page.evaluate(
                    async (id) =>
                      (await window.luma.listTasks()).find((task) => task.id === id)?.status,
                    id,
                  ),
                { timeout: 60000 },
              )
              .toBe('completed')
          }
          await expect
            .poll(() => page.evaluate(async () => (await window.luma.listPhotos()).total))
            .toBe(retained.size)
          if (operation?.exportResults)
            for (const file of operation.exportResults.results)
              if (file.outputName) {
                const output = join(destination, file.outputName)
                const bytes = await readFile(output)
                Object.assign(file, {
                  publishedBytes: (await stat(output)).size,
                  publishedSha256: createHash('sha256').update(bytes).digest('hex'),
                  jpegSignaturesValid:
                    bytes[0] === 255 &&
                    bytes[1] === 216 &&
                    bytes.at(-2) === 255 &&
                    bytes.at(-1) === 217,
                })
                await rm(output)
              }
          for (const task of await page.evaluate(() => window.luma.listTasks()))
            if (task.finishedAt !== undefined)
              await page.evaluate((id) => window.luma.dismissTask(id), task.id)
          // This is the isolated adapter's directory, never the operating system Trash.
          await rm(trash, { recursive: true, force: true })
          await mkdir(trash, { recursive: true })
        }
        await save()
        for (let repetition = 0; repetition < 3; repetition++) {
          const trial: MatchedTrial = { repetition, cleanupErrors: [] }
          let editingWork: Promise<EditorResult> | undefined,
            operationWork: Promise<OperationResult> | undefined,
            idleCleaned = false
          trials.push(trial)
          try {
            await restoreEditor()
            trial.idleEditor = await editorTrial(page, label)
            await save()
            trial.idleTask = await runOperation(page, await prepare())
            await save()
            await cleanup(trial.idleTask)
            idleCleaned = true
            const prepared = await prepare()
            await startSourceObserver(page)
            if (workload === 'merge-hdr') {
              operationWork = runOperation(page, prepared)
              await page.waitForTimeout(editorStartDelayMs)
              editingWork = editorTrial(page, label)
            } else {
              editingWork = editorTrial(page, label)
              await page.waitForFunction(
                () =>
                  document.querySelector<HTMLElement>('[data-testid="main-preview"]')?.dataset
                    .gesturing === 'true',
                undefined,
                { timeout: 15000 },
              )
              operationWork = runOperation(page, prepared)
            }
            ;[trial.editing, trial.editingTask] = await Promise.all([editingWork, operationWork])
            trial.sourceChanges = await stopSourceObserver(page)
            await save()
          } catch (error) {
            trial.error = String(error)
          } finally {
            if (editingWork && !trial.editing) trial.editing = await editingWork
            if (operationWork && !trial.editingTask)
              trial.editingTask = await operationWork.catch((error) => {
                trial.error ??= String(error)
                return undefined
              })
            trial.sourceChanges ??= await stopSourceObserver(page).catch(() => [])
            await save()
            await cleanup(trial.editingTask ?? (idleCleaned ? undefined : trial.idleTask)).catch(
              (error) => trial.cleanupErrors.push(String(error)),
            )
            await save()
          }
        }
        await verifyHdrOriginals('after')
        const comparisons = trials.map((trial) => {
          const changedDuringEditor =
            trial.sourceChanges?.filter(
              (change) =>
                change.filename !== 'sony-zv1.ARW' &&
                change.atEpochMs <= (trial.editing?.settledAtEpochMs ?? 0),
            ) ?? []
          return {
            repetition: trial.repetition,
            idleEditor: editorMetrics(trial.idleEditor),
            editing: editorMetrics(trial.editing),
            idleTaskDurationMs: trial.idleTask?.durationMs,
            editingTaskDurationMs: trial.editingTask?.durationMs,
            taskDurationRatio:
              trial.editingTask && trial.idleTask
                ? trial.editingTask.durationMs / trial.idleTask.durationMs
                : null,
            overlap: overlap(trial.editing, trial.editingTask),
            operationToFirstInputMs:
              workload === 'merge-hdr' && trial.editing?.trial && trial.editingTask
                ? trial.editing.trial.epochMs +
                  trial.editing.trial.inputs[0].at -
                  trial.editingTask.startedAtEpochMs
                : undefined,
            mergeMeasurements:
              workload === 'merge-hdr'
                ? {
                    idle: trial.idleTask?.mergeDiagnostics?.measurements,
                    editing: trial.editingTask?.mergeDiagnostics?.measurements,
                  }
                : undefined,
            changedDuringEditor,
            expectedMergeAutoOpenInterruptedTrial: mergeWorkload && changedDuringEditor.length > 0,
          }
        })
        await writeFile(
          evidencePath,
          JSON.stringify({ ...environment, comparisons, trials }, null, 2),
        )
        await recordBenchmark(info, {
          family: 'hdr',
          measurements: { ...environment, comparisons },
          gates: comparisons.flatMap((trial) =>
            ['idleEditor', 'editing']
              .flatMap((mode) =>
                [
                  ['interactionLatencyP95Ms', 33],
                  ['interactionLatencyP99Ms', 50],
                  ['interactionLatencyMaximumMs', 100],
                  ['longestPresentationGapMs', 100],
                  ['visibleUpdateShortfall', 0],
                  ['refinementMs', 200],
                  ['allocatedBytes', HDR_PRESENTATION_BUDGET],
                ].map(([metric, limit]) => ({
                  metric: `${trial.repetition}.${mode}.${metric}`,
                  operator: '<=' as const,
                  limit: Number(limit),
                })),
              )
              .concat(
                [
                  ['contendedLatencyP95Ms', 33],
                  ['contendedLatencyP99Ms', 50],
                  ['contendedLatencyMaximumMs', 100],
                  ['longestPresentationGapMs', 100],
                  ['visibleUpdateShortfall', 0],
                ].map(([metric, limit]) => ({
                  metric: `${trial.repetition}.overlap.${metric}`,
                  operator: '<=' as const,
                  limit: Number(limit),
                })),
              ),
          ),
          evidence: [evidencePath],
        })
        expect(environment.viewport).toMatchObject({ width: 1440, height: 900 })
        expect(trials).toHaveLength(3)
        for (const trial of trials) {
          expect.soft(trial.error, `${workload} repetition ${trial.repetition}`).toBeUndefined()
          expect.soft(trial.cleanupErrors, `${workload} cleanup ${trial.repetition}`).toEqual([])
          for (const operation of [trial.idleTask, trial.editingTask]) {
            expect.soft(operation?.error, `${workload} task ${trial.repetition}`).toBeUndefined()
            expect
              .soft(operation?.task?.status, `${workload} task ${trial.repetition}`)
              .toBe('completed')
            expect
              .soft(operation?.taskErrors?.total, `${workload} errors ${trial.repetition}`)
              .toBe(0)
            if (workload === 'import') expect.soft(operation?.task?.outcomes?.imported).toBe(9)
            if (mergeWorkload) expect.soft(operation?.task?.resultPhotoId).toBeTruthy()
            if (mergeWorkload) expect.soft(operation?.publishedMaster?.verified).toBe(true)
            if (mergeWorkload)
              for (const measurements of [
                operation?.mergeDiagnostics?.measurements,
                operation?.task?.mergeMeasurements,
              ]) {
                expect
                  .soft(measurements?.preparation)
                  .toHaveLength(workload === 'merge-hdr' ? 3 : 9)
                expect.soft(measurements?.peak.gpuBytes).toBeLessThanOrEqual(1024 ** 3)
                expect.soft(measurements?.peak.wasmBytes).toBeLessThanOrEqual(512 * 1024 ** 2)
                if (environment.requestedMergeBackends?.reference === 'gpu') {
                  expect.soft(measurements?.referenceFallback?.backend).toBe('gpu')
                  expect
                    .soft(measurements?.referenceFallback?.work?.referencePreparation?.backend)
                    .toBe('gpu')
                  expect
                    .soft(measurements?.referenceFallback?.work?.referencePreparation?.fallback)
                    .toBeUndefined()
                }
              }
            if (workload.startsWith('export')) {
              const count = workload === 'export-individual' ? 1 : 9
              expect.soft(operation?.frozenExport?.targets).toHaveLength(count)
              expect.soft(operation?.exportResults?.total).toBe(count)
              expect
                .soft(operation?.exportResults?.results.every((file) => file.status === 'exported'))
                .toBe(true)
              expect
                .soft(
                  operation?.exportResults?.results.every((file) => {
                    const output = file as ExportResult & {
                      jpegSignaturesValid?: boolean
                      publishedBytes?: number
                      publishedSha256?: string
                    }
                    return (
                      output.jpegSignaturesValid === true &&
                      (output.publishedBytes ?? 0) > 0 &&
                      /^[a-f0-9]{64}$/.test(output.publishedSha256 ?? '')
                    )
                  }),
                )
                .toBe(true)
            }
          }
          const comparison = comparisons[trial.repetition]
          expect
            .soft(comparison.changedDuringEditor, `${workload} preserves the editor source`)
            .toEqual([])
          for (const [mode, editor] of [
            ['idle', trial.idleEditor],
            ['editing', trial.editing],
          ] as const) {
            const input = editor?.trial,
              context = `${workload} ${mode} repetition ${trial.repetition}`
            expect.soft(editor?.error, context).toBeUndefined()
            expect.soft(input?.error, context).toBeUndefined()
            expect.soft(input?.backend, context).toBe('webgpu-hdr')
            expect.soft(input?.inputs.length, context).toBe(240)
            expect.soft(input?.draft, context).toBe(0)
            expect
              .soft((input?.sharp ?? 0) + (input?.interactive ?? 0), context)
              .toBe(input?.completed)
            expect.soft(editor?.policy, context).toBe(precision)
            expect
              .soft(
                input?.presentations.every((frame) => frame.previewPolicy === precision),
                context,
              )
              .toBe(true)
            expect.soft(editor?.allocatedBytes, context).toBeGreaterThan(0)
            expect
              .soft(editor?.allocatedBytes, context)
              .toBeLessThanOrEqual(HDR_PRESENTATION_BUDGET)
            if (precision !== 'reference')
              expect.soft(input?.interactive, context).toBeGreaterThan(0)
            expect.soft(input?.regressed, context).toBe(false)
            expect.soft(input?.attributionFailures, context).toBe(0)
            expect.soft(input?.finalMatched, context).toBe(true)
            expect.soft(input?.histogramMatched, context).toBe(true)
            expect.soft(input?.loaders, context).toBe(0)
            expect.soft(input?.hidden, context).toBe(0)
            expect.soft(input?.sidebarMovement, context).toBeLessThan(0.1)
            expect.soft(input?.sourceUploads, context).toBe(1)
            expect.soft(input?.historyEntriesAdded, context).toBe(1)
          }
        }
        const underDriven = trials.some((trial) =>
          [trial.idleEditor, trial.editing].some(
            (editor) => editor?.trial && editor.trial.achievedHz < 59.4,
          ),
        )
        test.skip(
          underDriven || environment.viewport.dpr !== 2,
          'DPR 2 or 99% native 60 Hz input was not achieved; all complete task/overlap evidence is retained and configuration acceptance is incomplete.',
        )
        for (const trial of trials) {
          const actualOverlap = overlap(trial.editing, trial.editingTask)
          expect.soft(actualOverlap?.durationMs).toBeGreaterThanOrEqual(500)
          expect.soft(actualOverlap?.inputCount).toBeGreaterThan(0)
          expect.soft(actualOverlap?.progressSamplesDuringInput.length).toBeGreaterThan(0)
          expect.soft(actualOverlap?.contendedPresentationCount).toBeGreaterThanOrEqual(25)
          expect.soft(actualOverlap?.contendedLatencyP95Ms).not.toBeNull()
          expect.soft(actualOverlap?.contendedLatencyP95Ms).toBeLessThanOrEqual(33)
          expect.soft(actualOverlap?.contendedLatencyP99Ms).toBeLessThanOrEqual(50)
          expect.soft(actualOverlap?.contendedLatencyMaximumMs).toBeLessThanOrEqual(100)
          expect.soft(actualOverlap?.visibleUpdatesPerSecond).toBeGreaterThanOrEqual(55)
          expect.soft(actualOverlap?.longestPresentationGapMs).toBeLessThanOrEqual(100)
          for (const editor of [trial.idleEditor, trial.editing]) {
            const input = editor?.trial
            const changed = input ? changedEditorMetrics(input) : null
            expect.soft(changed?.interactionLatencyP95Ms).not.toBeNull()
            expect.soft(changed?.interactionLatencyP95Ms).toBeLessThanOrEqual(33)
            expect.soft(changed?.interactionLatencyP99Ms).not.toBeNull()
            expect.soft(changed?.interactionLatencyP99Ms).toBeLessThanOrEqual(50)
            expect.soft(changed?.interactionLatencyMaximumMs).not.toBeNull()
            expect.soft(changed?.interactionLatencyMaximumMs).toBeLessThanOrEqual(100)
            expect.soft(changed?.longestPresentationGapMs).toBeLessThanOrEqual(100)
            expect.soft(changed?.visibleUpdatesPerSecond).toBeGreaterThanOrEqual(55)
            expect.soft(input?.refinementMs).toBeLessThanOrEqual(200)
          }
        }
      },
    )
