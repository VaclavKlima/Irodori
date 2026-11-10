import { expect } from '@playwright/test'
import { test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask, maskDetailTab } from './mask-panel.helpers'
import { captureWindow } from './window-capture.helpers'
import { openPreviewOptions } from './preview-options.helpers'

import { foregroundTest } from './foreground'

const nativeLayout =
  process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)
    ? foregroundTest(
        'Wayland native resizing and stable layout require a window presented by the compositor.',
      )
    : {}

test('whole-mask edge inputs commit once, reset atomically and retain manual corrections through history and restart', async ({
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
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1')
  await canvas.focus()
  await canvas.press('Space')
  await canvas.press('ArrowRight')
  await canvas.press('Space')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const head = (await history()).settings.maskStack[0].head
  expect(head).toMatch(/^[a-f0-9]{64}$/)
  await maskDetailTab(page, 'Adjustments')
  const exposure = page.getByRole('spinbutton', { name: 'Local Exposure value', exact: true })
  await exposure.fill('0.75')
  await exposure.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await maskDetailTab(page, 'Coverage')
  const feather = page.getByRole('spinbutton', { name: 'Feather value', exact: true })
  const shift = page.getByRole('spinbutton', { name: 'Expand/Contract value', exact: true })
  await expect(feather).toHaveValue('0.0')
  await expect(shift).toHaveValue('0')
  await expect(feather).toHaveAttribute('max', '64')
  await expect(shift).toHaveAttribute('min', '-16')
  await feather.fill('3.5')
  expect((await history()).settings.maskStack[0].edge).toEqual({ featherPx: 0, shiftPx: 0 })
  expect((await history()).revision).toBe(3)
  await feather.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 4 })
  await expect(feather).toHaveValue('3.5')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await shift.fill('2')
  await shift.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 5 })
  const edited = (await history()).settings.maskStack[0]
  expect(edited.edge).toEqual({ featherPx: 3.5, shiftPx: 2 })
  expect(edited.head).toBe(head)
  expect(edited.light.exposureEv).toBe(0.75)
  expect(edited).not.toHaveProperty('preparedCoverage')
  await activateButton(page.getByRole('button', { name: 'Reset mask edges', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 6 })
  expect((await history()).settings.maskStack[0].edge).toEqual({ featherPx: 0, shiftPx: 0 })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 7 })
  expect((await history()).settings.maskStack[0].edge).toEqual(edited.edge)
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 8 })
  await expect(feather).toHaveValue('0.0')
  await shift.fill('-1')
  await shift.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 9 })
  await feather.fill('65')
  await feather.press('Tab')
  await expect(feather).toHaveValue('0.0')
  expect((await history()).revision).toBe(9)
  await shift.fill('-3')
  await shift.press('Escape')
  await expect(shift).toHaveValue('-1')
  expect((await history()).revision).toBe(9)
  const settings = (await history()).settings
  ;({ page } = await irodori.restart())
  await expect.poll(async () => (await history()).settings).toEqual(settings)
  await expect(page.getByRole('spinbutton', { name: 'Feather value', exact: true })).toHaveValue(
    '0.0',
  )
  await expect(
    page.getByRole('spinbutton', { name: 'Expand/Contract value', exact: true }),
  ).toHaveValue('-1')
  expect((await history()).settings.maskStack[0].head).toBe(head)
})

test(
  'edge drafts stay on their mask, external revisions replace drafts and Coverage remains usable at the Console-open minimum',
  nativeLayout,
  async ({ irodori: { app, page } }, testInfo) => {
    test.setTimeout(90000)
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
    const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
    await navigateInspector(page, 'Masks')
    await createMask(page)
    await expect.poll(history).toMatchObject({ revision: 1 })
    const first = (await history()).settings.maskStack[0].id
    await createMask(page)
    await expect.poll(history).toMatchObject({ revision: 2 })
    const second = (await history()).settings.maskStack[0].id
    const feather = page.getByRole('spinbutton', { name: 'Feather value', exact: true })
    const shift = page.getByRole('spinbutton', { name: 'Expand/Contract value', exact: true })
    await feather.fill('2.5')
    await activateButton(page.locator(`[data-mask-id="${first}"] [data-mask-select]`))
    await expect.poll(history).toMatchObject({ revision: 3 })
    const stack = (await history()).settings.maskStack
    expect(stack.find((mask) => mask.id === second)?.edge).toEqual({ featherPx: 2.5, shiftPx: 0 })
    expect(stack.find((mask) => mask.id === first)?.edge).toEqual({ featherPx: 0, shiftPx: 0 })
    await expect(feather).toHaveValue('0.0')
    await feather.fill('1.5')
    await page.evaluate(
      async ({ photoId, first }) => {
        const state = await window.irodori.getEdits(photoId)
        await window.irodori.mutateMasks(photoId, state.revision, {
          operations: [{ kind: 'update', id: first, edge: { shiftPx: -2 } }],
        })
      },
      { photoId, first },
    )
    await expect.poll(history).toMatchObject({ revision: 4 })
    await expect(feather).toHaveValue('0.0')
    await expect(shift).toHaveValue('-2')
    await shift.press('Tab')
    expect((await history()).revision).toBe(4)
    await createMask(page, 'Select object…')
    await expect(page.getByTestId('object-selection-overlay')).toBeVisible()
    await expect(feather).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await activateButton(page.getByRole('button', { name: 'Cancel selection', exact: true }))
    await expect(feather).toHaveValue('0.0')
    await expect(shift).toHaveValue('-2')
    expect((await history()).revision).toBe(4)
    const native = await app.browserWindow(page)
    await native.evaluate((window) => window.setContentSize(1100, 700))
    await activateButton(page.getByTestId('console-toggle'))
    const list = page.getByTestId('masks-list')
    const listScroll = await list.evaluate((element) => element.scrollTop)
    await shift.scrollIntoViewIfNeeded()
    const panel = page.getByTestId('masks-panel')
    await expect(panel.getByRole('button', { name: 'Create mask', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(page.getByRole('tab', { name: 'Coverage', exact: true })).toBeInViewport({
      ratio: 1,
    })
    expect(await list.evaluate((element) => element.scrollTop)).toBe(listScroll)
    expect(
      await page.getByTestId('inspector-scroll').evaluate((element) => element.scrollTop),
    ).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await captureWindow(app, page, testInfo.outputPath('1100-console-mask-edges.png'))
    await page.getByTestId('mask-details-scroll').evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(page.getByRole('button', { name: 'Mask edges', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(feather).toBeInViewport({ ratio: 1 })
    await captureWindow(app, page, testInfo.outputPath('1100-console-mask-edges-top.png'))
  },
)

test('neutral Before renders while a real committed edge-coverage reply is pending', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  const center = () =>
    canvas.evaluate((element) => {
      const image = element as HTMLCanvasElement
      const x = Math.floor(image.width / 2) - 8,
        y = Math.floor(image.height / 2) - 8
      const gl = image.getContext('webgl2')
      if (gl) {
        const pixels = new Uint8Array(16 * 16 * 4)
        gl.readPixels(x, y, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        return Array.from(pixels)
      }
      return Array.from(image.getContext('2d')!.getImageData(x, y, 16, 16).data)
    })
  await expect
    .poll(async () => (await center()).some((value, index) => index % 4 !== 3 && value > 0))
    .toBe(true)
  const baseline = await center()
  await navigateInspector(page, 'Masks')
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 1 })
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1')
  await canvas.focus()
  await canvas.press('Space')
  await canvas.press('ArrowRight')
  await canvas.press('Space')
  await expect.poll(history).toMatchObject({ revision: 2 })
  await maskDetailTab(page, 'Adjustments')
  const exposure = page.getByRole('spinbutton', { name: 'Local Exposure value', exact: true })
  await exposure.fill('0.75')
  await exposure.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await expect.poll(center).not.toEqual(baseline)
  await maskDetailTab(page, 'Coverage')
  const gate = await app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get('masks:coverage')!
    let held = false,
      release: (() => void) | undefined,
      error = ''
    const wrapper: Handler = async (...args) => {
      const result = await original(...args)
      error = String((result as { error?: string }).error ?? '')
      held = true
      await new Promise<void>((done) => {
        release = done
      })
      held = false
      return result
    }
    ipcMain.removeHandler('masks:coverage')
    ipcMain.handle('masks:coverage', wrapper)
    return {
      held() {
        return held
      },
      error() {
        return error
      },
      release() {
        release?.()
      },
      close() {
        release?.()
        if (handlers.get('masks:coverage') === wrapper) {
          ipcMain.removeHandler('masks:coverage')
          ipcMain.handle('masks:coverage', original)
        }
      },
    }
  })
  try {
    const feather = page.getByRole('spinbutton', { name: 'Feather value', exact: true })
    await feather.fill('2.5')
    await feather.press('Enter')
    await expect.poll(history).toMatchObject({ revision: 4 })
    await expect
      .poll(() => gate.evaluate((control) => control.held()), { timeout: 60000 })
      .toBe(true)
    await expect(page.getByTestId('mask-edge-pending')).toBeVisible()
    await openPreviewOptions(page)
    await activateButton(page.getByRole('button', { name: 'Before', exact: true }))
    await expect(canvas).toHaveAttribute('data-comparison', 'before')
    await expect.poll(center).toEqual(baseline)
    await expect(page.getByTestId('preview-gpu-error')).toHaveCount(0)
    expect(await gate.evaluate((control) => control.error())).toBe('')
    await gate.evaluate((control) => control.release())
    await openPreviewOptions(page)
    await activateButton(page.getByRole('button', { name: 'Before', exact: true }))
    await expect(canvas).toHaveAttribute('data-comparison', 'after')
    await expect.poll(center).not.toEqual(baseline)
    expect((await history()).revision).toBe(4)
  } finally {
    await gate.evaluate((control) => control.close())
    await gate.dispose()
  }
})
