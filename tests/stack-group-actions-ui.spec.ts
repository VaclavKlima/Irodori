import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { foregroundImport } from './import-foreground.helpers'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  groupSources,
  numberedGroupSources,
  allGroupPhotos,
  createGroup,
  groupDeletionNames,
  holdGroupOperation,
  expectStackErrors,
  fixtureGroupMerge,
} from './stack-group-actions.helpers'

test('photo, selection and group targets stay distinct across unrelated groups without changing the anchor', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources)
  const photos = await allGroupPhotos(page)
  const stack = await createGroup(
    page,
    photos.slice(0, 3).map((p) => p.id),
    true,
  )
  await createGroup(
    page,
    photos.slice(3).map((p) => p.id),
    true,
  )
  const card = (i: number) => page.getByTestId(`photo-card-${photos[i].id}`)
  await card(0).click()
  await card(3).click({ modifiers: ['ControlOrMeta'] })
  await card(0).click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(
    menu.getByRole('group', { name: `Photo · ${photos[0].filename}`, exact: true }),
  ).toBeVisible()
  await expect(
    menu.getByRole('menuitem', { name: 'Move 2 selected photos to Trash…', exact: true }),
  ).toBeVisible()
  await expect(
    menu.getByRole('group', { name: 'Photo group · 3 photos · 3 originals', exact: true }),
  ).toBeVisible()
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await menu.getByRole('menuitem', { name: 'Move this photo to Trash…', exact: true }).click()
  await expect.poll(() => groupDeletionNames(page)).toEqual([photos[0].filename])
  await page.keyboard.press('Escape')
  await expect(card(0)).toBeFocused()
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await card(0).click({ button: 'right' })
  await menu
    .getByRole('menuitem', { name: 'Move entire group to Trash (3 photos)…', exact: true })
    .click()
  const snapshot = await page.evaluate((s) => window.luma.getStackSnapshot(s.id, s.revision), stack)
  await expect.poll(() => groupDeletionNames(page)).toEqual(snapshot.photos.map((p) => p.filename))
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await page.keyboard.press('Escape')
  for (const key of ['Delete', 'Backspace']) {
    await card(0).click({ button: 'right' })
    await menu
      .getByRole('menuitem', { name: 'Move entire group to Trash (3 photos)…', exact: true })
      .focus()
    await page.keyboard.press(key)
    await expect
      .poll(() => groupDeletionNames(page))
      .toEqual([photos[0].filename, photos[3].filename])
    await page.keyboard.press('Escape')
  }
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await menu.getByRole('menuitem', { name: 'Select entire group', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
  // The previous toggle anchor is retained even though Select group replaced the selected set.
  await card(4).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await expect(card(3)).toHaveAttribute('aria-pressed', 'true')
  await expect(card(4)).toHaveAttribute('aria-pressed', 'true')
})

test('collapsed and paginated members disclose a complete frozen group; menu scrolling and keyboard work at minimum console size', async ({
  luma,
}, info) => {
  test.setTimeout(90000)
  const { app, page } = luma
  const paths = await numberedGroupSources(luma.userDataDir, 69)
  const bytes = await Promise.all(paths.map((path) => readFile(path)))
  await importPhotos(app, page, paths)
  const photos = await allGroupPhotos(page)
  const ids = photos.slice(0, 65).map((p) => p.id)
  let stack = await createGroup(page, ids)
  const ordered = await page.evaluate((s) => window.luma.getStackSnapshot(s.id, s.revision), stack)
  const trash = await isolateTrash(app)
  const cover = page.getByTestId(`photo-card-${stack.coverId}`)
  await cover.click({ button: 'right' })
  await page
    .getByRole('menuitem', { name: 'Move entire group to Trash (65 photos)…', exact: true })
    .click()
  await expect.poll(() => groupDeletionNames(page)).toEqual(ordered.photos.map((p) => p.filename))
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await page.keyboard.press('Escape')
  stack = await page.evaluate((s) => window.luma.setStackExpanded(s.id, true, s.revision), stack)
  await page
    .getByRole('navigation', { name: 'Library pages' })
    .getByRole('button', { name: 'Next', exact: true })
    .click()
  await page.getByTestId(`photo-card-${photos[66].id}`).click()
  const member = ordered.photos[60]
  await page.getByTestId(`photo-card-${member.id}`).click({ modifiers: ['ControlOrMeta'] })
  await page.getByTestId('console-toggle').click()
  await (
    await app.browserWindow(page)
  ).evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  const actions = page.getByRole('button', { name: 'Actions', exact: true })
  await actions.click()
  const menu = page.getByRole('menu')
  const merge = menu.getByRole('menuitem', {
    name: 'Merge 65 group originals to HDR…',
    exact: true,
  })
  await expect(merge).toHaveCount(0)
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(
    menu.getByRole('menuitem', { name: 'Set this photo as group cover', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('End')
  await expect(
    menu.getByRole('menuitem', { name: 'Move entire group to Trash (65 photos)…', exact: true }),
  ).toBeFocused()
  await expect(
    menu.getByRole('menuitem', { name: 'Move entire group to Trash (65 photos)…', exact: true }),
  ).toBeInViewport({ ratio: 1 })
  expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')
  expect(
    await menu.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight)),
  ).toBeLessThanOrEqual(684)
  if (await menu.evaluate((el) => el.scrollHeight > el.clientHeight))
    expect(await menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('ArrowUp')
  await expect(
    menu.getByRole('menuitem', { name: 'Move 2 selected photos to Trash…', exact: true }),
  ).toBeFocused()
  await expect(
    menu.getByRole('menuitem', { name: 'Move 2 selected photos to Trash…', exact: true }),
  ).toBeInViewport({ ratio: 1 })
  const bounds = await menu.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(8)
  expect(bounds!.y).toBeGreaterThanOrEqual(8)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1092)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(692)
  await page.screenshot({ path: info.outputPath('group-actions-minimum-console.png') })
  await page.keyboard.press('Delete')
  await expect.poll(() => groupDeletionNames(page)).toEqual([photos[66].filename, member.filename])
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await actions.click()
  await menu
    .getByRole('menuitem', { name: 'Move entire group to Trash (65 photos)…', exact: true })
    .click()
  await expect.poll(() => groupDeletionNames(page)).toEqual(ordered.photos.map((p) => p.filename))
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  const list = page.getByRole('list', { name: 'Photos to move to Trash' })
  await list.focus()
  await page.keyboard.press('End')
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await expect(page.getByTestId('preview-filename')).toHaveText(member.filename)
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
  await expect.poll(() => groupDeletionNames(page)).toEqual(ordered.photos.map((p) => p.filename))
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(4)
  expect((await readdir(trash)).map((name) => name.slice(0, 64)).sort()).toEqual([...ids].sort())
  for (const [i, path] of paths.entries()) expect(await readFile(path)).toEqual(bytes[i])
  expect((await page.evaluate(() => window.luma.listStacks())).stacks).toEqual([])
  const restarted = await luma.restart()
  expect((await restarted.page.evaluate(() => window.luma.listPhotos())).total).toBe(4)
})

test('both group merge modes freeze current original IDs in persisted order and leave selection, active photo and anchor intact', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources)
  const photos = await allGroupPhotos(page)
  const stack = await createGroup(
    page,
    photos.slice(0, 4).map((p) => p.id),
    true,
  )
  const derived = [photos[0].id, photos[1].id]
  const fixture = await fixtureGroupMerge(app, derived)
  try {
    await page.getByTestId(`photo-card-${photos[4].id}`).click()
    await page.getByTestId(`photo-card-${photos[0].id}`).click({ modifiers: ['ControlOrMeta'] })
    const expected = (
      await page.evaluate((s) => window.luma.getStackSnapshot(s.id, s.revision), stack)
    ).photos
      .filter((p) => p.assetKind !== 'derived')
      .map((p) => p.id)
    expect(expected).toHaveLength(2)
    for (const mode of ['hdr', 'noise'] as const) {
      await page.getByRole('button', { name: 'Actions', exact: true }).click()
      await expect(
        page.getByRole('group', { name: 'Photo group · 4 photos · 2 originals', exact: true }),
      ).toContainText('2 originals')
      await page
        .getByRole('menuitem', {
          name:
            mode === 'hdr'
              ? 'Merge 2 group originals to HDR…'
              : 'Stack 2 group originals for noise reduction…',
          exact: true,
        })
        .click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('alert')).toContainText('original Sony RAW')
      await expect
        .poll(() => fixture.evaluate((f) => f.merges.at(-1)))
        .toEqual({ ids: expected, mode })
      await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
      await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
    }
    await page.getByTestId(`photo-card-${photos[3].id}`).click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
    await expect(page.getByTestId(`photo-card-${photos[4].id}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  } finally {
    await fixture.evaluate((f) => f.restore())
    await fixture.dispose()
  }
})

test('group merge bounds and known unsupported originals are hidden', async ({ luma }) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.map((p) => p.id),
  )
  const fixture = await fixtureGroupMerge(app)
  try {
    for (const scenario of [
      {
        derived: photos.slice(1).map((p) => p.id),
        format: 'ARW',
        count: 1,
        reason: 'The group needs at least two original Sony RAW photographs.',
      },
      {
        derived: [],
        format: 'PNG',
        count: 3,
        reason: 'Every group original must be a Sony ARW. Unsupported originals cannot be omitted.',
      },
    ]) {
      await fixture.evaluate((f, value) => f.set(value), scenario)
      await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
      for (const name of [
        `Merge ${scenario.count} group originals to HDR…`,
        `Stack ${scenario.count} group originals for noise reduction…`,
      ]) {
        const button = page.getByRole('menuitem', { name, exact: true })
        await expect(button).toHaveCount(0)
        await expect(page.getByRole('dialog')).toHaveCount(0)
      }
      await page.keyboard.press('Escape')
    }
    expect(await fixture.evaluate((f) => f.merges)).toEqual([])
  } finally {
    await fixture.evaluate((f) => f.restore())
    await fixture.dispose()
  }
})

for (const action of ['delete', 'hdr', 'noise', 'select', 'ungroup'] as const) {
  test(`stale or unavailable group ${action} closes the menu and performs no operation`, async ({
    luma,
  }) => {
    const { app, page } = luma
    await importPhotos(app, page, groupSources.slice(0, 3))
    const photos = await allGroupPhotos(page)
    let stack = await createGroup(
      page,
      photos.map((p) => p.id),
    )
    const fixture = await fixtureGroupMerge(app)
    const errors = await expectStackErrors(app)
    try {
      const actionName =
        action === 'delete'
          ? 'Move entire group to Trash (3 photos)…'
          : action === 'hdr'
            ? 'Merge 3 group originals to HDR…'
            : action === 'noise'
              ? 'Stack 3 group originals for noise reduction…'
              : action === 'select'
                ? 'Select entire group'
                : 'Ungroup photos'
      for (const missing of [false, true]) {
        await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
        await expect(page.getByRole('menuitem', { name: actionName, exact: true })).toBeVisible()
        const refresh = await holdGroupOperation(app, 'photo-actions:context')
        if (missing) await page.evaluate((s) => window.luma.ungroupStack(s.id, s.revision), stack)
        else
          stack = await page.evaluate(
            (s) => window.luma.setStackExpanded(s.id, true, s.revision),
            stack,
          )
        await page.getByRole('menuitem', { name: actionName, exact: true }).click()
        await expect(page.getByRole('menu')).toHaveCount(0)
        await expect(page.getByRole('alert')).toContainText(
          missing ? 'unavailable' : 'Stale stack revision',
        )
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await refresh.evaluate((h) => h.restore())
        await refresh.dispose()
        await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
        await expect(page.getByTestId('preview-filename')).toHaveText(photos[0].filename)
        expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(3)
        expect(
          (await page.evaluate(() => window.luma.listTasks())).some(
            (t) => t.kind === 'delete' || t.kind === 'merge',
          ),
        ).toBe(false)
      }
      expect(await fixture.evaluate((f) => f.merges)).toEqual([])
      expect(await errors.evaluate((f) => f.expectedErrors)).toEqual([
        'Stale stack revision. Reload the stack.',
        'This stack is unavailable.',
      ])
    } finally {
      await errors.evaluate((f) => f.restore())
      await fixture.evaluate((f) => f.restore())
      await errors.dispose()
      await fixture.dispose()
    }
  })
}

test('delayed, failed, superseded and dismissed menu snapshots never present partial counts or reopen old menus', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources)
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.slice(0, 3).map((p) => p.id),
  )
  await createGroup(
    page,
    photos.slice(3).map((p) => p.id),
  )
  const first = page.getByTestId(`photo-card-${photos[0].id}`)
  const second = page.getByTestId(`photo-card-${photos[3].id}`)
  const hold = await holdGroupOperation(app, 'photo-actions:context')
  try {
    await first.click({ button: 'right' })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await second.click({ button: 'right' })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    await hold.evaluate((h) => h.calls[1].resolve())
    await expect(
      page.getByRole('group', { name: 'Photo group · 2 photos · 2 originals', exact: true }),
    ).toBeVisible()
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect(
      page.getByRole('group', { name: 'Photo group · 3 photos · 3 originals', exact: true }),
    ).toHaveCount(0)
    await page.keyboard.press('Escape')
    await first.click({ button: 'right' })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(3)
    await page.keyboard.press('Escape')
    await expect(first).toBeFocused()
    await hold.evaluate((h) => h.calls[2].resolve())
    await expect(page.getByRole('menu')).toHaveCount(0)
    await first.click({ button: 'right' })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(4)
    await page.getByTestId('preview-filename').click()
    await hold.evaluate((h) => h.calls[3].reject())
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await first.click({ button: 'right' })
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(5)
    await hold.evaluate((h) => h.calls[4].reject())
    await expect(page.getByRole('alert')).toContainText('Action resolution failed.')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('delayed group actions ignore repeated activation and discard cancelled or superseded responses', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources)
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.slice(0, 3).map((p) => p.id),
  )
  const card = page.getByTestId(`photo-card-${photos[0].id}`)
  await card.click({ button: 'right' })
  const hold = await holdGroupOperation(app)
  try {
    const deletion = page.getByRole('menuitem', {
      name: 'Move entire group to Trash (3 photos)…',
      exact: true,
    })
    await deletion.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    await expect(page.getByRole('menu')).toHaveAttribute('aria-busy', 'true')
    await page.keyboard.press('Escape')
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await card.click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await deletion.click()
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(2)
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await hold.evaluate((h) => h.calls[1].reject())
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await deletion.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(3)
    await hold.evaluate((h) => h.calls[2].resolve())
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect.poll(() => groupDeletionNames(page)).toHaveLength(3)
    await page.keyboard.press('Escape')
    await card.click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await deletion.click()
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(4)
    await page.keyboard.press('Delete')
    await expect.poll(() => groupDeletionNames(page)).toEqual([photos[0].filename])
    await hold.evaluate((h) => h.calls[3].reject())
    await expect.poll(() => groupDeletionNames(page)).toEqual([photos[0].filename])
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('group deletion awaits pending range work and Select group prunes photographs deleted during snapshot resolution', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources)
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.slice(0, 3).map((p) => p.id),
    true,
  )
  await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
  const range = await holdGroupOperation(app, 'gallery:range')
  try {
    // A queued keyboard selection can precede a still-open menu action.
    await page
      .getByTestId(`photo-card-${photos[4].id}`)
      .evaluate((el) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })),
      )
    await expect.poll(() => range.evaluate((h) => h.calls.length)).toBe(1)
    await page
      .getByRole('menuitem', { name: 'Move entire group to Trash (3 photos)…', exact: true })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await range.evaluate((h) => h.calls[0].resolve())
    await expect.poll(() => groupDeletionNames(page)).toHaveLength(3)
    await expect(page.getByTestId('selection-count')).toHaveText('5 selected')
    await page.keyboard.press('Escape')
  } finally {
    await range.evaluate((h) => h.restore())
    await range.dispose()
  }
  await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
  const hold = await holdGroupOperation(app)
  const trash = await isolateTrash(app)
  try {
    await page.getByRole('menuitem', { name: 'Select entire group', exact: true }).click()
    await expect.poll(() => hold.evaluate((h) => h.calls.length)).toBe(1)
    const task = await page.evaluate((id) => window.luma.deletePhotos([id]), photos[1].id)
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.luma.listTasks()).find((t) => t.id === id)?.status,
          task,
        ),
      )
      .toBe('completed')
    await hold.evaluate((h) => h.calls[0].resolve())
    await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
    await expect(page.getByTestId(`photo-card-${photos[1].id}`)).toHaveCount(0)
    expect((await readdir(trash)).map((name) => name.slice(0, 64))).toEqual([photos[1].id])
  } finally {
    await hold.evaluate((h) => h.restore())
    await hold.dispose()
  }
})

test('direct group deletion and merge stay available during accepted background import while organization stays restricted', async ({
  luma,
}, info) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  await createGroup(
    page,
    photos.map((p) => p.id),
  )
  const fixture = await fixtureGroupMerge(app)
  const trash = await isolateTrash(app)
  const id = await foregroundImport(app, page, info)
  try {
    await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
    await expect(
      page.getByRole('menuitem', { name: 'Ungroup photos', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true')
    await expect(
      page.getByRole('menuitem', { name: 'Ungroup photos', exact: true }),
    ).toHaveAccessibleDescription('Finish or cancel the current library operation first.')
    await expect(
      page.getByRole('menuitem', { name: 'Merge 3 group originals to HDR…', exact: true }),
    ).toHaveAttribute('aria-disabled', 'false')
    await page
      .getByRole('menuitem', { name: 'Stack 3 group originals for noise reduction…', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText('original Sony RAW')
    await page.keyboard.press('Escape')
    expect(await fixture.evaluate((f) => f.merges.length)).toBe(1)
    await page.getByTestId(`photo-card-${photos[0].id}`).click({ button: 'right' })
    await page
      .getByRole('menuitem', { name: 'Move entire group to Trash (3 photos)…', exact: true })
      .click()
    await expect.poll(() => groupDeletionNames(page)).toHaveLength(3)
    await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.luma.listTasks()).find((t) => t.kind === 'delete')?.status,
        ),
      )
      .toBe('completed')
    expect((await readdir(trash)).map((name) => name.slice(0, 64)).sort()).toEqual(
      photos.map((p) => p.id).sort(),
    )
  } finally {
    await page.evaluate((id) => window.luma.cancelTask(id), id)
    await fixture.evaluate((f) => f.restore())
    await fixture.dispose()
  }
})

test('typed preload and editing MCP return identical complete snapshots and reject stale, missing and omitted revisions', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, groupSources.slice(0, 3))
  const photos = await allGroupPhotos(page)
  const stack = await createGroup(
    page,
    photos.map((p) => p.id),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
  })
  const client = new Client({ name: 'luma-group-actions-test', version: '1' })
  try {
    await client.connect(transport)
    const tool = (await client.listTools()).tools.find((t) => t.name === 'luma_get_stack_snapshot')!
    expect(tool.inputSchema.required).toEqual(['stackId', 'expectedRevision'])
    const result = await client.callTool({
      name: tool.name,
      arguments: { stackId: stack.id, expectedRevision: stack.revision },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(
      await page.evaluate((s) => window.luma.getStackSnapshot(s.id, s.revision), stack),
    )
    for (const args of [
      { stackId: stack.id },
      { stackId: stack.id, expectedRevision: 0.5 },
      { stackId: 'missing', expectedRevision: 0 },
    ]) {
      expect((await client.callTool({ name: tool.name, arguments: args })).isError).toBe(true)
    }
    await page.evaluate((s) => window.luma.setStackExpanded(s.id, true, s.revision), stack)
    expect(
      (
        await client.callTool({
          name: tool.name,
          arguments: { stackId: stack.id, expectedRevision: stack.revision },
        })
      ).isError,
    ).toBe(true)
  } finally {
    await client.close()
    await transport.close()
  }
})
