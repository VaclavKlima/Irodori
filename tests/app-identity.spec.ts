import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureAppIdentity } from '../src/main/app-identity'

let directory: string
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'irodori-identity-'))
})
test.afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function desktop(appData: string, explicitProfile?: string) {
  let name = 'Irodori'
  const paths = new Map<string, string>()
  const app = {
    commandLine: { hasSwitch: (key: string) => key === 'user-data-dir' && !!explicitProfile },
    getPath(key: string): string {
      if (key === 'appData') return appData
      if (key === 'userData') return paths.get(key) ?? explicitProfile ?? join(appData, name)
      if (key === 'sessionData') return paths.get(key) ?? app.getPath('userData')
      throw new Error(`Unexpected application path: ${key}`)
    },
    setPath(key: string, path: string) {
      if (!existsSync(path)) throw new Error('Electron requires the profile directory to exist.')
      paths.set(key, path)
    },
    setName(value: string) {
      name = value
    },
    getName: () => name,
  }
  return app
}

test('renaming preserves the existing library and settings even when a new-name folder exists', async () => {
  const profile = join(directory, 'Luma')
  const originals = join(profile, 'library', 'originals')
  await mkdir(originals, { recursive: true })
  await mkdir(join(directory, 'Irodori'))
  const original = Buffer.from([0, 1, 2, 127, 255])
  const settings = '{"version":1,"saved":"existing profile"}\n'
  await writeFile(join(originals, 'retained-original'), original)
  await writeFile(join(profile, 'resource-settings.json'), settings)

  const app = desktop(directory)
  configureAppIdentity(app)

  expect(app.getName()).toBe('Irodori')
  for (const key of ['userData', 'sessionData']) expect(app.getPath(key)).toBe(profile)
  expect(
    await readFile(join(app.getPath('userData'), 'library/originals/retained-original')),
  ).toEqual(original)
  expect(await readFile(join(app.getPath('userData'), 'resource-settings.json'), 'utf8')).toBe(
    settings,
  )
})

test('an explicit isolated profile takes priority over the normal library directory', async () => {
  const profile = join(directory, 'isolated-profile')
  await mkdir(profile)
  const appData = join(directory, 'untouched-app-data')
  const app = desktop(appData, profile)

  configureAppIdentity(app)

  expect(app.getName()).toBe('Irodori')
  for (const key of ['userData', 'sessionData']) expect(app.getPath(key)).toBe(profile)
  expect(existsSync(appData)).toBe(false)
})

test('a first launch creates its stable profile before Electron receives the path', () => {
  const app = desktop(directory)
  configureAppIdentity(app)
  expect(app.getPath('userData')).toBe(join(directory, 'Luma'))
  expect(existsSync(app.getPath('userData'))).toBe(true)
  expect(existsSync(join(directory, 'Irodori'))).toBe(false)
})
