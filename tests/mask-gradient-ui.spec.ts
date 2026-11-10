import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'
import { maskAction, maskDetailTab } from './mask-panel.helpers'
import { foregroundTest } from './foreground'
import { captureWindow } from './window-capture.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'

async function armGradient(page: Page, kind: 'Linear' | 'Radial') {
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await activateButton(page.getByRole('button', { name: 'Create mask', exact: true }))
  await activateButton(
    page
      .getByRole('menu', { name: 'Create mask', exact: true })
      .getByRole('menuitem', { name: `${kind} gradient`, exact: true }),
  )
  await expect(page.getByRole('button', { name: 'Place centered', exact: true })).toBeVisible()
}

async function ready(page: Page, revision: number) {
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect(page.getByTestId('main-preview')).toHaveAttribute(
    'data-frame-geometry-revision',
    String(revision),
  )
}

test('linear keyboard creation, pixel geometry and neutral history survive Undo, Redo and restart', async ({
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
  await armGradient(page, 'Linear')
  expect((await history()).revision).toBe(0)
  await page.getByTestId('main-preview').press('Escape')
  await expect(page.getByRole('button', { name: 'Place centered', exact: true })).toHaveCount(0)
  expect((await history()).settings.maskStack).toHaveLength(0)
  await armGradient(page, 'Linear')
  await activateButton(page.getByRole('button', { name: 'Place centered', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 1 })
  const created = (await history()).settings.maskStack[0]
  expect(created.gradient).toMatchObject({ kind: 'linear' })
  expect(Object.values(created.light)).toEqual([0, 0, 0, 0, 0, 0])
  expect(Object.values(created.color)).toEqual([0, 0, 0])
  expect(created.head).toBeNull()
  await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('checkbox', { name: 'Show overlay', exact: true })).toBeChecked()
  await ready(page, 1)
  await maskDetailTab(page, 'Coverage')
  await expect(page.getByRole('button', { name: 'Edit gradient', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await activateButton(page.getByRole('button', { name: 'Geometry', exact: true }))
  const startX = page.getByRole('spinbutton', { name: 'Start X value', exact: true })
  await expect(startX).toBeEnabled()
  const originalX = await startX.inputValue()
  await startX.fill('111')
  expect((await history()).revision).toBe(1)
  await startX.press('Escape')
  await expect(startX).toHaveValue(originalX)
  await startX.fill('-100')
  await startX.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const changed = (await history()).settings.maskStack[0]
  expect(changed.gradient?.kind).toBe('linear')
  if (changed.gradient?.kind !== 'linear') throw new Error('Expected linear geometry.')
  expect(changed.gradient.start.x).toBeLessThan(0)
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 3 })
  expect((await history()).settings.maskStack[0]).toEqual(created)
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 4 })
  expect((await history()).settings.maskStack).toHaveLength(0)
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 5 })
  expect((await history()).settings.maskStack[0]).toEqual(created)
  const saved = (await history()).settings
  ;({ page } = await irodori.restart())
  await expect.poll(async () => (await history()).settings).toEqual(saved)
  await navigateInspector(page, 'Masks')
  await maskDetailTab(page, 'Coverage')
  await expect(page.getByRole('button', { name: 'Geometry', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
})

test('radial Feather extremes, geometry, Paint corrections and duplication share one mask history', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await armGradient(page, 'Radial')
  await activateButton(page.getByRole('button', { name: 'Place centered', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 1 })
  expect((await history()).settings.maskStack[0].gradient).toMatchObject({
    kind: 'radial',
    feather: 50,
    rotation: 0,
  })
  await ready(page, 1)
  await maskDetailTab(page, 'Coverage')
  const feather = page.getByRole('spinbutton', { name: 'Gradient feather value', exact: true })
  for (const [value, revision] of [
    [0, 2],
    [100, 3],
  ]) {
    await feather.fill(String(value))
    await feather.press('Enter')
    await expect.poll(history).toMatchObject({ revision })
    expect((await history()).settings.maskStack[0].gradient).toMatchObject({ feather: value })
    await ready(page, revision)
  }
  await activateButton(page.getByRole('button', { name: 'Geometry', exact: true }))
  const rotation = page.getByRole('spinbutton', { name: 'Rotation value', exact: true })
  await rotation.fill('35')
  await rotation.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 4 })
  await ready(page, 4)
  await activateButton(page.getByRole('button', { name: 'Paint', exact: true }))
  await expect(page.getByRole('button', { name: 'Edit gradient', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  const canvas = page.getByTestId('main-preview')
  await canvas.focus()
  await canvas.press('Space')
  await canvas.press('ArrowRight')
  await canvas.press('Space')
  await expect.poll(history).toMatchObject({ revision: 5 })
  const painted = (await history()).settings.maskStack[0]
  expect(painted.head).toMatch(/^[a-f0-9]{64}$/)
  await ready(page, 5)
  await activateButton(page.getByRole('button', { name: 'Edit gradient', exact: true }))
  await expect(page.getByRole('button', { name: 'Paint', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await maskAction(page, painted.name, 'Duplicate')
  await expect.poll(history).toMatchObject({ revision: 6 })
  const duplicate = (await history()).settings.maskStack.find((mask) => mask.id !== painted.id)!
  expect(duplicate.gradient).toEqual(painted.gradient)
  expect(duplicate.head).toBe(painted.head)
})

test('pointer creation, handle drags and repeated keyboard gestures commit once and cancel safely', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await armGradient(page, 'Linear')
  const overlay = page.getByTestId('gradient-overlay')
  const bounds = (await overlay.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const top = bounds.y + bounds.height * 0.35
  const bottom = bounds.y + bounds.height * 0.65
  await page.mouse.move(x, top)
  await page.mouse.down()
  await page.mouse.move(x + 12, bottom, { steps: 4 })
  expect((await history()).revision).toBe(0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect((await history()).settings.maskStack).toHaveLength(0)
  await armGradient(page, 'Linear')
  await page.mouse.move(x, top)
  await page.mouse.down()
  await page.mouse.up()
  expect((await history()).settings.maskStack).toHaveLength(0)
  await page.mouse.move(x, top)
  await page.mouse.down()
  await page.mouse.move(x + 12, bottom, { steps: 4 })
  await page.mouse.up()
  await expect.poll(history).toMatchObject({ revision: 1 })
  await ready(page, 1)
  await maskDetailTab(page, 'Coverage')
  const start = page.getByRole('button', { name: 'Gradient start handle', exact: true })
  const end = page.getByRole('button', { name: 'Gradient end handle', exact: true })
  await expect(start).toBeVisible()
  const created = (await history()).settings.maskStack[0].gradient
  await start.focus()
  for (let i = 0; i < 3; i++) await page.keyboard.down('ArrowRight')
  expect((await history()).revision).toBe(1)
  await page.keyboard.up('ArrowRight')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const stepped = (await history()).settings.maskStack[0].gradient
  expect(stepped).not.toEqual(created)
  await ready(page, 2)
  const endBox = (await end.boundingBox())!
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(endBox.x + 25, endBox.y + 10, { steps: 3 })
  expect((await history()).revision).toBe(2)
  await end.evaluate((element) =>
    element.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 })),
  )
  await page.mouse.up()
  expect((await history()).settings.maskStack[0].gradient).toEqual(stepped)
  await start.focus()
  await page.keyboard.down('Shift')
  await page.keyboard.down('ArrowDown')
  await page.keyboard.press('Escape')
  await page.keyboard.down('ArrowDown')
  await page.keyboard.up('ArrowDown')
  await page.keyboard.up('Shift')
  expect((await history()).revision).toBe(2)
  expect((await history()).settings.maskStack[0].gradient).toEqual(stepped)
  await start.focus()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.press('Control+z')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.up('ArrowRight')
  expect((await history()).revision).toBe(2)
  expect((await history()).settings.maskStack[0].gradient).toEqual(stepped)
  await start.focus()
  await start.press('Shift+ArrowDown')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 4 })
  expect((await history()).settings.maskStack[0].gradient).toEqual(stepped)
})

test(
  'gradient shape and native handle input remain usable at 1100 by 700 with Console open',
  foregroundTest(
    'Native minimum-size geometry, visible gradient guides and physical pointer routing require compositor presentation.',
  ),
  async ({ irodori: { app, page } }, testInfo) => {
    test.setTimeout(90000)
    await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
    const native = await app.browserWindow(page)
    await native.evaluate((window) => {
      window.setContentSize(1100, 700)
      window.show()
      window.focus()
    })
    await activateButton(page.getByTestId('console-toggle'))
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await focusPreviewWindow(app, page)
    await ready(page, 0)
    const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
    await navigateInspector(page, 'Masks')
    await ready(page, 0)
    await armGradient(page, 'Radial')
    await activateButton(page.getByRole('button', { name: 'Place centered', exact: true }))
    await expect.poll(history).toMatchObject({ revision: 1 })
    await ready(page, 1)
    await maskDetailTab(page, 'Coverage')
    const panel = page.getByTestId('masks-panel')
    await expect(panel.getByRole('button', { name: 'Create mask', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(page.getByRole('tab', { name: 'Coverage', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await page.getByRole('button', { name: 'Edit gradient', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: 'Edit gradient', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(page.getByRole('button', { name: 'Geometry', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    const center = page.getByRole('button', { name: 'Gradient move handle', exact: true })
    await expect(center).toBeInViewport({ ratio: 1 })
    const before = (await history()).settings.maskStack[0].gradient
    const box = (await center.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2 + 8, { steps: 5 })
    expect((await history()).revision).toBe(1)
    await page.mouse.up()
    await expect.poll(history).toMatchObject({ revision: 2 })
    expect((await history()).settings.maskStack[0].gradient).not.toEqual(before)
    await ready(page, 2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect(
      await page.getByTestId('inspector-scroll').evaluate((element) => element.scrollTop),
    ).toBe(0)
    await captureWindow(app, page, testInfo.outputPath('1100-console-radial-gradient.png'))
    await activateButton(page.getByRole('button', { name: 'Geometry', exact: true }))
    await page
      .getByRole('spinbutton', { name: 'Rotation value', exact: true })
      .scrollIntoViewIfNeeded()
    await expect(panel.getByRole('button', { name: 'Create mask', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(page.getByRole('tab', { name: 'Coverage', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(
      page.getByRole('spinbutton', { name: 'Rotation value', exact: true }),
    ).toBeInViewport({ ratio: 1 })
    expect(
      await page.getByTestId('inspector-scroll').evaluate((element) => element.scrollTop),
    ).toBe(0)
    await captureWindow(app, page, testInfo.outputPath('1100-console-gradient-geometry.png'))
  },
)
