import type { ImageStatistics } from '../shared/statistics'
import type { HdrStatistics } from '../shared/hdr-statistics'
import type { HdrStatisticsJob, HdrPixelJob, PreviewWorkerRequest } from './preview-types'
import type { HdrPixel } from '../shared/hdr-pixel'
import type { ProcessingMetadata, ProcessingOptions } from '../shared/lens'
import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { constants, setPriority } from 'node:os'
import type {
  FullPreviewProcessor,
  FullPreviewResult,
  PreviewProcessor,
  PreviewResult,
  ThumbnailProcessor,
  ThumbnailResult,
} from './preview-types'

export class PreviewProcess implements PreviewProcessor, FullPreviewProcessor, ThumbnailProcessor {
  private child?: ChildProcess
  private busy = false
  private captureSession = false
  private idle?: ReturnType<typeof setTimeout>

  constructor(
    private workerPath = join(import.meta.dirname, 'preview-worker.js'),
    private timeoutMs = 90_000,
  ) {}

  private launch(): ChildProcess {
    const require = createRequire(import.meta.url)
    const platform = process.platform === 'win32' ? 'win' : process.platform
    const runtimePackage = require.resolve(`node-${platform}-${process.arch}/package.json`)
    const executable = join(
      dirname(runtimePackage),
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
    // Native libvips conflicts with Electron's exported GLib symbols on Linux.
    // A bundled Node binary keeps native decoding independent of Electron.
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = fork(this.workerPath, [], {
      execPath: executable.replace('app.asar/', 'app.asar.unpacked/'),
      execArgv: [],
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout?.resume()
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
    })
    return child
  }

  async process(path: string, output: string, signal: AbortSignal): Promise<PreviewResult> {
    return this.run<PreviewResult>('process', path, output, signal)
  }

  createWorker(): PreviewProcess {
    return new PreviewProcess(this.workerPath, this.timeoutMs)
  }
  async prepare(
    path: string,
    output: string,
    signal: AbortSignal,
    fallback: boolean,
    seed?: PreviewResult,
  ): Promise<PreviewResult> {
    this.assertIdle()
    // Forced fallback cancellation must never kill a process with a live ExifTool child.
    if (fallback) await this.close()
    return this.run<PreviewResult>(
      'process',
      path,
      output,
      signal,
      undefined,
      undefined,
      undefined,
      fallback ? 'fallback' : 'embedded',
      seed,
    )
  }

  thumbnail(
    path: string,
    output: string,
    signal: AbortSignal,
    fallback = false,
  ): Promise<ThumbnailResult> {
    return this.run<ThumbnailResult>(
      fallback ? 'thumbnail-fallback' : 'thumbnail',
      path,
      output,
      signal,
    )
  }

  async inspect(path: string, signal: AbortSignal): Promise<ProcessingMetadata> {
    this.assertIdle()
    try {
      return await this.run<ProcessingMetadata>('metadata', path, '', signal)
    } finally {
      await this.close()
    }
  }

  async inspectCapture(
    path: string,
    signal: AbortSignal,
  ): Promise<import('../shared/capture-sequence').CaptureMetadata> {
    this.assertIdle()
    try {
      return await this.run<import('../shared/capture-sequence').CaptureMetadata>(
        'capture-metadata',
        path,
        '',
        signal,
      )
    } finally {
      await this.close()
    }
  }

  async inspectCaptures(
    paths: string[],
    signal: AbortSignal,
    beforeRead?: (index: number) => Promise<void>,
  ): Promise<import('../shared/capture-sequence').CaptureMetadata[]> {
    signal.throwIfAborted()
    this.assertIdle()
    this.captureSession = true
    try {
      const results: import('../shared/capture-sequence').CaptureMetadata[] = []
      for (let index = 0; index < paths.length; index++) {
        signal.throwIfAborted()
        await beforeRead?.(index)
        signal.throwIfAborted()
        results.push(
          await this.run<import('../shared/capture-sequence').CaptureMetadata>(
            'capture-metadata-session',
            paths[index],
            '',
            signal,
          ),
        )
      }
      signal.throwIfAborted()
      return results
    } finally {
      try {
        // The worker closes its retained ExifTool before the source lease ends.
        await this.close()
      } finally {
        this.captureSession = false
      }
    }
  }

  async renderFull(
    path: string,
    output: string,
    signal: AbortSignal,
    options?: ProcessingOptions,
  ): Promise<FullPreviewResult> {
    this.assertIdle()
    const result = await this.run<FullPreviewResult>('full', path, output, signal, options).catch(
      async (error) => {
        await this.close(true)
        throw error
      },
    )
    // Preserve GPU shader compilation across nearby requests. CPU RAW processing has a
    // much larger WASM high-water mark; reclaim that process after its completed render.
    this.idle = setTimeout(() => {
      void this.close()
    }, 30_000)
    this.idle.unref()
    if (process.env.LUMA_PREVIEW_DIAGNOSTICS) console.info('Full preview', result.diagnostics)
    return result
  }

  async statistics(
    path: string,
    frame: { width: number; height: number; sha256: string },
    signal: AbortSignal,
  ): Promise<ImageStatistics> {
    this.assertIdle()
    return this.run<ImageStatistics>('statistics', path, '', signal, undefined, frame).finally(
      () => {
        this.idle = setTimeout(() => {
          void this.close()
        }, 30_000)
        this.idle.unref()
      },
    )
  }

  async hdrStatistics(
    path: string,
    job: HdrStatisticsJob,
    signal: AbortSignal,
  ): Promise<HdrStatistics> {
    this.assertIdle()
    return this.run<HdrStatistics>('statistics', path, '', signal, undefined, {
      width: job.asset.width,
      height: job.asset.height,
      sha256: job.asset.sha256,
      hdr: job,
    }).finally(() => {
      this.idle = setTimeout(() => {
        void this.close()
      }, 30_000)
      this.idle.unref()
    })
  }

  async hdrPixel(path: string, job: HdrPixelJob, signal: AbortSignal): Promise<HdrPixel> {
    this.assertIdle()
    return this.run<HdrPixel>('pixel', path, '', signal, undefined, undefined, job).finally(() => {
      this.idle = setTimeout(() => {
        void this.close()
      }, 30_000)
      this.idle.unref()
    })
  }

  releaseFrame(): void {
    if (!this.busy && this.child?.connected) this.child.send({ type: 'release' }, () => {})
  }

  private assertIdle() {
    if (this.busy || this.captureSession) throw new Error('The preview worker is busy.')
  }

  private async run<T>(
    mode: Exclude<PreviewWorkerRequest['type'], 'close' | 'release'>,
    path: string,
    output: string,
    signal: AbortSignal,
    options?: ProcessingOptions,
    frame?: { width: number; height: number; sha256: string; hdr?: HdrStatisticsJob },
    pixel?: HdrPixelJob,
    importMode?: 'embedded' | 'fallback',
    importSeed?: PreviewResult,
  ): Promise<T> {
    signal.throwIfAborted()
    clearTimeout(this.idle)
    if (this.busy || (this.captureSession && mode !== 'capture-metadata-session'))
      throw new Error('The preview worker is busy.')
    this.busy = true
    let child: ChildProcess | undefined
    let diagnostics = ''
    const diagnostic = (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-4000)
    }
    try {
      child = this.child ??= this.launch()
      if (mode === 'process' && child.pid) {
        try {
          setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
        } catch {
          /* Scheduling remains cooperative on hosts without process priority support. */
        }
      }
      const worker = child
      worker.stderr?.on('data', diagnostic)
      return await new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          worker.off('message', message)
          worker.off('exit', exited)
          worker.off('error', failed)
          signal.removeEventListener('abort', aborted)
        }
        const failed = (error: Error) => {
          cleanup()
          reject(error)
        }
        const message = (value: { type?: string; stage?: string; result?: T; error?: string }) => {
          if (value.type === 'stage') {
            if (process.env.LUMA_PREVIEW_DIAGNOSTICS) console.info('Preview stage', value.stage)
            return
          }
          cleanup()
          if (value.result) resolve(value.result)
          else reject(new Error(value.error ?? 'Preview generation failed.'))
        }
        const exited = (code: number | null) => {
          cleanup()
          if (diagnostics) console.warn('Preview worker exited:', code, diagnostics)
          reject(new Error('The preview worker stopped. Try again.'))
        }
        const aborted = () => {
          cleanup()
          void this.close(
            mode === 'full' || mode === 'thumbnail-fallback' || importMode === 'fallback',
          ).finally(() => {
            reject(new Error('Preview generation cancelled.'))
          })
        }
        const timer = setTimeout(() => {
          cleanup()
          void this.close(
            mode === 'full' || mode === 'thumbnail-fallback' || importMode === 'fallback',
          ).finally(() => {
            reject(new Error('Preview generation timed out.'))
          })
        }, this.timeoutMs)
        worker.on('message', message)
        worker.once('exit', exited)
        worker.once('error', failed)
        signal.addEventListener('abort', aborted, { once: true })
        worker.send(
          { type: mode, path, output, options, frame, pixel, importMode, importSeed },
          (error) => {
            if (error) failed(error)
          },
        )
      })
    } finally {
      child?.stderr?.off('data', diagnostic)
      this.busy = false
    }
  }

  async close(force = false): Promise<void> {
    clearTimeout(this.idle)
    const child = this.child
    if (!child) return
    this.child = undefined
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      if (force) child.kill('SIGKILL')
      else if (child.connected) child.send({ type: 'close' }, () => {})
      else child.kill()
    })
  }
}
