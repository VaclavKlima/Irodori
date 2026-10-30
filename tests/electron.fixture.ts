import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestElectron, assertTestWindowPolicy } from '../scripts/electron-test-launch.mjs'
import { testUiMode } from '../scripts/test-ui-mode.mjs'

interface DesktopWindow {
  app: ElectronApplication
  page: Page
}

interface DesktopSession extends DesktopWindow {
  restart: (clearPreviewCache?: boolean) => Promise<DesktopWindow>
  crashAndRestart: () => Promise<DesktopWindow>
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
  evidenceFile: string
}

export const test = base.extend<{ irodori: DesktopSession; hdrDisplay: boolean }>({
  hdrDisplay: [false, { option: true }],
  irodori: async ({ hdrDisplay }, use, testInfo) => {
    testInfo.skip(
      testUiMode() === 'background' && testInfo.tags.includes('@foreground'),
      testInfo.annotations.find((annotation) => annotation.type === 'requires-foreground')
        ?.description ?? 'Requires native desktop interaction; rerun with --foreground.',
    )
    const userDataDir = await mkdtemp(join(tmpdir(), 'irodori-e2e-'))
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
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit')
            child.kill('SIGKILL')
            await exited
          }
          await assertTestWindowPolicy(running.evidenceFile)
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
      env.IRODORI_HDR_TEST = hdrDisplay ? '1' : '0'

      const { app, child, evidenceFile } = await launchTestElectron({
        userDataDir,
        artifacts: testInfo.outputPath(`launch-${applications.length + 1}`),
        env,
      })
      const running: RunningApplication = {
        app,
        child,
        evidenceFile,
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
          if (message.type() === 'error') {
            errors.push(`Renderer console: ${message.text()}`)
            processOutput.push(`Renderer console location: ${JSON.stringify(message.location())}\n`)
          }
        })
        page.on('response', (response) => {
          if (response.status() >= 400)
            processOutput.push(`Renderer resource ${response.status()}: ${response.url()}\n`)
        })
        page.on('crash', () => errors.push('The renderer process crashed.'))
      }
      app.on('window', observePage)
      app.windows().forEach(observePage)
      expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(
        await realpath(userDataDir),
      )
      if (process.env.IRODORI_TEST_TRACE === '1') {
        await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
        running.tracing = true
      }
      const page = await app.firstWindow()
      observePage(page)
      await expect(
        page.locator('[data-testid="workspace"]:visible, [data-testid="all-photos"]:visible'),
      ).toHaveCount(1)
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
        crashAndRestart: async () => {
          const running = applications[applications.length - 1]
          running.closing = true
          if (running.tracing) {
            await running.app.context().tracing.stop({ path: running.tracePath })
            running.tracing = false
          }
          const exited = once(running.child, 'exit')
          running.child.kill('SIGKILL')
          await exited
          running.closed = true
          return launch()
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
            .screenshot({ path: testInfo.outputPath('failure.png'), timeout: 5_000 })
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
        await assertTestWindowPolicy(running.evidenceFile).catch((error: unknown) => {
          errors.push(`Electron window policy: ${String(error)}`)
        })
      }
      failed = failed || errors.length > 0
      for (const running of applications) {
        if (failed && process.env.IRODORI_TEST_TRACE === '1') {
          await testInfo
            .attach('Electron trace', { path: running.tracePath, contentType: 'application/zip' })
            .catch(() => undefined)
        } else {
          await rm(running.tracePath, { force: true })
        }
      }
      if (failed) {
        const diagnostics = testInfo.outputPath('electron-diagnostics.log')
        await writeFile(diagnostics, [...errors, ...processOutput].join('\n'))
        await testInfo.attach('Electron diagnostics', {
          path: diagnostics,
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
