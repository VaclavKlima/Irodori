/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestElectron, assertTestWindowPolicy } from '../scripts/electron-test-launch.mjs'
import { encodeDiagnosticChannel, type DiagnosticTarget } from '../src/shared/hdr-display'
import { maximizeEditorOnMonitor } from './editor-native-window.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import {
  RECOVERY_PATTERN_KINDS,
  generateRecoveryPattern,
  recoveryPatternMetadata,
} from './recovery-color-fixtures.helpers'
import {
  compareRecoveryColor,
  disposeRecoveryColorGpu,
  initializeRecoveryColorGpu,
  measureRawHalfSnapshotThroughput,
} from './recovery-color.helpers'

interface DiagnosticReport {
  state: string
  target: DiagnosticTarget
  screen: {
    label: string | null
    left: number | null
    top: number | null
    width: number
    height: number
    hdrHeadroomStops: number | null
  } | null
  configured: {
    format: string
    colorSpace: string
    toneMapping: { mode: string }
    alphaMode: string
  } | null
  physicalOutputVerified: false
  error: string | null
}

const geometries = [
  { width: 1327, height: 1019 },
  { width: 2053, height: 769 },
]
const scenarios = [
  { name: 'SDR sRGB', mode: 'sdr', colorSpace: 'srgb' },
  { name: 'SDR Display P3', mode: 'sdr', colorSpace: 'display-p3' },
  { name: 'HDR Display P3', mode: 'hdr', colorSpace: 'display-p3' },
] as const
const foreground = foregroundTest(
  'Actual native display/headroom and hardware float-canvas browser recovery conversion require a foreground diagnostic window.',
)
const nativeWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY
// Match the normal Bazzite application's native compositor and hardware GPU path.
const nativeArguments = nativeWayland
  ? ['--ozone-platform=wayland', '--enable-features=Vulkan', '--enable-unsafe-webgpu']
  : []
const requestedConversionProfile = process.env.IRODORI_RECOVERY_CONVERSION_PROFILE
if (
  requestedConversionProfile !== undefined &&
  !['raw-half', 'raw-half-throughput'].includes(requestedConversionProfile)
)
  throw new Error(
    'Recovery diagnostics support only unset, raw-half or raw-half-throughput conversion profiles.',
  )
const conversionProfile = 'raw-half' as const
const maximumRgbCodeDifference = 1
const throughputOnly = requestedConversionProfile === 'raw-half-throughput'

async function report(page: Page): Promise<DiagnosticReport> {
  return JSON.parse((await page.locator('#report').textContent()) || '{}')
}

if (!throughputOnly)
  for (const scenario of scenarios) {
    test(
      `bounded raw-half recovery color corpus: ${scenario.name} (RGB <=1, alpha exact)`,
      foreground,
      async ({}, info) => {
        requiresForeground(test, 'Hardware browser conversion and actual native display metadata.')
        test.setTimeout(300_000)
        const profile = await mkdtemp(join(tmpdir(), 'irodori-e2e-recovery-color-')),
          env = { ...process.env } as Record<string, string>,
          results: Array<Awaited<ReturnType<typeof compareRecoveryColor>>> = [],
          errors: Array<{ fixture: string; error: string }> = [],
          evidence: Record<string, unknown> = {
            scenario,
            conversionProfile,
            plannedFixtures: geometries.length * RECOVERY_PATTERN_KINDS.length,
            geometryPlan: geometries,
            patterns: RECOVERY_PATTERN_KINDS,
            profile,
            format: 'recovery-color-raw-half-v1',
            policy: {
              acceptedEmergencyRecoveryOnly: {
                version: 'float16-cpu-snapshot-v1',
                maximumRgbCodeDifference,
                alphaExact: true,
              },
              strictZeroComparison:
                'Measurement only. Historical strict-zero failures remain failed evidence; this criterion does not assert zero conversion error.',
              normalEditingAndExportBounds: 'Unchanged.',
              scope:
                'Synthetic encoded display RGB in a catalog-free diagnostic. This independently exercises the accepted raw-half conversion recipe; it does not call the application presenter. Sampled evidence cannot establish a universal bound or physical HDR output.',
              acceleration:
                'Explicit RGBA16F GPU readback to owned CPU bits; source-gamut float16 CPU reconstruction and CPU sRGB8 conversion.',
            },
            results,
            errors,
          }
        delete env.ELECTRON_RUN_AS_NODE
        let desktop: ElectronApplication | undefined,
          child: ChildProcess | undefined,
          evidenceFile: string | undefined,
          page: Page | undefined
        const save = async () => {
          evidence.completedFixtures = results.length
          evidence.acceptedBoundFailures = results.filter(
            (row) => !row.acceptedRecoveryBound.passed,
          ).length
          evidence.strictZeroComparison = {
            role: 'measurement-only',
            comparedFixtures: results.length,
            differingFixtures: results.filter((row) => !row.strictZeroComparison.identical).length,
            maximumRgbCodeDifference: results.length
              ? Math.max(...results.map((row) => row.maxRgbCodeDifference))
              : null,
            maximumAlphaCodeDifference: results.length
              ? Math.max(...results.map((row) => row.maxAlphaCodeDifference))
              : null,
            changedRGBA: results.length
              ? [0, 1, 2, 3].map((channel) =>
                  results.reduce((total, row) => total + row.changedRGBA[channel], 0),
                )
              : null,
            assertion:
              'None: exact zero is retained as a comparison, not the accepted recovery criterion.',
          }
          evidence.incomplete =
            results.length !== geometries.length * RECOVERY_PATTERN_KINDS.length ||
            errors.length > 0 ||
            !!evidence.caseError
          await writeFile(
            info.outputPath('recovery-color-evidence.json'),
            JSON.stringify(evidence, null, 2),
          )
        }
        try {
          const launched = await launchTestElectron({
            userDataDir: profile,
            artifacts: info.outputPath('launch'),
            entry: 'hdr-diagnostic',
            args: nativeArguments,
            env,
          })
          ;({ app: desktop, child, evidenceFile } = launched)
          expect(await realpath(await desktop.evaluate(({ app }) => app.getPath('userData')))).toBe(
            await realpath(profile),
          )
          const security = await desktop.evaluate(({ app, BrowserWindow }) => ({
            preferences: (
              BrowserWindow.getAllWindows()[0].webContents as unknown as {
                getLastWebPreferences(): Electron.WebPreferences
              }
            ).getLastWebPreferences(),
            noSandbox: app.commandLine.hasSwitch('no-sandbox'),
            forcedColorProfile: app.commandLine.getSwitchValue('force-color-profile'),
            enabledFeatures: app.commandLine.getSwitchValue('enable-features'),
            ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
            versions: process.versions,
          }))
          evidence.security = security
          expect(security).toMatchObject({
            noSandbox: false,
            forcedColorProfile: '',
            enabledFeatures: nativeWayland ? 'Vulkan' : '',
            ozonePlatform: nativeWayland ? 'wayland' : '',
            preferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webSecurity: true,
            },
          })
          page = await desktop.firstWindow()
          await expect(page.locator('#report')).toContainText('target')
          evidence.bridge = await page.evaluate(() => ({
            diagnostic: 'hdrDiagnostic' in window,
            application: 'irodori' in window,
            node: 'require' in window,
          }))
          expect(evidence.bridge).toEqual({ diagnostic: true, application: false, node: false })
          if (process.platform === 'linux') {
            evidence.nativeGeometry = await maximizeEditorOnMonitor(desktop, page, {
              diagnosticOnly: true,
            })
          } else {
            const native = await desktop.browserWindow(page)
            await native.evaluate((window) => window.maximize())
            evidence.nativeGeometry = await native.evaluate((window) => ({
              maximized: window.isMaximized(),
              fullscreen: window.isFullScreen(),
              bounds: window.getBounds(),
              contentBounds: window.getContentBounds(),
            }))
          }
          await page.getByLabel('Preview').selectOption(scenario.mode)
          await page.getByLabel('Canvas gamut').selectOption(scenario.colorSpace)
          await expect.poll(async () => (await report(page!)).target?.requested).toBe(scenario.mode)
          await expect.poll(async () => (await report(page!)).state).toBe('presented')
          const before = await report(page)
          evidence.displayBefore = before
          await save()
          expect(before.target.mode, `Actual target unavailable: ${before.target.reason}`).toBe(
            scenario.mode,
          )
          expect(before.screen, 'Actual screen identity/headroom must be available.').not.toBeNull()
          expect(before.screen!.width).toBeGreaterThan(0)
          expect(before.screen!.height).toBeGreaterThan(0)
          expect(before.configured).toMatchObject({
            format: 'rgba16float',
            colorSpace: scenario.colorSpace,
            alphaMode: 'opaque',
            toneMapping: { mode: scenario.mode === 'hdr' ? 'extended' : 'standard' },
          })
          if (scenario.mode === 'hdr') expect(before.target.headroom).toBeGreaterThan(1)
          const peakLinear = scenario.mode === 'hdr' ? before.target.headroom! : 1,
            peakEncoded = encodeDiagnosticChannel(peakLinear)
          evidence.inputRange = {
            peakLinear,
            peakEncoded,
            domain: 'encoded-display-rgb',
            hdrPeakSource:
              scenario.mode === 'hdr'
                ? 'actual reported linear target headroom; absolute nits unknown'
                : 'SDR reference white',
          }
          evidence.gpu = await page.evaluate(initializeRecoveryColorGpu)
          await save()
          for (const geometry of geometries) {
            for (const kind of RECOVERY_PATTERN_KINDS) {
              const metadata = recoveryPatternMetadata(
                  kind,
                  geometry.width,
                  geometry.height,
                  peakEncoded,
                ),
                fixture = `${kind}-${geometry.width}x${geometry.height}`,
                input = await page.evaluateHandle(generateRecoveryPattern, metadata)
              try {
                const result = await page.evaluate(compareRecoveryColor, {
                  input,
                  metadata,
                  mode: scenario.mode,
                  colorSpace: scenario.colorSpace,
                })
                results.push(result)
                await save()
                expect.soft(result.actualDownscale, fixture).toBe(true)
                expect.soft(Math.max(result.outputWidth, result.outputHeight), fixture).toBe(1024)
                expect
                  .soft(result.referenceContext, fixture)
                  .toMatchObject({ colorSpace: 'srgb', willReadFrequently: true })
                expect.soft(result.candidateContext, fixture).toMatchObject({
                  colorSpace: 'srgb',
                  willReadFrequently: true,
                })
                expect
                  .soft(result.referenceReadback, fixture)
                  .toEqual({ colorSpace: 'srgb', constructor: 'Uint8ClampedArray' })
                expect
                  .soft(result.candidateReadback, fixture)
                  .toEqual({ colorSpace: 'srgb', constructor: 'Uint8ClampedArray' })
                expect.soft(result.referencePixelsDifferentFromFirst, fixture).toBeGreaterThan(0)
                expect
                  .soft(result.referenceRgbCodeRange.maximum, fixture)
                  .toBeGreaterThan(result.referenceRgbCodeRange.minimum)
                expect
                  .soft(result.referenceAlphaCodeRange, fixture)
                  .toEqual({ minimum: 255, maximum: 255 })
                expect.soft(result.rawHalfSnapshot, fixture).toMatchObject({
                  ownedCpuBytes: geometry.width * geometry.height * 8,
                  sourceUnconfiguredBeforeConversion: true,
                  readbackDestroyedBeforeConversion: true,
                  reconstructedContext: {
                    colorSpace: scenario.colorSpace,
                    colorType: 'float16',
                    willReadFrequently: true,
                  },
                  reconstructedImageData: {
                    colorSpace: scenario.colorSpace,
                    pixelFormat: 'rgba-float16',
                    constructor: 'Float16Array',
                  },
                })
                expect
                  .soft(result.maxRgbCodeDifference, fixture)
                  .toBeLessThanOrEqual(maximumRgbCodeDifference)
                expect.soft(result.maxAlphaCodeDifference, fixture).toBe(0)
              } catch (error) {
                errors.push({ fixture, error: String(error) })
                await save()
                expect
                  .soft(String(error), fixture)
                  .toBe('Successful actual GPU conversion and complete readback')
              } finally {
                await input.dispose()
              }
            }
          }
          const after = await report(page)
          evidence.displayAfter = after
          await save()
          expect(after.state).toBe('presented')
          expect(after.screen).toEqual(before.screen)
          expect(after.target).toEqual(before.target)
          expect(after.configured).toEqual(before.configured)
          expect(results).toHaveLength(geometries.length * RECOVERY_PATTERN_KINDS.length)
          expect(errors).toEqual([])
          expect(await readdir(profile)).not.toContain('library')
        } catch (error) {
          evidence.caseError = String(error)
          if (page && !page.isClosed())
            evidence.lastDisplayReport = await report(page).catch(() => null)
          throw error
        } finally {
          try {
            if (page && !page.isClosed()) await page.evaluate(disposeRecoveryColorGpu)
            evidence.catalogCreated = (await readdir(profile)).includes('library')
            await save()
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
        }
      },
    )
  }

if (throughputOnly)
  test(
    'raw-half snapshot throughput at measured native editor viewport: strict await',
    foreground,
    async ({}, info) => {
      requiresForeground(test, 'Native hardware WebGPU and recorded maximized display geometry.')
      test.setTimeout(180_000)
      const profile = await mkdtemp(join(tmpdir(), 'irodori-e2e-raw-half-throughput-')),
        env = { ...process.env } as Record<string, string>,
        plan = { width: 2866, height: 1189, trials: 90 },
        evidence: Record<string, unknown> = {
          profile: 'raw-half-throughput',
          mode: 'strict-await',
          plan,
          geometrySource:
            'Measured native maximized editor viewport from 2026-10-19T12-13-00-maximized-spatial-60hz-diagnostic; this catalog-free diagnostic uses matching offscreen dimensions and records its own actual native geometry.',
          colorCorpusSelected: false,
          scope:
            'Isolated raw RGBA16F texture copy/map/CPU ownership diagnostic. No CPU oracle, drawImage, rare color conversion, app source change or visible-cadence/adoption gate. The accepted color corpus is separate; historical strict-zero failures remain retained evidence.',
          requestedProfile: profile,
        }
      delete env.ELECTRON_RUN_AS_NODE
      let desktop: ElectronApplication | undefined,
        child: ChildProcess | undefined,
        evidenceFile: string | undefined,
        page: Page | undefined
      const save = () =>
        writeFile(
          info.outputPath('raw-half-throughput-evidence.json'),
          JSON.stringify(evidence, null, 2),
        )
      try {
        const launched = await launchTestElectron({
          userDataDir: profile,
          artifacts: info.outputPath('launch'),
          entry: 'hdr-diagnostic',
          args: nativeArguments,
          env,
        })
        ;({ app: desktop, child, evidenceFile } = launched)
        evidence.actualProfile = await realpath(
          await desktop.evaluate(({ app }) => app.getPath('userData')),
        )
        expect(evidence.actualProfile).toBe(await realpath(profile))
        evidence.security = await desktop.evaluate(({ app, BrowserWindow }) => ({
          preferences: (
            BrowserWindow.getAllWindows()[0].webContents as unknown as {
              getLastWebPreferences(): Electron.WebPreferences
            }
          ).getLastWebPreferences(),
          noSandbox: app.commandLine.hasSwitch('no-sandbox'),
          forcedColorProfile: app.commandLine.getSwitchValue('force-color-profile'),
          enabledFeatures: app.commandLine.getSwitchValue('enable-features'),
          ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
          unsafeWebgpu: app.commandLine.hasSwitch('enable-unsafe-webgpu'),
          versions: process.versions,
        }))
        expect(evidence.security).toMatchObject({
          noSandbox: false,
          forcedColorProfile: '',
          enabledFeatures: nativeWayland ? 'Vulkan' : '',
          preferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        })
        page = await desktop.firstWindow()
        await expect(page.locator('#report')).toContainText('target')
        evidence.bridge = await page.evaluate(() => ({
          diagnostic: 'hdrDiagnostic' in window,
          application: 'irodori' in window,
          node: 'require' in window,
        }))
        expect(evidence.bridge).toEqual({ diagnostic: true, application: false, node: false })
        if (process.platform === 'linux')
          evidence.nativeGeometry = await maximizeEditorOnMonitor(desktop, page, {
            diagnosticOnly: true,
          })
        else {
          const native = await desktop.browserWindow(page)
          await native.evaluate((window) => window.maximize())
          evidence.nativeGeometry = await native.evaluate((window) => ({
            maximized: window.isMaximized(),
            fullscreen: window.isFullScreen(),
            bounds: window.getBounds(),
            contentBounds: window.getContentBounds(),
          }))
        }
        await page.getByLabel('Preview').selectOption('sdr')
        await page.getByLabel('Canvas gamut').selectOption('display-p3')
        await expect.poll(async () => (await report(page!)).state).toBe('presented')
        const before = await report(page)
        evidence.displayBefore = before
        await save()
        expect(before.target.mode).toBe('sdr')
        expect(before.screen).not.toBeNull()
        expect(before.configured).toMatchObject({
          format: 'rgba16float',
          colorSpace: 'display-p3',
          alphaMode: 'opaque',
          toneMapping: { mode: 'standard' },
        })
        evidence.gpu = await page.evaluate(initializeRecoveryColorGpu)
        const result = await page.evaluate(measureRawHalfSnapshotThroughput, plan)
        evidence.result = result
        evidence.displayAfter = await report(page)
        await save()
        expect(result.completedTrials).toBe(plan.trials)
        expect(result.publishedSerial).toBe(plan.trials)
        expect(result.mappedCount).toBe(plan.trials)
        expect(result.unmappedCount).toBe(plan.trials)
        expect(result.maximumInFlightSnapshots).toBe(1)
        expect(result.cpuOwnershipSlots).toBe(2)
        expect(result.ownedCpuBytes).toBe(plan.width * plan.height * 8)
        expect(result.ownership).toMatchObject({
          readbackUnmappedBeforeEveryWitness: true,
          sourceDestroyedBeforeFinalCpuHash: true,
          readbackDestroyedBeforeFinalCpuHash: true,
        })
        expect(result.observations.every((row) => row.matchingSerial)).toBe(true)
        const after = evidence.displayAfter as DiagnosticReport
        expect(after.state).toBe('presented')
        expect(after.screen).toEqual(before.screen)
        expect(after.target).toEqual(before.target)
        expect(after.configured).toEqual(before.configured)
        expect(await readdir(profile)).not.toContain('library')
      } catch (error) {
        evidence.error = String(error)
        if (page && !page.isClosed()) {
          evidence.progress = await page
            .evaluate(
              () =>
                (window as Window & { rawHalfThroughputProgress?: unknown })
                  .rawHalfThroughputProgress ?? null,
            )
            .catch(() => null)
          evidence.lastDisplayReport = await report(page).catch(() => null)
        }
        throw error
      } finally {
        try {
          if (page && !page.isClosed()) await page.evaluate(disposeRecoveryColorGpu)
          evidence.catalogCreated = (await readdir(profile)).includes('library')
          await save()
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
      }
    },
  )
