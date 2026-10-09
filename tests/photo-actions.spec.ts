import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'

const sources = [
  'alpine-lake',
  'mountain-ridge',
  'forest-light',
  'coastal-dunes',
  'quiet-valley',
].map((name) => `tests/fixtures/photos/${name}.jpg`)

test('native Delete and Backspace confirm single and multiple selections with isolated Trash', async ({
  luma,
}) => {
  const { app, page } = luma
  const trash = await isolateTrash(app)
  await importPhotos(app, page, sources.slice(0, 3))
  await focusPreviewWindow(app, page)
  const native = await app.browserWindow(page)
  const press = (keyCode: string) =>
    native.evaluate((window, keyCode) => {
      window.focus()
      window.webContents.focus()
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }, keyCode)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  const card = (index: number) => page.getByTestId(`photo-card-${photos[index].id}`)
  for (const key of ['Delete', 'Backspace']) {
    await card(0).click()
    await press(key)
    await expect(page.getByRole('dialog')).toContainText('Delete photo?')
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await press(key)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await press('Escape')
    await expect(card(0)).toBeFocused()
    await card(1).click({ modifiers: ['Shift'] })
    await press(key)
    await expect(page.getByRole('dialog')).toContainText('Delete 2 photos?')
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await press('Escape')
  }
  expect(await readdir(trash)).toHaveLength(0)
  await press('Backspace')
  await expect(page.getByRole('dialog')).toContainText('Delete 2 photos?')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  await card(2).click()
  await press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Delete photo?')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByTestId('empty-library')).toBeVisible()
  expect(await readdir(trash)).toHaveLength(3)
  for (const source of sources.slice(0, 3))
    expect((await readFile(source)).length).toBeGreaterThan(0)
})

test('native deletion keys protect fields, console focus, modifiers, repeats and handled events', async ({
  luma,
}) => {
  const { app, page } = luma
  await isolateTrash(app)
  await importPhotos(app, page, sources.slice(0, 2))
  await focusPreviewWindow(app, page)
  const native = await app.browserWindow(page)
  const press = (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []) =>
    native.evaluate(
      (window, { keyCode, modifiers }) => {
        window.focus()
        window.webContents.focus()
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      },
      { keyCode, modifiers },
    )
  const calls = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('tasks:list')!
    const state = { count: 0 }
    ipcMain.removeHandler('tasks:list')
    ipcMain.handle('tasks:list', (...args) => {
      state.count++
      return original(...args)
    })
    return state
  })
  try {
    const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
    await expect(exposure).toBeEnabled()
    await exposure.fill('12')
    await exposure.evaluate((el) => {
      el.dataset.nativeKeys = ''
      el.addEventListener('keydown', (event) => {
        el.dataset.nativeKeys += `${(event as KeyboardEvent).key},`
      })
    })
    await press('Delete')
    await press('Backspace')
    await expect(exposure).toHaveAttribute('data-native-keys', 'Delete,Backspace,')
    // Native Electron key events exercise the application guards. CDP also
    // exercises default text editing independently of macOS native edit commands.
    await exposure.fill('12')
    await exposure.press('ArrowLeft')
    await exposure.press('ArrowLeft')
    await exposure.press('Delete')
    await expect(exposure).toHaveValue('2')
    await exposure.fill('12')
    await exposure.press('Backspace')
    await expect(exposure).toHaveValue('1')
    await press('Escape')
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'deletion-key-fields'
      for (const tag of ['textarea', 'div']) {
        const field = document.createElement(tag)
        field.setAttribute('aria-label', `Protected ${tag}`)
        if (tag === 'div') {
          field.contentEditable = 'true'
          field.setAttribute('role', 'textbox')
          field.innerHTML = '<span>Editable text</span>'
        }
        host.append(field)
      }
      document.body.append(host)
    })
    for (const field of [
      page.getByRole('textbox', { name: 'Protected textarea' }),
      page.getByRole('textbox', { name: 'Protected div' }),
      page.getByRole('combobox', { name: 'Preview zoom', exact: true }),
    ]) {
      await field.focus()
      for (const key of ['Delete', 'Backspace']) await press(key)
    }
    await page.getByTestId('console-toggle').click()
    await page
      .getByRole('textbox', { name: 'Agent console output, disconnected and read only' })
      .focus()
    for (const key of ['Delete', 'Backspace']) await press(key)
    await page.getByTestId('main-preview').focus()
    for (const key of ['Delete', 'Backspace']) {
      for (const modifier of ['control', 'meta', 'alt', 'isautorepeat'] as const)
        await press(key, [modifier])
      await page.getByTestId('main-preview').evaluate((el) => {
        el.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
      })
      await press(key)
    }
    expect(await calls.evaluate((state) => state.count)).toBe(0)
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await calls.evaluate((state) => {
      state.count = 0
    })
    for (const key of ['Delete', 'Backspace']) await press(key)
    await expect(page.getByRole('dialog')).toContainText('Choose photos')
    await press('Escape')
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
    )
    expect(await calls.evaluate((state) => state.count)).toBe(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(2)
  } finally {
    await calls.dispose()
    await page.evaluate(() => document.querySelector('#deletion-key-fields')?.remove())
  }
})

test('selects ranges and individual photos, and preserves or replaces selection for context menus', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  const card = (index: number) => page.getByTestId(`photo-card-${photos[index].id}`)
  await card(0).click()
  await card(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  for (let index = 0; index < 3; index++)
    await expect(card(index)).toHaveAttribute('aria-pressed', 'true')
  await card(1).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await card(3).click({ modifiers: ['ControlOrMeta'] })
  await card(4).click({ modifiers: ['ControlOrMeta', 'Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('4 selected')
  await card(4).click({ modifiers: ['ControlOrMeta'] })
  await expect(card(4)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[4].filename)
  await card(1).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete 3 photos…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card(1)).toBeFocused()
  await card(2).click({ button: 'right' })
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  await page.getByRole('menuitem', { name: 'Delete photo…' }).click()
  await expect(page.getByRole('dialog')).toContainText(photos[2].filename)
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  const bounds = await page.getByRole('dialog').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700)
  await page.screenshot({ path: testInfo.outputPath('delete-confirmation.png') })
  await page.keyboard.press('Escape')
  await expect(card(2)).toBeFocused()
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(5)
  await card(3).click()
  await card(1).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(page.getByTestId('main-preview')).toBeVisible()
  await page.getByTestId('main-preview').focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: 'Delete 3 photos…' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('main-preview')).toBeFocused()
  await page.getByTestId('console-toggle').click()
  await page
    .getByRole('textbox', { name: 'Agent console output, disconnected and read only' })
    .focus()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('deletes a confirmed group and the last photos while preserving source files', async ({
  luma,
}) => {
  const { app, page } = luma
  const trash = await isolateTrash(app)
  await importPhotos(app, page, sources)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[2].id}`).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await expect(page.getByRole('dialog')).toContainText('Delete 3 photos?')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(2)
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[3].filename)
  await expect(page.getByTestId('selection-count')).toHaveText('0 selected')
  expect(await readdir(trash)).toHaveLength(3)
  for (const source of sources) expect((await readFile(source)).length).toBeGreaterThan(0)
  await page.getByTestId('main-preview').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete photo…' }).click()
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[4].filename)
  await page.getByTestId(`photo-card-${photos[4].id}`).click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByTestId('empty-library')).toBeVisible()
  expect(await readdir(trash)).toHaveLength(5)
  const restarted = await luma.restart()
  await expect(restarted.page.getByTestId('empty-library')).toBeVisible()
})

test('keeps deletion running through reload and cancels after the current OS move', async ({
  luma,
}, testInfo) => {
  const { app, page } = luma
  await importPhotos(app, page, sources)
  await isolateTrash(app, { delay: 3000 })
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[4].id}`).click({ modifiers: ['Shift'] })
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('task-progress')).toContainText('Moving photos to Trash')
  await page.reload()
  await expect(page.getByTestId('task-progress')).toContainText('Moving photos to Trash')
  const id = await page.evaluate(
    async () => (await window.luma.listTasks()).find((task) => task.kind === 'delete')!.id,
  )
  await page.getByRole('button', { name: 'Import photos', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId(`task-${id}`)).toContainText('0 / 5 photos moved to Trash')
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click()
  await expect(page.getByTestId(`task-${id}`)).toContainText('Cancelling deletion')
  await page.screenshot({ path: testInfo.outputPath('background-deletion.png') })
  await expect(page.getByTestId(`task-${id}`)).toHaveAttribute('data-status', 'cancelled')
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(4)
  expect(await readdir(join(luma.userDataDir, 'library', 'removed'))).toEqual([])
})

test('retains failed photos and confirms quit during deletion', async ({ luma }) => {
  const { app, page } = luma
  await importPhotos(app, page, sources.slice(0, 2))
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  await isolateTrash(app, { failId: photos[0].id })
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await expect(page.getByTestId('task-progress')).toContainText('Deletion finished with errors')
  await expect(page.getByTestId(`photo-card-${photos[0].id}`)).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByTestId('task-progress').click()
  await page.getByRole('button', { name: 'Show 1 errors' }).click()
  await expect(page.getByTestId('task-details')).toContainText('System Trash is unavailable')
  await page.keyboard.press('Escape')
  await isolateTrash(app, { delay: 2000 })
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.keyboard.press('Delete')
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  const options = await app.evaluate(async ({ dialog, BrowserWindow }) => {
    let shown!: (options: Electron.MessageBoxOptions) => void
    const result = new Promise<Electron.MessageBoxOptions>((resolve) => {
      shown = resolve
    })
    dialog.showMessageBox = async (...args: unknown[]) => {
      shown(args.at(-1) as Electron.MessageBoxOptions)
      return { response: 0, checkboxChecked: false }
    }
    BrowserWindow.getAllWindows()[0].close()
    return result
  })
  expect(options.buttons).toEqual(['Keep working', 'Cancel task and quit'])
  await expect(page.getByTestId('task-progress')).toContainText('Moving photos to Trash')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await luma.expectQuit(async () => {
    await app.evaluate(({ app }) => {
      setImmediate(() => app.quit())
    })
  })
  expect(await readdir(join(luma.userDataDir, 'library', 'removed'))).toEqual([])
  const restarted = await luma.restart()
  expect((await restarted.page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
})
