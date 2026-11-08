import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask, maskAction, maskDetailTab } from './mask-panel.helpers'
import { captureWindow } from './window-capture.helpers'

test('multiple masks, keyboard strokes and ordering share photo history and restart recovery', async ({
  irodori,
}) => {
  test.setTimeout(90000)
  let { page } = irodori
  await importPhotos(
    irodori.app,
    page,
    ['tests/fixtures/photos/forest-light.jpg'],
    true,
    'keyboard',
  )
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 1 })
  const first = (await history()).settings.maskStack[0].id
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 2 })
  const second = (await history()).settings.maskStack[0].id
  await maskDetailTab(page, 'Adjustments')
  const exposure = page.getByRole('spinbutton', { name: 'Local Exposure value', exact: true })
  await exposure.fill('1.25')
  expect((await history()).revision).toBe(2)
  await exposure.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  expect((await history()).settings.maskStack[0].light.exposureEv).toBe(1.25)
  await expect(
    page.getByRole('region', { name: 'Histogram · After', exact: true }).getByRole('status'),
  ).toHaveText('After / sRGB · SDR')
  await expect(
    page.getByRole('slider', { name: 'Histogram tonal value' }).locator('path[d]'),
  ).toHaveCount(3)
  const canvas = () => page.getByTestId('main-preview')
  await expect(canvas()).toHaveAttribute('data-editing', 'ready')
  await expect(canvas()).toHaveAttribute('data-frame-geometry-revision', '3')
  await maskDetailTab(page, 'Coverage')
  const paint = page.getByRole('button', { name: 'Paint', exact: true })
  await expect(paint).toBeEnabled()
  if ((await paint.getAttribute('aria-pressed')) !== 'true') await activateButton(paint)
  await canvas().focus()
  await page.keyboard.press('Space')
  await expect(canvas()).toHaveAttribute('data-gesturing', 'true')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  expect((await history()).revision).toBe(3)
  await page.keyboard.press('Space')
  await expect.poll(history).toMatchObject({ revision: 4 })
  const painted = (await history()).settings.maskStack[0].head
  expect(painted).toMatch(/^[a-f0-9]{64}$/)
  await expect(
    page.getByRole('region', { name: 'Histogram · After', exact: true }).getByRole('status'),
  ).toHaveText('After / sRGB · SDR')
  await expect(
    page.getByRole('slider', { name: 'Histogram tonal value' }).locator('path[d]'),
  ).toHaveCount(3)
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 5 })
  expect((await history()).settings.maskStack[0].head).toBeNull()
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 6 })
  expect((await history()).settings.maskStack[0].head).toBe(painted)
  await maskAction(page, 'Mask 2', 'Move down')
  await expect.poll(history).toMatchObject({ revision: 7 })
  expect((await history()).settings.maskStack.map((mask) => mask.id)).toEqual([first, second])
  await expect(canvas()).toHaveAttribute('data-frame-geometry-revision', '7')
  const handle = (await page
      .getByRole('button', { name: 'Drag to reorder Mask 2', exact: true })
      .boundingBox())!,
    target = (await page.locator(`[data-mask-id="${first}"]`).boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 })
  await expect(canvas()).toHaveAttribute('data-gesturing', 'true')
  expect((await history()).revision).toBe(7)
  await page.mouse.up()
  await expect.poll(history).toMatchObject({ revision: 8 })
  expect((await history()).settings.maskStack.map((mask) => mask.id)).toEqual([second, first])
  await canvas().focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Escape')
  expect((await history()).revision).toBe(8)
  const saved = (await history()).settings
  ;({ page } = await irodori.restart())
  await expect.poll(async () => (await history()).settings).toEqual(saved)
  await expect(page.getByRole('tab', { name: 'Masks', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByTestId('masks-panel')).toBeVisible()
  await maskDetailTab(page, 'Adjustments')
  await expect(
    page.getByRole('spinbutton', { name: 'Local Exposure value', exact: true }),
  ).toHaveValue('1.25')
})

test('mask management keeps light drafts, cancellation and independent identities coherent at minimum size', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const native = await app.browserWindow(page)
  await native.evaluate((window) => window.setContentSize(1100, 700))
  await activateButton(page.getByTestId('console-toggle'))
  await navigateInspector(page, 'Masks')
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 1 })
  const brushSize = page.getByRole('spinbutton', { name: 'Brush size value', exact: true })
  await brushSize.fill('17.5')
  await brushSize.press('Escape')
  await expect(brushSize).toHaveValue('10.0')
  await brushSize.fill('25')
  await brushSize.press('Enter')
  await expect
    .poll(
      async () => (await page.evaluate(() => window.irodori.getWorkspaceState())).state?.masks.size,
    )
    .toBe(25)
  expect((await history()).revision).toBe(1)
  await maskAction(page, 'Mask 1', 'Rename')
  await page.getByRole('textbox', { name: 'Mask name', exact: true }).fill('Trunk')
  await page.getByRole('textbox', { name: 'Mask name', exact: true }).press('Enter')
  await expect.poll(history).toMatchObject({ revision: 2 })
  await maskDetailTab(page, 'Adjustments')
  const exposure = page.getByRole('spinbutton', { name: 'Local Exposure value', exact: true })
  await exposure.fill('99')
  await exposure.press('Tab')
  expect((await history()).revision).toBe(2)
  await exposure.fill('0.75')
  await exposure.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await maskAction(page, 'Trunk', 'Duplicate')
  await expect.poll(history).toMatchObject({ revision: 4 })
  const stack = (await history()).settings.maskStack
  expect(stack.map((mask) => mask.name)).toEqual(['Trunk copy', 'Trunk'])
  expect(stack[0].id).not.toBe(stack[1].id)
  expect(stack[0].light).toEqual(stack[1].light)
  await maskAction(page, 'Trunk copy', 'Invert')
  await expect.poll(history).toMatchObject({ revision: 5 })
  expect((await history()).settings.maskStack.map((mask) => mask.inverted)).toEqual([true, false])
  await activateButton(page.getByRole('button', { name: 'Disable Trunk copy', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 6 })
  await maskAction(page, 'Trunk copy', 'Delete')
  await expect.poll(history).toMatchObject({ revision: 7 })
  expect((await history()).settings.maskStack.map((mask) => mask.name)).toEqual(['Trunk'])
  const bounds = await page.getByTestId('masks-panel').boundingBox()
  expect(bounds!.width).toBeLessThan(344)
  await page
    .getByRole('spinbutton', { name: 'Local Blacks value', exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole('spinbutton', { name: 'Local Blacks value', exact: true }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Info', exact: true }).focus()
  await expect(page.getByRole('tab', { name: 'Info', exact: true })).toBeInViewport()
})

test('mask menus, readable rows and independent detail scrolling fit the Console-open minimum window', async ({
  irodori: { app, page },
}, testInfo) => {
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const native = await app.browserWindow(page)
  await native.evaluate((window) => window.setContentSize(1100, 700))
  await activateButton(page.getByTestId('console-toggle'))
  await navigateInspector(page, 'Masks')
  const create = page.getByRole('button', { name: 'Create mask', exact: true })
  await expect(page.getByRole('button', { name: 'Select object', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('masks-panel')).toContainText('Create a mask')
  await expect(create).toHaveAttribute('aria-haspopup', 'menu')
  const alignment = await create.evaluate((button) => {
    const icon = button.querySelector('svg')!.getBoundingClientRect()
    const text = Array.from(button.childNodes).find(
      (node) => node.textContent?.trim() === 'Create mask',
    )!
    const range = document.createRange()
    range.selectNodeContents(text)
    const label = range.getBoundingClientRect()
    return {
      iconCenter: icon.y + icon.height / 2,
      textCenter: label.y + label.height / 2,
      gap: label.left - icon.right,
    }
  })
  expect(Math.abs(alignment.iconCenter - alignment.textCenter)).toBeLessThanOrEqual(2)
  expect(alignment.gap).toBeGreaterThanOrEqual(4)
  await create.focus()
  await create.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'Create mask', exact: true })
  await expect(menu.getByRole('menuitem')).toHaveCount(2)
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem').last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.type('br')
  await expect(menu.getByRole('menuitem', { name: 'Brush', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(create).toBeFocused()
  expect((await history()).revision).toBe(0)

  const longName =
    'Reflection in water beside the foreground bird with a long descriptive mask name'
  const ids = await page.evaluate(
    async ({ photoId, longName }) => {
      const names = [
        longName,
        'Water',
        'Bird',
        'Background',
        'Grasses',
        ...Array.from({ length: 27 }, (_, index) => `Mask ${index + 6}`),
      ]
      const operations = names.map((name) => ({
        kind: 'create' as const,
        id: crypto.randomUUID(),
        name,
      }))
      await window.irodori.mutateMasks(photoId, 0, { operations })
      return operations.map((operation) => operation.id)
    },
    { photoId, longName },
  )
  await expect.poll(history).toMatchObject({ revision: 1 })
  const list = page.getByTestId('masks-list')
  await expect(list.locator('[data-mask-id]')).toHaveCount(32)
  await activateButton(create)
  await expect(menu.getByRole('menuitem')).toHaveCount(2)
  for (const item of await menu.getByRole('menuitem').all())
    await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(menu).toContainText(/32/)
  await menu.getByRole('menuitem', { name: 'Brush', exact: true }).focus()
  await page.keyboard.press('Enter')
  expect((await history()).revision).toBe(1)
  await page.keyboard.press('Escape')
  const listDimensions = await list.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }))
  expect(listDimensions.height).toBeLessThanOrEqual(96)
  expect(listDimensions.scrollHeight).toBeGreaterThan(listDimensions.clientHeight)
  expect(listDimensions.overflow).toBe('auto')
  const longRow = list.locator(`[data-mask-id="${ids[0]}"]`)
  await activateButton(longRow.getByRole('button', { name: new RegExp(`^${longName}`) }))
  await expect(longRow.getByRole('button', { name: new RegExp(`^${longName}`) })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await maskDetailTab(page, 'Adjustments')
  await expect(page.getByRole('spinbutton', { name: 'Brush size value', exact: true })).toBeHidden()
  const rowText = await longRow.evaluate((row) => {
    const button = row.querySelector<HTMLButtonElement>('button[data-mask-select]')!
    const name = button.querySelector('span')!
    const metadata = button.querySelector('small')!
    return { name: getComputedStyle(name).fontSize, metadata: getComputedStyle(metadata).fontSize }
  })
  expect(rowText).toEqual({ name: '12px', metadata: '11px' })
  await maskAction(page, longName, 'Invert')
  await expect.poll(history).toMatchObject({ revision: 2 })
  await expect(longRow).toContainText('Inverted')
  await activateButton(longRow.getByRole('button', { name: `Disable ${longName}`, exact: true }))
  await expect.poll(history).toMatchObject({ revision: 3 })
  await expect(
    longRow.getByRole('button', { name: `Enable ${longName}`, exact: true }),
  ).toBeVisible()
  const rowActions = longRow.getByRole('button', { name: `Actions for ${longName}`, exact: true })
  await rowActions.focus()
  await rowActions.press('ArrowUp')
  const actions = page.getByRole('menu')
  await expect(actions.getByRole('menuitem').last()).toBeFocused()
  await expect(actions.getByRole('menuitem', { name: 'Uninvert', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(rowActions).toBeFocused()
  const listScroll = await list.evaluate((element) => element.scrollTop)
  const details = page.getByTestId('mask-details-scroll')
  await page
    .getByRole('spinbutton', { name: 'Local Blacks value', exact: true })
    .scrollIntoViewIfNeeded()
  expect(await details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await list.evaluate((element) => element.scrollTop)).toBe(listScroll)
  await expect(create).toBeInViewport()
  await expect(page.getByRole('tab', { name: 'Coverage', exact: true })).toBeInViewport()
  await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await captureWindow(app, page, testInfo.outputPath('1100-console-masks-adjustments.png'))
})

test('row actions retain their nonselected mask target and cancelled rename leaves history unchanged', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const selected = () =>
    page.evaluate(async () => (await window.irodori.getWorkspaceState()).state?.masks.selectedId)
  await navigateInspector(page, 'Masks')
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 1 })
  const first = (await history()).settings.maskStack[0].id
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 2 })
  const second = (await history()).settings.maskStack[0].id
  await maskDetailTab(page, 'Adjustments')
  const exposure = page.getByRole('spinbutton', { name: 'Local Exposure value', exact: true })
  await exposure.fill('0.75')
  await exposure.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  const saved = (await history()).settings.maskStack
  await expect.poll(selected).toBe(second)
  await maskAction(page, 'Mask 1', 'Rename')
  const name = page.getByRole('textbox', { name: 'Mask name', exact: true })
  await expect(name).toBeFocused()
  await name.fill('Discard this name')
  await name.press('Escape')
  await expect(name).toHaveCount(0)
  await expect(page.locator(`[data-mask-id="${first}"] [data-mask-select]`)).toBeFocused()
  expect((await history()).revision).toBe(3)
  expect((await history()).settings.maskStack).toEqual(saved)
  await expect.poll(selected).toBe(second)

  await maskAction(page, 'Mask 1', 'Duplicate')
  await expect.poll(history).toMatchObject({ revision: 4 })
  const duplicated = (await history()).settings.maskStack
  expect(duplicated.map((mask) => mask.name)).toEqual(['Mask 2', 'Mask 1 copy', 'Mask 1'])
  expect(duplicated[1].id).not.toBe(first)
  expect(duplicated[1].light).toEqual(saved.find((mask) => mask.id === first)!.light)
  expect(duplicated[0]).toEqual(saved.find((mask) => mask.id === second))
  await expect.poll(selected).toBe(duplicated[1].id)

  await activateButton(page.locator(`[data-mask-id="${second}"] [data-mask-select]`))
  await expect.poll(selected).toBe(second)
  await maskAction(page, 'Mask 1', 'Rename')
  await name.fill('Original region')
  await name.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 5 })
  expect((await history()).settings.maskStack.find((mask) => mask.id === first)?.name).toBe(
    'Original region',
  )
  await expect.poll(selected).toBe(second)
  await expect(exposure).toHaveValue('0.75')
  await maskAction(page, 'Mask 1 copy', 'Delete')
  await expect.poll(history).toMatchObject({ revision: 6 })
  expect((await history()).settings.maskStack.map((mask) => mask.id)).toEqual([second, first])
  await expect.poll(selected).toBe(second)
  await expect(exposure).toHaveValue('0.75')
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 7 })
  expect((await history()).settings.maskStack.find((mask) => mask.id === duplicated[1].id)).toEqual(
    duplicated[1],
  )
  await maskAction(page, 'Original region', 'Rename')
  await name.fill('Blur saved region')
  await name.press('Tab')
  const destination = page.locator(`[data-mask-id="${first}"] button[aria-haspopup="menu"]`)
  await expect(destination).toBeFocused()
  await expect.poll(history).toMatchObject({ revision: 8 })
  expect((await history()).settings.maskStack.find((mask) => mask.id === first)?.name).toBe(
    'Blur saved region',
  )
  await expect(destination).toBeFocused()
  await expect.poll(selected).toBe(second)
})
