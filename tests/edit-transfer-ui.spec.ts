import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import type { EditClipboard, EditPastePreparation } from '../src/shared/edit-transfer'

test('copy/paste uses the complete Library selection, accessible group choices and the same frozen MCP/history contract after restart', async ({
  irodori,
}, info) => {
  test.setTimeout(60000)
  const { app } = irodori
  let { page } = irodori
  const paths: string[] = [],
    bytes: Buffer[] = []
  for (let index = 0; index < 3; index++) {
    const path = info.outputPath(`transfer-${index}.png`)
    await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 70 + index * 20, g: 100, b: 150 },
      },
    })
      .png()
      .toFile(path)
    paths.push(path)
    bytes.push(await readFile(path))
  }
  await importPhotos(app, page, paths, true, 'keyboard')
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos.sort((a, b) =>
    a.filename.localeCompare(b.filename),
  )
  const source = photos[0],
    destination = photos[1]
  await activateButton(page.getByTestId(`photo-card-${source.id}`))
  const field = page.getByRole('spinbutton', { name: 'Exposure value', exact: true })
  await expect(field).toBeEnabled()
  await activateButton(page.getByRole('button', { name: 'Crop photo', exact: true }))
  await expect(page.getByRole('button', { name: 'Cancel crop', exact: true })).toBeVisible()
  await expect(page.evaluate((id) => window.irodori.copyEdits(id), source.id)).rejects.toThrow(
    'Finish or cancel the crop',
  )
  await activateButton(page.getByRole('button', { name: 'Cancel crop', exact: true }))
  await field.fill('1.5')
  // Opening Actions flushes the in-progress numeric change through the normal editor owner.
  await activateButton(page.getByRole('button', { name: 'Actions', exact: true }))
  await activateButton(page.getByRole('menuitem', { name: 'Copy edits', exact: true }))
  await expect(page.getByRole('menu')).toHaveCount(0)
  const clipboard = await page.evaluate(() => window.irodori.getEditClipboard())
  expect(clipboard).toMatchObject({ photoId: source.id, revision: 1 })
  expect(
    (await page.evaluate((id) => window.irodori.getEdits(id), source.id)).settings.exposureEv,
  ).toBe(1.5)
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Clear selection', exact: true }))
  const grid = page.getByTestId('browse-grid')
  await grid.focus()
  await grid.press('Home')
  await grid.press('Space')
  await grid.press('ArrowRight')
  await grid.press('Space')
  await grid.press('ArrowRight')
  await grid.press('Space')
  await expect(page.getByTestId('browse-selection-count')).toContainText('3 selected')
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await activateButton(page.getByTestId('console-toggle'))
  async function openPaste() {
    await activateButton(page.getByRole('button', { name: 'Actions', exact: true }))
    await activateButton(
      page.getByRole('menuitem', { name: 'Paste edits to 3 selected photos…', exact: true }),
    )
    const dialog = page.getByRole('dialog', { name: 'Paste edits', exact: true })
    await expect(dialog).toContainText('3 ready · 0 unavailable')
    return dialog
  }
  let dialog = await openPaste()
  for (const label of [
    'Light',
    'Saturation and vibrance',
    'Color mixer',
    'Color grading',
    'Noise reduction',
    'Detail sharpening',
  ])
    await expect(dialog.getByRole('checkbox', { name: label, exact: true })).toBeChecked()
  for (const label of ['Crop and straighten', 'White balance', 'Lens corrections'])
    await expect(dialog.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'White balance', exact: true })).toBeDisabled()
  await expect(
    dialog.getByRole('checkbox', { name: 'Lens corrections', exact: true }),
  ).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Light', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(dialog).toContainText('3 ready · 0 unavailable')
  await expect(dialog.getByRole('checkbox', { name: 'Light', exact: true })).not.toBeChecked()
  const box = (await dialog.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(700)
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  )
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect((await page.evaluate((id) => window.irodori.getEdits(id), destination.id)).revision).toBe(
    0,
  )
  dialog = await openPaste()
  await expect(dialog.getByRole('checkbox', { name: 'Light', exact: true })).toBeChecked()
  await activateButton(dialog.getByRole('button', { name: 'Apply edits', exact: true }))
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.irodori.listTasks()))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'edit-application',
          status: 'completed',
          editApplication: { applied: 2, unchanged: 1, conflict: 0, unavailable: 0, failed: 0 },
        }),
      ]),
    )
  const uiTask = (await page.evaluate(() => window.irodori.listTasks())).find(
    (task) => task.kind === 'edit-application',
  )!
  expect(
    (await page.evaluate((id) => window.irodori.getEditHistory(id), destination.id)).snapshots,
  ).toHaveLength(2)
  await activateButton(page.getByRole('button', { name: 'Editor', exact: true }))
  await activateButton(page.getByTestId(`photo-card-${destination.id}`))
  await expect(field).toHaveValue('1.50')
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect(field).toHaveValue('0.00')
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect(field).toHaveValue('1.50')

  const client = new Client({ name: 'edit-transfer-test', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    })
  try {
    await client.connect(transport)
    const copied = await client.callTool({
      name: 'irodori_copy_edits',
      arguments: { photoId: source.id },
    })
    expect(copied.isError).not.toBe(true)
    const c = copied.structuredContent as unknown as EditClipboard
    let target = await page.evaluate((id) => window.irodori.getEdits(id), destination.id)
    await page.evaluate(
      ({ id, revision }) => window.irodori.updateEdits(id, { exposureEv: -1 }, revision),
      { id: destination.id, revision: target.revision },
    )
    const prepared = await client.callTool({
      name: 'irodori_prepare_paste_edits',
      arguments: {
        pasteRequest: { clipboardId: c.id, photoIds: [destination.id], groups: ['light'] },
      },
    })
    expect(prepared.isError).not.toBe(true)
    const sourceState = await page.evaluate((id) => window.irodori.getEdits(id), source.id)
    await page.evaluate(
      ({ id, revision }) => window.irodori.updateEdits(id, { exposureEv: 2.5 }, revision),
      { id: source.id, revision: sourceState.revision },
    )
    const started = await client.callTool({
      name: 'irodori_start_paste_edits',
      arguments: {
        preparationId: (prepared.structuredContent as unknown as EditPastePreparation).id,
      },
    })
    expect(started.isError).not.toBe(true)
    const taskId = (started.structuredContent as { taskId: string }).taskId
    await expect
      .poll(
        async () =>
          (
            await client.callTool({
              name: 'irodori_get_edit_application_results',
              arguments: { taskId },
            })
          ).structuredContent,
      )
      .toMatchObject({ results: [expect.objectContaining({ outcome: 'applied' })], total: 1 })
    target = await page.evaluate((id) => window.irodori.getEdits(id), destination.id)
    expect(target.settings.exposureEv).toBe(1.5)
  } finally {
    await client.close()
  }
  ;({ page } = await irodori.restart())
  expect(await page.evaluate(() => window.irodori.getEditClipboard())).toBeNull()
  expect(
    (await page.evaluate((id) => window.irodori.getEdits(id), destination.id)).settings.exposureEv,
  ).toBe(1.5)
  expect(
    (await page.evaluate((id) => window.irodori.getEditApplicationResults(id), uiTask.id)).results,
  ).toHaveLength(3)
  for (const [index, photo] of photos.entries())
    expect(
      await readFile(join(irodori.userDataDir, 'library', 'originals', photo.id, 'original.png')),
    ).toEqual(bytes[index])
})
