import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { identityCrop } from '../src/shared/crop'
import { defaultExportOptions, type ExportPreparation } from '../src/shared/export'

test('Custom enlargement is keyboard-accessible, crop-aware and shared with MCP while legacy sizes and quick presets stay unchanged', async ({
  irodori,
}) => {
  test.setTimeout(60000)
  const { app } = irodori
  let { page } = irodori
  const source = test.info().outputPath('portrait.png'),
    original = await sharp({
      create: { width: 17, height: 11, channels: 3, background: { r: 80, g: 120, b: 160 } },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer()
  await sharp(original).withMetadata({ orientation: 6 }).toFile(source)
  const originalBytes = await readFile(source)
  await importPhotos(app, page, [source], true, 'keyboard')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    context = await page.evaluate((id) => window.irodori.getCropContext(id, 0), id)
  expect(context.source).toEqual({ width: 11, height: 17 })
  await page.evaluate(({ id, crop }) => window.irodori.updateEdits(id, { crop }, 0), {
    id,
    crop: { ...identityCrop, width: 9 / 11, height: 15 / 17 },
  })
  const before = await page.evaluate((id) => window.irodori.getEditHistory(id), id),
    destination = join(irodori.userDataDir, 'exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await activateButton(page.getByTestId('console-toggle'))
  async function custom() {
    await activateButton(page.getByRole('button', { name: 'Export photo', exact: true }))
    await activateButton(page.getByRole('button', { name: /Custom…/ }))
    return page.getByRole('dialog', { name: 'Custom JPEG export' })
  }
  let dialog = await custom()
  await dialog.getByRole('combobox', { name: 'Size', exact: true }).selectOption('longest')
  await dialog.getByLabel('Longest edge (px)').fill('30')
  const enlargement = dialog.getByRole('checkbox', { name: 'Allow enlargement', exact: true })
  await expect(enlargement).not.toBeChecked()
  await enlargement.focus()
  await enlargement.press('Space')
  await dialog.getByLabel('Longest edge (px)').fill('32')
  await expect(enlargement).toBeChecked()
  await dialog.getByRole('combobox', { name: 'Size', exact: true }).selectOption('fit')
  await expect(enlargement).toBeChecked()
  await dialog.getByLabel('Width (px)', { exact: true }).fill('20')
  await dialog.getByLabel('Height (px)', { exact: true }).fill('30')
  await expect(dialog).toContainText('Lanczos3')
  await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  expect((await page.evaluate(() => window.irodori.getExportPreferences())).lastCustom).toBeNull()
  dialog = await custom()
  await expect(dialog.getByRole('combobox', { name: 'Size', exact: true })).toHaveValue('original')
  await expect(dialog.getByRole('checkbox', { name: 'Allow enlargement' })).toHaveCount(0)
  await dialog.getByRole('combobox', { name: 'Size', exact: true }).selectOption('longest')
  await dialog.getByLabel('Longest edge (px)').fill('30')
  await dialog.getByRole('checkbox', { name: 'Allow enlargement' }).focus()
  await dialog.getByRole('checkbox', { name: 'Allow enlargement' }).press('Space')
  await dialog.getByLabel('Optional suffix', { exact: true }).fill('-enlarged')
  await dialog.getByRole('combobox', { name: 'Metadata', exact: true }).selectOption('none')
  await enlargement.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  const checkbox = (await enlargement.boundingBox())!,
    bounds = (await dialog.boundingBox())!
  expect(bounds.height).toBeLessThanOrEqual(660)
  expect(checkbox.y).toBeGreaterThan(bounds.y)
  expect(checkbox.y + checkbox.height).toBeLessThan(bounds.y + bounds.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await activateButton(dialog.getByRole('button', { name: 'Export', exact: true }))
  await expect(dialog).toHaveCount(0)
  async function finished() {
    await expect
      .poll(() => page.evaluate(() => window.irodori.listTasks()))
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'export', status: 'completed' })]),
      )
    const tasks = await page.evaluate(() => window.irodori.listTasks())
    expect(
      tasks.filter((task) => task.kind === 'export').every((task) => task.status === 'completed'),
    ).toBe(true)
  }
  await finished()
  const preferences = await page.evaluate(() => window.irodori.getExportPreferences())
  expect(preferences.lastCustom!.size).toEqual({
    mode: 'longest',
    edge: 30,
    method: 'lanczos3',
    allowEnlargement: true,
  })
  expect(await sharp(join(destination, 'portrait-enlarged.jpg')).metadata()).toMatchObject({
    width: 18,
    height: 30,
  })
  ;({ page } = await irodori.restart())
  expect(await page.evaluate(() => window.irodori.getExportPreferences())).toEqual(preferences)
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    }),
    client = new Client({ name: 'enlargement-test', version: '1' })
  try {
    await client.connect(transport)
    const caps = await client.callTool({ name: 'irodori_get_export_capabilities', arguments: {} })
    expect(caps.isError).not.toBe(true)
    expect(caps.structuredContent).toMatchObject({
      resize: { methods: ['lanczos3'], defaultAllowEnlargement: false },
    })
    for (const action of ['last-custom', 'custom', 'high'] as const) {
      const prepared = await client.callTool({
        name: 'irodori_prepare_export',
        arguments: { ids: [id] },
      })
      expect(prepared.isError).not.toBe(true)
      const result = await client.callTool({
        name: 'irodori_start_export',
        arguments: {
          exportRequest: {
            preparationId: (prepared.structuredContent as unknown as ExportPreparation).id,
            destinationId: preferences.destination!.id,
            action,
            ...(action === 'custom'
              ? {
                  options: {
                    ...defaultExportOptions,
                    metadata: 'none',
                    size: { mode: 'longest', edge: 30 },
                    names: { mode: 'original', suffix: '-legacy' },
                  },
                }
              : {}),
          },
        },
      })
      expect(result.isError).not.toBe(true)
      const taskId = (result.structuredContent as { taskId: string }).taskId
      await expect
        .poll(() =>
          page.evaluate(
            async (id) => (await window.irodori.listTasks()).find((task) => task.id === id)?.status,
            taskId,
          ),
        )
        .toBe('completed')
    }
    expect(await sharp(join(destination, 'portrait-enlarged (2).jpg')).metadata()).toMatchObject({
      width: 18,
      height: 30,
    })
    for (const name of ['portrait-legacy.jpg', 'portrait.jpg'])
      expect(await sharp(join(destination, name)).metadata()).toMatchObject({
        width: 9,
        height: 15,
      })
    expect(
      (await page.evaluate(() => window.irodori.getExportPreferences())).lastCustom!.size,
    ).toEqual({ mode: 'longest', edge: 30 })
    dialog = await custom()
    await expect(dialog.getByRole('checkbox', { name: 'Allow enlargement' })).not.toBeChecked()
    await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(before)
    expect(await readFile(source)).toEqual(originalBytes)
    expect(
      await readFile(join(irodori.userDataDir, 'library', 'originals', id, 'original.png')),
    ).toEqual(originalBytes)
  } finally {
    await client.close()
    await transport.close()
  }
})
