import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ElectronApplication, JSHandle, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import { type WorkabilitySlider } from './mac-workability.helpers'
import { neutralAdjustments } from '../src/shared/adjustments'
import {
  confirmEditorDisplay,
  editorCaseSelection,
  editorConfigurationMatches,
  editorDisplayPreference,
  editorDisplayProfile,
  editorExpectedDpr,
  editorPhysicalDisplay,
  editorRequestedTileBatch,
  matchedEditorInput,
} from './editor-responsiveness-profile.helpers'
import { provenance } from '../scripts/research/pipeline/provenance'
import type { BackgroundTask, TaskErrorPage } from '../src/shared/contracts'
import type { ExportPreparation, ExportResult, ExportWorkerProgress } from '../src/shared/export'
import { assertHdrMemory, type HdrMemoryObservation } from './hdr-memory-policy.helpers'
import { hdrTestPolicy } from './hdr-test-policy.helpers'
import { verifyMaster } from '../src/main/merge/store'
import { maximizeEditorOnMonitor } from './editor-native-window.helpers'
import { observeMainSqlTiming } from './editor-main-sql.helpers'
import type { MergeDiagnostics, MergeManifest } from '../src/shared/merge'

const reason =
  'Matched editor/task trials measure visible GPU presentation and native input cadence under actual work.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })

type Workload = 'import' | 'export-individual' | 'export-batch' | 'merge' | 'merge-hdr'
type InputTrial = Awaited<ReturnType<typeof matchedEditorInput>>
interface RendererLongTaskTrace {
  supported: boolean
  clock: string
  startedAtEpochMs: number
  finishedAtEpochMs: number
  dropped: number
  entries: { name: string; atEpochMs: number; startTime: number; duration: number }[]
  animationFrames: {
    capacity: number
    dropped: number
    samples: {
      frameTime: number
      callbackAt: number
      atEpochMs: number
      deliveryLatenessMs: number
      frameDeltaMs: number | null
      callbackGapMs: number | null
    }[]
  }
}
interface MainSqlTimingTrace {
  clock: string
  slowMs: number
  maxEvents: number
  dropped: number
  observerErrors: number
  calls: { exec: number; run: number; unboundRun: number; mappedStatements: number }
  catalogConnectionIds: string[]
  events: { tag: string; startedAtEpochMs: number; endedAtEpochMs: number; durationMs: number }[]
  limitations: string[]
  restoredAll: boolean
  restoreConflicts: string[]
}
type EditorResult = {
  mainSql?: MainSqlTimingTrace
  longTasks?: RendererLongTaskTrace
  trial?: InputTrial
  settledAtEpochMs: number
  allocatedBytes?: number
  memory?: HdrMemoryObservation
  policy?: string | null
  sourceOwnership?: SourceOwnership
  error?: string
}
interface SourceState {
  sourceIdentity: string | null
  requestedSourceIdentity: string | null
  epoch: number
  requestedEpoch: number
  uploads: number
  cacheState: string | null
  loadCacheHit: number
  cacheEntries: number
  cacheRamBytes: number
  cacheGpuBytes: number
  backend: string | null
  editing: string | null
}
interface SourceOwnership {
  before: SourceState
  after: SourceState
  sameCanvas: boolean
  sameDevice: boolean
}
interface MergePauseTrace {
  pid: number
  argv: string[]
  clock: string
  boundary: string
  dropped: number
  events: { atEpochMs: number; type: 'pause' | 'resume'; sendReturned?: boolean; error?: string }[]
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
  exportProgressDropped?: number
  frozenExport?: ExportPreparation
  error?: string
  samples: {
    atEpochMs: number
    observedAtEpochMs?: number
    requestStartedAtEpochMs?: number
    responseAtEpochMs?: number
    taskId?: string
    progressUnit?: 'bytes' | 'items'
    exportProgress?: ExportWorkerProgress
    producedAtEpochMs?: number
    status: BackgroundTask['status'] | MergeDiagnostics['status']
    observation?:
      | 'merge-preview-diagnostics'
      | 'merge-worker-progress'
      | 'export-worker-progress'
      | 'background-task'
    reviewId?: string
    reviewRevision?: number
    sourceCount?: number
    phase?: string
    waitingReason?: BackgroundTask['waitingReason']
    completed?: number
    total?: number
    sequence?: number
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
  mergePauseTrace?: MergePauseTrace
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
    // This observation belongs only to the isolated benchmark page and current operation.
    Object.assign(window, { workabilityOperationProgress: result })
    let taskId: string | undefined
    const seenExportProgress = new Set<string>()
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
        let lastWorkerSequence = 0
        try {
          do {
            const diagnostics = await window.luma.getMergeDiagnostics(review.id, review.revision)
            const progress = diagnostics.workerProgress
            if (progress && progress.sequence > lastWorkerSequence) {
              lastWorkerSequence = progress.sequence
              result.samples.push({
                // The worker clock controls overlap; preserve when the poll observed it separately.
                atEpochMs: progress.producedAtEpochMs,
                observedAtEpochMs: now(),
                status: diagnostics.status,
                observation: 'merge-worker-progress',
                reviewId: diagnostics.reviewId,
                reviewRevision: diagnostics.revision,
                sourceCount: diagnostics.sources.length,
                ...progress,
              })
            }
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
        const requestStartedAtEpochMs = now()
        const task = (await window.luma.listTasks()).find((task) => task.id === taskId)
        const responseAtEpochMs = now()
        if (!task) throw new Error(`Accepted ${prepared.workload} task disappeared.`)
        result.task = task
        if (task.exportWorkerProgress) {
          result.exportProgressDropped = task.exportWorkerProgress.dropped
          for (const progress of task.exportWorkerProgress.events) {
            const key = [
              progress.exportId,
              progress.fileIndex,
              progress.attemptId,
              progress.sequence,
            ].join(':')
            if (seenExportProgress.has(key)) continue
            seenExportProgress.add(key)
            result.samples.push({
              atEpochMs: progress.producedAtEpochMs,
              producedAtEpochMs: progress.producedAtEpochMs,
              observedAtEpochMs: responseAtEpochMs,
              status: task.status,
              observation: 'export-worker-progress',
              phase: progress.phase,
              completed: progress.completed,
              total: progress.total,
              sequence: progress.sequence,
              exportProgress: progress,
            })
          }
        }
        result.samples.push({
          atEpochMs: responseAtEpochMs,
          requestStartedAtEpochMs,
          responseAtEpochMs,
          taskId,
          observedAtEpochMs: responseAtEpochMs,
          progressUnit: task.progress?.unit,
          total: task.progress?.total,
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

async function editorTrial(
  page: Page,
  label: WorkabilitySlider,
  app: ElectronApplication,
  isolatedUserDataDir: string,
): Promise<EditorResult> {
  let source: Awaited<ReturnType<typeof captureSourceOwnership>> | undefined
  let longTasks: JSHandle<{ finish(): RendererLongTaskTrace }> | undefined
  let mainSql: Awaited<ReturnType<typeof observeMainSqlTiming>> | undefined
  try {
    mainSql = await observeMainSqlTiming(app, isolatedUserDataDir)
    longTasks = await page.evaluateHandle(() => {
      const supported = PerformanceObserver.supportedEntryTypes.includes('longtask')
      const startedAtEpochMs = performance.timeOrigin + performance.now()
      const entries: RendererLongTaskTrace['entries'] = []
      let dropped = 0,
        finishedAtEpochMs: number | undefined
      const frameSamples: RendererLongTaskTrace['animationFrames']['samples'] = []
      const frameCapacity = 512
      let droppedFrames = 0,
        nextFrameIndex = 0,
        frameToken: number
      let previousFrameTime: number | undefined, previousCallbackAt: number | undefined
      const recordFrame = (frameTime: number) => {
        const callbackAt = performance.now()
        const sample = {
          frameTime,
          callbackAt,
          atEpochMs: performance.timeOrigin + callbackAt,
          deliveryLatenessMs: callbackAt - frameTime,
          frameDeltaMs: previousFrameTime === undefined ? null : frameTime - previousFrameTime,
          callbackGapMs: previousCallbackAt === undefined ? null : callbackAt - previousCallbackAt,
        }
        previousFrameTime = frameTime
        previousCallbackAt = callbackAt
        if (frameSamples.length < frameCapacity) frameSamples.push(sample)
        else {
          frameSamples[nextFrameIndex] = sample
          nextFrameIndex = (nextFrameIndex + 1) % frameCapacity
          droppedFrames++
        }
        frameToken = requestAnimationFrame(recordFrame)
      }
      const record = (entry: PerformanceEntry) => {
        if (entries.length >= 128) {
          dropped++
          return
        }
        entries.push({
          name: entry.name,
          atEpochMs: performance.timeOrigin + entry.startTime,
          startTime: entry.startTime,
          duration: entry.duration,
        })
      }
      const observer = supported
        ? new PerformanceObserver((list) => list.getEntries().forEach(record))
        : undefined
      observer?.observe({ type: 'longtask', buffered: false })
      frameToken = requestAnimationFrame(recordFrame)
      return {
        finish: (): RendererLongTaskTrace => {
          if (finishedAtEpochMs === undefined) {
            observer?.takeRecords().forEach(record)
            observer?.disconnect()
            cancelAnimationFrame(frameToken)
            finishedAtEpochMs = performance.timeOrigin + performance.now()
          }
          return {
            supported,
            startedAtEpochMs,
            finishedAtEpochMs,
            dropped,
            entries: entries.slice(),
            animationFrames: {
              capacity: frameCapacity,
              dropped: droppedFrames,
              samples: droppedFrames
                ? frameSamples.slice(nextFrameIndex).concat(frameSamples.slice(0, nextFrameIndex))
                : frameSamples.slice(),
            },
            clock:
              'Actual renderer longtask entries and requestAnimationFrame callback timestamps. Relative clocks use performance milliseconds; epoch values add performance.timeOrigin. RAF samples retain the most recent 512 callbacks through release/refinement, with unmodified callback-minus-frame delivery lateness. These are passive scheduling observations, not proof of native/GPU/main work.',
          }
        },
      }
    })
    source = await captureSourceOwnership(page)
    const trial = await matchedEditorInput(page, { label, zoom: 'fit', frequency: 60 })
    const canvas = page.getByTestId('main-preview')
    return {
      trial,
      settledAtEpochMs: Date.now(),
      allocatedBytes: Number(await canvas.getAttribute('data-allocated-bytes')),
      memory: {
        allocatedRamBytes: trial.allocatedRamBytes,
        allocatedGpuBytes: trial.allocatedGpuBytes,
        ramBudgetBytes: trial.ramBudgetBytes,
        vramBudgetBytes: trial.vramBudgetBytes,
        resourcePolicyRevision: trial.resourcePolicyRevision,
      },
      policy: await canvas.getAttribute('data-interactive-policy'),
      sourceOwnership: await source.evaluate((control) => control.finish()),
      longTasks: await longTasks.evaluate((control) => control.finish()),
      mainSql: await mainSql.evaluate((control) => control.close()),
    }
  } catch (error) {
    return {
      error: String(error),
      settledAtEpochMs: Date.now(),
      longTasks: await longTasks?.evaluate((control) => control.finish()).catch(() => undefined),
      mainSql: await mainSql?.evaluate((control) => control.close()).catch(() => undefined),
    }
  } finally {
    await mainSql?.evaluate((control) => control.close()).catch(() => undefined)
    await mainSql?.dispose()
    await longTasks?.evaluate((control) => control.finish()).catch(() => undefined)
    await longTasks?.dispose()
    await source?.dispose()
  }
}

/** Bind the actual configured device/canvas and the current verified-load receipt. */
async function captureSourceOwnership(page: Page) {
  return page.evaluateHandle(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const device = canvas.getContext('webgpu')!.getConfiguration()?.device
    const read = (element: HTMLCanvasElement): SourceState => {
      const number = (key: string) =>
        element.dataset[key] === undefined ? Number.NaN : Number(element.dataset[key])
      const load = JSON.parse(element.dataset.loadTimings ?? 'null') as {
        sourceCacheHit?: number
      } | null
      return {
        sourceIdentity: element.dataset.presentedSourceIdentity ?? null,
        requestedSourceIdentity: element.dataset.requestedSourceIdentity ?? null,
        epoch: number('presentedEpoch'),
        requestedEpoch: number('requestedEpoch'),
        uploads: number('sourceUploads'),
        cacheState: element.dataset.sourceCache ?? null,
        loadCacheHit: load?.sourceCacheHit ?? Number.NaN,
        cacheEntries: number('sourceCacheEntries'),
        cacheRamBytes: number('sourceCacheRamBytes'),
        cacheGpuBytes: number('sourceCacheGpuBytes'),
        backend: element.dataset.backend ?? null,
        editing: element.dataset.editing ?? null,
      }
    }
    const before = read(canvas)
    return {
      finish: (): SourceOwnership => {
        const current = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
        return {
          before,
          after: read(current),
          sameCanvas: current === canvas && canvas.isConnected,
          sameDevice:
            !!device && current.getContext('webgpu')!.getConfiguration()?.device === device,
        }
      },
    }
  })
}

/** Observe sends to the one actual admitted merge child, without supplying progress. */
async function observeMergePauses(app: ElectronApplication) {
  return app.evaluateHandle(() => {
    type Child = {
      pid: number
      connected: boolean
      spawnargs: string[]
      send: (...args: unknown[]) => unknown
    }
    const candidates = (process as unknown as { _getActiveHandles(): unknown[] })
      ._getActiveHandles()
      .filter((item): item is Child => {
        const value = item as Partial<Child> | null
        return (
          !!value &&
          Number.isSafeInteger(value.pid) &&
          value.connected === true &&
          typeof value.send === 'function' &&
          Array.isArray(value.spawnargs) &&
          value.spawnargs.some((argument) => /(?:^|\/)merge-worker\.js$/.test(argument))
        )
      })
    if (candidates.length !== 1)
      throw new Error('Expected one actual admitted merge worker for pause observation.')
    const child = candidates[0],
      original = child.send
    const events: MergePauseTrace['events'] = []
    let dropped = 0
    const wrapped = function (...args: unknown[]) {
      const message = args[0] as { type?: unknown } | undefined
      const event =
        message?.type === 'pause' || message?.type === 'resume'
          ? ({
              atEpochMs: performance.timeOrigin + performance.now(),
              type: message.type,
            } as MergePauseTrace['events'][number])
          : undefined
      try {
        const returned = Reflect.apply(original, child, args)
        if (event && typeof returned === 'boolean') event.sendReturned = returned
        return returned
      } catch (error) {
        if (event) event.error = String(error)
        throw error
      } finally {
        if (event) {
          if (events.length < 64) events.push(event)
          else dropped++
        }
      }
    }
    child.send = wrapped
    return {
      close: (): MergePauseTrace => {
        if (child.send === wrapped) child.send = original
        return {
          pid: child.pid,
          argv: child.spawnargs.slice(),
          clock:
            'Actual main-child send invocation; main performance.timeOrigin + performance.now epoch milliseconds.',
          boundary:
            'Forwarded production pause/resume commands only; no worker acknowledgment or continuous hardware-computation proof.',
          dropped,
          events,
        }
      },
    }
  })
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
    ...editor.memory,
    policy: editor.policy,
    sourceOwnership: editor.sourceOwnership,
    longTasks: editor.longTasks,
    mainSql: editor.mainSql,
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
  const mergeAdvancements = operation.samples.filter(
    (sample) =>
      sample.observation === 'merge-worker-progress' &&
      Number.isFinite(sample.producedAtEpochMs) &&
      sample.producedAtEpochMs! >= first &&
      sample.producedAtEpochMs! <= last,
  )
  const exportAdvancements = operation.samples.filter(
    (sample) =>
      sample.observation === 'export-worker-progress' &&
      Number.isFinite(sample.producedAtEpochMs) &&
      sample.producedAtEpochMs! >= first &&
      sample.producedAtEpochMs! <= last,
  )
  const importPolls =
    operation.workload === 'import'
      ? operation.samples.filter(
          (sample) =>
            sample.observation === 'background-task' &&
            Number.isFinite(sample.requestStartedAtEpochMs) &&
            Number.isFinite(sample.responseAtEpochMs) &&
            sample.requestStartedAtEpochMs! >= first &&
            sample.responseAtEpochMs! <= last &&
            sample.responseAtEpochMs! >= sample.requestStartedAtEpochMs!,
        )
      : []
  const importAdvancements = importPolls.slice(1).flatMap((after, index) => {
    const before = importPolls[index]
    if (
      before.taskId !== after.taskId ||
      before.responseAtEpochMs! > after.requestStartedAtEpochMs!
    )
      return []
    const counters = (['completed', 'copiedBytes', 'prepared'] as const).filter(
      (key) =>
        Number.isFinite(before[key]) &&
        Number.isFinite(after[key]) &&
        (key !== 'completed' ||
          (before.progressUnit === after.progressUnit && before.total === after.total)),
    )
    if (counters.some((key) => after[key]! < before[key]!)) return []
    const increased = counters.filter((key) => after[key]! > before[key]!)
    return increased.length
      ? [
          {
            before,
            after,
            increased,
            interval: {
              requestedAtEpochMs: before.requestStartedAtEpochMs!,
              responseAtEpochMs: after.responseAtEpochMs!,
            },
          },
        ]
      : []
  })
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
    progressSamplesDuringInput: [
      ...mergeAdvancements,
      ...exportAdvancements,
      ...importAdvancements,
    ],
    mergeWorkerAdvancementsDuringInput: mergeAdvancements,
    exportWorkerAdvancementsDuringInput: exportAdvancements,
    importCounterAdvancementsDuringInput: importAdvancements,
    exportProgressDropped: operation.exportProgressDropped,
    previewSamplesDuringInput: operation.samples.filter(
      (sample) =>
        sample.observation === 'merge-preview-diagnostics' &&
        sample.atEpochMs >= first &&
        sample.atEpochMs <= last,
    ),
    progressObservationLimit:
      'Merge/export samples are deduplicated validated completed-stage receipts stamped by the actual producer; observedAtEpochMs separately records poll delivery. Import progress requires a strict counter increase between two nonoverlapping polls both requested after first input and responded before last input. Unchanged counters, status, phase and scheduler-wait polls never qualify. Events prove work advancement, not continuous simultaneous hardware computation.',
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
const precision = hdrTestPolicy.interactivePolicy

const interferenceLayout =
  process.env.LUMA_INTERFERENCE_LAYOUT ??
  (editorDisplayProfile === 'linux-native-dpr1' ? 'native-maximized' : '1440x900')
if (!['native-maximized', '1440x900'].includes(interferenceLayout))
  throw new Error('LUMA_INTERFERENCE_LAYOUT must be native-maximized or 1440x900.')
const workloads: Workload[] = ['import', 'export-individual', 'export-batch', 'merge', 'merge-hdr']
const caseTitle = (workload: Workload, label: WorkabilitySlider) =>
  `${workload} ${label}: three matched responsive editing trials at 60Hz, ${interferenceLayout} Fit`
for (const workload of workloads)
  for (const label of sliders)
    test(caseTitle(workload, label), foregroundTest(reason), async ({ luma }, info) => {
      test.setTimeout(1200000)
      const { app, page } = luma,
        mergeWorkload = workload === 'merge' || workload === 'merge-hdr',
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
            : Array.from({ length: 9 }, (_, i) => burst[Math.round((i * (burst.length - 1)) / 8)]),
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
      await confirmEditorDisplay(page, true)
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
      const maximizedConfiguration =
        interferenceLayout === 'native-maximized'
          ? await maximizeEditorOnMonitor(app, page, {
              monitorLabel: process.env.LUMA_RESPONSIVENESS_MONITOR,
            })
          : null
      const environment = {
        maximizedConfiguration,
        windowState: await (
          await app.browserWindow(page)
        ).evaluate((window) => ({
          maximized: window.isMaximized(),
          fullscreen: window.isFullScreen(),
          bounds: window.getBounds(),
          contentBounds: window.getContentBounds(),
        })),
        provenance: {
          ...(await provenance([
            'tests/fixtures/sony-zv1.ARW',
            'tests/fixtures/research-sony/manifest.json',
            'tests/mac-workability.helpers.ts',
            'tests/editor-responsiveness-interference.spec.ts',
            'tests/editor-responsiveness-profile.helpers.ts',
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
        physicalDisplay: await editorPhysicalDisplay(app, page),
        displayPreference: editorDisplayPreference,
        displayProfile: editorDisplayProfile,
        expectedDpr: editorExpectedDpr,
        ...(await confirmEditorDisplay(page)),
        scope: {
          ...editorCaseSelection(
            info,
            workloads.flatMap((workload) => sliders.map((label) => caseTitle(workload, label))),
            workloads.length * allSliders.length,
          ),
          fullMatrixTrialCount: workloads.length * allSliders.length * 3,
          trialsPerCase: 3,
          editorGesturesPerTrial: 2,
          layout: interferenceLayout,
          zoom: 'fit',
          frequency: 60,
        },
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
        mergeMode: mergeWorkload ? (workload === 'merge-hdr' ? 'hdr' : 'noise') : undefined,
        editingOrder: mergeWorkload
          ? 'Operation first; wait for validated partial worker progress while pending, then run the unchanged 240-input trial. Require later worker advancement during input.'
          : 'Gesture first; start the operation while the gesture is active.',
        requestedMergeBackends: mergeWorkload
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
        if (workload !== 'import') {
          // Finish the shared input driver's full neutral baseline before the
          // producer starts; its later identical reset must be a no-op.
          await page.evaluate(
            async ({ id, parameters }) => {
              const state = await window.luma.getEdits(id)
              await window.luma.updateEdits(id, parameters, state.revision)
            },
            { id: editorId, parameters: neutralAdjustments },
          )
          await expect
            .poll(
              () =>
                page.getByTestId('main-preview').evaluate((element) => ({
                  exposureEv: Number(element.dataset.exposure),
                  contrast: Number(element.dataset.contrast),
                  highlights: Number(element.dataset.highlights),
                  shadows: Number(element.dataset.shadows),
                  whites: Number(element.dataset.whites),
                  blacks: Number(element.dataset.blacks),
                  whiteBalance: JSON.parse(element.dataset.whiteBalance ?? 'null'),
                })),
              { timeout: 30000 },
            )
            .toEqual(neutralAdjustments)
        } else {
          await page.evaluate(async (id) => {
            const state = await window.luma.getEdits(id)
            await window.luma.updateEdits(id, { exposureEv: 0 }, state.revision)
          }, editorId)
        }
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
          mergePauseObserver: Awaited<ReturnType<typeof observeMergePauses>> | undefined,
          idleCleaned = false
        trials.push(trial)
        try {
          await restoreEditor()
          trial.idleEditor = await editorTrial(page, label, app, luma.userDataDir)
          await save()
          trial.idleTask = await runOperation(page, await prepare())
          await save()
          await cleanup(trial.idleTask)
          idleCleaned = true
          const prepared = await prepare()
          await startSourceObserver(page)
          if (mergeWorkload) {
            operationWork = runOperation(page, prepared)
            await page.waitForFunction(
              (workload) => {
                const current = (
                    window as unknown as { workabilityOperationProgress?: OperationResult }
                  ).workabilityOperationProgress,
                  latest = current?.samples.at(-1)
                return (
                  current?.workload === workload &&
                  current.settledAtEpochMs === 0 &&
                  latest?.observation === 'merge-preview-diagnostics' &&
                  latest.status === 'pending' &&
                  current.samples.some(
                    (sample) =>
                      sample.observation === 'merge-worker-progress' &&
                      sample.completed !== undefined &&
                      sample.total !== undefined &&
                      sample.completed > 0 &&
                      sample.completed < sample.total,
                  )
                )
              },
              workload,
              { timeout: 180000 },
            )
            mergePauseObserver = await observeMergePauses(app)
            editingWork = editorTrial(page, label, app, luma.userDataDir)
          } else if (workload.startsWith('export')) {
            operationWork = runOperation(page, prepared)
            await page.waitForFunction(
              (workload) => {
                const current = (
                  window as unknown as { workabilityOperationProgress?: OperationResult }
                ).workabilityOperationProgress
                const active = current?.task?.exportWorkerProgress?.active
                return (
                  current?.workload === workload &&
                  current.settledAtEpochMs === 0 &&
                  current.task?.status === 'running' &&
                  !!active &&
                  current.samples.some(
                    (sample) =>
                      sample.observation === 'export-worker-progress' &&
                      sample.exportProgress?.attemptId === active.attemptId &&
                      sample.exportProgress.fileIndex === active.fileIndex &&
                      sample.completed !== undefined &&
                      sample.total !== undefined &&
                      sample.completed > 0 &&
                      sample.completed < sample.total,
                  )
                )
              },
              workload,
              { timeout: 180000 },
            )
            editingWork = editorTrial(page, label, app, luma.userDataDir)
          } else {
            editingWork = editorTrial(page, label, app, luma.userDataDir)
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
          if (mergePauseObserver) {
            try {
              trial.mergePauseTrace = await mergePauseObserver.evaluate((control) =>
                control.close(),
              )
            } catch (error) {
              trial.cleanupErrors.push(String(error))
            } finally {
              await mergePauseObserver
                .dispose()
                .catch((error) => trial.cleanupErrors.push(String(error)))
            }
          }
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
            mergeWorkload && trial.editing?.trial && trial.editingTask
              ? trial.editing.trial.epochMs +
                trial.editing.trial.inputs[0].at -
                trial.editingTask.startedAtEpochMs
              : undefined,
          mergeMeasurements: mergeWorkload
            ? {
                idle: trial.idleTask?.mergeDiagnostics?.measurements,
                editing: trial.editingTask?.mergeDiagnostics?.measurements,
              }
            : undefined,
          mergePauseTrace: trial.mergePauseTrace,
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
          (['idleEditor', 'editing'] as const)
            .flatMap((mode) =>
              [
                ['interactionLatencyP95Ms', 33],
                ['interactionLatencyP99Ms', 50],
                ['interactionLatencyMaximumMs', 100],
                ['longestPresentationGapMs', 100],
                ['visibleUpdateShortfall', 0],
                ['refinementMs', 200],
                [
                  'allocatedRamBytes',
                  (trial[mode] as Partial<HdrMemoryObservation>).ramBudgetBytes,
                ],
                [
                  'allocatedGpuBytes',
                  (trial[mode] as Partial<HdrMemoryObservation>).vramBudgetBytes,
                ],
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
      expect(environment.windowState.fullscreen).toBe(false)
      expect(environment.windowState.maximized).toBe(interferenceLayout === 'native-maximized')
      if (interferenceLayout === '1440x900')
        expect(environment.viewport).toMatchObject({ width: 1440, height: 900 })
      else
        expect(environment.viewport).toMatchObject({
          width: environment.windowState.contentBounds.width,
          height: environment.windowState.contentBounds.height,
        })
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
              expect.soft(measurements?.preparation).toHaveLength(workload === 'merge-hdr' ? 3 : 9)
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
          expect.soft(input?.tileBatch, context).toBe(editorRequestedTileBatch)
          expect
            .soft(
              input?.presentations.every((frame) => frame.previewPolicy === precision),
              context,
            )
            .toBe(true)
          expect
            .soft(
              input?.presentations.every(
                (frame) =>
                  frame.presentedPolicy ===
                  (frame.quality === 'interactive' ? precision : 'reference'),
              ),
              context,
            )
            .toBe(true)
          expect.soft(input?.presentedTargetMatches, context).toBe(true)
          expect.soft(input?.display.targets, context).toHaveLength(1)
          expect.soft(editor?.mainSql?.restoredAll, context).toBe(true)
          expect.soft(editor?.mainSql?.restoreConflicts, context).toEqual([])
          expect.soft(editor?.mainSql?.observerErrors, context).toBe(0)
          expect.soft(editor?.mainSql?.dropped, context).toBe(0)
          expect.soft(editor?.mainSql?.catalogConnectionIds.length, context).toBeGreaterThan(0)
          assertHdrMemory(editor?.memory, context, true)
          if (precision !== 'reference') expect.soft(input?.interactive, context).toBeGreaterThan(0)
          expect.soft(input?.regressed, context).toBe(false)
          expect.soft(input?.attributionFailures, context).toBe(0)
          expect.soft(input?.finalMatched, context).toBe(true)
          expect.soft(input?.histogramMatched, context).toBe(true)
          expect.soft(input?.loaders, context).toBe(0)
          expect.soft(input?.hidden, context).toBe(0)
          expect.soft(input?.sidebarMovement, context).toBeLessThan(0.1)
          // An exact same-device cached source legitimately starts at zero uploads.
          // Bind that exception to the actual current successful load and keep
          // the same source/device/canvas through this whole input trial.
          const ownership = editor?.sourceOwnership
          expect.soft(ownership, context).toBeTruthy()
          expect.soft(input?.baselineSourceMatched, context).toBe(true)
          if (ownership) {
            expect.soft(ownership.sameCanvas, context).toBe(true)
            expect.soft(ownership.sameDevice, context).toBe(true)
            for (const snapshot of [ownership.before, ownership.after]) {
              expect.soft(snapshot.sourceIdentity, context).toBe(input?.expectedSourceIdentity)
              expect
                .soft(snapshot.requestedSourceIdentity, context)
                .toBe(input?.expectedSourceIdentity)
              expect.soft(snapshot.backend, context).toBe('webgpu-hdr')
              expect.soft(snapshot.editing, context).toBe('ready')
              expect.soft(Number.isSafeInteger(snapshot.uploads), context).toBe(true)
              expect.soft(snapshot.uploads, context).toBeGreaterThanOrEqual(0)
            }
            expect.soft(ownership.before.uploads, context).toBe(ownership.after.uploads)
            expect.soft(input?.sourceUploads, context).toBe(ownership.after.uploads)
            if (ownership.after.uploads === 0) {
              for (const snapshot of [ownership.before, ownership.after]) {
                // HdrPresenter publishes hit only after same-device/key acquire;
                // cache admission independently requires full strip hashes + EOF.
                expect.soft(snapshot.cacheState, context).toBe('hit')
                expect.soft(snapshot.loadCacheHit, context).toBe(1)
                expect.soft(snapshot.cacheEntries, context).toBeGreaterThan(0)
                expect.soft(snapshot.cacheRamBytes, context).toBeGreaterThan(0)
                expect.soft(snapshot.cacheGpuBytes, context).toBeGreaterThan(0)
              }
            } else expect.soft(ownership.after.uploads, context).toBe(1)
          }
          expect.soft(input?.historyEntriesAdded, context).toBe(1)
        }
      }
      const underDriven = trials.some((trial) =>
        [trial.idleEditor, trial.editing].some(
          (editor) => editor?.trial && editor.trial.achievedHz < 59.4,
        ),
      )
      test.skip(
        underDriven ||
          !editorConfigurationMatches(
            environment.viewport,
            environment.physicalDisplay,
            trials.flatMap((trial) =>
              [trial.idleEditor?.trial, trial.editing?.trial].filter(
                (trial): trial is InputTrial => !!trial,
              ),
            ),
          ),
        `Actual ${editorDisplayProfile} display configuration or 99% native 60 Hz input was not achieved; all complete task/overlap evidence is retained and configuration acceptance is incomplete.`,
      )
      for (const trial of trials) {
        const actualOverlap = overlap(trial.editing, trial.editingTask)
        if (mergeWorkload) {
          expect.soft(trial.mergePauseTrace?.pid).toBeGreaterThan(0)
          expect.soft(trial.mergePauseTrace?.dropped).toBe(0)
        }
        expect.soft(actualOverlap?.durationMs).toBeGreaterThanOrEqual(500)
        expect.soft(actualOverlap?.inputCount).toBeGreaterThan(0)
        expect.soft(actualOverlap?.progressSamplesDuringInput.length).toBeGreaterThan(0)
        if (mergeWorkload)
          expect.soft(actualOverlap?.mergeWorkerAdvancementsDuringInput.length).toBeGreaterThan(0)
        if (workload.startsWith('export')) {
          expect.soft(actualOverlap?.exportWorkerAdvancementsDuringInput.length).toBeGreaterThan(0)
          expect.soft(actualOverlap?.exportProgressDropped).toBe(0)
        }
        if (workload === 'import')
          expect.soft(actualOverlap?.importCounterAdvancementsDuringInput.length).toBeGreaterThan(0)
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
    })
