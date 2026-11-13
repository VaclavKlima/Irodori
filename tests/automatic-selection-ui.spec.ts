import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask } from './mask-panel.helpers'

test('Select Sky starts without guides, requires visible acceptance, and retains independent corrections through refinement and restart', async ({
  irodori,
}) => {
  test.setTimeout(120000)
  const { app } = irodori
  let { page } = irodori
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(
    app,
    page,
    [
      'assets/tests/images/raster/wikimedia/sky-selection/originals/Sunset_through_branches_0528.jpg',
    ],
    true,
    'keyboard',
  )
  await activateButton(page.getByTestId('console-toggle'))
  await navigateInspector(page, 'Masks')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await createMask(page, 'Select Sky')
  const use = page.getByRole('button', { name: 'Use mask', exact: true })
  await expect(use).toBeEnabled({ timeout: 60000 })
  await expect(page.getByTestId('object-selection-overlay')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Selection guides', exact: true })).toHaveCount(0)
  expect((await history()).settings.maskStack).toEqual([])
  // Check the actual button bounds against the viewport and every clipping owner.
  const bounds = await use.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    let left = Math.max(0, rect.left),
      top = Math.max(0, rect.top)
    let right = Math.min(innerWidth, rect.right),
      bottom = Math.min(innerHeight, rect.bottom)
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        box = parent.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left)
        right = Math.min(right, box.right)
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top)
        bottom = Math.min(bottom, box.bottom)
      }
    }
    return {
      width: rect.width,
      height: rect.height,
      visibleWidth: right - left,
      visibleHeight: bottom - top,
    }
  })
  expect(bounds.width).toBeGreaterThan(0)
  expect(bounds.visibleWidth).toBeCloseTo(bounds.width, 0)
  expect(bounds.visibleHeight).toBeCloseTo(bounds.height, 0)
  await expect(page.getByTestId('mask-coverage-overlay')).toBeVisible()
  await activateButton(use)
  await expect.poll(history).toMatchObject({ revision: 1 })
  await expect(use).toHaveCount(0)
  const created = (await history()).settings.maskStack[0]
  expect(created).toMatchObject({ name: 'Sky', head: null, resultHead: null })
  expect(created.base).toBeTruthy()
  const painted = await page.evaluate(
    async ({ photoId, id }) => {
      const before = await window.irodori.getEditHistory(photoId)
      return window.irodori.mutateMasks(photoId, before.revision, {
        operations: [
          {
            kind: 'stroke',
            id,
            stroke: {
              mode: 'subtract',
              radius: 0.025,
              feather: 0.5,
              points: [{ x: 0.51, y: 0.5 }],
            },
          },
        ],
      })
    },
    { photoId, id: created.id },
  )
  expect(painted.settings.maskStack[0].base).toEqual(created.base)
  expect(painted.settings.maskStack[0].resultHead).toBeTruthy()
  const refined = await page.evaluate(
    async ({ photoId, id }) => {
      const state = await window.irodori.getEditHistory(photoId)
      const context = await window.irodori.getObjectSelectionContext(photoId, state.revision)
      const proposal = await window.irodori.createObjectSelection({
        photoId,
        expectedRevision: state.revision,
        gridIdentity: context.gridIdentity,
        selection: 'sky',
        prompts: { positivePoints: [], negativePoints: [] },
        maskId: id,
      })
      return window.irodori.acceptObjectSelection({
        photoId,
        expectedRevision: state.revision,
        proposalId: proposal.id,
      })
    },
    { photoId, id: created.id },
  )
  expect(refined.settings.maskStack[0]).toMatchObject({
    id: created.id,
    resultHead: painted.settings.maskStack[0].resultHead,
  })
  expect(refined.revision).toBe(painted.revision + 1)
  await expect.poll(history).toMatchObject({ revision: refined.revision })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: refined.revision + 1 })
  expect((await history()).settings.maskStack[0].resultHead).toBe(
    painted.settings.maskStack[0].resultHead,
  )
  expect((await history()).settings.maskStack[0].base).toEqual(created.base)
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: refined.revision + 2 })
  ;({ page } = await irodori.restart())
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 30000,
  })
  expect((await history()).settings.maskStack[0]).toEqual(refined.settings.maskStack[0])
})

test('no-sky failures preserve an existing mask and keep acceptance unavailable', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(
    app,
    page,
    ['assets/tests/images/raster/wikimedia/object-selection/originals/Mug_image.jpg'],
    true,
    'keyboard',
  )
  await navigateInspector(page, 'Masks')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await createMask(page, 'Brush')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const before = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await createMask(page, 'Select Sky')
  await expect(page.getByRole('alert')).toContainText('No sky was found', { timeout: 60000 })
  await expect(page.getByRole('button', { name: 'Use mask', exact: true })).toHaveCount(0)
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)).toEqual(before)
  await activateButton(page.getByRole('button', { name: 'Cancel selection', exact: true }))
  await expect(page.getByTestId('object-selection-controls')).toHaveCount(0)
})
