import { test, expect } from './electron.fixture'
import { seedLargeBrowser } from './all-photos.helpers'
import { revealEditorPhoto } from './collection-ui.helpers'
import { activateButton } from './button.helpers'

test('unloaded group tiles span chunks and Show current reveals hidden active members without replacing selection', async ({
  irodori,
}) => {
  test.setTimeout(60000)
  await seedLargeBrowser(irodori.app, irodori.page, irodori.userDataDir, 185)
  const { page } = await irodori.restart()
  const summary = await page.evaluate(() => window.irodori.getGallerySummary())
  const first = (await page.evaluate((s) => window.irodori.getGalleryChunk(0, s), summary)).entries
  const next = (await page.evaluate((s) => window.irodori.getGalleryChunk(60, s), summary)).entries
  const ids = [first[59].photo.id, ...next.slice(0, 4).map((e) => e.photo.id)]
  const stack = await page.evaluate(
    async (ids) =>
      window.irodori.groupPhotos(ids, ids[0], (await window.irodori.listStacks()).revision),
    ids,
  )
  await page.evaluate(
    (stack) => window.irodori.setStackExpanded(stack.id, true, stack.revision),
    stack,
  )
  await revealEditorPhoto(page, ids[0])
  const before = await page.getByTestId(`photo-card-${ids[0]}`).boundingBox()
  const neighborId = (
    await page.evaluate(async () =>
      window.irodori.getGalleryChunk(60, await window.irodori.getGallerySummary()),
    )
  ).entries[0].photo.id
  const neighbor = await page.getByTestId(`photo-card-${neighborId}`).boundingBox()
  expect(before!.y).toBe(neighbor!.y)
  expect(neighbor!.x).toBeGreaterThan(before!.x)
  await activateButton(page.getByTestId(`photo-card-${ids[2]}`))
  await page.getByTestId(`photo-card-${ids[4]}`).click({ modifiers: ['ControlOrMeta'] })
  const active = await page.getByTestId('preview-filename').textContent()
  await expect
    .poll(
      async () => (await page.evaluate(() => window.irodori.getWorkspaceState())).selected.length,
    )
    .toBe(2)
  const selected = (await page.evaluate(() => window.irodori.getWorkspaceState())).selected.map(
    (p) => p.id,
  )
  await page.evaluate(async () => {
    const stack = (await window.irodori.listStacks()).stacks[0]
    await window.irodori.setStackExpanded(stack.id, false, stack.revision)
  })
  await expect(page.getByText('2 selected in collapsed stacks', { exact: true })).toBeVisible()
  await activateButton(page.getByRole('button', { name: 'Show current', exact: true }))
  await expect(page.getByTestId(`photo-card-${ids[4]}`)).toBeVisible()
  await expect(page.getByTestId('preview-filename')).toHaveText(active!)
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.irodori.getWorkspaceState())).selected.map((p) => p.id),
    )
    .toEqual(selected)
  const revision = await page.evaluate(() => window.irodori.getGallerySummary())
  expect(revision.groups).toEqual([{ stackId: stack.id, start: 59, count: 5 }])

  // Reveal a deep active row from the top, forcing its bottom to the viewport edge.
  const scroll = page.getByTestId('editor-photo-scroll')
  await scroll.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0)
  await activateButton(page.getByRole('button', { name: 'Show current', exact: true }))
  const activeCard = page.getByTestId(`photo-card-${ids[4]}`)
  await expect(activeCard).toBeVisible()
  await expect(async () => {
    const bounds = await activeCard.evaluate((element) => {
      const viewport = element.closest('[data-testid="editor-photo-scroll"]')!
      return {
        card: element.getBoundingClientRect().toJSON(),
        viewport: viewport.getBoundingClientRect().toJSON(),
      }
    })
    expect(bounds.card.top).toBeGreaterThanOrEqual(bounds.viewport.top - 0.5)
    expect(bounds.card.bottom).toBeLessThanOrEqual(bounds.viewport.bottom + 0.5)
  }).toPass()
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000)
  expect(
    (await page.evaluate(() => window.irodori.getWorkspaceState())).selected.map((p) => p.id),
  ).toEqual(selected)

  await scroll.focus()
  await scroll.press('ArrowDown')
  const focused = page.locator('[data-testid^="photo-card-"][data-focused="true"]')
  await expect(focused).not.toHaveAttribute('data-testid', `photo-card-${ids[4]}`)
  await expect(async () => {
    const bounds = await focused.evaluate((element) => {
      const viewport = element.closest('[data-testid="editor-photo-scroll"]')!
      return {
        card: element.getBoundingClientRect().toJSON(),
        viewport: viewport.getBoundingClientRect().toJSON(),
      }
    })
    expect(bounds.card.top).toBeGreaterThanOrEqual(bounds.viewport.top - 0.5)
    expect(bounds.card.bottom).toBeLessThanOrEqual(bounds.viewport.bottom + 0.5)
  }).toPass()
})

test('a delayed Show current request never overrides a later photo selection', async ({
  irodori: { app, page },
}) => {
  const { importPhotos } = await import('./import.helpers')
  await importPhotos(app, page)
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const gate = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('stacks:photo')!
    let release!: () => void,
      held = false
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('stacks:photo')
    ipcMain.handle('stacks:photo', async (...args) => {
      if (!held) {
        held = true
        await wait
      }
      return original(...args)
    })
    return {
      release,
      held: () => held,
      close() {
        release()
        ipcMain.removeHandler('stacks:photo')
        ipcMain.handle('stacks:photo', original)
      },
    }
  })
  try {
    const current = await page.getByTestId('preview-filename').textContent(),
      other = photos.find((p) => p.filename !== current)!
    await activateButton(page.getByRole('button', { name: 'Show current', exact: true }))
    await expect.poll(() => gate.evaluate((g) => g.held())).toBe(true)
    await activateButton(page.getByTestId(`photo-card-${other.id}`))
    await expect(page.getByTestId('preview-filename')).toHaveText(other.filename)
    await gate.evaluate((g) => g.release())
    await expect
      .poll(
        async () => (await page.evaluate(() => window.irodori.getWorkspaceState())).state?.activeId,
      )
      .toBe(other.id)
    await expect(page.getByTestId('preview-filename')).toHaveText(other.filename)
  } finally {
    await gate.evaluate((g) => g.close())
    await gate.dispose()
  }
})
