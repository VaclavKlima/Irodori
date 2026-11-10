import { expect, test } from '@playwright/test'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import {
  assertTestWindowPolicy,
  launchPackagedTestElectron,
} from '../scripts/electron-test-launch.mjs'
import type {
  PreviewResult,
  PreviewWorkerRequest,
  PreviewWorkerResponse,
} from '../src/main/preview-types'
import { defaultExportOptions } from '../src/shared/export'
import { foregroundTest, requiresForeground } from './foreground'
import { importPhotos } from './import.helpers'
import { completedTask } from './professional-editing-acceptance.helpers'
import { captureWindow } from './window-capture.helpers'

const executable =
  process.env.IRODORI_PACKAGED_EXECUTABLE ??
  resolve(
    process.platform === 'darwin'
      ? `dist/Irodori-darwin-${process.arch}/Irodori.app/Contents/MacOS/Irodori`
      : `dist/Irodori-linux-${process.arch}/irodori`,
  )

test(
  'unsigned packaged application starts offline, imports RAW, selects an object, exports mask edits, excludes retired assets, decodes fallback and restarts',
  foregroundTest(
    'Actual host-native packaged startup and desktop identity require the original packaged main entry in the foreground.',
  ),
  // eslint-disable-next-line no-empty-pattern -- This test launches the packaged executable through the shared launcher.
  async ({}, info) => {
    requiresForeground(test, 'Packaged startup uses the original production entry.')
    test.setTimeout(180000)
    test.skip(
      !(await access(executable).then(
        () => true,
        () => false,
      )),
      'Build the host-native application with npm run package:desktop first.',
    )
    const profile = await mkdtemp(join(tmpdir(), 'irodori-package-test-'))
    let session: Awaited<ReturnType<typeof launchPackagedTestElectron>> | undefined
    let nativeStderr: Buffer = Buffer.alloc(0)
    const retainStderr = (part: Buffer) => {
      nativeStderr = Buffer.concat([nativeStderr, part.subarray(-65536)]).subarray(-65536)
    }
    try {
      session = await launchPackagedTestElectron({
        executablePath: executable,
        userDataDir: profile,
        artifacts: info.outputPath('startup'),
      })
      session.child.stderr?.on('data', retainStderr)
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
        'out/main/object-selection-worker.js',
        'out/main/mask-edge-worker.js',
        'out/main/object-selection-model/manifest.json',
        'node_modules/sharp/package.json',
        'node_modules/webgpu/package.json',
        'node_modules/onnxruntime-node/package.json',
      ])
        await access(join(runtime.root, path))
      expect(
        JSON.parse(
          await readFile(join(runtime.root, 'node_modules/onnxruntime-node/package.json'), 'utf8'),
        ).version,
      ).toBe('1.31.1')
      for (const path of ['tests', 'assets/tests', 'node_modules/electron', 'app.asar'])
        expect(
          await access(join(runtime.root, path)).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      const rendererAssets = await readdir(join(runtime.root, 'out/renderer/assets'))
      expect(rendererAssets.some((name) => /^(?:hdr-)?presentation-worker-/.test(name))).toBe(false)
      expect(
        rendererAssets.some((name) =>
          /native-cpu-client|hdr-cpu-presenter|^(?:native-mask-parity|mask-portability|mask-photo-portability)-/.test(
            name,
          ),
        ),
      ).toBe(false)
      await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'])
      const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
      expect(photo).toMatchObject({ camera: 'ZV-1', previewSource: 'embedded' })
      const original = await readFile('tests/fixtures/sony-zv1.ARW')
      expect(await readFile(join(profile, 'library/originals', photo.id, 'original.arw'))).toEqual(
        original,
      )
      const selection = await page.evaluate(async (photoId) => {
        const context = await window.irodori.getObjectSelectionContext(photoId, 0)
        const proposal = await window.irodori.createObjectSelection({
          photoId,
          expectedRevision: 0,
          gridIdentity: context.gridIdentity,
          prompts: {
            box: [0.2, 0.15, 0.85, 0.8],
            positivePoints: [[0.5, 0.5]],
            negativePoints: [],
          },
        })
        return {
          proposalId: proposal.id,
          maskId: proposal.mask.id,
          modelIdentity: proposal.modelIdentity,
          width: context.geometry.canonicalWidth,
          height: context.geometry.canonicalHeight,
          base: proposal.mask.base && {
            hash: proposal.mask.base.hash,
            width: proposal.mask.base.width,
            height: proposal.mask.base.height,
          },
        }
      }, photo.id)
      expect(selection.modelIdentity).toBe('sam2.1-hiera-tiny-f32-labels-v1')
      expect(selection.base).toMatchObject({ width: selection.width, height: selection.height })
      expect(selection.base?.hash).toMatch(/^[a-f0-9]{64}$/)
      const accepted = await page.evaluate(
        (request) => window.irodori.acceptObjectSelection(request),
        { photoId: photo.id, proposalId: selection.proposalId, expectedRevision: 0 },
      )
      expect(accepted.revision).toBe(1)
      const edited = await page.evaluate(
        ({ photoId, maskId, revision }) =>
          window.irodori.mutateMasks(photoId, revision, {
            operations: [
              {
                kind: 'update',
                id: maskId,
                edge: { featherPx: 2, shiftPx: 1 },
                light: { exposureEv: 0.25 },
              },
            ],
          }),
        { photoId: photo.id, maskId: selection.maskId, revision: accepted.revision },
      )
      expect(edited.revision).toBe(2)
      expect(edited.settings.maskStack[0]).toMatchObject({
        id: selection.maskId,
        base: selection.base,
        edge: { featherPx: 2, shiftPx: 1 },
        light: { exposureEv: 0.25 },
      })
      const coverage = await page.evaluate(
        async ({ photoId, maskId, revision }) => {
          const prepared = await window.irodori.prepareMaskCoverage({
            photoId,
            revision,
            maskIds: [maskId],
          })
          const asset = prepared.coverages[maskId]
          return {
            width: asset.width,
            height: asset.height,
            hash: asset.hash,
            key: asset.key,
            encodedBytes:
              (asset.pngBase64.length / 4) * 3 -
              (asset.pngBase64.endsWith('==') ? 2 : asset.pngBase64.endsWith('=') ? 1 : 0),
          }
        },
        { photoId: photo.id, maskId: selection.maskId, revision: edited.revision },
      )
      expect(coverage).toMatchObject({ width: selection.width, height: selection.height })
      expect(coverage.hash).toMatch(/^[a-f0-9]{64}$/)
      expect(coverage.encodedBytes).toBeGreaterThan(0)
      const savedHistory = await page.evaluate(async (photoId) => {
        const { revision, settings, cursor, snapshots, canUndo, canRedo } =
          await window.irodori.getEditHistory(photoId)
        return { revision, settings, cursor, snapshots, canUndo, canRedo }
      }, photo.id)
      expect(savedHistory.snapshots).toHaveLength(3)
      await info.attach('packaged-object-selection-and-mask-edges', {
        contentType: 'application/json',
        body: JSON.stringify({ ...selection, revision: edited.revision, coverage }),
      })
      const destination = join(profile, 'package-exports')
      await mkdir(destination)
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, destination)
      const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
      expect(grant?.available).toBe(true)
      const preparation = await page.evaluate((id) => window.irodori.prepareExport([id]), photo.id)
      const exportId = await page.evaluate((request) => window.irodori.startExport(request), {
        preparationId: preparation.id,
        destinationId: grant!.id,
        action: 'custom' as const,
        options: {
          ...defaultExportOptions,
          output: 'sdr' as const,
          size: { mode: 'longest' as const, edge: 320 },
          metadata: 'none' as const,
        },
      })
      expect(await completedTask(page, exportId)).toMatchObject({
        status: 'completed',
        export: { exported: 1, failed: 0 },
      })
      const jpeg = (await readdir(destination)).find((name) => name.endsWith('.jpg'))!
      const exported = await sharp(join(destination, jpeg)).metadata()
      expect(exported.format).toBe('jpeg')
      expect(Math.max(exported.width!, exported.height!)).toBe(320)
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
      session.child.stderr?.on('data', retainStderr)
      const restarted = await session.app.firstWindow()
      await expect(restarted.getByTestId('preview-filename')).toHaveText(photo.filename)
      await expect(restarted.getByTestId('console-panel')).toBeVisible()
      expect((await restarted.evaluate(() => window.irodori.listPhotos())).total).toBe(1)
      expect(
        await restarted.evaluate((id) => window.irodori.getEditHistory(id), photo.id),
      ).toMatchObject(savedHistory)
      expect((await readdir(join(runtime.root, 'node_modules'))).includes('@electron')).toBe(false)
    } finally {
      try {
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
      } finally {
        await info.attach('packaged-main-stderr', {
          body: nativeStderr,
          contentType: 'text/plain',
        })
      }
    }
  },
)
