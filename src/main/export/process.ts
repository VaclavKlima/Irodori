import { execFile, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PreviewProcess } from '../preview-process'
import type { ExportRenderJob } from './types'

/** Decoder and encoder never retain their WASM heaps in the same process. */
export class ExportProcess {
  constructor(
    private workerPath = join(import.meta.dirname, 'export-worker.js'),
    private previewWorkerPath = join(import.meta.dirname, 'preview-worker.js'),
  ) {}
  async render(
    job: ExportRenderJob,
    signal: AbortSignal,
  ): Promise<{ path: string; sha256: string }> {
    signal.throwIfAborted()
    const source = structuredClone(job.source)
    if (source.hdr && !source.processing.metadata.mergeMaster) {
      const decoder = new PreviewProcess(this.previewWorkerPath)
      try {
        const frame = await decoder.renderFull(source.path, job.directory, signal, {
          ...source.processing,
          workingOnly: true,
        })
        if (!frame.linear?.hdr) throw new Error('The RAW decoder returned no HDR master.')
        source.processing.workingAsset = {
          ...frame.linear,
          width: frame.width,
          height: frame.height,
          path: join(job.directory, 'linear.f32'),
        }
      } finally {
        await decoder.close(true)
      }
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
      let result: { path: string; sha256: string } | undefined, error: Error | undefined
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
      child.on('message', (value: { result?: typeof result; error?: string }) => {
        result = value.result
        if (value.error) error = new Error(value.error)
      })
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
        else if (result) resolve(result)
        else reject(new Error(`The export worker stopped. ${diagnostics}`))
      })
      if (signal.aborted) abort()
      else child.send({ ...job, source })
    })
  }
}
