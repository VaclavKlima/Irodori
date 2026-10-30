import { writeFile } from 'node:fs/promises'
import type { ElectronApplication, Page } from '@playwright/test'

/** The shared test launcher also enforces stayHidden on native captures. */
export async function captureWindow(app: ElectronApplication, page: Page, path: string) {
  const window = await app.browserWindow(page)
  const encoded = await window.evaluate(async (browserWindow) => {
    const image = await browserWindow.capturePage(undefined, { stayHidden: true, stayAwake: true })
    if (image.isEmpty()) throw new Error('Native window capture returned an empty image.')
    return image.toPNG().toString('base64')
  })
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.byteLength) throw new Error('Native window capture returned an empty PNG.')
  await writeFile(path, bytes)
}
