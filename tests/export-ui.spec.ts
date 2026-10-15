import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { holdBrowseSelections, seedLargeBrowser } from './all-photos.helpers'
import { DEFAULT_BROWSE_QUERY } from '../src/shared/browse'

test('chooser reuses the destination, picker cancellation changes no preferences and retained results show counts', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  const chooser = page.getByRole('dialog', { name: 'Export JPEG', exact: true })
  await expect(chooser).toContainText('1 photo · 0 HDR · 1 SDR')
  await expect(chooser.getByRole('button', { name: /Last custom/ })).toBeDisabled()
  await chooser.getByRole('button', { name: /High quality/ }).click()
  await expect(chooser).toBeVisible()
  expect((await page.evaluate(() => window.luma.getExportPreferences())).destination).toBeNull()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  await chooser.getByRole('button', { name: 'Change folder…' }).click()
  await expect(chooser).toContainText(destination)
  await chooser.getByRole('button', { name: /High quality/ }).click()
  await expect(chooser).toHaveCount(0)
  await expect(page.getByTestId('task-details')).toContainText(
    '1 exported · 0 skipped · 0 failed',
    { timeout: 20000 },
  )
  await expect(page.getByRole('button', { name: 'Show in folder', exact: true })).toBeVisible()
  await expect.poll(() => readdir(destination)).toEqual(['alpine-lake.jpg'])
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('Remembered destination must avoid the picker.')
    }
  })
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await chooser.getByRole('button', { name: /Maximum quality/ }).click()
  await expect.poll(() => readdir(destination)).toEqual(['alpine-lake (2).jpg', 'alpine-lake.jpg'])
})

test('Custom is keyboard-accessible at minimum size, persists only on acceptance, and Last custom survives restart', async ({
  luma,
}) => {
  let { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((w) => w.setContentSize(1100, 700))
  await page.getByTestId('console-toggle').click()
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await page.getByRole('button', { name: /Custom…/ }).click()
  const custom = page.getByRole('dialog', { name: 'Custom JPEG export' })
  await expect(custom).toBeVisible()
  await custom.getByRole('combobox', { name: 'Output', exact: true }).selectOption('hdr')
  await expect(custom).toContainText('1 photo does not support HDR JPEG')
  await expect(custom.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
  await custom.getByRole('combobox', { name: 'Output', exact: true }).selectOption('sdr')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).fill('84')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).press('Escape')
  await expect(custom.getByRole('spinbutton', { name: 'JPEG quality value' })).toHaveValue('90')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).fill('84')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).press('Enter')
  await custom.getByRole('combobox', { name: 'Names', exact: true }).selectOption('sequence')
  await custom.getByLabel('Prefix', { exact: true }).fill('Trip-')
  await custom.getByRole('combobox', { name: 'Size', exact: true }).selectOption('longest')
  await custom.getByLabel('Longest edge (px)').fill('101')
  await custom.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await page.evaluate(() => window.luma.getExportPreferences())).lastCustom).toBeNull()
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await page.getByRole('button', { name: /Custom…/ }).click()
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).fill('83')
  await custom.getByRole('spinbutton', { name: 'JPEG quality value' }).press('Enter')
  await custom.getByRole('combobox', { name: 'Metadata', exact: true }).selectOption('none')
  await page.screenshot({ path: test.info().outputPath('export-custom-1100.png') })
  const box = await custom.boundingBox()
  expect(box!.height).toBeLessThanOrEqual(660)
  await custom.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(custom).toHaveCount(0)
  await expect.poll(() => readdir(destination)).toEqual(['alpine-lake.jpg'])
  ;({ app, page } = await luma.restart())
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('Unexpected picker after restart.')
    }
  })
  await page.getByRole('button', { name: 'Export photo', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('JPEG quality 83')
  await page.getByRole('button', { name: /Last custom/ }).click()
  await expect.poll(() => readdir(destination)).toHaveLength(2)
  expect((await page.evaluate(() => window.luma.getExportPreferences())).lastCustom).toMatchObject({
    quality: 83,
    metadata: 'none',
  })
})

test('header export awaits pending ranges and includes unloaded photos hidden by a later Library filter', async ({
  luma,
}) => {
  test.setTimeout(90000)
  await seedLargeBrowser(luma.app, luma.page, luma.userDataDir, 125)
  const { app, page } = await luma.restart()
  await page
    .getByRole('navigation', { name: 'Workspaces' })
    .getByRole('button', { name: 'Library', exact: true })
    .click()
  const references = await page.evaluate(
    (query) => window.luma.getBrowseSection(query, '2026-10-04'),
    DEFAULT_BROWSE_QUERY,
  )
  await page.getByTestId(`browse-photo-${references[0].id}`).click()
  const hold = await holdBrowseSelections(app)
  try {
    await page.getByTestId(`browse-photo-${references[2].id}`).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page.getByRole('checkbox', { name: 'Select 4 October 2026', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search photos' }).fill(references.at(-1)!.filename)
    await expect(page.getByTestId('browse-selection-count')).toContainText('1 matching')
    await page.getByRole('button', { name: 'Export photo', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[0].release())
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[1].release())
    await expect(page.getByRole('dialog')).toContainText('125 photos · 0 HDR · 125 SDR')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByTestId(`browse-photo-${references.at(-1)!.id}`).click({ button: 'right' })
    await expect(
      page.getByRole('menuitem', { name: 'Export this photo…', exact: true }),
    ).toBeVisible()
    await page.getByRole('menuitem', { name: 'Export this photo…', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('1 photo · 0 HDR · 1 SDR')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('editing MCP shares export validation, opaque destination grants and retained job results', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const destination = join(luma.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  const grant = await page.evaluate(() => window.luma.chooseExportDestination())
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  const client = new Client({ name: 'export-test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
  })
  try {
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).not.toBe(true)
      return result.structuredContent as Record<string, unknown>
    }
    expect(await call('luma_get_export_capabilities')).toMatchObject({
      format: 'jpeg',
      hdr: 'iso-21496-1',
    })
    const preparation = await call('luma_prepare_export', { ids: [id] })
    const rejected = await client.callTool({
      name: 'luma_start_export',
      arguments: {
        exportRequest: {
          preparationId: preparation.id,
          destinationId: '/arbitrary/path',
          action: 'high',
        },
      },
    })
    expect(rejected.isError).toBe(true)
    const result = await call('luma_start_export', {
      exportRequest: { preparationId: preparation.id, destinationId: grant!.id, action: 'high' },
    })
    await expect
      .poll(async () => (await call('luma_get_export_results', { taskId: result.taskId })).results)
      .toMatchObject([{ photoId: id, status: 'exported', outputName: 'alpine-lake.jpg' }])
    expect((await readFile(join(destination, 'alpine-lake.jpg'))).byteLength).toBeGreaterThan(100)
  } finally {
    await client.close()
    await transport.close()
  }
})
