import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { recordBenchmark } from './benchmark.helpers'
import { sustainedEditorInput } from './mac-workability.helpers'
import { provenance } from '../scripts/research/pipeline/provenance'
import type { BackgroundTask, TaskErrorPage } from '../src/shared/contracts'
import type { ExportPreparation, ExportResult } from '../src/shared/export'
import type { MergeDiagnostics } from '../src/shared/merge'

const reason =
  'Matched editor/task trials measure visible GPU presentation and native input cadence under actual work.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })

type Workload = 'import' | 'export-individual' | 'export-batch' | 'merge'
type InputTrial = Awaited<ReturnType<typeof sustainedEditorInput>>
type EditorResult = { trial?: InputTrial; settledAtEpochMs: number; error?: string }
interface PreparedOperation {
  workload: Workload
  sourceIds: string[]
  sessionId?: string
  exportPreparation?: ExportPreparation
  destinationId?: string
}
interface OperationResult {
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
    status: BackgroundTask['status']
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
      } else if (prepared.workload === 'merge') {
        const review = await window.luma.createMergeReview(prepared.sourceIds, 'noise')
        await window.luma.requestMergePreview(review.id, review.revision)
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

function editorTrial(page: Page): Promise<EditorResult> {
  return sustainedEditorInput(page, { label: 'Exposure', zoom: 'fit', frequency: 60 }).then(
    (trial) => ({ trial, settledAtEpochMs: Date.now() }),
    (error) => ({ error: String(error), settledAtEpochMs: Date.now() }),
  )
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

function editorMetrics(editor?: EditorResult) {
  if (!editor?.trial) return { error: editor?.error ?? 'Missing editor trial.' }
  const { inputs, presentations, histograms, ...metrics } = editor.trial
  return {
    ...metrics,
    inputCount: inputs.length,
    presentationCount: presentations.length,
    histogramCount: histograms.length,
    presentationsDuringInput: metrics.completedDuringInput,
    settledAtEpochMs: editor.settledAtEpochMs,
  }
}
function overlap(editor?: EditorResult, operation?: OperationResult) {
  if (!editor?.trial || !operation) return null
  const { trial } = editor,
    first = trial.epochMs + trial.inputs[0].at,
    last = trial.epochMs + trial.inputs.at(-1)!.at,
    end = operation.finishedAtEpochMs ?? operation.settledAtEpochMs,
    within = (at: number) =>
      at + trial.epochMs >= operation.startedAtEpochMs && at + trial.epochMs <= end,
    inputCount = trial.inputs.filter((input) => within(input.at)).length
  return {
    definition:
      'Accepted operation interval, including scheduler waits; not simultaneous computation.',
    operationStartedAtEpochMs: operation.startedAtEpochMs,
    operationFinishedAtEpochMs: end,
    inputStartedAtEpochMs: first,
    inputFinishedAtEpochMs: last,
    durationMs: Math.max(0, Math.min(last, end) - Math.max(first, operation.startedAtEpochMs)),
    inputCount,
    inputFraction: inputCount / trial.inputs.length,
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
  }
}

for (const workload of ['import', 'export-individual', 'export-batch', 'merge'] as const)
  test(
    `${workload}: three matched idle and editing trials at 60Hz, 1100x700 with Console`,
    foregroundTest(reason),
    async ({ luma }, info) => {
      test.setTimeout(1200000)
      const { app, page } = luma,
        manifest = JSON.parse(
          await readFile('tests/fixtures/research-sony/manifest.json', 'utf8'),
        ) as {
          sequences: { id: string; files: string[] }[]
          files: { name: string; path: string; sha256: string }[]
        },
        burst = manifest.sequences.find((sequence) => sequence.id === 'noise-burst')!.files,
        selected = Array.from(
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
        trials: MatchedTrial[] = []
      await mkdir(destination, { recursive: true })
      await (
        await app.browserWindow(page)
      ).evaluate((window) => {
        window.unmaximize()
        window.setContentSize(1100, 700)
      })
      await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
      await page.getByTestId('console-toggle').click()
      if (workload !== 'import')
        await importPhotos(
          app,
          page,
          originals.map((source) => source.path),
          false,
        )
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
            'src/renderer/src/preview/hdr-presenter.ts',
            'src/shared/display-rendering.ts',
            'src/shared/aces-wgsl.ts',
            'src/shared/aces-precision-wgsl.ts',
            'src/shared/aces-data.ts',
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
        consoleOpen: true,
        requestedHz: 60,
        inputsPerTrial: 240,
        sourceOriginals: originals.map(({ name, sha256 }) => ({ name, sha256 })),
        workload,
        mergeSources: workload === 'merge' ? 9 : undefined,
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
        if (workload === 'merge') {
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
          trial.idleEditor = await editorTrial(page)
          await save()
          trial.idleTask = await runOperation(page, await prepare())
          await save()
          await cleanup(trial.idleTask)
          idleCleaned = true
          const prepared = await prepare()
          await startSourceObserver(page)
          editingWork = editorTrial(page)
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLElement>('[data-testid="main-preview"]')?.dataset
                .gesturing === 'true',
            undefined,
            { timeout: 15000 },
          )
          operationWork = runOperation(page, prepared)
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
          changedDuringEditor,
          expectedMergeAutoOpenInterruptedTrial:
            workload === 'merge' && changedDuringEditor.length > 0,
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
          ['idleEditor', 'editing'].flatMap((mode) => [
            {
              metric: `${trial.repetition}.${mode}.latencyP95Ms`,
              operator: '<=' as const,
              limit: 33,
            },
            {
              metric: `${trial.repetition}.${mode}.histogramP95Ms`,
              operator: '<=' as const,
              limit: 33,
            },
            {
              metric: `${trial.repetition}.${mode}.refinementMs`,
              operator: '<=' as const,
              limit: 500,
            },
          ]),
        ),
        evidence: [evidencePath],
      })
      expect(environment.viewport).toMatchObject({ width: 1100, height: 700 })
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
          if (workload === 'merge') expect.soft(operation?.task?.resultPhotoId).toBeTruthy()
          if (workload.startsWith('export')) {
            const count = workload === 'export-individual' ? 1 : 9
            expect.soft(operation?.frozenExport?.targets).toHaveLength(count)
            expect.soft(operation?.exportResults?.total).toBe(count)
            expect
              .soft(operation?.exportResults?.results.every((file) => file.status === 'exported'))
              .toBe(true)
          }
        }
        const comparison = comparisons[trial.repetition]
        if (workload !== 'merge')
          expect
            .soft(comparison.changedDuringEditor, `${workload} preserves the editor source`)
            .toEqual([])
        for (const [mode, editor] of [
          ['idle', trial.idleEditor],
          ['editing', trial.editing],
        ] as const) {
          if (mode === 'editing' && comparison.expectedMergeAutoOpenInterruptedTrial) continue
          const input = editor?.trial,
            context = `${workload} ${mode} repetition ${trial.repetition}`
          expect.soft(editor?.error, context).toBeUndefined()
          expect.soft(input?.error, context).toBeUndefined()
          expect.soft(input?.backend, context).toBe('webgpu-hdr')
          expect.soft(input?.inputs.length, context).toBe(240)
          expect.soft(input?.draft, context).toBe(0)
          expect.soft(input?.sharp, context).toBe(input?.completed)
          expect.soft(input?.regressed, context).toBe(false)
          expect.soft(input?.attributionFailures, context).toBe(0)
          expect.soft(input?.finalMatched, context).toBe(true)
          expect.soft(input?.histogramMatched, context).toBe(true)
          expect.soft(input?.loaders, context).toBe(0)
          expect.soft(input?.hidden, context).toBe(0)
          expect.soft(input?.sidebarMovement, context).toBeLessThan(0.1)
          expect.soft(input?.sourceUploads, context).toBe(1)
          if (mode === 'editing' && workload.startsWith('export'))
            expect.soft(input?.historyEntriesAdded, context).toBeGreaterThanOrEqual(1)
          else expect.soft(input?.historyEntriesAdded, context).toBe(1)
        }
      }
      const underDriven = trials.some((trial) =>
          [trial.idleEditor, trial.editing].some(
            (editor) => editor?.trial && editor.trial.achievedHz < 60 * 0.99,
          ),
        ),
        interrupted = comparisons.some((trial) => trial.expectedMergeAutoOpenInterruptedTrial)
      test.skip(
        underDriven || interrupted,
        underDriven
          ? 'Actual input cadence did not reach 99% of 60Hz; all matched task and overlap evidence is retained.'
          : 'Expected merge-result auto-open interrupted the original-photo trial; exact partial overlap is retained.',
      )
      for (const trial of trials)
        for (const editor of [trial.idleEditor, trial.editing]) {
          const metrics = editorMetrics(editor)
          expect
            .soft('presentationsDuringInput' in metrics ? metrics.presentationsDuringInput : 0)
            .toBeGreaterThanOrEqual(160)
          expect
            .soft('histogramsDuringInput' in metrics ? metrics.histogramsDuringInput : 0)
            .toBeGreaterThanOrEqual(160)
          expect.soft(editor?.trial?.latencyP95Ms).not.toBeNull()
          expect.soft(editor?.trial?.latencyP95Ms).toBeLessThanOrEqual(33)
          expect.soft(editor?.trial?.histogramP95Ms).not.toBeNull()
          expect.soft(editor?.trial?.histogramP95Ms).toBeLessThanOrEqual(33)
          expect.soft(editor?.trial?.refinementMs).toBeLessThanOrEqual(500)
        }
    },
  )
