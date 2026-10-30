import { revealEditorPhoto } from './collection-ui.helpers'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'

const sources = [
  'alpine-lake',
  'mountain-ridge',
  'forest-light',
  'coastal-dunes',
  'quiet-valley',
].map((n) => `tests/fixtures/photos/${n}.jpg`)

test('separate keyboard expansion preserves active photo and selection; organization persists at minimum console size', async ({
  irodori,
}, info) => {
  const { app, page } = irodori
  await importPhotos(app, page, sources)
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const card = (i: number) => page.getByTestId(`photo-card-${photos[i].id}`)
  await card(0).click()
  await card(2).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Group selected photos', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(page.getByText('2 selected in collapsed stacks', { exact: true })).toBeVisible()
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[2].filename)
  expect((await page.evaluate(() => window.irodori.listGallery())).total).toBe(3)
  const expand = page.getByRole('button', {
    name: `Expand stack for ${photos[2].filename}, 3 photos`,
    exact: true,
  })
  await expand.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('button', { name: `Collapse stack for ${photos[2].filename}, 3 photos` }),
  ).toBeFocused()
  await card(0).click()
  await page
    .getByRole('button', { name: `Collapse stack for ${photos[2].filename}, 3 photos` })
    .click()
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
  await expect(page.getByText('1 selected in collapsed stacks', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Next photo', exact: true }).click()
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[3].filename)
  await card(2).click()
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await expand.click()
  await card(0).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Set this photo as group cover', exact: true }).click()
  await expect(
    page.getByRole('button', { name: `Collapse stack for ${photos[0].filename}, 3 photos` }),
  ).toBeVisible()
  await page.getByTestId('console-toggle').click()
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await card(1).click({ button: 'right' })
  const menu = page.getByRole('menu')
  const bounds = await menu.boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700)
  await page.screenshot({ path: info.outputPath('stacks-minimum-console.png') })
  await page.getByRole('menuitem', { name: 'Remove this photo from group', exact: true }).click()
  expect((await page.evaluate(() => window.irodori.listStacks())).stacks[0].count).toBe(2)
  expect((await page.evaluate((id) => window.irodori.getEdits(id), photos[0].id)).revision).toBe(0)
  const restarted = await irodori.restart()
  await expect(
    restarted.page.getByRole('button', {
      name: `Collapse stack for ${photos[0].filename}, 2 photos`,
    }),
  ).toBeVisible()
  await restarted.page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
  await restarted.page.getByRole('menuitem', { name: 'Ungroup photos', exact: true }).click()
  await expect
    .poll(
      async () => (await restarted.page.evaluate(() => window.irodori.listStacks())).stacks.length,
    )
    .toBe(0)
  expect((await restarted.page.evaluate(() => window.irodori.listPhotos())).total).toBe(5)
})

test('Continuous scrolling keeps expanded members contiguous, hidden anchors map to covers, and deletion awaits a pending range', async ({
  irodori,
}) => {
  test.setTimeout(90000)
  const { app, page } = irodori
  const directory = join(irodori.userDataDir, 'sources')
  await mkdir(directory)
  const paths: string[] = []
  for (let i = 0; i < 63; i++) {
    const path = join(directory, `photo-${String(i).padStart(2, '0')}.png`)
    await writeFile(
      path,
      await sharp({
        create: { width: 16, height: 12, channels: 3, background: { r: i * 3, g: 20, b: 50 } },
      })
        .png()
        .toBuffer(),
    )
    paths.push(path)
  }
  await importPhotos(app, page, paths)
  const flat = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const rest = (await page.evaluate(() => window.irodori.listPhotos(60))).photos
  const ids = [flat[59].id, rest[0].id, rest[1].id]
  await page.evaluate(async (ids) => {
    const { revision } = await window.irodori.listStacks()
    const stack = await window.irodori.groupPhotos(ids, ids[0], revision)
    await window.irodori.setStackExpanded(stack.id, true, stack.revision)
  }, ids)
  await revealEditorPhoto(page, flat[59].id)
  await expect(
    page.getByRole('button', { name: `Collapse stack for ${flat[59].filename}, 3 photos` }),
  ).toBeVisible()
  await revealEditorPhoto(page, rest[1].id)
  await expect(page.getByTestId(`photo-card-${rest[1].id}`).locator('..')).toHaveAttribute(
    'data-stack-id',
  )
  const second = await page.evaluate(() => window.irodori.listGallery(60))
  expect(second.entries.slice(0, 2).map((e) => e.photo.id)).toEqual([rest[1].id, rest[0].id])
  await page.getByTestId(`photo-card-${rest[1].id}`).click()
  await page.evaluate(async () => {
    const stack = (await window.irodori.listStacks()).stacks[0]
    await window.irodori.setStackExpanded(stack.id, false, stack.revision)
  })
  await expect(page.getByText('1 selected in collapsed stacks', { exact: true })).toBeVisible()
  await revealEditorPhoto(page, rest[2].id)
  await page.getByTestId(`photo-card-${rest[2].id}`).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('4 selected')
  await revealEditorPhoto(page, flat[0].id)
  await page.getByTestId(`photo-card-${flat[0].id}`).click()
  const hold = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('gallery:range')!
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('gallery:range')
    ipcMain.handle('gallery:range', async (...args) => {
      await wait
      return original(...args)
    })
    return { release }
  })
  await revealEditorPhoto(page, rest[2].id)
  await page.getByTestId(`photo-card-${rest[2].id}`).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await hold.evaluate((h) => h.release())
  await expect(page.getByRole('dialog')).toContainText('Move 63 photos to Trash?')
  await page.keyboard.press('Escape')
  expect((await page.evaluate(() => window.irodori.listPhotos())).total).toBe(63)
})

test('Select group names hidden targets; cover deletion deletes only the explicitly selected cover', async ({
  irodori,
}) => {
  const { app, page } = irodori
  await importPhotos(app, page, sources.slice(0, 3))
  await isolateTrash(app)
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const ids = photos.map((p) => p.id)
  await page.evaluate(async (ids) => {
    await window.irodori.groupPhotos(ids, ids[0], (await window.irodori.listStacks()).revision)
  }, ids)
  await page.getByTestId(`photo-card-${ids[0]}`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Select entire group', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  const hidden = page.getByText('2 selected in collapsed stacks', { exact: true })
  await hidden.click()
  await expect(page.getByRole('listitem').filter({ hasText: photos[1].filename })).toBeVisible()
  await page.getByTestId(`photo-card-${ids[0]}`).click()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Move photo to Trash?')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.irodori.listPhotos())).total)
    .toBe(2)
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[2].filename)
  expect((await page.evaluate(() => window.irodori.listStacks())).stacks[0]).toMatchObject({
    count: 2,
    coverId: ids[2],
  })
})

test('editing MCP uses the same revision-checked stack and gallery service as UI', async ({
  irodori,
}) => {
  await importPhotos(irodori.app, irodori.page, sources.slice(0, 3))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
  })
  const client = new Client({ name: 'irodori-stack-test', version: '1' })
  try {
    await client.connect(transport)
    const call = async (name: string, args = {}) => {
      const r = await client.callTool({ name, arguments: args })
      expect(r.isError).not.toBe(true)
      return r.structuredContent as Record<string, unknown>
    }
    const ids = (await irodori.page.evaluate(() => window.irodori.listPhotos())).photos.map(
      (p) => p.id,
    )
    const overview = await call('irodori_list_stacks')
    const stack = await call('irodori_group_photos', {
      ids,
      coverId: ids[0],
      expectedRevision: overview.revision,
    })
    expect(await call('irodori_list_gallery')).toMatchObject({ total: 1, storedTotal: 3 })
    expect(await call('irodori_get_photo_stack', { photoId: ids[1] })).toMatchObject({
      stack: { id: stack.id },
    })
    expect(
      (
        await client.callTool({
          name: 'irodori_set_stack_cover',
          arguments: { stackId: stack.id, photoId: ids[1] },
        })
      ).isError,
    ).toBe(true)
    const expanded = await call('irodori_set_stack_expanded', {
      stackId: stack.id,
      expanded: true,
      expectedRevision: stack.revision,
    })
    expect(await call('irodori_get_stack_members', { stackId: stack.id })).toMatchObject({
      total: 3,
    })
    expect(await call('irodori_locate_gallery_photo', { photoId: ids[1] })).toMatchObject({
      location: { photo: { id: ids[1] } },
    })
    const cover = await call('irodori_set_stack_cover', {
      stackId: stack.id,
      photoId: ids[1],
      expectedRevision: expanded.revision,
    })
    const removed = await call('irodori_remove_from_stack', {
      photoId: ids[2],
      expectedRevision: cover.revision,
    })
    const summary = removed.stack as { revision: number }
    await call('irodori_ungroup_stack', { stackId: stack.id, expectedRevision: summary.revision })
    await call('irodori_group_capture_sequences')
    await expect(irodori.page.getByTestId('task-progress')).toContainText(
      'Capture grouping complete',
    )
    expect(await call('irodori_list_stacks')).toMatchObject({ stacks: [] })
  } finally {
    await client.close()
    await transport.close()
  }
})
