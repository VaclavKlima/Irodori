import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'

test('empty presets, inspection, creation, update and explicit application preserve drafts and ordinary Undo/Redo', async ({
  irodori,
}) => {
  test.setTimeout(75000)
  const { app } = irodori
  let { page } = irodori
  await activateButton(page.getByRole('tab', { name: 'Presets', exact: true }))
  await expect(page.getByRole('region', { name: 'Presets', exact: true })).toContainText(
    'No presets yet.',
  )
  await expect(page.getByRole('button', { name: '+ New…', exact: true })).toBeDisabled()
  await importPhotos(
    app,
    page,
    ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/photos/forest-light.jpg'],
    true,
    'keyboard',
  )
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const source = photos.find((p) => p.filename === 'alpine-lake.jpg')!,
    destination = photos.find((p) => p.filename === 'forest-light.jpg')!
  await activateButton(page.getByTestId(`photo-card-${source.id}`))
  await navigateInspector(page, 'Light')
  const field = page.getByRole('spinbutton', { name: 'Exposure value', exact: true })
  await expect(field).toBeEnabled()
  await field.fill('1.25')
  await activateButton(page.getByRole('tab', { name: 'Presets', exact: true }))
  expect(
    (await page.evaluate((id) => window.irodori.getEdits(id), source.id)).settings.exposureEv,
  ).toBe(1.25)
  await activateButton(page.getByRole('button', { name: '+ New…', exact: true }))
  let dialog = page.getByRole('dialog', { name: 'New preset', exact: true })
  await dialog.getByRole('textbox', { name: 'Preset name' }).fill('Soft woodland')
  await expect(dialog.getByRole('group', { name: 'Preset appearance', exact: true })).toContainText(
    'General · Neutral',
  )
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '')
  await dialog.locator('summary').focus()
  await dialog.locator('summary').press('Enter')
  const icon = dialog.getByRole('radio', { name: 'General', exact: true })
  await icon.focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('radio', { name: 'Sunset', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '')
  await expect(dialog.locator('summary')).toBeFocused()
  await dialog.getByRole('radio', { name: 'Neutral', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('radio', { name: 'Amber', exact: true })).toBeChecked()
  for (const name of [
    'Light',
    'Curves',
    'Saturation and vibrance',
    'Color mixer',
    'Color grading',
    'Noise reduction',
    'Detail sharpening',
  ])
    await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeChecked()
  for (const name of ['Crop and straighten', 'White balance', 'Lens corrections'])
    await expect(dialog.getByRole('checkbox', { name, exact: true })).not.toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'White balance', exact: true })).toBeDisabled()
  await activateButton(dialog.getByRole('button', { name: 'Save preset', exact: true }))
  await expect(dialog).toHaveCount(0)
  const p = (await page.evaluate(() => window.irodori.listPresets())).presets[0]
  expect(p.appearance).toEqual({ icon: 'sunset', color: 'amber' })
  await expect(page.getByRole('option', { name: /Soft woodland/ })).toHaveAttribute(
    'aria-description',
    'Sunset · Amber',
  )
  await expect(page.getByRole('option', { name: /Soft woodland/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await activateButton(page.getByTestId(`photo-card-${destination.id}`))
  const before = await page.evaluate((id) => window.irodori.getEditHistory(id), destination.id)
  await activateButton(page.getByRole('option', { name: /Soft woodland/ }))
  await page.getByText('Included settings', { exact: false }).first().click()
  await expect(page.getByRole('region', { name: 'Presets', exact: true })).toContainText(
    'Exposure (EV): 1.25',
  )
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), destination.id)).toEqual(
    before,
  )
  await activateButton(page.getByRole('button', { name: 'Apply to current photo', exact: true }))
  dialog = page.getByRole('dialog', { name: 'Apply preset', exact: true })
  await expect(dialog).toContainText('1 ready · 0 unavailable')
  await activateButton(dialog.getByRole('button', { name: 'Apply edits', exact: true }))
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.irodori.getEdits(id), destination.id)).revision,
    )
    .toBe(1)
  await page.keyboard.press('Escape')
  await navigateInspector(page, 'Light')
  await expect(field).toHaveValue('1.25')
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect(field).toHaveValue('0.00')
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect(field).toHaveValue('1.25')
  await activateButton(page.getByRole('tab', { name: 'Presets', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Update…', exact: true }))
  dialog = page.getByRole('dialog', { name: 'Update preset', exact: true })
  await expect(dialog.getByRole('group', { name: 'Preset appearance', exact: true })).toContainText(
    'Sunset · Amber',
  )
  await expect(dialog.getByRole('checkbox', { name: 'Light', exact: true })).toBeChecked()
  await activateButton(dialog.getByRole('button', { name: 'Save preset', exact: true }))
  await expect(dialog).toHaveCount(0)
  expect((await page.evaluate((id) => window.irodori.getPreset(id), p.id)).revision).toBe(2)
  expect((await page.evaluate((id) => window.irodori.getPreset(id), p.id)).appearance).toEqual(
    p.appearance,
  )
  const history = await page.evaluate((id) => window.irodori.getEditHistory(id), destination.id)
  ;({ page } = await irodori.restart())
  await expect(page.getByRole('tab', { name: 'Presets', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('option', { name: /Soft woodland/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), destination.id)).toEqual(
    history,
  )
})

test('management works without a photo; API changes, errors, search, keyboard and deep scroll recover through the shared collection', async ({
  irodori,
}) => {
  test.setTimeout(75000)
  let { page } = irodori
  await page.evaluate(async () => {
    for (let i = 0; i < 75; i++)
      await window.irodori.createPreset({
        name: `Look ${String(i).padStart(3, '0')}`,
        source: {
          mode: 'explicit',
          settingsVersion: 12,
          groups: ['color'],
          values: { saturation: i, vibrance: 0 },
        },
      })
  })
  await activateButton(page.getByRole('tab', { name: 'Presets', exact: true }))
  const list = page.getByRole('listbox', { name: 'Saved presets' })
  await expect(page.getByRole('option', { name: /Look 000/ })).toBeVisible()
  await list.focus()
  await list.press('Home')
  await expect(page.getByRole('option', { name: /Look 000/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await list.press('ArrowDown')
  await expect(page.getByRole('option', { name: /Look 001/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await list.press('ArrowUp')
  await expect(page.getByRole('option', { name: /Look 000/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await list.press('End')
  await expect(page.getByRole('option', { name: /Look 074/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(
    page.getByRole('button', { name: 'Apply to current photo', exact: true }),
  ).toBeDisabled()
  await expect
    .poll(() => page.evaluate(() => window.irodori.getWorkspaceState()))
    .toMatchObject({
      state: { presets: { anchor: { index: expect.any(Number) }, selectedId: expect.any(String) } },
    })
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.irodori.getWorkspaceState())).state?.presets.anchor
          ?.index ?? 0,
    )
    .toBeGreaterThan(60)
  const saved = (await page.evaluate(() => window.irodori.getWorkspaceState())).state!.presets
  expect(saved.anchor!.index).toBeGreaterThan(60)
  const restarted = await irodori.restart()
  page = restarted.page
  const app = restarted.app
  await expect(page.getByRole('option', { name: /Look 074/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(
    await page.getByRole('listbox', { name: 'Saved presets' }).evaluate((e) => e.scrollTop),
  ).toBeGreaterThan(2400)
  await activateButton(page.getByRole('button', { name: 'Edit details…', exact: true }))
  const dialog = page.getByRole('dialog', { name: 'Edit preset details', exact: true })
  await dialog.getByRole('textbox', { name: 'Preset name' }).fill('A saved look')
  await dialog.locator('summary').focus()
  await dialog.locator('summary').press('Enter')
  await dialog.getByRole('radio', { name: 'High noise', exact: true }).focus()
  await page.keyboard.press('Space')
  await dialog.getByRole('radio', { name: 'Blue', exact: true }).focus()
  await page.keyboard.press('Space')
  await activateButton(dialog.getByRole('button', { name: 'Save preset', exact: true }))
  await expect(dialog).toHaveCount(0)
  const edited = (await page.evaluate(() => window.irodori.listPresets({ search: 'A saved look' })))
    .presets[0]
  expect(edited).toMatchObject({ revision: 2, appearance: { icon: 'high-noise', color: 'blue' } })
  await page.getByRole('searchbox', { name: 'Search presets' }).fill('A saved look')
  await expect(page.getByRole('option', { name: /A saved look/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('option', { name: /A saved look/ })).toHaveAttribute(
    'aria-description',
    'High noise · Blue',
  )
  await activateButton(page.getByRole('button', { name: 'Edit details…', exact: true }))
  await dialog.getByRole('textbox', { name: 'Preset name' }).fill('Discarded draft')
  await dialog.getByRole('radio', { name: 'Red', exact: true }).focus()
  await page.keyboard.press('Space')
  await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
  expect((await page.evaluate((id) => window.irodori.getPreset(id), edited.id)).appearance).toEqual(
    edited.appearance,
  )
  expect((await page.evaluate((id) => window.irodori.getPreset(id), edited.id)).name).toBe(
    'A saved look',
  )
  await activateButton(page.getByRole('button', { name: 'Delete…', exact: true }))
  const deletion = page.getByRole('dialog', { name: 'Delete preset', exact: true })
  await expect(deletion).toContainText('Delete “A saved look”?')
  expect(
    await deletion
      .getByRole('button', { name: 'Cancel', exact: true })
      .evaluate((e) => document.activeElement === e),
  ).toBe(true)
  await page.keyboard.press('Escape')
  expect((await page.evaluate(() => window.irodori.listPresets())).total).toBe(75)
  await activateButton(page.getByRole('button', { name: 'Delete…', exact: true }))
  await activateButton(deletion.getByRole('button', { name: 'Delete preset', exact: true }))
  await expect(page.getByRole('region', { name: 'Presets', exact: true })).toContainText(
    'No matching presets.',
  )
  const control = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('presets:list')!
    let fail = true
    ipcMain.removeHandler('presets:list')
    ipcMain.handle('presets:list', (...args) =>
      fail ? { error: 'Injected presets read failure' } : original(...args),
    )
    return {
      allow: () => {
        fail = false
      },
      restore: () => {
        ipcMain.removeHandler('presets:list')
        ipcMain.handle('presets:list', original)
      },
    }
  })
  try {
    await page.evaluate(() =>
      window.irodori.createPreset({
        name: 'A new look',
        source: {
          mode: 'explicit',
          settingsVersion: 12,
          groups: ['color'],
          values: { saturation: 20, vibrance: 0 },
        },
      }),
    )
    await expect(page.getByRole('alert')).toContainText('Injected presets read failure')
    await control.evaluate((s) => s.allow())
    await activateButton(page.getByRole('button', { name: 'Retry presets', exact: true }))
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await control.evaluate((s) => s.restore())
  }
  await page.getByRole('searchbox', { name: 'Search presets' }).fill('A new')
  await expect(page.getByRole('option', { name: /A new look/ })).toBeVisible()
  await activateButton(page.getByRole('option', { name: /A new look/ }))
  const p = (await page.evaluate(() => window.irodori.listPresets({ search: 'A new' }))).presets[0]
  await page.evaluate(
    (p) => window.irodori.deletePreset({ presetId: p.id, expectedPresetRevision: p.revision }),
    p,
  )
  await expect(page.getByRole('button', { name: 'Edit details…', exact: true })).toBeDisabled()
  await expect
    .poll(() => page.evaluate(() => window.irodori.getWorkspaceState()))
    .toMatchObject({ state: { presets: { selectedId: null, search: 'A new' } } })
})

test('preset application freezes the complete hidden selection and leaves the copy clipboard untouched', async ({
  irodori: { app, page },
}) => {
  await importPhotos(
    app,
    page,
    ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/photos/forest-light.jpg'],
    true,
    'keyboard',
  )
  const { ids, clipboard } = await page.evaluate(async () => {
    const ids = (await window.irodori.listPhotos()).photos.map((p) => p.id)
    const clipboard = await window.irodori.copyEdits(ids[0])
    await window.irodori.createPreset({
      name: 'Selection look',
      source: {
        mode: 'explicit',
        settingsVersion: 12,
        groups: ['color'],
        values: { saturation: 20, vibrance: 0 },
      },
    })
    return { ids, clipboard }
  })
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Clear selection', exact: true }))
  const grid = page.getByTestId('browse-grid')
  await grid.focus()
  await grid.press('Home')
  await grid.press('Space')
  await grid.press('ArrowRight')
  await grid.press('Space')
  await expect(page.getByTestId('browse-selection-count')).toContainText('2 selected')
  await page.getByRole('searchbox', { name: /Search/ }).fill('no matching photo')
  await activateButton(page.getByRole('button', { name: 'Editor', exact: true }))
  await activateButton(page.getByRole('tab', { name: 'Presets', exact: true }))
  await activateButton(page.getByRole('option', { name: /Selection look/ }))
  await activateButton(
    page.getByRole('button', { name: 'Apply to selection · 2 photos', exact: true }),
  )
  const dialog = page.getByRole('dialog', { name: 'Apply preset', exact: true })
  await expect(dialog).toContainText('Apply to 2 selected photos, including hidden selections.')
  await expect(dialog).toContainText('2 ready · 0 unavailable')
  await activateButton(dialog.getByRole('button', { name: 'Apply edits', exact: true }))
  for (const id of ids)
    await expect
      .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
      .toMatchObject({ revision: 1, settings: { saturation: 20 } })
  expect(await page.evaluate(() => window.irodori.getEditClipboard())).toEqual(clipboard)
})
