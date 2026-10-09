import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, _electron as electron, expect } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface DesktopWindow {
  app: ElectronApplication
  page: Page
}

interface DesktopSession extends DesktopWindow {
  restart: (clearPreviewCache?: boolean) => Promise<DesktopWindow>
  expectQuit: (action: () => Promise<void>) => Promise<void>
  userDataDir: string
}

interface RunningApplication {
  app: ElectronApplication
  child: ChildProcess
  closing: boolean
  closed: boolean
  tracePath: string
  tracing: boolean
}

export const test = base.extend<{ luma: DesktopSession; hdrDisplay: boolean }>({
  hdrDisplay: [false, { option: true }],
  luma: async ({ hdrDisplay }, use, testInfo) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'luma-e2e-'))
    const applications: RunningApplication[] = []
    const errors: string[] = []
    const processOutput: string[] = []

    const close = async (running: RunningApplication): Promise<void> => {
      if (running.closed) return
      running.closing = true
      try {
        if (running.tracing) {
          await running.app.context().tracing.stop({ path: running.tracePath })
          running.tracing = false
        }
      } finally {
        try {
          await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
          })
          await running.app.close()
        } finally {
          running.closed = true
          const child = running.child
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }
      }
    }

    const launch = async (): Promise<DesktopWindow> => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      delete env.FORCE_COLOR
      env.LUMA_HDR_TEST = hdrDisplay ? '1' : '0'

      const app = await electron.launch({
        // The package entry loads the compiled main file and preserves Luma's version metadata.
        args: [resolve('.'), `--user-data-dir=${userDataDir}`],
        env,
        chromiumSandbox: true,
        offline: true,
        timeout: 20_000,
      })
      const running: RunningApplication = {
        app,
        child: app.process(),
        closing: false,
        closed: false,
        tracePath: testInfo.outputPath(`electron-${applications.length + 1}.zip`),
        tracing: false,
      }
      applications.push(running)
      app.on('console', (message) => {
        if (message.type() === 'error') errors.push(`Main console: ${message.text()}`)
      })
      app.on('close', () => {
        if (!running.closing) errors.push('The Electron main process exited unexpectedly.')
      })
      running.child.stderr?.on('data', (chunk: Buffer) => processOutput.push(chunk.toString()))

      const observedPages = new Set<Page>()
      const observePage = (page: Page): void => {
        if (observedPages.has(page)) return
        observedPages.add(page)
        page.on('pageerror', (error) => errors.push(`Renderer exception: ${error.message}`))
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(`Renderer console: ${message.text()}`)
        })
        page.on('crash', () => errors.push('The renderer process crashed.'))
      }
      app.on('window', observePage)
      app.windows().forEach(observePage)
      expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(
        await realpath(userDataDir),
      )
      if (process.env.LUMA_TEST_TRACE === '1') {
        await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
        running.tracing = true
      }
      const page = await app.firstWindow()
      observePage(page)
      await expect(page.getByTestId('workspace')).toBeVisible()
      await expect(page.getByTestId('app-version')).not.toBeEmpty()
      return { app, page }
    }

    try {
      const initial = await launch()
      await use({
        ...initial,
        userDataDir,
        expectQuit: async (action) => {
          const running = applications[applications.length - 1]
          running.closing = true
          if (running.tracing) {
            await running.app.context().tracing.stop({ path: running.tracePath })
            running.tracing = false
          }
          const closed = running.app.waitForEvent('close')
          await action()
          await closed
          running.closed = true
        },
        restart: async (clearPreviewCache = false) => {
          await close(applications[applications.length - 1])
          if (clearPreviewCache)
            await rm(join(userDataDir, 'library/cache/previews'), {
              recursive: true,
              force: true,
            })
          return launch()
        },
      })
    } finally {
      let failed = testInfo.status !== testInfo.expectedStatus || errors.length > 0
      const active = applications.at(-1)
      if (failed && active && !active.closed) {
        const page = active.app.windows()[0]
        if (page && !page.isClosed()) {
          await page
            .screenshot({ path: testInfo.outputPath('failure.png') })
            .then(() =>
              testInfo.attach('Failure screenshot', {
                path: testInfo.outputPath('failure.png'),
                contentType: 'image/png',
              }),
            )
            .catch(() => undefined)
        }
      }
      for (const running of applications) {
        await close(running).catch((error: unknown) => {
          errors.push(`Electron cleanup: ${String(error)}`)
        })
      }
      failed = failed || errors.length > 0
      for (const running of applications) {
        if (failed && process.env.LUMA_TEST_TRACE === '1') {
          await testInfo
            .attach('Electron trace', { path: running.tracePath, contentType: 'application/zip' })
            .catch(() => undefined)
        } else {
          await rm(running.tracePath, { force: true })
        }
      }
      if (failed) {
        await testInfo.attach('Electron diagnostics', {
          body: [...errors, ...processOutput].join('\n'),
          contentType: 'text/plain',
        })
      }
      await rm(userDataDir, { recursive: true, force: true })
      await expect(access(userDataDir)).rejects.toThrow()
      expect(errors, 'Electron must finish without main-process or renderer errors').toEqual([])
    }
  },
})

export { expect } from '@playwright/test'
