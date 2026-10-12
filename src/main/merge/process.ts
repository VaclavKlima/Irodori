import { MergeError, type MergeFailure } from '../../shared/merge'
import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { MergeJob, MergeResult } from './engine'

export class MergeProcess {
  private child?: ChildProcess
  private paused = false
  constructor(private workerPath = join(import.meta.dirname, 'merge-worker.js')) {}
  async run(
    job: MergeJob,
    signal: AbortSignal,
    progress: (phase: string, completed: number, total: number) => void,
  ): Promise<MergeResult> {
    signal.throwIfAborted()
    if (this.child) throw new Error('The merge worker is busy.')
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
    })
    this.child = child
    child.stderr?.resume()
    try {
      return await new Promise<MergeResult>((resolve, reject) => {
        let result: MergeResult | undefined, error: Error | undefined
        const aborted = () => {
          error = new MergeError({
            code: 'cancelled',
            message: 'Merge cancelled.',
            filenames: [],
            diagnostics: [],
          })
          child.kill('SIGKILL')
        }
        signal.addEventListener('abort', aborted, { once: true })
        const timer = setTimeout(
          () => {
            error = new Error('Merge processing timed out.')
            child.kill('SIGKILL')
          },
          30 * 60 * 1000,
        )
        child.on(
          'message',
          (message: {
            result?: MergeResult
            error?: MergeFailure
            phase?: string
            completed: number
            total: number
          }) => {
            if (message.phase) {
              progress(message.phase, message.completed, message.total)
              return
            }
            if (message.result) result = message.result
            else
              error = new MergeError(
                message.error ?? {
                  code: 'processing',
                  message: 'Merge failed.',
                  filenames: [],
                  diagnostics: [],
                },
              )
            child.disconnect()
          },
        )
        child.once('error', (e) => {
          error = e
          // A spawn failure has no process and will not emit an exit event.
          if (!child.pid) {
            clearTimeout(timer)
            signal.removeEventListener('abort', aborted)
            reject(e)
          }
        })
        child.once('exit', () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', aborted)
          if (error) reject(error)
          else if (result) resolve(result)
          else reject(new Error('The merge worker stopped.'))
        })
        if (this.paused) child.send({ type: 'pause' })
        child.send({ type: 'run', job })
      })
    } finally {
      this.child = undefined
    }
  }
  pause(paused: boolean) {
    if (this.paused === paused) return
    this.paused = paused
    if (this.child?.connected) this.child.send({ type: paused ? 'pause' : 'resume' }, () => {})
  }
}
