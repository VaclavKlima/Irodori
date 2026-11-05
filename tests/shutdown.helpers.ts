import { expect, type TestInfo } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { launchTestElectron, assertTestWindowPolicy } from '../scripts/electron-test-launch.mjs'

export async function launchShutdown(info: TestInfo, profile?: string) {
  const root = profile ?? (await mkdtemp(join(tmpdir(), 'irodori-shutdown-')))
  const { app, child, evidenceFile } = await launchTestElectron({
    userDataDir: root,
    artifacts: info.outputPath(profile ? 'reopened' : 'initial'),
  })
  const logs: string[] = []
  child.stderr?.on('data', (bytes: Buffer) => logs.push(bytes.toString()))
  app.on('console', (message) => logs.push(message.text()))
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-version')).not.toBeEmpty()
  return {
    root,
    app,
    child,
    page,
    async quit() {
      await app.evaluate(({ app }) => {
        setImmediate(() => app.quit())
      })
    },
    async exited(code = 0) {
      // The Playwright connection closing is insufficient: assert the OS child exit before teardown.
      await expect.poll(() => child.exitCode, { timeout: 30_000 }).toBe(code)
      expect(child.signalCode).toBeNull()
      await assertTestWindowPolicy(evidenceFile)
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) {
        const state = await app
          .evaluate(({ BrowserWindow, ipcMain }) => ({
            injected: (globalThis as unknown as { __shutdownTest?: unknown }).__shutdownTest,
            windows: BrowserWindow.getAllWindows().map((window) => ({
              destroyed: window.isDestroyed(),
              crashed: window.webContents.isCrashed(),
              loading: window.webContents.isLoadingMainFrame(),
              process: window.webContents.getOSProcessId(),
            })),
            editWaits: ipcMain.listenerCount('edits:flushed'),
            workspaceWaits: ipcMain.listenerCount('workspace:flushed'),
          }))
          .catch(() => undefined)
        await writeFile(
          info.outputPath('pending-shutdown.json'),
          JSON.stringify(state ?? null, null, 2),
        )
      }
      if (child.exitCode === null && child.signalCode === null) {
        await app.evaluate(({ app }) => app.exit(91)).catch(() => {})
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
      }
      await writeFile(info.outputPath(profile ? 'reopened.log' : 'initial.log'), logs.join('\n'))
      await assertTestWindowPolicy(evidenceFile)
      if (!profile) await rm(root, { recursive: true, force: true })
    },
  }
}

export type ShutdownFixture = Awaited<ReturnType<typeof launchShutdown>>
export type Fault = 'none' | 'silence' | 'error' | 'crash' | 'reload' | 'hang'
interface InjectedState {
  dialogs: Electron.MessageBoxOptions[]
  flushes: number
  setFault(fault: Fault): void
}

export async function injectShutdown(
  f: ShutdownFixture,
  fault: Fault,
  choices: ('keep' | 'retry' | 'quit')[],
) {
  await f.app.evaluate(
    ({ BrowserWindow, ipcMain, dialog }, options) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const send = contents.send.bind(contents)
      let fault = options.fault
      const state: InjectedState = {
        dialogs: [],
        flushes: 0,
        setFault: (value) => {
          fault = value
        },
      }
      Object.assign(globalThis, { __shutdownTest: state })
      contents.send = (channel, ...args) => {
        if (channel === 'edits:flush') {
          state.flushes++
          if (fault === 'silence') return
          if (fault === 'error') {
            queueMicrotask(() =>
              ipcMain.emit(
                'edits:flushed',
                { sender: contents, senderFrame: contents.mainFrame },
                args[0],
                'Injected save error: storage is read-only',
              ),
            )
            return
          }
          if (fault === 'crash') {
            // Fatal Chromium crashes can wait on the attached debugger. Terminate only the
            // isolated renderer to exercise the real render-process-gone event deterministically.
            setImmediate(() => process.kill(contents.getOSProcessId(), 'SIGKILL'))
            return
          }
          if (fault === 'reload') {
            setImmediate(() => contents.reload())
            return
          }
          if (fault === 'hang') void contents.executeJavaScript('while (true) {}').catch(() => {})
        }
        send(channel, ...args)
      }
      dialog.showMessageBox = async (...args: unknown[]) => {
        const box = args.at(-1) as Electron.MessageBoxOptions
        state.dialogs.push(box)
        const choice = options.choices.shift() ?? 'keep'
        if (choice === 'retry') fault = 'none'
        return {
          response: box.buttons!.indexOf(
            choice === 'keep' ? 'Keep open' : choice === 'retry' ? 'Retry saving' : 'Quit anyway',
          ),
          checkboxChecked: false,
        }
      }
    },
    { fault, choices },
  )
}

export function shutdownState(f: ShutdownFixture) {
  return f.app.evaluate(() => {
    const state = (globalThis as unknown as { __shutdownTest: InjectedState }).__shutdownTest
    return { dialogs: state.dialogs, flushes: state.flushes }
  })
}

export async function clearFault(f: ShutdownFixture) {
  await f.app.evaluate(() =>
    (globalThis as unknown as { __shutdownTest: InjectedState }).__shutdownTest.setFault('none'),
  )
}
