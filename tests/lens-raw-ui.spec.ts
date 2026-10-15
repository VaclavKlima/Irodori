import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PREVIEW_VERSION } from '../src/main/full-previews'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('lens settings survive rapid changes, cache variants, restart and preserve native zoom', async ({
  luma,
}) => {
  test.setTimeout(90_000)
  let { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'])
  await page.getByRole('button', { name: 'Lens corrections', exact: true }).click()
  const id = await page.evaluate(async () => (await window.luma.listPhotos()).photos[0].id)
  const original = await readFile(
    join(luma.userDataDir, 'library', 'originals', id, 'original.arw'),
  )
  const initialUrl = await page.getByTestId('main-preview').getAttribute('data-src')
  await expect(page.getByRole('checkbox', { name: 'Distortion', exact: true })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Vignetting', exact: true })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Lateral chromatic aberration' })).toBeChecked()
  await page.getByRole('combobox', { name: 'Preview zoom' }).selectOption('1')
  const held = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('lens:update')!
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('lens:update')
    ipcMain.handle('lens:update', async (...args) => {
      await wait
      return original(...args)
    })
    return { release }
  })
  await page.getByRole('checkbox', { name: 'Distortion', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Lens corrections', exact: true }).click()
  await expect(page.getByTestId('lens-corrections')).toBeHidden()
  await held.evaluate((gate) => gate.release())
  await held.dispose()
  await expect(page.getByTestId('lens-corrections')).toHaveAttribute('data-revision', '1')
  await page.getByRole('button', { name: 'Lens corrections', exact: true }).click()
  await expect(page.getByTestId('main-preview')).not.toHaveAttribute('data-src', initialUrl!)
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toHaveValue('1')
  await page.getByRole('checkbox', { name: 'Distortion', exact: true }).check()
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-src', initialUrl!)
  const result = await page.evaluate(async (id) => {
    await Promise.all([
      window.luma.updateLensSettings(id, 'vignetting', false),
      window.luma.updateLensSettings(id, 'chromaticAberration', false),
      window.luma.updateLensSettings(id, 'vignetting', true),
    ])
    return window.luma.getLensSettings(id)
  }, id)
  expect(result.revision).toBe(5)
  expect(result.settings).toEqual({
    distortion: true,
    vignetting: true,
    chromaticAberration: false,
  })
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  const response = await page.evaluate(async (id) => {
    const token = crypto.randomUUID()
    try {
      return await window.luma.requestHdrPreview(id, token)
    } finally {
      await window.luma.releaseFullPreview(token)
    }
  }, id)
  expect(response).not.toBeNull()
  expect(response!.format).toBe('hdr-working')
  expect(response!.settingsRevision).toBe(5)
  expect(response!.appliedCorrections).toEqual(result.settings)
  expect(
    await readdir(join(luma.userDataDir, 'library', 'cache', 'previews', PREVIEW_VERSION)),
  ).toHaveLength(3)
  ;({ app, page } = await luma.restart())
  await expect(page.getByRole('button', { name: 'Lens corrections', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.getByRole('button', { name: 'Lens corrections', exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: 'Lateral chromatic aberration' }),
  ).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Vignetting', exact: true })).toBeChecked()
  expect(await page.evaluate((id) => window.luma.getLensSettings(id), id)).toEqual(result)
  expect(
    await readFile(join(luma.userDataDir, 'library', 'originals', id, 'original.arw')),
  ).toEqual(original)
  await page.getByTestId('console-toggle').click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 700),
  )
  await page.getByRole('checkbox', { name: 'Distortion', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('checkbox', { name: 'Distortion', exact: true })).toBeInViewport()
})
