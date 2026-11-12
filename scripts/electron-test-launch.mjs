import { _electron as electron } from '@playwright/test'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { testUiMode } from './test-ui-mode.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const bootstrap = fileURLToPath(new URL('./electron-test-bootstrap.cjs', import.meta.url))

export async function prepareTestElectron({
  userDataDir,
  artifacts,
  entry = 'index',
  compiledRoot = join(root, 'out'),
  env = process.env,
}) {
  if (!['index', 'hdr-diagnostic'].includes(entry)) throw new Error('Unknown Electron test entry.')
  const profile = await realpath(userDataDir)
  const compiled = await realpath(compiledRoot)
  const directory = resolve(artifacts)
  await mkdir(directory, { recursive: true })
  const mode = testUiMode(env)
  const evidenceFile = join(directory, 'window-policy.json')
  const packageDirectory = join(directory, 'app')
  await mkdir(packageDirectory, { recursive: true })
  const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name, version, main: 'entry.cjs' }),
  )
  await writeFile(
    join(packageDirectory, 'entry.cjs'),
    `require(${JSON.stringify(bootstrap)}).start(${JSON.stringify({
      entry: join(compiled, 'main', `${entry}.js`),
      profile,
      evidenceFile,
      mode,
    })}).catch(error => { console.error(error); require('electron').app.exit(1) })\n`,
  )
  const launchEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  )
  delete launchEnv.ELECTRON_RUN_AS_NODE
  delete launchEnv.ELECTRON_RENDERER_URL
  delete launchEnv.FORCE_COLOR
  delete launchEnv.NODE_OPTIONS
  launchEnv.IRODORI_TEST_UI_MODE = mode
  return { profile, packageDirectory, evidenceFile, launchEnv, mode }
}

export async function launchTestElectron({ args = [], offline = true, ...options }) {
  if (args.some((arg) => arg.startsWith('--user-data-dir')))
    throw new Error('The shared test launcher owns the isolated profile argument.')
  const { profile, packageDirectory, evidenceFile, launchEnv, mode } =
    await prepareTestElectron(options)
  const app = await electron.launch({
    args: [packageDirectory, `--user-data-dir=${profile}`, ...args],
    env: launchEnv,
    chromiumSandbox: true,
    offline,
    timeout: 20_000,
  })
  const child = app.process()
  try {
    const observed = await app.evaluate(({ app }) => ({
      profile: app.getPath('userData'),
      mode: globalThis.__irodoriTestUiMode,
    }))
    if ((await realpath(observed.profile)) !== profile || observed.mode !== mode)
      throw new Error('The isolated Electron startup policy was not installed.')
    await assertTestWindowPolicy(evidenceFile)
    return { app, child, evidenceFile }
  } catch (error) {
    await app.close().catch(() => undefined)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    throw error
  }
}

export async function assertTestWindowPolicy(evidenceFile) {
  const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
  if (evidence.violations.length)
    throw new Error(
      `Electron window policy failed: ${evidence.violations.join(', ')}. ${evidenceFile}`,
    )
  if (evidence.mode === 'background' && evidence.windows.some((w) => w.showEvents || w.focusEvents))
    throw new Error(`Background Electron exposed a native window. ${evidenceFile}`)
  return evidence
}

/** Real packaged startup cannot be wrapped before main runs. It is explicitly foreground-only. */
export async function launchPackagedTestElectron({
  executablePath,
  userDataDir,
  artifacts,
  env = process.env,
}) {
  if (testUiMode(env) !== 'foreground')
    throw new Error('Packaged startup requires explicit foreground testing.')
  const profile = await realpath(userDataDir),
    directory = resolve(artifacts)
  await mkdir(directory, { recursive: true })
  const launchEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  )
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'FORCE_COLOR',
    'NODE_OPTIONS',
  ])
    delete launchEnv[key]
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    env: launchEnv,
    chromiumSandbox: true,
    offline: true,
    timeout: 20000,
  })
  const child = app.process(),
    evidenceFile = join(directory, 'window-policy.json')
  try {
    const observed = await app.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      profile: app.getPath('userData'),
      pid: process.pid,
      windows: BrowserWindow.getAllWindows().map((w) => ({
        id: w.id,
        showEvents: w.isVisible() ? 1 : 0,
        focusEvents: w.isFocused() ? 1 : 0,
        closed: false,
      })),
    }))
    if (!observed.packaged || (await realpath(observed.profile)) !== profile)
      throw new Error('Packaged startup profile isolation failed.')
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          mode: 'foreground',
          pid: observed.pid,
          profile,
          windows: observed.windows,
          violations: [],
        },
        null,
        2,
      ),
    )
    return { app, child, evidenceFile }
  } catch (error) {
    await app.close().catch(() => undefined)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    throw error
  }
}
