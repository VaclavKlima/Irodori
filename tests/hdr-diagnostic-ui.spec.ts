/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestElectron, assertTestWindowPolicy } from '../scripts/electron-test-launch.mjs'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'

test('isolated HDR diagnostic preserves the sandbox, denies unrelated permissions, and reports fallback', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'irodori-hdr-test-'))
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  let desktop: ElectronApplication | undefined
  let child: ChildProcess | undefined
  let evidenceFile: string | undefined
  try {
    const launched = await launchTestElectron({
      userDataDir: profile,
      artifacts: testInfo.outputPath('launch'),
      entry: 'hdr-diagnostic',
      env,
    })
    ;({ app: desktop, child, evidenceFile } = launched)
    expect(await realpath(await desktop.evaluate(({ app }) => app.getPath('userData')))).toBe(
      await realpath(profile),
    )
    const security = await desktop.evaluate(({ app, BrowserWindow }) => ({
      prefs: (
        BrowserWindow.getAllWindows()[0].webContents as unknown as {
          getLastWebPreferences(): Electron.WebPreferences
        }
      ).getLastWebPreferences(),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      forcedColorProfile: app.commandLine.getSwitchValue('force-color-profile'),
      enabledFeatures: app.commandLine.getSwitchValue('enable-features'),
    }))
    expect(security.noSandbox).toBe(false)
    expect(security.forcedColorProfile).toBe('')
    expect(security.enabledFeatures).toBe('')
    expect(security.prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })
    const page = await desktop.firstWindow()
    // Deterministic failure injection covers a missing adapter on any host GPU.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => null },
        configurable: true,
      })
    })
    await page.getByRole('button', { name: 'Recheck display' }).click()
    await expect(page.getByRole('status')).toContainText('No WebGPU adapter')
    for (const mode of ['hdr', 'sdr', 'auto']) {
      await page.getByLabel('Preview').selectOption(mode)
      await expect
        .poll(
          async () =>
            JSON.parse((await page.locator('#report').textContent()) || '{}').target.requested,
        )
        .toBe(mode)
      await expect
        .poll(async () => JSON.parse((await page.locator('#report').textContent()) || '{}').state)
        .toBe('unavailable')
      const value = JSON.parse((await page.locator('#report').textContent()) || '{}')
      expect(value.target.mode).toBe('sdr')
      expect(value.physicalOutputVerified).toBe(false)
    }
    expect(
      await page.evaluate(
        async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
      ),
    ).toBe('denied')
    expect(
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
        node: 'require' in window,
        library: 'irodori' in window,
      })),
    ).toMatchObject({ width: 1100, height: 700, overflow: false, node: false, library: false })
    expect(await readdir(profile)).not.toContain('library')
  } finally {
    try {
      await desktop?.close()
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await rm(profile, { recursive: true, force: true })
      if (evidenceFile) await assertTestWindowPolicy(evidenceFile)
    }
  }
})
