import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { captureWindow } from './window-capture.helpers'
import { createMask, maskDetailTab } from './mask-panel.helpers'

async function drawBox(page: Page) {
  const box = (await page.getByTestId('object-selection-overlay').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 3 })
  await page.mouse.up()
}

test('object proposals require visible coverage and explicit acceptance, then share Paint and photo Undo', async ({
  irodori: { app, page },
}, testInfo) => {
  test.setTimeout(90000)
  await importPhotos(
    app,
    page,
    ['assets/tests/images/raster/wikimedia/object-selection/originals/Mug_image.jpg'],
    true,
    'keyboard',
  )
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((native) => native.setContentSize(1100, 700))
  await activateButton(page.getByTestId('console-toggle'))
  await navigateInspector(page, 'Masks')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await createMask(page, 'Select object…')
  await expect(page.getByRole('checkbox', { name: 'Show overlay', exact: true })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Show overlay', exact: true })).toBeDisabled()
  const overlay = page.getByTestId('object-selection-overlay')
  await expect(overlay).toHaveAttribute('data-matching-grid', 'true')
  await expect(page.getByRole('tab', { name: 'Coverage', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await drawBox(page)
  expect((await history()).revision).toBe(0)
  const pinnedLayout = async (stage: string) => {
    const layout = await page.evaluate(() => {
      const read = (element: Element | null) => {
        if (!element) return null
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element)
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          overflowY: style.overflowY,
        }
      }
      const panel = document.querySelector('[data-testid="masks-panel"]')!
      const create = panel.querySelector('[aria-label="Create mask"]')!
      return {
        viewport: [innerWidth, innerHeight],
        inspector: read(document.querySelector('[data-testid="adjustments-panel"]')),
        outerScroll: read(document.querySelector('[data-testid="inspector-scroll"]')),
        panel: read(panel),
        header: read(create.parentElement),
        create: read(create),
        list: read(document.querySelector('[data-testid="masks-list"]')),
        details: read(document.querySelector('[data-testid="mask-details-scroll"]')),
        rail: read(document.querySelector('[role="tablist"][aria-label="Editing groups"]')),
      }
    })
    await testInfo.attach(`mask-layout-${stage}`, {
      body: JSON.stringify(layout, null, 2),
      contentType: 'application/json',
    })
    await expect(page.getByRole('button', { name: 'Create mask', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(page.getByRole('tab', { name: 'Masks', exact: true })).toBeInViewport({ ratio: 1 })
    await expect
      .poll(() => page.getByTestId('inspector-scroll').evaluate((element) => element.scrollTop))
      .toBe(0)
  }
  const createSelection = page.getByRole('button', { name: 'Create selection', exact: true })
  await createSelection.focus()
  await pinnedLayout('selection-action-focused')
  await activateButton(createSelection)
  const use = page.getByRole('button', { name: 'Use mask', exact: true })
  await expect(use).toBeEnabled({ timeout: 60000 })
  await expect(page.getByRole('button', { name: 'Create selection', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Update selection', exact: true })).toBeEnabled()
  expect((await history()).settings.maskStack).toEqual([])
  await expect(page.getByTestId('mask-coverage-overlay')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  const selectionControls = (await page.getByTestId('object-selection-controls').boundingBox())!
  expect(selectionControls.x + selectionControls.width).toBeLessThanOrEqual(1100)
  await pinnedLayout('proposal-ready')
  await captureWindow(app, page, testInfo.outputPath('1100-console-object-selection.png'))
  await activateButton(use)
  await expect.poll(history).toMatchObject({ revision: 1 })
  const created = (await history()).settings.maskStack[0]
  expect(created.base?.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(created.head).toBeNull()
  await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await maskDetailTab(page, 'Coverage')
  await expect(
    page.getByRole('button', { name: 'Refine object selection…', exact: true }),
  ).toBeEnabled()
  const paint = page.getByRole('button', { name: 'Paint', exact: true })
  if ((await paint.getAttribute('aria-pressed')) !== 'true') await activateButton(paint)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await canvas.focus()
  await canvas.press('Space')
  await canvas.press('ArrowRight')
  await canvas.press('Space')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const painted = (await history()).settings.maskStack[0]
  expect(painted.head).toMatch(/^[a-f0-9]{64}$/)
  expect(painted.base).toEqual(created.base)
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 3 })
  expect((await history()).settings.maskStack[0]).toMatchObject({ head: null, base: created.base })
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 4 })
  await activateButton(page.getByRole('button', { name: 'Refine object selection…', exact: true }))
  await expect(overlay).toHaveAttribute('data-matching-grid', 'true')
  await expect(page.getByRole('tab', { name: 'Coverage', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await drawBox(page)
  await activateButton(page.getByRole('button', { name: 'Create selection', exact: true }))
  await expect(use).toBeEnabled({ timeout: 60000 })
  await activateButton(use)
  await expect(overlay).not.toBeVisible()
  expect((await history()).settings.maskStack[0]).toMatchObject({
    id: created.id,
    head: painted.head,
  })
})

test('guide drafts cancel cleanly, enforce point capacity and keep tools exclusive', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await createMask(page, 'Select object…')
  const overlay = page.getByTestId('object-selection-overlay')
  await expect(overlay).toHaveAttribute('data-matching-grid', 'true')
  await expect(page.getByRole('tab', { name: 'Coverage', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await drawBox(page)
  const frame = page.getByTestId('object-selection-box')
  const original = await frame.boundingBox()
  const area = (await overlay.boundingBox())!
  await page.mouse.move(area.x + area.width * 0.25, area.y + area.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(area.x + area.width * 0.5, area.y + area.height * 0.7)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await frame.boundingBox()).toEqual(original)
  await activateButton(page.getByRole('button', { name: 'Include', exact: true }))
  for (let index = 0; index < 4; index++)
    await overlay.click({ position: { x: area.width * 0.5 + index * 3, y: area.height * 0.5 } })
  await expect(
    page
      .getByRole('group', { name: 'Object selection guides', exact: true })
      .getByLabel(/Include point/),
  ).toHaveCount(4)
  await overlay.click({ position: { x: area.width * 0.6, y: area.height * 0.5 } })
  await expect(page.getByRole('alert').filter({ hasText: 'Four guide points' })).toBeVisible()
  await activateButton(page.getByRole('button', { name: 'Remove last point', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Exclude', exact: true }))
  await overlay.click({ position: { x: area.width * 0.65, y: area.height * 0.4 } })
  await expect(page.getByLabel('Exclude point 4', { exact: true })).toBeVisible()
  await activateButton(page.getByRole('button', { name: 'Cancel selection', exact: true }))
  await expect(overlay).not.toBeVisible()
  expect((await history()).revision).toBe(0)
  await activateButton(page.getByRole('button', { name: 'Inspect region', exact: true }))
  await expect(page.getByTestId('inspection-region-overlay')).toBeVisible()
  await createMask(page, 'Select object…')
  await expect(page.getByTestId('inspection-region-overlay')).not.toBeVisible()
  await expect(overlay).toHaveAttribute('data-matching-grid', 'true')
  await overlay.focus()
  await page.keyboard.press('Escape')
  await expect(overlay).not.toBeVisible()
})
