import { openPreviewOptions } from './preview-options.helpers'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector, openInspectorTool } from './inspector.helpers'
import { minimumAdjustmentWindow } from './adjustment-input.helpers'
import { foregroundTest } from './foreground'

const nativeCapture =
  process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)
    ? foregroundTest('Wayland native minimum-size screenshots require compositor presentation.')
    : {}

test('navigation flushes drafts, cancels invalid text, retains panels and external revisions, and restores preferences', async ({
  irodori,
}) => {
  let { page } = irodori
  await importPhotos(irodori.app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const light = page.locator('#panel-light')
  await light.evaluate((e) => e.setAttribute('data-owner', 'retained'))
  const value = page.getByRole('spinbutton', { name: 'Exposure value' })
  await expect(value).toBeEnabled({ timeout: 20000 })
  await value.fill('1.25')
  await navigateInspector(page, 'Color Mixer')
  await expect(light).toBeHidden()
  await expect(light).toHaveAttribute('data-owner', 'retained')
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 1, settings: { exposureEv: 1.25 } })
  await page.evaluate((id) => window.irodori.updateEdits(id, { exposureEv: 0.5 }, 1), id)
  await navigateInspector(page, 'Light')
  await expect(value).toHaveValue('0.50')
  await value.fill('99')
  await navigateInspector(page, 'Color Grading')
  await navigateInspector(page, 'Light')
  await expect(value).toHaveValue('0.50')
  expect((await page.evaluate((id) => window.irodori.getEdits(id), id)).revision).toBe(2)
  await navigateInspector(page, 'Color Grading')
  await activateButton(page.getByRole('button', { name: 'Toggle hover', exact: true }))
  await expect
    .poll(() => page.evaluate(() => window.irodori.getWorkspaceState()))
    .toMatchObject({ state: { inspectorGroup: 'color', colorTab: 'grading', hoverControls: true } })
  ;({ page } = await irodori.restart())
  await expect(page.getByRole('tab', { name: 'Color', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: 'Grading', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Toggle hover', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})
test('resets use one photo-wide history step, preserve crop guards, and support Undo/Redo', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const state = () => page.evaluate((id) => window.irodori.getEditHistory(id), id)
  await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toBeEnabled({
    timeout: 20000,
  })
  for (const [tool, patch, expected] of [
    ['Light', { exposureEv: 1, contrast: 20 }, { exposureEv: 0, contrast: 0 }],
    [
      'Color',
      { saturation: 20, vibrance: 25, colorGrading: { balance: 20 } },
      { saturation: 0, vibrance: 0, colorGrading: { balance: 0 } },
    ],
    ['Detail', { detailSharpening: { amount: 10 } }, { detailSharpening: { amount: 0 } }],
    [
      'Crop',
      {
        crop: {
          version: 1,
          quarterTurns: 1,
          angle: 0,
          centerX: 0.5,
          centerY: 0.5,
          width: 1,
          height: 1,
          aspectRatio: null,
        },
      },
      { crop: { quarterTurns: 0 } },
    ],
  ] as const) {
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    const before = await state()
    await page.evaluate(
      ({ id, patch, revision }) => window.irodori.updateEdits(id, patch, revision),
      { id, patch, revision: before.revision },
    )
    await openInspectorTool(page, tool)
    const group = tool === 'Crop' ? 'Geometry' : tool
    const reset = page.getByRole('button', { name: `Reset ${group}`, exact: true })
    await expect(reset).toBeEnabled({ timeout: 30000 })
    const changed = await state()
    await activateButton(reset)
    await expect.poll(state).toMatchObject({
      revision: changed.revision + 1,
      settings: expected,
      cursor: changed.cursor + 1,
    })
    await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
    await expect.poll(state).toMatchObject({ settings: changed.settings })
    await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
    await expect.poll(state).toMatchObject({ settings: expected })
  }
  await openPreviewOptions(page)
  await activateButton(page.getByRole('button', { name: 'Crop photo', exact: true }))
  await expect(page.getByRole('button', { name: 'Reset Geometry', exact: true })).toBeDisabled()
  await activateButton(page.getByRole('button', { name: 'Cancel crop', exact: true }))
})
test(
  'Sunflower fits the native minimum with Console, local fonts, pinned histogram and keyboard tabs',
  nativeCapture,
  async ({ irodori: { app, page } }) => {
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
    await minimumAdjustmentWindow(app, page)
    expect(
      await page.getByTestId('photo-library').evaluate((e) => e.getBoundingClientRect().width),
    ).toBe(224)
    expect(
      await page.getByTestId('adjustments-panel').evaluate((e) => e.getBoundingClientRect().width),
    ).toBe(344)
    const plot = await page.getByRole('slider', { name: 'Histogram tonal value' }).boundingBox()
    expect(plot!.width).toBeGreaterThanOrEqual(240)
    expect(plot!.height).toBeGreaterThanOrEqual(96)
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.fonts.check('600 12px Lato'))).toBe(true)
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter((e) => /\.ttf/.test(e.name))
          .every((e) => e.name.startsWith('file:')),
      ),
    ).toBe(true)
    const tab = page.getByRole('tab', { name: 'Light', exact: true })
    await tab.focus()
    await tab.press('ArrowDown')
    await expect(page.getByRole('tab', { name: 'Color', exact: true })).toBeFocused()
    await expect(page.getByRole('tab', { name: 'Color', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.screenshot({ path: test.info().outputPath('sunflower-minimum.png') })
  },
)

test('hover controls retain keyboard/menu/dialog access, coarse pointers and reduced motion', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const toolbar = page.locator('[data-hover-controls] > div').first()
  await activateButton(page.getByRole('button', { name: 'Toggle hover', exact: true }))
  await page.getByTestId('editor-photo-scroll').focus()
  await page.mouse.move(1, 1)
  await expect(toolbar).toHaveCSS('opacity', '0')
  await page
    .getByRole('button', { name: 'Undo', exact: true })
    .evaluate((e) => e.closest('div')?.querySelector<HTMLButtonElement>('button')?.focus())
  await page.getByRole('button', { name: 'Photo actions', exact: true }).focus()
  await expect(toolbar).toHaveCSS('opacity', '1')
  await activateButton(page.getByRole('button', { name: 'Photo actions', exact: true }))
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(toolbar).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')
  await activateButton(page.getByRole('button', { name: 'Settings', exact: true }))
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(toolbar).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await toolbar.evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0s')
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  await page.getByTestId('editor-photo-scroll').focus()
  await page.mouse.move(1, 1)
  await expect(toolbar).toHaveCSS('opacity', '1')
  await session.detach()
})

test('a delayed Geometry reset never commits to a later active photograph', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page)
  await openInspectorTool(page, 'Crop')
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  await expect(page.getByRole('button', { name: 'Reset Geometry', exact: true })).toBeEnabled()
  const gate = await app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const lens = handlers.get('lens:get')!,
      update = handlers.get('edits:update')!
    let release!: () => void,
      held = false
    const calls: string[] = []
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('lens:get')
    ipcMain.handle('lens:get', async (...args) => {
      if (!held) {
        held = true
        await wait
      }
      return lens(...args)
    })
    ipcMain.removeHandler('edits:update')
    ipcMain.handle('edits:update', (...args) => {
      calls.push(args[1] as string)
      return update(...args)
    })
    return {
      release,
      read: () => ({ held, calls }),
      close() {
        release()
        ipcMain.removeHandler('lens:get')
        ipcMain.handle('lens:get', lens)
        ipcMain.removeHandler('edits:update')
        ipcMain.handle('edits:update', update)
      },
    }
  })
  try {
    await activateButton(page.getByRole('button', { name: 'Reset Geometry', exact: true }))
    await expect.poll(() => gate.evaluate((g) => g.read().held)).toBe(true)
    const current = await page.getByTestId('preview-filename').textContent(),
      other = photos.find((p) => p.filename !== current)!
    await activateButton(page.getByTestId(`photo-card-${other.id}`))
    await expect(page.getByTestId('preview-filename')).toHaveText(other.filename)
    await gate.evaluate((g) => g.release())
    await expect(page.getByRole('button', { name: 'Reset Geometry', exact: true })).toBeEnabled()
    expect(await gate.evaluate((g) => g.read().calls)).toEqual([])
  } finally {
    await gate.evaluate((g) => g.close())
    await gate.dispose()
  }
})
