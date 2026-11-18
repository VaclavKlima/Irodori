import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'

async function saveCheckpoint(page: Page, name: string) {
  await activateButton(page.getByRole('button', { name: 'Save checkpoint…', exact: true }))
  const dialog = page.getByRole('dialog', { name: 'Save checkpoint', exact: true })
  await expect(dialog.getByRole('textbox', { name: 'Checkpoint name' })).toBeFocused()
  await dialog.getByRole('textbox', { name: 'Checkpoint name' }).fill(name)
  await activateButton(dialog.getByRole('button', { name: 'Save checkpoint', exact: true }))
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: `${name} checkpoint`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
}

test('named versions capture pending edits, compare without history changes and restore one undoable edit through restart', async ({
  irodori,
}) => {
  test.setTimeout(120000)
  let { page } = irodori
  const versions = () => page.getByRole('region', { name: 'Versions', exact: true })
  await activateButton(page.getByRole('tab', { name: 'Versions', exact: true }))
  await expect(versions()).toContainText('Select a photograph')
  await expect(page.getByRole('button', { name: 'Save checkpoint…', exact: true })).toBeDisabled()
  await importPhotos(irodori.app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
  await navigateInspector(page, 'Light')
  const exposure = page.getByRole('spinbutton', { name: 'Exposure value', exact: true })
  await expect(exposure).toBeEnabled()
  await exposure.fill('0.35')
  await activateButton(page.getByRole('tab', { name: 'Versions', exact: true }))
  await saveCheckpoint(page, 'Natural')
  const natural = (await page.evaluate((id) => window.irodori.listEditCheckpoints(id), photo.id))
    .checkpoints[0]
  expect(
    (
      await page.evaluate(
        ([id, checkpoint]) => window.irodori.getEditCheckpoint(id, checkpoint),
        [photo.id, natural.id],
      )
    ).settings.exposureEv,
  ).toBe(0.35)
  const savedHistory = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
  await activateButton(page.getByRole('button', { name: 'Natural checkpoint', exact: true }))
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
    savedHistory,
  )
  await page.evaluate(async (id) => {
    const edit = await window.irodori.getEdits(id)
    await window.irodori.updateEdits(id, { exposureEv: 0.9, contrast: 12 }, edit.revision)
  }, photo.id)
  await saveCheckpoint(page, 'Stronger')
  await activateButton(page.getByRole('button', { name: 'Natural checkpoint', exact: true }))
  await page.getByRole('combobox', { name: 'Comparison A' }).selectOption(natural.id)
  await activateButton(page.getByRole('button', { name: 'Stronger checkpoint', exact: true }))
  await expect(page.getByRole('combobox', { name: 'Comparison A' })).toHaveValue(natural.id)
  const stronger = (
    await page.evaluate((id) => window.irodori.listEditCheckpoints(id), photo.id)
  ).checkpoints.find((checkpoint) => checkpoint.name === 'Stronger')!
  await page.getByRole('combobox', { name: 'Comparison B' }).selectOption(stronger.id)
  const beforeCompare = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
  await activateButton(versions().getByRole('button', { name: 'Compare', exact: true }))
  let comparison = page.getByTestId('edit-comparison-preview')
  await expect(comparison).toHaveAttribute('data-status', 'ready', { timeout: 45000 })
  await expect(comparison).toContainText('Natural')
  await expect(comparison).toContainText('Stronger')
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Light', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(
    page.getByText('Unavailable during version comparison.', { exact: true }),
  ).toBeVisible()
  const photograph = page.getByLabel('Version comparison photograph', { exact: true })
  await photograph.focus()
  await photograph.press('\\')
  await photograph.press('y')
  await expect(comparison).toHaveAttribute('data-mode', 'split')
  await photograph.press('ControlOrMeta+z')
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
    beforeCompare,
  )
  // Quit must flush ordinary confirmed edits even while read-only comparison
  // suspends history commands. Its transient session must not reopen on restart.
  ;({ page } = await irodori.restart())
  comparison = page.getByTestId('edit-comparison-preview')
  await expect(comparison).toHaveCount(0)
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
    beforeCompare,
  )
  await activateButton(page.getByRole('tab', { name: 'Versions', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Natural checkpoint', exact: true }))
  await activateButton(versions().getByRole('button', { name: 'Restore selected', exact: true }))
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.irodori.getEdits(id), photo.id)).settings.exposureEv,
    )
    .toBe(0.35)
  const restored = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
  expect(restored.snapshots).toHaveLength(beforeCompare.snapshots.length + 1)
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.irodori.getEdits(id), photo.id)).settings.exposureEv,
    )
    .toBe(0.9)
  const renamed = page.getByRole('button', { name: 'Actions for Natural', exact: true })
  await activateButton(renamed)
  await activateButton(page.getByRole('menuitem', { name: 'Rename…', exact: true }))
  let dialog = page.getByRole('dialog', { name: 'Rename checkpoint' })
  await dialog.getByRole('textbox', { name: 'Checkpoint name' }).fill('Gentle')
  await activateButton(dialog.getByRole('button', { name: 'Rename checkpoint', exact: true }))
  await expect(dialog).toHaveCount(0)
  await activateButton(page.getByRole('button', { name: 'Actions for Gentle', exact: true }))
  await activateButton(page.getByRole('menuitem', { name: 'Delete…', exact: true }))
  dialog = page.getByRole('dialog', { name: 'Delete checkpoint' })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  ;({ page } = await irodori.restart())
  await activateButton(page.getByRole('tab', { name: 'Versions', exact: true }))
  await expect(page.getByRole('button', { name: 'Gentle checkpoint', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stronger checkpoint', exact: true })).toBeVisible()
  await expect(page.getByTestId('edit-comparison-preview')).toHaveCount(0)
  expect(
    (await page.evaluate((id) => window.irodori.listEditCheckpoints(id), photo.id)).total,
  ).toBe(2)
})

test('checkpoint collection navigates across unloaded chunks without applying or losing saved versions', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
  const expected = await page.evaluate(async (id) => {
    const state = await window.irodori.getEdits(id)
    for (let i = 0; i < 65; i++)
      await window.irodori.createEditCheckpoint({
        photoId: id,
        expectedRevision: state.revision,
        name: `Pass ${String(i).padStart(2, '0')}`,
      })
    const first = await window.irodori.listEditCheckpoints(id)
    const last = await window.irodori.listEditCheckpoints(id, {
      offset: 60,
      expectedStoreRevision: first.storeRevision,
    })
    return {
      first: first.checkpoints[0],
      last: last.checkpoints.at(-1)!,
      history: await window.irodori.getEditHistory(id),
    }
  }, photo.id)
  await activateButton(page.getByRole('tab', { name: 'Versions', exact: true }))
  const list = page.getByRole('list', { name: 'Saved checkpoints' })
  await expect(list).toHaveAttribute('aria-busy', 'false')
  await list.focus()
  await list.press('End')
  const last = page.getByRole('button', { name: `${expected.last.name} checkpoint`, exact: true })
  await expect(last).toBeFocused()
  await expect(last).toHaveAttribute('aria-pressed', 'true')
  await last.press('Home')
  await expect(
    page.getByRole('button', { name: `${expected.first.name} checkpoint`, exact: true }),
  ).toBeFocused()
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
    expected.history,
  )
  expect(await list.locator('[data-checkpoint-id]').count()).toBeLessThan(65)
})
