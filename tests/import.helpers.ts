import { resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { activateButton, type ButtonActivation } from './button.helpers'

export async function choose(
  app: ElectronApplication,
  page: Page,
  paths: string[],
  kind: 'photos' | 'folder' = 'photos',
  activation: ButtonActivation = 'pointer',
) {
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: !paths.length, filePaths: paths })
    },
    paths.map((path) => resolve(path)),
  )
  await activateButton(
    page.getByRole('button', { name: `Choose ${kind}`, exact: true }),
    activation,
  )
}

export async function importPhotos(
  app: ElectronApplication,
  page: Page,
  paths = ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/photos/mountain-ridge.jpg'],
  waitForPreview = true,
  activation: ButtonActivation = 'pointer',
) {
  await activateButton(page.getByLabel('Import photos', { exact: true }), activation)
  await choose(app, page, paths, 'photos', activation)
  await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('import-status')).toContainText(`${paths.length} awaiting checks`)
  await activateButton(
    page.getByRole('button', { name: `Import ${paths.length} photos`, exact: true }),
    activation,
  )
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
