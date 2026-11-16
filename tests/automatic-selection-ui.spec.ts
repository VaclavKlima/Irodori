import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask, maskDetailTab } from './mask-panel.helpers'

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

test('Select Background shares explicit root and compound acceptance, retained corrections, history and restart', async ({
  irodori,
}) => {
  test.setTimeout(240000)
  const { app } = irodori
  let { page } = irodori
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(
    app,
    page,
    [
      'assets/tests/images/raster/wikimedia/object-selection/originals/European_Robin_(Erithacus_rubecula)_with_mealworm.jpeg',
    ],
    true,
    'keyboard',
  )
  await activateButton(page.getByTestId('console-toggle'))
  await navigateInspector(page, 'Masks')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const ready = async (revision: number) => {
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-frame-geometry-revision',
      String(revision),
    )
  }
  const use = () => page.getByRole('button', { name: 'Use mask', exact: true })
  await ready(0)
  await createMask(page, 'Select Background')
  await expect(use()).toBeEnabled({ timeout: 60000 })
  await expect(use()).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('mask-coverage-overlay')).toBeVisible()
  await expect(page.getByTestId('object-selection-overlay')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Selection guides', exact: true })).toHaveCount(0)
  const untouched = await history()
  expect(untouched.revision).toBe(0)
  expect(untouched.settings.maskStack).toEqual([])
  const zoom = page.getByRole('combobox', { name: 'Preview zoom', exact: true })
  await zoom.selectOption('1')
  await expect
    .poll(() =>
      page
        .getByTestId('main-preview')
        .evaluate((canvas) => JSON.parse(canvas.dataset.presentedView ?? '{}').scale),
    )
    .toBe(1)
  await zoom.selectOption('fit')
  expect(await history()).toEqual(untouched)
  await activateButton(use())
  await expect.poll(history).toMatchObject({ revision: 1 })
  const created = (await history()).settings.maskStack[0]
  expect(created).toMatchObject({ name: 'Background', head: null, resultHead: null })
  expect(created.base).toBeTruthy()
  const corrected = await page.evaluate(
    ({ photoId, id }) =>
      window.irodori.mutateMasks(photoId, 1, {
        operations: [
          {
            kind: 'update',
            id,
            name: 'Repaired background',
            light: { exposureEv: 0.25 },
            color: { saturation: 7, tint: 3 },
            edge: { featherPx: 1, shiftPx: 0 },
          },
          {
            kind: 'stroke',
            id,
            stroke: { mode: 'subtract', radius: 0.015, feather: 0.5, points: [{ x: 0.5, y: 0.5 }] },
          },
        ],
      }),
    { photoId, id: created.id },
  )
  await ready(corrected.revision)
  await maskDetailTab(page, 'Coverage')
  await activateButton(page.getByRole('button', { name: 'Starting coverage', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Select Background', exact: true }))
  await expect(use()).toBeEnabled({ timeout: 60000 })
  expect((await history()).settings).toEqual(corrected.settings)
  expect((await history()).revision).toBe(corrected.revision)
  await activateButton(use())
  await expect.poll(history).toMatchObject({ revision: corrected.revision + 1 })
  const refined = await history()
  expect({ ...refined.settings.maskStack[0], base: corrected.settings.maskStack[0].base }).toEqual(
    corrected.settings.maskStack[0],
  )
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: refined.revision + 1 })
  expect((await history()).settings.maskStack).toEqual(corrected.settings.maskStack)
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: refined.revision + 2 })
  ;({ page } = await irodori.restart())
  const restarted = await history()
  expect(restarted.settings.maskStack).toEqual(refined.settings.maskStack)
  await navigateInspector(page, 'Masks')
  await ready(restarted.revision)

  for (const operator of ['Add', 'Subtract', 'Intersect']) {
    await maskDetailTab(page, 'Coverage')
    await activateButton(page.getByRole('button', { name: 'Combine…', exact: true }))
    await activateButton(
      page
        .getByRole('menu', { name: 'Combine coverage', exact: true })
        .getByRole('menuitem', { name: operator, exact: true }),
    )
    const methods = page.getByRole('menu', { name: 'New coverage part', exact: true })
    for (const selection of ['Select Sky', 'Select Background'])
      await expect(methods.getByRole('menuitem', { name: selection, exact: true })).toBeEnabled()
    if (operator !== 'Subtract') {
      await page.keyboard.press('Escape')
      continue
    }
    await activateButton(methods.getByRole('menuitem', { name: 'Select Background', exact: true }))
    await expect(use()).toBeEnabled({ timeout: 60000 })
    expect((await history()).revision).toBe(restarted.revision)
    await activateButton(use())
    await expect.poll(history).toMatchObject({ revision: restarted.revision + 1 })
    await ready(restarted.revision + 1)
  }
  const combined = await history()
  const combinedMask = combined.settings.maskStack[0]
  expect(combinedMask.operands).toHaveLength(1)
  expect(combinedMask.operands![0]).toMatchObject({ operator: 'subtract', name: 'Background part' })
  expect(combinedMask.operands![0].base).toBeTruthy()
  expect({ ...combinedMask, operands: restarted.settings.maskStack[0].operands }).toEqual(
    restarted.settings.maskStack[0],
  )

  const gradient = await page.evaluate(
    ({ photoId, id, revision }) =>
      window.irodori.mutateMasks(photoId, revision, {
        operations: [
          {
            kind: 'component-update',
            id,
            componentId: id,
            replacePrimary: true,
            gradient: { kind: 'linear', start: { x: 0.5, y: 0.2 }, end: { x: 0.5, y: 0.8 } },
          },
        ],
      }),
    { photoId, id: created.id, revision: combined.revision },
  )
  await ready(gradient.revision)
  await activateButton(
    page.getByRole('button', { name: 'Part actions for Starting coverage', exact: true }),
  )
  await activateButton(
    page
      .getByRole('menu', { name: 'Coverage part actions', exact: true })
      .getByRole('menuitem', { name: 'Replace starting coverage…', exact: true }),
  )
  const replacements = page.getByRole('menu', { name: 'Replace starting coverage', exact: true })
  await expect(
    replacements.getByRole('menuitem', { name: 'Select Sky', exact: true }),
  ).toBeEnabled()
  await activateButton(
    replacements.getByRole('menuitem', { name: 'Select Background', exact: true }),
  )
  await expect(use()).toBeEnabled({ timeout: 60000 })
  expect((await history()).settings.maskStack).toEqual(gradient.settings.maskStack)
  await activateButton(use())
  await expect.poll(history).toMatchObject({ revision: gradient.revision + 1 })
  const replaced = (await history()).settings.maskStack[0]
  expect(replaced.gradient).toBeUndefined()
  expect(replaced.base).toBeTruthy()
  expect({
    ...replaced,
    base: undefined,
    gradient: gradient.settings.maskStack[0].gradient,
  }).toEqual(gradient.settings.maskStack[0])
})
