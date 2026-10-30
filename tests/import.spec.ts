import { revealEditorPhoto, revealImportCandidate } from './collection-ui.helpers'
import { copyFile, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './electron.fixture'
import { choose, expectImportComplete } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'

test('reviews a folder, excludes photos, copies originals, persists, and marks duplicates', async ({
  irodori,
}, testInfo) => {
  const { app, page } = irodori
  const source = testInfo.outputPath('Výběr fotek')
  await mkdir(join(source, 'nested'), { recursive: true })
  const original = await readFile('tests/fixtures/photos/alpine-lake.jpg')
  await writeFile(join(source, 'výlet.jpg'), original)
  await copyFile('tests/fixtures/photos/mountain-ridge.jpg', join(source, 'nested', 'exclude.jpg'))
  await writeFile(join(source, 'broken.jpg'), 'not a photo')
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Include subfolders' })).toBeChecked()
  await choose(app, page, [source], 'folder')
  await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('import-status')).toContainText(
    '3 awaiting checks · 0 duplicates · 0 errors',
  )
  await expect(page.getByRole('checkbox', { name: 'Import výlet.jpg', exact: true })).toBeChecked()
  await expect(
    page.getByRole('checkbox', { name: 'Import exclude.jpg', exact: true }),
  ).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Import broken.jpg', exact: true })).toBeEnabled()
  await page.getByRole('checkbox', { name: 'Import broken.jpg', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: 'Import exclude.jpg', exact: true }).uncheck()
  await expect(page.getByRole('button', { name: 'Import 1 photos', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('import-review.png') })
  await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
  await expectImportComplete(page)
  await expect(page.getByTestId('preview-filename')).toHaveText('výlet.jpg')
  const catalog = await page.evaluate(() => window.irodori.listPhotos())
  expect(catalog.total).toBe(1)
  const stored = join(
    irodori.userDataDir,
    'library',
    'originals',
    catalog.photos[0].id,
    'original.jpg',
  )
  expect(await readFile(stored)).toEqual(original)
  expect(await readdir(join(irodori.userDataDir, 'library', 'staging'))).toEqual([])
  await rm(source, { recursive: true })
  const restarted = await irodori.restart()
  await expect(restarted.page.getByTestId('preview-filename')).toHaveText('výlet.jpg')
  await expect
    .poll(() =>
      restarted.page
        .getByTestId('main-preview')
        .evaluate((image) => (image as HTMLCanvasElement).width),
    )
    .toBeGreaterThan(0)
  await mkdir(source)
  await writeFile(join(source, 'renamed.jpg'), original)
  await restarted.page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(restarted.app, restarted.page, [join(source, 'renamed.jpg')])
  await expect(restarted.page.getByTestId('import-status')).toContainText('Ready to import')
  await expect(restarted.page.getByTestId('import-status')).toContainText('1 awaiting checks')
  await expect(restarted.page.getByRole('checkbox', { name: 'Import renamed.jpg' })).toBeEnabled()
  await restarted.page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
  await expectImportComplete(restarted.page)
  expect((await restarted.page.evaluate(() => window.irodori.listPhotos())).total).toBe(1)
  await restarted.page.getByTestId('task-progress').click()
  await expect(restarted.page.getByTestId('task-details')).toContainText('1 duplicate')
})

test('supports picker cancellation, nonrecursive folders, select all and keyboard dismissal', async ({
  irodori,
}, testInfo) => {
  const { app, page } = irodori
  const source = testInfo.outputPath('folder')
  await mkdir(join(source, 'nested'), { recursive: true })
  await copyFile('tests/fixtures/photos/alpine-lake.jpg', join(source, 'one.jpg'))
  await copyFile('tests/fixtures/photos/mountain-ridge.jpg', join(source, 'nested', 'two.jpg'))
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, [])
  await expect(page.getByText('Start with a photo or a folder')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Include subfolders' }).uncheck()
  await choose(app, page, [source], 'folder')
  await expect(page.getByTestId('import-status')).toContainText('Ready to import')
  await expect(page.getByTestId('import-status')).toContainText('1 found')
  await choose(app, page, [])
  await expect(page.getByTestId('import-status')).toContainText('1 found')
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Import 0 photos', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Import one.jpg' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await page.evaluate(() => window.irodori.listPhotos())).total).toBe(0)
  expect(await readdir(join(irodori.userDataDir, 'library', 'staging'))).toEqual([])
})

test('reviews and browses a library across loaded and unloaded records', async ({
  irodori,
}, testInfo) => {
  test.setTimeout(90_000)
  const { app, page } = irodori
  const source = testInfo.outputPath('large-folder')
  await mkdir(source)
  const bytes = await readFile('tests/fixtures/photos/alpine-lake.jpg')
  for (let index = 0; index < 61; index++) {
    // Distinct JPEG files with a trailing identifier exercise content-based identity.
    const path = join(source, `${String(index).padStart(2, '0')}.jpg`)
    await writeFile(path, Buffer.concat([bytes, Buffer.from(String(index))]))
    const date = new Date(Date.UTC(2024, 0, 1) + index * 60_000)
    await utimes(path, date, date)
  }
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await choose(app, page, [source], 'folder')
  await expect(page.getByTestId('import-status')).toContainText('Ready to import', {
    timeout: 60_000,
  })
  await expect(page.getByRole('button', { name: 'Import 61 photos', exact: true })).toBeEnabled()
  await expect(
    page.getByRole('checkbox', { name: /^Import .*\.jpg$/ }).first(),
  ).toHaveAccessibleName('Import 60.jpg')
  await revealImportCandidate(page, 60, '00.jpg')
  await expect(page.getByRole('checkbox', { name: 'Import 00.jpg', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Import 61 photos', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText(/^\d{2}\.jpg$/)
  const initialPreview = await page.getByTestId('preview-filename').textContent()
  await expectImportComplete(page)
  await expect(page.getByTestId('preview-filename')).toHaveText(initialPreview!)
  // Parallel preparation determines publication order. Browse the actual
  // catalog boundary while keeping the initially active photograph unchanged.
  const [firstPage, lastPage] = await page.evaluate(async () =>
      Promise.all([window.irodori.listPhotos(), window.irodori.listPhotos(60)]),
    ),
    newest = firstPage.photos[0].filename,
    previous = firstPage.photos.at(-1)!.filename,
    oldest = lastPage.photos[0].filename
  await revealEditorPhoto(page, lastPage.photos[0].id)
  await expect(page.getByTestId('preview-filename')).toHaveText(initialPreview!)
  await page.getByRole('button', { name: `Select ${oldest}`, exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText(oldest)
  await page.getByRole('button', { name: 'Previous photo', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText(previous)
  await page.getByRole('button', { name: 'Next photo', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText(oldest)
  await revealEditorPhoto(page, firstPage.photos[0].id)
  await expect(page.getByTestId('preview-filename')).toHaveText(oldest)
  await page.getByRole('button', { name: `Select ${newest}`, exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText(newest)
  await revealEditorPhoto(page, lastPage.photos[0].id)
  await expect(page.getByTestId('preview-filename')).toHaveText(newest)
  await page
    .getByRole('button', { name: `Select ${oldest}`, exact: true })
    .click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('61 selected')
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Move 61 photos to Trash?')
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: `Select ${oldest}`, exact: true })
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('selection-count')).toHaveText('60 selected')
  await isolateTrash(app)
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.irodori.listPhotos())).total)
    .toBe(1)
  await expect(page.getByTestId('preview-filename')).toHaveText(oldest)
  await expect(page.getByRole('button', { name: `Select ${oldest}`, exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: /pages/ })).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toHaveText('0 selected')
})
