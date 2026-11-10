import { expect } from '@playwright/test'
import { test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask, maskDetailTab } from './mask-panel.helpers'

async function openColor(page: import('@playwright/test').Page) {
  await maskDetailTab(page, 'Adjustments')
  const panel = page.getByTestId('masks-panel')
  const light = panel.getByRole('button', { name: 'Light', exact: true })
  if ((await light.getAttribute('aria-expanded')) === 'true') await activateButton(light)
  const color = panel.getByRole('button', { name: 'Color', exact: true })
  if ((await color.getAttribute('aria-expanded')) !== 'true') await activateButton(color)
}

test('relative masked color gestures, group reset and shared Undo persist independently of global color', async ({
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
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1')
  await canvas.focus()
  await canvas.press('Space')
  await canvas.press('ArrowRight')
  await canvas.press('Space')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const before = (await history()).settings
  await maskDetailTab(page, 'Adjustments')
  const color = page.getByTestId('masks-panel').getByRole('button', { name: 'Color', exact: true })
  await expect(color).toHaveAttribute('aria-expanded', 'false')
  const temperature = page.getByRole('spinbutton', { name: 'Local Temperature value', exact: true })
  const tint = page.getByRole('spinbutton', { name: 'Local Tint value', exact: true })
  const saturation = page.getByRole('spinbutton', { name: 'Local Saturation value', exact: true })
  await expect(temperature).toBeHidden()
  await openColor(page)
  for (const input of [temperature, tint, saturation]) {
    await expect(input).toHaveValue('0')
    await expect(input).toHaveAttribute('min', '-100')
    await expect(input).toHaveAttribute('max', '100')
    await expect(input).toHaveAttribute('step', '1')
  }
  await temperature.fill('17')
  expect((await history()).revision).toBe(2)
  await temperature.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await expect(temperature).toHaveValue('17')
  await expect(temperature).toBeFocused()
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '3')
  await tint.fill('-7')
  await tint.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 4 })
  await saturation.fill('-18')
  await saturation.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 5 })
  await temperature.fill('101')
  await temperature.press('Tab')
  await expect(temperature).toHaveValue('17')
  await temperature.fill('-6')
  await temperature.press('Escape')
  await expect(temperature).toHaveValue('17')
  expect((await history()).revision).toBe(5)
  const slider = page.getByRole('slider', { name: 'Local Temperature', exact: true })
  await slider.focus()
  for (let index = 0; index < 3; index++) await page.keyboard.down('ArrowRight')
  expect((await history()).revision).toBe(5)
  await page.keyboard.up('ArrowRight')
  await expect.poll(history).toMatchObject({ revision: 6 })
  const edited = (await history()).settings.maskStack[0]
  expect(edited.color).toEqual({ temperature: 20, tint: -7, saturation: -18 })
  expect(edited.head).toBe(before.maskStack[0].head)
  expect(edited.light).toEqual(before.maskStack[0].light)
  await activateButton(page.getByRole('button', { name: 'Reset mask Color', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 7 })
  expect((await history()).settings.maskStack[0].color).toEqual({
    temperature: 0,
    tint: 0,
    saturation: 0,
  })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 8 })
  expect((await history()).settings.maskStack[0]).toEqual(edited)
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 9 })
  await expect(temperature).toHaveValue('0')
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 10 })
  const saved = (await history()).settings
  expect(saved.whiteBalance).toEqual(before.whiteBalance)
  expect(saved.saturation).toBe(before.saturation)
  ;({ page } = await irodori.restart())
  await expect.poll(async () => (await history()).settings).toEqual(saved)
  await expect(
    page.getByTestId('masks-panel').getByRole('button', { name: 'Color', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  await openColor(page)
  await expect(
    page.getByRole('spinbutton', { name: 'Local Temperature value', exact: true }),
  ).toHaveValue('20')
  await expect(page.getByRole('spinbutton', { name: 'Local Tint value', exact: true })).toHaveValue(
    '-7',
  )
  await expect(
    page.getByRole('spinbutton', { name: 'Local Saturation value', exact: true }),
  ).toHaveValue('-18')
})

test('local color drafts flush to their selected mask and external revisions replace stale fields', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await createMask(page)
  const first = (await history()).settings.maskStack[0].id
  await openColor(page)
  const temperature = page.getByRole('spinbutton', { name: 'Local Temperature value', exact: true })
  const tint = page.getByRole('spinbutton', { name: 'Local Tint value', exact: true })
  await temperature.fill('15')
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 3 })
  const stack = (await history()).settings.maskStack
  const second = stack[0].id
  expect(stack.find((mask) => mask.id === first)?.color.temperature).toBe(15)
  expect(stack.find((mask) => mask.id === second)?.color.temperature).toBe(0)
  await activateButton(page.locator(`[data-mask-id="${first}"] [data-mask-select]`))
  await openColor(page)
  await tint.fill('5')
  await page.evaluate(
    async ({ photoId, first }) => {
      const state = await window.irodori.getEdits(photoId)
      await window.irodori.mutateMasks(photoId, state.revision, {
        operations: [{ kind: 'update', id: first, color: { saturation: -4 } }],
      })
    },
    { photoId, first },
  )
  await expect.poll(history).toMatchObject({ revision: 4 })
  await expect(tint).toHaveValue('0')
  await expect(
    page.getByRole('spinbutton', { name: 'Local Saturation value', exact: true }),
  ).toHaveValue('-4')
  await tint.press('Tab')
  expect((await history()).revision).toBe(4)
  await temperature.fill('21')
  await maskDetailTab(page, 'Coverage')
  await expect.poll(history).toMatchObject({ revision: 5 })
  expect((await history()).settings.maskStack.find((mask) => mask.id === first)?.color).toEqual({
    temperature: 21,
    tint: 0,
    saturation: -4,
  })
  await openColor(page)
  await temperature.fill('22')
  await navigateInspector(page, 'Light')
  await expect.poll(history).toMatchObject({ revision: 6 })
  expect(
    (await history()).settings.maskStack.find((mask) => mask.id === first)?.color.temperature,
  ).toBe(22)
  await navigateInspector(page, 'Masks')
  await openColor(page)
  await expect(temperature).toHaveValue('22')
  await activateButton(page.getByRole('button', { name: 'Reset mask Light', exact: true }))
  expect((await history()).settings.maskStack.find((mask) => mask.id === first)?.color).toEqual({
    temperature: 22,
    tint: 0,
    saturation: -4,
  })
})
