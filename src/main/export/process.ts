import { execFile, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PreviewProcess } from '../preview-process'
import type { ExportRenderJob, ExportRenderResult } from './types'
import { prepareExportWorkingSource } from './preparation'
import type { ExportWorkerProgress } from '../../shared/export'
import { acceptExportWorkerProgress, exportProgressOwner } from './progress'
import { validateExportCropPolicy } from './crop-policy'
import { validateExportDetailPolicy } from './detail-policy'
import { validateExportResizePolicy } from './resize-policy'

/** Decoder and encoder never retain their WASM heaps in the same process. */
export class ExportProcess {
  constructor(
    private workerPath = join(import.meta.dirname, 'export-worker.js'),
    private previewWorkerPath = join(import.meta.dirname, 'preview-worker.js'),
  ) {}
  async render(
    job: ExportRenderJob,
    signal: AbortSignal,
    onProgress?: (progress: ExportWorkerProgress) => void,
  ): Promise<ExportRenderResult> {
    job = structuredClone(job)
    validateExportCropPolicy(job)
    validateExportDetailPolicy(job)
    validateExportResizePolicy(job)
    const started = performance.now()
    let sourceMs = 0,
      sourceBackend: string | undefined,
      sourceFallback: string | undefined,
      sourcePreparation: import('./types').ExportDiagnostics['sourcePreparation'] = 'managed'
    signal.throwIfAborted()
    const source = structuredClone(job.source)
    if (source.hdr && !source.processing.metadata.mergeMaster) {
      const prepared = await prepareExportWorkingSource(job, signal, async (directory) => {
        const decoder = new PreviewProcess(this.previewWorkerPath)
        try {
          return await decoder.renderFull(source.path, directory, signal, {
            ...source.processing,
            crop: undefined,
            noiseReduction: undefined,
            detailSharpening: undefined,
            workingOnly: true,
          })
        } finally {
          await decoder.close(true)
        }
      })
      sourceBackend = prepared.backend
      sourceFallback = prepared.fallback
      sourcePreparation = prepared.preparation
      source.processing.workingAsset = prepared.asset
      sourceMs = performance.now() - started
    }
    signal.throwIfAborted()
    const require = createRequire(import.meta.url),
      platform = process.platform === 'win32' ? 'win' : process.platform
    const executable = join(
      dirname(require.resolve(`node-${platform}-${process.arch}/package.json`)),
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    ).replace('app.asar/', 'app.asar.unpacked/')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const owner = exportProgressOwner(job, performance.timeOrigin + performance.now())
    const child = fork(this.workerPath, [], {
      execPath: executable,
      execArgv: [],
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
    })
    let stopping: Promise<void> | undefined
    const stop = () =>
      (stopping ??= new Promise<void>((resolve) => {
        if (!child.pid) {
          resolve()
          return
        }
        if (process.platform === 'win32') {
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true },
            () => {
              child.kill('SIGKILL')
              resolve()
            },
          )
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
          resolve()
        }
      }))
    let diagnostics = ''
    child.stderr?.on('data', (bytes) => {
      diagnostics = (diagnostics + bytes.toString()).slice(-2000)
    })
    return new Promise((resolve, reject) => {
      let result: ExportRenderResult | undefined, error: Error | undefined
      let terminal = false,
        previousProgress: ExportWorkerProgress | undefined
      const abort = () => {
        error = new Error('Export rendering cancelled.')
        void stop()
      }
      signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => {
        error = new Error('Export rendering timed out.')
        void stop()
      }, 10 * 60_000)
      const clean = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
      child.on(
        'message',
        (value: { result?: typeof result; error?: string; progress?: unknown }) => {
          if (!value || typeof value !== 'object') return
          if (value.progress !== undefined) {
            if (
              !owner ||
              !onProgress ||
              terminal ||
              error ||
              signal.aborted ||
              Object.keys(value).length !== 1
            )
              return
            const accepted = acceptExportWorkerProgress(
              value.progress,
              owner,
              previousProgress,
              performance.timeOrigin + performance.now(),
            )
            if (accepted) {
              previousProgress = accepted
              try {
                onProgress(accepted)
              } catch (callbackError) {
                error =
                  callbackError instanceof Error
                    ? callbackError
                    : new Error('Export progress observer failed.')
                void stop()
              }
            }
            return
          }
          if (value.result) {
            result = value.result
            terminal = true
          }
          if (value.error) {
            error = new Error(value.error)
            terminal = true
          }
        },
      )
      child.once('error', (e) => {
        error = e
        if (!child.pid) {
          clean()
          reject(e)
        }
      })
      child.once('exit', async () => {
        clean()
        if (stopping) await stopping
        if (error) reject(error)
        else if (result) {
          if (result.diagnostics) {
            result.diagnostics.sourceBackend = sourceBackend
            result.diagnostics.sourceFallback = sourceFallback
            result.diagnostics.sourcePreparation = source.hdr
              ? sourcePreparation
              : (result.diagnostics.sourcePreparation ?? sourcePreparation)
            result.diagnostics.stages.sourcePreparationMs = sourceMs
            result.diagnostics.stages.processMs = performance.now() - started
          }
          resolve(result)
        } else reject(new Error(`The export worker stopped. ${diagnostics}`))
      })
      if (signal.aborted) abort()
      else child.send({ ...job, source })
    })
  }
}
