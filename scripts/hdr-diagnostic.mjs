/* global document -- Playwright callbacks run in the diagnostic renderer. */
import { _electron as electron } from '@playwright/test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, platform, release } from 'node:os'
import { join, resolve } from 'node:path'
import { artifactDirectory } from './verification-runner.mjs'

const configurations = {
  default: [],
  'wayland-gl-interop': [
    '--ozone-platform=wayland',
    '--enable-features=WebGPUOnVkViaGLInterop',
    '--enable-unsafe-webgpu',
  ],
  'wayland-native-vulkan': [
    '--ozone-platform=wayland',
    '--enable-features=Vulkan',
    '--use-vulkan=native',
    '--enable-unsafe-webgpu',
  ],
  wayland: ['--ozone-platform=wayland'],
  'wayland-vulkan': [
    '--ozone-platform=wayland',
    '--enable-features=Vulkan',
    '--enable-unsafe-webgpu',
  ],
  'wayland-angle-vulkan': [
    '--ozone-platform=wayland',
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--enable-unsafe-webgpu',
  ],
  'wayland-angle-blit': [
    '--ozone-platform=wayland',
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--disable-vulkan-surface',
    '--enable-unsafe-webgpu',
  ],
  'x11-vulkan': ['--ozone-platform=x11', '--enable-features=Vulkan', '--enable-unsafe-webgpu'],
}
const args = process.argv.slice(2)
const interactive = args.includes('--interactive')
const matrix = args.includes('--matrix')
const configuration = args.find((value) => !value.startsWith('--')) ?? 'default'
if (
  args.some((value) => value.startsWith('--') && !['--interactive', '--matrix'].includes(value)) ||
  args.filter((value) => !value.startsWith('--')).length > 1 ||
  !configurations[configuration] ||
  (matrix && (interactive || configuration !== 'default'))
)
  throw new Error('Use hdr:diagnostic -- [configuration] [--interactive], or --matrix.')
if (platform() !== 'linux' && (matrix || configuration !== 'default'))
  throw new Error('Only the default configuration applies outside Linux.')

const directory = await artifactDirectory('hdr-display')
const selected = matrix ? Object.keys(configurations) : [configuration]
console.log(`HDR diagnostic evidence: ${directory}`)
for (const name of selected) {
  const profile = await mkdtemp(join(tmpdir(), 'irodori-hdr-'))
  let desktop
  let closed = false
  const reports = []
  const logs = []
  const evidence = {
    schema: 1,
    configuration: name,
    flags: configurations[name],
    platform: platform(),
    release: release(),
    session: {
      type: process.env.XDG_SESSION_TYPE ?? null,
      desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      wayland: process.env.WAYLAND_DISPLAY ?? null,
    },
    started: new Date().toISOString(),
    physicalOutputVerified: false,
    meter: null,
    measurements: null,
    reports,
  }
  const save = () =>
    writeFile(join(directory, `${name}.json`), JSON.stringify(evidence, null, 2) + '\n')
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    desktop = await electron.launch({
      args: [
        resolve('out/main/hdr-diagnostic.js'),
        `--user-data-dir=${profile}`,
        ...configurations[name],
      ],
      env,
      chromiumSandbox: true,
      offline: true,
      timeout: 20_000,
    })
    desktop.on('close', () => {
      closed = true
    })
    desktop.process().stderr?.on('data', (chunk) => logs.push(chunk.toString()))
    const actual = await desktop.evaluate(({ app }) => app.getPath('userData'))
    if ((await realpath(actual)) !== (await realpath(profile)))
      throw new Error('Profile isolation failed.')
    evidence.runtime = await desktop.evaluate(async ({ app, BrowserWindow, screen }) => ({
      versions: process.versions,
      gpu: await app.getGPUInfo('complete'),
      features: app.getGPUFeatureStatus(),
      preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      forcedColorProfile: app.commandLine.getSwitchValue('force-color-profile'),
      enabledFeatures: app.commandLine.getSwitchValue('enable-features'),
      displays: screen.getAllDisplays(),
    }))
    if (
      evidence.runtime.noSandbox ||
      evidence.runtime.forcedColorProfile ||
      !evidence.runtime.preferences.sandbox ||
      !evidence.runtime.preferences.contextIsolation ||
      evidence.runtime.preferences.nodeIntegration
    )
      throw new Error('Diagnostic security or display settings are invalid.')
    const expectedFeatures =
      configurations[name]
        .find((flag) => flag.startsWith('--enable-features='))
        ?.slice('--enable-features='.length) ?? ''
    if (evidence.runtime.enabledFeatures !== expectedFeatures)
      throw new Error('The requested Chromium features were overridden.')
    const page = await desktop.firstWindow()
    page.on('pageerror', (error) => logs.push(`Renderer: ${error.message}`))
    page.on('console', (message) => {
      const text = message.text()
      if (text.startsWith('IRODORI_HDR_REPORT ')) {
        try {
          reports.push(JSON.parse(text.slice('IRODORI_HDR_REPORT '.length)))
        } catch {
          logs.push(text)
        }
      } else logs.push(text)
    })
    await page.waitForFunction(
      () => {
        const value = document.querySelector('#report')?.textContent
        return value && ['presented', 'unavailable'].includes(JSON.parse(value).state)
      },
      undefined,
      { timeout: 30_000 },
    )
    reports.push(JSON.parse(await page.locator('#report').textContent()))
    if (!closed) {
      evidence.runtime.gpu = await desktop.evaluate(({ app }) => app.getGPUInfo('complete'))
      evidence.runtime.features = await desktop.evaluate(({ app }) => app.getGPUFeatureStatus())
      const gpuWindowId = await desktop.evaluate(async ({ BrowserWindow }) => {
        const window = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        })
        await window.loadURL('chrome://gpu')
        return window.id
      })
      try {
        const gpuPage = desktop.windows().find((window) => window.url().startsWith('chrome://gpu'))
        await gpuPage.waitForFunction(
          () =>
            document.querySelector('info-view')?.shadowRoot?.textContent?.includes('GL_RENDERER'),
          undefined,
          { timeout: 10_000 },
        )
        const gpuText = await gpuPage.evaluate(() =>
          document.querySelector('info-view').getSelectionText(true),
        )
        await writeFile(join(directory, `${name}-chromium-gpu.txt`), gpuText)
      } finally {
        await desktop.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(),
          gpuWindowId,
        )
      }
    }
    await save()
    if (interactive) {
      console.log(
        'Move the window, compare SDR/HDR, and recheck after OS changes. Close the diagnostic window to save evidence.',
      )
      await new Promise((resolveClose) => {
        if (closed) resolveClose()
        else desktop.once('close', resolveClose)
      })
    } else {
      for (const mode of ['sdr', 'hdr', 'auto']) {
        const generation = reports.at(-1).target.generation
        await page.selectOption('#mode', mode)
        await page.waitForFunction(
          (previous) => {
            const value = JSON.parse(document.querySelector('#report').textContent)
            return (
              value.target.generation > previous &&
              ['presented', 'unavailable'].includes(value.state)
            )
          },
          generation,
          { timeout: 30_000 },
        )
        reports.push(JSON.parse(await page.locator('#report').textContent()))
      }
      if (reports.at(-1).state === 'presented') {
        await page.click('#lose')
        await page.waitForFunction(
          () => {
            const value = JSON.parse(document.querySelector('#report').textContent)
            return value.state === 'unavailable' && value.target.reason.includes('device lost')
          },
          undefined,
          { timeout: 10_000 },
        )
        evidence.deviceLossCleared = await page
          .locator('#patches')
          .evaluate((canvas) => canvas.style.visibility === 'hidden')
        if (!evidence.deviceLossCleared) throw new Error('Lost-device pixels remained visible.')
        await page.click('#retry')
        await page.waitForFunction(
          () => {
            const value = JSON.parse(document.querySelector('#report').textContent)
            return value.state === 'presented'
          },
          undefined,
          { timeout: 30_000 },
        )
        evidence.deviceRecoveryPresented = true
      }
      await page
        .screenshot({ path: join(directory, `${name}-sdr-screenshot.png`) })
        .catch((error) => {
          evidence.screenshotError = String(error)
        })
    }
    console.log(`${name}: ${reports.at(-1).state}; ${reports.at(-1).target.reason}`)
  } catch (error) {
    evidence.error = String(error)
    console.error(`${name}: ${evidence.error}`)
    process.exitCode = 1
  } finally {
    if (desktop && !closed) {
      await desktop.close().catch(() => desktop.process().kill('SIGKILL'))
    }
    evidence.finished = new Date().toISOString()
    await save()
    await writeFile(join(directory, `${name}.log`), logs.join('\n'))
    await rm(profile, { recursive: true, force: true })
  }
}
