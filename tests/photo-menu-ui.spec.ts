import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import {
  allGroupPhotos,
  createGroup,
  fixtureGroupMerge,
  groupSources,
  holdGroupOperation,
} from './stack-group-actions.helpers'

test('toolbar keyboard opening, roving focus, prefix search and normal Tab traversal share one menu', async ({
  luma,
}) => {
  const { app, page } = luma
  const actions = page.getByRole('button', { name: 'Actions', exact: true })
  await actions.click()
  await expect(page.getByRole('menu')).toContainText('No photo actions available.')
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.map((p) => p.id),
    true,
  )
  const card = page.getByTestId(`photo-card-${photos[1].id}`)
  await card.click()
  await actions.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu')
  const items = menu.getByRole('menuitem')
  await expect(actions).toHaveAttribute('aria-expanded', 'true')
  await expect(actions).toHaveAttribute('aria-controls', 'photo-actions-menu')
  await expect(items.first()).toBeFocused()
  expect(
    await items.evaluateAll(
      (nodes) => nodes.filter((node) => (node as HTMLElement).tabIndex === 0).length,
    ),
  ).toBe(1)
  await page.keyboard.press('ArrowUp')
  await expect(items.last()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('End')
  await expect(items.last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(items.first()).toBeFocused()
  await page.keyboard.type('rem')
  await expect(menu.getByRole('menuitem', { name: 'Remove this photo from group' })).toBeFocused()
  await page.waitForTimeout(1050)
  await page.keyboard.type('SEL')
  await expect(menu.getByRole('menuitem', { name: 'Select entire group' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeFocused()
  await actions.focus()
  await page.keyboard.press('ArrowUp')
  await expect(items.last()).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Library', exact: true })).toBeFocused()
  await card.click({ button: 'right' })
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(card).toBeFocused()
  await actions.click()
  await page.getByTestId('console-toggle').click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('console-toggle')).toBeFocused()
})

test('eligibility and equivalent targets keep complete-group menus compact, with originals-only group merges', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  const stack = await createGroup(
    page,
    photos.map((p) => p.id),
    true,
  )
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  const fixture = await fixtureGroupMerge(app, [photos[0].id])
  try {
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Set this photo as group cover' })).toHaveCount(
      0,
    )
    await expect(menu.getByRole('menuitem', { name: 'Group selected photos' })).toHaveCount(0)
    await expect(menu.locator('[data-action-id="selection-hdr"]')).toHaveCount(0)
    await expect(menu.locator('[data-action-id="group-hdr"]')).toBeVisible()
    await expect(menu.locator('[data-action-id="photo-trash"]')).toHaveCount(0)
    await menu.getByRole('menuitem', { name: 'Select entire group' }).click()
    await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await expect(menu.getByRole('menuitem', { name: 'Select entire group' })).toHaveCount(0)
    await expect(menu.locator('[data-action-id="group-trash"]')).toHaveCount(0)
    await expect(menu.locator('[data-action-id="selection-trash"]')).toHaveAccessibleName(
      'Move 3 selected photos to Trash…',
    )
    await expect(menu.locator('[data-action-id="group-hdr"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await fixture.evaluate((f) => f.set({ derived: [] }))
    const order = (
      await page.evaluate((s) => window.luma.getStackSnapshot(s.id, s.revision), stack)
    ).photos
    await page.getByTestId(`photo-card-${order[0].id}`).click()
    for (const p of order.slice(1))
      await page.getByTestId(`photo-card-${p.id}`).click({ modifiers: ['ControlOrMeta'] })
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await expect(menu.locator('[data-action-id="group-hdr"]')).toHaveCount(0)
    await expect(menu.locator('[data-action-id="selection-hdr"]')).toBeVisible()
  } finally {
    await fixture.evaluate((f) => f.restore())
    await fixture.dispose()
  }
})

test('availability updates retain focus, explain distinct blockers once, and disabled commands never run', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.map((p) => p.id),
    true,
  )
  await page.getByTestId(`photo-card-${photos[1].id}`).click()
  const fixture = await app.evaluateHandle(({ ipcMain, BrowserWindow }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('photo-actions:context')!
    let blocked = false
    const calls: unknown[][] = []
    ipcMain.removeHandler('photo-actions:context')
    ipcMain.handle('photo-actions:context', async (...args) => {
      calls.push(args.slice(1))
      const c = (await original(
        ...args,
      )) as import('../src/shared/photo-actions').PhotoActionsContext
      if (blocked) {
        for (const id of ['photo-cover', 'photo-remove', 'group-ungroup'] as const)
          c.availability[id] = { kind: 'blocked', reason: 'Finish the current task.' }
        c.availability['selection-trash'] = { kind: 'blocked', reason: 'Close the source review.' }
      }
      return c
    })
    return {
      calls,
      set(value: boolean) {
        blocked = value
        BrowserWindow.getAllWindows()[0].webContents.send('library:event', { tasksChanged: true })
      },
      restore() {
        ipcMain.removeHandler('photo-actions:context')
        ipcMain.handle('photo-actions:context', original)
      },
    }
  })
  try {
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    const menu = page.getByRole('menu')
    const cover = menu.locator('[data-action-id="photo-cover"]')
    await expect(cover).toBeFocused()
    await fixture.evaluate((f) => f.set(true))
    await expect(cover).toHaveAttribute('aria-disabled', 'true')
    await expect(cover).toBeFocused()
    await expect(menu.getByText('Finish the current task.', { exact: true })).toHaveCount(1)
    await expect(menu.getByText('Close the source review.', { exact: true })).toHaveCount(1)
    await expect(cover).toHaveAccessibleDescription('Finish the current task.')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await expect(menu).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('ArrowDown')
    await expect(menu.locator('[data-action-id="photo-remove"]')).toBeFocused()
    await fixture.evaluate((f) => f.set(false))
    await expect(cover).toHaveAttribute('aria-disabled', 'false')
    await expect(menu.locator('[data-action-id="photo-remove"]')).toBeFocused()
    await expect(menu.getByRole('status')).toHaveCount(0)
    expect(
      await fixture.evaluate((f, id) => f.calls.every((args) => args[0] === id), photos[1].id),
    ).toBe(true)
  } finally {
    await fixture.evaluate((f) => f.restore())
    await fixture.dispose()
  }
})

test('loading is dismissible and generation guards reject late context reads and repeated pending actions', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.map((p) => p.id),
  )
  const actions = page.getByRole('button', { name: 'Actions', exact: true })
  const hold = await holdGroupOperation(app, 'photo-actions:context')
  try {
    await actions.click()
    await expect(actions).toHaveAttribute('aria-busy', 'true')
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await page.keyboard.press('Escape')
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(actions).toBeFocused()
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
  await actions.click()
  await expect(page.getByRole('menu')).toBeVisible()
  const pending = await holdGroupOperation(app)
  try {
    await page.getByRole('menuitem', { name: 'Move entire group to Trash (3 photos)…' }).focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect.poll(() => pending.evaluate((h) => h.calls.length)).toBe(1)
    await expect(page.getByRole('menu')).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByRole('menuitem').first()).toHaveAccessibleDescription('Working…')
    await page.keyboard.press('Escape')
    await pending.evaluate((h) => h.calls[0].resolve())
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await pending.evaluate((h) => h.restore())
    await pending.dispose()
  }
})

test('a failed superseded availability read cannot close the current menu or replace its focus', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.map((p) => p.id),
    true,
  )
  await page.getByTestId(`photo-card-${photos[1].id}`).click()
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  const menu = page.getByRole('menu')
  const cover = menu.locator('[data-action-id="photo-cover"]')
  await expect(cover).toBeFocused()
  const hold = await holdGroupOperation(app, 'photo-actions:context')
  const changed = () =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('library:event', { tasksChanged: true })
    })
  try {
    await changed()
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBeGreaterThanOrEqual(1)
    await changed()
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBeGreaterThanOrEqual(2)
    await hold.evaluate((h) => h.calls.at(-1)!.resolve())
    await expect(cover).toBeFocused()
    await hold.evaluate((h) => h.calls[0].reject())
    await page.waitForTimeout(100)
    await expect(menu).toBeVisible()
    await expect(cover).toBeFocused()
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('long headings fit the native minimum window; unrelated imports persist and stale targets close', async ({
  luma,
}, info) => {
  const { app, page } = luma
  const filename = `${'Long photographic filename '.repeat(7)}.jpg`
  const source = join(luma.userDataDir, filename)
  await cp(groupSources[0], source)
  await importPhotos(app, page, [source, groupSources[1], groupSources[2]])
  const photos = await allGroupPhotos(page)
  const long = photos.find((p) => p.filename === filename)!
  const cover = photos.find((p) => p.id !== long.id)!
  const stack = await createGroup(
    page,
    [cover.id, ...photos.filter((p) => p.id !== cover.id).map((p) => p.id)],
    true,
  )
  await page.getByTestId(`photo-card-${long.id}`).click()
  await page.getByTestId('console-toggle').click()
  await (
    await app.browserWindow(page)
  ).evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('group', { name: `Photo · ${filename}`, exact: true })).toBeVisible()
  expect(
    await menu
      .locator('#photo-menu-photo')
      .evaluate(
        (el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis',
      ),
  ).toBe(true)
  const box = (await menu.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(270)
  expect(box.width).toBeLessThanOrEqual(350)
  expect(box.x + box.width).toBeLessThanOrEqual(1092)
  expect(box.y + box.height).toBeLessThanOrEqual(692)
  expect(
    await menu
      .getByRole('menuitem')
      .evaluateAll((buttons) =>
        buttons.every(
          (b) => b.getBoundingClientRect().height >= 32 && getComputedStyle(b).fontSize === '12px',
        ),
      ),
  ).toBe(true)
  await page.screenshot({ path: info.outputPath('photo-menu-minimum-console.png') })
  // A real accepted import is allowed while this menu remains open.
  await app.evaluate(
    ({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
    },
    join(process.cwd(), groupSources[3]),
  )
  await page.evaluate(async () => {
    const id = await window.luma.chooseSource('files', true)
    if (!id) throw new Error('Expected isolated import session.')
    for (;;) {
      if ((await window.luma.getReview(id)).phase === 'review') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await window.luma.importSelected(id)
  })
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(4)
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-action-id="photo-cover"]')).toBeFocused()
  await page.evaluate((s) => window.luma.ungroupStack(s.id, s.revision), stack)
  await expect(menu).toHaveCount(0)
  await page.getByTestId(`photo-card-${long.id}`).click({ button: 'right' })
  await expect(menu).toBeVisible()
  await isolateTrash(app)
  await page.evaluate((id) => window.luma.deletePhotos([id]), long.id)
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
