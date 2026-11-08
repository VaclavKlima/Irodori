import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { foregroundTest } from './foreground'
import type { Locator } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test(
  'native brush pointer and keyboard gestures keep ordered masks usable with Console at minimum size',
  foregroundTest(
    'Native pointer capture, keyboard focus and minimum content sizing require the isolated visible application window.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(90000)
    await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
    const native = await app.browserWindow(page)
    await native.evaluate((window) => {
      window.unmaximize()
      const [, outer] = window.getSize(),
        [, content] = window.getContentSize()
      window.setMinimumSize(1100, 700 + outer - content)
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await focusPreviewWindow(app, page)
    const send = (events: (Electron.KeyboardInputEvent | Electron.MouseInputEvent)[]) =>
      native.evaluate((window, events) => {
        if (!window.isVisible() || !window.isFocused() || window.isMinimized())
          throw new Error('The isolated mask window lost native activation.')
        for (const event of events) window.webContents.sendInputEvent(event)
      }, events)
    const key = (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []) =>
      send([
        { type: 'keyDown', keyCode, modifiers },
        { type: 'keyUp', keyCode, modifiers },
      ])
    const click = async (locator: Locator) => {
      await locator.scrollIntoViewIfNeeded()
      const box = (await locator.boundingBox())!,
        x = Math.round(box.x + box.width / 2),
        y = Math.round(box.y + box.height / 2)
      await send([
        { type: 'mouseMove', x, y },
        { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
        { type: 'mouseUp', x, y, button: 'left', clickCount: 1 },
      ])
    }
    await click(page.getByTestId('console-toggle'))
    await navigateInspector(page, 'Masks')
    await click(page.getByRole('button', { name: 'Create mask', exact: true }))
    await click(
      page
        .getByRole('menu', { name: 'Create mask', exact: true })
        .getByRole('menuitem', { name: 'Brush', exact: true }),
    )
    const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
      history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId),
      canvas = page.getByTestId('main-preview')
    await expect.poll(history).toMatchObject({ revision: 1 })
    const first = (await history()).settings.maskStack[0].id
    await click(page.getByRole('tab', { name: 'Adjustments', exact: true }))
    const exposure = page.getByRole('spinbutton', { name: 'Local Exposure value', exact: true })
    await exposure.fill('0.75')
    await key('Enter')
    await expect.poll(history).toMatchObject({ revision: 2 })
    await expect(exposure).toBeFocused()
    await click(page.getByRole('tab', { name: 'Coverage', exact: true }))
    await click(page.getByRole('button', { name: 'Paint', exact: true }))
    await expect(canvas).toHaveAttribute('data-editing', 'ready')
    await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '2')
    const stageBefore = await page.locator('[data-hover-controls]').boundingBox(),
      histogramBefore = await page.getByTestId('inspector-pinned').boundingBox(),
      box = (await page.getByTestId('preview-viewport').boundingBox())!,
      x = Math.round(box.x + box.width / 2),
      y = Math.round(box.y + box.height / 2)
    await send([
      { type: 'mouseMove', x: x - 18, y },
      { type: 'mouseDown', x: x - 18, y, button: 'left', clickCount: 1 },
    ])
    for (let step = 0; step < 6; step++)
      await send([{ type: 'mouseMove', x: x - 18 + step * 6, y: y + step * 2, button: 'left' }])
    expect((await history()).revision).toBe(2)
    await send([{ type: 'mouseUp', x: x + 12, y: y + 10, button: 'left', clickCount: 1 }])
    await expect.poll(history).toMatchObject({ revision: 3 })
    const head = (await history()).settings.maskStack[0].head
    expect(head).toMatch(/^[a-f0-9]{64}$/)
    await expect(canvas).toBeFocused()
    await key('Space')
    await key('Right')
    await key('Down')
    expect((await history()).revision).toBe(3)
    await key('Escape')
    await expect(canvas).toHaveAttribute('data-gesturing', 'false')
    expect((await history()).settings.maskStack[0].head).toBe(head)
    await click(page.getByRole('button', { name: 'Create mask', exact: true }))
    await click(
      page
        .getByRole('menu', { name: 'Create mask', exact: true })
        .getByRole('menuitem', { name: 'Brush', exact: true }),
    )
    await expect.poll(history).toMatchObject({ revision: 4 })
    const second = (await history()).settings.maskStack[0].id
    await click(page.getByRole('button', { name: 'Actions for Mask 2', exact: true }))
    await click(page.getByRole('menu').getByRole('menuitem', { name: 'Move down', exact: true }))
    await expect.poll(history).toMatchObject({ revision: 5 })
    expect((await history()).settings.maskStack.map((mask) => mask.id)).toEqual([first, second])
    await key('Z', process.platform === 'darwin' ? ['meta'] : ['control'])
    await expect.poll(history).toMatchObject({ revision: 6 })
    expect((await history()).settings.maskStack.map((mask) => mask.id)).toEqual([second, first])
    await click(page.getByRole('tab', { name: 'Adjustments', exact: true }))
    await page
      .getByRole('spinbutton', { name: 'Local Blacks value', exact: true })
      .scrollIntoViewIfNeeded()
    await expect(
      page.getByRole('spinbutton', { name: 'Local Blacks value', exact: true }),
    ).toBeVisible()
    expect(await page.locator('[data-hover-controls]').boundingBox()).toEqual(stageBefore)
    expect(await page.getByTestId('inspector-pinned').boundingBox()).toEqual(histogramBefore)
    await page.getByRole('tab', { name: 'Info', exact: true }).focus()
    await expect(page.getByRole('tab', { name: 'Info', exact: true })).toBeInViewport()
    await page.getByRole('tab', { name: 'Masks', exact: true }).focus()
    await page.screenshot({ path: info.outputPath('masks-minimum-console.png'), scale: 'css' })
    await writeFile(
      info.outputPath('masks-native.json'),
      JSON.stringify(
        {
          content: [1100, 700],
          stage: stageBefore,
          histogram: histogramBefore,
          history: (await history()).revision,
          focus: await native.evaluate((window) => ({
            window: window.isFocused(),
            contents: window.webContents.isFocused(),
          })),
          evidence:
            'Electron native event routing; physical mouse and keyboard devices are not certified.',
        },
        null,
        2,
      ),
    )
  },
)
