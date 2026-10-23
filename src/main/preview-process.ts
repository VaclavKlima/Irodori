import type { ImageStatistics } from '../shared/statistics'
import type { HdrStatistics } from '../shared/hdr-statistics'
import type {
  HdrStatisticsJob,
  HdrPixelJob,
  PreviewWorkerRequest,
  HdrFirstSurfaceProgress,
  PreviewWarmResult,
  HdrRawPreparation,
  NativeRawMainMessage,
} from './preview-types'
import type { HdrCacheKernelKind } from '../renderer/src/preview/hdr-shader'
import type { HdrPixel } from '../shared/hdr-pixel'
import type { ProcessingMetadata, ProcessingOptions } from '../shared/lens'
import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { NativeRawOwner, type NativeRawExecutableResolver } from './native-raw-owner'
import { prepareNativeRawExecutable } from './native-raw-executable'
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

function validWarmResult(
  value: unknown,
  kernel: HdrCacheKernelKind | undefined,
): value is PreviewWarmResult {
  const result = value as Partial<PreviewWarmResult> | null
  const finiteDuration = (duration: unknown): duration is number =>
    typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
  if (
    !result ||
    !['ready', 'unavailable', 'skipped'].includes(result.status ?? '') ||
    result.kernel !== kernel ||
    !finiteDuration(result.elapsedMs) ||
    !result.timings ||
    result.timings.totalMs !== result.elapsedMs ||
    (result.reason !== undefined && typeof result.reason !== 'string')
  )
    return false
  return (['wasmMs', 'tableMs', 'gpuMs'] as const).every((stage) =>
    result.timings![stage] === undefined
      ? result.status !== 'ready'
      : finiteDuration(result.timings![stage]),
  )
}

export class PreviewProcess implements PreviewProcessor, FullPreviewProcessor, ThumbnailProcessor {
  private child?: ChildProcess
  private retiring = new WeakMap<ChildProcess, Promise<void>>()
  private retirements = new Set<Promise<void>>()
  private nativeOwners = new WeakMap<ChildProcess, NativeRawOwner>()
  private workerCloses = new WeakMap<ChildProcess, Promise<void>>()
  private warming?: Promise<PreviewWarmResult>
  private lifecycle = 0
  private busy = false
  private captureSession = false
  private idle?: ReturnType<typeof setTimeout>

  constructor(
    private workerPath = join(import.meta.dirname, 'preview-worker.js'),
    private timeoutMs = 90_000,
    private idleMs = 30_000,
    private nativeExecutable: NativeRawExecutableResolver = prepareNativeRawExecutable,
  ) {}

  prewarmHdr(kernel: HdrCacheKernelKind): Promise<PreviewWarmResult> {
    if (kernel !== 'linear64') return Promise.reject(new Error('Invalid HDR warm-up kernel.'))
    if (this.warming) return this.warming
    const warming = this.run<PreviewWarmResult>(
      'warmup',
      '',
      '',
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      kernel,
    ).finally(() => {
      if (this.warming === warming) {
        this.warming = undefined
      }
      this.scheduleIdle()
    })
    this.warming = warming
    return warming
  }

  private async waitForWarmup(signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    const lifecycle = this.lifecycle
    // Warm-up failure is optional; the normal request still owns its fallback decision.
    const warming = this.warming
    if (warming) {
      let aborted: (() => void) | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          aborted = () => reject(new Error('Preview generation cancelled.'))
          signal.addEventListener('abort', aborted, { once: true })
          void warming.then(
            () => resolve(),
            () => resolve(),
          )
        })
      } finally {
        if (aborted) signal.removeEventListener('abort', aborted)
      }
    }
    signal.throwIfAborted()
    if (lifecycle !== this.lifecycle) throw new Error('Preview generation cancelled.')
    return lifecycle
  }

  private scheduleIdle(): void {
    clearTimeout(this.idle)
    const child = this.child
    if (!child || this.busy) return
    this.idle = setTimeout(() => {
      if (this.child === child && !this.busy) void this.retireChild(child, false)
    }, this.idleMs)
    this.idle.unref()
  }

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
    this.workerCloses.set(
      child,
      new Promise<void>((resolve) => child.once('close', () => resolve())),
    )
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
    return new PreviewProcess(this.workerPath, this.timeoutMs, this.idleMs, this.nativeExecutable)
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
    onFirstSurface?: (progress: HdrFirstSurfaceProgress) => Promise<void>,
    preparation?: HdrRawPreparation,
  ): Promise<FullPreviewResult> {
    this.assertIdle(await this.waitForWarmup(signal))
    const result = await this.run<FullPreviewResult>(
      'full',
      path,
      output,
      signal,
      options,
      undefined,
      undefined,
      undefined,
      undefined,
      onFirstSurface,
      undefined,
      preparation,
    )
    // Preserve GPU shader compilation across nearby requests. CPU RAW processing has a
    // much larger WASM high-water mark; reclaim that process after its completed render.
    this.scheduleIdle()
    if (process.env.LUMA_PREVIEW_DIAGNOSTICS) console.info('Full preview', result.diagnostics)
    return result
  }

  async statistics(
    path: string,
    frame: { width: number; height: number; sha256: string },
    signal: AbortSignal,
  ): Promise<ImageStatistics> {
    this.assertIdle(await this.waitForWarmup(signal))
    return this.run<ImageStatistics>('statistics', path, '', signal, undefined, frame).finally(
      () => {
        this.scheduleIdle()
      },
    )
  }

  async hdrStatistics(
    path: string,
    job: HdrStatisticsJob,
    signal: AbortSignal,
  ): Promise<HdrStatistics> {
    this.assertIdle(await this.waitForWarmup(signal))
    return this.run<HdrStatistics>('statistics', path, '', signal, undefined, {
      width: job.asset.width,
      height: job.asset.height,
      sha256: job.asset.sha256,
      hdr: job,
    }).finally(() => {
      this.scheduleIdle()
    })
  }

  async hdrPixel(path: string, job: HdrPixelJob, signal: AbortSignal): Promise<HdrPixel> {
    this.assertIdle(await this.waitForWarmup(signal))
    return this.run<HdrPixel>('pixel', path, '', signal, undefined, undefined, job).finally(() => {
      this.scheduleIdle()
    })
  }

  releaseFrame(): void {
    if (!this.busy && this.child?.connected) this.child.send({ type: 'release' }, () => {})
  }

  private assertIdle(lifecycle = this.lifecycle) {
    if (lifecycle !== this.lifecycle) throw new Error('Preview generation cancelled.')
    if (this.busy || this.captureSession) throw new Error('The preview worker is busy.')
  }

  private async run<T>(
    mode: Exclude<PreviewWorkerRequest['type'], 'close' | 'release' | NativeRawMainMessage['type']>,
    path: string,
    output: string,
    signal: AbortSignal,
    options?: ProcessingOptions,
    frame?: { width: number; height: number; sha256: string; hdr?: HdrStatisticsJob },
    pixel?: HdrPixelJob,
    importMode?: 'embedded' | 'fallback',
    importSeed?: PreviewResult,
    onFirstSurface?: (progress: HdrFirstSurfaceProgress) => Promise<void>,
    kernel?: HdrCacheKernelKind,
    preparation?: HdrRawPreparation,
  ): Promise<T> {
    signal.throwIfAborted()
    clearTimeout(this.idle)
    if (this.busy || (this.captureSession && mode !== 'capture-metadata-session'))
      throw new Error('The preview worker is busy.')
    this.busy = true
    const lifecycle = this.lifecycle
    let child: ChildProcess | undefined
    let diagnostics = ''
    const diagnostic = (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-4000)
    }
    try {
      await Promise.all([...this.retirements])
      signal.throwIfAborted()
      if (lifecycle !== this.lifecycle) throw new Error('Preview generation cancelled.')
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
        let publication = Promise.resolve()
        let terminal = false
        let completed = false
        let finishing: Promise<void> | undefined
        let nativeOwner: NativeRawOwner | undefined
        const fail = (error: Error, force = true) => {
          if (completed || finishing) return
          terminal = true
          cleanup()
          // The specific child and any in-progress file offer keep ownership until both drain.
          // Never clear busy/reuse a still-preparing worker after a publication failure.
          finishing = Promise.all([
            this.retireChild(worker, force),
            publication.catch(() => undefined),
          ]).then(
            () => {
              completed = true
              reject(error)
            },
            () => {
              completed = true
              reject(error)
            },
          )
        }
        const failed = (error: Error) => fail(error)
        const message = (value: {
          type?: string
          stage?: string
          result?: T
          error?: string
          progress?: HdrFirstSurfaceProgress
          nonce?: unknown
        }) => {
          if (terminal) return
          if (value.type === 'raw-source-request' || value.type === 'raw-source-reader-ready') {
            try {
              if (mode !== 'full' || !nativeOwner) throw new Error('Unexpected native RAW request.')
              if (value.type === 'raw-source-request') nativeOwner.request(value.nonce)
              else nativeOwner.readerReady(value.nonce)
            } catch (error) {
              failed(error instanceof Error ? error : new Error(String(error)))
            }
            return
          }
          if (value.type === 'stage') {
            if (process.env.LUMA_PREVIEW_DIAGNOSTICS) console.info('Preview stage', value.stage)
            return
          }
          if (value.type === 'first-surface') {
            if (!value.progress || !onFirstSurface) {
              failed(new Error('Unexpected first HDR surface progress.'))
              return
            }
            const progress = value.progress
            publication = publication.then(() => onFirstSurface(progress))
            void publication.catch(failed)
            return
          }
          if (value.type !== 'result' && value.type !== 'error') {
            failed(new Error('Unexpected preview worker response.'))
            return
          }
          terminal = true
          void publication
            .then(async () => {
              if (finishing || completed) return
              signal.throwIfAborted()
              if (!value.result && (mode === 'full' || mode === 'warmup')) {
                fail(new Error(value.error ?? 'Preview generation failed.'), mode !== 'warmup')
                return
              }
              await nativeOwner?.finish()
              if (finishing || completed) return
              signal.throwIfAborted()
              if (mode === 'warmup') {
                if (!validWarmResult(value.result, kernel)) {
                  fail(new Error('Invalid preview warm-up result.'))
                  return
                }
                if (value.result.status === 'unavailable') {
                  const result = value.result
                  cleanup()
                  // A failed LibRaw module promise is process-sticky. Drain this exact child
                  // before waking demand, without changing its existing lifecycle generation.
                  finishing = this.retireChild(worker, false).then(
                    () => {
                      completed = true
                      resolve(result)
                    },
                    (error: unknown) => {
                      completed = true
                      reject(error)
                    },
                  )
                  return
                }
              }
              cleanup()
              completed = true
              if (value.result) resolve(value.result)
              else reject(new Error(value.error ?? 'Preview generation failed.'))
            })
            .catch(failed)
        }
        const exited = (code: number | null) => {
          if (diagnostics) console.warn('Preview worker exited:', code, diagnostics)
          fail(new Error('The preview worker stopped. Try again.'))
        }
        const forceCancellation =
          mode === 'full' || mode === 'thumbnail-fallback' || importMode === 'fallback'
        const aborted = () => fail(new Error('Preview generation cancelled.'), forceCancellation)
        const timer = setTimeout(() => {
          fail(new Error('Preview generation timed out.'), forceCancellation)
        }, this.timeoutMs)
        worker.on('message', message)
        worker.once('exit', exited)
        worker.once('error', failed)
        signal.addEventListener('abort', aborted, { once: true })
        if (preparation) {
          try {
            if (mode !== 'full') throw new Error('Native RAW admission requires a full request.')
            const context = { ...preparation, nonce: randomBytes(16).toString('hex') }
            nativeOwner = new NativeRawOwner({
              worker,
              path,
              context,
              signal,
              executable: this.nativeExecutable,
              current: () =>
                this.lifecycle === lifecycle && this.child === worker && !finishing && !completed,
              failed,
            })
            // Registration precedes every native setup await and the initial full dispatch.
            this.nativeOwners.set(worker, nativeOwner)
          } catch (error) {
            failed(error instanceof Error ? error : new Error(String(error)))
            return
          }
        }
        worker.send(
          {
            type: mode,
            path,
            output,
            options,
            frame,
            pixel,
            importMode,
            importSeed,
            kernel,
            nativeRaw: nativeOwner?.context,
          },
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

  private retireChild(child: ChildProcess, force: boolean): Promise<void> {
    if (this.child === child) this.child = undefined
    const retiring = this.retiring.get(child)
    if (retiring) {
      if (force && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      return retiring
    }
    const workerClosed =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
            child.once('exit', () => {
              clearTimeout(timer)
              resolve()
            })
            if (force) child.kill('SIGKILL')
            else if (child.connected) child.send({ type: 'close' }, () => {})
            else child.kill()
          })
    const drained = Promise.all([
      workerClosed,
      this.workerCloses.get(child),
      this.nativeOwners.get(child)?.retire(),
    ]).then(() => undefined)
    this.retiring.set(child, drained)
    this.retirements.add(drained)
    void drained.then(
      () => this.retirements.delete(drained),
      () => this.retirements.delete(drained),
    )
    return drained
  }

  async close(force = false): Promise<void> {
    this.lifecycle++
    clearTimeout(this.idle)
    const child = this.child
    if (child) await this.retireChild(child, force)
    await Promise.all([...this.retirements])
  }
}
