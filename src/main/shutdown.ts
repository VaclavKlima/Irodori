import { randomUUID } from 'node:crypto'
import type { IpcMain, WebContents, IpcMainEvent } from 'electron'
import type { EditFlushScope } from '../shared/edits'

export type SaveResult = { status: 'saved' } | { status: 'error' | 'unknown'; reason: string }
export type ShutdownReason = 'close' | 'quit' | 'development-stop' | 'development-lost'
export type ShutdownOutcome = 'kept-open' | 'closing'

export function editorAvailable(contents: WebContents | undefined): contents is WebContents {
  return (
    !!contents &&
    !contents.isDestroyed() &&
    !contents.isCrashed() &&
    contents.getOSProcessId() > 0 &&
    !contents.isLoadingMainFrame()
  )
}

/** One token and one document lifetime. A replacement document cannot acknowledge old work. */
export function flushRenderer(
  contents: WebContents | undefined,
  ipc: Pick<IpcMain, 'on' | 'removeListener'>,
  kind: 'edits' | 'workspace',
  scope?: EditFlushScope,
  timeoutMs = 10_000,
): Promise<SaveResult> {
  if (!editorAvailable(contents))
    return Promise.resolve({
      status: 'unknown',
      reason: 'The editor is unavailable. Saving could not be confirmed.',
    })
  const frame = contents.mainFrame
  const token = randomUUID()
  return new Promise((resolve) => {
    const finish = (result: SaveResult) => {
      clearTimeout(timer)
      ipc.removeListener(`${kind}:flushed`, reply)
      contents.removeListener('destroyed', destroyed)
      contents.removeListener('render-process-gone', crashed)
      contents.removeListener('did-start-navigation', navigating)
      resolve(result)
    }
    const unknown = (reason: string) => finish({ status: 'unknown', reason })
    const destroyed = () => unknown('The editor closed. Saving could not be confirmed.')
    const crashed = () => unknown('The editor process stopped. Saving could not be confirmed.')
    const navigating = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument)
        unknown('The editor reloaded or navigated. Saving could not be confirmed.')
    }
    const reply = (event: IpcMainEvent, returned: string, error?: string) => {
      if (
        returned !== token ||
        event.sender !== contents ||
        contents.isDestroyed() ||
        event.senderFrame !== frame
      )
        return
      finish(error === undefined ? { status: 'saved' } : { status: 'error', reason: String(error) })
    }
    const timer = setTimeout(
      () => unknown('The editor did not respond within 10 seconds. Saving could not be confirmed.'),
      timeoutMs,
    )
    ipc.on(`${kind}:flushed`, reply)
    contents.once('destroyed', destroyed)
    contents.once('render-process-gone', crashed)
    contents.on('did-start-navigation', navigating)
    try {
      contents.send(`${kind}:flush`, token, ...(kind === 'edits' ? [scope] : []))
    } catch {
      unknown('The editor could not receive the save request. Saving could not be confirmed.')
    }
  })
}

interface ShutdownActions {
  pauseAdmission(paused: boolean): void
  confirmTasks(): Promise<boolean>
  flushEdits(): Promise<SaveResult>
  recover(result: SaveResult, reason: ShutdownReason): Promise<'keep' | 'retry' | 'quit'>
  sealAdmission(): void
  flushWorkspace(): Promise<void>
  cleanup(): Promise<void>
  report(error: unknown): void
  exit(code: number): void
}

/** Close, Quit and development stopping join one attempt, including its recovery dialog. */
export class ShutdownCoordinator {
  private attempt?: Promise<ShutdownOutcome>
  private closing = false
  constructor(private actions: ShutdownActions) {}

  request(reason: ShutdownReason): Promise<ShutdownOutcome> {
    if (this.attempt) return this.attempt
    this.actions.pauseAdmission(true)
    this.attempt = Promise.resolve()
      .then(() => this.run(reason))
      .finally(() => {
        if (!this.closing) {
          this.actions.pauseAdmission(false)
          this.attempt = undefined
        }
      })
    return this.attempt
  }

  private async run(reason: ShutdownReason): Promise<ShutdownOutcome> {
    try {
      if (!(await this.actions.confirmTasks())) return 'kept-open'
      let developmentNotice = reason === 'development-lost'
      for (;;) {
        const result = await this.actions.flushEdits()
        if (result.status === 'saved' && !developmentNotice) break
        const choice = await this.actions.recover(result, reason)
        if (choice === 'keep') return 'kept-open'
        if (choice === 'quit') break
        developmentNotice = false
      }
    } catch (error) {
      this.actions.report(error)
      return 'kept-open'
    }
    this.closing = true
    let code = 0
    try {
      await closeServices([
        () => this.actions.sealAdmission(),
        () => this.actions.flushWorkspace(),
        () => this.actions.cleanup(),
      ])
    } catch (error) {
      code = 1
      this.actions.report(error)
    }
    this.actions.exit(code)
    return 'closing'
  }
}

export async function closeServices(actions: Array<() => Promise<void> | void>): Promise<void> {
  const errors: unknown[] = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Could not close every application service.')
}
