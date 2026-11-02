import { navigateInspector, openInspectorTool, type InspectorTool } from './inspector.helpers'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { DEFAULT_INSPECTOR_SECTIONS } from '../src/shared/workspace'
import { managedOriginalHashes } from './professional-editing-acceptance.helpers'

test('every inspector section uses keyboard disclosures without remounting controls or adding photo history', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const before = await page.evaluate((id) => window.irodori.getEdits(id), id)
  for (const [title, content] of [
    ['Histogram · After', 'histogram'],
    ['Light', 'light-controls'],
    ['Color', 'color-controls'],
    ['Color intensity', 'color-intensity-controls'],
    ['Crop', 'crop-controls'],
    ['Color Mixer', 'color-mixer-controls'],
    ['Color Grading', 'color-grading-controls'],
    ['Tone blending', 'tone-blending-controls'],
    ['Detail', 'detail-controls'],
    ['Sharpening', 'sharpening-controls'],
    ['Lens corrections', 'lens-controls'],
    ['Metadata', 'photo-metadata'],
  ] as const) {
    await navigateInspector(page, title)
    const toggle = page.getByRole('button', { name: title, exact: true, includeHidden: true })
    const body = page.locator(`#${content}`)
    await expect(toggle).toHaveAttribute('aria-controls', content)
    const initiallyOpen = (await toggle.getAttribute('aria-expanded')) === 'true'
    // The sentinel detects lost DOM ownership even when new controls look identical.
    await body.evaluate((element) => element.setAttribute('data-retained', 'true'))
    await activateButton(toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', String(!initiallyOpen))
    await expect(body).toHaveAttribute('data-retained', 'true')
    await toggle.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', String(initiallyOpen))
    await expect(toggle).toBeFocused()
    await expect(body).toHaveAttribute('data-retained', 'true')
  }
  expect(await page.evaluate((id) => window.irodori.getEdits(id), id)).toEqual(before)
})

test('histogram remains pinned while only the adjustment body scrolls at native minimum size with Console open', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await activateButton(page.getByTestId('console-toggle'))
  await openInspectorTool(page, 'Lens corrections')
  const pinned = page.getByTestId('inspector-pinned')
  const scroll = page.getByTestId('inspector-scroll')
  const before = await pinned.boundingBox()
  const canvasBefore = await page.getByTestId('preview-viewport').boundingBox()
  await scroll.evaluate((element) => (element.scrollTop = element.scrollHeight))
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await pinned.boundingBox()).toEqual(before)
  expect(await page.getByTestId('preview-viewport').boundingBox()).toEqual(canvasBefore)
  const plot = page.getByRole('slider', { name: 'Histogram tonal value' })
  await expect(plot).toBeVisible()
  await expect(page.locator('#histogram')).toHaveAttribute('data-pending', /^(true|false)$/)
  await expect(page.locator('#histogram')).toHaveAttribute('aria-busy', /^(true|false)$/)
  // IntersectionObserver does not publish for a hidden native Wayland surface.
  // Check the real resized renderer's bounds, including overlap with its scroll body.
  const plotBox = await plot.boundingBox()
  const expandedBodyBox = await scroll.boundingBox()
  expect(plotBox!.x).toBeGreaterThanOrEqual(0)
  expect(plotBox!.y).toBeGreaterThanOrEqual(0)
  expect(plotBox!.x + plotBox!.width).toBeLessThanOrEqual(1100)
  expect(plotBox!.y + plotBox!.height).toBeLessThanOrEqual(expandedBodyBox!.y)
  expect(expandedBodyBox!.y + expandedBodyBox!.height).toBeLessThanOrEqual(700)
  const histogram = page.getByRole('button', { name: 'Histogram · After', exact: true })
  await activateButton(histogram)
  await expect(page.locator('#histogram')).toBeHidden()
  await expect(histogram).toBeVisible()
  await expect(page.getByTestId('console-panel')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const bodyBox = await scroll.boundingBox()
  const headingBox = await histogram.boundingBox()
  expect(headingBox!.y).toBeGreaterThanOrEqual(0)
  expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(700)
  expect(bodyBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height)
})

test('collapsed section retains a pending edit and receives external revisions without stale values on reopen', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const field = page.getByRole('spinbutton', { name: 'Exposure value' })
  await expect(field).toBeEnabled({ timeout: 20000 })
  await field.fill('1.25')
  const light = page.getByRole('button', { name: 'Light', exact: true, includeHidden: true })
  await activateButton(light)
  await expect(page.locator('#light-controls')).toBeHidden()
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 1, settings: { exposureEv: 1.25 } })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 2, settings: { exposureEv: 0 } })
  await activateButton(light)
  await expect(field).toHaveValue('0.00')
  await expect(field).toBeEnabled()
})

test('Sharpening collapse commits one pending radius edit and reopens at the external revision without changing its source', async ({
  irodori,
}) => {
  test.setTimeout(60000)
  const { app, page } = irodori
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0],
    before = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id),
    originals = await managedOriginalHashes(irodori.userDataDir, [photo]),
    toggle = page.getByRole('button', { name: 'Sharpening', exact: true }),
    body = page.locator('#sharpening-controls'),
    radius = page.getByRole('spinbutton', { name: 'Radius value', exact: true })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 40000,
  })
  await openInspectorTool(page, 'Sharpening')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(radius).toBeEnabled()
  expect(before.settings.detailSharpening.amount).toBe(0)
  await body.evaluate((element) => element.setAttribute('data-retained', 'pending-detail'))
  await radius.fill('1.2')
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(before)
  await activateButton(toggle)
  await expect(body).toBeHidden()
  await expect(body).toHaveAttribute('data-retained', 'pending-detail')
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), photo.id))
    .toMatchObject({
      revision: before.revision + 1,
      settings: { detailSharpening: { amount: 0, radius: 1.2 } },
    })
  const committed = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
  expect(committed.snapshots).toHaveLength(before.snapshots.length + 1)
  expect(committed.snapshots.slice(0, -1)).toEqual(before.snapshots)
  const external = await page.evaluate(
    ({ id, revision }) =>
      window.irodori.updateEdits(id, { detailSharpening: { radius: 1.4 } }, revision),
    { id: photo.id, revision: committed.revision },
  )
  expect(external.revision).toBe(committed.revision + 1)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(body).toBeHidden()
  await activateButton(toggle)
  await expect(radius).toHaveValue('1.4')
  await expect(radius).toBeEnabled()
  await expect(body).toHaveAttribute('data-retained', 'pending-detail')
  const reopened = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
  expect(reopened.revision).toBe(external.revision)
  expect(reopened.settings).toEqual(external.settings)
  expect(reopened.snapshots).toHaveLength(committed.snapshots.length + 1)
  expect(reopened.snapshots.slice(0, -1)).toEqual(committed.snapshots)
  expect(await managedOriginalHashes(irodori.userDataDir, [photo])).toEqual(originals)
})

test('disclosure choices survive photo changes, crash recovery and normal restart', async ({
  irodori,
}) => {
  let { page } = irodori
  await importPhotos(irodori.app, page)
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  for (const title of [
    'Histogram · After',
    'Light',
    'Color',
    'Metadata',
    'Lens corrections',
    'Color Mixer',
    'Color Grading',
    'Detail',
    'Crop',
  ]) {
    await navigateInspector(page, title as InspectorTool)
    await activateButton(
      page.getByRole('button', { name: title, exact: true, includeHidden: true }),
    )
  }
  const expected = {
    ...DEFAULT_INSPECTOR_SECTIONS,
    histogram: false,
    light: false,
    color: false,
    metadata: false,
    lens: !DEFAULT_INSPECTOR_SECTIONS.lens,
    colorMixer: !DEFAULT_INSPECTOR_SECTIONS.colorMixer,
    colorGrading: !DEFAULT_INSPECTOR_SECTIONS.colorGrading,
    detail: !DEFAULT_INSPECTOR_SECTIONS.detail,
    crop: !DEFAULT_INSPECTOR_SECTIONS.crop,
  }
  await expect
    .poll(
      async () => (await page.evaluate(() => window.irodori.getWorkspaceState())).state?.inspector,
    )
    .toEqual(expected)
  await activateButton(
    page.getByRole('button', { name: `Select ${photos[1].filename}`, exact: true }),
  )
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
  await expect(
    page.getByRole('button', { name: 'Color', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  for (const title of ['Detail', 'Crop'])
    await expect(
      page.getByRole('button', { name: title, exact: true, includeHidden: true }),
    ).toHaveAttribute('aria-expanded', 'false')
  ;({ page } = await irodori.crashAndRestart())
  for (const title of ['Histogram · After', 'Light', 'Color', 'Metadata'])
    await expect(
      page.getByRole('button', { name: title, exact: true, includeHidden: true }),
    ).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByRole('button', { name: 'Lens corrections', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  for (const title of ['Color Mixer', 'Color Grading', 'Detail', 'Crop'])
    await expect(
      page.getByRole('button', { name: title, exact: true, includeHidden: true }),
    ).toHaveAttribute('aria-expanded', 'false')
  await navigateInspector(page, 'Color')
  await activateButton(
    page.getByRole('button', { name: 'Color', exact: true, includeHidden: true }),
  )
  ;({ page } = await irodori.restart())
  await expect(
    page.getByRole('button', { name: 'Color', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(
    page.getByRole('button', { name: 'Light', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  for (const title of ['Detail', 'Crop'])
    await expect(
      page.getByRole('button', { name: title, exact: true, includeHidden: true }),
    ).toHaveAttribute('aria-expanded', 'false')
  await expect
    .poll(
      async () => (await page.evaluate(() => window.irodori.getWorkspaceState())).state?.inspector,
    )
    .toEqual({ ...expected, color: true })
})
