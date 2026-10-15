import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { assertTestWindowPolicy } from '../scripts/electron-test-launch.mjs'
import { testUiMode } from '../scripts/test-ui-mode.mjs'
import { readFile } from 'node:fs/promises'

test('isolated launch policy retains real rendering, security, DOM keyboard focus and native captures', async ({
  luma,
}, info) => {
  const background = testUiMode() === 'background'
  const { app, page } = luma
  const state = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(1100, 700)
    return {
      visible: window.isVisible(),
      focused: window.isFocused(),
      focusable: process.platform === 'linux' ? undefined : window.isFocusable(),
      backgroundThrottling: window.webContents.getBackgroundThrottling(),
      preferences: (
        window.webContents as unknown as {
          getLastWebPreferences(): Electron.WebPreferences
        }
      ).getLastWebPreferences(),
    }
  })
  expect(state).toMatchObject({
    visible: !background,
    preferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  if (process.platform !== 'linux') expect(state.focusable).toBe(!background)
  if (background) {
    expect(state.focused).toBe(false)
    expect(state.backgroundThrottling).toBe(false)
  }
  await page.getByRole('button', { name: 'Actions', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await importPhotos(app, page)
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  expect(
    await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let frames = 0
          const tick = () => {
            if (++frames === 3) resolve(frames)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
    ),
  ).toBe(3)
  const capture = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const image = await window.capturePage()
    return { size: image.getSize(), bytes: image.toPNG().byteLength, visible: window.isVisible() }
  })
  expect(capture.size.width).toBeGreaterThanOrEqual(1100)
  expect(capture.size.height).toBeGreaterThanOrEqual(700)
  expect(capture.bytes).toBeGreaterThan(10_000)
  expect(capture.visible).toBe(!background)
  const evidence = await assertTestWindowPolicy(info.outputPath('launch-1/window-policy.json'))
  expect(evidence.windows).toHaveLength(1)
  expect(evidence.windows[0].closed).toBe(false)
  if (background) expect(evidence.windows[0]).toMatchObject({ showEvents: 0, focusEvents: 0 })
})

test('normal restart, abrupt exit and explicit quit retain the requested window policy', async ({
  luma,
}, info) => {
  await luma.page.getByTestId('console-toggle').click()
  let current = await luma.restart()
  await expect(current.page.getByTestId('console-panel')).toBeVisible()
  current = await luma.crashAndRestart()
  await expect(current.page.getByTestId('console-panel')).toBeVisible()
  await luma.expectQuit(async () => {
    await current.app.evaluate(({ app }) => {
      setImmediate(() => app.quit())
    })
  })
  for (let launch = 1; launch <= 3; launch++) {
    const evidence = await assertTestWindowPolicy(
      info.outputPath(`launch-${launch}/window-policy.json`),
    )
    expect(evidence.windows).toHaveLength(1)
    expect(evidence.mode).toBe(testUiMode())
    if (testUiMode() === 'background')
      expect(evidence.windows[0]).toMatchObject({ showEvents: 0, focusEvents: 0 })
  }
})

test('orderly shutdown destroys the renderer before final quit and restores flushed workspace state', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await importPhotos(app, page)
  const chosen = (await page.evaluate(() => window.luma.listPhotos())).photos[0]
  await page.getByTestId(`photo-card-${chosen.id}`).click()
  await page.getByTestId('console-toggle').click()
  const evidenceFile = info.outputPath('orderly-shutdown.json')
  await app.evaluate(({ app, BrowserWindow, ipcMain }, evidenceFile) => {
    const originalWindow = BrowserWindow.getAllWindows()[0]
    const sender = originalWindow.webContents
    const senderId = sender.id
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const listTasks = handlers.get('tasks:list')!
    const request = (sender: { id: number }) => {
      try {
        return listTasks({
          sender,
          get senderFrame() {
            throw new Error('Disposed frame must not be accessed.')
          },
        }) === undefined
          ? 'ignored'
          : 'handled'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    let lateRequest = 'not observed'
    let untrustedRequest = 'not observed'
    originalWindow.once('closed', () => {
      lateRequest = request(sender)
      untrustedRequest = request({ id: senderId + 1 })
    })
    const quit = app.quit.bind(app)
    let quitCalls = 0
    app.quit = () => {
      quitCalls++
      // The first call enters the real before-quit handler; the final call follows cleanup.
      process.getBuiltinModule('fs').writeFileSync(
        evidenceFile,
        JSON.stringify({
          quitCalls,
          windowCount: BrowserWindow.getAllWindows().length,
          originalWindowDestroyed: originalWindow.isDestroyed(),
          lateRequest,
          untrustedRequest,
        }),
      )
      quit()
    }
  }, evidenceFile)
  const restarted = await luma.restart()
  expect(JSON.parse(await readFile(evidenceFile, 'utf8'))).toEqual({
    quitCalls: 2,
    windowCount: 0,
    originalWindowDestroyed: true,
    lateRequest: 'ignored',
    untrustedRequest: 'Untrusted library request.',
  })
  await expect(restarted.page.getByTestId('console-panel')).toBeVisible()
  await expect(restarted.page.getByTestId('preview-filename')).toHaveText(chosen.filename)
  expect(
    (await restarted.page.evaluate(() => window.luma.getWorkspaceState())).state,
  ).toMatchObject({ activeId: chosen.id, consoleOpen: true })
})
