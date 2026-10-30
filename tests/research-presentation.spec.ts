import { expect, test } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { hdrAdjustmentMatrix } from '../src/shared/hdr'
import { neutralAdjustments } from '../src/shared/adjustments'
import { provenance } from '../scripts/research/pipeline/provenance'
import type { runPresentationStudy } from '../scripts/research/pipeline/browser-study'
import { attachResearchEvidence } from './research.helpers'

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.afterEach(async ({}, info) => attachResearchEvidence(info))

const reason =
  'Research measures actual Electron canvas completion and presentation at native display cadence.'
test.use({ hdrDisplay: true })
for (const [width, height, consoleOpen] of [
  [1100, 700, true],
  [1440, 900, false],
] as const)
  for (const frequency of [60, 120] as const)
    test(
      `research sharp/draft ${frequency} Hz at ${width}x${height}, Console ${consoleOpen ? 'open' : 'closed'}`,
      foregroundTest(reason),
      async ({ irodori }, info) => {
        test.setTimeout(900000)
        const { app, page } = irodori
        await (
          await app.browserWindow(page)
        ).evaluate((window, size) => window.setContentSize(size[0], size[1]), [width, height])
        await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal', {
          timeout: 60000,
        })
        if (consoleOpen) await page.getByTestId('console-toggle').click()
        const state = await page.evaluate(async () => {
          const id = (await window.irodori.listPhotos()).photos[0].id
          return window.irodori.getEdits(id)
        })
        const parameters = Array.from({ length: 240 }, (_, i) => {
          const adjustments = { ...neutralAdjustments }
          const operator = Math.floor(i / 30),
            value = ((i % 30) - 15) * 4
          if (operator === 0) adjustments.exposureEv = value / 40
          else if (operator <= 5)
            adjustments[
              (['contrast', 'highlights', 'shadows', 'whites', 'blacks'] as const)[operator - 1]
            ] = value
          else
            adjustments.whiteBalance = {
              mode: 'custom',
              kelvin: operator === 6 ? 3500 + (i % 30) * 100 : 6500,
              tint: operator === 7 ? (i % 30) - 15 : 0,
            }
          const p = new Array<number>(44).fill(0)
          p.splice(
            8,
            6,
            adjustments.exposureEv,
            adjustments.contrast,
            adjustments.highlights,
            adjustments.shadows,
            adjustments.whites,
            adjustments.blacks,
          )
          const matrix = hdrAdjustmentMatrix(adjustments, state.whiteBalanceProfile)
          if (matrix) {
            p[19] = 1
            for (let row = 0; row < 3; row++)
              p.splice(20 + row * 4, 3, ...matrix.slice(row * 3, row * 3 + 3))
          }
          return p
        })
        const bundle = await build({
          entryPoints: ['scripts/research/pipeline/browser-study.ts'],
          bundle: true,
          write: false,
          format: 'iife',
          globalName: 'IrodoriPipelineResearch',
          platform: 'browser',
          target: 'chrome146',
          logLevel: 'silent',
        })
        await page.evaluate(bundle.outputFiles[0].text)
        const display = await app.evaluate(({ screen }) =>
          screen.getAllDisplays().map((d) => ({
            width: d.size.width,
            height: d.size.height,
            scaleFactor: d.scaleFactor,
            frequency: d.displayFrequency,
            colorDepth: d.colorDepth,
          })),
        )
        const result = await page.evaluate(
          async (options) => {
            const research = (
              window as unknown as {
                IrodoriPipelineResearch: { runPresentationStudy: typeof runPresentationStudy }
              }
            ).IrodoriPipelineResearch
            return research.runPresentationStudy(options)
          },
          { photoId: state.photoId, parameters, inputFrames: 240, repetitions: 3, frequency },
        )
        await writeFile(
          info.outputPath('research-presentation.json'),
          JSON.stringify(
            {
              provenance: await provenance([
                'scripts/research/pipeline/browser-study.ts',
                'scripts/research/pipeline/metrics.ts',
                'scripts/research/pipeline/gpu-study.ts',
                'src/renderer/src/preview/hdr-presenter.ts',
                'src/shared/aces-wgsl.ts',
                'tests/fixtures/sony-zv1.ARW',
              ]),
              nativeWindow: { width, height, consoleOpen },
              display,
              ...result,
              target: { frameRate: 60, p95Ms: 33 },
              acceptance:
                'research measurements; speed targets are reported without weakening existing gates',
            },
            null,
            2,
          ),
        )
        expect(result.errors).toEqual([])
        test.skip(
          !result.frequencyAvailable,
          `${frequency} Hz display or actual input sampling did not meet the 99% completeness requirement; evidence retained and this sampling requirement remains incomplete.`,
        )
      },
    )
for (let launch = 1; launch <= 5; launch++)
  test(
    `research fresh isolated application ${launch}: fixture selection through useful normal presentation`,
    foregroundTest(reason),
    async ({ irodori }, info) => {
      test.setTimeout(120000)
      const { app, page } = irodori
      const before = await page.evaluate(() => ({
        rendererNavigationEpoch: performance.timeOrigin,
        sinceRendererNavigationMs: performance.now(),
      }))
      const at = performance.now()
      await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-quality', 'normal', {
        timeout: 60000,
      })
      const measured = await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
        await canvas.getContext('webgpu')!.getConfiguration()!.device.queue.onSubmittedWorkDone()
        await new Promise(requestAnimationFrame)
        return {
          sinceRendererNavigationMs: performance.now(),
          width: canvas.width,
          height: canvas.height,
          backend: canvas.dataset.backend,
          quality: canvas.dataset.quality,
          dpr: devicePixelRatio,
        }
      })
      await writeFile(
        info.outputPath(`fresh-application-${launch}.json`),
        JSON.stringify(
          {
            provenance: await provenance(['tests/fixtures/sony-zv1.ARW']),
            launch,
            before,
            ...measured,
            importThroughNormalPresentationMs: performance.now() - at,
            profile: 'fresh shared harness temporary profile; verified before import',
            filesystemCache: 'uncontrolled warm filesystem; no purge',
            driverCache: 'uncontrolled',
            limitation:
              'Includes fixture import and review; renderer-navigation clock excludes main-process startup. Not a cached existing-library selection measurement.',
          },
          null,
          2,
        ),
      )
      expect(measured.backend).toBe('webgpu-hdr')
    },
  )
test('research shared-texture capability inventory preserves the sandbox and typed bridge', async ({
  irodori,
}, info) => {
  const result = await irodori.app.evaluate(({ sharedTexture, BrowserWindow }) => ({
    importAvailable: typeof sharedTexture?.importSharedTexture === 'function',
    sendAvailable: typeof sharedTexture?.sendSharedTexture === 'function',
    windows: BrowserWindow.getAllWindows().map((w) => {
      const p = (
        w.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }
      ).getLastWebPreferences()
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      }
    }),
    platform: process.platform,
    electron: process.versions.electron,
  }))
  await writeFile(
    info.outputPath('shared-texture-capabilities.json'),
    JSON.stringify(
      {
        ...result,
        status: 'incomplete transport experiment',
        reason:
          'Current Dawn Node binding does not provide a tested IOSurface/Mach-port or DMA-BUF producer. Capability presence alone does not prove zero-copy, fencing, alpha/color correctness, or release ownership.',
        nextExperiment:
          'Use a dedicated native producer and the shared hidden launcher; retain texture storage through allReferencesReleased, test stale generations, GPU loss and receiver crash before timing transfers.',
      },
      null,
      2,
    ),
  )
  expect(result.windows.every((w) => w.sandbox && w.contextIsolation && !w.nodeIntegration)).toBe(
    true,
  )
})
