import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const sources = [
  'alpine-lake',
  'mountain-ridge',
  'forest-light',
  'coastal-dunes',
  'quiet-valley',
].map((name) => `tests/fixtures/photos/${name}.jpg`)

async function numberedSources(root: string, count: number) {
  const directory = join(root, 'range-sources')
  await mkdir(directory, { recursive: true })
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    const path = join(directory, `range-photo-${String(i).padStart(3, '0')}.png`)
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
  return paths
}

async function allPhotos(page: Page) {
  const first = await page.evaluate(() => window.luma.listPhotos())
  const rest =
    first.total > 60 ? (await page.evaluate(() => window.luma.listPhotos(60))).photos : []
  return [...first.photos, ...rest]
}

async function group(page: Page, ids: string[], expanded = false) {
  return page.evaluate(
    async ({ ids, expanded }) => {
      const stack = await window.luma.groupPhotos(
        ids,
        ids[0],
        (await window.luma.listStacks()).revision,
      )
      return expanded ? window.luma.setStackExpanded(stack.id, true, stack.revision) : stack
    },
    { ids, expanded },
  )
}

async function holdRanges(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => unknown>
      }
    )._invokeHandlers
    const original = handlers.get('gallery:range')!
    const calls: { from: string; to: string; resolve: () => void; reject: () => void }[] = []
    const expectedErrors: string[] = []
    const originalError = console.error
    console.error = (...args) => {
      if (
        args[0] === "Error occurred in handler for 'gallery:range':" &&
        args[1] instanceof Error &&
        args[1].message === 'Range resolution failed.'
      ) {
        expectedErrors.push(args[1].message)
        return
      }
      originalError(...args)
    }
    ipcMain.removeHandler('gallery:range')
    ipcMain.handle('gallery:range', async (...args) => {
      const result = await original(...args)
      return new Promise((resolve, reject) => {
        calls.push({
          from: args[1],
          to: args[2],
          resolve: () => resolve(result),
          reject: () => reject(new Error('Range resolution failed.')),
        })
      })
    })
    return {
      calls,
      expectedErrors,
      restore: () => {
        for (const call of calls) call.resolve()
        ipcMain.removeHandler('gallery:range')
        ipcMain.handle('gallery:range', original)
        console.error = originalError
      },
    }
  })
}

function targetList(page: Page) {
  return page
    .getByRole('dialog')
    .getByRole('list', { name: 'Photos to move to Trash', exact: true })
}
async function targetNames(page: Page) {
  return targetList(page).getByRole('listitem').allTextContents()
}

test('ordinary clicks stay individual; cover ranges, additive ranges, deselection and hidden anchors retain the clicked active photo', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const photos = await allPhotos(page)
  const members = photos.slice(1, 4)
  const stack = await group(
    page,
    members.map((p) => p.id),
  )
  const card = (id: string) => page.getByTestId(`photo-card-${id}`)
  await card(stack.coverId).click()
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await card(stack.coverId).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await card(photos[4].id).click({ modifiers: ['ControlOrMeta'] })
  await card(photos[0].id).click({ modifiers: ['ControlOrMeta', 'Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('5 selected')
  await page
    .getByRole('button', { name: `Expand stack for ${members[0].filename}, 3 photos` })
    .click()
  await card(members[1].id).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('selection-count')).toHaveText('4 selected')
  await expect(card(members[1].id)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('preview-filename')).toHaveText(members[1].filename)
  const ordered = (await page.evaluate((id) => window.luma.getStackMembers(id), stack.id)).photos
  await card(ordered[1].id).click()
  await card(ordered[2].id).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await expect(card(stack.coverId)).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Delete')
  await expect.poll(() => targetNames(page)).toEqual(ordered.slice(1).map((p) => p.filename))
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: `Collapse stack for ${members[0].filename}, 3 photos` })
    .click()
  await card(photos[4].id).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('4 selected')
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[4].filename)
  await page.keyboard.press('Delete')
  await expect.poll(() => targetNames(page)).toEqual([...ordered, photos[4]].map((p) => p.filename))
  await page.keyboard.press('Escape')
})

test('paging and a real import preserve two delayed ranges and a queued toggle; immediate Delete waits for every action', async ({
  luma,
}) => {
  test.setTimeout(90000)
  const { app, page } = luma
  const paths = await numberedSources(luma.userDataDir, 70)
  await importPhotos(app, page, paths.slice(0, 69))
  const photos = await allPhotos(page)
  const ids = photos.slice(0, 65).map((p) => p.id)
  const stack = await group(page, ids, true)
  const ordered = [
    ...(await page.evaluate((id) => window.luma.getStackMembers(id), stack.id)).photos,
    ...(await page.evaluate((id) => window.luma.getStackMembers(id, 60), stack.id)).photos,
  ]
  const card = (id: string) => page.getByTestId(`photo-card-${id}`)
  await card(stack.coverId).click()
  const hold = await holdRanges(app)
  try {
    await card(ordered[58].id).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page
      .getByRole('navigation', { name: 'Library pages' })
      .getByRole('button', { name: 'Next', exact: true })
      .click()
    await importPhotos(app, page, paths.slice(69))
    await expect
      .poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total)
      .toBe(70)
    await expect(page.getByRole('navigation', { name: 'Library pages' })).toContainText('2 / 2')
    const last = ordered.at(-1)!
    await card(last.id).click({ modifiers: ['Shift'] })
    await card(last.id).click({ modifiers: ['ControlOrMeta'] })
    await page.keyboard.press('Delete')
    expect(await hold.evaluate((h) => h.calls.length)).toBe(1)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[1].resolve())
    await expect(page.getByRole('dialog')).toContainText('Move 64 photos to Trash?')
    await expect.poll(() => targetNames(page)).toEqual(ordered.slice(0, -1).map((p) => p.filename))
    await expect(page.getByTestId('preview-filename')).toHaveText(last.filename)
    await expect(page.getByTestId('selection-count')).toHaveText('64 selected')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('navigation', { name: 'Library pages' })).toContainText('2 / 2')
    expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(70)
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('successive ranges and a plain click run in arrival order and replace the anchor before context-menu deletion', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const photos = await allPhotos(page)
  const card = (i: number) => page.getByTestId(`photo-card-${photos[i].id}`)
  await card(0).click()
  const hold = await holdRanges(app)
  try {
    await card(3).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await card(1).click()
    await card(2).click({ modifiers: ['Shift'] })
    await card(4).click({ modifiers: ['ControlOrMeta'] })
    await card(1).click({ button: 'right' })
    await expect(page.getByRole('menu')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    expect(await hold.evaluate((h) => ({ from: h.calls[1].from, to: h.calls[1].to }))).toEqual({
      from: photos[1].id,
      to: photos[2].id,
    })
    await hold.evaluate((h) => h.calls[1].resolve())
    await page.getByRole('menuitem', { name: 'Move 3 selected photos to Trash…' }).click()
    await expect
      .poll(() => targetNames(page))
      .toEqual([photos[1], photos[2], photos[4]].map((p) => p.filename))
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
    await page.keyboard.press('Escape')
    await expect(card(1)).toBeFocused()
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('navigation queued after a delayed range selects the next photo before deletion can freeze targets', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const photos = await allPhotos(page)
  const stack = await group(
    page,
    photos.slice(0, 3).map((p) => p.id),
  )
  await page.getByTestId(`photo-card-${stack.coverId}`).click()
  const hold = await holdRanges(app)
  try {
    await page.getByTestId(`photo-card-${photos[3].id}`).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page.getByRole('button', { name: 'Next photo', exact: true }).click()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect(page.getByRole('dialog')).toContainText('Move photo to Trash?')
    await expect.poll(() => targetNames(page)).toEqual([photos[4].filename])
    await expect(page.getByTestId('preview-filename')).toHaveText(photos[4].filename)
    await page.keyboard.press('Escape')
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('ordinary cover and expanded-member deletion Trash only the clicked photo and repair the surviving stack', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const trash = await isolateTrash(app)
  const photos = await allPhotos(page)
  const stack = await group(
    page,
    photos.slice(0, 3).map((p) => p.id),
    true,
  )
  for (const photo of [photos[1], photos[0]]) {
    await page.getByTestId(`photo-card-${photo.id}`).click()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toContainText('Move photo to Trash?')
    await expect.poll(() => targetNames(page)).toEqual([photo.filename])
    await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.luma.listPhotos())).photos.some((p) => p.id === photo.id),
      )
      .toBe(false)
    if (photo.id === photos[1].id) {
      expect((await page.evaluate(() => window.luma.listStacks())).stacks[0]).toMatchObject({
        id: stack.id,
        count: 2,
        coverId: photos[0].id,
      })
    }
  }
  expect((await readdir(trash)).map((name) => name.slice(0, 64)).sort()).toEqual(
    [photos[0].id, photos[1].id].sort(),
  )
  expect((await page.evaluate(() => window.luma.listStacks())).stacks).toEqual([])
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(3)
  for (const path of sources) expect((await readFile(path)).length).toBeGreaterThan(0)
})

test('a failed range blocks deletion until a later selection succeeds, including while that selection is pending', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const photos = await allPhotos(page)
  const card = (i: number) => page.getByTestId(`photo-card-${photos[i].id}`)
  await card(0).click()
  const hold = await holdRanges(app)
  try {
    await card(2).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page.keyboard.press('Delete')
    await hold.evaluate((h) => h.calls[0].reject())
    await expect(page.getByRole('alert')).toContainText('Range resolution failed.')
    expect(await hold.evaluate((h) => h.expectedErrors)).toEqual(['Range resolution failed.'])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
    await card(1).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await hold.evaluate((h) => h.calls[1].resolve())
    await expect(page.getByRole('dialog')).toContainText('Move 2 photos to Trash?')
    await expect.poll(() => targetNames(page)).toEqual(photos.slice(0, 2).map((p) => p.filename))
    await page.keyboard.press('Escape')
    await card(4).click()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toContainText('Move photo to Trash?')
    await expect.poll(() => targetNames(page)).toEqual([photos[4].filename])
    await page.keyboard.press('Escape')
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('a delayed catalog response cannot reselect deleted IDs; removing the anchor makes the next Shift-click individual', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  await isolateTrash(app)
  const photos = await allPhotos(page)
  const stack = await group(
    page,
    photos.slice(0, 3).map((p) => p.id),
  )
  const card = (id: string) => page.getByTestId(`photo-card-${id}`)
  await card(photos[4].id).click()
  const hold = await holdRanges(app)
  try {
    await card(stack.coverId).click({ modifiers: ['Shift'] })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page.keyboard.press('Delete')
    const task = await page.evaluate(
      (ids) => window.luma.deletePhotos(ids),
      [stack.coverId, photos[4].id],
    )
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.luma.listTasks())).find((t) => t.id === task)?.status,
      )
      .toBe('completed')
    await expect(page.getByTestId(`photo-card-${stack.coverId}`)).toHaveCount(0)
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect(page.getByRole('dialog')).toContainText('Move 3 photos to Trash?')
    expect((await targetNames(page)).sort()).toEqual(
      photos
        .slice(1, 4)
        .map((p) => p.filename)
        .sort(),
    )
    await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
    await page.keyboard.press('Escape')
    const survivingStack = (await page.evaluate(() => window.luma.listStacks())).stacks[0]
    await card(survivingStack.coverId).click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
    expect(await hold.evaluate((h) => h.calls.length)).toBe(1)
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('keyboard and context deletion disclose every filename at minimum console size and Trash exactly the frozen group', async ({
  luma,
}, info) => {
  test.setTimeout(90000)
  const { app, page } = luma
  const paths = await numberedSources(luma.userDataDir, 69)
  const originalBytes = await Promise.all(paths.map((path) => readFile(path)))
  await importPhotos(app, page, paths)
  const trash = await isolateTrash(app)
  const photos = await allPhotos(page)
  const ids = photos.slice(0, 65).map((p) => p.id)
  const stack = await group(page, ids)
  const expected = await page.evaluate(({ from, to }) => window.luma.getGalleryRange(from, to), {
    from: stack.coverId,
    to: stack.coverId,
  })
  const cover = page.getByTestId(`photo-card-${stack.coverId}`)
  await cover.click()
  await cover.click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('65 selected')
  await page.getByTestId('console-toggle').click()
  const native = await app.browserWindow(page)
  await native.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await cover.focus()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Move 65 photos to Trash?')
  await expect.poll(() => targetNames(page)).toEqual(expected.map((p) => p.filename))
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(targetList(page)).toBeFocused()
  await page.keyboard.press('End')
  await expect.poll(() => targetList(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const bounds = await page.getByRole('dialog').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700)
  expect(await targetList(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect(page.getByRole('button', { name: 'Move to Trash', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('complete-deletion-targets-minimum-console.png') })
  await page.keyboard.press('Escape')
  await expect(cover).toBeFocused()
  await cover.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move 65 selected photos to Trash…' }).click()
  await expect.poll(() => targetNames(page)).toEqual(expected.map((p) => p.filename))
  await page.evaluate(
    async ({ stack, ids, extra }) => {
      await window.luma.ungroupStack(stack.id, stack.revision)
      await window.luma.groupPhotos(
        [...ids, extra],
        stack.coverId,
        (await window.luma.listStacks()).revision,
      )
    },
    { stack, ids, extra: photos[65].id },
  )
  await expect(page.getByRole('dialog')).toContainText('Move 65 photos to Trash?')
  await expect.poll(() => targetNames(page)).toEqual(expected.map((p) => p.filename))
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(4)
  expect((await readdir(trash)).map((name) => name.slice(0, 64)).sort()).toEqual([...ids].sort())
  expect((await allPhotos(page)).map((p) => p.id).sort()).toEqual(
    photos
      .slice(65)
      .map((p) => p.id)
      .sort(),
  )
  for (const [index, path] of paths.entries())
    expect(await readFile(path)).toEqual(originalBytes[index])
  expect((await page.evaluate(() => window.luma.listStacks())).stacks).toEqual([])
  const restarted = await luma.restart()
  expect((await restarted.page.evaluate(() => window.luma.listPhotos())).total).toBe(4)
})

test('editing MCP and UI resolve the same complete and member-only ranges while flat enumeration stays separate', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const photos = await allPhotos(page)
  const stack = await group(
    page,
    photos.slice(1, 4).map((p) => p.id),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
  })
  const client = new Client({ name: 'luma-range-test', version: '1' })
  try {
    await client.connect(transport)
    expect(
      (await client.listTools()).tools.find((t) => t.name === 'luma_get_gallery_range')
        ?.description,
    ).toContain('all current stack members')
    for (const expanded of [false, true]) {
      if (expanded)
        await page.evaluate((s) => window.luma.setStackExpanded(s.id, true, s.revision), stack)
      const ordered = (await page.evaluate((id) => window.luma.getStackMembers(id), stack.id))
        .photos
      const pairs = [
        [stack.coverId, stack.coverId],
        [photos[0].id, photos[4].id],
        [ordered[1].id, ordered[2].id],
      ]
      for (const [fromId, toId] of pairs) {
        const response = await client.callTool({
          name: 'luma_get_gallery_range',
          arguments: { fromId, toId },
        })
        expect(response.isError).not.toBe(true)
        const ui = await page.evaluate(
          ({ fromId, toId }) => window.luma.getGalleryRange(fromId, toId),
          { fromId, toId },
        )
        expect(response.structuredContent).toEqual({ photos: ui })
      }
      await page.getByTestId(`photo-card-${stack.coverId}`).click()
      await page.getByTestId(`photo-card-${stack.coverId}`).click({ modifiers: ['Shift'] })
      await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
      await page.keyboard.press('Delete')
      await expect.poll(() => targetNames(page)).toEqual(ordered.map((p) => p.filename))
      await page.keyboard.press('Escape')
    }
    expect((await page.evaluate(() => window.luma.listPhotos())).photos).toEqual(photos)
  } finally {
    await client.close()
    await transport.close()
  }
})
