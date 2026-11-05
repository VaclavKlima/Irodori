import { test, expect } from '@playwright/test'
import { EventEmitter } from 'node:events'
import type { IpcMain, WebContents } from 'electron'
import { acknowledgeFlush } from '../src/preload/flush'
import { LibraryAdmission } from '../src/main/library-admission'
import { flushRenderer, ShutdownCoordinator, type SaveResult } from '../src/main/shutdown'

function gate<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderer() {
  const events = new EventEmitter()
  const ipc = new EventEmitter()
  const messages: unknown[][] = []
  const contents = Object.assign(events, {
    mainFrame: {},
    isDestroyed: () => false,
    isCrashed: () => false,
    getOSProcessId: (): number => 123,
    isLoadingMainFrame: () => false,
    send: (...message: unknown[]) => {
      messages.push(message)
    },
  })
  return {
    contents,
    ipc,
    messages,
    flush: (ms = 50) =>
      flushRenderer(
        contents as unknown as WebContents,
        ipc as IpcMain,
        'edits',
        { kind: 'all' },
        ms,
      ),
    reply: (token = messages.at(-1)![1], error?: string, frame = contents.mainFrame) =>
      ipc.emit('edits:flushed', { sender: contents, senderFrame: frame }, token, error),
    clean() {
      expect(ipc.listenerCount('edits:flushed')).toBe(0)
      for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation'])
        expect(contents.listenerCount(event)).toBe(0)
    },
  }
}

test('flush binds tokens, sender and original frame, and removes every lifecycle listener', async () => {
  const f = renderer()
  const pending = f.flush()
  f.reply('stale')
  f.reply(undefined, undefined, {})
  f.ipc.emit('edits:flushed', { sender: {}, senderFrame: f.contents.mainFrame }, f.messages[0][1])
  expect(f.ipc.listenerCount('edits:flushed')).toBe(1)
  f.reply()
  expect(await pending).toEqual({ status: 'saved' })
  f.clean()
})

test('an exited renderer is unavailable even when Electron does not classify the exit as a crash', async () => {
  const f = renderer()
  f.contents.getOSProcessId = () => 0
  expect(await f.flush()).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('unavailable'),
  })
  expect(f.messages).toHaveLength(0)
  f.clean()
})

for (const cause of [
  'destroyed',
  'render-process-gone',
  'navigation',
  'silence',
  'send-error',
] as const)
  test(`flush reports unknown saving on ${cause} and rejects an obsolete reply`, async () => {
    const f = renderer()
    if (cause === 'send-error')
      f.contents.send = () => {
        throw new Error('Disposed')
      }
    const pending = f.flush(5)
    const old = f.messages[0]?.[1]
    if (cause === 'navigation') {
      f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
      f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
      expect(f.ipc.listenerCount('edits:flushed')).toBe(1)
      f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    } else if (cause === 'destroyed' || cause === 'render-process-gone') f.contents.emit(cause)
    const result = await pending
    expect(result).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('could not be confirmed'),
    })
    expect(JSON.stringify(result)).not.toMatch(/disk|storage failure/i)
    f.clean()
    if (cause === 'send-error') return
    const retried = f.flush()
    f.reply(old)
    expect(f.ipc.listenerCount('edits:flushed')).toBe(1)
    f.reply()
    expect(await retried).toEqual({ status: 'saved' })
    f.clean()
  })

test('explicit, rejected and synchronous save failures preserve their actual reason', async () => {
  for (const listener of [
    () => {
      throw new Error('Injected synchronous failure')
    },
    () => Promise.reject(new Error('Injected asynchronous failure')),
    async () => {},
  ]) {
    const f = renderer()
    const pending = f.flush()
    acknowledgeFlush(listener, (error) => f.reply(undefined, error))
    expect(await pending).toEqual(
      listener.toString().includes('failure')
        ? {
            status: 'error',
            reason: expect.stringMatching(/^Error: Injected (synchronous|asynchronous) failure$/),
          }
        : { status: 'saved' },
    )
    f.clean()
  }
})

function coordinator() {
  const log: unknown[] = []
  const actions = {
    pauseAdmission: (paused: boolean) => {
      log.push(['pause', paused])
    },
    confirmTasks: async () => true,
    flushEdits: async (): Promise<SaveResult> => ({
      status: 'unknown',
      reason: 'No acknowledgement',
    }),
    recover: async (): Promise<'keep' | 'retry' | 'quit'> => 'keep',
    sealAdmission: () => {
      log.push('seal')
    },
    flushWorkspace: async () => {
      log.push('workspace')
    },
    cleanup: async () => {
      log.push('cleanup')
    },
    report: (error: unknown) => {
      log.push(error)
    },
    exit: (code: number) => {
      log.push(['exit', code])
    },
  }
  return { actions, log, create: () => new ShutdownCoordinator(actions) }
}

test('repeated Close, Quit and development-stop join the recovery attempt; Keep open restores admission', async () => {
  const f = coordinator(),
    answer = gate<'keep'>()
  let dialogs = 0
  f.actions.recover = () => {
    dialogs++
    return answer.promise
  }
  const shutdown = f.create()
  const first = shutdown.request('close')
  expect(shutdown.request('quit')).toBe(first)
  expect(shutdown.request('development-stop')).toBe(first)
  await expect.poll(() => dialogs).toBe(1)
  answer.resolve('keep')
  expect(await first).toBe('kept-open')
  expect(f.log).toEqual([
    ['pause', true],
    ['pause', false],
  ])
  f.actions.confirmTasks = async () => false
  expect(await shutdown.request('quit')).toBe('kept-open')
  expect(dialogs).toBe(1)
})

test('Retry saving flushes afresh; Quit anyway still checkpoints, drains and exits', async () => {
  for (const choice of ['retry', 'quit'] as const) {
    const f = coordinator()
    let saves = 0
    f.actions.flushEdits = async () =>
      ++saves === 1 ? { status: 'error', reason: 'Permission denied' } : { status: 'saved' }
    f.actions.recover = async () => choice
    const shutdown = f.create()
    expect(await shutdown.request('quit')).toBe('closing')
    expect(saves).toBe(choice === 'retry' ? 2 : 1)
    expect(f.log).toEqual([['pause', true], 'seal', 'workspace', 'cleanup', ['exit', 0]])
  }
})

test('development loss offers Keep open even after successful saving', async () => {
  const f = coordinator()
  f.actions.flushEdits = async () => ({ status: 'saved' })
  expect(await f.create().request('development-lost')).toBe('kept-open')
  expect(f.log).toEqual([
    ['pause', true],
    ['pause', false],
  ])
})

test('checkpoint failure still attempts cleanup and exits unsuccessfully', async () => {
  const f = coordinator()
  f.actions.recover = async () => 'quit'
  f.actions.flushWorkspace = async () => {
    throw new Error('checkpoint failure')
  }
  f.actions.cleanup = async () => {
    f.log.push('cleanup')
    throw new Error('cleanup failure')
  }
  expect(await f.create().request('quit')).toBe('closing')
  expect(f.log).toContain('cleanup')
  expect(f.log.at(-1)).toEqual(['exit', 1])
  expect(f.log.find((entry) => entry instanceof AggregateError)).toMatchObject({
    errors: expect.any(Array),
  })
})

test('admission covers validation and nested work across sealing while refusing new operations', async () => {
  const admission = new LibraryAdmission(),
    entered = gate(),
    release = gate()
  const pending = admission.run(async () => {
    entered.resolve()
    await release.promise
    return admission.run(async () => 'committed')
  })
  await entered.promise
  admission.seal()
  expect(() => admission.assertTask()).toThrow('closing')
  await expect(admission.run(async () => 'late')).rejects.toThrow('closing')
  let drained = false
  const drain = admission.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release.resolve()
  expect(await pending).toBe('committed')
  await drain
})
