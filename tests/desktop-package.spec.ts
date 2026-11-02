import { test, expect } from '@playwright/test'
import { access, mkdtemp, mkdir, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import {
  launchPackagedTestElectron,
  assertTestWindowPolicy,
} from '../scripts/electron-test-launch.mjs'
import { foregroundTest, requiresForeground } from './foreground'
import { importPhotos } from './import.helpers'
import { captureWindow } from './window-capture.helpers'
import type {
  PreviewWorkerRequest,
  PreviewWorkerResponse,
  PreviewResult,
} from '../src/main/preview-types'

const executable =
  process.env.IRODORI_PACKAGED_EXECUTABLE ??
  resolve(
    process.platform === 'darwin'
      ? `dist/Irodori-darwin-${process.arch}/Irodori.app/Contents/MacOS/Irodori`
      : `dist/Irodori-linux-${process.arch}/irodori`,
  )

test(
  'unsigned packaged application starts offline with isolated profile, imports RAW, decodes fallback and restarts',
  foregroundTest(
    'Actual host-native packaged startup and desktop identity require the original packaged main entry in the foreground.',
  ),
  // eslint-disable-next-line no-empty-pattern -- This test launches the packaged executable through the shared launcher.
  async ({}, info) => {
    requiresForeground(test, 'Packaged startup uses the original production entry.')
    test.setTimeout(120000)
    test.skip(
      !(await access(executable).then(
        () => true,
        () => false,
      )),
      'Build the host-native application with npm run package:desktop first.',
    )
    const profile = await mkdtemp(join(tmpdir(), 'irodori-package-test-'))
    let session: Awaited<ReturnType<typeof launchPackagedTestElectron>> | undefined
    try {
      session = await launchPackagedTestElectron({
        executablePath: executable,
        userDataDir: profile,
        artifacts: info.outputPath('startup'),
      })
      const { app } = session,
        page = await app.firstWindow()
      await expect(page.getByTestId('workspace')).toBeVisible()
      const fonts = await page.evaluate(async () => {
        const loaded = await document.fonts.load('600 12px Lato')
        return loaded.map((face) => ({
          family: face.family,
          weight: face.weight,
          status: face.status,
        }))
      })
      expect(fonts).toEqual(
        expect.arrayContaining([{ family: 'Lato', weight: '600', status: 'loaded' }]),
      )
      expect(page.url().startsWith('file:')).toBe(true)
      const runtime = await app.evaluate(({ app, BrowserWindow }) => ({
        root: app.getAppPath(),
        packaged: app.isPackaged,
        name: app.getName(),
        security: (
          BrowserWindow.getAllWindows()[0].webContents as unknown as {
            getLastWebPreferences: () => Record<string, unknown>
          }
        ).getLastWebPreferences(),
      }))
      expect(runtime.packaged).toBe(true)
      expect(runtime.name).toBe('Irodori')
      expect(runtime.security).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      })
      expect(runtime.root).toContain(
        join(process.platform === 'darwin' ? 'Resources' : 'resources', 'app'),
      )
      for (const path of [
        'out/main/preview-worker.js',
        'out/main/catalog-worker.js',
        'out/main/export-worker.js',
        'out/main/merge-worker.js',
        'node_modules/sharp/package.json',
        'node_modules/webgpu/package.json',
      ])
        await access(join(runtime.root, path))
      for (const path of ['tests', 'assets/tests', 'node_modules/electron', 'app.asar'])
        expect(
          await access(join(runtime.root, path)).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'])
      const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
      expect(photo).toMatchObject({ camera: 'ZV-1', previewSource: 'embedded' })
      const original = await readFile('tests/fixtures/sony-zv1.ARW')
      expect(await readFile(join(profile, 'library/originals', photo.id, 'original.arw'))).toEqual(
        original,
      )
      await page.getByTestId('console-toggle').click()
      const native = await app.browserWindow(page)
      await native.evaluate((w) => {
        w.unmaximize()
        w.setContentSize(1100, 700)
      })
      await captureWindow(app, page, info.outputPath('packaged-minimum.png'))
      // Exercise the exact shipped Node binary, dependencies and worker with explicit decoder fallback.
      const platform = process.platform === 'win32' ? 'win' : process.platform
      const binary = join(runtime.root, `node_modules/node-${platform}-${process.arch}/bin/node`)
      const output = info.outputPath('fallback')
      await mkdir(output, { recursive: true })
      const child = fork(join(runtime.root, 'out/main/preview-worker.js'), [], {
        execPath: binary,
        execArgv: [],
        cwd: output,
        env: { ...process.env, NODE_OPTIONS: '' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      child.stdout?.resume()
      child.stderr?.resume()
      const exited = once(child, 'exit')
      try {
        const response = await new Promise<PreviewResult>((accept, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Packaged RAW fallback timed out.')),
            45000,
          )
          child.once('error', reject)
          child.on('message', (message: PreviewWorkerResponse) => {
            if (message.type === 'result') {
              clearTimeout(timer)
              accept(message.result as PreviewResult)
            } else if (message.type === 'error') {
              clearTimeout(timer)
              reject(new Error(message.error))
            }
          })
          child.send({
            type: 'process',
            path: resolve('tests/fixtures/sony-zv1.ARW'),
            output,
            importMode: 'fallback',
          } satisfies PreviewWorkerRequest)
        })
        expect(response).toMatchObject({ source: 'decoded', metadata: { camera: 'ZV-1' } })
        expect(response.metadata.width).toBeGreaterThan(5000)
        const manifest = JSON.parse(
          await readFile('assets/app/icons/generated/manifest.json', 'utf8'),
        ) as { files: { file: string; sha256: string }[] }
        if (process.platform === 'darwin')
          expect(
            createHash('sha256')
              .update(await readFile(join(dirname(runtime.root), 'electron.icns')))
              .digest('hex'),
          ).toBe(manifest.files.find((f) => f.file === 'irodori.icns')!.sha256)
      } finally {
        const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
        try {
          if (child.connected) child.send({ type: 'close' })
          else child.kill()
          await exited
        } finally {
          clearTimeout(kill)
        }
      }
      await app.close()
      await assertTestWindowPolicy(session.evidenceFile)
      session = undefined
      session = await launchPackagedTestElectron({
        executablePath: executable,
        userDataDir: profile,
        artifacts: info.outputPath('restart'),
      })
      const restarted = await session.app.firstWindow()
      await expect(restarted.getByTestId('preview-filename')).toHaveText(photo.filename)
      await expect(restarted.getByTestId('console-panel')).toBeVisible()
      expect((await restarted.evaluate(() => window.irodori.listPhotos())).total).toBe(1)
      expect((await readdir(join(runtime.root, 'node_modules'))).includes('@electron')).toBe(false)
    } finally {
      if (session) {
        await session.app.close().catch(() => undefined)
        await assertTestWindowPolicy(session.evidenceFile)
        if (session.child.exitCode === null) session.child.kill('SIGKILL')
      }
      await rm(profile, { recursive: true, force: true })
      expect(
        await access(profile).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    }
  },
)
