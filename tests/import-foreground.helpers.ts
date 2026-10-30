import { copyFile, mkdir } from 'node:fs/promises'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'
import { choose } from './import.helpers'
import { activateButton, type ButtonActivation } from './button.helpers'

export async function foregroundImport(
  app: ElectronApplication,
  page: Page,
  info: TestInfo,
  raw = false,
  activation: ButtonActivation = 'pointer',
) {
  const source = info.outputPath('card-import')
  await mkdir(source, { recursive: true })
  const paths = []
  for (let i = 0; i < 6; i++) {
    const path = `${source}/${i}.${raw ? 'ARW' : 'jpg'}`
    await copyFile(
      raw ? 'tests/fixtures/sony-zv1.ARW' : 'tests/fixtures/photos/forest-light.jpg',
      path,
    )
    paths.push(path)
  }
  await activateButton(page.getByRole('button', { name: 'Import photos', exact: true }), activation)
  await choose(app, page, paths, 'photos', activation)
  await expect(page.getByTestId('import-status')).toContainText('Ready to import')
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
    const { Readable } = process.getBuiltinModule('stream') as typeof import('node:stream')
    const { setTimeout: delay } = process.getBuiltinModule(
      'timers/promises',
    ) as typeof import('node:timers/promises')
    const original = fs.createReadStream
    fs.createReadStream = (path, options) => {
      if (!String(path).includes('card-import')) return original(path, options)
      const settings = typeof options === 'object' ? options : {}
      const source = original(path, { ...settings, highWaterMark: 4096 })
      return Readable.from(
        (async function* () {
          try {
            for await (const chunk of source) {
              await delay(35, undefined, { signal: settings?.signal ?? undefined })
              yield chunk
            }
          } finally {
            source.destroy()
          }
        })(),
      ) as import('node:fs').ReadStream
    }
    process.getBuiltinModule('module').syncBuiltinESMExports()
  })
  await activateButton(
    page.getByRole('button', { name: 'Import 6 photos', exact: true }),
    activation,
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const id = await page.evaluate(
    async () =>
      (await window.irodori.listTasks()).find((t) => t.kind === 'import' && t.status === 'running')!
        .id,
  )
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.irodori.listTasks()).find((t) => t.id === id)?.transfer?.bytes ?? 0,
        id,
      ),
    )
    .toBeGreaterThan(0)
  return id
}

export async function benchmarkImport(app: ElectronApplication, page: Page, info: TestInfo) {
  if (process.env.IRODORI_BENCHMARK_IMPORT_ACTIVE !== '1') return undefined
  return foregroundImport(app, page, info, true)
}
export async function finishBenchmarkImport(page: Page, id?: string) {
  if (!id) return
  expect(
    await page.evaluate(
      async (id) => (await window.irodori.listTasks()).find((t) => t.id === id)?.status,
      id,
    ),
  ).toBe('running')
  await page.evaluate((id) => window.irodori.cancelTask(id), id)
}
