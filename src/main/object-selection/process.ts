import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { packObjectSelectionPrompts } from './prompts'
import type {
  ObjectSelectionPrepared,
  ObjectSelectionPrompts,
  ObjectSelectionResult,
  ObjectSelectionSource,
  ObjectSelectionWorkerReply,
  ObjectSelectionWorkerRequest,
} from './types'

interface OwnedChild {
  child: ChildProcess
  exited: Promise<void>
  stderr: string
}

/** One GPU child and one retained image embedding; cancellation waits for child ownership to end. */
export class ObjectSelectionProcess {
  private owned?: OwnedChild
  private busy = false
  private serial = 0
  constructor(
    private options: { workerPath?: string; modelDirectory?: string; timeoutMs?: number } = {},
  ) {}

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
      this.options.workerPath ?? join(import.meta.dirname, 'object-selection-worker.js'),
      [],
      { execPath: executable, execArgv: [], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
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
    // Every request owns a detailed failure listener; retain a listener between requests too.
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

  private async request<T extends ObjectSelectionPrepared>(
    request:
      | Omit<
          Extract<ObjectSelectionWorkerRequest, { operation: 'prepare' }>,
          'id' | 'modelDirectory'
        >
      | Omit<
          Extract<ObjectSelectionWorkerRequest, { operation: 'refine' }>,
          'id' | 'modelDirectory'
        >,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted()
    if (this.busy) throw new Error('Object selection is already processing a request.')
    this.busy = true
    const id = ++this.serial
    try {
      const owned = this.start()
      return await new Promise<T>((resolve, reject) => {
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
                `Object selection GPU worker stopped.${owned.stderr ? ` ${owned.stderr.trim()}` : ''}`,
              ),
          )
        const aborted = () => {
          failure = new Error('Object selection cancelled.')
          owned.child.kill('SIGKILL')
        }
        const message = (reply: ObjectSelectionWorkerReply) => {
          if (reply.id !== id) return
          cleanup()
          if (failure || signal.aborted) reject(failure ?? new Error('Object selection cancelled.'))
          else if (reply.error) reject(new Error(reply.error))
          else if (reply.result) resolve(reply.result as T)
          else reject(new Error('Object selection worker returned no result.'))
        }
        const timer = setTimeout(() => {
          failure = new Error(
            'Object selection GPU processing timed out. Retry GPU to start a new worker.',
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
            ...request,
            id,
            modelDirectory:
              this.options.modelDirectory ?? join(import.meta.dirname, 'object-selection-model'),
          } satisfies ObjectSelectionWorkerRequest,
          (error) => {
            if (error) failed(error)
          },
        )
      })
    } catch (error) {
      await this.close()
      if (request.operation === 'refine')
        await Promise.allSettled([
          rm(request.outputPath, { force: true }),
          rm(`${request.outputPath}.tmp`, { force: true }),
        ])
      throw error
    } finally {
      this.busy = false
    }
  }

  prepare(source: ObjectSelectionSource, signal: AbortSignal): Promise<ObjectSelectionPrepared> {
    return this.request({ operation: 'prepare', source: structuredClone(source) }, signal)
  }

  refine(
    prompts: ObjectSelectionPrompts,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<ObjectSelectionResult> {
    packObjectSelectionPrompts(prompts)
    return this.request(
      { operation: 'refine', prompts: structuredClone(prompts), outputPath },
      signal,
    )
  }

  async run(
    source: ObjectSelectionSource,
    prompts: ObjectSelectionPrompts,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<ObjectSelectionResult> {
    await this.prepare(source, signal)
    return this.refine(prompts, outputPath, signal)
  }
}
