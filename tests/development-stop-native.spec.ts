/* eslint-disable no-empty-pattern -- Playwright requires destructured fixtures when only testInfo is used. */
import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { foregroundTest, requiresForeground } from './foreground'
import { prepareTestElectron, assertTestWindowPolicy } from '../scripts/electron-test-launch.mjs'
import { processExists } from '../scripts/development-supervisor.mjs'

test(
  'real npm development stopping keeps Vite alive through a native recovery dialog, cancellation and final exit',
  foregroundTest(
    'Verifies a real native recovery dialog and npm/electron-vite process ownership on the Bazzite desktop.',
  ),
  async ({}, info) => {
    requiresForeground(test, 'Native shutdown dialog and development session')
    test.skip(
      process.platform !== 'linux',
      'Bazzite foreground acceptance; macOS and Windows remain unverified.',
    )
    const manualNative = process.env.IRODORI_NATIVE_DIALOG_MANUAL === '1'
    test.skip(
      !manualNative,
      'Requires one physical Keep open choice. Set IRODORI_NATIVE_DIALOG_MANUAL=1 for this isolated foreground acceptance.',
    )
    test.setTimeout(240_000)
    const root = await mkdtemp(join(tmpdir(), 'irodori-real-dev-shutdown-'))
    const prepared = await prepareTestElectron({
      userDataDir: root,
      artifacts: info.outputPath('real-development'),
    })
    const drop = join(root, 'drop-flush')
    const nativeOptions = info.outputPath('native-dialog.json')
    await writeFile(drop, '')
    const entry = join(prepared.packageDirectory, 'entry.cjs')
    await writeFile(
      entry,
      `
const shutdownElectron = require('electron');
const shutdownFs = require('node:fs');
shutdownFs.writeFileSync(${JSON.stringify(info.outputPath('owned-processes.json'))}, JSON.stringify({ mainPid: process.pid, vitePid: process.ppid }));
shutdownElectron.app.whenReady().then(() => shutdownElectron.app.setAccessibilitySupportEnabled(true));
shutdownElectron.app.on('browser-window-created', (_event, window) => {
  const shutdownSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    if(channel === 'edits:flush' && shutdownFs.existsSync(${JSON.stringify(drop)})) return;
    return shutdownSend(channel, ...args);
  };
});
const shutdownDialog = shutdownElectron.dialog.showMessageBox.bind(shutdownElectron.dialog);
shutdownElectron.dialog.showMessageBox = (...args) => {
  shutdownFs.writeFileSync(${JSON.stringify(nativeOptions)}, JSON.stringify(args.at(-1)));
  return shutdownDialog(...args);
};
` + (await readFile(entry, 'utf8')),
    )
    const env = {
      ...prepared.launchEnv,
      ELECTRON_ENTRY: prepared.packageDirectory,
    }
    const npm = spawn('npm', ['run', 'dev', '--', '--', `--user-data-dir=${root}`], {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logs: string[] = []
    npm.stdout!.on('data', (data: Buffer) => logs.push(data.toString()))
    npm.stderr!.on('data', (data: Buffer) => logs.push(data.toString()))
    let mainPid = 0,
      vitePid = 0,
      supervisorPid = 0
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
    try {
      await expect
        .poll(
          async () => {
            const policy = await assertTestWindowPolicy(prepared.evidenceFile).catch(
              () => undefined,
            )
            if (policy?.windows.length) mainPid = policy.pid
            return policy?.windows.length
          },
          { timeout: 35_000 },
        )
        .toBe(1)
      expect((await assertTestWindowPolicy(prepared.evidenceFile)).profile).toBe(
        await realpath(root),
      )
      const parentPid = async (pid: number) => {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      }
      vitePid = await parentPid(mainPid)
      supervisorPid = await parentPid(vitePid)
      browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
      const page = browser.contexts()[0].pages()[0]
      await expect(page.getByTestId('app-version')).not.toBeEmpty()
      await page.getByTestId('console-toggle').click()
      process.kill(supervisorPid, 'SIGINT')
      process.kill(supervisorPid, 'SIGTERM')
      await expect
        .poll(async () => readFile(nativeOptions, 'utf8').catch(() => ''), { timeout: 15_000 })
        .toContain('Saving could not be confirmed')
      expect(JSON.parse(await readFile(nativeOptions, 'utf8'))).toMatchObject({
        defaultId: 0,
        cancelId: 0,
      })
      await expect.poll(() => logs.join(''), { timeout: 180_000 }).toContain('stop cancelled')
      await writeFile(
        info.outputPath('native-driver.json'),
        JSON.stringify({ mode: 'manual', cancelled: true }),
      )
      expect(await processExists(mainPid)).toBe(true)
      expect(await processExists(vitePid)).toBe(true)
      await expect(page.getByTestId('console-panel')).toBeVisible()
      await rm(drop)
      process.kill(supervisorPid, 'SIGTERM')
      await expect.poll(() => processExists(mainPid), { timeout: 20_000 }).toBe(false)
      await expect.poll(() => processExists(supervisorPid)).toBe(false)
      await expect.poll(() => npm.exitCode).toBe(0)
      expect(npm.signalCode).toBeNull()
      expect(await processExists(vitePid)).toBe(false)
      const db = new DatabaseSync(join(root, 'library/catalog.sqlite'), { readOnly: true })
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      db.close()
      await assertTestWindowPolicy(prepared.evidenceFile)
      await writeFile(
        info.outputPath('process-exit.json'),
        JSON.stringify({
          mainPid,
          vitePid,
          supervisorPid,
          npmPid: npm.pid,
          exitCode: npm.exitCode,
        }),
      )
    } finally {
      await writeFile(info.outputPath('real-development.log'), logs.join(''))
      const owned = await readFile(info.outputPath('owned-processes.json'), 'utf8').then(
        JSON.parse,
        () => ({}),
      )
      mainPid ||= owned.mainPid ?? 0
      vitePid ||= owned.vitePid ?? 0
      // Fixture cleanup follows all process-exit assertions and cannot establish a pass.
      for (const pid of [mainPid, vitePid ? -vitePid : 0, npm.pid ? -npm.pid : 0])
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* The fixture process has already exited. */
          }
        }
      await browser?.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  },
)
