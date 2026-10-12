import { resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export async function choose(
  app: ElectronApplication,
  page: Page,
  paths: string[],
  kind: 'photos' | 'folder' = 'photos',
) {
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: !paths.length, filePaths: paths })
    },
    paths.map((path) => resolve(path)),
  )
  await page.getByRole('button', { name: `Choose ${kind}`, exact: true }).click()
}

export async function importPhotos(
  app: ElectronApplication,
  page: Page,
  paths = ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/photos/mountain-ridge.jpg'],
  waitForPreview = true,
) {
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, paths)
  await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('import-status')).toContainText(`${paths.length} awaiting checks`)
  await page.getByRole('button', { name: `Import ${paths.length} photos`, exact: true }).click()
  await expectImportComplete(page)
  if (!waitForPreview) return
  await expect(page.getByTestId('main-preview')).toBeVisible()
  await expect
    .poll(() =>
      page.getByTestId('main-preview').evaluate((image) => (image as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(0)
}

export async function expectImportComplete(page: Page) {
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('task-progress')).toContainText('Import complete', {
    timeout: 30_000,
  })
}
