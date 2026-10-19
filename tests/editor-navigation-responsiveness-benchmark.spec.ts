import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import { focusPreviewWindow } from './preview-pan.helpers'
import { recordBenchmark } from './benchmark.helpers'
import {
  observePhotoActivation,
  type NavigationTarget,
} from './editor-navigation-responsiveness.helpers'
import { HDR_PRESENTATION_BUDGET } from '../src/renderer/src/preview/hdr-memory'
import { HDR_PRESENTATION_CACHE_BUDGET } from '../src/renderer/src/preview/hdr-presentation-cache'
import { provenance } from '../scripts/research/pipeline/provenance'

const reason =
  'Photo activation timing requires native foreground Retina presentation and post-paint observation.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })
const files = ['tests/fixtures/sony-zv1.ARW', 'tests/fixtures/research-sony/originals/DSC03243.ARW']
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, sha(await readFile(file))])),
  )
const quantile = (values: (number | null)[], p: number) => {
  const sorted: number[] = []
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) return null
    sorted.push(value)
  }
  sorted.sort((a, b) => a - b)
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null
}

for (const layout of [
  { name: '1100x700-console', width: 1100, height: 700, consoleOpen: true, fullscreen: false },
  { name: '1440x900', width: 1440, height: 900, consoleOpen: false, fullscreen: false },
  { name: 'native-fullscreen', width: 1440, height: 900, consoleOpen: false, fullscreen: true },
] as const)
  test(
    `photo activation ${layout.name}: cold diagnostics, five warm pairs and rapid reversal`,
    foregroundTest(reason),
    async ({ luma }, info) => {
      test.setTimeout(180000)
      const { app, page } = luma
      const native = await app.browserWindow(page)
      const path = info.outputPath('editor-navigation-responsiveness.json')
      const before = await hashes()
      const manifest = JSON.parse(
        await readFile('tests/fixtures/research-sony/manifest.json', 'utf8'),
      ) as { files: { name: string; sha256: string }[] }
      expect(before[files[0]]).toBe(
        '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
      )
      expect(before[files[1]]).toBe(
        manifest.files.find((file) => file.name === 'DSC03243.ARW')!.sha256,
      )
      const compiled = (await readdir('out', { recursive: true }))
        .filter((file) => /\.(?:js|cjs|css|html)$/.test(file))
        .map((file) => join('out', file))
        .sort()
      const source = {
        ...(await provenance([
          ...files,
          'tests/fixtures/README.md',
          'tests/fixtures/research-sony/README.md',
          'tests/fixtures/research-sony/manifest.json',
          'tests/editor-navigation-responsiveness-benchmark.spec.ts',
          'tests/editor-navigation-responsiveness.helpers.ts',
          'src/renderer/src/preview/hdr-presenter.ts',
          'src/renderer/src/preview/hdr-presentation-cache.ts',
          'src/renderer/src/components/PhotoPreview.tsx',
          'src/renderer/src/hooks/useFullPreview.ts',
          ...compiled,
        ])),
        build:
          'Compiled production Electron app, isolated managed library, capture-phase native click clock through post-paint observed matching frame.',
      }
      let observer: Awaited<ReturnType<typeof observePhotoActivation>> | undefined
      let observed: unknown
      const diagnostics: unknown[] = []
      let environment: Record<string, unknown> = {},
        after: Record<string, string>
      const targets: NavigationTarget[] = []
      const history = new Map<string, unknown>()
      let measurementStartedAt = 0,
        measurementDurationMs = 0
      try {
        await native.evaluate((window, { width, height }) => {
          window.unmaximize()
          window.setContentSize(width, height)
        }, layout)
        const workspaces = page.getByRole('navigation', { name: 'Workspaces' })
        await workspaces.getByRole('button', { name: 'Library', exact: true }).click()
        await importPhotos(app, page, files, false)
        const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
        for (const [index, filename] of ['sony-zv1.ARW', 'DSC03243.ARW'].entries()) {
          const photo = photos.find((photo) => photo.filename === filename)!
          const edits = await page.evaluate(
            async ({ id, exposureEv }) => {
              const previous = await window.luma.getEdits(id)
              return window.luma.updateEdits(id, { exposureEv }, previous.revision)
            },
            { id: photo.id, exposureEv: index === 0 ? 1 : -1 },
          )
          const { exposureEv, contrast, highlights, shadows, whites, blacks, whiteBalance } =
            edits.settings
          targets.push({
            id: photo.id,
            filename,
            revision: edits.revision,
            parameters: { exposureEv, contrast, highlights, shadows, whites, blacks, whiteBalance },
          })
          history.set(
            photo.id,
            await page.evaluate((id) => window.luma.getEditHistory(id), photo.id),
          )
        }
        const toggle = page.getByTestId('console-toggle')
        if (((await toggle.getAttribute('aria-expanded')) === 'true') !== layout.consoleOpen)
          await toggle.click()
        if (layout.fullscreen)
          await native.evaluate(
            (window) =>
              new Promise<void>((resolve) => {
                window.once('enter-full-screen', () => resolve())
                window.setFullScreen(true)
              }),
          )
        await focusPreviewWindow(app, page)
        environment = {
          window: await native.evaluate((window) => ({
            fullscreen: window.isFullScreen(),
            bounds: window.getBounds(),
            contentBounds: window.getContentBounds(),
          })),
          displays: await app.evaluate(({ screen }) =>
            screen.getAllDisplays().map((display) => ({
              id: display.id,
              bounds: display.bounds,
              scaleFactor: display.scaleFactor,
              displayFrequency: display.displayFrequency,
              colorSpace: display.colorSpace,
              internal: display.internal,
            })),
          ),
          target: await page.evaluate(() => window.luma.getDisplayState()),
          compiledCacheRequested: process.env.VITE_LUMA_HDR_PRESENTATION_CACHE === '1',
          preparationCondition:
            'Fresh isolated library; RAWs imported and edited with Editor suspended. OS/driver caches uncontrolled. First cold activation enters Editor; second uses the native photo button.',
          sampleLimitations:
            'Two cold diagnostics and ten ordinary warm activations per layout; these samples do not establish population-tail confidence or full goal acceptance. First workspace-entry cold clock is distinguished from photo-click clocks.',
          rapidWaitDefinition:
            'A pending useful wait starts at the first activation and spans superseded inputs until the next correctly attributed post-paint useful completion. Idle time after a completion is excluded; an unfinished tail remains a censored lower bound.',
        }
        const firstName = await page.getByTestId('main-preview').getAttribute('aria-label')
        const first = targets.find((target) => target.filename === firstName)!
        expect(first).toBeDefined()
        const second = targets.find((target) => target.id !== first.id)!
        observer = await observePhotoActivation(page)
        const activate = async (target: NavigationTarget, phase: string, workspace = false) => {
          await observer!.evaluate(
            (value, { target, phase, workspace }) => value.arm(target, phase, workspace),
            { target, phase, workspace },
          )
          if (workspace)
            await workspaces.getByRole('button', { name: 'Editor', exact: true }).click()
          else
            await page
              .getByRole('button', { name: `Select ${target.filename}`, exact: true })
              .click()
          await expect
            .poll(() => observer!.evaluate((value) => value.read().current?.nativeReadyAt), {
              timeout: 30000,
            })
            .toBeGreaterThan(0)
          const current = await observer!.evaluate((value) => value.read().current!)
          if (current.target.id !== target.id)
            throw new Error('Native activation was not captured for the intended photo.')
          target.sourceIdentity ??= current.nativeReady!.nativeSource
          const diagnostic = await page.evaluate(() => window.luma.getPreviewDiagnostics())
          diagnostics.push({ phase, filename: target.filename, diagnostic })
          expect
            .soft(diagnostic.presentation)
            .toMatchObject({ photoId: target.id, revision: target.revision, stage: 'presented' })
          return current
        }
        measurementStartedAt = Date.now()
        await activate(first, 'cold-workspace-control', true)
        await activate(second, 'cold-photo-selection')
        for (let pair = 0; pair < 5; pair++) {
          await activate(first, `warm-pair-${pair}-forward`)
          await activate(second, `warm-pair-${pair}-back`)
        }
        for (let input = 0; input < 12; input++) {
          const target = input % 2 ? second : first
          await observer.evaluate(
            (value, target) => value.arm(target, 'rapid-reversal', false),
            target,
          )
          await page
            .getByRole('button', { name: `Select ${target.filename}`, exact: true })
            .click({ noWaitAfter: true })
        }
        await expect
          .poll(() => observer!.evaluate((value) => value.read().current?.nativeReadyAt), {
            timeout: 30000,
          })
          .toBeGreaterThan(0)
        measurementDurationMs = Date.now() - measurementStartedAt
        observed = await observer.evaluate((value) => value.read())
        for (const target of targets)
          expect
            .soft(await page.evaluate((id) => window.luma.getEditHistory(id), target.id))
            .toEqual(history.get(target.id))
      } catch (error) {
        environment.failure = String(error)
        throw error
      } finally {
        try {
          if (observer) {
            observed = await observer.evaluate((value) => value.read())
            await observer.evaluate((value) => value.close())
            await observer.dispose()
          }
          after = await hashes()
          if (measurementStartedAt && !measurementDurationMs)
            measurementDurationMs = Date.now() - measurementStartedAt
          await writeFile(
            path,
            JSON.stringify(
              {
                provenance: source,
                layout,
                targets,
                ...environment,
                measurementDurationMs,
                originalHashesBefore: before,
                originalHashesAfter: after,
                diagnostics,
                observed,
              },
              null,
              2,
            ),
          )
        } finally {
          if (await native.evaluate((window) => window.isFullScreen()))
            await native.evaluate(
              (window) =>
                new Promise<void>((resolve) => {
                  window.once('leave-full-screen', () => resolve())
                  window.setFullScreen(false)
                }),
            )
        }
      }
      const result = observed as {
        observedAt: number
        activations: {
          phase: string
          startedAt: number
          supersededAt: number | null
          firstUsefulAt: number | null
          firstUsefulMs: number | null
          nativeReadyAt: number | null
          nativeReadyMs: number | null
          firstUsefulKind: string | null
          firstUseful?: unknown
          nativeReady?: {
            allocatedBytes: number
            retainedBytes: number
            viewport: { width: number; height: number; dpr: number }
          }
          wrongVisiblePublications: number
          unattributedVisibleFrames: number
          correctVisibleButNotUsefulFrames: number
          loaderBlockedVisibleFrames: number
          pendingRequestVisibleFrames: number
          target: NavigationTarget
        }[]
      }
      const cold = result.activations.filter((sample) => sample.phase.startsWith('cold'))
      const warm = result.activations.filter((sample) => sample.phase.startsWith('warm'))
      const rapid = result.activations.filter((sample) => sample.phase === 'rapid-reversal')
      expect(cold).toHaveLength(2)
      expect(warm).toHaveLength(10)
      expect(rapid).toHaveLength(12)
      for (const sample of [...cold, ...warm]) {
        const label = `${sample.phase} ${sample.target.filename}`
        expect(sample.firstUseful, `${label} useful post-paint snapshot`).toBeDefined()
        expect(sample.nativeReady, `${label} native post-paint snapshot`).toBeDefined()
        expect(sample.firstUsefulAt, `${label} useful completion`).not.toBeNull()
        expect(sample.nativeReadyAt, `${label} native completion`).not.toBeNull()
        expect(sample.firstUsefulMs, `${label} useful latency`).not.toBeNull()
        expect(sample.nativeReadyMs, `${label} native latency`).not.toBeNull()
        expect(Number.isFinite(sample.firstUsefulMs), `${label} finite useful latency`).toBe(true)
        expect(Number.isFinite(sample.nativeReadyMs), `${label} finite native latency`).toBe(true)
      }
      const completedBeforeSupersession = (sample: (typeof rapid)[number], at: number | null) =>
        at !== null && (sample.supersededAt === null || at <= sample.supersededAt)
      const rapidUsefulCompleted = rapid.filter((sample) =>
        completedBeforeSupersession(sample, sample.firstUsefulAt),
      )
      const rapidNativeCompleted = rapid.filter((sample) =>
        completedBeforeSupersession(sample, sample.nativeReadyAt),
      )
      const rapidSuperseded = rapid.filter((sample) => sample.supersededAt !== null)
      const rapidUsefulWaits: number[] = []
      let rapidWaitingSince: number | null = null
      for (const sample of rapid) {
        rapidWaitingSince ??= sample.startedAt
        if (completedBeforeSupersession(sample, sample.firstUsefulAt)) {
          rapidUsefulWaits.push(sample.firstUsefulAt! - rapidWaitingSince)
          rapidWaitingSince = null
        }
      }
      const coldP95Ms = quantile(
        cold.map((sample) => sample.firstUsefulMs),
        0.95,
      )
      const warmP95Ms = quantile(
        warm.map((sample) => sample.firstUsefulMs),
        0.95,
      )
      await recordBenchmark(info, {
        family: 'hdr',
        measurements: {
          layout,
          ...environment,
          measurementDurationMs,
          coldSamples: cold.length,
          warmSamples: warm.length,
          coldFirstUsefulP95Ms: coldP95Ms,
          warmFirstUsefulP95Ms: warmP95Ms,
          coldNativeReadyP95Ms: quantile(
            cold.map((sample) => sample.nativeReadyMs),
            0.95,
          ),
          warmNativeReadyP95Ms: quantile(
            warm.map((sample) => sample.nativeReadyMs),
            0.95,
          ),
          cacheHits: warm.filter((sample) => sample.firstUsefulKind === 'cached-exact').length,
          exposedWarmNativeMisses: warm.filter(
            (sample) => sample.firstUsefulKind === 'native-normal',
          ).length,
          rapidInputs: rapid.length,
          rapidUsefulCompletedInputs: rapidUsefulCompleted.length,
          rapidNativeCompletedInputs: rapidNativeCompleted.length,
          rapidSupersededInputs: rapidSuperseded.length,
          rapidSupersededWithoutUseful: rapidSuperseded.filter(
            (sample) => !completedBeforeSupersession(sample, sample.firstUsefulAt),
          ).length,
          rapidMissingUsefulInputs: rapid.filter((sample) => sample.firstUsefulAt === null).length,
          rapidWithoutUsefulBeforeSupersession: rapid.filter(
            (sample) => !completedBeforeSupersession(sample, sample.firstUsefulAt),
          ).length,
          rapidLongestCompletedUsefulWaitMs: rapidUsefulWaits.length
            ? Math.max(...rapidUsefulWaits)
            : null,
          rapidUsefulWaitCensored: rapidWaitingSince !== null,
          rapidOpenUsefulWaitLowerBoundMs:
            rapidWaitingSince === null ? 0 : result.observedAt - rapidWaitingSince,
          rapidLastFirstUsefulMs: rapid.at(-1)?.firstUsefulMs ?? null,
          wrongVisiblePublications: result.activations.reduce(
            (sum, sample) => sum + sample.wrongVisiblePublications,
            0,
          ),
          unattributedVisibleFrames: result.activations.reduce(
            (sum, sample) => sum + sample.unattributedVisibleFrames,
            0,
          ),
          correctVisibleButNotUsefulFrames: result.activations.reduce(
            (sum, sample) => sum + sample.correctVisibleButNotUsefulFrames,
            0,
          ),
          loaderBlockedVisibleFrames: result.activations.reduce(
            (sum, sample) => sum + sample.loaderBlockedVisibleFrames,
            0,
          ),
          pendingRequestVisibleFrames: result.activations.reduce(
            (sum, sample) => sum + sample.pendingRequestVisibleFrames,
            0,
          ),
        },
        gates: [
          { metric: 'coldFirstUsefulP95Ms', operator: '<=', limit: 500 },
          { metric: 'warmFirstUsefulP95Ms', operator: '<=', limit: 100 },
          { metric: 'rapidLastFirstUsefulMs', operator: '<=', limit: 100 },
        ],
        evidence: [path],
      })
      expect(after).toEqual(before)
      expect(environment.compiledCacheRequested).toBe(true)
      expect(rapid.at(-1)!.target.id).toBe(
        cold.find((sample) => sample.phase === 'cold-photo-selection')!.target.id,
      )
      expect.soft(coldP95Ms).not.toBeNull()
      expect.soft(coldP95Ms!).toBeLessThanOrEqual(500)
      expect.soft(warmP95Ms).not.toBeNull()
      expect.soft(warmP95Ms!).toBeLessThanOrEqual(100)
      expect.soft(rapid.at(-1)!.firstUsefulMs).not.toBeNull()
      expect.soft(rapid.at(-1)!.firstUsefulMs!).toBeLessThanOrEqual(100)
      for (const sample of result.activations) {
        expect.soft(sample.wrongVisiblePublications).toBe(0)
        for (const at of [sample.firstUsefulAt, sample.nativeReadyAt]) {
          if (at === null) continue
          expect.soft(at).toBeGreaterThanOrEqual(sample.startedAt)
          if (sample.supersededAt !== null) expect.soft(at).toBeLessThanOrEqual(sample.supersededAt)
        }
        if (sample.firstUsefulAt !== null && sample.nativeReadyAt !== null)
          expect.soft(sample.firstUsefulAt).toBeLessThanOrEqual(sample.nativeReadyAt)
        if (!sample.nativeReady) continue
        expect.soft(sample.nativeReady.allocatedBytes).toBeGreaterThan(0)
        expect.soft(sample.nativeReady.allocatedBytes).toBeLessThanOrEqual(HDR_PRESENTATION_BUDGET)
        expect
          .soft(sample.nativeReady.retainedBytes)
          .toBeLessThanOrEqual(HDR_PRESENTATION_CACHE_BUDGET)
        if (!layout.fullscreen)
          expect
            .soft(sample.nativeReady.viewport)
            .toMatchObject({ width: layout.width, height: layout.height })
        expect.soft(sample.nativeReady.viewport.dpr).toBe(2)
      }
      expect(measurementDurationMs).toBeLessThan(120000)
    },
  )
