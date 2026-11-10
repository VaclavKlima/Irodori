import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask, maskDetailTab } from './mask-panel.helpers'
import { captureWindow } from './window-capture.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { foregroundTest } from './foreground'

async function combine(page: Page, operator: 'Add' | 'Subtract' | 'Intersect', method: string) {
  await activateButton(page.getByRole('button', { name: 'Combine…', exact: true }))
  await activateButton(
    page
      .getByRole('menu', { name: 'Combine coverage', exact: true })
      .getByRole('menuitem', { name: operator, exact: true }),
  )
  await activateButton(
    page
      .getByRole('menu', { name: 'New coverage part', exact: true })
      .getByRole('menuitem', { name: method, exact: true }),
  )
}

async function partAction(page: Page, name: string, action: string) {
  await activateButton(page.getByRole('button', { name: `Part actions for ${name}`, exact: true }))
  await activateButton(
    page
      .getByRole('menu', { name: 'Coverage part actions', exact: true })
      .getByRole('menuitem', { name: action, exact: true }),
  )
}

test('compound brush and gradient creation commit once; Result corrections, cancellation and restart retain explicit targets', async ({
  irodori,
}) => {
  test.setTimeout(120000)
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
  const preview = () => page.getByTestId('main-preview')
  const ready = async () => {
    await expect(preview()).toHaveAttribute('data-editing', 'ready')
    await expect(preview()).toHaveAttribute(
      'data-frame-geometry-revision',
      String((await history()).revision),
    )
  }
  await navigateInspector(page, 'Masks')
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 1 })
  await ready()
  await combine(page, 'Subtract', 'Radial gradient')
  await expect(page.getByRole('button', { name: 'Place centered', exact: true })).toBeVisible()
  await preview().press('Escape')
  expect((await history()).revision).toBe(1)
  expect((await history()).settings.maskStack[0].operands).toEqual([])
  await combine(page, 'Add', 'Brush')
  await preview().focus()
  await preview().press('Space')
  await preview().press('ArrowRight')
  await preview().press('Escape')
  expect((await history()).revision).toBe(1)
  await combine(page, 'Add', 'Brush')
  await preview().focus()
  await preview().press('Space')
  await preview().press('ArrowRight')
  expect((await history()).revision).toBe(1)
  await preview().press('Space')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const brush = (await history()).settings.maskStack[0].operands![0]
  expect(brush.head).toMatch(/^[a-f0-9]{64}$/)
  expect(brush.resultHead).toBeNull()
  await ready()
  await activateButton(
    page.getByRole('button', { name: 'Result Completed combination', exact: true }),
  )
  await activateButton(page.getByRole('button', { name: 'Paint', exact: true }))
  await preview().focus()
  await preview().press('Space')
  await preview().press('Space')
  await expect.poll(history).toMatchObject({ revision: 3 })
  expect((await history()).settings.maskStack[0].resultHead).toMatch(/^[a-f0-9]{64}$/)
  expect((await history()).settings.maskStack[0].head).toBeNull()
  await ready()
  await combine(page, 'Intersect', 'Linear gradient')
  await activateButton(page.getByRole('button', { name: 'Place centered', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 4 })
  const gradient = (await history()).settings.maskStack[0].operands![1]
  expect(gradient).toMatchObject({ operator: 'intersect', gradient: { kind: 'linear' } })
  await ready()
  await expect(page.getByRole('button', { name: 'Edit gradient', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await activateButton(page.getByRole('button', { name: 'Geometry', exact: true }))
  const startX = page.getByRole('spinbutton', { name: 'Start X value', exact: true })
  const context = await page.evaluate(
    ({ photoId, revision }) => window.irodori.getMaskContext(photoId, revision),
    { photoId, revision: (await history()).revision },
  )
  await startX.fill('70')
  await startX.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 5 })
  expect((await history()).settings.maskStack[0].operands![1].gradient).toMatchObject({
    kind: 'linear',
    start: { x: 70 / context.width },
  })
  await page
    .getByRole('combobox', { name: 'Coverage inspection', exact: true })
    .selectOption('selected-part')
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 6 })
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 7 })
  const saved = (await history()).settings
  ;({ page } = await irodori.restart())
  await expect.poll(async () => (await history()).settings).toEqual(saved)
  await expect(
    page.getByRole('combobox', { name: 'Coverage inspection', exact: true }),
  ).toHaveValue('selected-part')
  const prefs = await page.evaluate(() => window.irodori.getWorkspaceState())
  expect(prefs.state?.masks.selectedComponentId).toBe(gradient.id)
})

test('copied nested groups preserve editable geometry; operator, reorder and removal share Undo with independent source masks', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(120000)
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect(page.getByTestId('main-preview')).toHaveAttribute(
    'data-frame-geometry-revision',
    '0',
  )
  const source = crypto.randomUUID(),
    child = crypto.randomUUID(),
    nested = crypto.randomUUID(),
    destination = crypto.randomUUID()
  await page.evaluate(
    ({ photoId, source, child, nested, destination }) =>
      window.irodori.mutateMasks(photoId, 0, {
        operations: [
          {
            kind: 'create',
            id: source,
            name: 'Bird coverage',
            gradient: { kind: 'linear', start: { x: 0.2, y: 0.2 }, end: { x: 0.7, y: 0.7 } },
          },
          {
            kind: 'component-add',
            id: source,
            componentId: child,
            name: 'Refined boundary',
            operator: 'intersect',
            gradient: {
              kind: 'radial',
              center: { x: 0.5, y: 0.5 },
              radiusX: 0.3,
              radiusY: 0.3,
              rotation: 0,
              feather: 50,
            },
          },
          {
            kind: 'component-add',
            id: source,
            parentId: child,
            componentId: nested,
            name: 'Leg correction',
            operator: 'add',
          },
          {
            kind: 'create',
            id: destination,
            name: 'Water',
            gradient: {
              kind: 'radial',
              center: { x: 0.5, y: 0.5 },
              radiusX: 0.4,
              radiusY: 0.4,
              rotation: 0,
              feather: 50,
            },
          },
        ],
      }),
    { photoId, source, child, nested, destination },
  )
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await maskDetailTab(page, 'Coverage')
  await expect(page.getByTestId('main-preview')).toHaveAttribute(
    'data-frame-geometry-revision',
    '1',
  )
  await combine(page, 'Subtract', 'Copy existing mask…')
  await activateButton(
    page
      .getByRole('menu', { name: 'Copy existing mask', exact: true })
      .getByRole('menuitem', { name: 'Bird coverage', exact: true }),
  )
  await expect.poll(history).toMatchObject({ revision: 2 })
  const copied = (await history()).settings.maskStack.find((mask) => mask.id === destination)!
    .operands![0]
  expect(copied.id).not.toBe(source)
  expect(copied.operands![0].id).not.toBe(child)
  expect(copied.operands![0].operands![0].id).not.toBe(nested)
  expect(copied.operands![0].gradient).toMatchObject({ kind: 'radial' })
  await activateButton(page.getByRole('button', { name: 'Expand Bird coverage copy', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Expand Refined boundary', exact: true }))
  await expect(page.getByRole('button', { name: '+ Leg correction', exact: true })).toBeVisible()
  await partAction(page, 'Bird coverage copy', 'Duplicate part')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await partAction(page, 'Bird coverage copy', 'Change operation…')
  await activateButton(
    page
      .getByRole('menu', { name: 'Part operation', exact: true })
      .getByRole('menuitem', { name: 'Intersect', exact: true }),
  )
  await expect.poll(history).toMatchObject({ revision: 4 })
  const handle = page.getByRole('button', { name: 'Reorder Bird coverage copy copy', exact: true })
  await expect(page.getByTestId('main-preview')).toHaveAttribute(
    'data-frame-geometry-revision',
    '4',
  )
  await expect(handle).toBeEnabled()
  await handle.focus()
  await expect(handle).toBeFocused()
  await handle.press('Alt+ArrowUp')
  await expect.poll(history).toMatchObject({ revision: 5 })
  const reordered = (await history()).settings.maskStack.find(
    (mask) => mask.id === destination,
  )!.operands!
  expect(reordered.map((node) => node.name)).toEqual([
    'Bird coverage copy copy',
    'Bird coverage copy',
  ])
  const sourceBefore = (await history()).settings.maskStack.find((mask) => mask.id === source)
  await partAction(page, 'Bird coverage copy', 'Remove part')
  await expect.poll(history).toMatchObject({ revision: 6 })
  expect((await history()).settings.maskStack.find((mask) => mask.id === source)).toEqual(
    sourceBefore,
  )
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 7 })
  expect(
    (await history()).settings.maskStack.find((mask) => mask.id === destination)!.operands,
  ).toHaveLength(2)
})

test(
  'new coverage previews through active destination feather without history; disabled part inspection prepares its own edge',
  foregroundTest(
    'Native composited WebGL pixels are required to inspect transient feathered coverage.',
  ),
  async ({ irodori: { app, page } }) => {
    test.setTimeout(120000)
    await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
    const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
      root = crypto.randomUUID(),
      disabled = crypto.randomUUID()
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-frame-geometry-revision',
      '0',
    )
    await page.evaluate(
      ({ photoId, root, disabled }) =>
        window.irodori.mutateMasks(photoId, 0, {
          operations: [
            { kind: 'create', id: root, name: 'Feathered destination' },
            { kind: 'update', id: root, edge: { featherPx: 3 }, light: { exposureEv: 1 } },
            {
              kind: 'component-add',
              id: root,
              componentId: disabled,
              name: 'Disabled feathered gradient',
              operator: 'add',
              gradient: {
                kind: 'radial',
                center: { x: 0.5, y: 0.5 },
                radiusX: 0.2,
                radiusY: 0.2,
                rotation: 0,
                feather: 50,
              },
            },
            {
              kind: 'component-update',
              id: root,
              componentId: disabled,
              enabled: false,
              edge: { featherPx: 2 },
            },
          ],
        }),
      { photoId, root, disabled },
    )
    const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
    await navigateInspector(page, 'Masks')
    await maskDetailTab(page, 'Coverage')
    await page.getByRole('checkbox', { name: 'Show overlay', exact: true }).check()
    const preview = page.getByTestId('main-preview'),
      overlay = page.getByTestId('mask-coverage-overlay')
    await expect(preview).toHaveAttribute('data-editing', 'ready')
    await expect(page.getByTestId('mask-edge-pending')).toHaveCount(0)
    await expect(overlay).toHaveAttribute('data-prepared-key', /^[a-f0-9]{64}$/)
    const before = await overlay.getAttribute('data-prepared-key')
    const native = await app.browserWindow(page)
    const box = (await preview.boundingBox())!
    const captureCenter = () =>
      native.evaluate(
        async (window, rectangle) =>
          (await window.capturePage(rectangle, { stayHidden: true, stayAwake: true }))
            .toPNG()
            .toString('base64'),
        {
          x: Math.round(box.x + box.width / 2 - 3),
          y: Math.round(box.y + box.height / 2 - 3),
          width: 6,
          height: 6,
        },
      )
    const beforePixels = await captureCenter()
    await combine(page, 'Add', 'Brush')
    await expect(preview).toBeVisible()
    await expect(preview).toHaveAttribute('data-editing', 'ready')
    await preview.focus()
    await preview.press('Space')
    await expect(preview).toHaveAttribute('data-gesturing', 'true')
    await expect(page.getByTestId('mask-edge-pending')).toHaveCount(0, { timeout: 30000 })
    await expect
      .poll(() => overlay.getAttribute('data-prepared-key'), { timeout: 30000 })
      .not.toBe(before)
    await expect.poll(captureCenter, { timeout: 30000 }).not.toBe(beforePixels)
    expect((await history()).revision).toBe(1)
    expect((await history()).settings.maskStack[0].operands).toHaveLength(1)
    await preview.press('Escape')
    await expect(preview).not.toHaveAttribute('data-gesturing', 'true')
    expect((await history()).revision).toBe(1)
    await activateButton(page.locator(`[data-part-id="${disabled}"] button[aria-pressed]`))
    await page
      .getByRole('combobox', { name: 'Coverage inspection', exact: true })
      .selectOption('selected-part')
    await expect(page.getByTestId('mask-edge-pending')).toHaveCount(0, { timeout: 30000 })
    await expect(page.getByRole('button', { name: 'Retry GPU', exact: true })).toHaveCount(0)
    await expect(overlay).toHaveAttribute('data-coverage-id', disabled)
    await expect(overlay).toHaveAttribute('data-prepared-key', /^[a-f0-9]{64}$/)
    expect((await history()).settings.maskStack[0].operands![0].enabled).toBe(false)
  },
)

const nativeLayout =
  process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)
    ? foregroundTest(
        'Native 1100×700 Console-open resizing and pointer reordering require compositor presentation.',
      )
    : {}
test(
  'nested coverage parts remain independently scrollable at native minimum size with Console open',
  nativeLayout,
  async ({ irodori: { app, page } }, testInfo) => {
    test.setTimeout(120000)
    await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
    await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
    await activateButton(page.getByTestId('console-toggle'))
    await focusPreviewWindow(app, page)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    await navigateInspector(page, 'Masks')
    await createMask(page)
    await maskDetailTab(page, 'Coverage')
    const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    const state = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId),
      rootId = state.settings.maskStack[0].id
    await expect(page.getByTestId('main-preview')).toHaveAttribute(
      'data-frame-geometry-revision',
      String(state.revision),
    )
    await page.evaluate(
      ({ photoId, rootId, revision }) =>
        window.irodori.mutateMasks(photoId, revision, {
          operations: Array.from({ length: 12 }, (_, index) => ({
            kind: 'component-add' as const,
            id: rootId,
            componentId: crypto.randomUUID(),
            name: `Coverage ${index + 1}`,
            operator: 'subtract' as const,
          })),
        }),
      { photoId, rootId, revision: state.revision },
    )
    const parts = page.getByTestId('mask-parts-list'),
      details = page.getByTestId('mask-details-scroll')
    await parts.scrollIntoViewIfNeeded()
    const scroll = await parts.evaluate((element) => ({
      client: element.clientHeight,
      total: element.scrollHeight,
    }))
    expect(scroll.total).toBeGreaterThan(scroll.client)
    await parts.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const lastPart = page.getByRole('button', { name: '− Coverage 12', exact: true })
    await lastPart.scrollIntoViewIfNeeded()
    await expect(lastPart).toBeInViewport()
    const before = await parts.evaluate((element) => element.scrollTop)
    await details.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    expect(await parts.evaluate((element) => element.scrollTop)).toBe(before)
    await expect(page.getByTestId('console-toggle')).toBeInViewport()
    await details.evaluate((element) => {
      element.scrollTop = 0
    })
    await parts.evaluate((element) => {
      element.scrollTop = 0
    })
    const first = page.getByRole('button', { name: 'Reorder Coverage 1', exact: true })
    const second = page.getByRole('button', { name: 'Reorder Coverage 2', exact: true })
    await first.scrollIntoViewIfNeeded()
    await second.scrollIntoViewIfNeeded()
    await expect(first).toBeEnabled()
    await expect(first).toBeInViewport()
    const start = (await first.boundingBox())!,
      target = (await second.boundingBox())!
    const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
    const revision = (await history()).revision
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 })
    expect((await history()).revision).toBe(revision)
    await page.mouse.up()
    await expect.poll(history).toMatchObject({ revision: revision + 1 })
    expect(
      (await history()).settings.maskStack[0].operands!.slice(0, 2).map((node) => node.name),
    ).toEqual(['Coverage 2', 'Coverage 1'])
    await captureWindow(app, page, testInfo.outputPath('compound-mask-minimum.png'))
  },
)
