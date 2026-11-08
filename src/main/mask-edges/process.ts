import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { ResolvedMask } from '../../shared/masks'
import type { MaskEdgeResult, MaskEdgeWorkerReply, MaskEdgeWorkerRequest } from './types'

interface OwnedChild {
  child: ChildProcess
  exited: Promise<void>
  stderr: string
}

/** A bounded GPU worker; cancellation and timeout wait for owned-process disappearance. */
export class MaskEdgeProcess {
  private owned?: OwnedChild
  private busy = false
  private serial = 0
  constructor(private options: { workerPath?: string; timeoutMs?: number } = {}) {}

  private start(): OwnedChild {
    if (this.owned) return this.owned
    const require = createRequire(import.meta.url)
    const platform = process.platform === 'win32' ? 'win' : process.platform
    const executable = join(
      dirname(require.resolve(`node-${platform}-${process.arch}/package.json`)),
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    ).replace('app.asar/', 'app.asar.unpacked/')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = fork(
      this.options.workerPath ?? join(import.meta.dirname, 'mask-edge-worker.js'),
      [],
      {
        execPath: executable,
        execArgv: [],
        env,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    )
    const owned: OwnedChild = {
      child,
      stderr: '',
      exited: new Promise((resolve) => {
        child.once('close', () => {
          if (this.owned === owned) this.owned = undefined
          resolve()
        })
      }),
    }
    child.stderr?.on('data', (data: Buffer) => {
      owned.stderr = (owned.stderr + data.toString()).slice(-4096)
    })
    child.on('error', () => undefined)
    this.owned = owned
    return owned
  }

  async close(): Promise<void> {
    const owned = this.owned
    if (!owned) return
    owned.child.kill('SIGKILL')
    await owned.exited
    if (this.owned === owned) this.owned = undefined
  }

  async prepare(
    mask: ResolvedMask,
    width: number,
    height: number,
    key: string,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<MaskEdgeResult> {
    signal.throwIfAborted()
    if (this.busy) throw new Error('Mask edge processing is already running.')
    this.busy = true
    const id = ++this.serial
    try {
      const owned = this.start()
      return await new Promise<MaskEdgeResult>((resolve, reject) => {
        let failure: Error | undefined
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', aborted)
          owned.child.removeListener('message', message)
          owned.child.removeListener('error', failed)
          owned.child.removeListener('close', closed)
        }
        const failed = (error: Error) => {
          cleanup()
          reject(error)
        }
        const closed = () =>
          failed(
            failure ??
              new Error(
                `Mask edge GPU worker stopped.${owned.stderr ? ` ${owned.stderr.trim()}` : ''}`,
              ),
          )
        const aborted = () => {
          failure = new Error('Mask edge processing cancelled.')
          owned.child.kill('SIGKILL')
        }
        const message = (reply: MaskEdgeWorkerReply) => {
          if (reply.id !== id) return
          cleanup()
          if (failure || signal.aborted)
            reject(failure ?? new Error('Mask edge processing cancelled.'))
          else if (reply.error) reject(new Error(reply.error))
          else if (reply.result) resolve(reply.result)
          else reject(new Error('Mask edge worker returned no result.'))
        }
        const timer = setTimeout(() => {
          failure = new Error(
            'Mask edge GPU processing timed out. Retry GPU to start a new worker.',
          )
          owned.child.kill('SIGKILL')
        }, this.options.timeoutMs ?? 120_000)
        signal.addEventListener('abort', aborted, { once: true })
        owned.child.on('message', message)
        owned.child.once('error', failed)
        owned.child.once('close', closed)
        if (signal.aborted) {
          aborted()
          return
        }
        owned.child.send(
          {
            id,
            mask: structuredClone(mask),
            width,
            height,
            key,
            outputPath,
          } satisfies MaskEdgeWorkerRequest,
          (error) => {
            if (error) failed(error)
          },
        )
      })
    } catch (error) {
      await this.close()
      await Promise.allSettled([
        rm(outputPath, { force: true }),
        rm(`${outputPath}.tmp`, { force: true }),
      ])
      throw error
    } finally {
      this.busy = false
    }
  }
}
